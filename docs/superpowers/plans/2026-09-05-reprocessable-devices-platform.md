# Reprocessable Devices Platform Implementation Plan

- Date: 2026-09-05
- Revision: **Revision 2.2 — final migration 767 §3 contract quoted verbatim 2026-09-07**, retaining Revision 2.1's accepted contract positions and Revision 2's owner-review closure
- Status: **awaits owner design approval; stage 1 of 3**
- Spec: `docs/superpowers/specs/2026-09-05-reprocessable-devices-platform-design.md`
- Verified base: `github/main` at `db30fe80b` on 2026-09-07; highest migration 766
- Future implementation branch: `feat/reprocessable-devices-platform`
- Migration: **`NNN`**, the next free number at implementation push time. Migration 767 is reserved for the Phase 1 dialysis-isolation lane whether or not a `767_*` file exists

This plan implements one patient-blind physical-device register for dialysers and OT instrument sets/trays while keeping patient linkage on usage rows. It preserves dialysis dedication, immutable historical exposure, live-data decisions, safe unused-capture restoration, and the existing cath register. It does not implement Phase 1 derivation or migration 767; it consumes the accepted, versioned `DialysisIsolationDecision/v2` contract quoted verbatim in §3.1.

## 1. Approval model and execution boundary

Approval has three independent stages. Passing one does not imply the next.

1. **Revised design approval.** The owner approves the spec and this plan after the 2026-09-06 review. No implementation starts before this approval.
2. **Implementation verification.** The future implementation is exercised through complete dialysis/OT lifecycles, the five named Revision 2 closure tests, five amplified concurrency tests, durable exposure admission/recovery, schema/response validation, mutation checks, fresh-database runs, and canonical full CI. The implementation task remains draft and unmerged at hand-back.
3. **Tenant clinical activation.** A tenant may activate a domain only under an approved nephrology/CSSD/infection-control protocol that records the model/processing basis, pathogen-specific matrix, TCV threshold, process-agent limits, residual-test rule, surveillance intervals, and prion pathway. Durable exposure delivery and the real Phase 1 resolver are activation prerequisites.

The hand-back in Task 9 is for stage 2 evidence. It gives no authority to activate a tenant, mark a pull request ready, or merge.

## 2. Re-verified repository facts

These are the current-code seams. Re-run the named searches at Task 0; line numbers are secondary to function names.

| Function / contract | Verified fact on `db30fe80b` | Plan consequence |
|---|---|---|
| `enrolPatient` (`dialysisService.js:223`) | omitted serology is written with `COALESCE(..., 'negative')` | a legacy negative is not evidence and never clears an analyte |
| `recordReuseRegister` (`dialysisService.js:943`) | compares a client-supplied count only with the session count and upserts the statutory row | derive cycles from the device; settle the statutory row once; use append-only attempts afterward |
| `completeSession` / `cancelSession` (`dialysisService.js:529`, `:631`) | completion already records `early_termination` and reason; cancellation is pre-start | use completion as the non-circular aborted-use path; cancellation only restores a proven-unused capture |
| `recordSerology` (`dialysisService.js:1115`) | #1024 stamps the row's tenant; `:1160-1170` promotes only literal `positive` values to the roster columns | Phase 1 owns derivation; a legacy positive restricts without corroboration |
| `addAccess` (`dialysisService.js:309`) | #1024 stamps vascular access with its own tenant | closed baseline item; no Plan 4 edit |
| `ingestMachineObservations` (`dialysisMachineService.js:46`) | #1021 requires tenant scope on the in-progress-session lookup | Task 4 preflight is verify-only |
| `createSterilizationLoad` (`cssdService.js:424`) | derives an initial outcome and directly updates sets/issues, including loads created already passed or failed | creation and transitions must call one load-outcome handler |
| `transitionSterilizationLoad` (`cssdService.js:588`) | repeats the outcome writes | call sites are discovered by scan and pinned by a population snapshot |
| `issueSet`, `transitionIssue`, `cancelIssue` (`cssdService.js:731`, `:807`, `:947`) | issue, return, and cancel mutate the physical set in their existing transactions | hooks stay inside those transactions and follow the common lock order |
| `markTheatreUse` (`cssdService.js:935`) | is the actual transition into theatre use and currently has no Plan 4 admission hook | add the OT actual-use boundary here, not only at issue |
| `registerExposureHandler` (`bloodborneMarkerRules.js:227`) and the registration in `cathDeviceReuseService.js:1428` | handler registration is process-local | add the Plan 4 handler to `exposureHandlerBootstrap.js` and make delivery durable |
| `notifyExposureHandlers` (`bloodborneMarkerRules.js:255`) and cath `quarantineDevicesExposedToPatient` | dispatcher and cath consumer catch failures; promise resolution is not complete delivery | stable handler IDs, explicit results/obligations, and no swallowed failures |
| `recordMarkerTx`, `recordMarkers`, `recordMarkersFromSignedResults` (`bloodborneMarkerService.js`) | reactive marker rows commit before the current post-commit fan-out | insert the exposure-outbox row in the marker transaction |
| `reconcileTenant` / `reconcileAllTenants` | #1017 re-drives signed-result writers and the operator sweep refuses an empty handler registry | add an outbox-drain phase; do not treat the sweep alone as durable delivery |
| `dbClockAsOf` / `refreshCaseLabReadiness` and the clock guard | #1025 uses the database clock and covers DATE comparisons | recorded baseline only; no Plan 4 contract changes |

`github/main` presently contains neither `resolveDialysisIsolation` nor a `767_*` migration. That absence does not free migration 767. Release CI must fail, not skip green, if dialysis activation is possible before the real resolver is present.

## 3. Non-negotiable contracts

### 3.1 Resolver and asymmetric Q1

The request was accepted into the Phase 1 migration 767 brief §3 as written on 2026-09-07. Plan 4 consumes that contract and adds nothing to it:

```js
export const CONTRACT_VERSION = 2;   // exported by the resolver module

resolveDialysisIsolation({
  tenantId,
  patientUids,
  db,
  contractVersion,                 // caller states what it can read; adapter enforces
  includeMarkers = false,          // opt-in, default OFF
  includeIsolationClass = false,   // separate opt-in, default OFF (D11)
}) -> Map<patientUid, Decision>

Decision = {
  contract_version: 2,

  status: 'restricted' | 'unknown' | 'clear',
  asOf,
  reasons: [],
  evidence: 'marker' | 'legacy_declaration' | 'none',

  // ONE date: the most recent qualifying evidence, whatever marker produced it.
  // Per-marker dates are NOT here — see markers below. null when evidence === 'none'.
  evidence_dated_on: date | null,

  // ONLY when includeMarkers === true. Per-marker detail lives here and nowhere
  // else. A per-marker DATE is marker-identifying, so it is gated exactly as the
  // marker is. Key is `marker`, matching the shipped `markers` shape.
  markers: [ { marker, result, tested_on, marker_row_id, source } ],

  // ONLY when includeIsolationClass === true. Two server-side askers, no read surface.
  isolation_class: 'hbsag' | 'hcv' | 'hiv' | 'isolation_mixed' | null,
}
```

