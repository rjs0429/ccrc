#!/usr/bin/env bash
# Installs ccrc for the user running it, then hands over to `ccrc setup` for the rest (Claude Code, Tailscale, the
# service, VS Code, the phone). This script only prepares: base tools, Node.js 22.18 or newer, and the code, a git
# copy with its build in <dataDir>/versions/<version>, linked from <dataDir>/current and ~/.local/bin/ccrc.
#
#   curl -fsSL https://raw.githubusercontent.com/rjs0429/ccrc/main/install.sh | bash
#   curl -fsSLO https://raw.githubusercontent.com/rjs0429/ccrc/v0.7.0/install.sh && less install.sh && bash install.sh
#
# Options; any other goes on to `ccrc setup` (see `ccrc setup --help`), as does everything after `--`:
#   --version <tag>      install this release instead of the newest one
#   --ref <git ref>      install a branch or commit (for testing)
#   --from <path>        install from a local repository: its HEAD, or --ref
#   --channel stable|rc  with rc, release candidates count when looking for the newest release
#   --yes                take the default answer to every question
#   --dry-run            show what would be done and change nothing; with an install in place, setup shows its part
#   --no-system          never use sudo or change the system (for testing)
#   --uninstall          run `ccrc uninstall` of the install in place
# Environment: CCRC_REPO_URL (the repository), CCRC_DATA_DIR (the install folder), CCRC_NODE (a Node.js 22.18+ to
# use instead of looking for one), CCRC_NODE_DIST (where Node.js is downloaded from).
set -Eeuo pipefail

REPO_URL=${CCRC_REPO_URL:-https://github.com/rjs0429/ccrc.git}
DATA_DIR=${CCRC_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/ccrc}
STATE_DIR=${CCRC_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/ccrc}
BIN_DIR=$HOME/.local/bin
NODE_DIST=${CCRC_NODE_DIST:-https://nodejs.org/dist/latest-v22.x}
TOOLS=(git curl tar xz sha256sum)
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false

VERSION=
REF=
FROM=
CHANNEL=stable
YES=0
DRY_RUN=0
NO_SYSTEM=0
UNINSTALL=0
SETUP_ARGS=()
LOG=/dev/null
TTY=
STEP=start
WORK=
NODE=
NAME=
EXISTING=

say() {
  printf '%s\n' "$*"
  printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"
}

die() {
  printf 'install.sh: %s\n' "$*" >&2
  printf '%s error: %s\n' "$(date '+%F %T')" "$*" >>"$LOG"
  exit 1
}

on_error() {
  # set -E hands this trap to subshells too: report once, from the script itself.
  [ "$BASHPID" = "$$" ] || return 0
  if [ "$LOG" = /dev/null ]; then
    printf 'install.sh: the step "%s" failed (exit code %s).\n' "$STEP" "$1" >&2
  else
    printf 'install.sh: the step "%s" failed (exit code %s). The log is %s.\n' "$STEP" "$1" "$LOG" >&2
  fi
  printf 'Fix what it says and run install.sh again; what is already done is kept.\n' >&2
}

cleanup() {
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
}

step() {
  STEP=$1
  say ""
  say "== $1"
}

# Runs a command with its output in the log; on failure the end of the log is shown.
logged() {
  local code=0 out
  out=$(mktemp)
  printf '%s $ %s\n' "$(date '+%F %T')" "$*" >>"$LOG"
  "$@" >"$out" 2>&1 || code=$?
  cat "$out" >>"$LOG"
  if [ "$code" -ne 0 ]; then tail -n 20 "$out" >&2; fi
  rm -f "$out"
  return "$code"
}

confirm() {
  local answer
  if [ "$YES" = 1 ]; then return 0; fi
  [ -n "$TTY" ] || die "no terminal to ask \"$1\" on: run this in a terminal, or pass --yes"
  read -r -p "$1 [Y/n] " answer <"$TTY"
  case "$answer" in "" | [yY] | [yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

need_value() {
  [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version) need_value "$@"; VERSION=$2; shift 2 ;;
      --ref) need_value "$@"; REF=$2; shift 2 ;;
      --from) need_value "$@"; FROM=$2; shift 2 ;;
      --channel)
        need_value "$@"
        case "$2" in stable | rc) CHANNEL=$2 ;; *) die "--channel takes stable or rc" ;; esac
        shift 2
        ;;
      --yes | -y) YES=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --no-system) NO_SYSTEM=1; shift ;;
      --uninstall) UNINSTALL=1; shift ;;
      -h | --help)
        if [ -f "${BASH_SOURCE[0]:-}" ]; then sed -n '2,/^set -/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; else echo "see the comments at the top of install.sh"; fi
        exit 0
        ;;
      --) shift; SETUP_ARGS+=("$@"); break ;;
      *) SETUP_ARGS+=("$1"); shift ;;
    esac
  done
  if [ -n "$VERSION" ] && [ -n "$REF" ]; then die "give --version or --ref, not both"; fi
}

