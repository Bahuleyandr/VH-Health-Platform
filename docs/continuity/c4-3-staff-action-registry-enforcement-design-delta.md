# C4.3 Staff action-registry enforcement — design delta

**Status:** Step 1 design-only; awaiting coordinator clearance
**Authority:** implementation plan §1 and §7 C4.3, design §5.4 and §5.6,
[C0.2 action census](./c0-2-action-route-inventory.md#6-proposed-default-deny-registry),
[C0A queue contract](./c4-1-queue-envelope-design-delta.md),
[C4.2 signed registry contract](./c4-2-action-registry-design-delta.md), and
countersigned owner decisions C-D3, C-D4, C-D7, and C-D14 in the
[owner dossier](./c0-4-owner-decision-dossier.md)
**Base re-derived at kickoff:** `1d602c0acef815b0e533f86b6ef304b8447a80e5`
(`github/main`, 2026-07-31 13:16:32 +05:30)
**Lane:** `feat/continuity-c4-3-staff-enforcement`
**Ledger overlap:** zero with backend lanes AF, C5.1, C5.2, and C6.1-B
**Activation:** none

## 1. Decision and boundary

C4.3 replaces every Staff clinical-continuity enqueue decision with one
default-deny action gateway. The gateway consumes the exact C4.2 policy-schema
v3 document only after it has passed the existing C3.3 trust chain. It checks
the same verified decision before showing a capture affordance, immediately
before inserting a queued row, and immediately before leasing or sending that
row.

Only these two C4.2 executable action bindings can reach an electronic replay
transport:

| Action ID | Staff semantic attachment | Transport ceiling |
|---|---|---|
| `emr.nursing_note.draft.store` | Nursing-assessment private draft storage | `PUT /api/v1/emr/notes/draft` |
| `emr.op_note.draft.store` | OP-consultation private draft storage | `PUT /api/v1/emr/notes/draft` |

That table is a compiled client ceiling, not authority. An action is available
only when a currently verified signed v3 policy also places the exact facility,
device posture, role, app version, and action in `enforce`. C4.3 does not
publish, approve, or activate such a policy. The presently inert rollout
therefore remains inert after this client work.

Prescription and inpatient drug-chart drafts use a separate encrypted
`local_draft_only` store. They never enter the queue and never auto-submit.
MAR administration, specimen collection, transfusion verification, vitals,
generic nursing-note capture, final/sign/lock actions, security mutations, and
unknown actions have no electronic offline path.

Ordinary authenticated online workflows remain ordinary online workflows.
C4.3 adds explicit offline state and a press-time guard to high-risk online
actions, but does not route those actions through continuity capture.

## 2. Isolation and current-state evidence

The lane was created from a fresh fetch of `github/main`. The requested branch
did not exist locally or on either configured remote before creation. The
worktree was clean at the pinned base.

This Step 1 changes only this document. It has no overlap with backend lanes:

- AF owns backend authorization work;
- C5.1 owns backend replay receipt and command-effect atomicity;
- C5.2 owns backend conflict and reconciliation behavior; and
- C6.1-B owns provisioning and device-bound enrollment.

C4.3 owns only `packages/vhhealth_core`, `apps/staff`, and this design record.
It does not edit backend, Prisma, migrations, deployment, provisioning,
receipt, or activation files.

## 3. Re-derived producer census

Repository-wide searches of production Dart under `apps/staff/lib` and
`packages/vhhealth_core/lib` found only two Staff expressions that call an
enqueue API:

| Current expression | Semantic producers | Present behavior | C4.3 disposition |
|---|---|---|---|
| `ConnectivitySyncService.instance.enqueue(...)` in `vitals_screen.dart` | Vitals capture | Calls the deprecated endpoint facade and creates a legacy C0A row | Remove. Vitals uses the governed paper/back-entry path while offline. |
| `_sync.enqueue(...)` in `note_draft_autosave.dart` | Nursing-assessment draft and OP-consultation draft | One generic endpoint expression classifies the body at runtime and creates a legacy C0A row | Replace with two explicit typed gateway attachments and the exact registered draft-store action ID. |

`ConnectivitySyncService.enqueue` is the only production core call to
`OfflineQueue.enqueue`. No production Staff feature calls
`prepareCapture`, `persistPreparedCommand`, or the prepared HTTP mutation path.
There are therefore three semantic capture attachments today: one vitals
attachment and two note-draft attachment contexts. The conformance gate in
section 13 freezes that complete census and fails on an unregistered future
attachment.

The old endpoint facade can infer only vitals, nursing draft, OP draft, or
`unknown`. It has no trustworthy way to prove a semantic call site. C4.3
removes it from production instead of extending its inference.

## 4. Closed client action inventory

The compiled client vocabulary remains the 17 C-D3 IDs plus `unknown`. C4.3
does not add, rename, or reinterpret an ID.

| Action IDs | C4.3 client disposition |
|---|---|
| `emr.nursing_note.draft.store`, `emr.op_note.draft.store` | Potentially queueable private storage, but only after exact signed v3 `enforce` evaluation. Storage receipts never prove clinical finalization. |
| `op.prescription.draft`, `ip.drug_chart.draft` | Potentially `local_draft_only`; encrypted device-local storage, no queue and no transport. |
| `mar.administration.backfill`, `lab.specimen_collection.backfill`, `blood.transfusion_verification.backfill` | `paper_only_backfill`; no queue, no transport, no policy/config-only enablement. |
| `emr.nursing_note.observation.capture`, `emr.nursing_note.medication_note.capture`, `emr.nursing_note.post_procedure.capture`, `emr.nursing_note.intake_output.capture`, `emr.nursing_note.patient_complaint.capture`, `emr.nursing_note.wound_care.capture`, `emr.nursing_note.shift_handover.capture`, `emr.nursing_note.emergency.capture`, `emr.nursing_note.other.capture` | Default deny. No binding to generic note creation. |
| `vitals.capture` | Default deny. No binding to the current authoritative health-record route. |
| `unknown` | Fail closed before display, local persistence, enqueue, lease, or send. |

The static transport adapter continues to return a route for exactly the two
draft-store IDs and `null` for every other ID. That adapter is a necessary
negative control, not a permission source. A valid transport without a valid
signed action decision still fails closed.

## 5. One verified authority path

C4.3 does not create a second signature or trust implementation. It extends
the existing C3.3 components:

1. `ClinicalContinuityTrustStore` retains the already validated policy-signing
   key in the returned trust bundle.
2. `ClinicalContinuityVerifier` gains an action-policy verification entry
   point that shares its strict JSON parsing, RFC 8785 JCS canonicalization,
   SHA-256, Ed25519, audience, clock, key-state, revocation, supersession, and
   anti-rollback primitives.
3. `ClinicalContinuityCache` stores a verified v3 action-policy receipt and
   advances the existing tenant/facility floors and secure witness. There is no
   parallel floor, trusted clock, key registry, or witness.
4. `StaffActionPolicySource` is an injected byte-source boundary for one exact
   signed C4.2 policy envelope plus authenticated provenance. The production
   implementation in this lane is deliberately unavailable because no
   approved Staff delivery adapter exists.
5. The existing Staff `GET /encounters/downtime-policy` getter returns an
   unsigned parsed legacy advisory, with none of the signed-envelope authority
   required by C3.1/C4.2. C4.3 never fetches, verifies, caches, or evaluates it.
   Its unused `ClinicalDowntimePolicy` getter/model are retired to prevent
   accidental elevation.
6. A later signed-policy delivery adapter requires its own approved source
   contract and lane. It must supply exact bytes; it may not supply a parsed or
   pre-verified object. Adding that adapter is not a C4.3 activation.
7. A Staff repository publishes only an immutable verified decision snapshot
   or a typed unavailable state. UI code never receives an unsigned policy
   object.

The verifier requires:

- strict policy-schema v3;
- an exact tenant and facility audience;
- a validated policy key from the device trust bundle;
- valid issue, effective, and finite expiry times under the shared trusted
  clock;
- monotonic policy, registry, revocation, and trusted-time floors;
- exact registry and action checksums;
- non-revoked and non-superseded authority;
- exact `activation.mode = enforce`;
- the action ID in the exact `enforcedActionIds` set;
- exact allowed role and capability membership;
- an allowed device posture;
- a valid per-posture minimum Staff version; and
- a trustworthy Staff capture context, including tenant, facility, device,
  actor, role, app version, and durable capture session.

Missing, malformed, expired, shadow, stale, rolled-back, wrong-audience,
unsupported, or unknown authority yields `unavailable`. Cached last-known-good
authority is usable only while its signed validity window and shared trust
floors still pass. No network failure extends expiry.

Because the production source is unavailable, this lane cannot authorize
capture even if a backend operator publishes an enforcing v3 policy. That
closed condition is intentional: signed policy delivery must exist and pass
its own review before it can be wired into Staff.

The current Staff capture-context resolver deliberately returns
`facility_context_unavailable` because C6.1-B provisioning has not supplied
trustworthy production facility identity. C4.3 preserves that fail-closed
state. It neither derives facility from mutable UI state nor invents a
fallback.

## 6. Default deny at display, persistence, and drain

### 6.1 Display

The gateway exposes a synchronous decision for each typed semantic call site.
Initial state is unavailable, so an asynchronous policy refresh cannot flash
an enabled capture control.

For the two draft-store actions, the offline-capture affordance is hidden when
authority is unavailable or mismatched. Normal online draft behavior may
remain visible, but cannot silently fall into a queue.

For high-risk online actions, the control remains visible so the user can
understand the workflow, but it is disabled while offline and carries explicit
copy such as:

> Reconnect to continue. This action cannot be completed offline.

Paper-only clinical surfaces retain their already governed paper instruction.
They do not display an electronic “save for later” control.

### 6.2 Local persistence and enqueue

The gateway accepts a closed `StaffCaptureCallSite` value and typed clinical
identity input. The enum member maps internally to one exact action ID; feature
code cannot supply an action ID, method, URL, endpoint, or replay binding.

Immediately before persistence it re-evaluates the latest verified snapshot,
capture context, role, device posture, minimum version, and exact action
contract. An unrecognized call site or changed policy rejects before any
SQLite insert. The gateway prepares the C4.1 envelope and calls the internal
prepared-command persistence path only for the two draft-store actions.

`ConnectivitySyncService.enqueue` and production use of
`OfflineQueue.enqueue` are removed. The legacy queue fixture helper may remain
test-only to prove migration behavior. `OfflineQueue.persistPreparedCommand`
is core-internal and is not a Staff feature API.

### 6.3 Lease and drain

Before a v6 envelope-ready row is leased or sent, the drain resolves its
pinned action decision against current verified authority and the C4.2
compatibility rules.

- A transiently unavailable current policy pauses drain without changing the
  row bytes or attempt count.
- A now-revoked, incompatible, unknown, unbound, wrong-audience, or
  non-queueable action moves to typed `needs_review`.
- A row classified as `local_draft_only`, `paper_only_backfill`,
  `blocked_electronic`, or default deny can never be sent.
- An action with no static client transport can never be sent.
- A current signed policy cannot widen the action captured under an older
  policy unless the exact C4.2 compatibility record accepts every pinned
  authority claim.

The decision occurs before lease acquisition so a denied row never appears
in-flight. A connectivity change between the decision and transport is handled
by the existing retry state machine; it does not bypass a future policy
decision.

## 7. Local-draft-only contract

Prescription and inpatient drug-chart drafts are not queue commands. C4.3 adds
an encrypted device-local draft store outside `OfflineQueue`.

Each record binds:

- schema version and local draft ID;
- exact action ID;
- tenant, facility, device, actor, and role;
- patient plus encounter, appointment, or admission identity as applicable;
- workflow-specific draft payload;
- created and last-updated times; and
- `requiresOnlineReview = true`.

The record deliberately has no endpoint, method, replay binding, client event
ID, idempotency key, queue state, automatic drain hook, or server receipt.
Local persistence requires the same verified exact v3 `local_draft_only`
decision and trustworthy facility context. C4.3 does not enable it merely
because the client contains the storage code.

The offline acknowledgement is explicit:

> Saved on this device only — not sent to the EMR. Reconnect and reopen for
> review.

Reconnection does not submit. The user must explicitly reopen the editor,
reauthenticate under the current online session, and invoke the ordinary
online workflow. Prescription clinical-decision support, medication safety,
authorization, concurrency, and all other existing online checks run again.
The device-local draft is deleted only after confirmed server success.

Investigation and referral drafts are not implemented because the frozen C-D3
vocabulary contains no approved IDs for them. C4.3 does not invent IDs or map
them to prescription or drug-chart drafts.

## 8. Proactive offline blocks

The following currently reachable Staff mutations remain online-only and gain
both a display-time connectivity state and a press-time/service-boundary
guard:

- prescription create and sign;
- inpatient drug-chart/order submission;
- MAR administration, including override-bearing paths;
- specimen collection and investigation-result upload;
- transfusion bedside verification;
- nursing-note, OP-note, radiology-result, and other clinical sign/finalize
  actions;
- encounter completion plus any future encounter sign or lock attachment;
- discharge summary sign, discharge initiation, and discharge completion;
- critical-inbox acknowledgement, review submission, cross-sign, transfer
  acceptance, and post-discharge cross-sign; and
- password, PIN, biometric, registered-device, Staff role, temporary-password,
  and equivalent security mutations.

The `signEncounter` and `lockEncounter` service methods have no production
caller at this base. They are recorded as dormant, not omitted: a future UI
attachment must first enter the conformance inventory and adopt the online-only
guard.

The reusable guard is presentation plus defense in depth. Existing server
authorization remains authoritative. The guard does not claim that a local
connectivity signal proves server reachability, and it does not convert a
backend failure into offline capture.

## 9. Critical-inbox error UX

The current inbox can render an error banner and then an empty-success state
when refresh fails with no tasks. C4.3 makes the states mutually exclusive:

| Provider state | Required UI |
|---|---|
| No tasks and no error | Empty-success state |
| No tasks and error | Terminal error state with retry; no empty-success copy |
| Cached tasks and error | Stale/error banner plus the retained task list |
| Offline | Mutation buttons visibly disabled with online-required copy |

Every critical-inbox mutation also performs a fresh press-time connectivity
check. The same rule covers actions currently guarded only after a sheet has
opened. No inbox acknowledgement, diagnostic review, cross-sign, or transfer
acceptance is queued.

## 10. Staff version floor

Live repository history yields this Staff public-version sequence:

| Version | First repository revision |
|---|---|
| `1.0.0+1` | `af787adb70a73e0663534bcff7732fde5520f8dc` |
| `1.0.1+2` | `f1982421c3d63c00aaecb78f828ef1ce1f8094f3` |
| `1.1.0+3` | `d37fac742f3e8840b80e6478d26e1665f30ed696` |

The current app is still `1.1.0+3`. All later C0A, C3, and C4 revisions share
that public version, so `1.1.0` cannot distinguish an enforcing client from
older clients. No `staff-v*` local tag, remote tag, or GitHub release was found.

Step 2 therefore bumps Staff to `1.2.0+4`. The signed minimum safe version for
an enforcing Android or Windows posture must be at least `1.2.0`. The security
comparison uses the semantic version, not the build suffix: the current shared
version comparator strips `+build`, so a build-only floor would be unsafe.

The existing global `VersionGate` remains a service-availability convenience
and currently fails open on an unreachable or malformed endpoint. It is not
continuity authority. The action gateway independently fails closed on a
missing, malformed, or unmet signed per-posture minimum.

An older client row is never silently replayed merely because the installed
binary is now new enough. Section 11 governs those rows.

## 11. Legacy C0A facade retirement and row UX

On the first C4.3 queue open, every unresolved row with
`envelope_ready = 0` is idempotently moved to `needs_review` with reason
`legacy_client_row_requires_reconciliation` and a state event. The migration
preserves ciphertext, identity, timestamps, attempts, and evidence. It does
not need a schema bump because v6 already has the required state and reason
fields.

The drain no longer executes method and endpoint data from a legacy row.
Retry is disabled for these rows.

The badge/status sheet presents:

> Created by an older Staff app — not sent. Review against the server or paper
> record.

Rows show only a safe action label, capture time, and review state. They do not
expose endpoint strings, identifiers, or decrypted protected health
information in list metadata.

A decryptable nursing or OP private-draft row may offer “Open for online
review”. That action hydrates an editor but does not submit, delete, or mark
the row reconciled. Vitals, physical-action, unknown, and undecryptable rows
remain preserved for the existing attested C0A/C-D7 handoff and reconciliation
path. There is no one-tap discard.

`OfflineWriteContainment` remains as legacy migration and reconciliation
classification evidence. It no longer authorizes a new enqueue or drain.

## 12. Physical-action replay cannot be configuration-enabled

MAR, specimen, and transfusion screens retain their paper fallback. Their
three action IDs have:

- no executable entry in the static client transport table;
- no gateway attachment allowed to persist a prepared command;
- no misleading `enqueue` boolean or executable endpoint field in the
  specimen/transfusion intent objects;
- an exact conformance assertion that transport resolution is `null`;
- a source scan proving the screens do not call the gateway; and
- a runtime drain rule that sends only the two registered private-draft IDs.

Changing a flag or publishing a wider policy cannot overcome those compiled
controls. Any future electronic backfill requires a new reviewed code change,
an updated frozen inventory and conformance manifest, its own backend binding
and reconciliation contract, named owner approval, and new platform receipts.
C4.3 supplies none of those.

## 13. Exact conformance gate

Step 2 adds
`apps/staff/test/clinical_continuity_action_registry_conformance_test.dart`.
The test is executable architecture enforcement, not a prose or snapshot-only
check.

It proves all of the following:

1. The inventory ID set is exactly equal to `OfflineActionIds.values`,
   including `unknown`; no missing or unexpected ID is accepted.
2. Every `StaffCaptureCallSite` occurs exactly once in a closed source
   attachment manifest and maps to exactly one expected action ID.
3. The only production gateway attachments that can persist queue commands are
   nursing-assessment private-draft storage and OP-consultation private-draft
   storage.
4. Each closed call-site enum member resolves internally to its exact
   registered action ID; no feature caller can select or override the ID.
5. `OfflineActionIds.clientTransportFor` resolves exactly those two action IDs
   and returns `null` for all 15 other stable IDs plus `unknown`.
6. `local_draft_only`, `paper_only_backfill`, blocked, and unknown entries have
   no queue attachment.
7. A deterministic scan of every Dart file under `apps/staff/lib` rejects
   production calls to `ConnectivitySyncService.enqueue`,
   `OfflineQueue.enqueue`, `OfflineQueue.persistPreparedCommand`, and direct
   prepared HTTP mutation sending.
8. The same scan rejects a newly added gateway attachment that is absent from
   the closed call-site manifest. Reusing an existing action ID at a new source
   location therefore still fails.
9. The MAR, specimen, and transfusion screens contain no gateway attachment
   and their action IDs have no transport.
10. The online-only mutation inventory includes each live high-risk attachment
    from section 8 and each dormant service method that could become reachable.

The manifest stores repository-relative file and stable semantic-symbol
identity rather than historical line numbers. A refactor must update the
manifest and receive review; moving a call cannot silently evade the gate.

Focused unit tests additionally cover every policy rejection reason,
display/enqueue time-of-check changes, drain pause versus review behavior,
legacy-row quarantine, local-draft encryption and explicit reopening, critical
inbox state exclusivity, and per-posture version-floor behavior.

## 14. Exact Step 2 file ledger

This is the clearance ceiling. Step 2 may touch only the files below unless a
new design delta is approved.

### 14.1 Add — core

- `packages/vhhealth_core/lib/models/clinical_continuity_action_policy.dart`
- `packages/vhhealth_core/lib/services/clinical_continuity_action_gate.dart`
- `packages/vhhealth_core/lib/services/clinical_local_draft_store.dart`
- `packages/vhhealth_core/test/clinical_continuity_action_policy_test.dart`
- `packages/vhhealth_core/test/clinical_continuity_action_gate_test.dart`
- `packages/vhhealth_core/test/clinical_local_draft_store_test.dart`

### 14.2 Modify — core

- `packages/vhhealth_core/lib/services/clinical_continuity_trust_store.dart`
- `packages/vhhealth_core/lib/services/clinical_continuity_verifier.dart`
- `packages/vhhealth_core/lib/services/clinical_continuity_cache.dart`
- `packages/vhhealth_core/lib/services/offline_action_ids.dart`
- `packages/vhhealth_core/lib/services/connectivity_sync_service.dart`
- `packages/vhhealth_core/lib/services/offline_queue.dart`
- `packages/vhhealth_core/lib/services/offline_write_containment.dart`
- `packages/vhhealth_core/lib/widgets/offline_sync_badge.dart`
- `packages/vhhealth_core/lib/vhhealth_core.dart`
- `packages/vhhealth_core/test/clinical_continuity_verifier_test.dart`
- `packages/vhhealth_core/test/clinical_continuity_cache_test.dart`
- `packages/vhhealth_core/test/connectivity_sync_c0a_test.dart`
- `packages/vhhealth_core/test/connectivity_sync_pre_attempt_test.dart`
- `packages/vhhealth_core/test/connectivity_sync_state_machine_test.dart`
- `packages/vhhealth_core/test/offline_queue_c0a_safety_test.dart`
- `packages/vhhealth_core/test/offline_queue_v6_migration_test.dart`
- `packages/vhhealth_core/test/offline_write_containment_test.dart`
- `packages/vhhealth_core/test/helpers/offline_queue_test_harness.dart`

### 14.3 Add — Staff

- `apps/staff/lib/core/services/staff_action_policy_source.dart`
- `apps/staff/lib/core/services/staff_action_policy_repository.dart`
- `apps/staff/lib/core/services/staff_clinical_action_gateway.dart`
- `apps/staff/lib/core/widgets/online_only_action_state.dart`
- `apps/staff/test/clinical_continuity_action_registry_conformance_test.dart`
- `apps/staff/test/core/services/staff_action_policy_repository_test.dart`
- `apps/staff/test/core/services/staff_clinical_action_gateway_test.dart`
- `apps/staff/test/core/widgets/online_only_action_state_test.dart`
- `apps/staff/test/features/clinical_inbox/clinical_inbox_error_state_test.dart`
- `apps/staff/test/features/doctor/prescription_local_draft_test.dart`
- `apps/staff/test/features/ipd/drug_chart_local_draft_test.dart`

### 14.4 Modify — Staff authority and capture

- `apps/staff/pubspec.yaml`
- `apps/staff/lib/main.dart`
- `apps/staff/lib/core/services/clinical_platform_api_service.dart`
- `apps/staff/lib/core/models/clinical_platform_models.dart`
- `apps/staff/lib/core/services/prescription_payloads.dart`
- `apps/staff/lib/core/services/order_payloads.dart`
- `apps/staff/lib/features/clinical_continuity/services/staff_continuity_repository.dart`
- `apps/staff/lib/features/emr/note_draft_autosave.dart`
- `apps/staff/lib/features/nursing/screens/nursing_notes_screen.dart`
- `apps/staff/lib/features/opd/screens/op_doctor_workspace_screen.dart`
- `apps/staff/lib/features/nursing/screens/vitals_screen.dart`
- `apps/staff/lib/features/doctor/prescription_offline_rx.dart`
- `apps/staff/lib/features/doctor/screens/prescriptions_screen.dart`
- `apps/staff/lib/features/ipd/drug_chart_offline_order.dart`
- `apps/staff/lib/features/ipd/screens/drug_chart_screen.dart`
- `apps/staff/lib/core/widgets/offline_sync_badge.dart`

### 14.5 Modify — Staff online-only and error UX

- `apps/staff/lib/features/investigations/specimen_scan_intent.dart`
- `apps/staff/lib/features/nursing/screens/mar_scan_screen.dart`
- `apps/staff/lib/features/investigations/screens/specimen_scan_screen.dart`
- `apps/staff/lib/features/bloodbank/transfusion_scan_intent.dart`
- `apps/staff/lib/features/bloodbank/screens/transfusion_scan_screen.dart`
- `apps/staff/lib/features/clinical_inbox/screens/clinical_inbox_screen.dart`
- `apps/staff/lib/core/providers/clinical_inbox_provider.dart`
- `apps/staff/lib/core/widgets/post_discharge_cross_sign_sheet.dart`
- `apps/staff/lib/features/emr/screens/clinical_notes_screen.dart`
- `apps/staff/lib/features/radiology/screens/radiology_screen.dart`
- `apps/staff/lib/features/investigations/screens/lab_bookings_screen.dart`
- `apps/staff/lib/features/emr/screens/discharge_summary_screen.dart`
- `apps/staff/lib/features/emr/screens/discharge_hub_screen.dart`
- `apps/staff/lib/features/beds/screens/bed_board_screen.dart`
- `apps/staff/lib/features/settings/screens/settings_screen.dart`
- `apps/staff/lib/features/hr/screens/staff_management_screen.dart`
- `apps/staff/lib/l10n/app_strings.dart`
- `apps/staff/test/i18n_guard_test.dart`

### 14.6 Modify — Staff tests

- `apps/staff/test/core/services/prescription_payloads_test.dart`
- `apps/staff/test/core/services/order_payloads_test.dart`
- `apps/staff/test/features/emr/note_draft_autosave_test.dart`
- `apps/staff/test/features/nursing/vitals_queue_identity_test.dart`
- `apps/staff/test/features/doctor/prescription_offline_rx_test.dart`
- `apps/staff/test/features/ipd/drug_chart_offline_order_test.dart`
- `apps/staff/test/features/offline_physical_evidence_fallback_test.dart`
- `apps/staff/test/features/nursing/mar_scan_offline_test.dart`
- `apps/staff/test/features/investigations/specimen_scan_intent_test.dart`
- `apps/staff/test/features/bloodbank/transfusion_scan_intent_test.dart`
- `apps/staff/test/features/clinical_inbox/clinical_inbox_screen_test.dart`
- `apps/staff/test/features/radiology/radiology_screen_test.dart`

### 14.7 Step 1 design-only file

- `docs/continuity/c4-3-staff-action-registry-enforcement-design-delta.md`

There is no backend, Prisma, migration, OpenAPI, generated API, Admin, Patient,
infrastructure, deployment, provisioning, receipt, or activation file in the
ledger.

## 15. Step 2 verification receipts

Step 2 retains command logs under
`D:\Dev\_codex\artifacts\logs\<date>\c4-3-staff-enforcement\` and must produce:

- focused new verifier, action-gate, local-draft, conformance, version-floor,
  critical-inbox, and high-risk UI test receipts;
- the complete unchanged C0A suites:
  `connectivity_sync_c0a_test.dart`,
  `offline_queue_c0a_safety_test.dart`,
  `offline_write_containment_test.dart`, and Staff capture-context,
  note-draft identity, and vitals identity suites;
- the complete unchanged C2.2 restart/expiry/readiness suites named in the C4.1
  design record;
- the complete unchanged C3.3 canonical JSON, verifier, cache, trust-store,
  Staff repository, bootstrap, and UI suites named in the C4.1 design record;
- `melos run format`;
- `melos run analyze`;
- `melos run test`;
- `flutter test apps/staff/test/i18n_guard_test.dart`;
- `melos run i18n-health-staff`;
- Android Staff APK and app-bundle release builds;
- Windows Staff release build;
- the Staff airplane-mode integration flow, including restart with queued,
  legacy-review, and device-local draft state;
- repository secret and dependency checks applicable to the client delta;
- `git diff --check`; and
- `git diff --name-status github/main...HEAD`.

The three-dot intent receipt must contain only this design record and cleared
core/Staff files in section 14. Any backend, provisioning, receipt, activation,
new action ID, or transport expansion is a hard failure.

## 16. Rollback

C4.3 is safe to ship before activation because unavailable or shadow authority
permits no continuity capture. Rollback is:

1. stop publishing any enforcing policy before rolling the client back;
2. allow the new client to move unresolved legacy rows to `needs_review`;
3. revert the C4.3 client commit without changing server data; and
4. preserve encrypted local drafts and queued/review rows for explicit
   reconciliation rather than deleting them.

Rollback never re-enables the endpoint facade or legacy route replay. A binary
older than `1.2.0` is below the enforcing posture's signed minimum and must
remain denied.

## 17. Explicit non-goals

C4.3 provides:

- no backend or server database change;
- no signed-policy network/edge delivery adapter and no use of the unsigned
  legacy downtime-policy endpoint as authority;
- no C4.2 policy approval, publication, shadow-to-enforce transition, facility
  activation, action activation, or feature-flag flip;
- no provisioning, facility inference, device enrollment, or C-D14 bypass;
- no replay receipt, command-effect transaction, conflict engine, tombstone,
  or reconciliation mutation;
- no new action ID, route, endpoint, backend binding, schema, or electronic
  offline action;
- no offline prescription submission, CPOE submission, MAR administration,
  specimen collection, transfusion verification, generic note creation,
  vitals creation, sign, lock, finalization, discharge, inbox mutation, or
  security mutation;
- no automatic submission of a device-local draft;
- no weakening of C0A ciphertext, sequence, state-event, handoff, or
  containment invariants;
- no use of the global fail-open version service as continuity authority;
- no deployment; and
- no merge.

## 18. Coordinator clearance requested

Please approve or correct these exact Step 2 decisions:

1. one shared C3.3 trust, verifier, floor, witness, and cache path for signed v3
   action authority;
2. an unavailable production byte source until a separately approved signed
   C4.2 policy delivery adapter exists, with the unsigned legacy endpoint
   explicitly rejected as authority;
3. exact default deny before display, persistence, lease, and send;
4. exactly two queue transports and no policy/config-only widening;
5. separate encrypted `local_draft_only` storage with explicit online reopen
   and no auto-submit;
6. proactive offline blocks and mutually exclusive critical-inbox error UX;
7. Staff `1.2.0+4` with signed minimum `1.2.0`;
8. idempotent legacy-row review migration and retirement of the C0A endpoint
   facade;
9. permanent compiled denial of MAR, specimen, and transfusion replay;
10. the executable call-site and transport conformance gate;
11. the exact Step 2 file ledger and named receipt matrix; and
12. the zero-overlap boundary and explicit non-goals.

Until clearance is recorded, this branch remains documentation-only and must
not be merged.