Plan 4 derives only `isolated === (status === 'restricted')`; it is not another resolver field.

The following three paragraphs are quoted verbatim from the Phase 1 migration 767 brief §3:

**Why the version field earns its place** (it is not ceremony): the adapter already fails
closed when the Phase 1 module is *absent*. The version makes it fail closed when the
module is *present and incompatible* — the more dangerous case, because an absent field
reads as a negative answer. If `evidence_dated_on` were later moved or renamed, a
consumer would read `undefined` and could treat it as "no evidence dated", which is a
fail-open by omission. A version turns that silent misread into a loud refusal.

**The two constants must not be allowed to drift.** The adapter hard-codes the version it
supports; the resolver exports `CONTRACT_VERSION`. Pin that they are equal *today*, so a
bump without updating the consumer fails CI rather than production, and keep the runtime
refusal for the case that reaches it anyway.

**Not on the Decision, deliberately:** `surveillance_overdue` (a policy verdict, not
evidence — the interval varies by tenant and protocol; expose the date, let the policy
layer compute it), and any third flag such as `includeEvidenceRefs` (its payload is
data `markers` already carries — one door, not two).

The resolver returns evidence, not policy. `reuseEligibilityTx` owns the tenant/protocol interval and computes overdue from the single base `evidence_dated_on`; when a protocol requires per-analyte currency, that function requests `includeMarkers: true` and computes from marker-object `tested_on`. It also passes a selected `marker_row_id` directly to `placeHoldTx` when its verdict creates a hold. `cohortCompatibilityTx` is the only other Plan 4 function that requests `includeMarkers: true`; it derives the per-analyte profile from the returned marker objects. Its output is exactly `{ verdict: 'compatible' | 'incompatible' | 'not_established' }`, with no analyte, class or date. A whole-value pin rejects `hbsag`, `hcv`, `hiv` and `isolation_mixed` anywhere in that returned object; a mutation that returns the profile beside the verdict must turn it red. D11 is preserved because the server-side calculation emits only whether two patients may share a bay. The marker caller set is pinned at exactly those two in-process functions, and no route, snapshot, receipt, audit row or device record passes `includeMarkers: true` or receives their protected input.

Q1 is asymmetric and is owned by the Phase 1 lane:

- legacy `positive` contributes `restricted` on its own; it is never the default and always represents a deliberate write;
- legacy `negative` contributes nothing: it is never an input to `clear`, never ANDed with evidence, and never treated as weaker evidence;
- a marker or `dialysis_serology` row decides independently per analyte;
- a negative-shaped roster value with no evidence row resolves `unknown`;
- a voided reactive with no other evidence falls back only to a positive legacy declaration;
- evidence date and surveillance currency remain separate from cohort status.

### 3.2 Marker-free routing and storage

D11 remains **NO**. `dialysis_machines.isolation_group` is the routing key. No marker name or isolation class may appear in a routing payload, device row, frozen usage screen, error body, audit-derived response, audit metadata, or free-text reason written by this lane.

The device stores `exposure_flag` as immutable history. An unresolved `reprocessable_device_holds` row is the operational restriction. Detailed marker evidence is reachable only through a separately authorised clinical record pointer on the hold. `reuse_screen` and `post_use_screen` are immutable evidence snapshots, but every response passes them through `projectUsageForRole`, which recursively removes marker/class fields and empties free-text reasons for non-audience roles.

Isolation groups come from an infection-control-approved non-clinical vocabulary. The case-insensitive token deny-list includes `hiv`, `hbv`, `hbs`, `hbsag`, `hcv`, `hep`, `hepatitis`, `aids`, `positive`, `reactive`, `sero`, `infect`, `cjd`, and `prion`. This limits direct disclosure but cannot eliminate ward-level inference about which physical bay serves which cohort.

### 3.3 Processing occurrence, obligation evaluation, and restoration

`releaseToAvailableTx` is the only **processing-based** readiness authorisation. It always records the physical occurrence first, even when deactivation, a hold, or invalid scope prevents availability. The generic `POST /api/v1/cssd/reprocessable-devices/:id/reprocessed` resolves the domain and delegates:

- dialysis: require `device_usage_id` and the complete statutory evidence, then call `recordDialyserReprocessing` if the statutory row is unsettled or `recordDialyserReprocessingAttempt` after settlement;
- OT: require the applicable passed load containing this set, linked to the correct processing event and compatible with the active protocol.

The generic controller contains no transition logic. A settled `dialyzer_reuse_register` row is never rewritten. `restoreUnusedCaptureTx` is separate: it creates no processing event, ignores reprocessing eligibility/ceiling, and restores `available` only for `sealed_unopened` with still-valid readiness and zero obligations. `not_connected` clears episode residual evidence and requires processing. `releaseHoldTx` never writes `available`; `evaluateOutstandingObligationsTx` considers every active hold, released-unsatisfied processing requirement, dirty return, invalidation, residual rule, and exact protocol/device-scope/timing requirement.

### 3.4 States, cycles, locks, and receipts

Device states remain `awaiting_reprocessing`, `in_cssd`, `available`, `in_case`, `quarantined`, and `discarded`. Unused restoration consumes no cycle: `sealed_unopened` may restore prior readiness; `not_connected` never does. A hold arriving while captured yields quarantine. An in-progress dialysis use ends through `completeSession(early_termination)` into a non-available state before reprocessing.

`max_cycles` means permitted reprocessing cycles. A device permits `max_cycles + 1` total uses. Capture at the current ceiling is allowed; the next reprocessing is not. Unlimited is null and every comparison has an explicit non-null guard so `Number(null) = 0` cannot create a false ceiling. Cath parity tests cover only the shared input domain.

Every safety-evidence/status change increments `version`, and every accepted command inserts an append-only `reprocessable_device_operations` receipt `{ operation_id, action, device_id, version_before, version_after, audit_id }` in the same transaction. Version change alone is not proof of which command landed; the operation lookup is.

The complete call-graph order is: tenant/patient advisory lock when relevant; dialysis session or OT load(s) ascending; OT issue rows ascending; set rows ascending; platform devices ascending; usages; holds/satisfactions; links; statutory/attempt/operation appends. Existing CSSD writers are changed to this order, including ordinary UPDATE and FK locks. Unseen serials use conflict-safe insert, never catch a unique violation and continue in an aborted transaction.

## 4. File and responsibility map

| Area | Files |
|---|---|
| Schema | `apps/backend/src/migrations/NNN_reprocessable_devices_platform.sql`, Prisma mirror, runtime grant lists, schema pins, comprehensive seeder |
| Rules and projection | new `reprocessableDeviceRules.js`, `dialysisIsolationAdapter.js`, `reprocessableDeviceProjection.js` and unit tests |
| Core lifecycle | new `reprocessableDeviceService.js`, `exposureOutboxService.js`, handler bootstrap import, scheduler and reconciliation-script integration |
| Dialysis | new `dialysisReuseService.js`, changes by function name in `dialysisService.js`, dialysis routes, census and activation guard |
| OT/CSSD | new `cssdReuseHooks.js`, changes by function name in `cssdService.js`, CSSD/theatre routes |
| Contracts | OpenAPI overlay, generated OpenAPI/core, `tests/helpers/assertSchema.js`, route wiring and disclosure canary |
| Staff | new dialysis feature, shared restriction strip, theatre set panel, role contract, exactly 75 new keys in all five locales |
| Admin | reprocessing API/types, CSSD domain/hold actions, governance protocol/policy forms, dialysis machine/dialyser panels |

