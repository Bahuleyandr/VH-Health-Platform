# C0A Immediate Safety Containment Slice Design

**Status:** coordinator-cleared implementation delta

**Clearance date:** 2026-07-28

**Implementation baseline:** `5ee03f142b0048771ed8f1939eb483008be79be4`

**Scope:** Staff client and `vhhealth_core` only. This slice has no backend,
server migration, infrastructure, Patient application, or production activation
change.

**Authority:** the C0A tranche in
[`docs/superpowers/specs/2026-07-28-clinical-service-continuity-design.md`](../superpowers/specs/2026-07-28-clinical-service-continuity-design.md),
the execution rules and C0A plan in
[`docs/superpowers/plans/2026-07-28-clinical-service-continuity.md`](../superpowers/plans/2026-07-28-clinical-service-continuity.md),
the frozen six-family census in
[`docs/continuity/c0-2-action-route-inventory.md`](c0-2-action-route-inventory.md),
and C-D3, C-D7, the attested-handoff addendum, and the partial C-D6 fallback
principal record in
[`docs/continuity/c0-4-owner-decision-dossier.md`](c0-4-owner-decision-dossier.md).

## 1. Safety outcome and boundary

C0A removes the current automatic enqueue and replay path for six
owner-quarantined clinical action families, preserves every existing affected
row as visible `needs_review`, and removes session and conflict-resolution
paths that can silently destroy unresolved clinical evidence.

This is containment, not the C4 action registry or replay state machine. It
does not make a new action offline-eligible. In particular:

- `POST /health/records` vitals capture is not contained by C0A and retains its
  current behavior when tenant, capture owner, and encryption metadata are
  trustworthy;
- `PUT /emr/notes/draft` remains a non-authoritative draft control when its
  metadata is trustworthy;
- deletion protection may cover vitals and note conflicts without changing
  whether those workflows are eligible to enqueue or drain; and
- every action not explicitly recognized by this containment table is rejected
  at new enqueue and moved to `needs_review` when found in the existing queue.

## 2. Always-on containment table

`packages/vhhealth_core/lib/services/offline_write_containment.dart` is a
small, hard-coded, always-on C0A classifier. It is deliberately separate from
the future signed C4 registry.

The classifier normalizes HTTP method case only. Paths must already be in the
existing unprefixed relative-path form. Absolute URLs, query strings,
fragments, trailing slashes, `/api/v1` prefixes, malformed identifiers, and
lookalike paths classify as `unknown`.

Classification is based only on normalized method and exact path shape. Body
fields, including `note_type`, never select a family.

| Method and path | C0A action family | Existing-row reason | New enqueue | Drain |
| --- | --- | --- | --- | --- |
| `POST /prescriptions/create` | prescription create | `contained_prescription_create` | reject | never |
| `POST /emr/orders` | drug-chart order | `contained_drug_chart_order` | reject | never |
| `POST /clinical/mar/[int]/administer-with-scan` | MAR administration | `contained_mar_administration` | reject | never |
| `POST /lab/samples/[int]/collect` | specimen collection | `contained_specimen_collection` | reject | never |
| `POST /blood-bank/[int]/verify-bedside` | transfusion verification | `contained_transfusion_verification` | reject | never |
| `POST /emr/notes` | authoritative note, all nine UI categories | `contained_authoritative_note` | reject | never |
| `POST /health/records` | vitals control | none when metadata is trustworthy | retain | retain |
| `PUT /emr/notes/draft` | note-draft control | none when metadata is trustworthy | retain | retain |
| anything else | unknown | `unknown_action` | reject | never |

The integer route segments accept canonical non-negative decimal identifiers
only. Empty, signed, decimal, encoded, extra-segment, or otherwise malformed
identifiers fail closed.

Every current surface checks the table before its offline branch, but that is
not the safety boundary. `ConnectivitySyncService.enqueue()` independently
rejects all contained and unknown actions so a new or missed screen cannot
bypass C0A.

## 3. Queue schema v5 and upgrade

The local SQLite database advances from schema v4 to v5. There is no server
migration. The existing `pending_writes` table receives exactly six nullable
columns:

| Column | SQLite type | Purpose |
| --- | --- | --- |
| `tenant_id` | `TEXT` | validated capture/database namespace |
| `encryption_version` | `INTEGER` | recognized AES-GCM envelope version |
| `review_reason_code` | `TEXT` | non-PHI typed review reason |
| `reconciliation_owner_id` | `TEXT` | capture owner or fallback role code |
| `handoff_attested_at` | `INTEGER` | immutable epoch-millisecond attestation time |
| `handoff_attested_by` | `TEXT` | immutable attesting Staff UID |

