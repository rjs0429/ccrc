# Security policy

English | [한국어](SECURITY.ko.md)

## Supported versions

Security fixes go into the newest release. Before 1.0, only the latest minor version is supported; update with
`ccrc update`.

| Version | Supported |
|---|---|
| 0.7.x | Yes |
| 0.6 and earlier | No |

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**
(<https://github.com/rjs0429/ccrc/security/advisories/new>). Do not open a public issue for them.

Include what you found, the ccrc version (`ccrc version`), and steps to reproduce. Leave out real tailnet names,
addresses, passwords and API keys. ccrc is a one-person project, so an answer may take some time. Fixes are released
as a patch version with a GitHub security advisory.

## Scope

In scope: the broker, the phone web app, the VS Code wrapper, `install.sh`, `ccrc setup`, `ccrc update` and
`ccrc uninstall`. For example: getting past the device allowlist, the login or its passkey confirmation, reading files
outside a session's folders or secret files, switching a session to `bypassPermissions` remotely, or another local
user reaching the wrapper socket.

Out of scope: Claude Code, the Claude Agent SDK and the VS Code extension (report those to Anthropic, see
<https://code.claude.com/docs/en/legal-and-compliance>), Tailscale, and attacks that need someone who is already
signed in to your machine as you.