## Task 0: Re-anchor, branch, and migration preflight

- [ ] Obtain stage 1 owner approval before creating the implementation branch.
- [ ] Fetch `github` and create a fresh worktree from current `github/main`; never reuse a docs/review worktree.
- [ ] Record `git rev-parse github/main` and re-run every function-name check in §2.
- [ ] Confirm #1021, #1024, and #1025 remain present by the named functions, not by PR number alone.
- [ ] Record the Phase 1 contract owner's 2026-09-07 answer as the accepted `DialysisIsolationDecision/v2` shape in §3.1. Confirm migration 767 supplies that resolver plus the `(tenant_id, id)` marker parent unique before enabling/testing dialysis. No further owner decision is required; non-dialysis work may proceed if the implementation is absent, but stage 2 cannot pass.
- [ ] Scan migrations on `github/main` and every open GitHub branch. Reserve 767 unconditionally and substitute `NNN` only when the implementation is ready to push. Re-scan at Task 9.
- [ ] Create a fresh PostgreSQL test database and record the Node version (`v26.5.0`).
- [ ] Record the discovered current CSSD outcome-write population for `createSterilizationLoad` and `transitionSterilizationLoad`; the snapshot is a deliberate review point, not a hard-coded assumption from this document.

Gate: the worktree is clean, based on the recorded main SHA, and no migration or resolver ownership conflicts exist.

## Task 1: Forward-only schema, integrity, RLS, and seed

Create one forward migration. Do not edit migrations 168, 418, 421-423, 565, 764-767.

- [ ] Create the seventeen new relations from spec §4:

  1. `reprocessing_domain_settings`
  2. `reprocessing_domain_policies`
  3. `reprocessing_protocols`
  4. `reprocessable_devices`
  5. `reprocessable_device_usages`
  6. `reprocessable_device_dialysis_links`
  7. `dialysis_machines`
  8. `reprocessable_device_holds`
  9. `device_processing_events` (append-only)
  10. `dialyser_reprocessing_attempts` (append-only)
  11. `bloodborne_exposure_outbox`
  12. `reprocessing_protocol_device_scopes`
  13. `device_processing_event_revisions` (append-only)
  14. `reprocessable_hold_satisfactions` (append-only)
  15. `bloodborne_exposure_deliveries`
  16. `bloodborne_exposure_applications` (append-only)
  17. `reprocessable_device_operations` (append-only receipts)

- [ ] Add forward-only columns/constraints to `dialysis_sessions`, `dialyzer_reuse_register`, `surgical_implants`, `ot_schedules`, `instrument_sets`, `sterilization_loads`, `set_issue_log`, and `clinical_ai_biomed_devices` exactly as the spec requires. Baseline-owned tables are altered only; they are never re-declared inline.
- [ ] Keep the register patient-blind and marker-free. `quarantine_reason` is a fixed non-clinical code, not free text. `exposure_flag` is irreversible history.
- [ ] Make `current_usage_id` point to an open usage belonging to this device through the composite target `(tenant_id, id, device_id)` plus transactional open-row checks.
- [ ] Make the statutory `(device_id, device_usage_id)` pair identify the same device/use and the correct dialysis session.
- [ ] Enforce usage/session/patient and usage/issue/set/device consistency with composite foreign keys where possible and locked transactional checks for the dialysis patient join.
- [ ] Persist both evidence sides: `ready_processing_event_id` at capture and write-once `post_use_processing_event_id` after use. Never rely on the overwritten convenience `set_issue_log.sterilization_load_id` as statutory evidence.
- [ ] Remove bloodlines from the release vocabulary. Refuse `procedure_pack` with `reprocessable = true` at both database and service layers.
- [ ] Make protocol revisions immutable and require an enforceable manufacturer/model device scope, linked IFU and `single_use = false`. Database-lock HBsAg, HIV, and mixed dialysis reuse to `no_reuse`; HCV defaults to `no_reuse`. Give OT a structurally separate standard-processing shape and prion pathway.
- [ ] Validate protocol JSON as an exact object with all required keys and predicates that are `IS TRUE`; runtime-role probes for `{}`, missing keys and JSON nulls must fail.
- [ ] Add baseline TCV provenance, measured TCV, integrity/process parameters, pre-use residual result, release verdict, missing-evidence list, device/protocol/time-pinned hold satisfaction, command version, append-only occurrence/revision/attempt/application/receipt identity. A first mid-life measurement is never a baseline; only manufacturer nominal or validated model basis may substitute.
- [ ] Make all evidence/event/hold/attempt references device-pinned. Make schedule-patient consistency deferrable for the patient-merge transaction. Require Phase 1's `(tenant_id, id)` marker parent unique; never accept a single-column FK as an RLS substitute.
- [ ] Apply tenant RLS, explicit tenant predicates, sequences, runtime grants, and append-only privilege revocation. Add Prisma scalars/indexes without relation fields, update runtime relation lists, schema tests, and seeder overrides.
- [ ] Seed an inactive/dark-safe configuration: no active reprocessable category, conservative matrix, one closed usage, one released hold, one event, one not-established attempt, and one delivered outbox row.

Verification:

- [ ] Run migration-number, immutable-migration, session-GUC, inline-check census, Prisma relation, schema-drift, RLS, grants, and seed-contract gates.
- [ ] Apply all migrations twice to fresh databases. Run the comprehensive seed twice; the second run creates zero duplicates.
- [ ] Probe the relationship constraints with deliberately mismatched device/use/session/issue/set/tenant fixtures.

## Task 2: Pure rules, protocol validation, resolver adapter, and projection

- [ ] Implement `assertDecisionShape` for all three statuses with `includeIsolationClass` on and off. Missing/null class is invalid only for `restricted` when asked; a non-null class is invalid for `clear`/`unknown` and when unrequested.
- [ ] Implement and contract-test `DialysisIsolationDecision/v2`: `contract_version`, one base `evidence_dated_on`, marker-object `tested_on` and `marker_row_id` behind `includeMarkers`, and the existing `isolation_class` behind `includeIsolationClass`. Fail closed on any older/unknown contract version. Assert that the Decision has no overdue verdict or isolation-profile field and that no third detail flag exists.
- [ ] In `dialysisIsolationAdapter.js`, hard-code the consumer's supported version as its own `SUPPORTED_CONTRACT_VERSION = 2`; do **not** import the resolver's `CONTRACT_VERSION`, because comparing an imported constant to the resolver's own output would be a tautology. Unit-test that the adapter's hard-coded value equals the resolver module's exported `CONTRACT_VERSION` today, and separately prove a Decision with a mismatched `contract_version` fails closed with 503 `RPD_ISOLATION_CONTRACT_VERSION_UNSUPPORTED`.
- [ ] Keep `includeMarkers` and `includeIsolationClass` default-off. Pin the marker requester population at exactly `reuseEligibilityTx` and `cohortCompatibilityTx` by function name; pin the class requester population separately at exactly `assessIsolationTx` and `reuseEligibilityTx`.
- [ ] Implement three separate decisions:

  - `resolveDialysisIsolation`: what clinical evidence establishes;
  - `assessIsolationTx`: where the patient may dialyse;
  - `reuseEligibilityTx`: whether this physical dialyser may be reprocessed.