node_ok() {
  [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null
}

# npm next to that Node, or on PATH: the build needs it, and some distributions package it apart from Node.
has_npm() {
  [ -x "$(dirname "$1")/npm" ] || command -v npm >/dev/null 2>&1
}

complete() {
  [ -f "$1/.ccrc-install.json" ] && [ -x "$1/bin/ccrc" ] && [ -f "$1/web/dist/index.html" ]
}

not_root() {
  [ "$(id -u)" -ne 0 ] || die "do not run this as root: ccrc is installed for your own user, and uses sudo only where it has to"
}

prepare() {
  step "prepare"
  case "$(uname -s)" in
    Linux) ;;
    Darwin) die "macOS is not supported yet: ccrc runs as a systemd user service on Linux" ;;
    *) die "$(uname -s) is not supported: ccrc runs as a systemd user service on Linux" ;;
  esac
  if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then
    die "WSL is not supported yet: run ccrc on the Linux machine VS Code runs on"
  fi
  case "$(uname -m)" in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) die "the $(uname -m) processor is not supported: ccrc supports x86_64 and aarch64" ;;
  esac
  if ! systemctl --user show-environment >/dev/null 2>&1; then
    if [ "$NO_SYSTEM" = 1 ] || [ "$DRY_RUN" = 1 ]; then
      say "warning: no systemd user session answers here (systemctl --user); the service will not run from this session"
    else
      die "no systemd user session answers here (systemctl --user), and ccrc runs as a user service. Log in to a session with systemd (a desktop, or SSH on a systemd machine) and run this again."
    fi
  fi
  if complete "$DATA_DIR/current"; then
    EXISTING=$(basename "$(readlink -f "$DATA_DIR/current")")
    say "ccrc $EXISTING is installed in $DATA_DIR"
  fi
  say "This installs ccrc for $(id -un) in $DATA_DIR and links $BIN_DIR/ccrc, then runs ccrc setup."
  if [ "$DRY_RUN" = 0 ]; then confirm "Go on?" || die "stopped"; fi
}

install_tools() {
  step "base tools"
  local missing=() pkgs=() pm= t
  for t in "${TOOLS[@]}"; do command -v "$t" >/dev/null 2>&1 || missing+=("$t"); done
  if [ "${#missing[@]}" -eq 0 ]; then
    say "found ${TOOLS[*]}"
    return
  fi
  for t in apt-get dnf pacman zypper; do
    if command -v "$t" >/dev/null 2>&1; then pm=$t; break; fi
  done
  for t in "${missing[@]}"; do
    case "$t" in
      xz) if [ "$pm" = apt-get ]; then pkgs+=(xz-utils); else pkgs+=(xz); fi ;;
      sha256sum) pkgs+=(coreutils) ;;
      *) pkgs+=("$t") ;;
    esac
  done
  local cmd
  case "$pm" in
    apt-get) cmd="sudo apt-get update && sudo apt-get install -y ${pkgs[*]}" ;;
    dnf) cmd="sudo dnf install -y ${pkgs[*]}" ;;
    pacman) cmd="sudo pacman -S --needed --noconfirm ${pkgs[*]}" ;;
    zypper) cmd="sudo zypper install -y ${pkgs[*]}" ;;
    *) die "missing ${missing[*]}, and no apt-get, dnf, pacman or zypper to install them with: install them and run this again" ;;
  esac
  if [ "$DRY_RUN" = 1 ]; then
    say "missing ${missing[*]}; would run: $cmd"
    return
  fi
  [ "$NO_SYSTEM" = 0 ] || die "missing ${missing[*]}; --no-system does not install them: $cmd"
  say "missing ${missing[*]}; to install them: $cmd"
  confirm "Run that with sudo?" || die "install ${missing[*]} and run this again"
  if [ -n "$TTY" ]; then sh -c "$cmd" <"$TTY"; else sh -c "$cmd"; fi
}

