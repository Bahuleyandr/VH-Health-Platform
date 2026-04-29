# Runbook — Database restore

> Executed via `kubectl` on the on-prem cluster. See
> [`../../../../docs/DEPLOYMENT_GUIDE.md`](../../../../docs/DEPLOYMENT_GUIDE.md)
> for kubeconfig setup.

**Severity:** P0
**RPO target:** ≤ 1 hour
**RTO target:** ≤ 30 minutes

Companion to [`../DISASTER-RECOVERY.md`](../DISASTER-RECOVERY.md) — that
doc has the full scenario tree; this runbook is the hot-path "restore
via CloudNativePG PITR" step-by-step.

## Symptoms

- `GET /health/deep` returns `{"checks":{"database":{"ok":false}}}`
- App logs (`kubectl -n vhhealth logs deployment/vhhealth-backend`) repeatedly
  show `circuit breaker open` or `connection refused`
- `kubectl -n vhhealth-platform cnpg status vhhealth-pg` shows instances
  Failed / Replica without primary
- `admin:kpi` WS channel has stopped emitting (KPI tick warnings in logs)

## Prerequisites

- kubeconfig for `vhhealth-prod` cluster context.
- `kubectl cnpg` plugin installed locally
  (`kubectl krew install cnpg`).
- Read access to the `pgbackrest-cipher` sealed secret (its decrypted
  form lives inside the cluster as Secret `pgbackrest-cipher`; CNPG
  pods mount it automatically).
- 2–5 minutes of accepted read-only mode — the app will fail at the
  circuit breaker anyway, so the UX degrades regardless.

## Response

### 1. Confirm the DB is genuinely down (not just a pool-exhaustion flap)

```bash
kubectl -n vhhealth exec deployment/vhhealth-backend -- \
  curl -s http://localhost:5000/health/deep | jq .checks.database

kubectl -n vhhealth-platform cnpg status vhhealth-pg

kubectl -n vhhealth-platform logs vhhealth-pg-1 -c postgres --tail=100
```