- [ ] Implement `reuseEligibilityTx` with conservative protocol defaults: HBsAg no reuse, HIV no reuse, mixed no reuse, HCV per approved protocol, active-hold precedence, dedication, and separate `prion_exposure` rules. It owns surveillance intervals and computes overdue from the base `evidence_dated_on`; only a protocol requiring per-analyte currency may make it request marker detail and use marker-object `tested_on`. Its return value is an eligibility verdict only.
- [ ] Remove the former same-patient exposure escape. Same-patient dedication is necessary for the HCV protocol branch but never overrides a `no_reuse` cell.
- [ ] Implement `deviceEligibilityTx({ action: 'use' | 'reprocess' })` with no default action. Use checks current readiness/holds/scope and permits the last use at the ceiling; reprocess applies the next-cycle ceiling, matrix, currency and obligations.
- [ ] Implement `releaseCriteria`: missing mandatory evidence is `not_established`, never pass. Require a pre-use or validated-model/manufacturer baseline (never first mid-life measurement); default threshold 80% and prohibit lower values; validate integrity, agent, concentration, contact time, scope/IFU and residual obligations.
- [ ] Keep OT sterility evidence (load indicators/process event) separate from return inspection/function evidence.
- [ ] Implement the cycle ceiling with an explicit null guard and table-driven lifecycles for 1, 2, and unlimited.
- [ ] Implement `cohortCompatibilityTx` before opaque group routing. It requests existing marker objects with `includeMarkers: true`, derives the per-analyte profile in process, preserves HBsAg cohort distinctions, and forbids unknown patients from incompatible HBV-dedicated groups. Its return value is exactly a compatibility verdict with no analyte, class or date; validate the selected machine's active state.
- [ ] Implement approved isolation-group validation and deny-list. In block mode refuse unregistered/unmapped. Emergency authorisation is pre-scheduling-capable, role-gated, one-time, max four hours, and bound to patient, selected machine, decision fingerprint, settings/policy/protocol revisions; reassignment/evidence/config changes invalidate it.
- [ ] Implement distinct non-exposure hold/disposition codes, including `serology_required`, `post_issue_restriction`, and `inspection_failed`.
- [ ] Implement `projectUsageForRole`, `projectReuseRestrictionForRole`, and allow-listed `projectHoldForOperationalRole`. Notes, adjudication, evidence/source refs, patient/case IDs and nested metadata appear only on the purpose-bound, access-logged evidence-review route. Operational prion text is `specialist_contamination_hold`.

Unit gate: rules, adapter, projection, null-ceiling, 1/2/unlimited lifecycle, matrix, protocol, deny-list, and parity-over-shared-domain tests all pass.

## Task 3: Core lifecycle, holds, one release path, and durable exposure delivery

- [ ] Implement register mint/read, reservation, actual-use admission helpers, return, unused restoration, quarantine, hold release, processing release, discard, label, history and operation lookup in `reprocessableDeviceService.js`.
- [ ] Define the complete call-graph `LOCK_ORDER`, including existing CSSD UPDATE/FK locks. Rewrite `transitionIssue` and load transitions to load→issue→set→device order; sort multi-row IDs.
- [ ] Use conflict-safe `INSERT ... ON CONFLICT DO NOTHING RETURNING` for unseen serials. Never continue after a caught unique violation inside the failed transaction.
- [ ] Require `expected_version`, increment version for every safety-evidence mutation, and insert `reprocessable_device_operations` in the same transaction. Test stale-version refusal, receipt lookup, and exact idempotent replay.
- [ ] Keep `quarantine` out of the `in_case` from-list. Dialysis and OT close the usage with `return` before quarantine in the same transaction.
- [ ] Implement `restoreUnusedCaptureTx` separately. Standardise `pack_condition`, `sealed_unopened`/`not_connected`, and `RPD_PACK_CONDITION_REQUIRED`/`INVALID`; clear residual evidence on not-connected. Re-check holds/obligations after locking.
- [ ] Implement the explicit retrospective-use command: record actual-use time, recorder and deviation even if unsafe, then settle non-available with required holds/discard. Never reject history merely because authorisation would have failed.
- [ ] Implement `placeHoldTx`, `releaseHoldTx`, `evaluateOutstandingObligationsTx`, and device/protocol/time-pinned append-only satisfaction. Hold release never writes available; erroneous release removes only its own obligation.
- [ ] Implement `releaseToAvailableTx` as processing occurrence plus readiness authorisation. Record the occurrence even if release is refused. Pin processing and restoration call sites separately; deactivation settles enrolled history and never re-enters legacy behavior.
- [ ] Replace every Plan 4 exposure writer, including the late-reactive handler, with `{ exposure_flag: true }` plus a non-clinical hold code. Put detailed evidence only on the authorised record pointer. Audit only hold ids and reason codes.
- [ ] Register handlers as stable `{ id, apply }` records. Change dispatcher and cath compatibility path to return explicit remaining-device/alert/notification obligations; no swallowed failure can be acknowledged complete. Add cath `tested_on = NULL` lookback.
- [ ] Insert `bloodborne_exposure_outbox` from `recordMarkerTx` in the same transaction as the reactive marker. The two public writers retain post-commit fan-out only as the fast path.
- [ ] Implement deliveries plus append-only event×handler×device applications. Replays of an applied event never recreate a released hold; new events retain distinct evidence associations. Complete only at zero durable obligations.
- [ ] Add the shared tenant/patient advisory transaction lock to marker writes and every actual-use admission. Admission synchronously applies relevant committed work or refuses `RPD_EXPOSURE_RECONCILIATION_PENDING`; async drain is recovery, not the safety boundary.
- [ ] Implement an idempotent reconciler with `FOR UPDATE SKIP LOCKED`, lease/reap, bounded backoff, failed/operator-redrive state, scheduler drain, on-demand governance drain, and a first-step drain in the #1017 reconciliation script.
- [ ] Define `tested_on = NULL` as an unbounded historical lookback. The handler applies the hold to every affected use and records the non-clinical code `exposure_undated_declaration`; infection control reviews it.

Deep recovery gate: after marker+outbox commit and a simulated crash, attempt actual dialysis/OT use **before drain** and prove it refuses or synchronously applies; then drain/redrive obligations exactly once and complete release → processing → successful re-issue while `exposure_flag` remains true.

