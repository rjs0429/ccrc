#!/usr/bin/env bash
# Makes a GitHub Release for every release tag from v0.7.0 on that has none, oldest first, with notes from
# scripts/release-notes.sh. Tags with "-" (v0.8.0-rc.1) become pre-releases; only the highest other tag is marked
# latest. Existing releases are left alone, so running it again changes nothing.
#
# A tag whose commit holds .ccrc-allowed-signers must carry a signature from a key in that file (git verify-tag);
# otherwise its release is not made and the script exits with 1 after the other tags. Older tags have no such file and
# are not checked.
#
# Run inside a clone with all tags as annotated tag objects (git fetch --force --tags). Uses gh, which needs GH_TOKEN,
# and GH_REPO (owner/name) outside a clone of the GitHub repository.
set -euo pipefail

MIN_VERSION=0.7.0
SIGNERS=.ccrc-allowed-signers
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

say() { echo "sync-releases: $*"; }

# Prints major, minor and patch of a tag such as v1.2.3 or v1.2.3-rc.1; fails for other names.
triple() {
  [[ $1 =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)(-[0-9A-Za-z.-]+)?$ ]] || return 1
  echo "$((10#${BASH_REMATCH[1]})) $((10#${BASH_REMATCH[2]})) $((10#${BASH_REMATCH[3]}))"
}

# Whether a tag is MIN_VERSION or newer; a pre-release of MIN_VERSION is older.
wanted() {
  local t m
  t=($(triple "$1")) || return 1
  m=(${MIN_VERSION//./ })
  for i in 0 1 2; do
    ((t[i] > m[i])) && return 0
    ((t[i] < m[i])) && return 1
  done
  [[ $1 != *-* ]]
}

# 0 when the release exists, 1 when GitHub says it does not, 2 when gh failed otherwise.
release_exists() {
  local err
  if err=$(gh release view "$1" --json tagName 2>&1 >/dev/null); then return 0; fi
  [[ $err == *"release not found"* ]] && return 1
  echo "$err" >&2
  return 2
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

tags=()
while IFS= read -r tag; do
  wanted "$tag" && tags+=("$tag")
done < <(git -c versionsort.suffix=- tag -l 'v[0-9]*' --sort=v:refname)
if [ ${#tags[@]} -eq 0 ]; then
  say "no release tags from v$MIN_VERSION on"
  exit 0
fi

latest=""
for tag in "${tags[@]}"; do
  [[ $tag == *-* ]] || latest=$tag
done

failed=()
made=0
for tag in "${tags[@]}"; do
  if [ "$(git cat-file -t "refs/tags/$tag")" != tag ]; then
    say "$tag: not an annotated tag object here (fetch with: git fetch --force --tags)"
    failed+=("$tag")
    continue
  fi
  rc=0
  release_exists "$tag" || rc=$?
  if [ $rc -eq 0 ]; then
    say "$tag: release exists"
    continue
  elif [ $rc -eq 2 ]; then
    say "$tag: could not look up its release"
    failed+=("$tag")
    continue
  fi

  if git cat-file -e "$tag^{commit}:$SIGNERS" 2>/dev/null; then
    git show "$tag^{commit}:$SIGNERS" >"$work/allowed-signers"
    if ! out=$(git -c gpg.format=ssh -c "gpg.ssh.allowedSignersFile=$work/allowed-signers" verify-tag "$tag" 2>&1); then
      say "$tag: the signature does not check out against $SIGNERS at $tag; no release made"
      printf '%s\n' "$out" | sed 's/^/  /' >&2
      failed+=("$tag")
      continue
    fi
    say "$tag: signed by a key in $SIGNERS"
  fi

  if ! "$here/release-notes.sh" "$tag" >"$work/notes.md"; then
    say "$tag: no release notes; no release made"
    failed+=("$tag")
    continue
  fi

  args=(release create "$tag" --verify-tag --title "ccrc $tag" --notes-file "$work/notes.md")
  if [[ $tag == *-* ]]; then
    args+=(--prerelease --latest=false)
  elif [ "$tag" = "$latest" ]; then
    args+=(--latest=true)
  else
    args+=(--latest=false)
  fi
  if gh "${args[@]}"; then
    say "$tag: release made$([ "$tag" = "$latest" ] && echo " (latest)")"
    made=$((made + 1))
  else
    say "$tag: gh release create failed"
    failed+=("$tag")
  fi
done

say "$made made, ${#failed[@]} failed"
if [ ${#failed[@]} -gt 0 ]; then
  say "failed: ${failed[*]}"
  exit 1
fi
