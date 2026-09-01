# Runbook — Database restore

> Executed via `kubectl` on the on-prem cluster. See
> [`../../../../docs/DEPLOYMENT_GUIDE.md`](../../../../docs/DEPLOYMENT_GUIDE.md)
> for kubeconfig setup.

**Severity:** P0
**RPO target:** ≤ 5 minutes
**RTO target:** ≤ 60 minutes

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
- The pinned Barman Cloud Plugin is healthy and
  `objectstores.barmancloud.cnpg.io` is established. A plugin outage can leave
  the database serving while WAL/base-backup and recovery jobs stop.
- A sealed `cnpg-dr-reader-credentials` Secret in the recovery namespace.
  Recovery uses this Object Read-only identity only; the CNPG producer Secret
  is prohibited.
- The recovery image matches the backup's PostgreSQL major and qualified source
  image. Production remains on PostgreSQL 17 until the C1.2 Kubernetes 1.34+
  and PostgreSQL 18 qualification gates pass.
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

### 4. Bring up a recovery Cluster through the Barman plugin

This creates a NEW `Cluster` CR alongside the broken one — it doesn't
destroy the broken one, so you retain rollback. The committed reference is
`infra/kubernetes/base/cnpg/dr-restore-drill.yaml`: its recovery source uses
`externalClusters[].plugin` with plugin
`barman-cloud.cloudnative-pg.io`, ObjectStore `vhhealth-pg18-reader`, and
archive server identity `vhhealth-pg18`.

That committed template is only for the post-qualification PostgreSQL 18
archive. While production remains on PostgreSQL 17, recover from the exact
qualified PG17 image/archive and the reader-only recovery procedure recorded by
the mandatory pre-upgrade rehearsal. Never use the PG18 template to open a
PG17 backup or retarget the PG17 archive.

```bash
# First prove the committed reader-only path in the restricted proof namespace.
# The script removes only its labeled disposable Cluster and ObjectStore.
bash infra/kubernetes/base/cnpg/dr-restore-drill.sh
```

For a real incident, create a reviewed incident copy of that plugin
`ObjectStore` + `Cluster` pair. Change only the namespace, recovery-cluster
name, qualified image for the backup's major version, recovery target time, and
the archive identity selected for the source backup. A PostgreSQL 18 copy keeps
`vhhealth-pg18`; a current or historical PostgreSQL 17 recovery intentionally
sets and records the qualified PostgreSQL 17 archive identity. Preserve that
selected identity throughout recovery: never retarget or overwrite its archive.
Keep the read-only Secret, plugin name, endpoint, and source binding unchanged.
Store the exact rendered YAML and checksum in the incident evidence bundle
before applying it.

Watch the incident recovery cluster bootstrap:
```bash
kubectl -n vhhealth-platform get cluster vhhealth-pg-recovery -w
# Phase transitions: Creating cluster -> Bootstrapping -> Cluster in healthy state
```

Bootstrap reads the R2 base backup and WAL through the reader-only Barman
`ObjectStore`. It never needs or mounts `cnpg-backup-producer-credentials`.
Record the selected `Backup` custom resource, object metadata, archive identity,
replayed target time, and elapsed recovery time.

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

Rotate the actual broad `vhhealth-backend-env` SealedSecret. Start from the
approved complete plaintext source used for the currently deployed Secret,
preserve every reviewed key, and change only the database bindings:

- `DATABASE_URL` uses the `vhhealth_runtime` role and the recovered read/write
  Service.
- `DATABASE_READ_URL`, when enabled, uses the recovered read-only Service.
- `DATABASE_SUPERUSER_URL` uses the owner role and recovered read/write Service
  for the PreSync migration hook.

Never create a two- or three-key replacement Secret: updating the broad Secret
with only database keys would remove JWT, API, encryption, integration, and
monitoring credentials.

```bash
# /secure/operator-work/vhhealth-backend-env.yaml is a complete Secret named
# vhhealth-backend-env in namespace vhhealth, sourced outside the repository.
kubeseal \
  --controller-namespace sealed-secrets \
  --controller-name sealed-secrets-controller \
  --scope strict \
  -f /secure/operator-work/vhhealth-backend-env.yaml \
  -w infra/kubernetes/apps/backend/sealed-secret.yaml

# The real sealed file must be a Kustomize resource. On first activation, add
# `- sealed-secret.yaml` under resources in the backend kustomization and stage
# that reviewed resource entry in the same commit.
git add infra/kubernetes/apps/backend/sealed-secret.yaml \
  infra/kubernetes/apps/backend/kustomization.yaml
git diff --cached -- \
  infra/kubernetes/apps/backend/sealed-secret.yaml \
  infra/kubernetes/apps/backend/kustomization.yaml
git commit -m "incident: point backend at vhhealth-pg-recovery (restore)"
git push
approved_sha="$(git rev-parse HEAD)"
argocd app sync vhhealth-apps --revision "${approved_sha}"
kubectl -n vhhealth wait --for=condition=complete \
  job/vhhealth-backend-migrate --timeout=900s
# Read ALL attempts, not one. The Job runs restartPolicy: Never, so each of its
# up-to-3 attempts is a separate retained pod; `logs job/<name>` picks a single
# arbitrary one ("Found 3 pods, using pod/…") and can show you a pod that is not
# the one that failed. Select on the controller-set job-name label instead.
kubectl -n vhhealth logs -l batch.kubernetes.io/job-name=vhhealth-backend-migrate \
  -c migrate --tail=400 --prefix
kubectl -n vhhealth rollout restart deployment/vhhealth-backend
kubectl -n vhhealth rollout status deployment/vhhealth-backend
```

