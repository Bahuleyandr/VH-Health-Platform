# DR Restore Drill — CNPG PITR (REL-2 / B2.2)

> Last updated: 2026-07-31 — C6.2 action-scoped identities, provider bucket
> locks, timed target-time restore-only evidence, and separate C-D1/C-D9
> measurement contracts recorded.
> Script at
> `infra/kubernetes/base/cnpg/dr-restore-drill.sh`.

HA (3 in-cluster replicas) protects against a node dying. It does NOT
protect against ransomware, a fat-fingered `DROP`, fire/flood, or the
storage layer eating itself — those need the **off-site** backup chain:
continuous WAL archiving + the sole daily base backup at 20:30 UTC to
Cloudflare R2 through the Barman Cloud Plugin
(`base/cnpg/barman-cloud-object-store.yaml` +
`base/cnpg/scheduled-backup.yaml`).

The running production database remains PostgreSQL 17. The committed
PostgreSQL 18.4 and `vhhealth-pg18` archive target are inert until C1.2 moves
RKE2 to Kubernetes 1.34 or newer and
[`CNPG_POSTGRES_18_QUALIFICATION.md`](CNPG_POSTGRES_18_QUALIFICATION.md) is
completed. A pre-upgrade PostgreSQL 17 reader-only restore is a mandatory gate.

Cross-site promotion is covered by the companion
[`CROSS_SITE_DR_FAILOVER_PLAN.md`](CROSS_SITE_DR_FAILOVER_PLAN.md). Use this
document for PITR mechanics; use the cross-site plan when the primary site,
network, or storage layer is unavailable and traffic must move to an approved
secondary site.

---

## Objective rows — do not conflate them

| Scenario | Target/measurement | Decision authority |
|---|---|---|
| Immutable-backup restore-only | The first timed target-time drill measures RTO through the application clinical-read gate and RPO from source safe point to approved PITR target | C-D1 ratifies the measured values |
| Warm-standby end-to-end promotion | Approximately one hour to restored service and seconds of data loss; not measured by this document | C-D9 is evaluated separately in Phase 2 |
| Backup freshness | Base backup older than 30 hours is an alert condition, not RTO/RPO | C1.1 rule; C1.3 delivery |
| Restore drill cadence | Quarterly, timed, logged, and shipped `suspend: true` | Operator-approved window |

A restore-only result of 12 hours does not fail C-D9. It provides the measured
justification for the warm site. Every evidence record has two rows, never one.

---

## R2 backup hardening and credential boundaries

Cloudflare R2 object versioning is unavailable: its S3 compatibility does not
support `GetBucketVersioning`, and current Wrangler has no bucket-versioning
command. Do not make versioning or non-current-version cleanup an activation
gate. The repository does not claim that bucket locks or lifecycle rules are
active.

| Control | Status | Notes |
|---|---|---|
| R2 object versioning | UNAVAILABLE | No supported R2 operation or current Wrangler command; do not invent a non-current-version retention policy |
| R2 bucket lock | OPERATOR GATE | Native R2 bucket-lock rules prevent overwrite/deletion; trial on a synthetic bucket before a separate legal/security-approved production change |
| CNPG producer identity | OPERATOR ACTION | Short-lived prefix/action-scoped writer; delete actions forbidden |
| Read-only DR identity | OPERATOR ACTION | Separate short-lived list/head/get identity for verifier, drill, and restore only |
| Retention remover | MANIFESTED, SUSPENDED | Exact approved eligible-object inventory only; put/overwrite denied; execution defaults false |
| Lock administrator | OUTSIDE KUBERNETES | Exact bucket-configuration authority; no object or Kubernetes Secret access |
| Base-backup verification | MANIFESTED, INERT | `cnpg-backup-verify` runs after the daily backup and uses only the DR reader |
| Scheduled restore proof | MANIFESTED, SUSPENDED | `scheduled-restore-proof.yaml` stays `suspend: true` until an approved synthetic proof window |
| Evidence writer/reader | OPERATOR ACTION | Separate off-site upload/readback identities; neither can access the database archive |

