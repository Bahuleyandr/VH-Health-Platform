# VHHealth Database — Migration to CloudNativePG on-prem
> **Purpose:** Move Postgres from the legacy containerised deployment to a
> CloudNativePG (CNPG)-managed Postgres 17 cluster running on the 3-node RKE2
> Kubernetes cluster inside the hospital.
> **Drafted:** 2026-04-04 (original — targeting managed SaaS)
> **Rewritten:** 2026-04-23 (on-prem CNPG target)
> **Status:** Plan locked; execution gated on Ansible + platform manifests landing (agents A/B).

> **Pre-requisite completed:** DB fully validated and all migrations applied (164 tables, 0 errors). Schema dump available at `docs/schema-dump.sql`. Rebuild guide at `docs/DB-REBUILD-GUIDE.md`.

---

## Goal

Run VH Health's Postgres as a **CNPG `Cluster` CR** with 3 replicas (1 primary
+ 2 sync standbys), storing data on NVMe-backed PVCs on the on-prem RKE2 nodes,
with backups going to in-cluster MinIO and replicated to Cloudflare R2. No SaaS
database dependency; all PHI remains inside the hospital's physical perimeter.

## Why

| Driver | Detail |
|--------|--------|
| **HA** | 3-replica synchronous replication; primary failover in <60s via CNPG instance manager |
| **PITR** | pgBackRest + continuous WAL archiving → restore to any point in the retention window |
| **k8s-native ops** | `kubectl cnpg` for backup/restore/promote; ArgoCD reconciles configuration; no shell scripts |
| **No SaaS lock-in** | Data stays in-hospital; satisfies DPDP Act data-residency and any HIPAA-style local-control posture |
| **Observability** | CNPG exports Prometheus metrics by default; Grafana dashboards shipped by the operator |
| **Cost** | Zero recurring DB SaaS fees — capex-only on hardware already provisioned for k8s |

---

## Pre-requisites

Gates the migration cannot start without:

- [ ] Cluster bootstrapped via Ansible (`infra/ansible/playbooks/site.yml`
      applied, `kubectl get nodes` shows 3 Ready nodes).
- [ ] CNPG operator installed in namespace `cnpg-system`
      (`kubectl get deploy -n cnpg-system cnpg-controller-manager` Ready).
- [ ] MinIO running in `vhhealth-platform` namespace with bucket
      `vhhealth-pg-backups` created and service
      `minio.vhhealth-platform.svc.cluster.local:9000` reachable from the
      CNPG pods.
- [ ] Cloudflare R2 offsite bucket `vhhealth-pg-backups-cold` created,
      credentials in sealed secret `r2-backup-credentials`.
- [ ] Sealed secret `pgbackrest-cipher` with a fresh AES-256 pass.
- [ ] StorageClass `longhorn-nvme` (or equivalent) available on all 3 nodes.
- [ ] Backend container image published with `DATABASE_URL` support for the
      CNPG primary DNS name.
- [ ] Off-hours window agreed with hospital IT (recommend 02:00–05:00 IST,
      low admissions and no planned surgeries).

---

## Step-by-step

### 1. Apply the CNPG `Cluster` manifest

The manifest lives at `infra/kubernetes/base/cnpg/cluster.yaml`. Key shape:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: vhhealth-pg
  namespace: vhhealth-platform
spec:
  instances: 3
  imageName: ghcr.io/cloudnative-pg/postgresql:17.2
  primaryUpdateStrategy: unsupervised
  postgresql:
    parameters:
      max_connections: "300"
      shared_buffers: "16GB"
      effective_cache_size: "48GB"
      work_mem: "32MB"
      wal_level: replica
      archive_mode: "on"
      archive_timeout: "60s"
  storage:
    storageClass: longhorn-nvme
    size: 200Gi
  backup:
    barmanObjectStore:
      destinationPath: s3://vhhealth-pg-backups/main
      endpointURL: http://minio.vhhealth-platform.svc.cluster.local:9000
      s3Credentials:
        accessKeyId: {name: minio-creds, key: access}
        secretAccessKey: {name: minio-creds, key: secret}
      encryption: AES256
      wal:
        compression: gzip
    retentionPolicy: "30d"
```

Apply:
```bash
kubectl apply -f infra/kubernetes/base/cnpg/cluster.yaml
```

In the ArgoCD-managed flow, you'd commit `cluster.yaml` and ArgoCD applies it;
for the migration cutover, `kubectl apply` directly is acceptable (ArgoCD
detects no drift because the committed manifest matches).

### 2. Verify the 3-replica cluster is healthy

```bash
kubectl -n vhhealth-platform get cluster vhhealth-pg -o yaml
# Look for: status.phase: "Cluster in healthy state"
#           status.readyInstances: 3

