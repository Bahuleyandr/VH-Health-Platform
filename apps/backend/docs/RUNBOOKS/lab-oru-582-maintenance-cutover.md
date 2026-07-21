# Lab ingest/governance migrations 580-584 non-rolling maintenance cutover

This is a maintenance-window cutover, not a rolling deployment. Old backend
writers cannot coexist with migrations 582 or 583: migration 582 requires every
ORU result write to own an immutable message claim, and migration 583 requires
every inbound ASTM receipt to carry its atomic contract and exact result links.
Migration 584 is part of the same exact release tail and pins care-pathway
governance that the execution spine must not omit.

The production Argo CD application is manual, but its backend Deployment is a
three-replica `RollingUpdate`, its HPA has `minReplicas: 3`, and its migration
Job is a `PreSync` hook. The operator must therefore drain the old writers and
run the migration/reconciliation job while the Deployment remains at zero;
ordinary Argo rolling order is not safe for this release.

## Frozen release inputs

Record the release Git SHA, backend image digest, rendered production manifests,
database backup identifier, production-clone identifier, PostgreSQL major
version, and these migration SHA-256 values in the change record. Any byte
change requires a new clone rehearsal.

| Migration | Bytes | SHA-256 |
| --- | ---: | --- |
| `580_care_pathway_execution_spine.sql` | `246628` | `A41495FC511BD5238FE548E9185A1461715B47AA54607C7F42FF8AD79EDAA979` |
| `581_lab_critical_alert_generations.sql` | `110528` | `43AFB83D57E50E738540ADDCC02875C35826884B3D9D4D7B31BBAEBB77B61CB4` |
| `582_lab_oru_replay_idempotency.sql` | `64558` | `F0CEA6E6EA63F9CF5932ACBD99EE9508A2E838D3715D09B969AED99E3A0E41F0` |
| `583_lab_astm_atomic_replay.sql` | `177245` | `7D1ABE4238FA95D4BAFBEA9E86052DF8C53CA8361FEFDCF407EA9E44E10919F1` |
| `584_care_pathway_governance_pinning.sql` | `73446` | `F799232A9007CB3A69DEA11D7131C96913578E94BB8C62B9C1B6106921C31EB7` |

Any placeholder or byte/hash mismatch is a hard stop. Migration 581's earlier hash was revoked after
a fresh-schema regression exposed an acknowledgement-receipt width mismatch;
the replacement above restores the established 160-character contract.
Migration 584's earlier candidates were revoked while publication-voter
eligibility and transaction-global advisory-fence ordering were corrected. The
replacement above is the only approved 584 artifact. The combined audit must
verify all five exact files before it opens a database transaction.

The readiness scripts are read-only but must connect to the primary with the
migration owner, a superuser, or a `BYPASSRLS` audit role. Never substitute the
ordinary runtime `DATABASE_URL`, a tenant-scoped role, or a recovery replica.
Keep JSON reports in the protected release evidence store; they contain tenant
IDs and bounded one-way fingerprints, but no patient identifier, raw HL7/ASTM,
raw OBX, accession, result value, or stable clinical row ID.

The combined 582-584 audit is the machine-checked PostgreSQL 18
production-clone/target gate. It fails closed unless the server major is exactly
18, the active transaction reports both `READ ONLY` and `REPEATABLE READ`, the
connection is the primary, the principal is all-tenant privileged, and the
all-tenant inventory is nonempty. There is no empty-install override.

Migration 584 and the postflight audit both prove the creation transition's
exact canonical timeline/audit source, resource, actor, state, payload/metadata,
timestamp, and idempotency parity; non-null same-tenant links alone are not
sufficient. Publication-voter eligibility is point-in-time: post-584 first
publication checks every voter as an active non-patient tenant user, while later
user drift does not invalidate immutable publication evidence. Migration 584
cannot retroactively prove that historical voters were active and non-patient at
their earlier publication time because no immutable eligibility receipt exists.
Keep that boundary visible in the change record; do not infer or synthesize the
missing historical fact. Current approved clinical and operational owners remain
an exact active, non-patient readiness requirement.

## Hard stop conditions

Abort before any schema write when any of the following is true:

- The migration-580 audit exits nonzero or reports any blocker.
- The 582-584 report has `clone_rehearsal_input_ready: false`.
- The pending migration list is anything except the exact ordered default set
  `[580, 581, 582, 583, 584]`, or the exact ordered set `[582, 583, 584]` when
  `_migrations` proves both 580 and 581 were applied by a separately documented
  compatible release. One of 580/581 applied without the other is always a
  blocker, and 584 may never be omitted or treated as preinstalled while
  582/583 are pending.