If the `wait` above times out, the hook failed and the sync aborted. Prod sync
is manual, so this surfaces to whoever triggered it — nothing pages, and nobody
else is looking. **Start by counting pods, because that alone tells you which of
three failures you have, and two of the three make the `logs -l …` command above
answer something other than the diagnosis:**

```bash
kubectl -n vhhealth get pods -l batch.kubernetes.io/job-name=vhhealth-backend-migrate
```

**1 — one to three pods, `Error`. A migration failed.** This is the ordinary
case. The `logs -l … -c migrate` command above is the answer: each attempt is a
separate retained pod (`restartPolicy: Never`), and they are kept for
`ttlSecondsAfterFinished` (24h). Compare the attempts — all failing identically
means a genuinely bad migration, one failure followed by success means a
transient blip. Do not re-sync before reading them: the next sync's
`hook-delete-policy: BeforeHookCreation` deletes this Job and its pods.

**2 — pods exist, but `-c migrate` answers `container "migrate" ... is waiting
to start: PodInitializing`.** The `wait-owner-bypassrls` init gate is what
failed, not a migration — `migrate` never ran, so it has no logs. Omitting `-c`
does not help; kubectl defaults to `migrate`. Read the gate instead:

```bash
kubectl -n vhhealth logs -l batch.kubernetes.io/job-name=vhhealth-backend-migrate \
  -c wait-owner-bypassrls --tail=400 --prefix
```

A gate timeout means CNPG has not reconciled `bypassrls` onto the owner role;
see `docs/GO_LIVE_ACTIVATION_CHECKLIST.md` D1. Do not force the migration
through.

**3 — `No resources found`. The deadline killed it, and there are no logs to
read.** On `activeDeadlineSeconds` (900s) the job controller DELETES the pod
that is still running, under either restartPolicy, so retention cannot help
here. The Job object's own condition is the only surviving evidence:

```bash
kubectl -n vhhealth describe job vhhealth-backend-migrate
```

`DeadlineExceeded` confirms it. Note the distinction from case 2: a pod stuck in
a *Waiting* reason (`PodInitializing`, `CreateContainerConfigError`) is not a pod
*failure*, so it never increments the backoff counter and never becomes a
retained failed pod — it sits until the deadline and is then deleted. That is
why a Job can end `Failed`/`DeadlineExceeded` having produced no pod output at
all. If ArgoCD streamed the hook logs live during the sync, that stream is the
only place the container's output ever existed; otherwise re-run the sync and
watch it. Reproduced on a kind cluster with ArgoCD 3.2 (k8s 1.34), 2026-09-01.

### 7. Apply any post-backup migrations

The manual `vhhealth-apps` sync above runs the repository's actual
`infra/kubernetes/apps/backend/migration-job.yaml` as the
`Job/vhhealth-backend-migrate` PreSync hook. It reads
`DATABASE_SUPERUSER_URL` from `vhhealth-backend-env`, ensures pgvector is
available, and runs the tracker-driven `scripts/ci-setup-db.mjs`. Hook failure
aborts the app sync. Do not manually apply a second migration manifest or
continue the rollout after a failed hook.

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

### 11. Preserve recovery evidence and plan consolidation

Do not delete or rename the original cluster under incident pressure. After at
least 24 hours of verified service, open a separately approved maintenance
change for the long-term cluster name and service wiring. Preserve the broken
cluster, source image reference, `Backup` custom resources, R2 objects,
checksums, plugin/ObjectStore status, and recovery logs until the evidence owner
signs off. Cleanup may remove only resources explicitly labeled disposable.

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
      incident) — if > 5 minutes, treat the RPO target as breached and raise a
      separate remediation item to tighten
      `archive_timeout` or investigate Barman-plugin/R2 latency.
- [ ] Confirm `kubectl -n vhhealth-platform get backups` is resuming
      on-schedule after the recovery.
- [ ] Post the timeline to `#vhhealth-postmortem`.
- [ ] Confirm the verifier and restore paths still reference only
      `cnpg-dr-reader-credentials`; rotate the reader generation if it was
      exposed, without deleting the last known-good generation.
- [ ] Never delete R2 objects, `Backup` custom resources, checksums, drill
      evidence, or the only recoverable backup generation.