fetch_node() {
  local line sum file name dir get=(curl -fsSL)
  # From an https source, redirects may not leave https.
  case "$NODE_DIST" in https://*) get+=(--proto-redir =https) ;; esac
  WORK=$(mktemp -d)
  logged "${get[@]}" "$NODE_DIST/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
  line=$(grep -m 1 -E "^[0-9a-f]{64}  node-v22\.[0-9]+\.[0-9]+-linux-$ARCH\.tar\.xz$" "$WORK/SHASUMS256.txt") ||
    die "no Node.js 22 for linux-$ARCH in $NODE_DIST/SHASUMS256.txt"
  sum=${line%% *}
  file=${line##* }
  name=${file%.tar.xz}
  say "downloading $file"
  logged "${get[@]}" "$NODE_DIST/$file" -o "$WORK/$file"
  printf '%s  %s\n' "$sum" "$WORK/$file" | sha256sum -c --status - || die "$file does not match its checksum in SHASUMS256.txt"
  dir=$DATA_DIR/$name
  mkdir -p "$DATA_DIR"
  rm -rf "$dir.tmp"
  mkdir "$dir.tmp"
  tar -xJf "$WORK/$file" -C "$dir.tmp" --strip-components=1
  rm -rf "$dir"
  mv "$dir.tmp" "$dir"
  ln -sfn "$name" "$DATA_DIR/node.tmp"
  mv -T "$DATA_DIR/node.tmp" "$DATA_DIR/node"
  rm -rf "$WORK"
  WORK=
  NODE=$DATA_DIR/node/bin/node
  node_ok "$NODE" || die "the Node.js in $DATA_DIR/$name does not run here"
  say "Node.js $("$NODE" --version) is in $DATA_DIR/$name"
}

# The Node the install in place recorded, as bin/ccrc finds it.
installed_node() {
  if [ -f "$DATA_DIR/current/.ccrc-install.json" ]; then
    sed -n 's/.*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DATA_DIR/current/.ccrc-install.json" | head -n 1
  fi
}

find_node() {
  step "Node.js"
  local c
  if [ -n "${CCRC_NODE:-}" ]; then
    node_ok "$CCRC_NODE" || die "CCRC_NODE=$CCRC_NODE is not Node.js 22.18 or newer"
    NODE=$CCRC_NODE
  else
    for c in "$DATA_DIR/node/bin/node" "$(installed_node)" "$(command -v node 2>/dev/null || true)"; do
      if node_ok "$c" && has_npm "$c"; then NODE=$c; break; fi
      if node_ok "$c"; then say "skipping Node.js at $c: no npm next to it or on PATH"; fi
    done
  fi
  if [ -n "$NODE" ]; then
    say "using Node.js $("$NODE" --version) at $NODE"
  elif [ "$DRY_RUN" = 1 ]; then
    say "no Node.js 22.18 or newer; would download the newest Node.js 22 for linux-$ARCH from $NODE_DIST, check it against SHASUMS256.txt and unpack it into $DATA_DIR/node-<version>, linked as $DATA_DIR/node"
  else
    fetch_node
  fi
}

latest_tag() {
  git ls-remote --tags --refs "$1" 'v*' | sed 's#.*refs/tags/##' |
    { grep -E '^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$' || true; } |
    { if [ "$CHANNEL" = rc ]; then cat; else grep -v -- '-rc\.' || true; fi; } |
    sed 's/-rc\./~rc./' | sort -V | tail -n 1 | sed 's/~rc\./-rc./'
}

write_info() {
  "$NODE" -e '
    const [file, version, commit, source, node] = process.argv.slice(1);
    const info = { version, commit, source, node, installedAt: new Date().toISOString() };
    require("node:fs").writeFileSync(file, JSON.stringify(info, null, 2) + "\n");
  ' "$1/.ccrc-install.json" "$NAME" "$(git -C "$1" rev-parse HEAD)" "$2" "$NODE"
}

fetch_code() {
  step "ccrc"
  local source=$REPO_URL tag= dest tmp
  if [ -n "$FROM" ]; then
    source=$(cd "$FROM" && pwd) || die "--from $FROM is not a folder"
  fi
  if [ -n "$EXISTING" ] && [ -z "$VERSION$REF$FROM" ]; then
    NAME=$EXISTING
    say "keeping ccrc $NAME; to change versions, use ccrc update"
  else
    if [ -n "$VERSION" ]; then
      tag=$VERSION
    elif [ -z "$REF$FROM" ]; then
      tag=$(latest_tag "$source")
      [ -n "$tag" ] || die "no release tags at $source; pass --ref <branch> to install a branch"
    fi
    NAME=$tag
    if [ -n "$NAME" ] && complete "$DATA_DIR/versions/$NAME"; then
      say "ccrc $NAME is already in $DATA_DIR/versions/$NAME"
    elif [ "$DRY_RUN" = 1 ]; then
      say "would fetch ${tag:-${REF:-HEAD}} from $source into $DATA_DIR/versions/<version>, run npm ci and npm run build there, and record the install"
    else
      mkdir -p "$DATA_DIR/versions"
      tmp=$DATA_DIR/versions/.tmp-$$
      WORK=$tmp
      rm -rf "$tmp"
      say "fetching ${tag:-${REF:-HEAD}} from $source"
      if [ -n "$tag" ]; then
        logged git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" "$source" "$tmp"
      else
        logged git clone --quiet "$source" "$tmp"
        if [ -n "$REF" ]; then
          local commit
          commit=$(git -C "$tmp" rev-parse -q --verify "origin/$REF^{commit}" || git -C "$tmp" rev-parse -q --verify "$REF^{commit}") ||
            die "no branch, tag or commit \"$REF\" in $source"
          logged git -C "$tmp" checkout --quiet --detach "$commit"
        fi
        # Named as `ccrc update --from` and the broker's version name the commit.
        NAME=$(git -C "$tmp" describe --always --match 'v[0-9]*')
      fi
      dest=$DATA_DIR/versions/$NAME
      if complete "$dest"; then
        say "ccrc $NAME is already in $dest"
      else
        say "building ccrc $NAME (npm ci, npm run build; the output goes to the log)"
        local path=$PATH
        cd "$tmp"
        PATH=$(dirname "$NODE"):$path
        logged npm ci
        logged npm run build
        PATH=$path
        cd - >/dev/null
        write_info "$tmp" "$source"
        rm -rf "$dest"
        mv "$tmp" "$dest"
        say "ccrc $NAME is in $dest"
      fi
      rm -rf "$tmp"
      WORK=
    fi
  fi
  link_code
}

link_code() {
  if [ "$DRY_RUN" = 1 ]; then
    [ "$(readlink "$DATA_DIR/current" 2>/dev/null || true)" = "versions/$NAME" ] || say "would point $DATA_DIR/current at versions/${NAME:-<version>} and link $BIN_DIR/ccrc to $DATA_DIR/current/bin/ccrc"
    return
  fi
  if [ "$(readlink "$DATA_DIR/current" 2>/dev/null || true)" != "versions/$NAME" ]; then
    ln -sfn "versions/$NAME" "$DATA_DIR/current.tmp"
    mv -T "$DATA_DIR/current.tmp" "$DATA_DIR/current"
    say "$DATA_DIR/current is now ccrc $NAME"
  fi
  mkdir -p "$BIN_DIR"
  if [ -e "$BIN_DIR/ccrc" ] && [ ! -L "$BIN_DIR/ccrc" ]; then
    say "warning: $BIN_DIR/ccrc is a file of its own, left as it is; ccrc is $DATA_DIR/current/bin/ccrc"
  else
    ln -sfn "$DATA_DIR/current/bin/ccrc" "$BIN_DIR/ccrc"
  fi
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) say "$BIN_DIR is not on PATH; add it to your shell, e.g.: echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc" ;;
  esac
}