- The database major is not exactly PostgreSQL 18, the audit transaction is not
  both read-only and repeatable-read, the database is on a recovery replica,
  the audit principal cannot bypass RLS, the all-tenant inventory is empty, the
  schema is partially migrated, or the release migration inventory disagrees
  with `_migrations`.
- Any ORU result group, completed ORU claim, ASTM receipt, or ASTM result has
  both `booking_id` and `investigation_id` null. Orderless rows are a hard
  activation blocker. Migration 582 makes linked ORU source identity immutable,
  and clinical sign-off rejects the both-null source. Do not repair these rows
  with an ad hoc update. Resolution requires a future owner-approved
  reconciliation/linkage policy and migration.
- Any historical critical-lab acknowledgement lacks one exact version-2
  alert/task/SLA/state-change-comment/timeline/audit chain. Before migration
  581, the audit uses only the legacy task metadata `sla_instance_id` and
  `sla_key`; after 581 it requires exact generation/task pointers and an
  immutable `lab_critical_alert_acknowledgement_receipts` row. A current closed
  generation requires both that receipt and the still-current exact v2 chain.
  A superseded predecessor may use its valid receipt snapshot for the SLA
  closure that a corrected successor has legitimately rearmed, but its alert,
  task, comment, timeline, audit, actor, authorization, and timestamps must
  still match. Receipt-less, weak, ambiguous, unbound, actionable, or either
  direction of alert/task split evidence is a global hard blocker.
- The acknowledgement receipt `read_back_method` is not `VARCHAR(160)`, matching
  the established alert contract. A 41-160 character descriptive read-back is
  valid input and must not fail or truncate while its immutable receipt is
  inserted.
- Any ORC-2 or OBR-2 is numeric-looking, the two fields disagree, or either
  field begins with the reserved `VHINV`/`VHBOOK` prefix without being the
  exact uppercase `VHINV-<positive-int4>` form. Bare integers, decimals,
  exponents, zero, overflow, case variants, malformed `VHINV`, and every
  `VHBOOK` value are rejected; never infer a local table from an integer.
- Any canonical `VHINV` claim does not resolve under the same tenant to the
  exact active patient and a resultable investigation, or the trimmed,
  case-sensitive `investigations.test_code` does not byte-match the trimmed
  code component of OBR-4, every OBX-3, and every persisted result `test_code`.
  Namespace syntax alone is not provenance, and no fuzzy name or panel mapping
  is allowed.
- Any unrecognized external alphanumeric or absent order identity has acquired
  a local booking/investigation link. It must remain fingerprinted, unlinked
  shadow evidence and blocks activation until an owner-governed mapping exists.
  Legacy `lab_results` rows cannot prove their original ORC/OBR namespace or
  full OBR-4/OBX-3 contract from source columns or `raw_obx` alone, so
  `legacy_local_order_contract_unproven_message_groups` must also be zero.
- Any caller of the manual-result POST contract is not proven to send the new
  idempotency key. The in-repo production/UI sweep found no caller, but that is
  not evidence that external clients are absent. Inventory API gateway logs,
  analyzer/integration registrations, customer automation, and published client
  contracts; migrate and test every real caller before the window.
- Any duplicate ASTM canonical fingerprint, nonterminal receipt, unresolved
  analyzer, adoption blocker, current-generation critical rail mismatch, or
  generic task-ack/alert-open split remains.
- Any workflow run whose `(tenant_id, workflow_definition_id)` matches a
  governance row lacks the exact governance/checksum pin, exactly one pinned
  pathway companion, and one exact immutable `pathway_instance_created` event.
  A run with pins but no matching governance also blocks. Only a run with no
  governance row and both pin fields null is generic/ungoverned. Published
  approval checksum drift, invalid retirement evidence, mutable published
  governance/approval/definition state, or any run/instance/event pin mismatch
  is a hard blocker.
- The PostgreSQL 18 production-clone rehearsal, backup restore test, or post-584
  report did not complete successfully against the exact release bytes.
- The required database/lab validation suite has not passed twice consecutively
  against the same migrated clone with clean teardown after both runs. A cleanup
  error, including a dependency-order failure surfaced by `afterAll`, invalidates
  that run; do not suppress the error or relax an append-only, foreign-key, or
  other product constraint to obtain a pass.

## 1. Build the evidence packet on a fresh production clone

Restore a fresh backup to an isolated PostgreSQL 18 clone. Record the backup
identifier and restore completion time. The clone must have no application or
analyzer writers.