If CNPG shows Healthy + primary present but the app shows circuit-breaker,
jump to [Scenario — Circuit-breaker flap without DB outage](#scenario-circuit-breaker-flap)
instead. DO NOT restore if the DB itself is fine.

### 2. Put the API in maintenance mode (stops mutations)

```bash
kubectl -n vhhealth set env deployment/vhhealth-backend VHHEALTH_MAINTENANCE=true
kubectl -n vhhealth rollout status deployment/vhhealth-backend
kubectl -n vhhealth exec deployment/vhhealth-backend -- \
  curl -s http://localhost:5000/health | jq .maintenance
# Expected: true
```

### 3. Determine the restore target time

```bash
kubectl -n vhhealth-platform get backups
# Pick the newest backup BEFORE the corruption window (if known)
# or the absolute latest if the primary is simply dead.
```

For PITR to a specific timestamp, pick the exact wall-clock second you
want to land on (all timestamps in ISO 8601 with IST offset).

### 4. Bring up a recovery Cluster via `kubectl cnpg restore`

This creates a NEW `Cluster` CR alongside the broken one — it doesn't
destroy the broken one, so you retain rollback.

```bash
# Point-in-time recovery to a specific timestamp:
kubectl cnpg restore \
  --cluster vhhealth-pg-recovery \
  --source vhhealth-pg \
  --target-time "2026-04-22T14:05:00+05:30"

# Or, latest available WAL (full recover to most recent archived segment):
kubectl cnpg restore \
  --cluster vhhealth-pg-recovery \
  --source vhhealth-pg
```

Watch it bootstrap:
```bash
kubectl -n vhhealth-platform get cluster vhhealth-pg-recovery -w
# Phase transitions: Creating cluster -> Bootstrapping -> Cluster in healthy state
```

Bootstrap pulls the base backup from MinIO (`repo1`) and replays WAL
segments. Time depends on WAL volume since the base backup: typically
2–10 minutes for a single day's worth of WAL.

### 5. Verify recovered data

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-recovery-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c \
    "SELECT COUNT(*) AS tables FROM information_schema.tables WHERE table_schema='public';"
# Expected: ~170 tables

kubectl -n vhhealth-platform exec -it vhhealth-pg-recovery-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c \
    "SELECT 'patients' as tbl, count(*) FROM patients
     UNION ALL SELECT 'appointments', count(*) FROM appointments
     UNION ALL SELECT 'pharmacy_orders', count(*) FROM pharmacy_orders;"
```

Cross-check row counts against your last-known-good metric snapshot (a
daily Prometheus scrape of `vhhealth_table_rows` gets you this).

### 6. Cut the backend over to the recovered cluster

Update the `vhhealth-db-url` sealed secret to point at the new primary:

```bash
cat > /tmp/db-url-secret.yaml <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: vhhealth-db-url
  namespace: vhhealth
stringData:
  DATABASE_URL: "postgresql://vhhealth:<DB_PASSWORD>@vhhealth-pg-recovery-rw.vhhealth-platform.svc.cluster.local:5432/vhhealth?sslmode=require"
  DATABASE_READ_URL: "postgresql://vhhealth:<DB_PASSWORD>@vhhealth-pg-recovery-ro.vhhealth-platform.svc.cluster.local:5432/vhhealth?sslmode=require"
EOF

kubeseal < /tmp/db-url-secret.yaml \
  > infra/kubernetes/apps/backend/vhhealth-db-url.sealed-secret.yaml
rm /tmp/db-url-secret.yaml

git commit -am "incident: point backend at vhhealth-pg-recovery (restore)"
git push
argocd app sync vhhealth-backend
kubectl -n vhhealth rollout restart deployment/vhhealth-backend
kubectl -n vhhealth rollout status deployment/vhhealth-backend
```

### 7. Apply any post-backup migrations

If new migrations landed between the backup and the incident:

```bash
kubectl -n vhhealth apply -f infra/kubernetes/apps/backend/jobs/migrate.yaml
kubectl -n vhhealth wait --for=condition=complete job/vhhealth-migrate --timeout=600s
kubectl -n vhhealth logs job/vhhealth-migrate
```

Phase 0.5 note: Prisma only has ~69 of the ~170 tables; the rest live
in `migrations/*.sql` and must be re-applied. The `migrate.yaml` Job
wraps `scripts/ci-setup-db.mjs` which handles both paths.

### 8. Take the API out of maintenance mode

```bash
kubectl -n vhhealth set env deployment/vhhealth-backend VHHEALTH_MAINTENANCE-
kubectl -n vhhealth rollout status deployment/vhhealth-backend
kubectl -n vhhealth exec deployment/vhhealth-backend -- \
  curl -s http://localhost:5000/health | jq .maintenance
# Expected: false (or null)
```

### 9. Verify recovery end-to-end

```bash
kubectl -n vhhealth exec deployment/vhhealth-backend -- \
  curl -s http://localhost:5000/health/deep | jq
# All checks should be { "ok": true }

curl -s -H "x-api-key: $API_KEY" https://api.vhhealth.app/api/v1/appointments/list?limit=1
# Expected: 200 OK with the appointments envelope
```

### 10. Clear the Sentry + Discord incident banner

- Close the Sentry issue with a `db-restore-completed-YYYYMMDD` tag.
- Post a resolution message to `#vhhealth-ops`.

### 11. Rename the recovery cluster to the primary (follow-up)

Once confirmed stable for 24+ hours, consolidate:

1. Delete the old `vhhealth-pg` Cluster CR (preserves PV retention per
   storageClass policy).
2. Create a new `vhhealth-pg` that bootstraps from `vhhealth-pg-recovery`.
3. Point the `vhhealth-db-url` secret back at `vhhealth-pg-rw`.

This is a planned maintenance step; open a follow-up ticket rather than
doing it under incident pressure.

## Scenario — Circuit-breaker flap

If CNPG shows Healthy but the app still shows circuit-open:

1. `kubectl -n vhhealth exec deployment/vhhealth-backend -- curl -s http://localhost:5000/health/metrics | jq .db_pool`
   — look at `waitingCount`. A sustained value > 5 means pool
   exhaustion, not DB outage.
2. Check circuit-breaker state in logs:
   ```bash
   kubectl -n vhhealth logs deployment/vhhealth-backend --tail=200 | grep -i breaker
   ```
3. Circuit auto-resets after 30s half-open window. If it doesn't, restart
   only the app (DB stays up):
   ```bash
   kubectl -n vhhealth rollout restart deployment/vhhealth-backend
   ```

## Post-incident

- [ ] Note the RPO actually achieved (time between last WAL archive and
      incident) — if > 1hr, raise a separate ticket to tighten
      `archive_timeout` below 60s or check pgBackRest / MinIO latency.
- [ ] Confirm `kubectl -n vhhealth-platform get backups` is resuming
      on-schedule after the recovery.
- [ ] Post the timeline to `#vhhealth-postmortem`.
- [ ] If the `pgbackrest-cipher` secret was accessed by anyone other than
      the on-call, rotate it via [`cert-rotation.md`](./cert-rotation.md)
      §pgBackRest.
