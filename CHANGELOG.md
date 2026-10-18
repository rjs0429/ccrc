# Changelog

All notable changes to ccrc are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and ccrc uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). `ccrc update` shows the sections between
your version and the new one, and the lines under "Breaking" separately.

## [Unreleased]

### Added

- Agent map: a subagent's transcript open on the phone now updates as Claude Code writes it. While it is open the
  broker watches the file (the kernel's file watch, or a look at its size twice a second where no watch is left, as an
  editor watching a large tree can use them all), reads only what was added, and sends the new items over the
  WebSocket; the phone reads it every 2 seconds again only when the broker cannot follow the file. A shell's output is
  read by the broker every second while it changes, every 2 seconds while it does not, and once more when the shell
  ends, and sent only when it changed.
- "백그라운드로" (move to background) on a Bash or Agent card the turn waits on, once Claude Code lists it as running in
  the foreground (a subagent after 2 seconds), and on the agent map's card of a subagent or shell running in the
  foreground: Claude Code moves it to the background, the card says it runs there, and the turn goes on. Broker
  sessions use the Agent SDK's `backgroundTasks`; VS Code sessions need this release's wrapper (reload the VS Code
  window), which says so in its hello and passes `background_tasks` on only for a call Claude Code runs in the
  foreground. With an older wrapper the card shows how to get it instead of the button.

## [0.7.3] - 2026-10-18

### Fixed

- A machine without OpenSSH's `ssh-keygen` installed ccrc but stopped at its first `ccrc update`, which checks release
  signatures with it. `install.sh` now counts `ssh-keygen` among the base tools and installs it with them
  (`openssh-client`, `openssh-clients` or `openssh`, asking for sudo as before); `ccrc setup` has an `ssh-keygen` step
  that says why it is needed and how to install it; and `ccrc update` says what to install, or that OpenSSH is older
  than 8.2, instead of reporting a signature that does not check out.

## [0.7.2] - 2026-10-18

### Added

- GitHub Releases: `.github/workflows/release.yml` runs `scripts/sync-releases.sh` when a tag is pushed, which makes a
  Release for each tag from v0.7.0 that has none, with its CHANGELOG section, install and update commands and a
  compare link (`scripts/release-notes.sh`). Tags with a `-` become pre-releases; pushes to `main` and a manual run
  fill in releases a failed run left out.
- CI: `.github/workflows/ci.yml` runs `npm ci`, `npm run typecheck`, `npm test` and `npm run build` on Node.js 22 for
  pushes to `main` and `dev` and for pull requests.

### Security

- Release tags are signed with SSH from 0.7.2, with the keys in `.ccrc-allowed-signers` at the repository root. An
  install of 0.7.2 or newer holds that file, so `ccrc update` checks each tag it updates to with `git verify-tag` and
  stops unless it carries an SSH signature from a key in that file; this needs OpenSSH's `ssh-keygen`. The release
  workflow makes no Release for such a tag either. The update from 0.7.1 or older to 0.7.2 is not checked; the README's
  "Verifying a release" shows how to check a tag by hand.

## [0.7.1] - 2026-10-18

### Changed

- Consent to sudo is no longer taken from `--yes`. In `install.sh` and `ccrc setup`, every use of sudo (base tools,
  Tailscale's installer, `tailscale up`, `tailscale set --operator`, and `sudo loginctl enable-linger` when linger
  needs it) says what it runs and why and asks at the terminal, `--yes` or not. Without a terminal it runs only with
  the new `--allow-sudo` option, which `install.sh` also passes on to setup; otherwise `install.sh` stops before
  installing base tools, and setup leaves the step as "sudo consent needed", goes on with the steps that do not need
  it, and says how to finish. `deploy/install-service.sh` still uses no sudo. When `install.sh` installs an earlier
  version, whose setup takes `--yes` as consent to sudo, it runs that setup without `--yes` (or, without a terminal,
  stops before it) unless `--allow-sudo` is given.

### Fixed

- When looking for a new version fails (the update check, and `ccrc update`), the message now names the line of
  git's output that says why ("Repository not found.", "Could not resolve host", a timeout) instead of git's closing
  advice ("and the repository exists."). A user name or token in the repository URL is still left out.

## [0.7.0] - 2026-10-18

The first public release: an installer, updates, and the changes needed to run on machines other than the author's.