## Task 4: Dialysis capture, routing, statutory settlement, attempts, and census

- [ ] Verify only: `ingestMachineObservations` still binds the session lookup to `tenantId`; do not create another tenant-scope commit.
- [ ] Bind `dialysisIsolationAdapter.js` to the accepted real Phase 1 v2 contract. Product code has no stub/fallback; version mismatch fails closed. Record the contract owner's 2026-09-07 answer and the landed resolver/version evidence before stage 2; no further owner decision is needed.
- [ ] Add capture by serial/tag with physical identity minting, patient dedication, baseline TCV provenance, residual-test requirement, live decision snapshot, version receipt, and transactionally consistent `dialysis_sessions.dialyser`/`reuse_count` fields.
- [ ] Integrate by function name: `scheduleSession` plans before insert; `startSession` is the actual-use admission boundary and revalidates exposure, holds, readiness, dedication, scope, residual evidence, use eligibility, selected-machine activity and cohort compatibility; machine reassignment invalidates bound emergency authorisation; `recordReuseRegister` delegates while only truly dark sessions keep legacy behavior.
- [ ] Persist only `required_group` and non-clinical warning codes. No `required_class`, marker, or reason reaches a session, response, error, or audit row.
- [ ] Under block mode, unregistered, unmapped, retired-selected and cohort-incompatible machines refuse. Add pre-scheduling-capable one-time emergency authorisation bound to patient/machine/decision/config revisions with max four-hour expiry; consume only at start.
- [ ] Require use completed/aborted before statutory settlement. Route in-progress abort through existing `completeSession` with `early_termination` and close usage non-available in that transaction, without requiring a reprocessing record first.
- [ ] Record all mandatory release evidence and one of `released`, `not_established`, or a discard verdict on the statutory row. Once settled, route later legitimate work to `dialyser_reprocessing_attempts`; never update the statutory evidence row.
- [ ] Make the generic `/reprocessed` endpoint delegate to the same statutory command or append-only attempt based on `device_usage_id` and settlement state. A domain-specific role check applies before delegation.
- [ ] Treat capture as reservation. Check `deviceEligibilityTx({action:'use'})` again at start; reserve ceiling enforcement for `action:'reprocess'`. A historically exposed device can re-issue only after current holds and all obligations clear.
- [ ] Add the retrospective-use command and explicit scheduled cancellation restoration contract. `sealed_unopened` may restore; `not_connected` returns awaiting processing and clears residual attestation; in-progress use terminates, never cancels.
- [ ] Keep the Phase 1 files and `dialysis_patients.*_status` untouched. The asymmetric Q1 rule is an input/acceptance contract, not code owned here.
- [ ] Implement the Phase 2 census:

  - orphan roster patient ids;
  - every unbackfilled legacy positive across all roster rows using `bool_or`;
  - `declared_and_corroborated_negative_*`: negative-shaped roster values backed by independent non-reactive serology evidence, with the evidence row doing the deciding;
  - defaulted negative-shaped values with no evidence;
  - `column_only_declared_negatives = 0` by construction; a large number is a script bug;
  - retrospective captures and relationship-integrity defects;
  - `--compare-drop` status **and routing group** per patient with and without the columns.

The census gates only a future DROP, never additive migration `NNN`. Preserve valid positives with provenance, reconcile defaults without promoting them, and treat serology rows as their own evidence.

Dialysis deep gate: full capture/admission/use/end/settle/attempt/re-capture lifecycle; 1/2/unlimited ceilings; every matrix cell; missing evidence; residual test; dedication; snapshot-vs-live decision; compatible cohorts and bounded emergency authorization; hold after capture; unused restoration; early termination; retrospective recording; generic delegation; exposure/release races; marker-free device/error/audit assertions; accepted real Phase 1 v2 resolver only.

## Task 5: OT/CSSD load identity, issue lifecycle, and failure response

- [ ] Create `applyLoadOutcomeTx` and call it from both `createSterilizationLoad` and `transitionSterilizationLoad`, including loads created already passed or failed.
- [ ] Build `cssdLoadOutcomeCallSites.test.js` by scanning for all outcome writes, assigning them to containing functions, and asserting both delegation and a reviewed population snapshot. Do not maintain an enumerated allow-list that can silently shrink.
- [ ] Separate occurrence from adjudication. Write one immutable processing occurrence per device/load; append a `device_processing_event_revisions` invalidation when a later indicator changes that load to failed. Unchanged pass is no-op; invalidation ignores latest-return applicability and never increments a second cycle.
- [ ] On first enrolment of an existing set, import `last_passed_load_id` as `legacy_readiness_import` with `counts_cycle = false` and use it as first readiness, so a later failure finds every platform usage.
- [ ] Preserve `ready_processing_event_id` before the use and write-once `post_use_processing_event_id` after it.
- [ ] Integrate reservation/return/cancel hooks plus `onTheatreUseStartedTx` inside `markTheatreUse`. Actual-use admission takes the patient advisory lock and revalidates exposure work, hold, readiness, patient, scope and use eligibility.
- [ ] Make existing direct `instrument_sets` / `set_issue_log` outcome updates conditional on the handler result for enrolled sets; only dark/unenrolled sets keep the legacy direct behavior.
- [ ] At issue time, refuse active holds, not historical exposure. If a restriction arrives after issue, place `post_issue_restriction`; acknowledgement is obtained at infection-control release, not fabricated at the earlier issue.
- [ ] Keep routine blood-borne holds separate from prion. A known CJD concern synchronously creates the operationally generic specialist hold at assessment/return; only the specifically authorised pathway event can satisfy it.
- [ ] Standardise cancellation on `pack_condition`. Only `sealed_unopened` may restore readiness; already-used/opened requires return; an active hold or obligation wins.
- [ ] Require the generic OT `reprocessed` command to name the passed load that contains this set, follows its return, matches the allowed cycle/protocol, and has no prior event for this device.
- [ ] Keep sterility evidence separate from mechanical inspection/function. A failed inspection has its own hold and cannot be cleared merely by a passed load.
- [ ] Implement the minimum load-failure response now: follow every usage linked to the original occurrence regardless of current device state/return, place holds, create patient safety alerts, notify IC, and produce a durable investigation. CSSD receives devices plus aggregate counts only; patient/case detail is on the access-logged investigation route.
- [ ] Implement the required suspect-interval report/manual closure back to the last acceptable biological indicator whenever the active protocol requires it. Only a richer dashboard is deferred.

OT deep gate: dark/active/deactivated; creation/transition outcomes; cycle-neutral legacy import; unchanged pass; late invalidation after issue/use/return; both load links; actual-use hold refusal; restricted/unknown/post-issue/inspection/prion holds; full release-processing-reissue; patient-blind CSSD plus authorised investigation; generic applicable-load refusal; return/load and overlapping-load races; marker-free responses/audits.

## Task 6: Routes, role gates, OpenAPI, response validation, and canary

### 6.1 Routes