kubectl -n vhhealth-platform cnpg status vhhealth-pg
# Shows: primary, replicas, replication lag, backup status
```

Expected:
- `vhhealth-pg-1` = primary
- `vhhealth-pg-2`, `vhhealth-pg-3` = sync standbys, lag <1MB
- `vhhealth-pg-rw` Service routes to the current primary
- `vhhealth-pg-ro` Service load-balances across standbys

### 3. Take the final dump from the legacy DB

Dump the current production DB to a file:

```bash
# Run against the legacy production Postgres (wherever it currently lives).
# For the legacy host, use its connection string from the secret locker.
pg_dump "$LEGACY_DATABASE_URL" \
  --no-owner --no-acl \
  --exclude-table='_prisma_migrations' \
  --exclude-table='_migrations' \
  --format=custom \
  -f /tmp/vhhealth-prod-$(date +%Y%m%dT%H%M%S).dump
```

Archive to a secure offline location (encrypted USB or sealed storage) in
addition to the in-flight copy — this dump is your pre-cutover rollback anchor.

### 4. Copy the dump to the CNPG primary pod

```bash
DUMP=/tmp/vhhealth-prod-$(ls /tmp | grep vhhealth-prod | sort | tail -1)
kubectl -n vhhealth-platform cp "$DUMP" vhhealth-pg-1:/tmp/vhhealth-prod.dump -c postgres
```

### 5. Import the dump inside the CNPG primary pod

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  pg_restore \
    --clean --if-exists \
    --no-owner --no-acl \
    --dbname=vhhealth \
    /tmp/vhhealth-prod.dump 2>&1 | tee /tmp/restore.log
```

Review `/tmp/restore.log` for errors. `NOTICE` lines are normal; any
`ERROR:` line must be resolved before continuing.

### 6. Replay migrations not captured in pg_dump

The dump contains data and schema. Row-count check against the
`_migrations` tracking table ensures migration history is intact:

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "SELECT name, applied_at FROM _migrations ORDER BY applied_at DESC LIMIT 10;"
```

If any migration committed to `main` but not yet captured in the dump is
missing, apply it:

```bash
# From a pod with the backend image mounted / or a one-off Job:
kubectl -n vhhealth apply -f infra/kubernetes/apps/backend/jobs/migrate.yaml
kubectl -n vhhealth wait --for=condition=complete job/vhhealth-migrate --timeout=600s
kubectl -n vhhealth logs job/vhhealth-migrate
```

### 7. Point the backend at the new CNPG primary

Update the sealed secret for the DB URL:

```bash
# Create a locally-built Secret (do NOT commit this file)
cat > /tmp/db-url-secret.yaml <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: vhhealth-db-url
  namespace: vhhealth
stringData:
  DATABASE_URL: "postgresql://vhhealth:<DB_PASSWORD>@vhhealth-pg-rw.vhhealth-platform.svc.cluster.local:5432/vhhealth?sslmode=require"
  DATABASE_READ_URL: "postgresql://vhhealth:<DB_PASSWORD>@vhhealth-pg-ro.vhhealth-platform.svc.cluster.local:5432/vhhealth?sslmode=require"
EOF

kubeseal < /tmp/db-url-secret.yaml > infra/kubernetes/apps/backend/vhhealth-db-url.sealed-secret.yaml
rm /tmp/db-url-secret.yaml    # never commit the plain version

git add infra/kubernetes/apps/backend/vhhealth-db-url.sealed-secret.yaml
git commit -m "feat(deploy): point backend at CNPG primary"
git push
```

ArgoCD auto-syncs within 3 minutes; the Deployment rolls out with the new
Secret mounted. To accelerate:

```bash
argocd app sync vhhealth-backend
kubectl -n vhhealth rollout restart deployment/vhhealth-backend
kubectl -n vhhealth rollout status deployment/vhhealth-backend
```

### 8. End-to-end verification

```bash
# Health
kubectl -n vhhealth exec deployment/vhhealth-backend -- curl -s http://localhost:5000/health/deep | jq

# Expected checks: { database: { ok: true }, redis: { ok: true }, r2: { ok: true } }

# Patient OTP happy path (test phone)
curl -s -X POST https://api.vhhealth.app/api/v1/auth/firebase/firebase-login \
  -H "x-api-key: $API_KEY_PATIENT" \
  -H "Content-Type: application/json" \
  -d '{"phone":"+91XXXXXXXXXX","idToken":"<firebase-id-token>"}' | jq .success

# Admin login
curl -s -X POST https://api.vhhealth.app/api/v1/auth/admin/login \
  -H "x-api-key: $API_KEY_ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"username":"testadmin","password":"<test-password>"}' | jq .data.token

