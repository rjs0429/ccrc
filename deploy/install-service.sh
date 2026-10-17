#!/usr/bin/env bash
# Installs and starts the broker as a systemd user service: the service step of `ccrc setup`. The unit runs this
# copy's bin/ccrc (or <dataDir>/current/bin/ccrc for an install) with the Node bin/ccrc finds, and takes PATH from
# the calling shell, so tools that Claude runs in broker sessions resolve the same way as in a terminal.
set -euo pipefail
exec "$(dirname "$(readlink -f "$0")")/../bin/ccrc" setup --only service --yes "$@"