The existing `status` column represents `needs_review`. C0A does not add C4
leases, predecessors, registry IDs, command fingerprints, or additional
states.

Allowed plaintext reason codes are:

- `contained_prescription_create`;
- `contained_drug_chart_order`;
- `contained_mar_administration`;
- `contained_specimen_collection`;
- `contained_transfusion_verification`;
- `contained_authoritative_note`;
- `unknown_action`;
- `unknown_tenant`;
- `unknown_owner`;
- `unknown_encryption_version`;
- `decrypt_failed`; and
- `retry_exhausted`.

### 3.1 Upgrade transaction

Database initialization completes the migration before exposing the database
to enqueue, count, display, or drain callers.

1. Read `PRAGMA table_info(pending_writes)` and add each missing v5 column
   idempotently. The guarded adds and row migration run in one database
   transaction.
2. Inspect every row without changing its `id`, endpoint, method, body,
   creation time, retry count, context, status, conflict reason, idempotency
   key, or stored capture owner unless the specific encrypted-field migration
   below succeeds.
3. Backfill `tenant_id` only from the validated build/database namespace and
   `TenantConfig.id`. Never infer it from the current login.
4. Retain `staff_id` as the capture owner. Never attribute a null legacy owner
   to the currently signed-in user.
5. Assign `reconciliation_owner_id = staff_id` when the capture owner is
   known. When it is unknown, assign the tenant-configured stable fallback role
   code `role:clinical_safety_lead`.
6. Verify the stored AES-GCM envelope by authenticated decrypt before assigning
   `encryption_version = 1`. Missing keys, corrupt ciphertext, and future or
   unrecognized formats remain byte-preserved with a null version and
   `needs_review`.
7. A valid legacy plaintext body may be encrypted only after decrypting the
   produced envelope and proving exact round-trip equality. Failure leaves the
   original bytes intact and moves the row to `needs_review`.
8. Encrypt `context_label` and `conflict_reason`, which may contain PHI, using
   the same verified v1 envelope. Typed reason codes remain plaintext. Each
   field is replaced only after exact round-trip proof; otherwise its original
   bytes are retained and the row requires review.
9. Move contained pending or conflict rows to `needs_review`, retaining the
   original encrypted conflict reason. Move unknown actions to
   `needs_review/unknown_action`.
10. Move rows with `retry_count >= 6` to
    `needs_review/retry_exhausted`.
11. Known control rows remain pending or conflict only when tenant, owner, and
    encryption version are trustworthy. Missing tenant, owner, or recognized
    encryption moves them to `needs_review` with the corresponding typed
    reason. Authenticated decrypt failure uses `decrypt_failed`.

The upgrade never deletes or rebuilds the table, never changes row identity or
ordering, and never runs `VACUUM`.

### 3.2 Post-v5 decoding

The drain accepts only a recognized `encryption_version` and authenticated
AES-GCM decoding. The current catch-all
decrypt-failure-to-plaintext behavior is migration-only. A post-v5 decrypt
failure moves the row to `needs_review/decrypt_failed` without an HTTP
request, and the stored bytes remain intact.

`OfflineWriteEntry` in
`packages/vhhealth_core/lib/models/offline_write_entry.dart` is the typed
read/display model for v5 rows and computed UI state. It does not expand the
durable C0A schema.

## 4. Reconciliation owner and attested handoff

Known capture owners reconcile their own rows, so
`reconciliation_owner_id = staff_id`.

Unknown capture owners use `role:clinical_safety_lead`, supplied through
`apps/staff/lib/core/config/c0a_reconciliation_config.dart`. The contract is
tenant-specific and has no production default. Staff startup registers the
resolver before any queue initialization. The UI displays a localized
clinical-safety-lead role label and never persists a staff name. This stable
role code is not a backend RBAC role.

A current owner may record one attested handoff on a `needs_review` row:

> reviewed — transferred to paper / handed to the reconciliation owner

The service performs a fresh owner, tenant, status, classification, and
existing-attestation check. It atomically stores the actor Staff UID and
timestamp only when both attestation columns are null. Attestation is
immutable. It does not resolve, delete, retry, or make a row drainable.

## 5. Logout, revocation, and credential preservation

### 5.1 Session barrier