Cloudflare R2 temporary credentials can be constrained by bucket, prefix or
object path, lifetime, and locally signed action list. C6.2 qualifies the
Barman writer without `DeleteObject` or `DeleteObjects`, and moves eligible
deletion to the suspended remover. The parent signing credential never enters
a workload.

The production recovery boundary remains 30 days, but effective retention is
the longer of that boundary, every applicable bucket lock, and legal hold.
C-D10's 7-day post-expiry continuity-pack and 365-day edge-access-log values
govern different data. The PG18 upgrade rehearsal's coincidental `7d` is only
for a disposable synthetic archive and must not be harmonized with any of
them.

The detailed operator sequence is
[`runbooks/C6_2_R2_LOCK_AND_RESTORE_DRILL.md`](runbooks/C6_2_R2_LOCK_AND_RESTORE_DRILL.md).

---

## Barman plugin recovery

A Barman plugin/controller failure does not necessarily stop PostgreSQL
queries. The database can remain healthy while WAL archiving, base backups,
verification, and recovery stop.

1. Capture the CNPG `Cluster`, `ScheduledBackup`, latest `Backup`, producer and
   reader `ObjectStore` status, plugin controller/sidecar logs, current CRDs,
   and exact image/release-manifest digests.
2. If the controller or CRD is missing, reinstall the pinned Barman Cloud
   Plugin `0.13.0` outside ArgoCD. Verify its release-manifest digest and image
   pins, wait for the controller, and confirm
   `objectstores.barmancloud.cnpg.io` is established.
3. Confirm the production writer `ObjectStore` still uses
   `cnpg-backup-producer-credentials`, while verifier/proof resources use only
   namespace-local `cnpg-dr-reader-credentials`. Do not copy or widen
   credentials during recovery.
4. Prove the exact R2 endpoint, then create an approved plugin `Backup`, run the
   reader-only verification, and complete a restore proof. Keep the pre-failure
   and recovery evidence.

A merge leaves the C1.1 alert definitions for these failures inert. After an
operator manually syncs `vhhealth-platform`, Prometheus may evaluate them; C1.3
owns Alertmanager receiver/delivery wiring and proof.

---

## Prerequisites

```bash
# On the ops workstation:
for cmd in kubectl curl grep head seq mktemp awk; do
  command -v "${cmd}" >/dev/null || {
    echo "Missing required command: ${cmd}" >&2
    exit 1
  }
done
kubectl version --client
```

Also required:
- `kubectl` authenticated to the prod cluster.
- `kubectl`, `curl`, `grep`, `head`, `seq`, `mktemp`, and `awk` on the ops
  workstation for both the automated script preflight and its
  UID-preconditioned cleanup.
- Kubernetes 1.34 or newer and the fully qualified CNPG 1.30 operator ladder
  before any PostgreSQL 18 exercise.
- Barman Cloud Plugin `0.13.0` installed outside ArgoCD, with
  `objectstores.barmancloud.cnpg.io` established.
- The production `ObjectStore` render contains the confirmed endpoint
  `https://dbe488236c64499a3dfc797a750c912d.r2.cloudflarestorage.com`.
- `cnpg-dr-reader-credentials` is sealed in the restore namespace. The producer
  Secret is neither required nor permitted.
- Network access from the ops workstation to the cluster API.

---

## Timed target-time restore-only proof

The fixed namespace `vhhealth-restore-proof` and its reader Secret must already
exist from reviewed manifests. The script never creates, copies, exports, or
deletes credentials.

```bash
# From the repo root after setting every approved input described in the C6.2
# runbook. EVIDENCE_OUTPUT must be outside the repository and protected.
bash infra/kubernetes/base/cnpg/dr-restore-drill.sh
```

The script:

