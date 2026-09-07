# Reprocessable Devices Platform Implementation Plan

- Date: 2026-09-05
- Revision: owner review of 2026-09-06, including the revised asymmetric Q1 rule
- Status: **awaits owner design approval; stage 1 of 3**
- Spec: `docs/superpowers/specs/2026-09-05-reprocessable-devices-platform-design.md`
- Verified base: `github/main` at `db30fe80b` on 2026-09-07; highest migration 766
- Future implementation branch: `feat/reprocessable-devices-platform`
- Migration: **`NNN`**, the next free number at implementation push time. Migration 767 is reserved for the Phase 1 dialysis-isolation lane whether or not a `767_*` file exists

This plan implements one patient-blind physical-device register for dialysers and OT instrument sets/trays while keeping patient linkage on usage rows. It preserves dialysis dedication, immutable historical exposure, live-data decisions, atomic un-capture, and the existing cath register. It does not implement the Phase 1 dialysis-isolation resolver or migration 767; it consumes them.

## 1. Approval model and execution boundary

Approval has three independent stages. Passing one does not imply the next.

1. **Revised design approval.** The owner approves the spec and this plan after the 2026-09-06 review. No implementation starts before this approval.
2. **Implementation verification.** The future implementation is exercised through the complete dialysis and OT lifecycles, the three amplified race tests, durable exposure recovery, schema/response validation, mutation checks, fresh-database runs, and the canonical full CI gate. The implementation task remains draft and unmerged at hand-back.
3. **Tenant clinical activation.** A tenant may activate a domain only under an approved nephrology/CSSD/infection-control protocol that records the model/processing basis, pathogen-specific matrix, TCV threshold, process-agent limits, residual-test rule, surveillance intervals, and prion pathway. Durable exposure delivery and the real Phase 1 resolver are activation prerequisites.

The hand-back in Task 9 is for stage 2 evidence. It gives no authority to activate a tenant, mark a pull request ready, or merge.

## 2. Re-verified repository facts

These are the current-code seams. Re-run the named searches at Task 0; line numbers are secondary to function names.

| Function / contract | Verified fact on `db30fe80b` | Plan consequence |
|---|---|---|
| `enrolPatient` (`dialysisService.js:223`) | omitted serology is written with `COALESCE(..., 'negative')` | a legacy negative is not evidence and never clears an analyte |
| `recordReuseRegister` (`dialysisService.js:943`) | compares a client-supplied count only with the session count and upserts the statutory row | derive cycles from the device; settle the statutory row once; use append-only attempts afterward |
| `recordSerology` (`dialysisService.js:1115`) | #1024 stamps the row's tenant; `:1160-1170` promotes only literal `positive` values to the roster columns | Phase 1 owns derivation; a legacy positive restricts without corroboration |
| `addAccess` (`dialysisService.js:309`) | #1024 stamps vascular access with its own tenant | closed baseline item; no Plan 4 edit |
| `ingestMachineObservations` (`dialysisMachineService.js:46`) | #1021 requires tenant scope on the in-progress-session lookup | Task 4 preflight is verify-only |
| `createSterilizationLoad` (`cssdService.js:424`) | derives an initial outcome and directly updates sets/issues, including loads created already passed or failed | creation and transitions must call one load-outcome handler |
| `transitionSterilizationLoad` (`cssdService.js:588`) | repeats the outcome writes | call sites are discovered by scan and pinned by a population snapshot |
| `issueSet`, `transitionIssue`, `cancelIssue` (`cssdService.js:731`, `:807`, `:947`) | issue, return, and cancel mutate the physical set in their existing transactions | hooks stay inside those transactions and follow the common lock order |
| `registerExposureHandler` (`bloodborneMarkerRules.js:227`) and the registration in `cathDeviceReuseService.js:1428` | handler registration is process-local | add the Plan 4 handler to `exposureHandlerBootstrap.js` and make delivery durable |
| `recordMarkerTx`, `recordMarkers`, `recordMarkersFromSignedResults` (`bloodborneMarkerService.js`) | reactive marker rows commit before the current post-commit fan-out | insert the exposure-outbox row in the marker transaction |
| `reconcileTenant` / `reconcileAllTenants` | #1017 re-drives signed-result writers and the operator sweep refuses an empty handler registry | add an outbox-drain phase; do not treat the sweep alone as durable delivery |
| `dbClockAsOf` / `refreshCaseLabReadiness` and the clock guard | #1025 uses the database clock and covers DATE comparisons | recorded baseline only; no Plan 4 contract changes |

