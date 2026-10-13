#!/usr/bin/env bash
# Installs and starts the broker as a systemd user service. PATH is taken from the calling shell,
# so tools that Claude runs in broker sessions resolve the same way as in a terminal.
set -euo pipefail
ROOT=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/ccrc.service" <<UNIT
[Unit]
Description=ccrc broker
After=network-online.target

[Service]
ExecStart=$ROOT/bin/ccrc serve
Environment=PATH=$PATH
Environment=CCRC_LOG_LEVEL=warn
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now ccrc.service
systemctl --user --no-pager status ccrc.service | head -5