### Breaking

- The VS Code wrapper now needs Node.js 22.18 or newer, as `ccrc` does (its built relay used to run on Node.js 20).
  Without one it runs Claude Code directly and notes it in `wrapper.log`, so VS Code keeps working but the phone cannot
  see or drive its sessions.
- `bin/ccrc` and `bin/ccrc-wrapper` no longer look in `~/.local/opt/node22`. They look in `CCRC_NODE`,
  `<dataDir>/node/bin/node`, the Node.js the install recorded, then `PATH`. A development checkout needs one of these
  before it is updated: see "Upgrading from 0.6".
- `allowedDevices` matches only the first label of a machine's MagicDNS name in your tailnet, no longer the host name
  the machine reports itself, and never machines shared in from another tailnet. An entry that named a host name
  different from the MagicDNS name no longer lets that machine in.

### Added

- `install.sh`: checks the platform, installs missing base tools (asks first, uses sudo), downloads Node.js 22 checked
  against `SHASUMS256.txt` when no Node.js 22.18+ is found, builds ccrc into `~/.local/share/ccrc/versions/<version>`,
  links `current` and `~/.local/bin/ccrc`, then runs `ccrc setup`. Options `--version`, `--ref`, `--from`,
  `--channel stable|rc`, `--yes`, `--dry-run`, `--no-system` and `--uninstall`; other options, and everything after
  `--`, go to `ccrc setup`. Environment `CCRC_REPO_URL`, `CCRC_DATA_DIR`, `CCRC_STATE_DIR`, `CCRC_NODE` and
  `CCRC_NODE_DIST`. It reuses the Node.js an existing install recorded, and logs to `<stateDir>/install.log`.
- `ccrc setup [--yes] [--dry-run] [--only ids] [--skip ids] [--no-system] [--no-vscode] [--no-serve] [--https-port N]`:
  checks each part (Claude Code, Tailscale install, login and operator, MagicDNS and HTTPS, the allowed phone, the ccrc
  login, settings, the service, `tailscale serve`, the VS Code wrapper setting, the phone, the compatibility check) and
  does only what is missing; running it again finishes or repairs. It asks how broker sessions sign in, and changes
  VS Code's `settings.json` in place, keeping comments and layout, after a backup. It keeps settings already in
  config.json (an empty `roots` list too), signs in to Tailscale with a bare `tailscale up` so the machine's other
  Tailscale settings stay, and asks before turning on linger. With `--yes`, steps that use sudo run without asking.
- `ccrc uninstall [--purge] [--yes] [--dry-run]`: removes VS Code's wrapper setting first, then the service,
  `tailscale serve` and the installed versions; `--purge` also removes settings and state, and keeps the copy of VS
  Code's settings next to `settings.json`. `<dataDir>/node` stays while a development checkout the service or VS Code
  runs still needs it.
- `ccrc update [--check] [--to <version>] [--channel stable|rc] [--yes] [--from <repo>[@<ref>]]`: builds a release
  beside the running one, shows its changes, backs up and migrates config and state, switches the `current` link,
  restarts the service and checks `/api/ping`, going back on its own when the new version does not answer (exit code 3;
  4 when the old version cannot be confirmed either). A failed update puts config and state back exactly as they were.
  Ctrl-C is held until a switch is confirmed or undone.
- `ccrc rollback`: returns to the version before the last update and restores the config and state files that update's
  migration reported changing (`ccrc migrate --json`). Exits with code 4 when the service cannot be restarted.
- `ccrc update`, `ccrc rollback`, setup's service step and `ccrc uninstall` refuse to run inside `ccrc.service` (a
  session the broker started, such as one asked from the phone), whose restart would stop them halfway.
- Update and rollback keep their three newest backups and those of the last three history entries, and remove older
  ones.
- `<dataDir>/history.json`, a record of each update and rollback with its backup folder.
- Optional tag signature checks: when an install has `.ccrc-allowed-signers`, `ccrc update` requires
  `git verify-tag` (SSH signatures) to pass.
- A new-release check in the broker, a minute after start and then daily (`git ls-remote` with a time limit), stored in
  `<stateDir>/update-check.json`, with the config keys `updateCheck`, `updateChannel`, `updateRepo` and `updateNotify`.
  An install sends one push notification per new release to subscribed phones.