# Sample read query against a high-cardinality table
kubectl -n vhhealth-platform exec vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "SELECT count(*) FROM appointments;"
```

### 9. Re-run migrations + seed via `ci-setup-db.mjs`

Only if this is a pre-launch environment with no production data:

```bash
kubectl -n vhhealth apply -f infra/kubernetes/apps/backend/jobs/ci-setup-db.yaml
kubectl -n vhhealth wait --for=condition=complete job/vhhealth-ci-setup-db --timeout=600s
```

For a real production cutover with patient data, SKIP this step — it's only
for fresh environments.

### 10. Backfill any legacy-only data

Tables that the legacy deployment wrote to but may not have been included in
the dump freeze window:

- `audit_log` — verify every row post-dump-timestamp on legacy is also present
  on CNPG. Use `pg_dump -t audit_log --data-only` against the legacy host if
  needed, import via `psql` into CNPG.
- `file_access_logs` (HIPAA PHI-access tracking) — same treatment.
- `notifications` — if the outbox on legacy still had unsent rows, migrate
  their state to the new DB.

```bash
# Example backfill pattern for audit_log
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "SELECT max(created_at) FROM audit_log;"
# Compare against legacy; dump the gap; import.
```

### 11. Verify backup is working

Trigger an on-demand backup and confirm it lands in MinIO and replicates to R2:

```bash
kubectl cnpg backup vhhealth-pg
kubectl -n vhhealth-platform get backups
# Expected: status=completed, a few minutes later
```

Check MinIO:
```bash
kubectl -n vhhealth-platform exec -it minio-0 -- \
  mc ls local/vhhealth-pg-backups/main/base/
```

Check R2 (from a workstation with R2 creds):
```bash
wrangler r2 object list vhhealth-pg-backups-cold --prefix main/base/
```

### 12. Keep legacy DB running in standby mode for 30 days

Don't decommission immediately.

- Leave the legacy DB accepting read-only connections (no writes — block
  at the network layer).
- Run `pg_dump` on both legacy and CNPG daily; diff row counts on the 10
  highest-volume tables. Any divergence → investigate; do not decommission
  until 14 consecutive days of parity.
- Script scaffold at `apps/backend/scripts/compare-dbs.mjs` (to be written).

### 13. Decommission legacy Postgres

After 30 days of parity:

- [ ] Take one final `pg_dump` from legacy, archive to R2 cold storage
      (`vhhealth-archive/legacy-final-dump/`).
- [ ] Stop legacy DB container / service.
- [ ] Remove legacy DB from any remaining orchestration files (container
      manifests, host provisioning).
- [ ] Update secrets manager — remove `LEGACY_DATABASE_URL`.
- [ ] Update `.env.example` to only show CNPG-style connection strings.
- [ ] Log the decommission in `docs/incidents/legacy-db-decommission-YYYYMMDD.md`.

---

## SSL / Security

- All connections inside the cluster use `sslmode=require` (TLS terminated at
  the CNPG pod; cert managed by the operator, rotated automatically).
- Backup files are AES-256 encrypted by pgBackRest before they leave the
  primary pod. Key in `pgbackrest-cipher` sealed secret; rotation covered in
  `RUNBOOKS/cert-rotation.md`.
- Network policy only allows `vhhealth` namespace → CNPG Service; cross-
  namespace access denied by default.
- Superuser credentials live in a CNPG-managed Secret; `vhhealth` app user has
  only the grants it needs (`CONNECT`, `USAGE`, `SELECT/INSERT/UPDATE/DELETE`
  on app schema).

---

## Estimated Timeline

| Phase | Time |
|-------|------|
| CNPG cluster apply + health verify | 30 min |
| Dump + copy + import (5GB-ish DB) | 30–60 min |
| Migration/seed parity check | 15 min |
| Cutover (Secret update + rollout) | 10 min |
| End-to-end verification | 30 min |
| Backfill audit/PHI logs | 15–30 min |
| Monitoring + 30-day parity period | 30 days (passive) |

Active cutover window: **2–3 hours**. Legacy decommission: 30 days after
cutover.

---

## Rollback Procedure

If cutover fails at any point before step 12, revert in **<10 minutes**:

1. Update the `vhhealth-db-url` sealed secret back to the legacy
   `DATABASE_URL`:
   ```bash
   cat > /tmp/db-url-secret.yaml <<EOF
   apiVersion: v1
   kind: Secret
   metadata:
     name: vhhealth-db-url
     namespace: vhhealth
   stringData:
     DATABASE_URL: "$LEGACY_DATABASE_URL"
   EOF
   kubeseal < /tmp/db-url-secret.yaml > infra/kubernetes/apps/backend/vhhealth-db-url.sealed-secret.yaml
   rm /tmp/db-url-secret.yaml
   git commit -am "revert(deploy): point backend back at legacy DB (cutover rollback)"
   git push
   ```

2. Force sync + restart:
   ```bash
   argocd app sync vhhealth-backend
   kubectl -n vhhealth rollout restart deployment/vhhealth-backend
   ```

3. Verify legacy is serving traffic:
   ```bash
   curl -s https://api.vhhealth.app/health/deep | jq .checks.database
   ```

The CNPG cluster stays untouched in the rollback — you can retry the cutover
after diagnosis. Nothing about step 1 (creating CNPG) is destructive to the
legacy DB.

---

## Related files

- [`../SYSTEM-ARCHITECTURE.md`](../SYSTEM-ARCHITECTURE.md) — cluster topology reference
- [`DISASTER-RECOVERY.md`](DISASTER-RECOVERY.md) — DR runbook (backup + PITR scenarios)
- [`RUNBOOKS/db-restore.md`](RUNBOOKS/db-restore.md) — hot-path restore runbook
- [`../../../docs/DEPLOYMENT_GUIDE.md`](../../../docs/DEPLOYMENT_GUIDE.md) — end-to-end deployment guide
