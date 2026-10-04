#!/usr/bin/env bash
# Upgrade an existing Tunnel File Wizard deployment to this version.
#
# Usage: ./upgrade.sh
#
# What it does:
#   1. Backs up ./data (users, invites, settings, sessions, transfer log)
#      to ./data-backup-YYYYMMDD-HHMMSS — so an upgrade can never wipe
#      your accounts.
#   2. Rebuilds the image and restarts the container (docker compose).
#   3. Waits until /healthz answers, then shows container status.
#
# Upgrading from v1 (no accounts): nothing breaks. Your existing setup
# keeps working exactly as before; the first time you open the page
# you'll get the one-time admin setup instead.

set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"

if [ -d data ]; then
  BACKUP="data-backup-$(date +%Y%m%d-%H%M%S)"
  cp -r data "$BACKUP"
  echo "Backed up ./data -> ./$BACKUP"
else
  echo "No ./data directory yet — nothing to back up."
fi

echo "Rebuilding and restarting..."
docker compose up --build -d

echo "Waiting for the server to answer..."
for _ in $(seq 1 30); do
  if curl -sf "http://localhost:${PORT}/healthz" > /dev/null 2>&1; then
    echo "Tunnel File Wizard is up on port ${PORT}."
    docker compose ps
    exit 0
  fi
  sleep 2
done

echo "WARNING: the server did not answer /healthz within 60 seconds."
echo "Check what happened with:  docker compose logs --tail=50"
exit 1
