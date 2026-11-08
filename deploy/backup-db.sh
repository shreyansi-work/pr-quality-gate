#!/usr/bin/env bash
# Nightly database backup. Add to cron with:  crontab -e
#   30 2 * * * bash /opt/prgate/deploy/backup-db.sh >> /var/log/prgate-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U prgate prgate | gzip > "backups/prgate-$(date +%F).sql.gz"
find backups -name 'prgate-*.sql.gz' -mtime +14 -delete # keep two weeks
