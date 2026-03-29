#!/bin/bash
# Encrypted database backup script
# Usage: ./encrypted-backup.sh [label]

set -euo pipefail

LABEL="${1:-$(date +%Y%m%d_%H%M%S)}"
BACKUP_DIR="/backups/${LABEL}"
ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set}"

mkdir -p "$BACKUP_DIR"

echo "[$(date)] Starting encrypted backup: $LABEL"

# Dump database
pg_dump "$DATABASE_URL" --no-owner --no-privileges | gzip > "$BACKUP_DIR/db_dump.sql.gz"

# Encrypt with AES-256-CBC
openssl enc -aes-256-cbc -salt -pbkdf2 \
  -in "$BACKUP_DIR/db_dump.sql.gz" \
  -out "$BACKUP_DIR/db_dump.sql.gz.enc" \
  -pass env:ENCRYPTION_KEY

# Remove unencrypted dump
rm "$BACKUP_DIR/db_dump.sql.gz"

# Generate checksum
sha256sum "$BACKUP_DIR/db_dump.sql.gz.enc" > "$BACKUP_DIR/checksum.sha256"

echo "[$(date)] Encrypted backup complete: $BACKUP_DIR"
echo "Files: $(ls -la $BACKUP_DIR)"
