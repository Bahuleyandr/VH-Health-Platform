#!/bin/bash
# Encrypted database restore script
# Usage: ./encrypted-restore.sh <backup_label>
#
# Decrypts an AES-256-CBC encrypted backup and restores it to the target database.
# Requires BACKUP_ENCRYPTION_KEY and DATABASE_URL environment variables.

set -euo pipefail

LABEL="${1:?Usage: ./encrypted-restore.sh <backup_label>}"
BACKUP_DIR="/backups/${LABEL}"
ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set}"

ENCRYPTED_FILE="$BACKUP_DIR/db_dump.sql.gz.enc"
CHECKSUM_FILE="$BACKUP_DIR/checksum.sha256"

# Verify backup exists
if [ ! -f "$ENCRYPTED_FILE" ]; then
  echo "ERROR: Encrypted backup not found: $ENCRYPTED_FILE"
  exit 1
fi

echo "[$(date)] Starting encrypted restore from: $BACKUP_DIR"

# Verify checksum
if [ -f "$CHECKSUM_FILE" ]; then
  echo "Verifying checksum..."
  cd "$BACKUP_DIR" && sha256sum -c checksum.sha256
  cd - > /dev/null
  echo "Checksum verified."
else
  echo "WARNING: No checksum file found — skipping integrity check"
fi

# Decrypt
echo "Decrypting backup..."
openssl enc -aes-256-cbc -d -salt -pbkdf2 \
  -in "$ENCRYPTED_FILE" \
  -out "$BACKUP_DIR/db_dump.sql.gz" \
  -pass env:ENCRYPTION_KEY

# Decompress and restore
echo "Restoring database..."
gunzip -c "$BACKUP_DIR/db_dump.sql.gz" | psql "$DATABASE_URL" --single-transaction

# Clean up decrypted file
rm -f "$BACKUP_DIR/db_dump.sql.gz"

echo "[$(date)] Database restore complete from backup: $LABEL"