`github/main` presently contains neither `resolveDialysisIsolation` nor a `767_*` migration. That absence does not free migration 767. Release CI must fail, not skip green, if dialysis activation is possible before the real resolver is present.

## 3. Non-negotiable contracts

### 3.1 Resolver and asymmetric Q1

The only dialysis isolation input is:

```text
resolveDialysisIsolation({
  tenantId,
  patientUids,
  db,
  includeMarkers = false,
  includeIsolationClass = false
}) -> Map<patientUid, Decision>

Decision.status = restricted | unknown | clear
```

Marker detail and `isolation_class` are opt-in. Exactly two server-side functions may request the class: `assessIsolationTx` for class-to-group routing and `reuseEligibilityTx` for the pathogen-specific reuse matrix. Neither serialises, snapshots, logs, or audits it. With the flag on, `restricted` requires a valid class and `clear`/`unknown` require null. With the flag off, omission is valid and a non-null unrequested class fails closed.

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

### 3.3 One release operation

`releaseToAvailableTx` is the only service path that can make a platform device available. The generic `POST /api/v1/cssd/reprocessable-devices/:id/reprocessed` resolves the domain and delegates:

- dialysis: require `device_usage_id` and the complete statutory evidence, then call `recordDialyserReprocessing` if the statutory row is unsettled or `recordDialyserReprocessingAttempt` after settlement;
- OT: require the applicable passed load containing this set, linked to the correct processing event and compatible with the active protocol.

The generic controller contains no transition logic. A settled `dialyzer_reuse_register` row is never rewritten. Policy deactivation stops new enrolment, capture, processing, and release while preserving tracking, return/settlement, hold placement/release, failure response, and discard.

### 3.4 States, cycles, locks, and receipts

Device states remain `awaiting_reprocessing`, `in_cssd`, `available`, `in_case`, `quarantined`, and `discarded`. `uncapture` is only `in_case -> available`, consumes no cycle, and requires affirmative `sealed_unopened` or `not_connected` evidence. A hold arriving while captured changes the un-capture result to return-plus-quarantine.

`max_cycles` means permitted reprocessing cycles. A device permits `max_cycles + 1` total uses. Capture at the current ceiling is allowed; the next reprocessing is not. Unlimited is null and every comparison has an explicit non-null guard so `Number(null) = 0` cannot create a false ceiling. Cath parity tests cover only the shared input domain.

Every command carries `expected_version` and returns a durable receipt `{ version, audit_id, action }`. Idempotency is bound to the lifecycle version/receipt, not only a from-list.

The documented lock order is: owner row (`dialysis_sessions` or `set_issue_log`) -> named `sterilization_loads` row -> `instrument_sets` row -> `reprocessable_devices` rows in ascending id -> usage -> holds -> dialysis link -> statutory row. This differs from a set-first order because the generic/load commands must establish the authoritative owner and load before locking devices, and the load-outcome path already begins from a locked load. Every function follows one order; no function acquires backward.

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
- [ ] Confirm the Phase 1 resolver contract and migration 767 have landed before enabling or testing the dialysis arm. If absent, non-dialysis implementation may proceed, but stage 2 cannot pass.
- [ ] Scan migrations on `github/main` and every open GitHub branch. Reserve 767 unconditionally and substitute `NNN` only when the implementation is ready to push. Re-scan at Task 9.
- [ ] Create a fresh PostgreSQL test database and record the Node version (`v26.5.0`).
- [ ] Record the discovered current CSSD outcome-write population for `createSterilizationLoad` and `transitionSterilizationLoad`; the snapshot is a deliberate review point, not a hard-coded assumption from this document.

Gate: the worktree is clean, based on the recorded main SHA, and no migration or resolver ownership conflicts exist.

## Task 1: Forward-only schema, integrity, RLS, and seed

Create one forward migration. Do not edit migrations 168, 418, 421-423, 565, 764-767.

- [ ] Create the eleven new tables from spec §4:

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