- [ ] Dialysis: capture/read, explicit retrospective use, append-only attempts, pre-scheduling emergency authorization, reuse-register delegation, machine reassignment/master, actual-start admission, early-termination settlement, and scheduled cancellation restoration.
- [ ] CSSD: list platform devices and operationally projected holds, label, receive, generic domain-aware `reprocessed`, quarantine/hold release/discard, issue/cancel/theatre-use hooks, and patient-blind load results.
- [ ] Theatre: `GET /api/v1/theatre/:id/reprocessable-sets` with projected restriction and both load-evidence sides.
- [ ] Governance: settings, policies, immutable protocols/device scopes, outbox drain, exact hold evidence, load-investigation affected usages, operation receipt lookup, and device history with per-patient HIPAA access logging.
- [ ] Apply the resolved domain's role gate to generic reprocessing. All mutation guards run before idempotency-key claim.
- [ ] Define hold-release and emergency role sets as intersections with their mounts. Add an actual-assignment census for `DIALYSIS_TECHNICIAN`, `BLOOD_BANK_STAFF`, and `BLOOD_BANK_TECHNICIAN`; D10a, D10b and D10c remain separate decisions and are each NO; the census verifies that no actual assignment invalidates that baseline.

### 6.2 OpenAPI response enforcement

- [ ] Add `reprocessableDevices.mjs`, register every operation, and set `additionalProperties: false` on every response object, nested warning, operation receipt, projected hold, aggregate load result, investigation item, and error detail.
- [ ] Name the test validator: `apps/backend/src/tests/helpers/assertSchema.js` with `assertResponse`, `assertData`, and `assertErrorBody` compiled from generated OpenAPI.
- [ ] Validate one success response for every operation and every documented error body in `reprocessableDevicesOpenApiContract.test.js`. Validate deep-suite readbacks with `assertData`.
- [ ] Do not claim OpenAPI validates production responses by itself. The named tests are the enforcement boundary.

### 6.3 Disclosure canary

- [ ] Add `/api/v1/dialysis`, `/api/v1/cssd`, `/api/v1/theatre`, and `/api/v1/reprocessing` to the existing canary.
- [ ] Poison and walk device fields, `reuse_screen`, `post_use_screen`, service error details/error bodies, and audit-derived history responses.
- [ ] Run the D11 class-in-routing check for every role in a fixed `D11_FIXTURE_ROLES`, independent of D10 and independent of the serology audience complement.
- [ ] Attribute liveness separately: counters prove the walker visited Decision and warning nodes; an entitled response proves poisoned restriction reasons arrived; a fixed `machine_id` proves the isolation fixture arrived; the class mutation proves the value sentinel bites. None substitutes for another.
- [ ] Pin `includeMarkers: true` to exactly `reuseEligibilityTx` and `cohortCompatibilityTx`; prove no route, response/snapshot builder, receipt/audit writer or device persistence path passes it. Walk both functions' outputs and every route, snapshot, receipt, audit row and device value in the canary. By value, reject every marker-class string anywhere in `cohortCompatibilityTx`'s verdict object.
- [ ] Regenerate the reachable-route snapshot deliberately, inspect every added line, and pin the new population.
- [ ] Resolve the old contradiction: no deep test expects a marker on a device. The positive assertion is `exposure_flag = true`, an active hold pointing to the authorised evidence row, and no marker word in the device JSON.
- [ ] Exercise exported marker-free behavior and inspect persisted/projected/returned values; `JSON.stringify(module)` is not evidence.

## Task 7: Admin and Staff surfaces

### 7.1 Admin

- [ ] Add the CSSD domain filter, platform device actions, label, operational hold dialog, version-conflict reload, and patient-blind load aggregates/investigation link only for authorised users.
- [ ] Add reprocessing settings/policies/immutable protocol revisions and device scopes with linked IFU/single-use exclusion, locked dialysis cells, HCV choice, TCV floor, validated model baseline (never first mid-life measurement), process-agent bounds, surveillance, prion/suspect-interval rules, approved isolation groups, and retirement/deactivation impact.
- [ ] Add dialysis machine and dialyser panels. Render `required_group`; never parse or display `required_class`.
- [ ] Add append-only attempt history and `not_established` missing evidence.

### 7.2 Staff

- [ ] Add the generated dialysis role contract, route, today screen, capture sheet, isolation strip, reprocessing sheet, shared restriction strip, and theatre set panel.
- [ ] Read `allowed_dispositions` and server verdicts; do not reproduce matrix or release decisions client-side.
- [ ] Render historical exposure as history and active holds as the blocker. Do not show a marker name.
- [ ] Use `IdempotencyAttemptRegistry` for capture, issue, and reprocessing retries.

Exactly **75 keys × 5 locales = 375 entries**, of which **300** are non-English placeholders for OPEN-21. The authoritative groups and counts are:

| Group | Count | Keys / required content |
|---|---:|---|
| Shared restriction strip | 3 | `restriction_restricted`, `restriction_unknown`, `more_reasons` |
| Dialysis today | 8 | title, empty, station, machine, isolation, dialyser, refresh, load failure |
| Policy banner | 1 | policy disabled |
| Capture | 17 | title, serial, tag, model, baseline TCV, residual test, residual required, submit, identity required, dedicated-other-patient, already captured, active hold, exposure history, max cycles, acknowledgement title, acknowledgement reason, policy deactivated |
| Device card | 3 | cycle, unlimited, exposure history |
| Isolation | 8 | unregistered, mismatch, general-on-isolation-machine, unmapped group, required group, override reason, override required, blocked |
| Reprocessing | 23 | title, outcome, three outcomes, integrity, measured TCV, percentage, agent, contact, concentration, discard reason, notes, submit, not allowed, settled, cycle derived, acknowledgement required, not established, missing evidence, baseline required, use not ended, not eligible |
| Theatre sets | 10 | title, empty, issue, set code/barcode, last load, no load, quarantined, active hold, acknowledgement title, on hold |
| Feature/navigation | 2 | feature and navigation labels |
| **Total** | **75** | No `DIALYSIS_SEROLOGY_UNKNOWN` and no `required_class` key |

Every Hindi, Tamil, Telugu, and Malayalam block carries the established OPEN-21 review marker. Analyzer, widget/model tests, locale parity, and i18n guard must pass.

## Task 8: Complete verification and release gates

### 8.1 Mandatory deep lifecycle tests