- The settings status page and `/api/health` show the ccrc version, whether it is an install or a development checkout,
  the newest release with a link to its changes, and when it was last checked.
- `brokerSessions` setting (`off`, `apiKey`, `subscription`) decides whether and how sessions ccrc starts itself through
  the Agent SDK sign in. New installs default to `off`.
- With `apiKey`, broker sessions get the key stored by `ccrc config set-api-key` (`<configDir>/anthropic-api-key`,
  0600), and nothing else sees it.
- When broker sessions are off or have no key, the phone greys the new-session button, shows the reason and how to turn
  them on, and hides the start and fork actions; the status page shows the mode read-only. Storing a key while the
  broker runs tells an open phone right away.
- `ccrc config path | get [key] | set <key> <value> | set-api-key` to read and change config.json from the terminal.
- `ccrc update --from` records where the install looked for releases before (`updateSource` in the install info), so
  trying local work does not move the new-release check off GitHub.
- `ccrc version` (and `--version`): the installed version, `git describe` for a development checkout, else
  package.json's.
- `GET /api/ping` answers `{ ok, version }` without a login, to this machine always and to allowed devices.
- config.json is checked on load: a key of the wrong type stops the broker with the key and what it takes, unknown keys
  are warned about, and broken JSON is reported with its line and column.
- A running broker takes in changes to `allowedDevices`, `allowLocal`, `roots`, `brokerSessions`, `leaseIdleMinutes`,
  `sessionIdleMinutes` and the update keys without a restart, and logs that `host`, `port` and `claudePath` need one.
- config.json has a `schemaVersion`. `ccrc serve` and `ccrc migrate` bring older files up to date after copying them to
  `<stateDir>/backup/`; a file from a newer ccrc is refused with a hint to update or roll back.
- `CCRC_VSCODE_EXTENSIONS_DIR` sets the VS Code extensions folder.
- README for public use, this changelog, a license (MIT) and a security policy.

### Changed

- `ccrc status` also shows the version, the newest release the broker has seen, and the `brokerSessions` mode.
- `deploy/install-service.sh` runs setup's service step: the unit runs `<dataDir>/current/bin/ccrc serve` for an
  install, records `CCRC_NODE`, and checks `/api/ping`; a replaced unit is copied to `<stateDir>/backup/`, and its
  `Environment` lines that setup does not write are carried over. Linger is optional and left as it is with `--yes`.
  It changes only the service, not VS Code's setting.
- package.json carries the version.
- New dependency: `jsonc-parser`.

### Fixed

- Claude Code's folder follows `CLAUDE_CONFIG_DIR` everywhere, not only for its settings file.
- The VS Code wrapper finds an installed Node.js when VS Code was started from a desktop whose `PATH` has none, instead
  of quietly running Claude Code without ccrc.

### Security

- `install.sh`, `ccrc setup` and `ccrc uninstall` refuse to run as root.
- `ccrc uninstall` never touches `/`, your home folder, `~/.config`, `~/.local`, `~/.local/share`, `~/.local/state`,
  `~/.cache` (or the `XDG_*` folders) or a folder holding one, and removes a folder whole only when it is named `ccrc`;
  elsewhere it removes only what ccrc makes.
- Copies of Claude Code's settings that the phone's settings editor keeps (`settings.json.ccrc-<time>.bak`) are secret
  files to the file viewer, attachments and `@` suggestions, as `settings.json` is.
- `install.sh` keeps its log private (state folder 0700, `install.log` 0600) and keeps Node.js downloads from an https
  source on https.
- The API key never reaches logs, the audit log, the screen or API answers; in `apiKey` mode an inherited
  `CLAUDE_CODE_OAUTH_TOKEN` is removed from broker sessions' environment.
- The new-release check runs git without password prompts or credential helpers, and masks a user name or token in a
  repository URL in errors shown on the status page.

### Upgrading from 0.6