The service has an explicit session barrier that stops new enqueue and drain
while logout or revocation is evaluating and clearing identity. Ordinary
logout rechecks blocking rows at the service layer after the barrier is
closed, preventing a race-time enqueue from escaping the decision.

For the current capture owner:

- every pending row blocks ordinary logout;
- every conflict row blocks ordinary logout;
- an unattested `needs_review` row blocks ordinary logout; and
- an attested `needs_review` row no longer blocks but stays encrypted,
  owner-bound, visible, undeletable, and undrainable.

Blocked copy:

> **Sign out blocked — offline clinical work needs review**
>
> You have {count} unresolved offline clinical item(s). To prevent loss or
> recording under the wrong staff account, you cannot sign out yet. Open Sync
> status and follow the reconciliation handoff.

Actions are **Stay signed in** and **Review offline work**.

With zero blocking rows, ordinary logout makes a best-effort backend logout
request and clears session identity only. Other-owner and unknown-owner rows,
the queue database, the queue AES key, and device credentials survive.

### 5.2 Forced revocation and idle timeout

Forced/server revocation bypasses the ordinary blocker. It captures the
current-owner unresolved count, clears session identity only, navigates to
login, and reports:

> {count} unresolved offline clinical item(s) remain encrypted on this device
> for later reconciliation.

The queue database and AES key survive a process reset/reopen and remain
decryptable by the correct later reconciliation flow.

`apps/staff/lib/core/providers/session_timeout_provider.dart` remains
byte-identical to blob `8cf929dc0f94ad9c3d418eb1b5ae413e7e6b1e3f`.
Its existing facade now receives a count of all current-owner unresolved states
from the service. The preserved-count copy is:

> {count} unresolved offline item(s) for this user are preserved on this
> device. Sign in as the same staff member to review them; review-required
> items will not send automatically.

The destructive chain
`AuthService.logout -> clearQueue -> OfflineQueue.clearAll ->
ApiConfig.clearAll/deleteAll` is removed. The two production `deleteAll()`
callers in Staff `ApiConfig` and core `AuthService` become explicit
session-key deletion. No public device-wide unfiltered queue delete remains.

## 6. Safely scoped drain

The drain partition is:

`(tenant_id, captured staff_id, normalized action family)`.

Rows are inspected in global `created_at ASC, id ASC` order. A persisted
conflict, `needs_review`, or exhausted row blocks later pending rows only in
its partition. A transient failure blocks the same partition for that pass.
Other trustworthy partitions continue. A later pending row in a blocked
partition remains durable and its displayed `skipped` state is computed, not
persisted.

Restart reconstructs partition blockers from the persisted rows; no
in-memory-only dependency state is trusted.

Additional hard stops:

- retry `5 -> 6` atomically moves the row to
  `needs_review/retry_exhausted`;
- a preloaded retry count of six sends no HTTP;
- contained actions send no HTTP;
- unknown tenant, capture owner, encryption version, key, action, or method
  sends no HTTP;
- a persistent `401` or changed current owner stops the entire drain pass
  without consuming a clinical retry; and
- trustworthy vitals and note-draft partitions drain independently.

The Sync status sheet lists every unresolved current-owner row with family,
decrypted context when available, capture time, status, typed reason, computed
blocker/skipped state, retry count, capture owner, and reconciliation owner.
Review-required, exhausted, and skipped rows have no Retry or Discard control.

## 7. Deletion protection

Conflict deletion protection is intentionally wider than the six-family
containment table. Confirmation is required for:

- the six contained action families;
- vitals `POST /health/records`; and
- every mutating `/emr/notes` route, including drafts.

The service rechecks owner, tenant, status, and classification immediately
before deletion. Widget confirmation alone never authorizes deletion.
`needs_review`, exhausted, skipped, other-owner, unknown-owner, and
unknown-action rows cannot be deleted through the conflict flow.

Clinical framing:

- MAR: “Administration not recorded on the server — review needed. The
  medication may have been given offline.”
- Notes: “Note data on this device is not reconciled with the server. Review
  before discarding.”
- Vitals: “Vitals not recorded on the server — review needed. Review the
  patient chart before discarding.”
- confirm action: “Discard after reconciliation”.

The deliberate current-owner `removePendingMatching()` scratchpad-draft path
is unchanged.

## 8. Blocked-action paper fallback

Each contained offline surface returns before enqueue, success state, form
reset, draft clearing, or completion/pending-sync state.

Common copy:

> This action was not saved for automatic sync. Use the department's {paper
> form set} and follow the downtime reconciliation procedure. Keep the entered
> information open until it has been transferred to paper.