run_ccrc() {
  local args=("$@")
  [ "$YES" = 0 ] || args+=(--yes)
  [ "$NO_SYSTEM" = 0 ] || args+=(--no-system)
  [ "$DRY_RUN" = 0 ] || args+=(--dry-run)
  args+=("${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}")
  if [ -n "$NODE" ]; then export CCRC_NODE=$NODE; fi
  say ""
  say "== ccrc ${args[*]}"
  if [ ! -t 0 ] && [ -n "$TTY" ]; then exec "$DATA_DIR/current/bin/ccrc" "${args[@]}" <"$TTY"; fi
  exec "$DATA_DIR/current/bin/ccrc" "${args[@]}"
}

main() {
  parse_args "$@"
  not_root
  if [ -t 0 ]; then
    TTY=/dev/stdin
  elif (: </dev/tty) 2>/dev/null; then
    TTY=/dev/tty
  fi
  if [ "$DRY_RUN" = 0 ]; then
    # The broker keeps its state private (0700); the log is made the same way.
    mkdir -p "$(dirname "$STATE_DIR")"
    (umask 077 && mkdir -p "$STATE_DIR" && touch "$STATE_DIR/install.log")
    LOG=$STATE_DIR/install.log
    printf '\n%s install.sh %s\n' "$(date '+%F %T')" "$*" >>"$LOG"
  fi
  trap 'on_error $?' ERR
  trap cleanup EXIT

  if [ "$UNINSTALL" = 1 ]; then
    complete "$DATA_DIR/current" || die "no ccrc install in $DATA_DIR"
    run_ccrc uninstall
  fi
  prepare
  install_tools
  find_node
  fetch_code
  if [ "$DRY_RUN" = 1 ] && ! complete "$DATA_DIR/current"; then
    say ""
    say "Then ccrc setup would check and set up the rest: see ccrc setup --help."
    exit 0
  fi
  trap - EXIT
  cleanup
  run_ccrc setup
}

main "$@"
