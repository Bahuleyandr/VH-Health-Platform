#!/bin/bash
set -euo pipefail

# Monthly backup verification - restores to temp DB, runs sanity check, drops temp DB
LOG="/var/log/vhhealth-backup.log"
TEMP_DB="vhhealth_verify_$(date +%s)"

echo "[$(date)] Starting backup verification" >> "$LOG"

# Find latest backup
LATEST=$(ls -t /backups/ | head -1)
if [ -z "$LATEST" ]; then
  echo "[$(date)] ERROR: No backups found to verify" >> "$LOG"
  exit 1
fi

BACKUP_DIR="/backups/$LATEST"
echo "[$(date)] Verifying backup: $LATEST" >> "$LOG"

# Decrypt backup
ENCRYPTED_FILE=$(find "$BACKUP_DIR" -name "*.enc" | head -1)
if [ -z "$ENCRYPTED_FILE" ]; then
  echo "[$(date)] ERROR: No encrypted backup file found in $BACKUP_DIR" >> "$LOG"
  exit 1
fi

DECRYPTED_FILE="/tmp/${TEMP_DB}.sql"
openssl enc -aes-256-cbc -d -pbkdf2 \
  -in "$ENCRYPTED_FILE" \
  -out "$DECRYPTED_FILE" \
  -pass env:BACKUP_ENCRYPTION_KEY >> "$LOG" 2>&1

# Create temp DB
PGPASSWORD="${POSTGRES_PASSWORD}" psql -h "${DB_HOST:-db}" -U "${POSTGRES_USER:-vhhealth}" -d postgres \
  -c "CREATE DATABASE $TEMP_DB;" >> "$LOG" 2>&1

# Restore
PGPASSWORD="${POSTGRES_PASSWORD}" psql -h "${DB_HOST:-db}" -U "${POSTGRES_USER:-vhhealth}" -d "$TEMP_DB" \
  -f "$DECRYPTED_FILE" >> "$LOG" 2>&1

# Sanity checks
PATIENT_COUNT=$(PGPASSWORD="${POSTGRES_PASSWORD}" psql -h "${DB_HOST:-db}" -U "${POSTGRES_USER:-vhhealth}" -d "$TEMP_DB" \
  -t -c "SELECT count(*) FROM patients;" 2>/dev/null || echo "0")
APPOINTMENT_COUNT=$(PGPASSWORD="${POSTGRES_PASSWORD}" psql -h "${DB_HOST:-db}" -U "${POSTGRES_USER:-vhhealth}" -d "$TEMP_DB" \
  -t -c "SELECT count(*) FROM appointments;" 2>/dev/null || echo "0")

echo "[$(date)] Verification counts - patients: $PATIENT_COUNT, appointments: $APPOINTMENT_COUNT" >> "$LOG"

# Cleanup
PGPASSWORD="${POSTGRES_PASSWORD}" psql -h "${DB_HOST:-db}" -U "${POSTGRES_USER:-vhhealth}" -d postgres \
  -c "DROP DATABASE IF EXISTS $TEMP_DB;" >> "$LOG" 2>&1
rm -f "$DECRYPTED_FILE"

# Fail if tables are empty (likely corrupt restore)
if [ "$(echo "$PATIENT_COUNT" | tr -d ' ')" = "0" ]; then
  echo "[$(date)] WARNING: Backup verification found 0 patients - possible corruption" >> "$LOG"
  exit 1
fi

echo "[$(date)] Backup verification PASSED for $LATEST" >> "$LOG"