- [ ] `lateLoadFailureInvalidatesReadinessWithoutRecount.deep.test.js`: pass → issue/use → return → late original-load failure; append invalidation, do not recount, identify every usage/patient via authorised investigation.
- [ ] `exposureAdmissionBoundaryCrash.deep.test.js`: marker commits and process crashes before drain; actual dialysis start and OT theatre use before drain cannot proceed unsafely.
- [ ] `holdBetweenCaptureAndUse.deep.test.js`: capture/issue → new hold → actual session/theatre start refused.
- [ ] `abortedUseTermination.deep.test.js`: in-progress `completeSession(early_termination)` closes usage non-available without circular processing prerequisite.
- [ ] `erroneousHoldReleaseKeepsProcessingObligation.deep.test.js`: erroneous hold release cannot restore available while any other obligation remains.
- [ ] Dialysis: capture -> use -> end -> live decision -> statutory settlement -> not-established attempt -> release -> residual check -> re-capture, plus quarantine/hold/adjudication/reprocessing/re-capture.
- [ ] OT: issue -> theatre use -> return -> hold/release -> applicable load -> re-issue, plus cancellation before use and failed-load response.
- [ ] Test `max_cycles` at 1, 2, and unlimited through full lifecycle.
- [ ] Test every matrix cell, unknown/surveillance rules, prion pathway, block-mode preconditions, emergency override, and policy deactivation.
- [ ] Test relationship mismatches, end-of-use preconditions, retrospective capture provenance, hold arriving while captured, and distinct non-exposure dispositions.
- [ ] Test the outbox crash window and `tested_on = NULL` unbounded lookback.
- [ ] Run five races with two connections and a lock barrier, 20 times each:

  1. concurrent first capture of one unseen serial;
  2. exposure hold versus authorised release/reprocessing;
  3. set issue versus load outcome.
  4. set return versus load outcome;
  5. overlapping multi-device loads with sorted locks.

### 8.2 Mutation/liveness checks

- [ ] Remove each dedication, hold, ceiling, end-of-use, applicable-load, release-criteria, and relationship guard once; confirm the named test fails; restore.
- [ ] Remove actual-use admission from `startSession` and `markTheatreUse`, late-failure invalidation, legacy readiness import, obligation evaluation, stable delivery result, or event-application uniqueness one at a time; confirm the corresponding named closure suite turns red.
- [ ] Remove `applyLoadOutcomeTx` only from `createSterilizationLoad`; confirm both discovery-population and creation deep tests fail.
- [ ] Shrink the discovery regex; confirm the population snapshot fails rather than passing over fewer call sites.
- [ ] Reintroduce `Late reactive hcv` into a device reason; confirm the device-field canary and code-vocabulary test fail.
- [ ] Poison snapshot reasons, error details, and audit history independently; confirm each attributed canary assertion fails.
- [ ] Add `required_class: 'hbsag'` beside benign `required_group: 'Bay 1'`; confirm every fixed D11 role fails regardless of D10 while the benign group remains accepted.
- [ ] Mutate `cohortCompatibilityTx` to return the derived profile beside its verdict; confirm the whole-value marker-class pin turns red. If it stays green, the pin is decorative and stage 2 fails.
- [ ] Mutate the adapter to import the resolver's `CONTRACT_VERSION` instead of using its own hard-coded supported value. Demonstrate the equality comparison becomes tautological and require the mismatched-version refusal test to turn red; if it stays green, the drift pin does not protect the present-and-incompatible case.
- [ ] Remove the isolation fixture, the Decision poison, and the fixed machine id one at a time; confirm the corresponding liveness assertion alone fails.
- [ ] Make missing baseline pass, remove a locked matrix check at service and DB layers, clear historical exposure on release, bypass the generic domain delegate, remove expected-version handling, and move outbox insertion after commit; confirm each named test fails.

### 8.3 CI and activation gate

- [ ] Add `check-dialysis-activation-gate.mjs` to the release check chain. If Plan 4's dialysis arm exists and the real resolver is missing, CI fails.
- [ ] Run the dialysis deep suite under `RPD_REQUIRE_PHASE1=1`; missing Phase 1 is a failure, not a skip.
- [ ] Add the boot-time `dialysisActivationGuard.js`: any active dialysis reprocessing policy with an unavailable resolver refuses startup.
- [ ] Gate the policy activation WRITE itself on resolver v2, admission hooks, stable required exposure consumers, active immutable protocol/device scopes, required suspect-interval/prion capabilities, and valid block-mode isolation mapping. Prove each missing capability refuses atomically.
- [ ] Run backend lint, focused/unit/deep suites, OpenAPI generation/check/core sync/lint budget, Prisma/schema/RLS/seed gates, security checks, Staff analysis/tests/i18n, Admin type-check/lint/format/tests/build.
- [ ] Run the complete backend/Staff/Admin/fresh-database matrix twice on the final implementation tree.
- [ ] Make the final source change before the canonical marker. Then create the no-source-change `[full-ci]` commit and require both `Merge Gate` and `Full Merge Gate` on that exact head.

No skipped dialysis suite, stale head, or manually dispatched diagnostic run counts as stage 2 evidence.

## Task 9: Stage 2 hand-back — draft, no merge, no activation

- [ ] Re-fetch `github/main`, re-scan migration numbers, and resolve `NNN` only if still free while treating 767 as reserved.
- [ ] Attach the final Phase 1 `DialysisIsolationDecision/v2` contract block, the contract owner's 2026-09-07 answer, and the landed resolver/version evidence; do not seek another owner decision, implement migration 767, or silently emulate missing fields.
- [ ] Confirm the implementation diff contains no edits to Phase 1-owned files, migrations 168/418/421-423/565/764-767, or out-of-scope bloodline/procedure-pack activation.
- [ ] Run the role-assignment census and report actual active assignments separately for D10a `DIALYSIS_TECHNICIAN`, D10b `BLOOD_BANK_STAFF`, and D10c `BLOOD_BANK_TECHNICIAN`. Non-assignability is not treated as proof of zero assignments.
- [ ] Run the Phase 2 census and report declared positives, declared-and-evidence-backed negatives, defaults, column-only declared negatives (must be zero), and status/routing differences. State plainly that it gates only the future DROP.
- [ ] Report the five named closure suites, every deep lifecycle result, all five race results, admission-before-drain/replay obligations, call-site populations, canary liveness/mutations, response schemas, fresh-database runs, activation-write probes, and exact full-CI head.
- [ ] State that stage 2 verification is complete or incomplete. Do not collapse skipped/failing evidence into a green summary.
- [ ] State stage 3 prerequisites: tenant-approved nephrology/CSSD/infection-control protocol; immutable device scope/IFU/single-use exclusion; locked/default matrix; TCV/process/residual/surveillance and suspect-interval/prion rules; approved isolation groups/cohort mapping; accepted real v2 resolver; admission-safe durable exposure delivery; named clinical activation authority.
- [ ] Keep the implementation pull request draft, do not mark ready, do not merge, and do not activate a tenant. The owner/merge-authority session decides those actions separately.

Clinical thresholds in the implementation are protocol configuration constrained by conservative floors/defaults; they are not new owner questions. Any genuinely new question discovered during implementation is reported separately and does not silently broaden configuration.

## 5. Owner-review coverage ledger

Every review point and additional release condition appears in both the spec and this plan.

