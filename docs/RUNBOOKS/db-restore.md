# Runbook — Database restore

**Severity:** P0
**RPO target:** ≤ 1 hour
**RTO target:** ≤ 30 minutes

Companion to [`docs/DISASTER-RECOVERY.md`](../DISASTER-RECOVERY.md) — that
doc has the full scenario tree; this runbook is the hot-path "restore
from the last good backup" step-by-step.

## Symptoms

- `GET /health/deep` returns `{"checks":{"database":{"ok":false}}}`
- App logs repeatedly show: `circuit breaker open` or `connection refused`
- `docker exec vhhealth-db pg_isready -U vhhealth` → exit code ≠ 0
- `admin:kpi` WS channel has stopped emitting (KPI tick warnings in logs)

## Prerequisites

- SSH access to the primary API host.
- The encryption key used by `admin/backup-db.js` — stored in
  `/srv/vhhealth/secrets/backup-key.txt` (sealed file; `root` only).
- Write access to `/srv/vhhealth/backups/` (where encrypted dumps land).
- Postgres superuser password (in `.env.local` as `PGPASSWORD`).
- 2–5 minutes of accepted read-only mode — the app will fail at the
  circuit breaker anyway, so the UX degrades regardless.

## Response

### 1. Confirm the DB is genuinely down (not just a pool-exhaustion flap)

```bash
$ curl -s http://localhost:5000/health/deep | jq .checks.database
$ docker exec vhhealth-db pg_isready -U vhhealth
$ docker logs --tail=100 vhhealth-db 2>&1 | tail -30
```

If `pg_isready` returns OK but the app shows circuit-breaker, jump to
[Scenario — Circuit-breaker flap without DB outage](#scenario-circuit-breaker-flap)
instead. DO NOT restore if the DB itself is fine.

### 2. Put the API in maintenance mode (stops mutations)

```bash
# Set a short-lived maintenance env var the proxy reads
$ sudo systemctl set-environment VHHEALTH_MAINTENANCE=1
$ sudo systemctl restart vhhealth-backend.service
$ curl -s http://localhost:5000/health | jq .maintenance
# Expected: true
```

### 3. Stop the DB container (if it's running in a bad state)

```bash
$ docker stop vhhealth-db
```

### 4. Identify the backup to restore

```bash
$ ls -lt /srv/vhhealth/backups/*.enc | head -5
# Newest first. Typical filename: vhhealth-2026-04-17T06-00-00Z.sql.enc
```

The `.enc` files are AES-256-CBC encrypted by `admin/backup-db.js`.
Decrypt using the key file:

```bash
$ BACKUP=/srv/vhhealth/backups/vhhealth-2026-04-17T06-00-00Z.sql.enc
$ openssl enc -d -aes-256-cbc -pbkdf2 \
    -in "$BACKUP" \
    -out /tmp/vhhealth-restore.sql \
    -pass file:/srv/vhhealth/secrets/backup-key.txt
$ head -1 /tmp/vhhealth-restore.sql
# Expected: -- PostgreSQL database dump
```

### 5. Bring up a clean DB container

```bash
$ docker start vhhealth-db   # uses the existing volume if present, else:
$ docker run -d --name vhhealth-db-new \
    -e POSTGRES_USER=vhhealth -e POSTGRES_PASSWORD=$PGPASSWORD \
    -e POSTGRES_DB=vhhealth \
    -p 5433:5432 -v vhhealth-pgdata-new:/var/lib/postgresql/data \
    postgres:16
$ sleep 10 && docker exec vhhealth-db-new pg_isready -U vhhealth
```

If you created `vhhealth-db-new`, point the app at it (edit
`.env.local` `DATABASE_URL`) before restart.

### 6. Restore

```bash
$ docker exec -i vhhealth-db psql -U vhhealth -d vhhealth < /tmp/vhhealth-restore.sql
# Watch stderr. Some NOTICE lines are fine. Any ERROR means stop and triage.
```

### 7. Apply post-backup migrations (in case the schema advanced)

```bash
[backend] $ npm run db:migrate:status
[backend] $ npm run db:migrate   # deploys any pending Prisma migrations
[backend] $ node scripts/ci-setup-db.mjs   # applies raw migrations/*.sql
                                           # that Prisma doesn't know about
```

Phase 0.5 note: Prisma only has ~69 of the ~170 tables; the rest live
in `migrations/*.sql` and must be re-applied via the scripts step.

### 8. Verify recovery

```bash
$ docker exec vhhealth-db psql -U vhhealth -d vhhealth -c \
    "SELECT COUNT(*) AS tables FROM information_schema.tables WHERE table_schema='public';"
# Expected: tables = 170 (± schema drift)

$ curl -s http://localhost:5000/health/deep | jq
# All checks should be { "ok": true }.

$ curl -s -H "x-api-key: $API_KEY" http://localhost:5000/api/v1/appointments/list?limit=1
# Expected: 200 OK with the appointments envelope
```

### 9. Restart the API out of maintenance mode

```bash
$ sudo systemctl unset-environment VHHEALTH_MAINTENANCE
$ sudo systemctl restart vhhealth-backend.service
$ curl -s http://localhost:5000/health | jq .maintenance
# Expected: false
```

### 10. Clear the Sentry + Discord incident banner

- Close the Sentry issue with a `db-restore-completed-YYYYMMDD` tag.
- Post a resolution message to `#vhhealth-ops`.

## Scenario — Circuit-breaker flap

If `pg_isready` is OK but the app still shows circuit-open:

1. `curl -s http://localhost:5000/health/metrics | jq .db_pool` — look
   at `waitingCount`. A sustained value > 5 means pool exhaustion, not
   DB outage.
2. Check `src/utils/circuitBreaker.js` state log: `journalctl -u
   vhhealth-backend.service -n 200 | grep -i breaker`.
3. Circuit auto-resets after 30s half-open window. If it doesn't, restart
   only the app (DB stays up): `sudo systemctl restart vhhealth-backend`.

## Post-incident

- [ ] Note the RPO actually achieved (time between last backup and
      incident) — if > 1hr, raise a separate ticket to increase backup
      frequency.
- [ ] Confirm encrypted backups resumed landing in `/srv/vhhealth/backups/`.
- [ ] Post the timeline to `#vhhealth-postmortem`.
- [ ] If the `backup-key.txt` file was accessed by anyone other than the
      on-call, rotate it via the [`cert-rotation.md`](./cert-rotation.md)
      runbook.
