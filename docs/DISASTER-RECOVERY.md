# VH Health - Disaster Recovery Runbook

## Recovery Objectives

| Metric | Target | Notes |
|--------|--------|-------|
| **RPO** (Recovery Point Objective) | 1 hour | Maximum acceptable data loss window |
| **RTO** (Recovery Time Objective) | 30 minutes | Maximum acceptable downtime |
| Backup frequency | Every 6 hours + on-demand | Encrypted with AES-256-CBC |
| Backup retention | 30 days rolling | Stored off-host in encrypted form |

---

## Scenario 1: Database Failure

### Symptoms
- API returns 503 on `GET /` or `GET /health/deep`
- `db_pool` in `/health/metrics` shows 0 idle connections or elevated waiting requests
- Application logs: `circuit breaker open` or `connection refused`

### Immediate Response
1. Check PostgreSQL status:
   ```bash
   docker exec vhhealth-db pg_isready -U vhhealth
   systemctl status postgresql   # if running natively
   ```
2. If container crashed, restart:
   ```bash
   docker restart vhhealth-db
   ```
3. If data directory is corrupted, restore from backup (see Restore Procedure below).
4. Verify recovery:
   ```bash
   curl -s http://localhost:5000/health/deep | jq .checks.database
   ```

### If Restore Is Needed
Follow the **Restore from Encrypted Backup** procedure at the bottom of this document.

---

## Scenario 2: Application Crash / Process Down

### Symptoms
- `curl http://localhost:5000/` returns connection refused
- systemd unit `vhhealth-backend.service` shows failed status
- Nginx returns 502 Bad Gateway

### Immediate Response
1. Check service status:
   ```bash
   systemctl status vhhealth-backend
   journalctl -u vhhealth-backend --since "10 minutes ago" --no-pager
   ```
2. Restart the service:
   ```bash
   systemctl restart vhhealth-backend
   ```
3. If crashes are recurring, check for:
   - Out of memory (OOM): `dmesg | grep -i oom`
   - Missing environment variables: review `.env` against `src/utils/validateEnv.js`
   - Failed database migrations: check startup logs for Prisma errors
4. If the issue persists, deploy previous known-good version:
   ```bash
   cd /home/user/vh-health-backend
   git log --oneline -5          # identify last good commit
   git checkout <commit-sha>
   npm ci && npm start
   ```

---

## Scenario 3: Complete Host Failure

### Symptoms
- Host unreachable via SSH
- Cloudflare tunnel reports origin down
- All services (API, admin portal, database) offline

### Recovery Steps
1. **Provision new host** with matching OS and specs.
2. **Install dependencies**:
   ```bash
   # Node.js 22, Docker, PostgreSQL client, nginx, certbot
   curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
   apt-get install -y nodejs docker.io nginx postgresql-client
   ```
3. **Restore database** from the most recent encrypted backup:
   ```bash
   # Copy backup from offsite storage
   scp backup-host:/backups/latest/ /backups/latest/

   # Start PostgreSQL container
   docker run -d --name vhhealth-db \
     -e POSTGRES_USER=vhhealth \
     -e POSTGRES_PASSWORD=<password> \
     -e POSTGRES_DB=vhhealth \
     -p 5433:5432 postgres:16

   # Run restore script
   export BACKUP_ENCRYPTION_KEY="<key>"
   export DATABASE_URL="postgresql://vhhealth:<password>@localhost:5433/vhhealth"
   bash src/scripts/encrypted-restore.sh latest
   ```
4. **Deploy application**:
   ```bash
   git clone <repo-url> /home/user/vh-health-backend
   cd /home/user/vh-health-backend
   npm ci
   cp /secure-storage/.env .env    # restore environment file
   npm start
   ```
5. **Restore Cloudflare tunnel** configuration.
6. **Verify all services**:
   ```bash
   curl http://localhost:5000/health/deep
   curl http://localhost:3001       # admin portal
   ```

---

## Scenario 4: Data Corruption