- [ ] Add forward-only columns/constraints to `dialysis_sessions`, `dialyzer_reuse_register`, `surgical_implants`, `ot_schedules`, `instrument_sets`, `sterilization_loads`, `set_issue_log`, and `clinical_ai_biomed_devices` exactly as the spec requires. Baseline-owned tables are altered only; they are never re-declared inline.
- [ ] Keep the register patient-blind and marker-free. `quarantine_reason` is a fixed non-clinical code, not free text. `exposure_flag` is irreversible history.
- [ ] Make `current_usage_id` point to an open usage belonging to this device through the composite target `(tenant_id, id, device_id)` plus transactional open-row checks.
- [ ] Make the statutory `(device_id, device_usage_id)` pair identify the same device/use and the correct dialysis session.
- [ ] Enforce usage/session/patient and usage/issue/set/device consistency with composite foreign keys where possible and locked transactional checks for the dialysis patient join.
- [ ] Persist both evidence sides: `ready_processing_event_id` at capture and write-once `post_use_processing_event_id` after use. Never rely on the overwritten convenience `set_issue_log.sterilization_load_id` as statutory evidence.
- [ ] Remove bloodlines from the release vocabulary. Refuse `procedure_pack` with `reprocessable = true` at both database and service layers.
- [ ] Require an active `reprocessing_protocols` row before any category becomes reprocessable. Database-lock HBsAg, HIV, and mixed reuse to `no_reuse`; HCV defaults to `no_reuse` and may be `dedicated_reuse` only under the approved protocol.
- [ ] Add baseline TCV provenance, measured TCV, integrity/process parameters, pre-use residual result, release verdict, missing-evidence list, hold adjudication/protocol/evidence, command version, and append-only attempt/event identity exactly as spec §4 defines.
- [ ] Apply tenant RLS, explicit tenant predicates, sequences, runtime grants, and append-only privilege revocation. Add Prisma scalars/indexes without relation fields, update runtime relation lists, schema tests, and seeder overrides.
- [ ] Seed an inactive/dark-safe configuration: no active reprocessable category, conservative matrix, one closed usage, one released hold, one event, one not-established attempt, and one delivered outbox row.

Verification:

- [ ] Run migration-number, immutable-migration, session-GUC, inline-check census, Prisma relation, schema-drift, RLS, grants, and seed-contract gates.
- [ ] Apply all migrations twice to fresh databases. Run the comprehensive seed twice; the second run creates zero duplicates.
- [ ] Probe the relationship constraints with deliberately mismatched device/use/session/issue/set/tenant fixtures.

## Task 2: Pure rules, protocol validation, resolver adapter, and projection

- [ ] Implement `assertDecisionShape` for all three statuses with `includeIsolationClass` on and off. Missing/null class is invalid only for `restricted` when asked; a non-null class is invalid for `clear`/`unknown` and when unrequested.
- [ ] Keep `includeMarkers` and `includeIsolationClass` default-off. Pin the class requester population at exactly `assessIsolationTx` and `reuseEligibilityTx` by function name.
- [ ] Implement three separate decisions:

  - `resolveDialysisIsolation`: what clinical evidence establishes;
  - `assessIsolationTx`: where the patient may dialyse;
  - `reuseEligibilityTx`: whether this physical dialyser may be reprocessed.

- [ ] Implement `reuseEligibilityTx` with conservative protocol defaults: HBsAg no reuse, HIV no reuse, mixed no reuse, HCV per approved protocol, surveillance-overdue handling, active-hold precedence, dedication, and separate `prion_exposure` rules.
- [ ] Remove the former same-patient exposure escape. Same-patient dedication is necessary for the HCV protocol branch but never overrides a `no_reuse` cell.
- [ ] Implement `releaseCriteria`: missing mandatory evidence is `not_established`, never pass. Require baseline TCV or an explicitly approved mid-life alternative; default threshold 80% and prohibit lower values; validate integrity, agent, concentration, contact time, and applicable residual test.
- [ ] Keep OT sterility evidence (load indicators/process event) separate from return inspection/function evidence.
- [ ] Implement the cycle ceiling with an explicit null guard and table-driven lifecycles for 1, 2, and unlimited.
- [ ] Implement approved isolation-group validation and the deny-list. In block mode, refuse unregistered machines and unmapped classes; refuse enabling block until approved mappings cover active machines. Emergency use is an explicit role-gated command, not a warn fallback.
- [ ] Implement distinct non-exposure hold/disposition codes, including `serology_required`, `post_issue_restriction`, and `inspection_failed`.
- [ ] Implement `projectUsageForRole` and `projectReuseRestrictionForRole` so non-audience responses sanitise nested snapshot reasons, marker arrays, class fields, hold marker pointers, and error details while preserving stable keys where the existing projection contract requires them.

