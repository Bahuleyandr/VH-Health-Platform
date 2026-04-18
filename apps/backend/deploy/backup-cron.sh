#!/bin/bash
set -euo pipefail

LABEL="$(date +%Y%m%d_%H%M%S)"
LOG="/var/log/vhhealth-backup.log"

echo "[$(date)] Starting scheduled backup: $LABEL" >> "$LOG"

# Run encrypted backup
bash /app/src/scripts/encrypted-backup.sh "$LABEL" >> "$LOG" 2>&1

# Upload to R2
if [ -n "${BACKUP_R2_BUCKET:-}" ] && [ -n "${R2_ACCESS_KEY_ID:-}" ]; then
  aws s3 cp "/backups/$LABEL/" "s3://$BACKUP_R2_BUCKET/backups/$LABEL/" \
    --recursive --endpoint-url "$R2_ENDPOINT_URL" >> "$LOG" 2>&1
  echo "[$(date)] Uploaded to R2: $BACKUP_R2_BUCKET/backups/$LABEL" >> "$LOG"
fi

# Prune local (keep 7 days)
find /backups -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null
echo "[$(date)] Backup complete: $LABEL" >> "$LOG"
