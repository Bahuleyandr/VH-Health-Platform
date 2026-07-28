# Production Database Hardening

> **STATUS.** The C1.1 CNPG 1.30, PostgreSQL 18.4, Barman-plugin, and
> reader-only restore manifests are repository-complete but inert. Production
> remains on PostgreSQL 17. Activation is blocked on C1.2 moving RKE2 from
> Kubernetes 1.31.4 to 1.34 or newer, the full operator/major-upgrade
> qualification, and live backup/restore evidence. A merge deploys nothing
> because all four top-level production ArgoCD Applications are manual-sync.
> Child Applications may define their own policy, but they are not created or
> updated until an operator manually syncs the platform Application.

This is the operational gate before the VH Health database is trusted outside a
test or pilot environment. The running baseline is CloudNativePG PostgreSQL 17
with 3 instances, synchronous replication, PgBouncer, restrictive backend
network policy, and a read-only inspection role. The intended PostgreSQL 18.4
state moves WAL archiving and the sole daily base backup to the Barman Cloud
Plugin and Cloudflare R2; it is not active until the gates below pass.

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
- The CNPG producer is bucket-scoped Object Read & Write because Barman
  retention requires deletion. Verification and recovery use a different,
  bucket-scoped Object Read-only DR identity; no verifier or restore pod
  receives the producer Secret. The ObjectStore destination prefix is workload
  routing, not credential scope. Brokered prefix/put-only enforcement remains
  deferred to C6.2.
- Secrets live in Kubernetes secrets or sealed secrets; no database password is
  committed to repo docs, examples, screenshots, or CI logs.
- Production incidents prefer degraded/error states over synthetic "success"
  values when telemetry tables or log backends are unavailable.

## Pre-Production Checklist

- Complete the binding activation procedure in
  [`CNPG_POSTGRES_18_QUALIFICATION.md`](CNPG_POSTGRES_18_QUALIFICATION.md):
  C1.2 Kubernetes 1.34+, PostgreSQL 17 at the current secure minor floor (17.10
  as of 2026-07-28), a reader-only PostgreSQL 17 backup restore, the sequential
  CNPG ladder through 1.30.0 without a major change, operating-system
  alignment, synthetic offline upgrade, exact pgvector proof, `ANALYZE`, and a
  fresh PostgreSQL 18 backup plus reader-only restore.

- Before the next manual platform sync, install Barman Cloud Plugin 0.13.0
  outside ArgoCD, confirm `objectstores.barmancloud.cnpg.io`, seal the producer,
  reader, and archive-crypto Secrets, and prove that the confirmed production
  R2 endpoint renders into the production `ObjectStore` and both backend
  backup jobs. An unknown `ObjectStore` kind makes the platform Application
  unsyncable; missing
  credentials or endpoint wiring stops the backup/proof jobs.

- Block activation of the backend MinIO archive producer and verifier until
  observed source and archive sizes fit their bounded 10 GiB `emptyDir`
  staging. The producer holds the source plus encrypted archive together with
  a 128 MiB safety margin; its preflight projects this as
  `2 × source bytes + 128 MiB ≤ 10 GiB`, so the practical source ceiling is
  less than 5 GiB. The verifier requires
  `archive bytes + 128 MiB ≤ 10 GiB`. The scripts fail closed before producer
  encryption/upload or verifier download when projected capacity exceeds the
  limit. Growth beyond this bound requires a reviewed streaming/multipart
  design, MinIO replication, or a dedicated staging PVC.

- Seal `backup-crypto` with two independently generated high-entropy values:
  `BACKUP_ENCRYPTION_KEY` and `BACKUP_HMAC_KEY` must differ. The producer uses
  HMAC-SHA256 to authenticate canonical archive metadata, archive key, and
  ciphertext; the verifier must validate that HMAC before decryption. A matching
  SHA-256 alone is not authenticity evidence. For rotation, deploy one reviewed
  new pair to producer and verifier together, retain the prior pair while its
  archives remain required, and require new archive, verification, decryption,
  and restore evidence before retiring the prior generation.

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