1. validates the approved target/safe-point, baseline, application probe,
   lock-proof, source-commit, run-ID, and evidence-output inputs;
2. refuses to overwrite an existing `vhhealth-pg-drill` Cluster or
   `vhhealth-pg18-reader` ObjectStore;
3. patches only a temporary copy of the excluded manifest with the target time
   and applies the reader-only `ObjectStore` and disposable recovery Cluster;
4. waits up to 50 minutes for `Cluster in healthy state`;
5. proves the exact image, roles, approved schema/migration baselines, data
   checksums, pgvector, tenant-isolated admissions/timeline/audit reads, and a
   read-only application clinical probe;
6. writes a PHI-free evidence file containing separate C-D1 restore-only and
   C-D9 `NOT_RUN_PHASE_2` rows; and
7. removes only the Cluster and ObjectStore carrying
   `vhhealth.app/disposable-restore-proof=true` and the UIDs captured when the
   script created them, using UID delete preconditions and waiting for Cluster
   deletion before ObjectStore deletion.

Upload the evidence through the separate evidence writer and read it back
through the evidence reader. The suspended `cnpg-scheduled-restore-proof`
CronJob performs the same target-time, SQL/application, upload/readback, and
UID-bound cleanup contract after every `OWNER_INPUT` is supplied out-of-band.

---

## Manual pausable drill

Use this path when you need to inspect the restored cluster before cleanup.

### Step 1 — Verify fixed prerequisites

```bash
kubectl get namespace vhhealth-restore-proof
kubectl get crd objectstores.barmancloud.cnpg.io
kubectl -n vhhealth-restore-proof get secret cnpg-dr-reader-credentials
kubectl -n vhhealth-restore-proof get cluster vhhealth-pg-drill 2>&1
kubectl -n vhhealth-restore-proof get objectstore vhhealth-pg18-reader 2>&1
```

The Cluster and ObjectStore checks must return NotFound. Do not copy a Secret
from another namespace, and never make `cnpg-backup-producer-credentials`
available here.

### Step 2 — Apply the reviewed reader-only resources

```bash
RECOVERY_START=$(date +%s)
kubectl apply -f infra/kubernetes/base/cnpg/dr-restore-drill.yaml
kubectl -n vhhealth-restore-proof get cluster vhhealth-pg-drill -w
# Wait for: "Cluster in healthy state"
RECOVERY_END=$(date +%s)
echo "Recovery elapsed: $(( RECOVERY_END - RECOVERY_START ))s"
```

The committed endpoint, plugin name, reader `ObjectStore`, archive identity,
and digest-pinned image are authoritative. Do not introduce account-ID
substitution or writer credentials.

### Step 3 — Verify clinical invariants

```bash
DRILL_POD=$(kubectl get pods -n vhhealth-restore-proof \
  -l cnpg.io/cluster=vhhealth-pg-drill,role=primary \
  -o jsonpath='{.items[0].metadata.name}')

psql() {
  kubectl exec -n vhhealth-restore-proof "${DRILL_POD}" \
    -c postgres -- psql -U postgres vhhealth -tAc "$*"
}

echo "INV-1 admitted admissions:          $(psql 'SELECT count(*) FROM admissions WHERE status = '\''admitted'\'';')"
echo "INV-2 max(clinical_timeline_events): $(psql 'SELECT max(created_at) FROM clinical_timeline_events;')"
echo "INV-3 migration count:               $(psql 'SELECT count(*) FROM _migrations;')"
echo "INV-4 users count:                   $(psql 'SELECT count(*) FROM users;')"
echo "INV-5 tenants count:                 $(psql 'SELECT count(*) FROM tenants;')"
echo "INV-6 vector distance:               $(psql \"SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector;\")"
```

### Step 4 — Backend smoke test

Port-forward only from an approved isolated workstation and point a
non-production backend at the drill service. Record representative application
reads; do not route production traffic or writes to the proof cluster.