| # | Owner requirement | Plan implementation | Spec |
|---|---|---|---|
| 1 | Marker-free late-reactive writer, sanitised snapshots/reasons, canary breadth, fixed D11 population, approved vocabulary, residual inference, contradiction removed | Tasks 2, 3, 6, 8 | §2 D11, §3.2-3.6, §4.1, §4.3, §4.12, §8 |
| 2 | One domain-aware release, append-only recovery, no deactivation bypass, applicable OT load | §§3.3; Tasks 1, 3, 4, 5, 6 | §4.2, §4.14, §5.6, §6.2 |
| 3 | Historical exposure separate from unresolved hold; adjudication/processing; successful re-issue | §§3.2-3.3; Tasks 1, 3-5, 8 | §4.12, §5.5, §8 |
| 4 | One load-outcome handler incl. creation, discovered call sites, durable event identity, both loads, failure response | Tasks 1, 5, 8 | §4.4, §4.13, §5.2, §8 |
| 5 | Separate evidence/routing/reuse decisions, pathogen matrix, block escapes closed, asymmetric Q1, evidence currency, prion | §§3.1-3.2; Tasks 2, 4, 5 | §3.3-3.4, §4.2a, §5.3, §5.5 |
| 6 | Missing evidence not established, TCV baseline/80% floor, process/residual/integrity, approved basis, exclusions, OT evidence split | Tasks 1, 2, 4, 5, 7 | §1.1, §4.2-4.5, §5.1-5.2 |
| 7 | Null class, null ceiling, 1/2/unlimited semantics, return-before-quarantine, acknowledgement point, distinct dispositions | §§3.1, 3.4; Tasks 2-5, 8 | §3.3, §4.3-4.4, §5.1-5.3 |
| 8 | Relationship integrity, bloodline removal, end-of-use, affirmative un-capture, hold race, retrospective provenance | Tasks 1, 3-5, 8 | §1.1, §4.3-4.8, §5.1-5.2 |
| 9 | Same-transaction outbox, idempotent reconciler, activation prerequisite, NULL-date lookback | Task 3 and Task 8 | §3.2, §4.15, §5.7 |
| 10 | Full asymmetric census, status+routing comparison, preserve provenance, defaults reconciliation, DROP-only gate | Task 4 and Task 9 | §3.3, §7.6, §8 |
| A1 | Lock order, five races, lifecycle/version/operation receipts | §3.4; Tasks 3-5, 8 | §4.3, §4.16, §5.8, §8 |
| A2 | CI fails when activation is possible without real resolver | Tasks 0 and 8 | §7.3, §8 |
| A3 | Named outgoing response validator, nested warnings/errors | Task 6 | §6.6, §8 |
| A4 | D10 per role plus actual-assignment check | Tasks 6 and 9 | §2 D10, §7.6, §9 |
| Approval | Three stages and clinical activation boundary | §1 and Task 9 | §1.2 |
| Baseline | Re-verify current main by function name, including #1025 | §2 and Task 0 | document header and §11 |

## 6. Revision 2 coverage ledger

| # | Owner requirement | Plan implementation | Spec |
|---|---|---|---|
| 1 | Late failure after existing pass; legacy readiness; direct board writes | Tasks 1, 5, 8: occurrence revisions, cycle-neutral import, handler-governed board writes, named test | §4.13, §5.2, §8 |
| 2 | Admission-safe exposure; explicit completion; replay; cath NULL | Tasks 2–3, 8: advisory lock, stable IDs/results/obligations, applications, cath compatibility, named test | §4.15, §5.7, §8 |
| 3 | Reservation vs use/reprocess; last use; retrospective record | Tasks 2, 4–5, 8: mandatory action, actual-use hooks, retrospective command | §5.1–§5.3, §6.1–§6.2 |
| 4 | Abort; separate restoration; all obligations; not-connected | Tasks 3–5, 8: early termination, `restoreUnusedCaptureTx`, obligation evaluator, residual reset | §5.1, §5.5–§5.6 |
| 5 | Patient-blind CSSD; evidence roles/projection; prion boundary | Tasks 2, 5–6, 8: aggregates, logged investigation/evidence, allow-list, specialist operational code | §3.5, §5.2, §6.2, §6.4 |
| 6 | Resolver evidence amendment; domain/prion rules | Tasks 0–2, 5, 9: final 767 §3 contract quoted verbatim, one base date, marker-object ids/dates with `marker` key, independent hard-coded version drift pin, reuse-owned intervals, domain shapes/pathway | §3.3, §4.2a, §5.2–§5.3 |
| 7 | Cohort compatibility and bounded emergency | Tasks 2, 4, 8: profile derived from opted-in markers, verdict-only value pin, selected-active check, one-time fingerprinted pre-schedule authorization | §3.3–§3.4, §5.1, §8 |
| 8 | Enforceable constraints/device pinning/merge/append order/marker tenant | Tasks 1–2, 8–9: exact JSON checks, device FKs, deferrable merge, reverse event link, Phase 1 parent unique | §3.3, §4.2a–§4.15, §8 |
| 9 | Complete lock graph; conflict-safe insert; evidence version; operation receipt | Tasks 1, 3, 5, 8: rewritten CSSD order, safe insert, version + append-only operation, two added races | §4.16, §5.8, §8 |
| 10 | Enforceable device applicability/baseline/immutability/hold timing/suspect interval | Tasks 1–2, 5, 7–8: scope+IFU+single-use, validated model baseline, pinned satisfaction, report | §4.2a, §4.12–§4.13, §5.2, §5.5 |
| S1 | Unknown block-return | Tasks 2, 4–5: both domains use `serology_required`; discard explicit | §5.3 |
| S2 | Deactivation bypass | Tasks 3–5: discover enrolment first; physical history retained | §4.2, §5.2, §5.6 |
| S3 | Cancellation vocabulary | Tasks 3–6: one `pack_condition` contract and two errors | §5.1–§5.2, §6.2, §7.1 |
| S4 | Activation write | Tasks 2, 4, 8: atomic capability validator | §7.3 |
| S5 | Marker-free behavior test | Tasks 2, 6, 8: execute exports and inspect values | §8 |
| S6 | Regex not semantic proof | Tasks 5, 8: population pin plus deep call-graph/races | §5.2, §5.8, §8 |
| S7 | Physical occurrence despite refused release | Tasks 1, 3, 5, 8: occurrence precedes readiness authorization | §4.13, §5.2, §5.6 |

## 7. Final consistency checklist

- [ ] Both documents quote migration 767 §3's v2 block verbatim, use marker object `{ marker, result, tested_on, marker_row_id, source }`, require an independently hard-coded adapter version plus drift pin, and also say 17 Plan 4 relations, six device states, separate processing release and unused restoration, no v2 profile or overdue field, and 75 Staff keys.
- [ ] Both documents use `RPD_DIALYSIS_USAGE_REQUIRED` for a generic dialysis command lacking its usage and do not claim dialysis is refused by the generic route.
- [ ] Both documents say a legacy positive restricts alone and a legacy negative is not evidence.
- [ ] Both documents distinguish exposure history from an active hold and require acceptance through re-issue.
- [ ] Both documents keep `required_group` and prohibit `required_class` in routing payloads.
- [ ] Both documents keep migration `NNN` unresolved and reserve 767 for Phase 1.
- [ ] Both documents name the same five closure suites and five concurrency races.
- [ ] Both documents finish at a draft, unmerged, non-activated hand-back.
