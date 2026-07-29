# Production Database Hardening

> **STATUS.** The C1.1 CNPG 1.30, PostgreSQL 18.4, Barman-plugin, and
> reader-only restore manifests are repository-complete but inert. Production
> remains on PostgreSQL 17. Activation is blocked on the approved C1.2 ladder
> from RKE2 `v1.31.4+rke2r1` to the exact
> `v1.34.9+rke2r1` / Kubernetes `v1.34.9` objective, the full
> operator/major-upgrade qualification, and live backup/restore evidence. A
> merge deploys nothing because all four top-level production Argo CD
> Applications are manual-sync. The Longhorn child Application is manual-sync
> too; no child is created or updated until an operator manually syncs its
> parent platform Application.

This is the operational gate before the VH Health database is trusted outside a
test or pilot environment. The running baseline is CloudNativePG PostgreSQL 17
with 3 instances, synchronous replication, PgBouncer, restrictive backend
network policy, and a read-only inspection role. The intended PostgreSQL 18.4
state moves WAL archiving and the sole daily base backup to the Barman Cloud
Plugin and Cloudflare R2; it is not active until the gates below pass.

Dalekdefender should still be treated as pilot/test until the restore drill and
monitoring checks below have been completed on a disposable namespace.

## C1.2 storage and activation boundary

CNPG data and WAL currently use `local-path`. Their replicated durability comes
from PostgreSQL streaming replication across CNPG instances, not from
replicated block storage. The declared Longhorn StorageClass is named
`longhorn`; Longhorn `1.7.2` is an unqualified repository target, and the
production PVC patch remains commented out. C1.2 selects and executes no
storage migration. Any later proposal must first pass
[`C1_2_STORAGE_PLACEMENT_GATE.md`](C1_2_STORAGE_PLACEMENT_GATE.md).

Three Longhorn replicas would mean three node copies, not three proven rack,
power, network, or facility failure domains. Longhorn upgrades advance one
supported minor at a time; downgrade is not an accepted recovery path.

The exact RKE2 pins, rung gates, evidence, and rollback contract are in
[`RKE2_1_34_QUALIFICATION.md`](RKE2_1_34_QUALIFICATION.md). The C1.1
CloudNativePG and PostgreSQL prerequisites remain in
[`CNPG_POSTGRES_18_QUALIFICATION.md`](CNPG_POSTGRES_18_QUALIFICATION.md).

## Required pre-sync operator warning

> Syncing this revision is an operator action, not a merge side effect. It
> triggers a CNPG rolling re-schedule under required hostname anti-affinity,
> redeploys the backend under hard hostname spread, and changes the Longhorn
> child Application to manual-sync. Expect controlled pod movement and a
> deliberately OutOfSync Longhorn child. Abort before sync if node labels,
> capacity, CNPG quorum/replication, backend disruption budget/readiness, or
> the Longhorn ownership plan do not match the qualification evidence.

Before that sync, the operator must relabel the three existing nodes and align
their persistent RKE2 `node-label` configuration. RKE2 registration-time
configuration does not retroactively relabel an already registered node. The
named change commander, database owner, application owner, storage owner,
network owner, and facilities owner must approve the window and their
service-specific abort thresholds. Missing ownership or thresholds means
`NOT QUALIFIED`; this document does not invent an RTO or RPO.

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
  follow
  [`RKE2_1_34_QUALIFICATION.md`](RKE2_1_34_QUALIFICATION.md) through
  `v1.31.4+rke2r1 -> v1.31.14+rke2r2 -> v1.32.13+rke2r2 ->
  v1.33.13+rke2r1 -> v1.34.9+rke2r1`, interleaving CNPG `1.27.4`,
  `1.28.4`, `1.29.2`, and `1.30.0` at Kubernetes 1.31, 1.32, 1.33, and
  1.34 respectively. CNPG 1.27.4 and 1.28.4 are past-EOL transit-only
  states crossed in one campaign, never parking states. Then require
  PostgreSQL 17 at the current secure minor floor (17.10 as of 2026-07-28), a
  reader-only PostgreSQL 17 backup restore, operating-system alignment,
  synthetic offline upgrade, exact pgvector proof, `ANALYZE`, and a fresh
  PostgreSQL 18 backup plus reader-only restore.

- Keep the production Longhorn PVC patch commented. Before any later storage
  proposal, complete the owner and evidence contract in
  [`C1_2_STORAGE_PLACEMENT_GATE.md`](C1_2_STORAGE_PLACEMENT_GATE.md), including
  StorageClass/PV/PVC/affinity inventory, Longhorn health, hardware and
  capacity, performance and network-loss testing, write-amplification
  measurement, facility mapping, backup/restore proof, compatibility, and a
  service-by-service migration and abort plan.

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

The named database and service owners must explicitly approve the five-minute
RPO target, the RTO window, retention, and drill acceptance criteria for the
change window. An absent owner approval or an unspecified RTO is
`NOT QUALIFIED`.

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
- Run the C1.2 infrastructure CI entrypoint:

```text
node scripts/ci/run.mjs --only=infra
```

  This repository-only gate claims no live cluster, R2, backup, restore,
  upgrade, migration, or deployment result.
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