Unit gate: rules, adapter, projection, null-ceiling, 1/2/unlimited lifecycle, matrix, protocol, deny-list, and parity-over-shared-domain tests all pass.

## Task 3: Core lifecycle, holds, one release path, and durable exposure delivery

- [ ] Implement register mint/read, capture, return, un-capture, quarantine, release, discard, label, and history operations in `reprocessableDeviceService.js`.
- [ ] Define `LOCK_ORDER` once and pin every `FOR UPDATE` sequence. Multiple devices lock in ascending id.
- [ ] Require `expected_version` on queue/lifecycle commands and return the durable audit-backed receipt. Test stale-version refusal and exact idempotent replay.
- [ ] Keep `quarantine` out of the `in_case` from-list. Dialysis and OT close the usage with `return` before quarantine in the same transaction.
- [ ] Require affirmative unopened/unconnected evidence for un-capture. Re-check active holds after locking; a hold arriving while captured produces return-plus-quarantine, never available.
- [ ] Record implicit capture at reuse time as `capture_provenance = 'retrospective'`, with current recording time and an explicit census count.
- [ ] Implement `placeHoldTx`, `releaseHoldTx`, and hold satisfaction. Infection-control release records adjudication, required protocol, evidence, actor, and role. Reprocessing satisfies the release condition; it never erases historical exposure.
- [ ] Implement `releaseToAvailableTx` as the sole availability path. Pin every availability write and every generic-controller delegation. Deactivated policy refuses new processing/release but still allows settlement, tracking, hold work, failure response, and discard.
- [ ] Replace every Plan 4 exposure writer, including the late-reactive handler, with `{ exposure_flag: true }` plus a non-clinical hold code. Put detailed evidence only on the authorised record pointer. Audit only hold ids and reason codes.
- [ ] Add the Plan 4 handler import to `exposureHandlerBootstrap.js`; keep the bootstrap the one registry authority.
- [ ] Insert `bloodborne_exposure_outbox` from `recordMarkerTx` in the same transaction as the reactive marker. The two public writers retain post-commit fan-out only as the fast path.
- [ ] Implement an idempotent reconciler with `FOR UPDATE SKIP LOCKED`, lease/reap, per-handler acknowledgements, bounded backoff, failed/operator-redrive state, scheduler drain, on-demand governance drain, and a first-step drain in the #1017 reconciliation script.
- [ ] Define `tested_on = NULL` as an unbounded historical lookback. The handler applies the hold to every affected use and records the non-clinical code `exposure_undated_declaration`; infection control reviews it.

Deep recovery gate: force the post-commit notifier to fail, verify marker+outbox commit without a hold, drain once to create exactly one hold/alert/notification, drain again with unchanged counts, then complete release -> processing -> successful re-issue while `exposure_flag` remains true.

## Task 4: Dialysis capture, routing, statutory settlement, attempts, and census

- [ ] Verify only: `ingestMachineObservations` still binds the session lookup to `tenantId`; do not create another tenant-scope commit.
- [ ] Bind `dialysisIsolationAdapter.js` to the real Phase 1 resolver. Product code has no stub or fallback to roster columns.
- [ ] Add capture by serial/tag with physical identity minting, patient dedication, baseline TCV provenance, residual-test requirement, live decision snapshot, version receipt, and transactionally consistent `dialysis_sessions.dialyser`/`reuse_count` fields.
- [ ] Integrate by function name: `scheduleSession` evaluates before insert; `startSession` and machine reassignment evaluate while locked; `cancelSession` calls atomic un-capture before its status update; `recordReuseRegister` delegates to the new domain command while dark behavior stays unchanged for sessions with no platform usage.
- [ ] Persist only `required_group` and non-clinical warning codes. No `required_class`, marker, or reason reaches a session, response, error, or audit row.
- [ ] Under block mode, unregistered machine, unmapped class, and mismatch all refuse. The switch to block requires validated approved groups and active-machine coverage. Add a separately authorised emergency override with its own role set, reason, actor, receipt, and audit.
- [ ] Require the dialysis use to be completed/aborted before statutory settlement (`RPD_USE_NOT_ENDED`). Apply return before quarantine atomically.
- [ ] Record all mandatory release evidence and one of `released`, `not_established`, or a discard verdict on the statutory row. Once settled, route later legitimate work to `dialyser_reprocessing_attempts`; never update the statutory evidence row.
- [ ] Make the generic `/reprocessed` endpoint delegate to the same statutory command or append-only attempt based on `device_usage_id` and settlement state. A domain-specific role check applies before delegation.
- [ ] At issue/capture time, check active holds rather than `exposure_flag`. A historically exposed device that completed adjudication and processing can be re-issued to its dedicated patient if the matrix permits.
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

