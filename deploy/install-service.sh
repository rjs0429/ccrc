#!/usr/bin/env bash
# Installs and starts the broker as a systemd user service. PATH is taken from the calling shell,
# so tools that Claude runs in broker sessions resolve the same way as in a terminal. A CCRC_NODE set in the
# calling shell is kept for bin/ccrc, which otherwise looks in <dataDir>/node and then PATH for Node 22.18+.
set -euo pipefail
ROOT=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
NODE_ENV=
[ -n "${CCRC_NODE:-}" ] && NODE_ENV="Environment=CCRC_NODE=$CCRC_NODE"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/ccrc.service" <<UNIT
[Unit]
Description=ccrc broker
After=network-online.target

[Service]
ExecStart=$ROOT/bin/ccrc serve
Environment=PATH=$PATH
Environment=CCRC_LOG_LEVEL=warn
$NODE_ENV
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now ccrc.service
systemctl --user --no-pager status ccrc.service | head -5