### Step 5 — Record evidence and clean up

Fill in the results template below before cleanup. Capture and verify both the
disposable label and UID, then send UID-preconditioned Kubernetes API deletes.
Delete and wait for the Cluster first; only then re-check and delete the
ObjectStore. Stop without deleting anything if a label, UID, or identity check
fails.

```bash
set -euo pipefail
drill_ns="vhhealth-restore-proof"
drill_cluster="vhhealth-pg-drill"
reader_store="vhhealth-pg18-reader"

cluster_label="$(kubectl -n "${drill_ns}" get cluster "${drill_cluster}" \
  -o jsonpath='{.metadata.labels.vhhealth\.app/disposable-restore-proof}')"
cluster_uid="$(kubectl -n "${drill_ns}" get cluster "${drill_cluster}" \
  -o jsonpath='{.metadata.uid}')"
store_label="$(kubectl -n "${drill_ns}" get objectstore "${reader_store}" \
  -o jsonpath='{.metadata.labels.vhhealth\.app/disposable-restore-proof}')"
store_uid="$(kubectl -n "${drill_ns}" get objectstore "${reader_store}" \
  -o jsonpath='{.metadata.uid}')"

[ "${cluster_label}" = "true" ] && [ -n "${cluster_uid}" ] &&
  [ "${store_label}" = "true" ] && [ -n "${store_uid}" ] || {
    echo "Refusing cleanup: disposable label or UID proof failed" >&2
    exit 1
  }

proxy_port="${KUBECTL_PROXY_PORT:-18001}"
proxy_log="/tmp/vhhealth-dr-kubectl-proxy.$$"
kubectl proxy --port="${proxy_port}" >"${proxy_log}" 2>&1 &
proxy_pid=$!
trap 'kill "${proxy_pid}" 2>/dev/null || true; rm -f "${proxy_log}"' EXIT
sleep 1
curl --fail --silent --show-error "http://127.0.0.1:${proxy_port}/healthz"

cluster_delete="$(
  printf '{"apiVersion":"v1","kind":"DeleteOptions","preconditions":{"uid":"%s"}}' \
    "${cluster_uid}"
)"
curl --fail --silent --show-error -X DELETE \
  -H "Content-Type: application/json" --data-binary "${cluster_delete}" \
  "http://127.0.0.1:${proxy_port}/apis/postgresql.cnpg.io/v1/namespaces/${drill_ns}/clusters/${drill_cluster}"
kubectl -n "${drill_ns}" wait --for=delete \
  "cluster/${drill_cluster}" --timeout=10m

current_store_label="$(kubectl -n "${drill_ns}" get objectstore "${reader_store}" \
  -o jsonpath='{.metadata.labels.vhhealth\.app/disposable-restore-proof}')"
current_store_uid="$(kubectl -n "${drill_ns}" get objectstore "${reader_store}" \
  -o jsonpath='{.metadata.uid}')"
[ "${current_store_label}" = "true" ] &&
  [ "${current_store_uid}" = "${store_uid}" ] || {
    echo "Refusing ObjectStore cleanup: identity changed" >&2
    exit 1
  }

store_delete="$(
  printf '{"apiVersion":"v1","kind":"DeleteOptions","preconditions":{"uid":"%s"}}' \
    "${store_uid}"
)"
curl --fail --silent --show-error -X DELETE \
  -H "Content-Type: application/json" --data-binary "${store_delete}" \
  "http://127.0.0.1:${proxy_port}/apis/barmancloud.cnpg.io/v1/namespaces/${drill_ns}/objectstores/${reader_store}"
kubectl -n "${drill_ns}" wait --for=delete \
  "objectstore/${reader_store}" --timeout=5m

kill "${proxy_pid}"
wait "${proxy_pid}" 2>/dev/null || true
rm -f "${proxy_log}"
trap - EXIT
kubectl -n "${drill_ns}" get secret cnpg-dr-reader-credentials
```