```bash
kubectl get namespace vhhealth-restore-proof
kubectl -n vhhealth-restore-proof get secret cnpg-dr-reader-credentials
bash infra/kubernetes/base/cnpg/dr-restore-drill.sh
```

The script uses a namespace-local read-only `ObjectStore`, removes only its
labeled disposable Cluster/ObjectStore, and retains the namespace and sealed
reader Secret.

- Verify database roles:

```sql
SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
       rolreplication, rolbypassrls, rolinherit
FROM pg_roles
WHERE rolname IN (
  'vhhealth',
  'vhhealth_app',
  'vhhealth_runtime',
  'vhhealth_readonly'
)
ORDER BY rolname;

SELECT member.rolname AS member, granted.rolname AS granted_role
FROM pg_auth_members AS membership
JOIN pg_roles AS granted ON granted.oid = membership.roleid
JOIN pg_roles AS member ON member.oid = membership.member
WHERE member.rolname IN (
  'vhhealth',
  'vhhealth_app',
  'vhhealth_runtime',
  'vhhealth_readonly'
)
ORDER BY member.rolname, granted.rolname;

SELECT datname, pg_get_userbyid(datdba) AS owner
FROM pg_database
WHERE datname = 'vhhealth';

SELECT pg_get_userbyid(relowner) AS owner, count(*) AS objects
FROM pg_class
WHERE relnamespace IN (
  SELECT oid
  FROM pg_namespace
  WHERE nspname NOT IN ('pg_catalog', 'information_schema')
)
GROUP BY owner
ORDER BY owner;
```

All four roles must be non-superuser, non-createdb, non-createrole, and
non-replication. `vhhealth_app` is NOLOGIN/NOBYPASSRLS;
`vhhealth_runtime` is LOGIN/NOBYPASSRLS and a member of `vhhealth_app`;
`vhhealth_readonly` is LOGIN/NOBYPASSRLS; and `vhhealth` is the database/object
owner used only by the migration path. Record any deliberate `vhhealth`
BYPASSRLS state as migration-only and prove the backend runtime DSN never uses
it. For `vhhealth_readonly`, all app tables must be selectable and every insert,
update, delete, truncate, create, alter, and drop attempt must fail.

- Verify PITR readiness:

```text
RPO: latest archived WAL segment is no more than 5 minutes old; greater than
5 minutes is an RPO breach and blocks production-readiness sign-off.
RTO: restore drill reaches a queryable database within the agreed window.
Retention: backup retention meets hospital/legal retention requirements.
```

- A merge leaves the C1.1 `PrometheusRule` definitions inert because the
  top-level platform Application is manual-sync. After an operator syncs
  `vhhealth-platform`, Prometheus may load and evaluate them. Verify that rule
  state separately; C1.3 owns Alertmanager receiver/delivery wiring and proof.
  A rendered, loaded, or firing rule does not prove that Discord, PagerDuty, or
  any other receiver pages:

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
- Keep source-image inventory, Backup custom-resource status, object metadata,
  checksums, upgrade logs, pgvector proof, restore output, and application-read
  evidence in the release folder for the deployed version.
- Suspend a broken verifier or proof job without stopping a healthy WAL/base
  backup stream. Remove only labeled disposable restore resources, and keep old
  and new credential generations until backup, verification, and synthetic
  restore evidence pass.

## Current Status

The repo has the manifests and local schema guardrails needed for qualification.
It is not production-ready until the operator ladder, PostgreSQL 17-to-18
synthetic qualification, real reader-only restore drill, alert delivery, and
credential evidence exist for the target environment. Before activation,
rollback is a Git revert. After a successful PostgreSQL 18 conversion, never
image-downgrade the converted cluster: restore the qualified PostgreSQL 17
backup into a new cluster or fix forward, and retain all backup and failure
evidence.
