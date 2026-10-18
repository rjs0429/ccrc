# ccrc

Drive the live Claude Code sessions in VS Code from your phone, without a third-party relay.

ccrc runs a small broker on your own Linux machine and serves a phone web app to your own
[Tailscale](https://tailscale.com) network (tailnet). From the phone you see every Claude Code session on the machine,
grouped by folder, follow a turn as it runs, send messages and attachments, answer permission prompts, questions
and plan approvals, and change model, permission mode and effort. Sessions open in VS Code are driven through a
small wrapper that VS Code's Claude Code extension starts the CLI with; inactive sessions can be resumed and new ones
started by the broker itself.

- **Personal tool.** Each person installs ccrc on their own machine and uses it with their own Claude Code login.
  There is no ccrc server: the phone talks to your machine over your tailnet, and transcripts stay on the machine.
  Claude Code itself talks to Anthropic's API as it always does.
- **Not an Anthropic product.** ccrc is not made, endorsed or supported by Anthropic. It does not include or modify
  Claude Code (see [License and Anthropic's terms](#license-and-anthropics-terms)).
- **Korean screens.** The phone app is in Korean only for now; the command line and documentation are in English.

### Tested with

| Part | Version |
|---|---|
| Claude Code VS Code extension and CLI | 2.1.301 (2.1.300 or later for files Claude sends to the phone) |
| Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | 0.3.296 |
| Node.js | 22.18 or newer |
| OS | Linux with systemd (Ubuntu 24.04, systemd 255), x86_64 or aarch64 |
| Tailscale | 1.104.1 |
| Phone | iOS 16.4 or later, Safari, added to the home screen (needed for notifications) |

`ccrc setup` and the settings screen run a compatibility check against the installed extension. Newer Claude Code
versions usually work; the check tells you when they do not.

### How sessions the phone starts sign in (`brokerSessions`)

There are two kinds of session:

- **VS Code sessions** are Claude Code as VS Code's extension starts it, signed in the way you set Claude Code up.
  ccrc only relays them. This always works.
- **Broker sessions** are the ones ccrc starts itself through the Claude Agent SDK: a new session from the phone,
  resuming an inactive session, a fork, a new worktree session.

Anthropic's [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page asks developers of
products built on the Agent SDK to use API key authentication, and does not permit routing requests through Free, Pro
or Max plan credentials on behalf of users; it does not restrict signing in to the unmodified Claude Code with your own
subscription. ccrc therefore leaves broker sessions to you, with the `brokerSessions` setting:

| Value | Broker sessions |
|---|---|
| `off` (default for new installs) | Do not start. The phone still shows and drives VS Code sessions and reads past ones. |
| `apiKey` | Sign in with an Anthropic API key you store with `ccrc config set-api-key`. Use is billed to the key. |
| `subscription` | Use this machine's Claude Code login, as ccrc 0.6 and earlier did. |

Read Anthropic's terms and decide which fits your use; ccrc does not make that call for you, and this is not legal
advice. Change it any time with `ccrc config set brokerSessions <value>`; a running broker picks it up at once.

## Requirements

- Linux with a systemd user session (desktop login, or SSH on a systemd machine), on x86_64 or aarch64.
  macOS, WSL and VS Code Remote-SSH are not supported.
- VS Code with Anthropic's Claude Code extension, or the Claude Code CLI, signed in.
- A Tailscale account. The installer sets up Tailscale on the machine; MagicDNS and HTTPS certificates must be on in
  the tailnet (setup shows where).
- The Tailscale app on the phone, signed in with the same Tailscale account as the machine: setup offers only that
  account's phones (another can be allowed by name).
- Node.js 22.18 or newer with npm, git, curl, tar, xz, sha256sum and OpenSSH's `ssh-keygen` (it comes with the SSH
  client: `openssh-client` on Debian and Ubuntu, `openssh-clients` on Fedora, RHEL and openSUSE, `openssh` on Arch),
  which `ccrc update` uses from 0.7.2 to check the signatures of release tags and which must be from OpenSSH 8.2 or
  newer (RHEL 8 has 8.0); ccrc installs and runs without it, only `ccrc update` stops. The installer offers to install
  the base tools and downloads Node.js 22 (npm included) into ccrc's own folder when none is found; some distributions
  package npm apart from Node.js. Nothing needs root except the base tools, Tailscale and, if your system asks for it,
  `loginctl enable-linger`.

## Install

Run as your normal user (not root, not with sudo):

```bash
curl -fsSL https://raw.githubusercontent.com/rjs0429/ccrc/main/install.sh | bash
```

To read the script before running it, or to pick a version:

```bash
curl -fsSLO https://raw.githubusercontent.com/rjs0429/ccrc/v0.7.0/install.sh
less install.sh
bash install.sh --version v0.7.0
```

`install.sh` only prepares, then hands over to `ccrc setup`:

1. Checks the platform (Linux, x86_64 or aarch64, a systemd user session) and refuses to run as root.
2. Installs missing base tools (git, curl, tar, xz, sha256sum, ssh-keygen) with apt, dnf, pacman or zypper. This
   uses sudo, so it says why and asks first, even with `--yes` (see [sudo](#sudo)). When only `ssh-keygen` is
   missing and stays so (sudo not given, `--no-system`, no package manager, or its install failing), the install goes
   on with a warning: installing does not use it, and `ccrc update` stops at its signature check, saying why, until
   it is installed.
3. Finds Node.js 22.18 or newer (`CCRC_NODE`, ccrc's own Node, the one an earlier install recorded, then `PATH`).
   Without one it downloads the newest Node.js 22 from nodejs.org, checks it against the `SHASUMS256.txt` there, and
   unpacks it into `~/.local/share/ccrc/node-v22.x.y-linux-<arch>`, linked as `~/.local/share/ccrc/node`. The
   checksum catches a damaged or cut-off download; that the file is Node.js's own rests on HTTPS to the source (the
   signature on `SHASUMS256.txt` is not checked).
4. Clones the release into `~/.local/share/ccrc/versions/<version>`, runs `npm ci` and `npm run build` there,
   records the install in `.ccrc-install.json`, and links `~/.local/share/ccrc/current` and `~/.local/bin/ccrc`. The
   tag's signature is not checked here (see [Verifying a release](#verifying-a-release) to check it by hand);
   `ccrc update` checks each tag it updates to, also when it finds that version already in `versions/`.
5. Runs `ccrc setup`. Under `curl | bash`, questions are read from the terminal (`/dev/tty`).

The log is `~/.local/state/ccrc/install.log`. When a step fails, fix what it says and run the script again; finished
steps are kept. Running it again on an existing install keeps the installed version (use `ccrc update` to change
versions) and runs setup again.

| `install.sh` option | Meaning |
|---|---|
| `--version <tag>` | Install this release instead of the newest one (`0.7.0` and `v0.7.0` both name the tag `v0.7.0`) |
| `--channel stable\|rc` | With `rc`, release candidates count when looking for the newest release |
| `--yes` | Take the default answer to every question except whether to use sudo; steps that need you still wait, except `devices`, which adds your phone only when you have exactly one and does not wait for one |
| `--allow-sudo` | Without a terminal, let the steps that need sudo run; sudo then has to work without asking for a password. With a terminal each one is still asked. Passed on to `ccrc setup` |
| `--dry-run` | Show what would be done and change nothing; with an install in place, setup shows its part too |
| `--no-system` | Never use sudo or change the system (for testing) |
| `--uninstall` | Run `ccrc uninstall` of the install in place |
| `--ref <git ref>`, `--from <path>` | Install a branch or commit, or from a local repository (for testing) |
| anything else, and everything after `--` | Passed on to `ccrc setup`, e.g. `bash install.sh -- --https-port 8444 --no-vscode` |

Environment for `install.sh`: `CCRC_REPO_URL` (repository to install from), `CCRC_DATA_DIR`, `CCRC_STATE_DIR`,
`CCRC_NODE` (a Node.js 22.18+ to use instead of looking for one) and `CCRC_NODE_DIST` (where Node.js is downloaded
from, for mirrors).

### What `ccrc setup` does

Setup checks each step and does only what is missing, so running it again finishes or repairs an install. Steps
that need you show what to do and wait until it is done (with `--yes`, `devices` does not wait; see its row). The
change to VS Code's settings is asked first; `--yes` takes the default answer to it and to the other questions.
Steps that need sudo are asked separately (see [sudo](#sudo)).

| Step id | Checks and does |
|---|---|
| `ssh-keygen` | OpenSSH's `ssh-keygen` is on `PATH` and from OpenSSH 8.2 or newer, as `ccrc update` needs to check release signatures; setup asks it what git asks it, and one without `-Y find-principals` is older. Otherwise it warns that updates will stop at that check and shows how to fix it: the command that installs it for the package manager found, or a newer OpenSSH. It installs nothing (no sudo), and the steps after it go on; skipped when ccrc runs from a checkout |
| `claude` | The Claude Code extension or CLI is installed and signed in (`claude auth status`); otherwise offers to install the extension with `code --install-extension`, or shows how, and waits for the sign-in |
| `tailscale-install` | Tailscale is installed and running; otherwise runs Tailscale's install script (sudo) |
| `tailscale-login` | This machine is signed in; otherwise runs `sudo tailscale up` with no flags, so Tailscale settings already on the machine stay, and waits while you open the sign-in link it shows |
| `tailscale-operator` | `tailscale serve` works without sudo; otherwise `sudo tailscale set --operator=$USER` |
| `https` | MagicDNS and HTTPS certificates are on; otherwise shows the Tailscale admin page to turn them on and waits. The machine's name then appears in public certificate logs |
| `devices` | Offers the iOS and Android machines of your Tailscale user, the one this machine belongs to (`UserID` in `tailscale status --json`), for `allowedDevices`; other users' phones in the tailnet are not offered. With `--yes` it adds your phone only when you have exactly one, and otherwise adds none and says how to add yours. A tagged machine, or a Tailscale that does not report users, gets none offered: name yours with `ccrc config set allowedDevices '["phone"]'`. A list already in config.json is left as it is |
| `account` | Sets the ccrc login ID and password (`ccrc passwd`) |
| `config` | Asks which folders new sessions may start in (default: home; `none` for only folders that already have sessions), sets `claudePath`, and asks how broker sessions sign in (`off`, `apiKey` with the key typed hidden, or `subscription`). Settings already in config.json are kept, an empty `roots` list too |
| `service` | Writes `~/.config/systemd/user/ccrc.service` (runs `<dataDir>/current/bin/ccrc serve` with the Node found), enables and starts it, and checks `/api/ping`. A replaced unit is backed up first, and its `Environment` lines that setup does not write itself (a proxy, say) are kept. Linger is optional: when it is off, setup asks whether to turn it on so the broker runs while you are logged out (`--yes` leaves it off). Refuses to run inside a broker session (see [Update and roll back](#update-and-roll-back)) |
| `serve` | `tailscale serve --bg --https=8443 http://127.0.0.1:8737` (kept across restarts) and shows the phone's address |
| `vscode` | Asks, backs up, then sets `claudeCode.claudeProcessWrapper` in VS Code's `settings.json`, keeping its comments and layout |
| `phone` | Shows the address (and a terminal QR code when `qrencode` is installed) and what to do on the phone |
| `doctor` | Runs the compatibility check with VS Code's Claude Code without a model call |

```
ccrc setup [--yes] [--allow-sudo] [--dry-run] [--only ids] [--skip ids] [--no-system] [--no-vscode] [--no-serve] [--https-port N]
```

`--only` and `--skip` take comma-separated step ids. `--no-system` leaves out steps that use sudo or change the
system (Tailscale, the service and `tailscale serve`); `--allow-sudo` lets the steps that need sudo run without a
terminal (see [sudo](#sudo)); `--https-port` sets the tailnet HTTPS port (default 8443).

When the broker first starts, it rewrites the `entrypoint` field in transcripts that earlier broker sessions wrote
under `~/.claude/projects`, so VS Code lists them; each file is copied to `~/.local/state/ccrc/backup/` first. On a
fresh install there is nothing to rewrite.

#### sudo

`install.sh` and `ccrc setup` use sudo only for the base tools, Tailscale (`tailscale-install`, `tailscale-login`,
`tailscale-operator`), and `loginctl enable-linger` when your system refuses it without sudo. Consent to sudo is never
taken from `--yes`:

- With a terminal, each use says what it runs and why, and asks, `--allow-sudo` or not.
- Without a terminal (from a script, say), it runs only with `--allow-sudo`, and sudo then has to work without asking
  for a password (a `NOPASSWD` rule, for example); otherwise that sudo fails and so does the step. Without
  `--allow-sudo`, `install.sh` stops before installing base tools, and setup leaves the step as "sudo consent needed",
  goes on with the steps that do not depend on it, and says how to finish: run `ccrc setup` in a terminal, or again
  with `--allow-sudo`.
- Before 0.7.1, setup took `--yes` as consent to sudo and had no `--allow-sudo`. When `install.sh` installs such a
  version (`--version v0.7.0`) with `--yes` and without `--allow-sudo`, it runs that setup without `--yes`, so each
  question is asked, or, without a terminal, stops once the code is installed.
- `--no-system` leaves out those steps altogether. `deploy/install-service.sh` (`ccrc setup --only service --yes`)
  never uses sudo: under `--yes` linger is left as it is.

### On the phone

1. Install the Tailscale app and sign in with the same Tailscale account as the machine.
2. Open the address setup showed (`https://<machine>.<tailnet>.ts.net:8443`) in Safari and sign in with the ccrc ID
   and password.
3. Share > Add to Home Screen, then open ccrc from the home screen.
4. In ccrc's settings, turn on notifications and send a test one (iOS 16.4 or later; iOS allows web push only in
   home screen apps).

Android with Chrome should work the same way, but has not been tested.

### VS Code

Setup adds one line to VS Code's user settings:

```json
"claudeCode.claudeProcessWrapper": "/home/user/.local/share/ccrc/current/bin/ccrc-wrapper"
```

Claude Code tabs opened after that go through ccrc; tabs already open keep running without it until you close and
open them again (or reload the window). The wrapper relays only conversation processes; anything else (config
probes, `auth status`, worktree cleanup) runs Claude Code directly. VS Code keeps working the same way when the
broker is down, and the wrapper reconnects when it comes back.

- A permission prompt shows in VS Code and on the phone; the first answer counts.
- Opening a session in VS Code that the broker is running hands it over to VS Code. A session another process
  (a terminal, say) still holds opens in VS Code as a fork after waiting up to 9 seconds, so two processes never write
  one transcript.
- The wrapper does two things the extension turns off when a wrapper is set: it resumes a turn cut off by a window
  reload (up to twice, within an hour; `claudeCode.continueAfterReload: false` turns this off), and it starts new tabs
  in the permission mode VS Code remembered.
- When Claude sends a notification (its PushNotification tool), ccrc sends it to the phone. The wrapper adds one
  PostToolUse hook to the extension's `initialize` and answers it itself: while a phone takes those notifications,
  Claude reads "Mobile push requested." rather than Claude Code's "not sent", or, while the phone shows that session,
  that a notification was not needed; nothing else about the call changes, and VS Code's own hooks reach VS Code as
  before. Tabs opened with an older wrapper still get the push, and Claude reads Claude Code's own answer.
- To turn ccrc off for VS Code, remove the setting, or add `CCRC_WRAPPER=off` to
  `claudeCode.environmentVariables`.

## Update and roll back

The broker looks for new releases a minute after it starts and then daily (`git ls-remote`, no GitHub API), and shows
a new version in the phone's settings (status page) and in `ccrc status`. On an install (not a development checkout),
a phone with notifications on gets one notification per new release. Updates are applied on the machine, in a
terminal or VS Code's terminal:

```bash
ccrc update --check        # only report
ccrc update                # newest release on your channel
ccrc update --to v0.7.1    # a given version, newer or older
ccrc rollback              # back to the version before the last update
```

`ccrc update [--check] [--to <version>] [--channel stable|rc] [--yes] [--from <repository>[@<ref>]]`:

1. Finds the newest release tag (release candidates only with `--channel rc` or `updateChannel: "rc"`).
2. Fetches it into `versions/<version>`, shows its CHANGELOG section (breaking changes separately), and asks.
   From 0.7.2 an install holds `.ccrc-allowed-signers`, and the tag's SSH signature must check out against it
   (`git verify-tag`); see [Verifying a release](#verifying-a-release). A copy already in `versions/<version>`
   (left by `install.sh` or an earlier update) is used only when it passes the same check, and fetched again otherwise.
3. Builds it beside the running version (`npm ci`, `npm run build`); the service keeps running meanwhile.
4. Backs up config and state to `~/.local/state/ccrc/backup/update-<old>-<new>-<time>/` and migrates them with the
   new version's code.
5. Records the switch in `~/.local/share/ccrc/history.json`, moves the `current` link, restarts `ccrc.service`, and
   waits up to 30 seconds for `/api/ping` to report the new version.
6. If it does not, it moves the link back, restores the backup, restarts the old version, and exits with code 3.
7. Keeps the previous version (open VS Code tabs may still run its wrapper) and removes older ones.
8. Tells you what else to do: reload VS Code windows when the wrapper protocol changed, and fully close and reopen
   the phone's home screen app.

`ccrc update`, `ccrc rollback`, setup's `service` step and `ccrc uninstall` refuse to run inside a broker session
(asking Claude to run them from the phone, for example): those sessions run inside `ccrc.service`, so restarting it
would stop the command halfway, before it could confirm the new version or go back.

Exit codes: 0 done or nothing to do, 1 stopped before anything was switched, 3 the update failed and the old
version is back, 4 the old version could not be confirmed after going back (check `systemctl --user status
ccrc.service`). `ccrc rollback` exits with 4 when the service cannot be restarted.

`ccrc rollback` returns to the version before the last update and puts back the config and state files that update's
migration reported changing (the current ones are backed up first), so later password changes and notification
subscriptions are kept. Ctrl-C is held while a switch is being confirmed, so a cut-off run can still be rolled back.

Change versions with `ccrc update`, not `install.sh --version`: `install.sh` does not record the switch in
`history.json`, so `ccrc rollback` cannot undo it.

`ccrc update --from <repository>[@<ref>]` installs a commit of a local repository as a version (named by
`git describe`) the same way, for trying changes before a release. The install keeps looking for releases where it did
before. In a development checkout, `ccrc update` only explains this; `--check` works there too.

## Uninstall

```bash
ccrc uninstall [--purge] [--yes] [--dry-run]
```

In this order: removes `claudeCode.claudeProcessWrapper` from VS Code's settings (after a backup; VS Code could not
start Claude Code if the wrapper went first), stops and removes `ccrc.service`, turns off its `tailscale serve`, and
removes `~/.local/share/ccrc` with the installed versions and the `~/.local/bin/ccrc` link. `--purge` also removes
settings (`~/.config/ccrc`) and state (`~/.local/state/ccrc`, with the backups); the copy of VS Code's settings is then
kept next to `settings.json` instead. Tailscale, Node.js on the system and Claude Code are left alone.

- It only removes a VS Code setting or service that points into the install. When one is left because it runs a
  development checkout, `~/.local/share/ccrc/node` stays too, as that checkout finds Node.js there.
- It never touches `/`, your home folder, `~/.config`, `~/.local`, `~/.local/share`, `~/.local/state`, `~/.cache` (or
  the `XDG_*` folders set instead), or a folder holding one of them.
- A folder is removed whole only when it is named `ccrc`. In a folder of another name (`CCRC_DATA_DIR`,
  `CCRC_CONFIG_DIR` or `CCRC_STATE_DIR` set to it), only the files and folders ccrc makes are removed.

## Commands

| Command | Does |
|---|---|
| `ccrc serve` | Run the broker (what the service runs) |
| `ccrc setup [options]` | Check each part of the setup and do what is missing (`ccrc setup --help`) |
| `ccrc passwd` | Set the login ID and password |
| `ccrc status` | Version, config file, listen address, wrapper socket, allowed devices, newest release, broker sessions, login and current remote use |
| `ccrc logout` | End the current remote login |
| `ccrc version`, `ccrc --version` | The version: the installed release, `git describe` in a checkout, else package.json's |
| `ccrc config path` | Where config.json is |
| `ccrc config get [key]` | The config, or one key of it |
| `ccrc config set <key> <value>` | Change a key; a value that is not JSON is taken as a string. Unknown keys are refused |
| `ccrc config set-api-key` | Store the Anthropic API key for `brokerSessions: "apiKey"` (typed hidden, or from stdin) |
| `ccrc migrate` | Bring config.json to this version's format (`serve` does this too) |
| `ccrc update [...]`, `ccrc rollback [--yes]` | See [Update and roll back](#update-and-roll-back) |
| `ccrc uninstall [...]` | See [Uninstall](#uninstall) |
| `ccrc-wrapper` | The value of VS Code's `claudeCode.claudeProcessWrapper`; not run by hand |

`GET /api/ping` answers `{ "ok": true, "version": "..." }` without a login, to this machine and to allowed devices.

## Configuration

`~/.config/ccrc/config.json`. Change it with `ccrc config set` or by editing the file. The file is checked when read:
a key of the wrong type stops the broker with the key and what it takes, broken JSON is reported with its line and
column, and unknown keys are only warned about. A running broker takes in changes at once, except `host`, `port` and
`claudePath`, which need a restart (`systemctl --user restart ccrc.service`).

| Key | Default | Meaning |
|---|---|---|
| `schemaVersion` | `1` | Format of the file, written by ccrc. Older files are migrated after a backup to `~/.local/state/ccrc/backup/migrate-<from>-<to>-<time>/`; a file from a newer ccrc is refused with a hint to update or roll back |
| `brokerSessions` | `"off"` | How sessions ccrc starts itself sign in: `"off"`, `"apiKey"` or `"subscription"` (see [above](#how-sessions-the-phone-starts-sign-in-brokersessions)). A config from 0.6 or earlier becomes `"subscription"` |
| `allowedDevices` | `[]` | Tailnet machines allowed through `tailscale serve`, by the first label of their MagicDNS name in your tailnet (`"phone"` for `phone.<tailnet>.ts.net`; not the host name a device reports) |
| `allowLocal` | `true` | Allow requests from this machine itself |
| `roots` | `[]` | Folders (and below) where new sessions may start, besides folders that already have sessions |
| `claudePath` | `"vscode"` | Claude Code CLI for broker sessions: a path, or `"vscode"` for the one bundled in the newest VS Code extension, picked again at each session start; without one, `~/.local/bin/claude`, else the CLI that comes with the Agent SDK |
| `leaseIdleMinutes` | `720` | The remote login ends after this long without activity |
| `sessionIdleMinutes` | `15` | Broker session processes nobody is viewing, with no work or open prompt, close after this long |
| `host` | `"127.0.0.1"` | Address the broker listens on (keep it on loopback; the phone reaches it through `tailscale serve`) |
| `port` | `8737` | Port the broker listens on |
| `updateCheck` | `true` | Look for new releases a minute after start and daily |
| `updateChannel` | `"stable"` | `"stable"`, or `"rc"` to include release candidates |
| `updateRepo` | (unset) | Repository to look in when the install does not name its source; else `https://github.com/rjs0429/ccrc.git` |
| `updateNotify` | `true` | Send one push notification per new release to subscribed phones |

Other settings (notifications, Enter to send, Claude Code's own settings) are changed in the phone's settings screen.

### Environment variables

| Variable | Meaning |
|---|---|
| `CCRC_CONFIG_DIR` | Config folder (default `$XDG_CONFIG_HOME/ccrc`, i.e. `~/.config/ccrc`) |
| `CCRC_STATE_DIR` | State folder (default `$XDG_STATE_HOME/ccrc`, i.e. `~/.local/state/ccrc`) |
| `CCRC_DATA_DIR` | Install folder (default `$XDG_DATA_HOME/ccrc`, i.e. `~/.local/share/ccrc`) |
| `CCRC_NODE` | Node.js 22.18+ for `ccrc` and the wrapper; looked for first, before `<dataDir>/node/bin/node`, the Node the install recorded and `PATH`. Setup writes it into the service unit, which only the service reads: the wrapper sees it only in VS Code's own environment (or `claudeCode.environmentVariables`) |
| `CCRC_VSCODE_EXTENSIONS_DIR` | VS Code extensions folder (default `~/.vscode/extensions`) |
| `CLAUDE_CONFIG_DIR` | Claude Code's folder (default `~/.claude`); ccrc follows it everywhere |
| `CCRC_WRAPPER=off` | In `claudeCode.environmentVariables`: VS Code runs Claude Code without ccrc |
| `CCRC_SEND_FILES=0` | Do not turn on Claude Code's file sending (`CLAUDE_CODE_ATTACHMENTS_BY_PATH`) in ccrc's sessions |
| `CCRC_LINK_SOCKET` | Socket where the wrapper and the broker meet (default `$XDG_RUNTIME_DIR/ccrc/link.sock`) |
| `CCRC_WRAPPER_LOG` | Wrapper log file (default `<stateDir>/wrapper.log`) |
| `CCRC_LOG_LEVEL` | Broker request log level (default `info`; the service unit sets `warn`) |
| `CCRC_REPO_URL`, `CCRC_NODE_DIST` | `install.sh` only: repository and Node.js download source |

When `CCRC_CONFIG_DIR`, `CCRC_STATE_DIR`, `CCRC_DATA_DIR`, `CLAUDE_CONFIG_DIR` or `CCRC_VSCODE_EXTENSIONS_DIR` is set
while setup runs, setup writes it into the service unit too.

## Files and folders

| Path | Holds |
|---|---|
| `~/.local/share/ccrc/versions/<version>/` | Installed versions (git copies with their build and `.ccrc-install.json`) |
| `~/.local/share/ccrc/current` | Link to the running version; the service and VS Code use paths through it |
| `~/.local/share/ccrc/node` | Node.js downloaded by `install.sh` (when it had to); in a development checkout, a link you make to a Node.js folder so `ccrc` and the wrapper find it |
| `~/.local/share/ccrc/history.json` | Each update and rollback, with its backup folder |
| `~/.local/bin/ccrc` | Link to `current/bin/ccrc` |
| `~/.config/ccrc/config.json` | Settings |
| `~/.config/ccrc/state.json` | Login ID, Argon2id password hash, current login, lockout |
| `~/.config/ccrc/push.json` | Web Push keys and subscriptions |
| `~/.config/ccrc/anthropic-api-key` | The API key for `brokerSessions: "apiKey"` (0600) |
| `~/.config/systemd/user/ccrc.service` | The service |
| `~/.local/state/ccrc/audit.jsonl` | Audit log |
| `~/.local/state/ccrc/backup/` | Backups: config migrations, updates, rollbacks, VS Code settings, the service unit, rewritten transcripts. Update and rollback backups copy the whole config folder, with the API key, the password hash and the Web Push keys; the newest three and those of the last three updates are kept |
| `~/.local/state/ccrc/update-check.json` | The last new-release check |
| `~/.local/state/ccrc/install.log`, `wrapper.log` | Logs of `install.sh` and the wrapper (no conversation content) |
| `~/.local/state/ccrc/uploads/` | Phone attachments, kept 24 hours |
| `~/.local/state/ccrc/*.json`, `turns/`, `cli/`, `doctor/` | Working state: archived and unread sessions, recent remote activity, start settings, model and context window lists, the last compatibility check, cut-off turns |
| `$XDG_RUNTIME_DIR/ccrc/link.sock` | Wrapper and broker socket |

The config and state folders (`~/.config/ccrc`, `~/.local/state/ccrc`) are private to you (0700) and the files in them
0600; the install folder (`~/.local/share/ccrc`) holds code and Node.js and has the usual permissions. After changing
or revoking the API key, also delete the update and rollback backups that still hold the old one
(`~/.local/state/ccrc/backup/update-*`, `rollback-*`). Editing Claude Code's settings from the phone saves each change
at once and backs the file up next to it as `settings.json.ccrc-<time>.bak`, once per ten minutes of editing: the copy
from before ccrc first changed the file stays, and so do the last ten. ccrc's file viewer treats them as secret, as it
does the file.

## Security model

- **Tailnet only.** The broker listens on `127.0.0.1`. The phone reaches it through `tailscale serve`, which offers it
  over HTTPS inside your tailnet only (not Tailscale Funnel). Nothing is exposed to the internet.
- **Device allowlist.** A request through `tailscale serve` is let in only when its tailnet address belongs to a
  device of your tailnet whose MagicDNS name is in `allowedDevices` (looked up with `tailscale status`; machines shared
  in from other tailnets never match). `ccrc setup` offers only the phones of the Tailscale user the machine belongs
  to for it, and `--yes` adds one only when there is exactly one. Requests from the machine itself need `allowLocal`.
  A program on the machine can pass its request off as coming through `tailscale serve`, so `allowLocal: false` does
  not keep out other users of the machine; the login does.
- **Login.** An ID and password, stored as an Argon2id hash. After five failed logins, logins lock for 5 minutes,
  doubling up to an hour, also across restarts. The session cookie is HttpOnly, Secure and SameSite=Strict;
  POST requests and WebSockets have their Origin checked, and pages carry a Content Security Policy.
- **One remote login at a time.** Signing in on another device or window asks first and then ends the other login.
  The login ends after `leaseIdleMinutes` without activity.
- **No remote bypass.** The phone cannot switch any session to `bypassPermissions`: the broker refuses it, and the
  wrapper refuses any request or answer that would. The wrapper accepts only an allowlist of control requests from
  the broker.
- **Files.** The file viewer reads within a session's folders only and answers "denied" for anything else, whether it
  exists or not. Secret files (`.env*`, key files, `.ssh`, `.gnupg`, cloud and package-manager credentials, Claude
  Code's settings and credentials, ccrc's own folders, `/proc`) are blocked for every session, also for files Claude
  sends to the phone, for `@` suggestions and for the lines of the changes sheet's git view, which also shows the
  lines of files inside the session's folders only.
- **Audit log.** Logins, failed logins, denied devices, messages sent, answers, mode and model changes, file reads,
  git changes read, side questions, new sessions and forks are recorded in `audit.jsonl`, without message contents.
- **Local socket.** The wrapper socket is 0600 in a 0700 folder owned by you; both sides check this, and it never
  falls back to a shared folder such as `/tmp`.
- **Secrets.** The API key is passed only to broker sessions' Claude Code as `ANTHROPIC_API_KEY`, and never written to
  logs, the audit log, the screen or API answers. Notifications carry the session title and the kind of request only,
  unless "도구 이름 표시" (show tool names) is on for the device: then also the tool or file name, or the text of a
  notification Claude sends.

### What leaves your machine

- **Claude Code** talks to Anthropic's API as it always does; ccrc adds nothing to that.
- **New-release check:** a minute after the broker starts and then daily, `git ls-remote` to the repository updates
  come from (GitHub by default). GitHub sees the machine's address and the time; ccrc sends no version or identifier.
  `updateCheck: false` turns it off, `updateNotify: false` only the notification.
- **Notifications** go through the phone's push service (Apple's or Google's), encrypted end to end; they carry the
  session title and the kind of request (with "도구 이름 표시" on, also the names and Claude's text described above).
- **Tailscale** keeps its own connection to its coordination server; the phone's traffic to the broker stays on the
  tailnet.
- **Installing and updating** fetch from GitHub, nodejs.org and the npm registry.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Known gaps of the VS Code wrapper

- With a wrapper set, the extension skips its "still open somewhere else" check. ccrc covers it by waiting for the
  other process and opening a fork when it does not let go.
- Reopening a conversation that ended in plan mode does not bring plan mode back.
- With `claudeCode.useTerminal` on, VS Code does not use the wrapper, and those sessions are view-only on the phone.
- A model changed on the phone shows in VS Code's model picker from the next reply; a message queued on the phone shows
  in VS Code once Claude Code takes it.
- Some VS Code dialogs (usage limit consent, for example) show on the phone but are answered in VS Code.
- Side questions from the phone, and the changes sheet's git view as Claude Code sees it, need the wrapper of ccrc 0.8
  or later: a tab opened before an update keeps its older wrapper until it is opened again. Side questions asked from
  the phone do not show in VS Code's side panel.
- When removing ccrc by hand, remove the VS Code setting before the files (`ccrc uninstall` does this).

## Limitations

- The phone app is in Korean only.
- Linux with systemd only; no macOS, WSL or VS Code Remote-SSH. VS Code's settings are looked for in `~/.config/Code`
  and its extensions in `~/.vscode/extensions`, as Microsoft's build keeps them: not Insiders, VSCodium or Code - OSS
  (Arch's `code` package; use `visual-studio-code-bin` there). With another build, setup skips the `vscode` step.
- One user per machine and one remote login at a time.
- Sessions run on the machine, so it has to be on and online. Sessions started in a terminal are view-only.
- In `apiKey` mode, commands Claude runs in a broker session (the Bash tool, for example) inherit Claude Code's
  environment and so can read the key.
- The installer is new. ccrc has run daily on Ubuntu 24.04. On 2026-10-18 `install.sh` from GitHub installed v0.7.0
  over an existing 0.6 setup on Ubuntu 24.04: setup kept the settings, the phone's notifications and `tailscale serve`
  as they were, and moved only the service and the VS Code wrapper to the install. Installs on other distributions
  (Debian, Fedora, Arch, openSUSE) and on a fresh machine have not been tried yet.

## Development

```bash
git clone https://github.com/rjs0429/ccrc.git && cd ccrc
npm ci
npm run build        # the web app (served by the broker) and the VS Code wrapper's relay
npm run typecheck
npm test             # broker unit tests
npm run dev -w web   # Vite dev server, proxying to a broker on :8737
bin/ccrc serve
```

`bin/ccrc` and `bin/ccrc-wrapper` look for Node.js 22.18+ in `CCRC_NODE`, `<dataDir>/node/bin/node`, the install's
recorded Node, then `PATH`; without one, `ccrc` stops with an error and the wrapper runs Claude Code directly, noting
it in `wrapper.log`. VS Code started from a desktop, and the service, often have no Node.js on `PATH`, so in a checkout
link one: `mkdir -p ~/.local/share/ccrc && ln -s /path/to/node-v22 ~/.local/share/ccrc/node`. The broker runs from
its TypeScript sources (Node's type stripping); the wrapper uses the built relay while it is newer than its sources.

Running `bin/ccrc setup` from a checkout points the service and VS Code at that checkout; `deploy/install-service.sh`
runs only its service step, so it changes the service and not VS Code. To try a commit on an install instead, use `ccrc update --from <repo>[@<ref>]`.

GitHub Actions runs the same `npm ci`, typecheck, tests and build on Node.js 22 for pushes to `main` and `dev` and
for pull requests (`.github/workflows/ci.yml`).

When a change adds a config key, a state file, an outside tool or a path, update `ccrc setup`, the migrations in
`broker/src/config.ts`, this README and the CHANGELOG's Unreleased section together. Test data uses example values
only (`100.64.0.x`, `*.example.ts.net`, `/home/user`).

## Versions

ccrc follows [Semantic Versioning](https://semver.org). Before 1.0, a new feature stage or an incompatible change
raises MINOR and fixes raise PATCH. Releases are annotated tags on `main`, and tags are never moved. The compatibility
promise covers the commands, the port, the minimum Node.js, the one VS Code setting line, the wrapper protocol
(`LINK_VERSION`) and the config and state formats; breaking it is listed under "Breaking" in
[CHANGELOG.md](CHANGELOG.md), with what to do, and `ccrc update` shows those lines before it asks.

## Releases

Each release tag has a GitHub Release on the [Releases page](https://github.com/rjs0429/ccrc/releases) with its
CHANGELOG section, the commands to install or update to it, and a link to the changes since the release before it.
They are made automatically: pushing a tag runs `.github/workflows/release.yml`, which runs
`scripts/sync-releases.sh` (notes from `scripts/release-notes.sh`). Tags with a `-` (`v0.8.0-rc.1`) become
pre-releases, and the highest other tag is marked latest. Pushes to `main` and a manual run of the workflow make any
release a failed run left out; releases that exist are left alone. A release has no files of its own beyond GitHub's
source archives: `install.sh` and `ccrc update` build ccrc on your machine from the tag.

From 0.7.2, release tags are signed with an SSH key listed in `.ccrc-allowed-signers` at the repository root, and the
workflow makes a release only when the tag's signature checks out against that file.

### Verifying a release

In a clone, with OpenSSH's `ssh-keygen` installed:

```bash
git fetch --tags
git -c gpg.ssh.allowedSignersFile=.ccrc-allowed-signers verify-tag v0.7.2
```

It prints `Good "git" signature for 79899760+rjs0429@users.noreply.github.com with ED25519 key
SHA256:7tvRIQuI7tARS7iihd3ezgTJycbqrIN8E9TPofkuAAw` and exits with 0; a tag without a signature, or signed by a key not
in the file, fails. Look for that line: git checks an OpenPGP signature against your GnuPG keyring, not the file
(`ccrc update` and the release workflow accept SSH signatures only). The file comes with the clone, so compare its key
with the signing key on the author's GitHub account (<https://api.github.com/users/rjs0429/ssh_signing_keys>); GitHub
also marks the tag Verified. If your git config sets `gpg.ssh.program` to a program that only signs, add
`-c gpg.ssh.program=ssh-keygen` to the command.

`ccrc update` does this by itself from 0.7.2: an install of 0.7.2 or newer holds `.ccrc-allowed-signers`, and
`ccrc update` checks the tag it fetched against the install's own copy of the file before building it, and stops when
it does not pass. The signature must check out, the tag must have been signed under the name it was fetched as (a
signed older release offered under a newer name does not pass), and the copy must be at the commit the tag names. A
copy of that version already in `versions/` gets the same check before it is used, and the tag is fetched again when
the copy does not pass. git checks with the `ssh-keygen` on `PATH` and the file alone, whatever `gpg.ssh.program` or
`gpg.minTrustLevel` your git config sets. An update from 0.7.1 or older to 0.7.2 is not checked, as those
versions have no such file; check `v0.7.2` by hand as above if you want to. Without `ssh-keygen`, `ccrc update` on
0.7.2 or newer cannot check and stops, with the command that installs it; `install.sh` installs it with the other base
tools (and goes on with a warning when it stays missing), and `ccrc setup` warns when it is missing. An `ssh-keygen`
older than OpenSSH 8.2 cannot check SSH signatures either: `ccrc update` stops saying so, and `ccrc setup` warns about
it beforehand.

## License and Anthropic's terms

ccrc is under the [MIT License](LICENSE).

ccrc does not include Claude Code or the Claude Agent SDK. Claude Code is Anthropic's software, not open source, and
ccrc runs the extension and CLI you installed without modifying them. `npm ci` fetches
`@anthropic-ai/claude-agent-sdk` from npm under Anthropic's terms. Your use of Claude Code, the Agent SDK and Claude
through ccrc is governed by your own agreement with Anthropic (the Consumer or Commercial Terms) and the
[Usage Policy](https://www.anthropic.com/legal/aup); see [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance).
Claude and Claude Code are trademarks of Anthropic, used here only to say what ccrc works with.