- A development checkout must find Node.js 22.18+ **before you update it** (`git pull` or `git merge`), not only before
  restarting the service: VS Code runs the checkout's `bin/ccrc-wrapper` directly, so from the moment the new code is
  in place, new Claude tabs run without ccrc when it finds no Node.js, and the service fails to start at its next
  restart. VS Code started from a desktop and the service often have no Node.js on `PATH`. Make the link first, then
  update, then check that `ccrc` finds Node.js without `PATH`:

  ```bash
  mkdir -p ~/.local/share/ccrc && ln -s /path/to/node-v22 ~/.local/share/ccrc/node
  ~/.local/share/ccrc/node/bin/node --version      # v22.18 or newer
  git pull                                         # or git merge
  env -i HOME=$HOME PATH=/usr/bin:/bin bin/ccrc version
  ```

  The link serves both `ccrc` and the wrapper. `deploy/install-service.sh` (run from a shell that finds Node.js 22.18+)
  writes that Node into the service unit as `CCRC_NODE`, which only the service reads; without the link, the wrapper
  needs `CCRC_NODE` in `claudeCode.environmentVariables` instead.
- 0.6 has no `ccrc update`. Either update the checkout (`git pull`, `npm ci`, `npm run build`, then
  `systemctl --user restart ccrc.service`), or move to an install with `install.sh`, which keeps your settings, login
  and notification subscriptions and points the service and VS Code at the install.
- On its first start, 0.7 moves `config.json` to `schemaVersion: 1` and adds `"brokerSessions": "subscription"`, so
  broker sessions keep working as before. The earlier file is kept in `<stateDir>/backup/migrate-0-1-<time>/`. To turn
  broker sessions off or move them to an API key: `ccrc config set brokerSessions off` (or `apiKey`, after
  `ccrc config set-api-key`).
- Check that each name in `allowedDevices` is the first label of the device's MagicDNS name (`tailscale status`).
- Reload VS Code windows so open tabs use the new wrapper, and fully close and reopen the phone's home screen app.

### Tested with

- Claude Code VS Code extension and CLI 2.1.301, Claude Agent SDK 0.3.296
- Node.js 22.18 or newer; Ubuntu 24.04 with systemd 255; Tailscale 1.104.1
- iOS 16.4 or later (home screen app, for notifications)

## [0.6.0] - 2026-10-16

### Added

- Rename sessions (also seen by VS Code and `claude --resume`) and archive them within ccrc.
- Fork a session from the menu or from any message into a new broker session that can run in the background;
  `/fork` and `/branch` open the fork sheet.
- Rewind the conversation as Claude Code does: conversation and code, conversation only, or code only. Broker sessions
  rewind in place; VS Code sessions continue in a fork from that point.
- Start a new session in a new git worktree, and clean worktrees up from the session menu or when archiving.
- Fast mode and Thinking switches for the current session, with markers on the composer.
- Claude can send files to the phone (`SendUserFile`, Claude Code 2.1.300 or later), opened by reference, with secret
  files blocked and a 50 MB limit. `CCRC_SEND_FILES=0` turns it off.
- Agent map: read a subagent's transcript, and the output of shell and monitor tasks.
- Turn-done notifications in three choices (sessions driven from the phone, all sessions, off), an app icon badge, and
  separate wording and urgency for errors, usage limits and Claude Code exiting unexpectedly. Turn-done notifications
  also survive a broker restart.
- Prompts that only VS Code can answer are marked as such in notifications.

### Changed

- `claudePath` defaults to `"vscode"`: broker sessions use the CLI bundled in the newest VS Code extension.
- Composer chips fit on one line when they can, two otherwise; the session menu puts the four frequent actions first.
- Web Push reuses its VAPID signature for six hours and retries once with a new one on 401 or 403.

## [0.5.0] - 2026-10-15

### Added

- Session search by title and message text, jumping to the message found.
- Output style per session, from the session menu.
- MCP input requests (elicitation) answered on the phone, for broker sessions and for VS Code sessions while the
  phone is reachable.
- Model, effort, ultracode and permission mode can be chosen for an inactive session, and applied when ccrc starts it;
  a "start now" button starts it without a message.
- A context ring next to the model chip, opening Context, plan usage and Compact.
- Dedicated views for AskUserQuestion, plan approval and 19 other tools; a raw view for the rest.
- Queued messages show at the bottom until Claude Code takes them, can be taken back, and stay in step with VS Code.
- Photo thumbnails with a full-screen viewer, a jump-to-bottom button, and timestamps under Claude's replies with date
  separators.
- A new-session screen with the full composer (`@`, `/`, attachments, chips).
- Agent map: subagents, workflows and background tasks of a session.
- Agent reports and messages from other sessions as collapsed cards; `!` commands as shell cards.
- Landscape layout, with notch and home indicator areas kept clear.