From the exact backend image or release checkout, run both pre-schema audits:

```powershell
$env:CARE_PATHWAY_AUDIT_DATABASE_URL = '<clone-owner-primary-dsn>'
npm --prefix apps/backend run lab:audit-care-pathway-spine-readiness -- --ack-read-only-primary-scan --json --sample-limit=5

$env:LAB_ORU_AUDIT_DATABASE_URL = '<clone-owner-primary-dsn>'
npm --prefix apps/backend run lab:audit-ingest-582-584-readiness -- --ack-read-only-primary-scan --json --sample-limit=5
```

Migration 580 readiness must exit `0`. Before migration 584 is applied, the combined
audit deliberately exits `2`: it is not allowed to declare the migration batch
or lab-ingest cutover ready before the exact 580-584 tail has committed. It never
authorizes care-pathway production runtime activation. The only
acceptable pre-schema state is `clone_rehearsal_input_ready: true`, with the sole
global blocker `fresh_production_clone_migration_584_proof_pending`. Every
tenant/data blocker and
`global_blockers.historical_lab_ack_contract_violations.count` must be zero.

Apply the exact pending set on the clone with the same migration runner and
migration-owner role used by production. This is the executable proof for
migration 580's post-lock/race checks and migration 583's full legacy adoption,
canonical result evidence, corrected-generation successor chain, and exact
active-unacknowledged or authoritative closed-ack task/SLA rail, plus migration
584's care-pathway governance pin. A SELECT-only preflight does not replace a
successful migration commit.

Migration 581 has no preview or dry-run mode. Its own SQL is fail closed. It may
bind provenance and record an immutable receipt only after an already-existing,
single exact v2 chain validates; it never manufactures an acknowledgement,
authorization, task/SLA closure, comment, or canonical evidence. Weak legacy
evidence must stop before schema write. No generic reconciliation receipt is
ACK evidence, and no operator update or automatic repair is allowed. Any future
exception requires a separately designed, typed, owner-approved receipt and a
reviewed migration.

After 581 exists and with no old clone writers, run the generation closeout
exactly once:

```powershell
$env:DATABASE_URL = '<clone-migration-owner-dsn>'
npm --prefix apps/backend run lab:reconcile-critical-alert-generations -- --old-replicas-drained
```

Then rerun both audits. The combined report must exit `0` with
`schema_version: 5`, `schema_mode: post_582_583`,
`critical_alert_schema_mode: post_581`, `ready: true`,
`care_pathway_governance_schema_mode: post_584`,
`migration_batch_ready: true`, `lab_ingest_cutover_ready: true`,
`care_pathway_production_activation_ready: false`, and the deprecated
fail-closed compatibility field `activation_ready: false`. Its migration-584,
ACK-receipt, ORU namespace, ORU analyte/source, and legacy-unproved counts must
all be zero. Also run the release's database migration, lab
closed-loop, corrected-generation, parser/security, schema-drift, and lint gates.
Run the combined database/lab validation suite twice consecutively against this
same migrated clone, without rebuilding or reseeding it between runs. Both runs
must pass and both must complete clean teardown. Treat any swallowed or reported
`afterAll` cleanup failure as a failed rehearsal; fix cleanup dependency order
and repeat both runs from the start. Never weaken append-only, foreign-key, or
other product constraints to make teardown pass. Retain the commands, exit
codes, reports, migration logs, and exact hashes.

## 2. Open maintenance and drain every old writer

Announce maintenance and stop inbound analyzer/interface feeds before touching
the Deployment. Confirm upstream queues retain raw messages for later replay.
Block staff/API mutations through the approved maintenance control.

Run the two read-only audits on the live primary and store the reports. The same
pre-schema semantics apply: migration 580 must be green; the 582-584 report must
have `clone_rehearsal_input_ready: true` and no tenant/data blocker. Compare its
bounded counts with the clone input report. A row listed by the historical ACK
blocker is evidence for owner review, not permission to synthesize a receipt.

The HPA will recreate at least three replicas, so remove it before scaling down:

```powershell
kubectl -n vhhealth delete hpa vhhealth-backend
kubectl -n vhhealth scale deployment vhhealth-backend --replicas=0
kubectl -n vhhealth wait --for=delete pod -l app.kubernetes.io/name=vhhealth-backend --timeout=180s
kubectl -n vhhealth get pods -l app.kubernetes.io/name=vhhealth-backend
kubectl -n vhhealth get endpointslice -l kubernetes.io/service-name=vhhealth-backend -o wide
```

