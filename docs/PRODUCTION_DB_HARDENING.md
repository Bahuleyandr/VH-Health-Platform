# Production Database Hardening

> **STATUS.** Baseline (3-replica CNPG, WAL archiving, daily backups, RLS, read-only role) is code-complete. The DR-restore-drill automation has shipped (infra/kubernetes/base/cnpg/dr-restore-drill.sh); the pre-prod gate is execution-evidence + operator sign-off (commit drill output to docs/qa-findings/). Not production-certified until that evidence exists for the target environment.

This is the operational gate before the VH Health database is trusted outside a
test or pilot environment. The Kubernetes manifests already contain a strong
baseline: CloudNativePG Postgres 17, 3 instances, synchronous replication, WAL
archiving to object storage, daily scheduled backups, PgBouncer, restrictive
backend network policy, and a read-only CloudBeaver user for inspection.

Dalekdefender should still be treated as pilot/test until the restore drill and
monitoring checks below have been completed on a disposable namespace.

## Required Posture

- Postgres runs as a managed CNPG cluster, not as an ad hoc container.
- App traffic uses the pooler or the CNPG service, never direct pod IPs.
- Backend egress to Postgres is allowed only through Kubernetes network policy.
- CloudBeaver and ad hoc GUI access use `vhhealth_readonly`; no write-capable
  browser credentials are allowed.
- WAL archiving and daily scheduled backups are configured before patient data
  is accepted.
- Secrets live in Kubernetes secrets or sealed secrets; no database password is
  committed to repo docs, examples, screenshots, or CI logs.
- Production incidents prefer degraded/error states over synthetic "success"
  values when telemetry tables or log backends are unavailable.

## Pre-Production Checklist

- Confirm cluster health:

```powershell
kubectl -n vhhealth-platform get cluster vhhealth-pg
kubectl -n vhhealth-platform get pods -l cnpg.io/cluster=vhhealth-pg
kubectl -n vhhealth-platform get pooler vhhealth-pg-rw-pooler
```

- Confirm backups exist and are recent:

```powershell
kubectl -n vhhealth-platform get scheduledbackup,backup
kubectl -n vhhealth-platform describe scheduledbackup vhhealth-pg-daily
```

- Run one restore drill to a disposable namespace before go-live:

```powershell
kubectl create namespace vhhealth-restore-drill
# Apply a temporary CNPG recovery cluster that points at the same object store.
# Verify schema, row counts, and representative app login/read paths, then
# delete the namespace.
kubectl delete namespace vhhealth-restore-drill
```

- Verify database roles:

```sql
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication
FROM pg_roles
WHERE rolname IN ('vhhealth', 'vhhealth_readonly');

SHOW default_transaction_read_only;
```

For `vhhealth_readonly`, all app tables must be selectable and every insert,
update, delete, truncate, create, alter, and drop attempt must fail.

- Verify PITR readiness:

```text
RPO: latest archived WAL segment is no more than 10 minutes old.
RTO: restore drill reaches a queryable database within the agreed window.
Retention: backup retention meets hospital/legal retention requirements.
```

- Verify monitoring and alerts:

```text
Replication lag
Backup failure or stale backup
Disk pressure on data and WAL PVCs
Connection pressure and pool saturation
Long-running queries
Deadlocks and lock waits
Failed auth spikes
```

## Ongoing Guardrails

- Run `npm run ci:db-guardrails` from `apps/backend` before every
  schema-affecting merge.
- Run `node scripts/local-ci.mjs --only=security,backend,infra` before deploy.
- Run the staff role workflow sweep against the deployed backend after deploy:

```powershell
$env:VH_BASE_URL = 'https://<host>/api/v1'
$env:VH_API_KEY = '<redacted>'
$env:VH_STAFF_TEST_PASSWORD = '<seeded staff password>'
.\scripts\smoke-staff-role-workflows.ps1 -IncludeCreates
```

- Rotate browser/read-only credentials whenever they are pasted into chat,
  screenshots, shared docs, or logs.
- Keep restore evidence in the release folder for the deployed version.

## Current Status

The repo has the manifests and local schema guardrails needed for a safe pilot.
It is not production-ready until a real restore drill, alert verification, and
credential rotation evidence exist for the target environment.