The form-set mapping is fixed by the Packet-4 record:

| Family | Paper form set |
| --- | --- |
| prescription create | OPD prescription pads |
| drug-chart order | inpatient drug charts |
| MAR administration | MAR sheets |
| specimen collection | laboratory requisition forms |
| transfusion verification | blood-bank verification slips |
| authoritative note | nursing note forms |

Prescription and drug-chart screens retain entered data. MAR, specimen, and
transfusion screens never enter completed or pending-sync state. Nursing notes
retain the form and its existing autosave.

## 9. Exact file ledger

### Add

- `docs/continuity/c0a-containment-slice-design.md`
- `packages/vhhealth_core/lib/models/offline_write_entry.dart`
- `packages/vhhealth_core/lib/services/offline_write_containment.dart`
- `apps/staff/lib/core/config/c0a_reconciliation_config.dart`
- `apps/staff/lib/core/widgets/offline_clinical_fallback_dialog.dart`
- `apps/staff/lib/core/widgets/logout_flow.dart`
- `packages/vhhealth_core/test/helpers/offline_queue_test_harness.dart`
- focused core and Staff test files required by section 10

### Modify — `vhhealth_core`

- `packages/vhhealth_core/lib/services/offline_queue.dart`
- `packages/vhhealth_core/lib/services/connectivity_sync_service.dart`
- `packages/vhhealth_core/lib/services/auth_service.dart`
- `packages/vhhealth_core/lib/widgets/offline_sync_badge.dart`
- `packages/vhhealth_core/lib/vhhealth_core.dart`

### Modify — Staff integration and UI

- `apps/staff/lib/main.dart`
- `apps/staff/lib/core/config/api_config.dart`
- `apps/staff/lib/core/services/auth_service.dart`
- `apps/staff/lib/core/widgets/offline_sync_badge.dart`
- `apps/staff/lib/core/widgets/logout_action.dart`
- `apps/staff/lib/core/widgets/session_revocation_listener.dart`
- `apps/staff/lib/features/settings/screens/settings_screen.dart`
- `apps/staff/lib/features/auth/services/login_service.dart`
- `apps/staff/lib/l10n/app_strings.dart`

### Modify — six contained surfaces

- `apps/staff/lib/features/doctor/prescription_offline_rx.dart`
- `apps/staff/lib/features/doctor/screens/prescriptions_screen.dart`
- `apps/staff/lib/features/ipd/drug_chart_offline_order.dart`
- `apps/staff/lib/features/ipd/screens/drug_chart_screen.dart`
- `apps/staff/lib/features/nursing/mar_offline_administer.dart`
- `apps/staff/lib/features/nursing/screens/mar_scan_screen.dart`
- `apps/staff/lib/features/investigations/screens/specimen_scan_screen.dart`
- `apps/staff/lib/features/bloodbank/screens/transfusion_scan_screen.dart`
- `apps/staff/lib/features/nursing/screens/nursing_notes_screen.dart`

### Static non-edits

These files must remain byte-identical to the implementation baseline:

- `apps/staff/lib/core/providers/session_timeout_provider.dart`
  (`8cf929dc0f94ad9c3d418eb1b5ae413e7e6b1e3f`);
- `apps/staff/lib/features/nursing/screens/vitals_screen.dart`
  (`9ff1a434ef98c1b63c9d6fa389215814e3e92bac`); and
- `apps/staff/lib/features/emr/note_draft_autosave.dart`
  (`4c7e166c00949450ff1d798f3d94baaba2279989`).

No file under `apps/patient`, `apps/backend`, server migrations, or `infra` is
part of this slice.

## 10. Gate test matrix

### Containment and capture

- exact classifier positives for all six families;
- all nine authoritative note categories classify by the same route;
- wrong methods, absolute URLs, query/fragment/trailing-slash variants,
  `/api/v1` prefixes, malformed IDs, extra segments, and lookalikes are
  unknown;
- vitals and note-draft controls classify distinctly;
- unknown defaults to deny;
- the generic enqueue barrier rejects contained and unknown actions;
- each of the six Staff surfaces performs zero affected enqueue calls, shows
  the exact paper fallback copy/form set, and preserves its form and
  non-success state as specified.

### v5 upgrade and encrypted preservation

- shared harness creates isolated v1 and v4 fixture databases;
- upgrade preserves row count and fixed IDs, endpoints, methods, times,
  retries, keys, owners, bodies, contexts, statuses, and conflict reasons
  semantically;