The last two commands must show zero backend pods and no serving endpoint. Also
query `pg_stat_activity` with the migration-owner connection and prove that no
old backend/interface application session remains. Record the drained image
digests, pod UIDs, endpoint output, and session query. If any old writer or
analyzer feed remains, stop here.

Run both audits again against the final drained primary snapshot. No data repair
is allowed between this snapshot and the migration job. The pending list must
still be exactly one of the two approved modes above.

## 3. Apply, reconcile, and postflight while replicas remain zero

Do not allow the normal Argo sync to start the three-replica Deployment yet.
From the approved, immutable production render, create a one-off cutover Job
derived from `vhhealth-backend-migrate` with the Argo hook annotations removed,
a unique name, the exact pinned backend image digest, and the same owner DSN,
Vault injection, init gates, service account, and network policy. Its command
must run the normal migration runner and, only after it succeeds, run:

```text
npm run lab:reconcile-critical-alert-generations -- --old-replicas-drained
```

This controlled Job applies the exact ordered pending set and completes the 581
closeout before any new writer starts. Do not construct an ad hoc pod with copied
secrets or a different image. Save the rendered Job manifest and logs.

After the Job succeeds, verify `_migrations` contains the expected rows and no
release migration remains pending. Run the 580 audit and combined 582-584 audit
once more from an owner/BYPASSRLS one-off audit Job based on the same image and
network/secret posture. The combined postflight must exit `0` with
`lab_ingest_cutover_ready: true` and
`care_pathway_production_activation_ready: false`, with deprecated
`activation_ready: false`; all immutable
ACK-receipt/current-chain,
corrected-generation current-tail, generic task-ack/alert-open split, ORU
namespace, ordered-analyte, and migration-584 counts must be zero.

This cutover installs dormant care-pathway governance and execution-spine
contracts only. It does not register a production pathway handler, enable a
tenant pathway mode, or authorize active pathway execution. Production pathway
runtime activation remains a separate S1b-c release and gate.

Any failure after the first migration commits is a maintenance hold and
roll-forward incident. Keep all writers at zero, preserve logs, correct the
cause in reviewed release bytes, rehearse that exact correction on a fresh
clone, and continue forward. Never start an old backend image against the new
schema. Restoring the pre-cutover backup is a separate owner-approved disaster
recovery decision with an explicit data-loss assessment, not routine rollback.

## 4. Deploy only the new writers

Trigger a manual Argo sync of `vhhealth-apps` at the exact reviewed revision.
The `PreSync` migration hook must observe no pending migration and succeed; wave
0 may then create only the new backend image, and wave 1 may restore the HPA.
Verify the live Deployment image digest before reopening traffic:

```powershell
argocd app sync vhhealth-apps --revision '<exact-release-revision>'
argocd app wait vhhealth-apps --sync --health --timeout 600
kubectl -n vhhealth rollout status deployment/vhhealth-backend --timeout=300s
kubectl -n vhhealth get deployment vhhealth-backend -o jsonpath='{.spec.template.spec.containers[0].image}'
kubectl -n vhhealth get hpa vhhealth-backend
```

Run health, authenticated ORU, ASTM replay, critical acknowledgement, and
external-nonnumeric-order shadow-path smoke tests. Exercise the manual-result
POST with the required idempotency key and verify a same-key replay is stable;
prove that exact `VHINV` succeeds, numeric-looking and all `VHBOOK` identities
fail before durable writes, unknown external IDs remain unlinked shadow data,
ORC/OBR disagreement fails, and OBR-4/OBX-3 case or code mismatch rolls the
transaction back. Exercise a descriptive critical-result read-back longer than
40 characters and at most 160 characters, and prove both alert acknowledgement
and its immutable receipt commit without truncation. Do not reopen an unverified external client. Confirm no old
ReplicaSet pod is running and rerun the combined postflight on the live primary.
Only then reopen staff/API traffic and analyzer feeds. Replay queued analyzer messages
through the authenticated new endpoints and monitor replay conflicts, critical
task/SLA creation, shadow reconciliation volume, and database constraint errors.

## 5. Abort and rollback boundary

Before the one-off cutover Job starts, rollback is operational: keep the schema
unchanged, restore the old Deployment/HPA from the last reviewed revision, then
reopen feeds after health checks. Once any migration in the cutover Job commits,
do not restore old writers. A partial tracker state, a failed postflight, or a
mixed image set is never a degraded-success condition; it is a maintenance hold
until the reviewed roll-forward is clone-proven and complete.
