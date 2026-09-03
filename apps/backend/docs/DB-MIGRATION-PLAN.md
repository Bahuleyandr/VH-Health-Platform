# VH Health Database Migration and PreSync Readiness

Status: **HELD operational runbook; not migration authority.**

Last reconciled: 2026-09-02 against `github/main`
`a4ffe9860596f07ae984d9334fe78f008b75907b`.

This runbook describes the current production migration contract and the
evidence required before an authorized operator may consider a manual ArgoCD
sync. It does not authorize a database cutover, Secret change, migration,
deployment, restore, or production mutation. The previous version described a
legacy container-to-CNPG cutover with direct `kubectl apply`, auto-sync, obsolete
Secret names, and a generic sub-ten-minute DSN rollback. Those instructions no
longer match the repository and must not be used.

The broader activation stop lines are in
[`../../../docs/GO_LIVE_ACTIVATION_CHECKLIST.md`](../../../docs/GO_LIVE_ACTIVATION_CHECKLIST.md)
and
[`../../../docs/GO_LIVE_READINESS_GAP_MATRIX.md`](../../../docs/GO_LIVE_READINESS_GAP_MATRIX.md).

## Current source-backed contract

- The active repository composition targets a CNPG-managed PostgreSQL 17
  cluster; live production state requires a target-environment receipt. The
  PostgreSQL 18 target is held outside active composition at
  `infra/kubernetes/held/c1-1-pg18-cutover/`; this runbook does not authorize or
  describe that major-version cutover.
- Raw SQL files in `apps/backend/src/migrations/` are the schema source of
  truth. `prisma db push` and synthetic seeds are not production migration
  mechanisms.
- Applied migration files are immutable. The `_migrations` tracker records file
  checksums; never edit/delete an applied file or rewrite/clear the tracker.
- `Application/vhhealth-apps` is manual-sync. A merge or `OutOfSync` state is
  inert until a named operator approves and starts the exact revision.
- `infra/kubernetes/apps/backend/migration-config.yaml` is an ArgoCD `PreSync`
  hook at wave `-2`. `migration-job.yaml` is a `PreSync` hook at wave `-1`.
  The backend Deployment is not reconciled until the Job reaches `Complete`.
- The Job uses the approved backend image and overrides `DATABASE_URL` with the
  owner DSN from `DATABASE_SUPERUSER_URL`. The runtime Deployment remains on the
  NOSUPERUSER/NOBYPASSRLS runtime role.
- The Job runs, in order:
  1. `node scripts/ensure-pgvector-extension.mjs`;
  2. `node scripts/payroll-revision-754-preflight.mjs --report-only`;
  3. `node scripts/ci-setup-db.mjs --skip-seeds`.
- `ci-setup-db.mjs` is tracker-driven and re-runnable, but individual migration
  files need not be transactionally reversible. Re-running is not rollback.
- `wait-owner-bypassrls` stops the Job before SQL until the CNPG-managed owner
  role reports `rolbypassrls=true`. Do not bypass this gate.
- `restartPolicy: Never` plus `backoffLimit: 2` retains up to three attempt pods.
  The Job has a 900-second job-wide deadline and a 24-hour terminal TTL.
  `BeforeHookCreation` deletes the previous Job and pods at the next sync.
  `DeadlineExceeded` may delete the still-running pod, so the ArgoCD live stream
  is required evidence.

## Current hard stops

All rows are fail-closed. Missing evidence is a stop.

| Gate | Current repository state | Required owner evidence |
|---|---|---|
| Release authority | PR #872 (`INF-006`) remained open/draft/HELD when live-checked on 2026-09-02. | OWNER-INPUT — external containment and named release authority receipt: ______. |
| Exact release | No release SHA/environment is selected by this document. | OWNER-INPUT — SHA: ______; environment: ______; operator: ______; window: ______. |
| Restore point | Repository state cannot prove a usable target-environment backup. | Database-owner signed backup plus restore-to-new-cluster receipt, identifiers, RPO/RTO, hash: ______. |
| Payroll 754 | The production acceptance ConfigMap leaves `PAYROLL_754_ACCEPTED_MANIFEST_SHA256` and `PAYROLL_754_ACCEPTED_BY` blank. | If the report finds rows: mode-0600 export hash, exact accepted manifest, and named payroll data owner: ______. |
| Inventory 753 | The file has 82 `NOT VALID` occurrences, no `VALIDATE CONSTRAINT`, and states validation is deferred to migration 756; no migration 756 exists in the release. | Additive readiness migration, zero-open or named accepted-exception receipt, and proof every applicable constraint is `convalidated=true`: ______. |
| Inventory design | Two design questions remain open in the readiness gap matrix. | OWNER-INPUT — 753-D1 disposition: ______; 753-D2 disposition: ______. Do not edit migration 753. |
| Runtime role | Repository configuration cannot prove the live owner/runtime role posture. | Live `rolsuper`/`rolbypassrls`, CNPG reconciliation, and runtime boot-guard evidence: ______. |

## Pre-sync evidence packet

OWNER-INPUT — database owner: ______; release captain: ______; payroll data
owner: ______; pharmacy owner: ______; clinical safety owner: ______; rollback
decision owner: ______; protected evidence location: ______.

Before any write, capture read-only evidence for the exact target:

1. Candidate SHA and signed image digest used by the migration Job.
2. Rendered object hashes for `vhhealth-backend-migration-config`,
   `vhhealth-payroll-revision-754-acceptance`, and
   `Job/vhhealth-backend-migrate`; exclude Secret values.