Dialysis deep gate: full capture/use/end/settle/attempt/re-capture lifecycle; 1/2/unlimited ceilings; every matrix cell; missing evidence; residual test; dedication; snapshot-vs-live decision; warn/block/emergency routing; hold arriving during capture; un-capture conditions; generic delegation; race tests 1 and 2; marker-free device/error/audit assertions; real Phase 1 resolver only.

## Task 5: OT/CSSD load identity, issue lifecycle, and failure response

- [ ] Create `applyLoadOutcomeTx` and call it from both `createSterilizationLoad` and `transitionSterilizationLoad`, including loads created already passed or failed.
- [ ] Build `cssdLoadOutcomeCallSites.test.js` by scanning for all outcome writes, assigning them to containing functions, and asserting both delegation and a reviewed population snapshot. Do not maintain an enumerated allow-list that can silently shrink.
- [ ] Write one exactly-once `device_processing_events` row per device/load/set/outcome with an applicability window tied to the device's last return. A metadata edit to an old passed load cannot count a cycle or release a newly returned set.
- [ ] Preserve `ready_processing_event_id` before the use and write-once `post_use_processing_event_id` after it.
- [ ] Integrate `onSetIssuedTx`, `onSetReturnedTx`, and `onIssueCancelledTx` inside `issueSet` and `transitionIssue`. Validate issue/schedule/patient/set/device relationships while the owner rows are locked.
- [ ] At issue time, refuse active holds, not historical exposure. If a restriction arrives after issue, place `post_issue_restriction`; acknowledgement is obtained at infection-control release, not fabricated at the earlier issue.
- [ ] Keep routine blood-borne holds separate from `prion_exposure`. Routine validated processing may satisfy the former after adjudication; prion/CJD follows the protocol's discard or explicit IC pathway.
- [ ] Require affirmative `sealed_unopened` for cancellation. An opened/connected or already-used set must return and settle; an active hold wins over un-capture.
- [ ] Require the generic OT `reprocessed` command to name the passed load that contains this set, follows its return, matches the allowed cycle/protocol, and has no prior event for this device.
- [ ] Keep sterility evidence separate from mechanical inspection/function. A failed inspection has its own hold and cannot be cleared merely by a passed load.
- [ ] Implement the minimum load-failure response now: identify every device prepared by the failed/invalidated event, identify affected usages and patients, place holds that prevent further issue where indicated (including `pending_return` for an in-case set), create the patient safety alerts, and notify infection control. Only the dashboard is deferred.

OT deep gate: dark vs active vs deactivated policy; creation-time and transition-time outcomes; exactly-once event identity; old-load non-applicability; both load links; restricted/unknown/post-issue/inspection/prion holds; full authorised-release-processing-reissue acceptance; cancellation conditions; minimum failure response; generic applicable-load refusal; race test 3; marker-free responses/audits.

## Task 6: Routes, role gates, OpenAPI, response validation, and canary

### 6.1 Routes

- [ ] Dialysis: capture/read dialyser, append-only attempts, emergency isolation override, existing reuse-register delegation, machine reassignment, machine master, and cancel hook.
- [ ] CSSD: list platform devices, list/release holds, label, receive, one generic domain-aware `reprocessed`, quarantine, release, discard, issue/cancel hooks, and load affected-device/usage results.
- [ ] Theatre: `GET /api/v1/theatre/:id/reprocessable-sets` with projected restriction and both load-evidence sides.
- [ ] Governance: settings, policies, protocols, outbox drain, and device history with per-patient HIPAA access logging.
- [ ] Apply the resolved domain's role gate to generic reprocessing. All mutation guards run before idempotency-key claim.
- [ ] Define hold-release and emergency role sets as intersections with their mounts. Add an actual-assignment census for `DIALYSIS_TECHNICIAN`, `BLOOD_BANK_STAFF`, and `BLOOD_BANK_TECHNICIAN`; D10a, D10b and D10c remain separate decisions and are each NO; the census verifies that no actual assignment invalidates that baseline.