- guarded column adds are idempotent;
- plaintext conversion occurs only after exact encrypted round-trip proof;
- body, context, and conflict-reason PHI are encrypted after a successful
  migration;
- contained pending/conflict rows become typed `needs_review`;
- known-metadata vitals/drafts retain behavior;
- unknown tenant, owner, encryption version, missing key, corrupt ciphertext,
  and future format rows send zero HTTP and retain their original bytes;
- upgrade and app restart lose no row.

### Drain and retry

- a mock `200` transport still receives zero contained-family requests;
- retry `5 -> 6` immediately becomes
  `needs_review/retry_exhausted`;
- a preloaded retry-six row sends no HTTP;
- a conflict/review/exhausted row blocks only its tenant-owner-family
  partition;
- transient failure skips later same-partition rows for that pass while other
  partitions continue;
- skipped is recomputed after reset/reopen and same-owner reauthentication;
- persistent `401` and owner change stop the whole pass without retry
  consumption;
- trustworthy vitals and note drafts continue independently.

### Logout, revocation, and attestation

- ordinary logout is blocked on current-owner pending, conflict, and
  unattested `needs_review` rows before any backend logout request;
- the closed session barrier catches a race-time enqueue;
- unattested row blocks, attestation succeeds after confirmation, and logout
  is then permitted when no other blocker remains;
- attestation actor/time are immutable;
- attested rows remain visible and refuse drain, retry, discard, and removal;
- forced revocation clears session identity while raw rows and AES key survive
  reset/reopen and correct decryption;
- zero-blocker logout preserves other-owner/unknown-owner rows and the AES key;
- idle-timeout implementation remains byte-identical;
- preserved-count UX counts every current-owner unresolved state and uses the
  approved copy.

### Deletion and per-row UI

- confirm-guard predicates cover the six families, vitals, and every mutating
  note route including drafts;
- cancel performs zero delete callbacks and confirm performs exactly one for a
  service-authorized conflict;
- clinical MAR, note, and vitals copy and the confirm label are exact;
- review/exhausted/skipped/other-owner/unknown rows expose no retry/discard;
- current-owner scratchpad-draft `removePendingMatching()` behavior is
  unchanged;
- the sync sheet shows every required per-row field and uses non-color
  semantics.

### Unchanged controls and localization

- vitals enqueue/drain behavior is unchanged for trustworthy metadata;
- note-draft autosave, drain, and deliberate pending-draft removal are
  unchanged for trustworthy metadata;
- Staff English, Hindi, Tamil, Telugu, and Malayalam key parity passes;
- localization health and accessibility/non-color state guards pass.

The shared fixture lives at
`packages/vhhealth_core/test/helpers/offline_queue_test_harness.dart` and
teardown deletes only its unique test database.

## 11. Validation

The slice runs, from the repository root:

1. `dart pub get`;
2. `dart run melos bootstrap`;
3. `dart run melos run format-fix`;
4. `dart run melos run format`;
5. `dart run melos run codegen`;
6. `dart run melos run analyze`;
7. `dart run melos run test`;
8. `dart run melos run i18n-health-staff`;
9. `git diff --check`;
10. `git diff --exit-code 5ee03f142b0048771ed8f1939eb483008be79be4 --`
    for the three non-edit files; and
11. a static wipe audit:

    ```text
    rg -n "OfflineQueue\.clearAll\(|clearQueue\(|await db\.delete\('pending_writes'\);|\.deleteAll\(\)" packages/vhhealth_core/lib apps/staff/lib
    ```

The final static audit may find explicitly scoped secure-storage key deletes,
but it must find no device-wide queue delete, queue `VACUUM`, `clearQueue`,
`OfflineQueue.clearAll`, or production `deleteAll()` path.

## 12. Rollback

Rollback is a forward safety floor, not a return to schema v4:

- keep schema v5 and every migrated or newly created `needs_review` row;
- keep strict version/owner/tenant/action/decryption drain checks;
- keep contained and unknown enqueue/drain barriers;
- keep logout, revocation, AES-key, and row preservation;
- keep deletion protections and immutable attestation;
- never down-migrate, rebuild, delete, `VACUUM`, reinstall v4, or convert
  `needs_review` back to pending;
- never restore generic physical/final replay or discard; and
- if drain behavior is suspect, ship a forward patch disabling drain while
  preserving every row.

Presentation-only UI changes may be rolled back above this floor when they do
not obscure retained evidence or remove access to the required handoff.