3. Current CNPG Cluster health, instances, synchronous replication, backup
   status, and the owner/runtime role posture.
4. Verified pre-sync Backup/restore receipt and exact recovery identifiers.
5. Current `_migrations` tail with name, checksum, and applied timestamp.
6. Ordered target migration filenames and SHA-256 checksums, plus the expected
   post-run tracker tail.
7. Read-only migration-754 report. If its cardinality is non-zero, export to a
   protected mode-0600 file, retrieve it before the container exits, and obtain
   the named owner's exact-hash acceptance. Do not put payroll identities or the
   export in git, a PR, or an ordinary log.
8. Inventory-753 readiness receipt and both owner design dispositions. Until
   migration 756 or an explicitly reviewed successor exists, this gate cannot
   close.

Record: packet ID ______; target SHA ______; rendered hashes ______; backup/
restore receipt ______; tracker before ______; target manifest ______; payroll
receipt ______; inventory receipt ______; final GO/STOP owner ______.

## Authorized operator sequence

This section is sequence, not permission. Proceed only after every hard stop and
owner blank above is complete.

1. Freeze the approved change window and verify no competing ArgoCD sync or
   database maintenance is active.
2. Reconfirm the exact candidate SHA, image digest, rendered hook/config hashes,
   pre-sync backup, and tracker state match the signed packet.
3. Reconfirm the migration-754 acceptance values match the report exactly; a
   blank, malformed, stale, or different hash/owner is a stop.
4. The authorized ArgoCD operator starts the exact `vhhealth-apps` manual sync.
5. Observe and retain the `wait-owner-bypassrls` initContainer output from every
   attempt. The successful attempt must report owner bypass reconciliation
   before SQL begins.
6. Observe and retain every `migrate` container attempt using the controller-set
   selector
   `batch.kubernetes.io/job-name=vhhealth-backend-migrate`. Do not use
   `logs job/<name>` as the sole evidence because it chooses one arbitrary pod.
7. Confirm the Job itself reaches `Complete`; export its YAML/conditions and
   every attempt log before the 24-hour TTL and before any further sync.
8. Independently query `_migrations` and compare its ordered names/checksums with
   the approved expected tail. Confirm the backend Deployment begins only after
   hook completion and the runtime role boot guard is healthy.
9. Attach the post-run database, application, RLS isolation, alert-delivery, and
   rollback-readiness receipts. A green rollout alone is not migration proof.

## Failure stop and evidence preservation

On initContainer, Job, SQL, tracker, readiness, or post-run mismatch:

1. Stop the sync and production cutover. Do not force the Deployment or delete
   the Job/pods.
2. Export the ArgoCD live stream, Job YAML/conditions, pod events, and every
   retained attempt log immediately. On `DeadlineExceeded`, the running pod may
   already be gone; record that limitation rather than inventing an SQL cause.
3. Capture the current `_migrations` tail and database health read-only. Never
   rewrite the tracker to make a retry pass.
4. Do not start another sync merely to recreate evidence: the
   `BeforeHookCreation` policy deletes the previous Job and its pods.
5. Diagnose which statements committed and whether the failed migration owns an
   explicit transaction. Do not assume a file was atomic merely because the Job
   failed.
6. OWNER-INPUT — database/release owners select and sign exactly one recovery:
   restore the verified pre-sync backup into a new cluster and prove it before
   traffic, or ship an additive fix-forward migration after independent review.
   Decision/receipt: ______.

## Rollback limits

- Reverting an image digest, application manifest, or connection Secret does
  not undo committed schema or data changes.
- Tracker-driven idempotence prevents replay of recorded files; it is not a down
  migration system.
- Never edit migrations 753, 754, 757, 758, or any other applied migration to
  retrofit rollback. Use a new migration number if owners authorize a
  correction.
- Do not route new writes back to a legacy database after CNPG has accepted
  production writes unless the cutover plan already proves a lossless reverse
  replication/reconciliation path. No such path is authorized by this file.
- A database restore is a new-cluster recovery operation governed by the DR
  runbooks. It requires exact backup identity, recovery target, validation, and
  traffic-cutover authority; it is not an ad hoc replacement for diagnosis.
- Preserve the failed state and both failure/recovery receipts. Do not delete or
  overwrite evidence to claim a clean run.

## Legacy container-to-CNPG cutover

OPEN-QUESTION — this repository does not currently provide an approved,
site-specific legacy-to-CNPG data cutover packet. If a hospital still needs that
transition, the database, privacy, clinical, and release owners must supply a
new plan covering write freeze, complete data and audit/outbox capture,
checksums, sequence state, encryption, backup/restore, forward and reverse
reconciliation, RPO/RTO, traffic switch, and decommission evidence. Do not use
the retired direct-apply procedure from this file's history.

## Related runbooks

- [`../../../docs/DEPLOYMENT_GUIDE.md`](../../../docs/DEPLOYMENT_GUIDE.md)
- [`../../../docs/GO_LIVE_ACTIVATION_CHECKLIST.md`](../../../docs/GO_LIVE_ACTIVATION_CHECKLIST.md)
- [`../../../docs/DR_RESTORE_DRILL.md`](../../../docs/DR_RESTORE_DRILL.md)
- [`RUNBOOKS/db-restore.md`](RUNBOOKS/db-restore.md)
- [`../../../docs/CNPG_POSTGRES_18_QUALIFICATION.md`](../../../docs/CNPG_POSTGRES_18_QUALIFICATION.md)
- [`../../../docs/DB_SCHEMA_GUARDRAILS.md`](../../../docs/DB_SCHEMA_GUARDRAILS.md)