### 6.2 OpenAPI response enforcement

- [ ] Add `reprocessableDevices.mjs`, register every operation, and set `additionalProperties: false` on every response object, nested warning, receipt, hold, affected-device/usage item, and error detail.
- [ ] Name the test validator: `apps/backend/src/tests/helpers/assertSchema.js` with `assertResponse`, `assertData`, and `assertErrorBody` compiled from generated OpenAPI.
- [ ] Validate one success response for every operation and every documented error body in `reprocessableDevicesOpenApiContract.test.js`. Validate deep-suite readbacks with `assertData`.
- [ ] Do not claim OpenAPI validates production responses by itself. The named tests are the enforcement boundary.

### 6.3 Disclosure canary

- [ ] Add `/api/v1/dialysis`, `/api/v1/cssd`, `/api/v1/theatre`, and `/api/v1/reprocessing` to the existing canary.
- [ ] Poison and walk device fields, `reuse_screen`, `post_use_screen`, service error details/error bodies, and audit-derived history responses.
- [ ] Run the D11 class-in-routing check for every role in a fixed `D11_FIXTURE_ROLES`, independent of D10 and independent of the serology audience complement.
- [ ] Attribute liveness separately: counters prove the walker visited Decision and warning nodes; an entitled response proves poisoned restriction reasons arrived; a fixed `machine_id` proves the isolation fixture arrived; the class mutation proves the value sentinel bites. None substitutes for another.
- [ ] Regenerate the reachable-route snapshot deliberately, inspect every added line, and pin the new population.
- [ ] Resolve the old contradiction: no deep test expects a marker on a device. The positive assertion is `exposure_flag = true`, an active hold pointing to the authorised evidence row, and no marker word in the device JSON.

## Task 7: Admin and Staff surfaces

### 7.1 Admin

- [ ] Add the CSSD domain filter, platform device actions, label, holds/adjudication dialog, version-conflict reload, and load failure results.
- [ ] Add reprocessing settings/policies/protocols with the three locked matrix cells, HCV choice, TCV floor, mid-life baseline alternatives, process-agent bounds, surveillance, prion rule, approved isolation-group vocabulary, and retirement/deactivation impact.
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

- [ ] Dialysis: capture -> use -> end -> live decision -> statutory settlement -> not-established attempt -> release -> residual check -> re-capture, plus quarantine/hold/adjudication/reprocessing/re-capture.
- [ ] OT: issue -> theatre use -> return -> hold/release -> applicable load -> re-issue, plus cancellation before use and failed-load response.
- [ ] Test `max_cycles` at 1, 2, and unlimited through full lifecycle.
- [ ] Test every matrix cell, unknown/surveillance rules, prion pathway, block-mode preconditions, emergency override, and policy deactivation.
- [ ] Test relationship mismatches, end-of-use preconditions, retrospective capture provenance, hold arriving while captured, and distinct non-exposure dispositions.
- [ ] Test the outbox crash window and `tested_on = NULL` unbounded lookback.
- [ ] Run the three races with two connections and a lock barrier, 20 times each:

  1. concurrent first capture of one unseen serial;
  2. exposure hold versus authorised release/reprocessing;
  3. set issue versus load outcome.

### 8.2 Mutation/liveness checks

- [ ] Remove each dedication, hold, ceiling, end-of-use, applicable-load, release-criteria, and relationship guard once; confirm the named test fails; restore.
- [ ] Remove `applyLoadOutcomeTx` only from `createSterilizationLoad`; confirm both discovery-population and creation deep tests fail.
- [ ] Shrink the discovery regex; confirm the population snapshot fails rather than passing over fewer call sites.
- [ ] Reintroduce `Late reactive hcv` into a device reason; confirm the device-field canary and code-vocabulary test fail.
- [ ] Poison snapshot reasons, error details, and audit history independently; confirm each attributed canary assertion fails.
- [ ] Add `required_class: 'hbsag'` beside benign `required_group: 'Bay 1'`; confirm every fixed D11 role fails regardless of D10 while the benign group remains accepted.
- [ ] Remove the isolation fixture, the Decision poison, and the fixed machine id one at a time; confirm the corresponding liveness assertion alone fails.
- [ ] Make missing baseline pass, remove a locked matrix check at service and DB layers, clear historical exposure on release, bypass the generic domain delegate, remove expected-version handling, and move outbox insertion after commit; confirm each named test fails.