### Symptoms
- Application errors referencing invalid data or constraint violations
- Unexpected NULL values or missing rows reported by staff
- `canaryHealthCheck` reports DB read/write anomalies

### Immediate Response
1. **Assess scope**: determine which tables and time range are affected.
   ```sql
   -- Check for obvious corruption indicators
   SELECT schemaname, relname, n_dead_tup, last_autovacuum
   FROM pg_stat_user_tables
   WHERE n_dead_tup > 10000
   ORDER BY n_dead_tup DESC;
   ```
2. **Isolate affected data**: if limited to specific records, quarantine rather than full restore.
3. **If widespread**, perform point-in-time recovery:
   - Stop the application: `systemctl stop vhhealth-backend`
   - Identify the last clean backup (before corruption was introduced)
   - Restore from that backup (see procedure below)
   - Re-apply any legitimate transactions from audit logs if possible
4. **Verify integrity** after restore:
   ```bash
   curl http://localhost:5000/health/deep
   # Run canary health check manually
   curl http://localhost:5000/health/metrics
   ```

---

## Restore from Encrypted Backup

### Prerequisites
- `BACKUP_ENCRYPTION_KEY` environment variable set (same key used during backup)
- `DATABASE_URL` pointing to the target database
- PostgreSQL client (`psql`) installed
- OpenSSL installed

### Step-by-Step

1. **List available backups**:
   ```bash
   ls -lt /backups/
   ```

2. **Verify backup integrity**:
   ```bash
   cd /backups/<label>
   sha256sum -c checksum.sha256
   ```

3. **Run the restore script**:
   ```bash
   export BACKUP_ENCRYPTION_KEY="<encryption-key>"
   export DATABASE_URL="postgresql://vhhealth:<password>@localhost:5433/vhhealth"
   bash /home/user/vh-health-backend/src/scripts/encrypted-restore.sh <label>
   ```

4. **Verify restore**:
   ```bash
   # Check row counts on key tables
   docker exec vhhealth-db psql -U vhhealth -d vhhealth \
     -c "SELECT 'patients' as tbl, count(*) FROM patients
         UNION ALL SELECT 'appointments', count(*) FROM appointments
         UNION ALL SELECT 'pharmacy_orders', count(*) FROM pharmacy_orders;"
   ```

5. **Restart the application**:
   ```bash
   systemctl restart vhhealth-backend
   curl http://localhost:5000/health/deep
   ```

---

## Contact Escalation Matrix

| Level | Responder | Contact | Escalation Trigger |
|-------|-----------|---------|-------------------|
| L1 | On-call engineer | [Phone/Slack TBD] | Any alert from monitoring |
| L2 | Backend lead | [Phone/Slack TBD] | L1 unresolved after 15 minutes |
| L3 | System administrator | [Phone/Slack TBD] | Host-level or infrastructure failure |
| L4 | Hospital IT director | [Phone/Slack TBD] | Patient safety impact or data breach |

> **Action required**: Fill in contact details for each level before this runbook goes live.

---

## Post-Incident Review Checklist

After any incident requiring this runbook, complete the following within 48 hours:

- [ ] **Timeline**: Document exact timestamps for detection, response start, mitigation, and full recovery
- [ ] **Root cause**: Identify the underlying cause (not just the symptom)
- [ ] **Impact assessment**: Number of affected users, duration of downtime, any data loss
- [ ] **Detection gap**: How long between incident start and detection? Can monitoring be improved?
- [ ] **Response effectiveness**: Did the runbook steps work as documented? Any gaps?
- [ ] **Data integrity**: Confirm no data was lost or corrupted beyond RPO target
- [ ] **HIPAA implications**: Determine if PHI was exposed or unavailable beyond acceptable limits
- [ ] **Action items**: List concrete improvements with owners and deadlines
- [ ] **Runbook updates**: Update this document with any lessons learned
- [ ] **Communication**: Notify relevant stakeholders (hospital management, affected staff)
- [ ] **Backup verification**: Confirm next backup completed successfully after recovery
