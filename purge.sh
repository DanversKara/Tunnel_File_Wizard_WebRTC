#!/usr/bin/env bash
# Purge the Tunnel File Wizard Docker deployment to start completely over.
#
# Usage: ./purge.sh [--yes]
#
# Removes the compose containers, the locally-built image, and moves ./data
# aside (users, invites, settings, transfer log). Your data is NOT destroyed:
# it's renamed to ./data-purged-YYYYMMDD-HHMMSS so you can recover or delete
# it yourself. The next `docker compose up --build -d` starts totally fresh
# (you'll get the one-time admin setup page again).
#
# To purge some OTHER container (e.g. an old one-off called "send"), use
# docker directly instead:
#   docker stop send && docker rm -v send

set -euo pipefail
cd "$(dirname "$0")"

if [ "${1:-}" != "--yes" ]; then
  echo "This will remove:"
  echo "  - the tunnel-file-wizard container(s)"
  echo "  - the locally built image"
  echo "  - ./data moved aside (all users, invites, settings)"
  echo ""
  read -r -p "Type DELETE to continue: " ans
  if [ "$ans" != "DELETE" ]; then echo "Aborted."; exit 1; fi
fi

docker compose down --rmi local 2>/dev/null || true

if [ -d data ]; then
  BACKUP="data-purged-$(date +%Y%m%d-%H%M%S)"
  mv data "$BACKUP"
  echo "Moved ./data -> ./$BACKUP (kept, not deleted)"
fi

echo "Purged. Start fresh with:  docker compose up --build -d"