### 8.3 CI and activation gate

- [ ] Add `check-dialysis-activation-gate.mjs` to the release check chain. If Plan 4's dialysis arm exists and the real resolver is missing, CI fails.
- [ ] Run the dialysis deep suite under `RPD_REQUIRE_PHASE1=1`; missing Phase 1 is a failure, not a skip.
- [ ] Add the boot-time `dialysisActivationGuard.js`: any active dialysis reprocessing policy with an unavailable resolver refuses startup.
- [ ] Run backend lint, focused/unit/deep suites, OpenAPI generation/check/core sync/lint budget, Prisma/schema/RLS/seed gates, security checks, Staff analysis/tests/i18n, Admin type-check/lint/format/tests/build.
- [ ] Run the complete backend/Staff/Admin/fresh-database matrix twice on the final implementation tree.
- [ ] Make the final source change before the canonical marker. Then create the no-source-change `[full-ci]` commit and require both `Merge Gate` and `Full Merge Gate` on that exact head.

No skipped dialysis suite, stale head, or manually dispatched diagnostic run counts as stage 2 evidence.

## Task 9: Stage 2 hand-back — draft, no merge, no activation

- [ ] Re-fetch `github/main`, re-scan migration numbers, and resolve `NNN` only if still free while treating 767 as reserved.
- [ ] Confirm the implementation diff contains no edits to Phase 1-owned files, migrations 168/418/421-423/565/764-767, or out-of-scope bloodline/procedure-pack activation.
- [ ] Run the role-assignment census and report actual active assignments separately for D10a `DIALYSIS_TECHNICIAN`, D10b `BLOOD_BANK_STAFF`, and D10c `BLOOD_BANK_TECHNICIAN`. Non-assignability is not treated as proof of zero assignments.
- [ ] Run the Phase 2 census and report declared positives, declared-and-evidence-backed negatives, defaults, column-only declared negatives (must be zero), and status/routing differences. State plainly that it gates only the future DROP.
- [ ] Report every deep lifecycle result, the three race results, outbox crash/replay result, call-site populations, canary liveness/mutations, response-schema results, fresh-database runs, and exact full-CI head.
- [ ] State that stage 2 verification is complete or incomplete. Do not collapse skipped/failing evidence into a green summary.
- [ ] State stage 3 prerequisites: tenant-approved nephrology/CSSD/infection-control protocol; model/processing basis; locked/default matrix; TCV/process/residual/surveillance rules; approved isolation groups; real resolver; durable outbox; named clinical activation authority.
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
| A1 | Lock order, three races, lifecycle/version receipts | §3.4; Tasks 3-5, 8 | §4.3, §5.8, §8 |
| A2 | CI fails when activation is possible without real resolver | Tasks 0 and 8 | §7.3, §8 |
| A3 | Named outgoing response validator, nested warnings/errors | Task 6 | §6.6, §8 |
| A4 | D10 per role plus actual-assignment check | Tasks 6 and 9 | §2 D10, §7.6, §9 |
| Approval | Three stages and clinical activation boundary | §1 and Task 9 | §1.2 |
| Baseline | Re-verify current main by function name, including #1025 | §2 and Task 0 | document header and §11 |

## 6. Final consistency checklist

- [ ] Both documents say 11 new tables, two append-only tables, six device states, one availability service, two class-requesting functions, and 75 Staff keys.
- [ ] Both documents use `RPD_DIALYSIS_USAGE_REQUIRED` for a generic dialysis command lacking its usage and do not claim dialysis is refused by the generic route.
- [ ] Both documents say a legacy positive restricts alone and a legacy negative is not evidence.
- [ ] Both documents distinguish exposure history from an active hold and require acceptance through re-issue.
- [ ] Both documents keep `required_group` and prohibit `required_class` in routing payloads.
- [ ] Both documents keep migration `NNN` unresolved and reserve 767 for Phase 1.
- [ ] Both documents finish at a draft, unmerged, non-activated hand-back.