The final command must still find the sealed reader Secret. Do not delete the
restricted namespace, credentials, R2 objects, Backup custom resources,
checksums, or captured evidence.

---

## Results capture template

Use
[`qa-findings/c6-2-restore-evidence-template.md`](qa-findings/c6-2-restore-evidence-template.md).
It requires two distinct objective rows, lock and identity-negative proof,
clinical invariants, off-site upload/readback, UID cleanup, and C-D1
ratification.

---

## Real-incident quick path

For a site-disaster or primary-site isolation event, first read
[`CROSS_SITE_DR_FAILOVER_PLAN.md`](CROSS_SITE_DR_FAILOVER_PLAN.md) and run the
cross-site preflight. The steps below are the same database recovery hot path,
but cross-site promotion adds operator approval, DNS/tunnel cutover, and the
promotion evidence template.

1. **Declare**: wards switch to the downtime procedure
   (`docs/DOWNTIME_PROCEDURE.md`). Incident commander paged.
2. **Set recovery time**: decide T = last known-good time (check Prometheus
   for when the anomaly started).
3. **Create a reviewed incident recovery manifest** from
   `dr-restore-drill.yaml`. Do not edit or repurpose the cleanup-enabled drill
   script. Use a new recovery cluster name, the approved target time, the exact
   image/archive identity for the source backup's PostgreSQL major, and a
   namespace-local reader Secret. Preserve the rendered YAML and checksum.
4. **Verify** roles, schema, row counts, checksums, pgvector, and
   representative application reads before production cutover.
5. **Repoint**: rotate the complete `vhhealth-backend-env` SealedSecret while
   preserving every reviewed non-database key. Update `DATABASE_URL`, optional
   `DATABASE_READ_URL`, and `DATABASE_SUPERUSER_URL` to the recovered services
   with their runtime/read-only/owner roles. Seal and stage the actual
   `infra/kubernetes/apps/backend/sealed-secret.yaml` plus its reviewed
   Kustomize resource entry, commit and push, then manually sync
   `vhhealth-apps`. Require the actual `Job/vhhealth-backend-migrate` PreSync
   hook to pass before restarting the backend and confirming `/health/ready`.
   Follow
   [`db-restore.md`](../apps/backend/docs/RUNBOOKS/db-restore.md#6-cut-the-backend-over-to-the-recovered-cluster)
   for the exact procedure.
6. **Back-entry**: wards enter paper records accumulated during downtime.
7. **Post-incident**: full write-up + diff against this runbook.

---

## Open items (owner-gated)

- [ ] Non-production bucket-lock and credential-negative trial accepted.
- [ ] Legal/security-approved production database lock applied and retrieved.
- [ ] Short-lived writer, reader, remover, and evidence identities qualified.
- [ ] First timed restore-only drill scheduled and completed.
- [ ] C-D1 restore-only values ratified.
- [ ] Phase 1 evidence accepted before site-specific Phase 2 work.

## Rollback and evidence invariants

- Before activation, revert the manifest commit; manual Argo sync means merge
  alone deploys nothing.
- During the CNPG ladder, stop at the last qualified rung. If the PostgreSQL 18
  upgrade fails, restore the exact qualified PostgreSQL 17 image and retain the
  failed-upgrade evidence.
- After a successful PostgreSQL 18 conversion, never image-downgrade the
  converted cluster. Restore the qualified PostgreSQL 17 backup into a **new**
  cluster or fix forward.
- Suspend a broken verifier or restore-proof job without stopping healthy WAL
  archiving or base backups. Remove only resources explicitly labeled
  disposable.
- Keep old and new credential generations until backup, verification, and
  synthetic restore evidence all pass.
- Never delete R2 objects, `Backup` custom resources, checksums, drill evidence,
  or the only recoverable generation. Never restore the old endpoint
  placeholder, duplicate schedule, producer/reader reuse, or broad backend
  Secret imports.