### Changed

- Commands that open a window in Claude Code (`/context`, `/usage`, `/mcp`, `/model`, `/config` and others) open a
  sheet on the phone and are not sent into the conversation.
- The attachment button opens the iOS picker in one tap.
- Send and stop are one button; the effort chip shows the value only.
- Broker sessions name their own entrypoint, so VS Code lists them; transcripts written by earlier versions are
  rewritten after a backup.
- Secret file names are left out of `@` suggestions.

## [0.4.0] - 2026-10-14

### Added

- Model, effort and ultracode follow what Claude Code reports, also when changed in VS Code; an ultracode switch in
  the effort sheet.
- Cards for command results: `/usage` with a bar per limit, `/context` with its breakdown, others as Markdown; the
  `/` palette opens sheets for `/context`, `/usage`, `/cost`, `/stats`, `/mcp` and `/model`.
- File link viewer: links in replies open files within the session's folders, with line anchors, rendered Markdown,
  highlighted code, images, PDFs, JSON and CSV tables. Secret files are blocked, and each read is in the audit log.

### Changed

- Settings are grouped into pages; chip and menu names follow VS Code's.
- The wrapper accepts only `effortLevel` and `ultracode` in remote flag settings.

## [0.3.0] - 2026-10-14

### Added

- Attachments (photos resized for upload, PDFs, text files), `@` file mentions and `/` commands in the composer.
- Edit and Write diffs, subagent activity and a to-do bar in the conversation.
- Session menu: changes with line comments, running tasks with stop, context breakdown, MCP servers (status, on and
  off, reconnect), and rewinding files to a message.
- Web Push notifications for prompts waiting for an answer and for turns sent from the phone that finished.
- Settings: edit Claude Code's settings (allowed keys only, with backups), a compatibility check whenever the VS Code
  extension changes, the audit log, and Enter to send.
- The wrapper resumes a turn cut off by a VS Code window reload, and starts new tabs in the permission mode VS Code
  remembered.

### Security

- Plan approval accepts only its four decisions, and the wrapper refuses any remote answer that would switch to
  `bypassPermissions`.
- `@` suggestions use git's file list only when the git worktree holds the session folder.

## [0.2.0] - 2026-10-14

### Added

- VS Code wrapper (`bin/ccrc-wrapper`, for `claudeCode.claudeProcessWrapper`): sessions open in VS Code can be driven
  from the phone (live view, messages, stop, model, mode, effort, context usage).
- Permission prompts show in VS Code and on the phone; the first answer counts.
- A session the broker runs is handed over when VS Code opens it; a session another process holds opens as a fork.
- VS Code keeps working while the broker is down, and the wrapper reconnects when it returns.
- The wrapper and the broker meet on a private socket in `$XDG_RUNTIME_DIR/ccrc/`, never in `/tmp`.

## [0.1.0] - 2026-10-13

### Added

- Broker on `127.0.0.1:8737`, run as a systemd user service, and a phone web app served through `tailscale serve`.
- Every Claude Code session on the machine, by folder, with its state (running in ccrc, open in VS Code or a terminal,
  inactive).
- Inactive sessions resume when you send a message; new sessions start in folders that have sessions or in `roots`.
- Conversation view with live streaming, tool cards and thinking; cards for permission prompts, questions and plan
  approval; model, permission mode and effort; stop; input queued while Claude works.
- Sessions open in VS Code are shown live, read-only.
- Login with an ID and an Argon2id-hashed password, lockout after repeated failures, one remote login at a time,
  logout after 12 hours idle.
- Only allowed tailnet devices get in; Origin checks, strict cookies and a Content Security Policy;
  `bypassPermissions` cannot be chosen remotely.
- Idle broker session processes close after 15 minutes; an audit log without message contents; light and dark themes.
- `ccrc serve | passwd | status | logout` and `deploy/install-service.sh`.

[Unreleased]: https://github.com/rjs0429/ccrc/compare/v0.7.3...HEAD
[0.7.3]: https://github.com/rjs0429/ccrc/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/rjs0429/ccrc/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/rjs0429/ccrc/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/rjs0429/ccrc/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/rjs0429/ccrc/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/rjs0429/ccrc/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/rjs0429/ccrc/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/rjs0429/ccrc/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/rjs0429/ccrc/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rjs0429/ccrc/releases/tag/v0.1.0
