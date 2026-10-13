# ccrc

Self-hosted remote console for the Claude Code sessions on this machine, reachable over Tailscale.
It lists every session by folder, shows live progress, and runs inactive sessions remotely through the
Claude Agent SDK, including permission prompts, questions, plan approval, model, mode, and effort.

## Requirements

- Node.js 22.18 or newer, the Claude Code CLI logged in, Tailscale with HTTPS certificates enabled.

## Setup

```bash
npm install
npm run build                      # web app, served by the broker
bin/ccrc passwd                    # login ID and password (stored as an Argon2id hash)
$EDITOR ~/.config/ccrc/config.json # allowedDevices, roots (created on first run)
deploy/install-service.sh          # systemd user service on 127.0.0.1:8737
tailscale serve --bg --https=8443 http://127.0.0.1:8737
```

Only one login can be active at a time; logging in elsewhere asks first and then ends the other one.

## Configuration (`~/.config/ccrc/config.json`)

| Key | Meaning |
|---|---|
| `allowedDevices` | Tailnet machine names allowed through `tailscale serve` |
| `allowLocal` | Allow requests from this machine itself |
| `roots` | Extra folders where new sessions may start (folders with sessions are always allowed) |
| `claudePath` | Claude Code CLI used for remote sessions |
| `leaseIdleMinutes` | Remote login ends after this long without activity |
| `sessionIdleMinutes` | Remote session processes nobody is viewing close after this long idle |

## Commands

`bin/ccrc serve | passwd | status | logout`

## Development

```bash
npm test             # broker tests
npm run typecheck
npm run dev -w web   # Vite dev server proxying to a broker on :8737
```
