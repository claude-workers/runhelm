#!/usr/bin/env bash
set -euo pipefail

# The orchestrator starts this container with User=PUID:PGID and GroupAdd for
# the docker socket GID, so we run as the host user from the start. No root
# fixups needed — just boot the supervisor.
cd /opt/supervisor
exec npm start
