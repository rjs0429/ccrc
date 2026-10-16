# ccrc

Self-hosted remote console for the Claude Code sessions on this machine, reachable over Tailscale.
It lists every session by folder, shows live progress, and runs inactive sessions remotely through the
Claude Agent SDK, including permission prompts, questions, plan approval, model, mode, and effort.
With the VS Code wrapper, sessions open in VS Code can be driven remotely as well.

## Requirements

- Node.js 22.18 or newer, the Claude Code CLI logged in, Tailscale with HTTPS certificates enabled.

## Setup

```bash
npm install
npm run build                      # web app (served by the broker) and the VS Code wrapper
bin/ccrc passwd                    # login ID and password (stored as an Argon2id hash)
$EDITOR ~/.config/ccrc/config.json # allowedDevices, roots (created on first run)
deploy/install-service.sh          # systemd user service on 127.0.0.1:8737
tailscale serve --bg --https=8443 http://127.0.0.1:8737
```

Only one login can be active at a time; logging in elsewhere asks first and then ends the other one.

## VS Code sessions

Add to the VS Code user settings, then open a Claude Code tab (tabs already open keep running without it):

```json
"claudeCode.claudeProcessWrapper": "/path/to/ccrc/bin/ccrc-wrapper",
"claudeCode.initialPermissionMode": "auto"
```

The wrapper sits between VS Code and each Claude Code conversation process and lets the broker see and
drive it; VS Code keeps working the same way, also while the broker is down. A permission prompt can be
answered on either side, and the first answer counts. Opening a session in VS Code that the broker is
running hands it over to VS Code; a session another process still holds opens as a copy. With a wrapper
set, VS Code starts new conversations in manual mode unless `initialPermissionMode` says otherwise, and it
no longer resumes an interrupted turn after a window reload.

To turn it off, remove the setting, or set `CCRC_WRAPPER=off` in `claudeCode.environmentVariables`.
Run `npm run build` after updating; until then the wrapper runs from its TypeScript sources.

## Configuration (`~/.config/ccrc/config.json`)

| Key | Meaning |
|---|---|
| `allowedDevices` | Tailnet machine names allowed through `tailscale serve` |
| `allowLocal` | Allow requests from this machine itself |
| `roots` | Extra folders where new sessions may start (folders with sessions are always allowed) |
| `claudePath` | Claude Code CLI used for remote sessions: a path, or `"vscode"` (the default) for the one bundled in the newest VS Code extension, picked again at each session start; without one, `~/.local/bin/claude` |
| `leaseIdleMinutes` | Remote login ends after this long without activity |
| `sessionIdleMinutes` | Remote session processes nobody is viewing close after this long idle |

## Commands

`bin/ccrc serve | passwd | status | logout`, and `bin/ccrc-wrapper` for VS Code (see above).
The wrapper and the broker meet on `$XDG_RUNTIME_DIR/ccrc/link.sock`; the wrapper logs to `~/.local/state/ccrc/wrapper.log`.

## Development

```bash
npm test             # broker tests
npm run typecheck
npm run dev -w web   # Vite dev server proxying to a broker on :8737
```
