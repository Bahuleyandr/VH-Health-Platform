# Cath-lab readiness checklist never restricts — design

- Date: 2026-09-06 (revision 1); revision 2: 2026-09-07; **revision 3: 2026-09-07** — both owner reviews of PR #1023 are answered point by point
- Status: **draft, revision 3, awaiting owner design approval of the documents**. Docs only; no code on this branch. Revision 3 closes the owner's seven remaining issues and every row of “Further corrections” without reopening the five settled owner decisions or the non-restrictive principle.
- Base: `github/main` at **`db30fe80b`** (newer than the required `5857298dc`). That tree **includes #1018** (`feat/cath-readiness-followups`, head `a0144fc00`, merged as `3f3959306`) and **#1022** (`fix/cath-readiness-date-only-external-evidence`, head `9d730a417`, merged as `35a231238`). This lane builds on current `main`; nothing is pending upstream. Every code citation is by **function name** against that tree, re-verified 2026-09-07 (§16); line numbers are not load-bearing.
- #1018's shape, **verified on `main`** (no longer a Task 0 question): `waiveLabItem` is unguarded after start and derives `recorded_after_start`; `unwaiveLabItem` **still throws 409 `CATH_LAB_READINESS_CASE_STARTED`** (record-yes / lift-no). Decision 9's branch is therefore **KEPT** (§3 decision 9, §5.3): the code keeps exactly one thrower after this lane removes the order-missing and outside-result ones.
- Predecessors: `2026-09-04-cath-pre-procedure-lab-readiness-design.md` (Plan 3, shipped as #1008) and its plan `2026-09-04-cath-lab-readiness.md`; #1018 (waiver exit, day-list summary, rules/actions/persistence split, late waivers); #1022 (date-only outside reports read as calendar dates — it is why `externalReportedMs` exists and why "unparseable" and "future-dated" are distinct causes in §5.6).
- Plan: `docs/superpowers/plans/2026-09-06-cath-readiness-never-restricts.md`.


> **Migration number.** `NNN` = the next free migration number ABOVE 767 at push time (768 unless claimed). **767 is NOT this lane's:** it is reserved by the merge-authority session's Phase 1 isolation-derivation lane (dev-1b). Task 0 must re-check the free number when the branch is pushed; any lane that claims a number it does not own collides with the immutability gate.

## 0. What revision 3 changes, point by point (owner review 2026-09-06)

Revision 2's answers remain in force except where the table below tightens them. This table is the controlling revision-3 delta.

| Owner point | Revision-3 answer | Where |
|---|---|---|
| 1. Replay must be reachable; delayed first delivery must be fenced | The status handler normalises the requested target, refuses `cancelled`, and dispatches `in_progress` to `startCaseTx` **before** ordinary transition validation. Every case response carries a server-issued `lifecycle_token`; it rotates on cancellation and reopening, including cancel/reopen before the first start. Start, consent, time-out and procedure-log writes require `expected_lifecycle_token`. Start `command_id` replay and procedure-log creation idempotency are separate; both are checked before insertion. | §4.2, §4.3, §4.7, §4.10; Plan Tasks 3–4 |
| 2. Start must not wait behind lab resolution; Staff must load cached state | Refresh is split into an unlocked resolution phase and a bounded publish phase. Only the publish phase briefly locks the case to compare lifecycle/cache generation; no patient evidence query runs while that lock is held. Staff loads the last committed picture through the cached-read contract and schedules refresh after the response. A real two-connection test pauses resolution while its lab locks are held and proves Start commits independently. | §4.5, §5.1, §6.3; Plan Tasks 3, 4, 7 |
| 3. Attempt history end to end | `cath_lab_attempt_readiness_records` stores consent/time-out current and immutable at-start evidence by `(tenant_id, case_id, procedure_attempt)`; client history is rejected and evidence references are archived server-side. Procedure logs carry `procedure_attempt`, `lifecycle_token`, and a separate `log_command_id`. The report joins the attempt record, never the mutable current check. | §4.3, §4.7–4.10, §6.5, §7.2–7.3, §8; Plan Tasks 1, 3, 4, 6 |
| 4. Unknown vs not performed; clinical vs recording time | Pending means `not_documented` / `performance_unknown`, never `not_performed`. `not_performed` requires an explicit declaration. `attempt_started_at` is the clinical occurrence and may be null; `attempt_start_recorded_at` is the server recording time and is the active-attempt discriminator. Status Start records a staff-confirmed-now clinical instant; a retrospective finalized log supplies a clinical instant plus provenance or leaves clinical timing unknown. One database `clock_timestamp()` value is bound to the case projection, snapshot, command record and canonical event. | §4.7, §4.9, §7.3, §8; Plan Tasks 1–3, 6 |
| 5. Age-only needs evidence and policy fingerprints | Each item persists a SHA-256 evidence fingerprint, policy fingerprint and last accepted evidence independently of display state. `aged_out` carries only when both fingerprints are unchanged. Same-id corrections, backward timestamp corrections, explicit withdrawal and policy edits cannot inherit it; lookback exclusion is unknown, not withdrawal; a null prior fingerprint is bootstrap, not policy change. | §5.6, §8; Plan Tasks 1, 2, 4 |
| 6. Consent record is conditional; legacy is server-owned | Patient/representative authority requires an evidence reference and scope (plus representative reference where applicable) and a communication mode. Emergency basis has no fictitious mode; it requires a documentation reference or attested justification. No default enum list is called a complete hospital policy: clinical/legal governance approves each tenant policy/version before activation. Legacy acceptance uses a migration-established server provenance marker, never absence or a client timestamp. | §4.3, §13; Plan Tasks 1, 3, 7 |
| 7. Migration preflight and compatibility | Rollout is an explicit preflight → quiesce old writers → expand → classified backfill → enforce → deploy/readback sequence with rollback points. Inconsistent existing rows stop rollout for an owner-approved remediation; creation time is never invented as a historical start. CHECKs prove only timestamp/status shape, not consent or use of `startCaseTx`; application restrictions and source pins remain authoritative. | §8, §13–14; Plan Tasks 1, 9 |
| Further: active-attempt end invariant | The CHECK directly requires `actual_end_at IS NULL` while `status = 'in_progress'`; mutation 15 asserts this invariant rather than relying on the preserved first-start timestamp. | §8, §12; Plan Tasks 1, 4, 9 |
| Further: durable audit and tenant binding | Report access uses a required audit insert with explicit `tenant_id`; failure returns 500 and no report body. A non-default-tenant DB test reads the actual audit row. | §6.3, §7.4; Plan Tasks 4, 6 |
| Further: realtime path | Sign-off commit → readiness publish commit → `staff:lab` emission → delivery → reload is tested. Reconnect reloads immediately; debounce has a 2 s maximum wait; monotonic request generations prevent an older response replacing a newer picture. | §6.3; Plan Tasks 4, 7 |
| Further: EXPLAIN acceptance | The predicate remains index-friendly, but acceptance is bounded buffers/work on a statistically refreshed, representative-selectivity fixture; it does not require one plan node on every tiny fixture. | §7.2; Plan Task 6 |
| Further: new-writer pin | The source guard scans SQL and ORM case writes, asserts the measured 9 UPDATE + 2 INSERT population, and is unit-tested with newly introduced parameterised-SQL and ORM writers that the guard rejects by name. | §4.3, §12; Plan Tasks 3–4 |
| Further: privacy survey | The canonical-timeline reader survey, reachable-role matrix and nested-payload projection tests are a release condition, not an optional follow-up. Current `main` has two route callers of `readCanonicalPatientTimeline`; both pass through `patientAccessGuard`. | §6.5, §12, §16; Plan Tasks 0, 5, 9 |
| Further: PR migration claim | The PR description must name migration `NNN` as the next free number above 767 and must not claim 767. | §8, §13; Plan Tasks 0, 1, 9 |

### Revision-2 corrections retained

| Owner point | Answer | Where |
|---|---|---|
| 1. Creation bypass — `createCase` accepts any `CASE_STATUSES` value | Ordinary creation restricted to `CREATABLE_STATUSES = ['requested','scheduled','readiness_pending']`; the route validates; `in_progress` / `completed` / `cancelled` / `ready` refused with 400 `CATH_LAB_CASE_STATUS_NOT_CREATABLE`; migration NNN's CHECK makes a running row without an attempt start impossible at the database; the source pin covers every `INSERT INTO cath_lab_cases` **and** every `UPDATE cath_lab_cases` as a named population with a **known count** (9 UPDATE + 2 INSERT sites after the lane, by `path:function`; a write site reformatted out of the regex shrinks the list and fails loudly); no upsert on the table; route-level test. Historical import is a separate, explicitly governed path and is **out of scope**. | §3 d.14, §4.11, §4.3 pins, §8, §12 |
| 2a. Generic status endpoint reopens | `transitionCaseStatus` short-circuits on `status === 'cancelled'` **before** the table check and answers 409 `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED` naming `/reopen`; the table entry stays for consistency; tested. | §3 d.15, §4.2, §4.8 |
| 2b. Reopen precondition; signature mismatch | `reopenCaseTx` asserts `cathCase.status === 'cancelled'` explicitly, then the table check; `/reopen` tested against every non-cancelled status (incl. `scheduled`); signature is `reopenCaseTx(tx, { tenantId, cathCase, reason, context })` and it cleans `reason`, not `input.reason`. | §3 d.15, §4.8 |
| 3. `recordProcedureLog` leaves `requested` undefined; draft logs | Exhaustive outcome table by case status × log status; a **draft log does not start the case**; `requested` / unexpected refused before insertion with 409 `CATH_LAB_CASE_START_NOT_ELIGIBLE` naming the next action. | §3 d.16, §4.2 |
| 4. Reopen of a previously started case | First-class `procedure_attempt`; operational start is `attempt_start_recorded_at`, clinical occurrence is nullable `attempt_started_at`, and `actual_start_at` is first-start history. Reopen opens N+1 only after a recorded start, resets consent/time-out projections, preserves server history, and rotates lifecycle token. | §3 d.17, §4.9, §8 |
| 5. Start waits on the lab rail | The start reads the **last committed** readiness picture, never awaits a refresh, schedules one after commit through `scheduleReadinessRefresh`; snapshot records `readiness_picture_at` and `lab_component_status`; missing cached rows → `missing_lab_items: null` and `lab_component_status: 'unavailable'`, never `[]`; tested with a never-settling refresh. | §3 d.18, §4.5 |
| 6. `state === 'stale'` ≠ age-only | Cause, evidence fingerprint, policy fingerprint and independently retained accepted evidence are persisted; age-only carry requires both fingerprints to match. | §3 d.19, §5.2, §5.6 |
| 7. Start replay after cancel → reopen | Stable Start command plus server lifecycle token; replay is reachable before transition validation; cancel/reopen rotate the token, fencing even a delayed first delivery. | §3 d.20, §4.10 |
| 8. Consent vs emergency authority; time-out | Authority-conditional evidence under an approved tenant policy; emergency basis has no mode; legacy/provenance is server-owned. Time-out absence is unknown and explicit attestation alone yields `not_performed`; clinical and recording clocks stay separate. | §3 d.21–22, §4.3, §4.7 |
| Live updates | Commit-to-emission-to-render test, bounded debounce, reconnect reload and monotonic stale-response guard. | §6.3, §12 |
| `resulted_after_start` semantics | Renamed **`received_after_start`** (a receipt marker, `lab_results.received_at`) with the transaction-timestamp limitation stated; a separate **`finalised_after_start`** defined from `signed_off_at`. | §3 d.24, §5.4 |
| Monthly report: identifiable, scope, audit, predicate, count | Attempt-keyed event report; explicit-tenant fail-closed access audit; index-friendly predicate with representative bounded-work EXPLAIN criteria. | §3 d.23, §7 |
| Free-text disclosure | Every free-text field this design writes is enumerated with its readers; sentinel tests extended to each reader and to CSV. | §6.5 |
| Error-code coverage | A second overlay enum, `CASE_LIFECYCLE_ERROR_CODES`, and the source pin scans the case-lifecycle throw sites for it in both directions. | §9 |
| Dependency baseline | Current `github/main` `db30fe80b` or newer; #1018 and #1022 merged; `unwaiveLabItem` still throws `CATH_LAB_READINESS_CASE_STARTED` (decision 9 KEPT). | header, §15, §16 |

## 1. Principle and problem

Owner principle, verbatim (2026-09-06):

> in emergencies with no reports immediately available we will proceed with no reports and we might add while the procedure is ongoing and the reports become available; we do not want the pre-cath checklist to be restrictive as principle.

The design goal that follows from it: **the pre-cath checklist informs and records; it never blocks and never freezes. Lateness is marked, never refused.** The principle is general — it is not scoped to `urgency = emergency` — so nothing below keys a permission on urgency; urgency is recorded so the pattern can be reviewed. There is exactly one hard block, and it is not a readiness check in the checklist's sense: **consent — more precisely, the documented authority to proceed** (§4.3).

The owner's five decisions (2026-09-06), each confirmed with dev-1b, unchanged in revision 2:

1. **The principle** above.
2. **Post-start waivers: record-yes / lift-no** — built on #1018 (merged); this lane assumes it and does not re-open it.
3. **No second signature and no role restriction** on "start with checks pending": one reason line, the audit row and the at-start snapshot suffice.
4. **A monthly report** of starts-with-checks-pending (§7).
5. **Consent is compulsory before the procedure** — the single hard block (§4.3).

Facts, verified on `github/main` `db30fe80b` (§16 is the citation ledger):

**(a) The checklist blocks a normal start, and there is no bypass through the transition table today — but there is one through creation.** `CASE_TRANSITIONS` (`cathLabService.js`) reaches `in_progress` only from `ready`. `assertReadinessComplete` (throws 400 `CATH_LAB_READINESS_BLOCKED` unless `evaluateReadinessGate` finds every required check of `READINESS_TYPES` in `READINESS_CLEAR_STATES`) has **exactly two callers**: `transitionCaseStatus` (for the `in_progress` target) and `recordProcedureLog` (before its force-start). Both run before anything starts. **However** `createCase` accepts `input.status` against the whole `CASE_STATUSES` vocabulary (`const status = input.status ? normalizeStatus(input.status, CASE_STATUSES, 'status') : 'scheduled';`), inserts it directly and seeds the eight checks pending, and `router.post('/cases', requireCathWorkflow, guardCathCaseCreate, …)` passes `req.body` straight through. A `POST /cases { status: 'in_progress' }` therefore manufactures a running case with no `actual_start_at`, no consent assertion and no snapshot; `recordProcedureLog` then treats it as already running and never asserts consent. This is the owner's point 1 and is closed in §4.11.

**(b) After start the checklist freezes.** `refreshOpenCasesForPatient` refreshes only `status IN ('scheduled','readiness_pending','ready') AND actual_start_at IS NULL`. `orderMissingLabs` and `recordExternalLabResult` (`cathLabReadinessActions.js`) refuse a started case with 409 `CATH_LAB_READINESS_CASE_STARTED`. `computeCheckDecision` (`cathLabReadinessRules.js`) gates **both** automation branches on `!started`. #1018 opened the waiver pair with `isAfterCaseStart` and the derived `recorded_after_start`, and kept the un-waive refusal.

**(c) STEMI is display-only here, and it creates the emergency case as `readiness_pending`.** `spawnCathCase` (`stemiPathwayService.js`) inserts the primary-PCI case with the literal `'readiness_pending'`, `urgency = 'emergency'`, seeds the eight checks pending, and never writes `in_progress` or `actual_start_at`. So `readiness_pending → in_progress` (§4.1) is exactly the emergency path, and `'readiness_pending'` is inside `CREATABLE_STATUSES` (§4.11), so nothing in this lane touches the STEMI service.

**(d) The serology disclosure canary is a gate.** `serologyDisclosureCanary.test.js` poisons `lab_results` with a sentinel, walks every GET on the cath, STEMI and governance mounts as every platform role, and asserts (`disclosures()`, which serialises the whole body with `JSON.stringify`) that no non-entitled 2xx body carries the sentinel. It pins the day-list summary's exact key set and snapshots the reachable set per GET. It does **not** today parse a `text/csv` body — §6.5 extends it.

**(e) The Staff app already has a realtime rail.** `packages/vhhealth_core/lib/services/realtime_client.dart` (`RealtimeClient`: `events(channel)`, `connectionState`, `onConnectionStateChange`, `subscribe-denied` handling), `apps/staff/lib/core/widgets/realtime_status_banner.dart` (`RealtimeStatusBanner`: amber "live updates paused / data may be stale" when reconnecting or disconnected, red when a watched channel is denied, `fallbackPoll`), and `cath_lab_screen.dart` already listens to `staff:code-stemi` with a 400 ms debounced reload. The backend's `emitLabEvent(kind, { tenantId })` (`realtimeEmitter.js`) broadcasts `staff:lab` — `'result-signed'` from the sign-off path and `'result-pending'` from manual/outside-result entry in `labResultsService.js` — tenant-scoped, staff-only per `channelAuth.js`. §6.3 uses exactly that rail.

Two more facts that shape the design:

- **The Staff app cannot start a case today.** No client drives `POST /cath-lab/cases/:id/status` or `/procedure-logs`. "Start" is the first start affordance in Staff.
- **The cath mount never admits QUALITY_OFFICER**; the monthly report follows `cathDeviceHistoryHandler` — one handler on the cath mount and the governance mount (§7).

## 2. What does NOT change

- **The gate still drives `ready` vs `readiness_pending` for the board.** `evaluateReadinessGate`, `recomputeCaseStatusTx` and `updateReadinessCheck`'s status rewrite (`WHEN status IN ('scheduled','readiness_pending','ready')`) keep deciding between those two pre-start statuses exactly as today.
- **The STEMI pathway** (§1c).
- **The critical-warning safety review on a human `labs` pass** (`updateReadinessCheck`, `CATH_LAB_READINESS_REASON_REQUIRED`, `CRITICAL_LAB_ACKNOWLEDGED`). A critical value never blocks (Plan 3, owner decision).
- **Idempotency scopes**: `cath_lab_readiness_order`, `_external`, `_waive`, `_unwaive` unchanged. Start replay uses `command_id`; procedure-log creation uses its distinct `log_command_id`; both also carry the server-issued `expected_lifecycle_token` (§4.10). One middleware scope is added, `cath_lab_case_reopen`, on `POST /cases/:id/reopen` (§4.8).
- **#1018's record-yes / lift-no asymmetry**: `waiveLabItem` after start records with `recorded_after_start`; `unwaiveLabItem` after start refuses. What "after start" means for that refusal is now the **active attempt** (§4.9) — the decision is untouched, its discriminator is made precise.
- The eight `check_type` values; automation altering only rows it set (`auto_managed`); `AUTOMATION_METADATA_KEYS` stripping; RLS; the seven items; the resolver's state vocabulary (`unavailability_cause` is a **cause**, beside the state, never a new state); the roles on every existing route.
- **No new start route.** `POST /cases/:id/status` with `{ status: 'in_progress', reason, command_id, expected_lifecycle_token }` is the start; `POST /cases/:id/procedure-logs` with a `finalized` log is the other. One function behind both (§4.2). `POST /cases/:id/reopen` is added and is deliberately **not** a start route.

## 3. Decisions

Decisions 1–13 are revision 1's, kept by number; decisions 14–25 are revision 2's. Revision 3 amends 2, 5–8 and 17–25 as stated below and adds decisions 26–31.

1. **Consent is the one hard block, and it is enforced in one place.** `assertReadinessComplete` is **replaced** by `assertConsentDocumented` (the old name goes with the full gate; the pin asserts the old name is gone from shipping code): the `consent` check must be `pass` **with a documented authority** (§4.3); `waived` and `not_applicable` do not satisfy it and its `required` flag is not consulted. New code `CATH_LAB_CONSENT_REQUIRED`, 400. *Amended by decision 21*: the pass records **who gave the authority and on what basis** (`authority`) separately from **how it was communicated** (`mode`); `emergency_basis` is an authority, never a waiver, and is never described as "consent obtained".
2. **One start path, one snapshot, one assertion.** `startCaseTx` is the only code that moves a case to `in_progress`, the only code that records an attempt start, and the only caller of `assertConsentDocumented`. `transitionCaseStatus` and `recordProcedureLog` are its only two callers. The source guard pins the measured SQL population (9 UPDATE + 2 INSERT after the lane), scans Prisma/ORM case writes too, and its own tests feed it newly introduced parameterised-SQL and ORM writers and assert the named unknown-writer failure.
3. **`scheduled` and `readiness_pending` may start; `ready` still may.** `START_ELIGIBLE_STATUSES` is derived from the table. `requested` is not added. `cancelled → in_progress` stays impossible.
4. **Reason required only on the explicit start with a pending gate.** `via: 'status'` + gate not clear + empty reason → 400 `CATH_LAB_START_REASON_REQUIRED`. The procedure-record start takes an optional `start_reason`. No second signature, no role restriction, no urgency restriction.
5. **The snapshot is codes and booleans.** It also carries `procedure_attempt`, `lifecycle_token`, `command_id`, `recorded_at`, nullable `clinical_started_at`, `clinical_start_provenance`, `readiness_picture_at`, `lab_component_status` and `consent_authority`; `missing_lab_items` is nullable. Never a lab value.
6. **Attempt history is server-owned.** `metadata.readiness_at_start` is the current projection and the canonical event carries it, but consent/time-out evidence lives in `cath_lab_attempt_readiness_records` keyed by attempt. Its at-start fields are immutable after Start; follow-up fields may change only for that same lifecycle token. Client-supplied history, provenance and evidence-reference archives are rejected.
7. **After start, the checklist keeps living; ageing alone never moves the check; new evidence always does.** “Ageing alone” requires unchanged evidence and policy fingerprints plus `unavailability_cause === 'aged_out'`; display state alone is never sufficient. “After start” is keyed on `attempt_start_recorded_at`; clinical comparisons use nullable `attempt_started_at`.
8. **Lateness is derived, not stored.** `ordered_after_start`, `received_after_start` and `finalised_after_start` compare transaction-recording instants with `attempt_start_recorded_at`. They remain qualified receipt/order/finalisation markers, not clinical chronology.
9. **The two remaining refusals go.** `orderMissingLabs` and `recordExternalLabResult` accept a started case; the order becomes `STAT`. **Settled on `main`**: `unwaiveLabItem` still throws `CATH_LAB_READINESS_CASE_STARTED`, so the code keeps **one** thrower and stays in the overlay's `ERROR_CODES`; only the two operations' 409 lists and the `case_started` description change (§5.3, §15).
10. **The only free text in the picture is projected.** *Amended by revision 3*: there are five free-text fields, including emergency-basis justification, each enumerated with its readers and covered by a sentinel (§6.5).
11. **Monthly report on both mounts, one handler, one role constant.** *Amended by decision 23* (scope, audit, predicate, event count).
12. **`timeout` pending at start** — *replaced by decision 22*. The old sentence ("expected in an emergency") is withdrawn.
13. **A procedure log on a `cancelled` case is refused, and the refusal names the door.** `reopenCaseTx`, `cancelled → readiness_pending`, mandatory reason, own audit action, own route. *Amended by decisions 15, 17 and 20.*
14. **Ordinary creation may only create a pre-start case.** `createCase` normalises `input.status` against `CREATABLE_STATUSES = ['requested','scheduled','readiness_pending']` (400 `CATH_LAB_CASE_STATUS_NOT_CREATABLE` otherwise, raised before any write); `ready` is excluded because it is a gate result, not a booking state; `in_progress`, `completed`, `cancelled` are excluded because a case that starts, ends or is cancelled must do so through the functions that record why. The creation route validates the same list. A **historical-import workflow** (bringing already-finished cases into the register) is a separate, explicitly governed path with its own authority and audit and is **out of this lane's scope**; until it exists there is no way to create a finished case, and that is intended. migration NNN's CHECK (`status <> 'in_progress' OR attempt_started_at IS NOT NULL`) makes the bypass impossible at the database as well (§8).
15. **Only `reopenCaseTx` takes a case out of `cancelled`, and it takes only a `cancelled` case.** `transitionCaseStatus` refuses **every** target on a `cancelled` case with 409 `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED` before consulting the table (the table entry `cancelled: ['readiness_pending']` stays so the vocabulary is honest and `START_ELIGIBLE_STATUSES` derives correctly). `reopenCaseTx` asserts `cathCase.status === 'cancelled'` explicitly and only then runs the table check; `scheduled → readiness_pending` being a legal table transition no longer makes `/reopen` act on a scheduled case.
16. **Procedure-log handling is exhaustive, and a draft never starts a case.** Case status × log status table in §4.2. Starting on a log requires the log to be **`finalized`** (`START_LOG_STATUSES = ['finalized']`): the service accepts `draft` / `finalized` / `amended`, and only a finalized log is the team's statement that the procedure occurred; a draft is preparation and must not start the clock, assert consent, or write a snapshot. A draft on a pre-start case is inserted and the case is left alone; the explicit Start (status route) remains available and is the emergency path. `requested` and any unexpected status are refused before insertion with 409 `CATH_LAB_CASE_START_NOT_ELIGIBLE` whose `details.next_action` names the transition to make first.
17. **A procedure attempt is a first-class lifecycle concept with two clocks.** `procedure_attempt` identifies it; `attempt_start_recorded_at` is the server recording instant and active-attempt discriminator; nullable `attempt_started_at` is the clinical occurrence. `actual_start_at` remains the historical first server-recorded start. Reopen after a recorded start increments the attempt, clears active projections, rotates `lifecycle_token`, and resets consent/time-out; history is preserved in the attempt table, not client-replaceable JSON.
18. **The start never waits on lab evidence resolution.** It reads the last committed cache. Refresh resolves evidence without a case-row lock, then enters only a brief generation-checked publish critical section. Staff has a cached-read path that never awaits refresh. Missing cache rows remain unknown (`null`).
19. **Age-only is fingerprinted.** Each item persists `evidence_fingerprint`, `policy_fingerprint`, `last_accepted_evidence` and an initialization marker. `aged_out` may carry only when both fingerprints equal those attached to the last accepted evidence. Lookback exclusion is `not_observed`, not `withdrawn`; bootstrap is not a policy edit.
20. **Start is replay-safe and lifecycle-fenced.** The server issues `lifecycle_token`; Start requires `expected_lifecycle_token` and a stable `command_id`. The status handler dispatches Start before ordinary transition validation so same-command replay is reachable after status becomes `in_progress`. A same-command/same-token replay returns 200 without writing; token mismatch is 409 `CATH_LAB_LIFECYCLE_STALE`. Cancellation and reopen rotate the token even when the attempt number remains 1.
21. **Consent records conditional authority evidence.** Patient/representative records require `mode`, `evidence_ref` and `scope`; representative also requires `representative_ref`. Emergency basis requires `basis_document_ref` or `{ justification, attested: true }` and accepts no communication mode. The tenant policy is versioned and must have clinical/legal approval; there is no implicit all-three production default. Legacy acceptance requires `server_provenance = 'legacy_pre_NNN'` written by migration/backfill, never absence or client time.
22. **Start has clinical and recording time; time-out absence is unknown.** Status Start records clinical start equal to the bound recording instant with provenance `staff_confirmed_now`. A retrospective finalized log either supplies `started_at` plus provenance or leaves clinical time null. Pending time-out means `not_documented` / `performance_unknown`; `not_performed` requires an explicit attested declaration. Clinical before/after comparisons use `attempt_started_at`; documentation-lateness uses `attempt_start_recorded_at`.
23. **The monthly report is identifiable, attempt-stable and durably audited.** It counts start events, joins attempt evidence on `(tenant_id, case_id, procedure_attempt)`, and reports immutable at-start facts separately from follow-up documentation. Each mount inserts an explicit-tenant required audit row; audit failure fails the request closed. The date predicate converts bounds, and EXPLAIN acceptance is bounded work/buffers rather than a mandated plan node.
24. **The receipt marker is named for what it measures.** `received_after_start` = the deciding result row's `lab_results.received_at` is after the active attempt's start (receipt here, transaction-start ordering, stated once in §5.4). `finalised_after_start` = the deciding row's `signed_off_at` is after the active attempt's start (false unless the row is signed). Neither claims "became available after start"; nothing does.
25. **Every free-text field is enumerated, and every reader is tested.** This now includes emergency-basis justification and nested attempt evidence. The canonical-timeline reader/role survey and nested-payload projection matrix are a release condition.
26. **Attempt-specific writes share one fence.** Consent, time-out and every procedure log require the current `expected_lifecycle_token`; the check happens under the lifecycle lock before any write. Generic non-attempt checklist updates are unchanged.
27. **Procedure-log creation has its own idempotency.** `log_command_id` is required, unique by tenant/case, and checked before insert. It is not a Start command and never enters `start_commands`.
28. **One recording instant.** `startCaseTx` obtains one `clock_timestamp()` after its lock waits and binds it to `attempt_start_recorded_at`, the snapshot, command binding, canonical event and audit metadata. Database defaults may differ only on storage bookkeeping columns and are not used for clinical comparisons.
29. **Report audit is fail-closed.** Required access auditing explicitly binds `audit_logs.tenant_id`; the catch-and-log-only `logAudit` helper is not used for this identifiable report.
30. **Realtime delivery is ordered and bounded.** Readiness update emission occurs only after the publish transaction commits; reconnect forces a reload; debounce has a maximum wait; stale responses are discarded by generation.
31. **CHECKs are narrow.** They enforce lifecycle timestamp/end-field shape only. They do not prove consent, command fencing or that `startCaseTx` ran; those remain application and source-guard obligations.

## 4. Starting with checks pending

### 4.1 Transition table

```js
export const CASE_TRANSITIONS = Object.freeze({
  requested: ['scheduled', 'cancelled'],
  scheduled: ['readiness_pending', 'ready', 'in_progress', 'cancelled'],
  readiness_pending: ['ready', 'in_progress', 'cancelled'],
  ready: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  // Decision 13/15: the ONE way out of cancellation, and it is a pre-start
  // status. The generic status endpoint never takes it (transitionCaseStatus
  // refuses a cancelled case before reading this table); only reopenCaseTx does.
  cancelled: ['readiness_pending']
});
export const START_ELIGIBLE_STATUSES = Object.freeze(
  Object.entries(CASE_TRANSITIONS).filter(([, t]) => t.includes('in_progress')).map(([from]) => from)
);   // ['scheduled', 'readiness_pending', 'ready']
export const REOPENABLE_STATUSES = Object.freeze(['cancelled']);
export const REOPEN_TARGET_STATUS = 'readiness_pending';
// Decision 14: what ordinary creation may create. Pre-start only; `ready` is a
// gate result, never a booking state; the three that end or run a case are
// reachable only through the functions that record why.
export const CREATABLE_STATUSES = Object.freeze(['requested', 'scheduled', 'readiness_pending']);
// Decision 16: which procedure-log statuses declare the procedure begun.
export const START_LOG_STATUSES = Object.freeze(['finalized']);
```

### 4.2 `startCaseTx` — the one start path, and its two callers

Signature (internal, `cathLabService.js`):

```js
async function startCaseTx(tx, {
  tenantId, cathCase, expectedLifecycleToken, reason = null, via,
  commandId, procedureLogId = null, clinicalStartedAt = null,
  clinicalStartProvenance = null, context = {}
})
// via: 'status' | 'procedure_log'
// returns { updated, snapshot, replayed }   // replayed: true when the command id had already started this attempt
```

`caseById` widens its explicit select with `procedure_attempt`, `lifecycle_token`, `attempt_start_recorded_at`, nullable clinical `attempt_started_at`, `attempt_start_time_provenance`, `metadata->'start_commands' AS start_commands` and `metadata->'readiness_at_start' AS readiness_at_start` — never the whole metadata column on a read path.

Order of work, on the caller's tenant transaction, case row locked `FOR UPDATE`:

1. Normalise `command_id` and `expected_lifecycle_token`. Missing/malformed values are 400 `CATH_LAB_START_COMMAND_REQUIRED` / `CATH_LAB_LIFECYCLE_TOKEN_REQUIRED` before any write.
2. Search server-owned `start_commands[]` **before eligibility**. The same command, attempt and token on an `in_progress` row returns the current row/snapshot without writing; a command bound elsewhere is 409 `CATH_LAB_START_COMMAND_STALE`.
3. Compare the expected token with the locked row. Mismatch is 409 `CATH_LAB_LIFECYCLE_STALE`. Cancellation and reopening rotate it even when the attempt remains 1 (§4.10).
4. Assert start eligibility, then call `assertConsentDocumented` for this attempt/token (§4.3).
5. Enforce the reason rule and read only the last committed lab picture (§4.5).
6. Obtain one recording instant after lock waits with `SELECT clock_timestamp() AS recorded_at`. Status Start uses it as the staff-confirmed clinical start; a retrospective finalized log supplies a clinical instant plus provenance or leaves clinical time unknown.
7. Build the snapshot and freeze consent/time-out at-start fields in `cath_lab_attempt_readiness_records` before the case UPDATE.

```sql
UPDATE cath_lab_cases
   SET status = 'in_progress',
       actual_start_at = COALESCE(actual_start_at, $3::timestamptz),
       attempt_start_recorded_at = $3::timestamptz,
       attempt_started_at = $4::timestamptz,                    -- nullable CLINICAL occurrence
       attempt_start_time_provenance = $5,
       metadata = COALESCE(metadata, '{}'::jsonb)
                  || jsonb_build_object('readiness_at_start', $6::jsonb)
                  || jsonb_build_object('start_commands',
                       COALESCE(metadata->'start_commands', '[]'::jsonb) || $7::jsonb),
       updated_by = $8::uuid,
       updated_at = $3::timestamptz
 WHERE tenant_id = $1::uuid AND id = $2::bigint
   AND lifecycle_token = $9::uuid
 RETURNING *
```

The command entry is `{ command_id, lifecycle_token, procedure_attempt, via, recorded_at }`. The canonical event receives the same bound `recorded_at` as `occurredAt`; snapshot and audit metadata carry it verbatim. Default `created_at` values are bookkeeping and never drive clinical comparisons.

8. Canonical event `cath_lab.case_in_progress`, `payload: { status, reason, via, procedure_attempt, command_id, started_with_readiness_pending, readiness_at_start: snapshot }`; `updateCaseCanonicalRefs`.
9. **Only when `gate.blocking.length > 0`**: `recordReadinessAudit(tx, { action: 'cath_lab.case.started_with_readiness_pending', resource: 'cath_lab_cases', resourceId, context, metadata: { case_id, facility_id, ...snapshot } })`. The audit row's own `id` is the report's `start_event_id`.

**After the transaction commits**, the caller (not `startCaseTx`) calls `scheduleReadinessRefresh({ tenantId, patientUid, source: 'cath_case_start' })` — synchronous, never awaited, never throws (§4.5).

**`transitionCaseStatus`**, inside the transaction, in this order:

1. `caseById(..., { lock: true })`.
2. `requestedTarget = normalizeStatus(input.status, CASE_STATUSES, 'status')` — vocabulary normalisation only.
3. Refuse a cancelled case before dispatch or transition validation.
4. If `requestedTarget === 'in_progress'`, call `startCaseTx` with `command_id` and `expected_lifecycle_token` **before** `validateCaseTransition`. Therefore a same-command retry on an already `in_progress` row reaches replay logic.
5. Otherwise call `validateCaseTransition` and run the generic update. A cancellation rotates `lifecycle_token` in that same statement, so delayed attempt-specific writes fail even before a never-started case is reopened.

**`recordProcedureLog`** separates log-creation idempotency from Start replay. `expected_lifecycle_token` and `log_command_id` are required for every log. After locking the case, token equality is checked and an existing same-command/same-request log is returned **before insertion**; a changed request is 409 `CATH_LAB_PROCEDURE_LOG_COMMAND_CONFLICT`. Every inserted row stores `procedure_attempt`, `lifecycle_token` and `log_command_id`, backed by a partial unique constraint on `(tenant_id, case_id, log_command_id)`. Only then does the exhaustive table apply:

| Case status | Log `draft` | Log `finalized` | Log `amended` |
|---|---|---|---|
| `scheduled` / `readiness_pending` / `ready` (start-eligible) | Insert the attempt-associated log; **case untouched**. A draft is preparation. | Insert, then **`startCaseTx(…, { via: 'procedure_log', procedureLogId, commandId: input.start_command_id, expectedLifecycleToken, clinicalStartedAt: input.started_at, clinicalStartProvenance })`** atomically. `started_at` without provenance is refused; absent clinical time remains unknown. | Insert; case untouched. |
| `in_progress` / `completed` | Insert; case untouched. | Insert; case untouched (an additional or corrected record of a procedure already under way or finished). | Insert; case untouched. |
| `cancelled` | **409 `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED`** before the insert; `details.reopen_path` names `/reopen`. | same | same |
| `requested` | **409 `CATH_LAB_CASE_START_NOT_ELIGIBLE`** before the insert; `details: { case_status: 'requested', next_action: { path: '/api/v1/cath-lab/cases/:id/status', body: { status: 'scheduled' } } }`. | same | same |
| anything else (defensive) | **409 `CATH_LAB_CASE_START_NOT_ELIGIBLE`** before the insert, `details.case_status` = the value found. | same | same |

There is no row without an outcome. Token validation and log-command replay happen before every cell and before insertion. The inline `assertReadinessComplete` call and force-start UPDATE are deleted.

### 4.3 Consent — the one hard block

```js
export const CONSENT_AUTHORITIES = Object.freeze(['patient', 'legally_authorised_representative', 'emergency_basis']);
export const CONSENT_MODES = Object.freeze(['written', 'verbal', 'telephone']);
export const CONSENT_SCOPES = Object.freeze(['named_procedure', 'episode']);

// THE ONE HARD BLOCK (owner decisions 1 and 5; §3 decisions 1 and 21). Every
// other readiness check informs and records. `pass` only — a waived or
// not-applicable consent is not an authority to proceed — and `required` is
// not consulted, because marking consent not-required must not be a way round
// it. What the pass documents (patient / legally authorised representative /
// emergency basis) is enforced where the pass is WRITTEN (updateReadinessCheck,
// against the tenant's consent policy); here the question is only whether the
// applicable authority has been documented. Legacy acceptance requires the
// SERVER-WRITTEN legacy_pre_NNN provenance established by migration; absence,
// client metadata and client timestamps never grandfather a row.
// Called from startCaseTx and nowhere else (cathLabStartPathPin.test.js).
async function assertConsentDocumented(db, tenantId, caseId, procedureAttempt, lifecycleToken) {
  const checks = await readinessForCase(db, tenantId, caseId);
  const gate = evaluateReadinessGate(checks);
  const consentCheck = checks.find((check) => check.check_type === 'consent');
  if (!consentCheck || consentCheck.status !== 'pass') {
    throw AppError.badRequest(
      'The authority to proceed (consent, or a documented emergency basis) must be recorded before the procedure starts',
      'CATH_LAB_CONSENT_REQUIRED',
      { consent_status: consentCheck?.status ?? 'missing', blocking: gate.blocking }
    );
  }
  const attemptRecord = await attemptReadinessRecord(db, tenantId, caseId, procedureAttempt, 'consent');
  const consent = attemptRecord?.current_metadata?.consent ?? null;
  const legacy = attemptRecord?.server_provenance === 'legacy_pre_NNN';
  if (!consent && !legacy) throw AppError.badRequest('Consent authority evidence is required', 'CATH_LAB_CONSENT_REQUIRED');
  if (attemptRecord.lifecycle_token !== lifecycleToken) throw lifecycleStale();
  return { gate, checks, consent };
}
```

`CONSENT_AUTHORITIES`, `CONSENT_MODES` and `CONSENT_SCOPES` live in the pure rules module and are re-exported by the facade.

**Conditional write contract.** Every consent write requires `expected_lifecycle_token`; the locked case must match before either the current check projection or attempt record changes. Client keys `previous_attempts`, `server_provenance`, `evidence_refs`, `documented_at` and `policy_version` are rejected, not merged.

- `patient`: `{ authority, mode, evidence_ref, scope }`.
- `legally_authorised_representative`: `{ authority, mode, evidence_ref, scope, representative_ref }`.
- `emergency_basis`: `{ authority, basis_document_ref }` **or** `{ authority, justification, attested: true }`; `mode` is forbidden because necessity is not a person communicating consent.

The server stamps `documented_at`, `documented_by`, the active `procedure_attempt`, `lifecycle_token`, approved `policy_version`, and archives evidence references in `cath_lab_attempt_readiness_records`. The current check remains a projection. `consentPolicyFor` reads a versioned tenant policy that includes allowed authorities and required evidence shapes. **There is no implicit production default.** Activation stops until the hospital's clinical/legal governance has approved the tenant policy version and its evidence requirements; this approval is not a second start signature and is not an urgency gate.

**Why the hard block is not "consent obtained".** A competent adult who cannot consent and has no legally authorised representative present can still be treated in an emergency; forcing staff to tick "consent obtained" to get past a block would put a false statement on the record. The block therefore reads "the applicable authority has been documented", the record says which, and the pattern (how often `emergency_basis` is the authority) is one column of the monthly report.

**Legacy provenance.** The preflight inventories every existing `consent = pass` row. The migration/backfill creates an attempt record with `server_provenance = 'legacy_pre_NNN'`; only that marker allows “authority not recorded”. A missing `metadata.consent`, a client-supplied completion time, or a client-supplied provenance key never does. The enum list is vocabulary, not the complete hospital policy.

**The pin** (`cathLabStartPathPin.test.js`, textual, comments stripped, shipping modules under `apps/backend/src` excluding `tests/`):

- `assertConsentDocumented(` is **called** from exactly one function body: `startCaseTx`. `assertReadinessComplete` and `CATH_LAB_READINESS_BLOCKED` occur nowhere in shipping code.
- `startCaseTx(` is **called** from exactly two function bodies: `transitionCaseStatus` and `recordProcedureLog`.
- **SQL-shape pin**: only `startCaseTx` assigns `status = 'in_progress'`, `actual_start_at`, `attempt_start_recorded_at` or clinical `attempt_started_at`; only `reopenCaseTx` clears the active-attempt clocks. The expected lines use bound `recorded_at`, never `NOW()`.
- **`SET status =` allow-list, literal**: `cathLabReadinessService.js:recomputeCaseStatusTx`, `cathLabService.js:{startCaseTx, reopenCaseTx, transitionCaseStatus, updateReadinessCheck}` — five pairs.
- **INSERT pin (decision 14, owner point 1)**: every backtick literal containing `INSERT INTO cath_lab_cases` sits in an allow-list of exactly two `path:function` pairs — `cathLabService.js:createCase` and `stemiPathwayService.js:spawnCathCase` — and no literal naming `cath_lab_cases` contains `ON CONFLICT` (there is no upsert on the case table today, and one would have to be argued for). Inside `createCase`'s source the text `normalizeStatus(input.status, CREATABLE_STATUSES` is present and `normalizeStatus(input.status, CASE_STATUSES` is absent; inside `spawnCathCase`'s literal the bound status literal is `'readiness_pending'`, and the test asserts `CREATABLE_STATUSES.includes('readiness_pending')` on the imported value.
- **Population pin (owner point 1; dev-1b's post-landing check)**: the guard asserts the exact measured population — **nine UPDATE + two INSERT** SQL sites after the lane — and detects `prisma.cath_lab_cases.create/update/upsert/delete` and transaction-client equivalents. Its unit test feeds a new parameterised SQL writer and a new ORM `upsert`; both must fail with `CATH_CASE_UNKNOWN_SQL_WRITER` / `CATH_CASE_UNKNOWN_ORM_WRITER` naming the synthetic function. This proves the boundary instead of testing only a reformatted known writer.
- **Door pins**: `CASE_TRANSITIONS.cancelled` deep-equals `['readiness_pending']`; `START_ELIGIBLE_STATUSES` excludes `cancelled`; the literal `status = 'readiness_pending'` on a `cath_lab_cases` statement occurs only in `reopenCaseTx`; and `transitionCaseStatus`'s source contains the text `=== 'cancelled'` **before** the text `validateCaseTransition(` (decision 15, the short-circuit order).

**A deep test per path** (`cath-lab-readiness.deep.test.js`, own case per test): consent `pending` → both paths refused `CATH_LAB_CONSENT_REQUIRED`, nothing written (no log row either — the transaction rolled back); consent `waived` and `not_applicable` → refused; consent pass with `authority: 'emergency_basis'` → starts, snapshot `consent_authority: 'emergency_basis'`, and the audit metadata carries it; a pass write without an authority → 400 `CATH_LAB_CONSENT_AUTHORITY_REQUIRED`; a pass write with an authority outside the tenant policy (policy set to `['patient']` for the test tenant) → 400 `CATH_LAB_CONSENT_AUTHORITY_NOT_PERMITTED`; a legacy pass (row seeded with `metadata: {}`) → starts with `consent_authority: null`.

**Staff.** Patient/representative choices show mode, scope, evidence reference, and representative reference when applicable. Emergency basis hides mode and requires a documentation reference or attested justification. Every submission carries the loaded lifecycle token. A migration-marked legacy pass shows “Authority not recorded”; an unmarked pass is treated as incomplete, not grandfathered.

### 4.4 The Staff "Start" action

The dialog carries the Start definition. `CathLabApiService.startCase` posts `{ status: 'in_progress', reason, command_id, expected_lifecycle_token }`; the command is minted once per confirmation, while the lifecycle token comes only from the latest server response. A 409 lifecycle/command stale response reloads and requires a fresh review. The client never invents or edits the lifecycle token.

### 4.5 The start never waits on the lab rail (decision 18)

Start never invokes a refresh. Revision 3 also removes the hidden lock dependency in baseline `refreshCaseLabReadiness`, whose `caseRowTx(..., { lock: 'no key update' })` currently holds a `FOR NO KEY UPDATE` case-row lock while it resolves lab evidence. That lock conflicts with Start's `FOR UPDATE`.

`labsPictureForStartTx(tx, tenantId, caseId, checks)`:

```js
// The LAST COMMITTED lab picture: the stored item rows and the labs check's
// evidence stamp. No refresh is called and nothing is awaited on the lab rail.
// Missing rows mean UNKNOWN, never "nothing missing".
async function labsPictureForStartTx(tx, tenantId, caseId, checks) {
  const items = normalizeRows(await tx.$queryRawUnsafe(
    `SELECT item_code, required, state FROM cath_case_lab_readiness_items WHERE tenant_id = $1::uuid AND case_id = $2::bigint`,
    tenantOr(tenantId), normalizeId(caseId, 'case_id')));
  const settings = await getReadinessSettings({ tenantId: tenantOr(tenantId), db: tx });
  const labsCheck = checks.find((check) => check.check_type === 'labs');
  const pictureAt = labsCheck?.metadata?.live_evidence_refreshed_at ?? null;
  const status = labComponentStatus({ pictureAt, itemCount: items.length, now: new Date() });
  return {
    missing: status === 'unavailable' ? null : missingLabItemCodes(items, settings),
    picture_at: pictureAt,
    lab_component_status: status
  };
}
```

`labComponentStatus` (rules module, pure): `'unavailable'` when there are no item rows or no stamp; `'fresh'` when `now - pictureAt ≤ START_PICTURE_FRESH_MS` (300 000 ms — five minutes, the same order as the read-through refresh's own `EVIDENCE_STAMP_MAX_AGE_MS` and long enough that the previous `getCase` of the same case counts as fresh); `'stale'` otherwise. The Staff dialog shows "Lab picture as of 04:29" or "Lab picture unavailable — the checklist will refresh after start" (key `start_lab_picture`).

**Refresh locking contract.** `resolveCaseLabReadinessCandidate` runs the settings, results, orders and last-accepted-evidence queries without a case-row lock and captures `{ lifecycle_token, cache_generation, policy_fingerprint }`. `publishCaseLabReadinessCandidate` then opens a short transaction, locks the case `FOR NO KEY UPDATE`, rechecks those values, upserts item/check projections, increments `cache_generation`, and commits. If they changed, it discards/retries; no expensive evidence query is repeated while the lock is held. Lifecycle and consent writes remain serialised. Start can wait only for this bounded publish section, never for evidence resolution. Scheduling after Start is best-effort and gives no “within one tick” completion promise.

**Loading contract.** `GET /cases/:id?readiness_mode=cached` calls `getCase` with `refreshReadiness: false`: it returns the case, checks and last committed lab picture immediately, marks missing/stale cache honestly, and schedules a refresh after sending. Staff uses this mode for checklist/start affordance loads and reconnect reloads. The existing default read-through mode remains for callers that explicitly want freshness, but it is never on the Start affordance's critical path.

**Tests.** Keep the never-settling mock, then add the real two-connection test: connection A begins resolution, locks/pauses the deciding `lab_results` row, and proves via `pg_locks` that it holds no conflicting case-row lock; connection B posts Start and must commit within 2 s while A remains paused. Resume A and assert publish detects the changed cache/lifecycle generation and retries or discards safely. A second DB test pauses only inside the brief publish section, verifies no evidence query occurs there, releases it, and bounds Start's wait to that critical section. Staff's cached GET returns the Start affordance while a fresh resolver is deliberately never settled.

### 4.6 Audit and review

`audit_logs.action = 'cath_lab.case.started_with_readiness_pending'`, `resource = 'cath_lab_cases'`, `resource_id = <case id>`, actor from `context`, `metadata = { case_id, facility_id, recorded_at, procedure_attempt, via, command_id, procedure_log_id, urgency, reason, blocking, missing_lab_items, readiness_picture_at, lab_component_status, consent_authority }`. The row's `id` is the **start event id** the report exposes. The canonical `cath_lab.case_in_progress` event carries the same snapshot for the timeline.

### 4.7 `timeout` semantics (decision 22)

The old sentence ("expected to be pending in an emergency") is withdrawn. A pending check proves only that the system lacks documentation; it never proves the clinical act was omitted.

- **Start** is defined in decision 22 and restated in the Start dialog.
- Every write requires `expected_lifecycle_token`. `status === 'pass'` requires `{ timeout: { outcome: 'performed', performed_at } }`; the server stamps one `documented_at` and ignores client completion time. An explicit omission is `{ timeout: { outcome: 'not_performed', attested: true } }` and remains non-pass. No other shape yields `not_performed`.
- The attempt record stores the latest follow-up separately from immutable `at_start_status` / `at_start_metadata`. Derived `timing ∈ {performed_before_clinical_start, performed_after_clinical_start, not_documented, not_performed, performance_unknown}`. If clinical start is null, performed timing is `performance_unknown`; documentation lateness compares `documented_at` with `attempt_start_recorded_at`.
- Staff shows, on the check row, "Time-out performed 04:29 · documented 04:41 (after start)" (key `cath-readiness-timeout-timing`); the "Recorded after start" chip becomes specific for this check: **"Documented after start"** when performed before start, **"Performed after start"** otherwise. The dialog does not pre-fill or auto-pass it.
- The report (§7.3) carries `timeout_outcome` per start event and the Admin tab shows its breakdown.

### 4.8 `reopenCaseTx` — the door out of `cancelled` (decision 13, amended by 15, 17, 20)

Owner decision, 2026-09-06, verbatim: **"deliberate, auditable, and nothing stranded."**

Signature (internal, `cathLabService.js`, beside `startCaseTx`):

```js
async function reopenCaseTx(tx, { tenantId, cathCase, reason, context = {} })
// returns { updated, procedureAttempt, checksReset }
```

Order of work, on the caller's tenant transaction, case row locked `FOR UPDATE` by `caseById(..., { lock: true })`:

1. **Explicit precondition (decision 15)**: `if (cathCase.status !== 'cancelled') throw AppError.invalidTransition(cathCase.status, REOPEN_TARGET_STATUS, CASE_TRANSITIONS[cathCase.status] || [])`. Only then `validateCaseTransition('cancelled', REOPEN_TARGET_STATUS)` as the table-consistency check (it cannot throw while the door pin holds; it is there so the table and the door cannot drift silently). Nothing is written. A `scheduled` case answers `INVALID_STATE_TRANSITION` with `allowed: ['readiness_pending','ready','in_progress','cancelled']`, which is truthful and is not a reopen.
2. `cleanReason = cleanText(reason, 500)` — the parameter, not `input.reason`. Empty → 400 `CATH_LAB_REOPEN_REASON_REQUIRED`, `details: { case_status: 'cancelled' }`. Nothing written.
3. Capture `cancelledAt`, `previousAttemptRecordedAt = cathCase.attempt_start_recorded_at`, the prior lifecycle token and cancel reason.
4. `newAttempt = previousAttemptRecordedAt ? procedure_attempt + 1 : procedure_attempt`. Generate a **new server lifecycle token regardless**; this fences delayed first deliveries even when no attempt had started.
5. The case UPDATE — one statement:

```sql
UPDATE cath_lab_cases
   SET status = 'readiness_pending',
       actual_end_at = NULL,                         -- pre-start again; also keeps cath_lab_cases_actual_time_check satisfied on the next start
       attempt_start_recorded_at = NULL,             -- no active attempt
       attempt_started_at = NULL,                    -- clinical occurrence unknown/not begun
       attempt_start_time_provenance = NULL,
       procedure_attempt = $4::int,                  -- N+1 when the previous attempt had started, else unchanged
       lifecycle_token = $5::uuid,                   -- server-issued generation always rotates
       metadata = (COALESCE(metadata, '{}'::jsonb) - 'readiness_at_start')
                  || jsonb_build_object('readiness_at_start_history',
                       COALESCE(metadata->'readiness_at_start_history', '[]'::jsonb)
                       || CASE WHEN jsonb_typeof(metadata->'readiness_at_start') = 'object'
                               THEN jsonb_build_array(metadata->'readiness_at_start') ELSE '[]'::jsonb END),
       updated_by = $3::uuid,
       updated_at = NOW()
 WHERE tenant_id = $1::uuid AND id = $2::bigint
 RETURNING *
```

`actual_start_at` is **kept** as the historical first start (decision 17); `readiness_at_start` moves to history so the current snapshot key is `null` until the next start writes attempt N+1's; `start_commands[]` is kept (that is what lets a stale replay be recognised, §4.10).

6. **Check reset on a new attempt only**: set the current `consent`/`timeout` projections to pending. Do not copy history into request-replaceable metadata; attempt N's row in `cath_lab_attempt_readiness_records` already retains current and immutable at-start evidence/references. Attempt N+1 receives its own row on the first write/start. The other six checks carry over; labs is recomputed.
7. Canonical event `cath_lab.case_reopened`, `payload: { status: 'readiness_pending', reason, previous_status: 'cancelled', previous_attempt, procedure_attempt: newAttempt, checks_reset }`; `updateCaseCanonicalRefs`.
8. `recordReadinessAudit(tx, { action: 'cath_lab.case.reopened', … metadata: { case_id, facility_id, reason, previous_status: 'cancelled', cancelled_at, cancel_reason, urgency, previous_attempt, procedure_attempt, previous_attempt_start_recorded_at, lifecycle_token_rotated: true, checks_reset } })` — **always**.

**History and reset.** On a new attempt, consent/time-out projections reset to pending, while attempt N's `cath_lab_attempt_readiness_records` row remains immutable in its at-start fields and retains its final follow-up/evidence references. No `metadata.previous_attempts` client-merge exists. On a never-started reopen the attempt number and checks remain, but the lifecycle token still rotates.

**Roles, route, Staff, SLA, re-cancel** — as revision 1: the cancel path's guard chain (`requireCathWorkflow`, `guardCathCaseById`), `requireIdempotencyKey({ required: true, scope: 'cath_lab_case_reopen' })`, cath mount only; Staff "Reopen case" with a mandatory reason and an `Idempotency-Key` minted **once per confirmation** through `IdempotencyAttempt('cath-lab-reopen-$caseId').keyFor(body)` (`packages/vhhealth_core/lib/services/idempotency_key.dart`; the readiness panel already mints its order / outside-result / waive keys this way, and calls `reset()` only after the write concluded), reused across retries; the workflow SLA instance stays cancelled; the door is not one-shot. The Staff dialog body now also says: "If the procedure had already started, this opens a new attempt: consent and the time-out will be re-confirmed."

### 4.9 The attempt lifecycle (decision 17)

Two questions revision 1 conflated, now separate:

| Question | Field | Set by | Cleared by |
|---|---|---|---|
| Has this case **ever been recorded as started**? | `actual_start_at` | first `startCaseTx` (bound server recording instant) | never |
| Is this case in an **active** procedural attempt? | `attempt_start_recorded_at` | every `startCaseTx` | `reopenCaseTx` (`NULL`) |
| When did the invasive act clinically occur? | nullable `attempt_started_at` + `attempt_start_time_provenance` | status Start (`staff_confirmed_now`) or a provenance-bearing finalized log | `reopenCaseTx` clears the current projection; attempt record keeps history |
| Which attempt is this? | `procedure_attempt` | default 1; `reopenCaseTx` increments when the previous attempt had started | never decremented |
| Which server-issued lifecycle generation may mutate it? | `lifecycle_token` | create; rotated by cancellation and every reopen | client never writes it |

What each field controls — **every rule keys on the active attempt**:

| Behaviour | Keyed on | Effect after start → cancel → reopen (attempt 2, not yet started) |
|---|---|---|
| Board / `case_started` / Staff `started` | `attempt_start_recorded_at IS NOT NULL` | pre-start: start row shown, banners hidden |
| Automation regime / un-waive / late-action markers | `attempt_start_recorded_at` | pre-start again until attempt 2 is recorded started |
| Clinical time-out comparison | nullable clinical `attempt_started_at` | unknown when a retrospective log did not establish clinical time |
| Consent / time-out | reset to pending on attempt N+1 (§4.8 step 6) | must be re-documented before attempt 2 starts; consent is the hard block again |
| Snapshot `readiness_at_start` | keyed by `procedure_attempt`; prior ones in `readiness_at_start_history[]` | `null` until attempt 2 starts |
| `readiness_gate` / `recomputeCaseStatusTx` | unchanged (status-based) | may move the case to `ready` when clear |
| Report | one row per start **event** with `procedure_attempt` | attempt 2's start is its own row |
| `cath_lab_cases_actual_time_check` (482) | `actual_start_at` / `actual_end_at` | reopen clears `actual_end_at`; completion stamps it ≥ the first start |

**Reads.** Operational “started” checks use `attempt_start_recorded_at` and its epoch twin. Clinical timing uses `attempt_started_at` and its provenance. The block and case contract expose both, plus `procedure_attempt`, `lifecycle_token` and `first_started_at`.

**The test the owner asked for** (deep): attempt 1 starts with all seven items fresh and the check auto-passed; cancelled; HGB evidence ages 45 days; reopened → `readiness_pending`, attempt 2, `attempt_start_recorded_at IS NULL`, clinical `attempt_started_at IS NULL`, and historical `actual_start_at` unchanged. Refresh retracts labs to pending; consent is pending; Start without consent fails. After re-documenting consent, attempt 2 Start writes a new recording instant, may carry a nullable/independent clinical instant, preserves first-start history, creates a second event, and leaves the attempt-1 at-start evidence immutable. A later time-out/log amendment attaches only to attempt 2; the report returns both events joined to their own attempt records.

### 4.10 Reachable replay and the lifecycle fence (decisions 20, 26–27)

The sequence the owner named: start succeeds but the response is lost → the case is cancelled and reopened → the client's automatic retry of the original start arrives, finds a startable case, and starts attempt 2 with attempt 1's reason.

- Staff mints `command_id` once per Start decision and uses the latest server-issued `lifecycle_token` as `expected_lifecycle_token`.
- The status handler normalises `in_progress` and dispatches to `startCaseTx` before transition validation. `startCaseTx` checks an existing command before eligibility, so retry after success is reachable.
- A known command on the same token/attempt returns 200 without a second event/audit. A command bound elsewhere is `CATH_LAB_START_COMMAND_STALE`; any token mismatch is `CATH_LAB_LIFECYCLE_STALE`.
- Cancellation and reopening each rotate the token. Thus a **delayed first delivery** prepared before cancel/reopen cannot start the new lifecycle even when its command was never previously stored and `procedure_attempt` stayed 1.
- Consent, time-out and procedure-log requests require the same expected token. Procedure logs additionally require independent `log_command_id`; their duplicate detection runs before insertion and does not reuse Start commands.
- **Reopen**: `Idempotency-Key` per user decision (§4.8). A replay of a reopen under its own key answers the original response (middleware); a **new** decision to reopen an already reopened-and-restarted case gets a new key and is refused by the explicit precondition (the case is not `cancelled`).

**Tests**: same-command replay through the actual status endpoint; delayed first Start across cancel/reopen before first start; delayed consent and time-out across reopen; duplicate and changed-body procedure-log commands; start attempt 1 → cancel → reopen → fresh attempt 2; and token rotation on both cancel and reopen.

### 4.11 Creation may only create a pre-start case (decision 14)

`createCase`: `const status = input.status ? normalizeStatus(input.status, CREATABLE_STATUSES, 'status') : 'scheduled';` — `normalizeStatus` already throws 400 `CATH_LAB_BAD_STATUS` with the allowed list in its message; this lane gives the refusal its own code so a client can tell "not a status" from "not creatable": a value in `CASE_STATUSES` but not in `CREATABLE_STATUSES` → 400 `CATH_LAB_CASE_STATUS_NOT_CREATABLE`, `details: { status, creatable: CREATABLE_STATUSES }`, raised before `assertPatient` and before the transaction. The creation route validates `req.body.status` against the same exported list before calling the service (defence in depth; the service check is the one the pin reads). `input.metadata` is stripped of `CASE_START_METADATA_KEYS = ['readiness_at_start', 'readiness_at_start_history', 'start_commands']`. `procedure_attempt` and `attempt_started_at` are not accepted from the body at all (the INSERT does not name them; defaults apply).

**Route-level test** (supertest against the cath router, in the suite that already drives `POST /cases` for facility authority): `POST /cases { patient_uid, facility_id, requested_procedure, status: 'in_progress' }` as a workflow role → 400 `CATH_LAB_CASE_STATUS_NOT_CREATABLE`, no `cath_lab_cases` row (count unchanged), no readiness check rows; the same for `completed`, `cancelled` and `ready`; `readiness_pending` → 201 with `attempt_started_at: null`, `procedure_attempt: 1`; and a follow-up `POST /cases/:id/procedure-logs` on the refused id answers 404 (the case does not exist), proving the running-case-with-pending-consent cannot be manufactured this way. migration NNN's CHECK is separately proved by a deep test that issues the raw `INSERT … status = 'in_progress'` with `attempt_started_at` NULL and asserts Postgres 23514.

## 5. The checklist keeps living after start

### 5.1 Lab events reach started cases

`refreshOpenCasesForPatient`: `WHERE status NOT IN ('completed', 'cancelled')`. Refresh uses the two-phase resolution/publish contract of §4.5; evidence resolution never holds the case-row lock. A successful publish emits `staff:lab { kind: 'cath-readiness-updated', case_id, cache_generation }` only **after commit**.

### 5.2 Check-level rule after start — cause, not state (decision 19)

**Before start (of the active attempt), nothing changes.** Plan 3's rule stands: automation passes when every required item is available and retracts a pass it made when one goes missing — by age included. This regime has its own test and that test is in the mutation list.

**After start:**

- **NEW EVIDENCE always applies, better or worse.** A value arriving mid-procedure makes its item available and the auto-pass branch may pass the check, marked `passed_after_start: true` on the `auto_pass` audit row; a critical value sets `critical_warning` / `critical_items` / `live_evidence`, Staff shows the red banner, the check reflects it; the case status and the gate are untouched.
- **AGEING alone never flips the check.** When every missing required item's `unavailability_cause` is `aged_out`, the retraction branch does nothing. The item still reads `stale` (or `ordered_awaiting_sample` when a repeat draw is already open) — the picture is truthful; only the check's status is held.
- **Any other cause still retracts**: `policy_changed` (a validity window or the required set edited mid-procedure), `future_dated` / `unparseable` (the evidence's timestamp was corrected into something unusable), `withdrawn` (the deciding result was cancelled or retracted), `corrected` (a different result now decides and it is not acceptable). Each is new information.

```js
// computeCheckDecision, rules module. `missing` entries are { item, state, cause }.
const started = Boolean(caseRow?.attempt_start_recorded_at);
// POST-START ONLY, and only for AGEING: the team acted on the value it had, and
// the clock moving is noise mid-procedure. Any other cause of unavailability is
// new information and retracts exactly as before start. Gated strictly on the
// ACTIVE attempt's start; delete `started &&` and the pre-start staleness test
// goes red; replace `cause === 'aged_out'` with `state === 'stale'` and the
// policy-change and future-dated tests go red.
const agedOnly = started && missing.length > 0 && missing.every((row) => row.cause === 'aged_out');
if (missing.length === 0) {
  if (settings.auto_pass === true && (status === 'pending' || (status === 'pass' && autoManaged))) {
    nextStatus = status === 'pass' ? null : 'pass';
  }
} else if (status === 'pass' && autoManaged && !agedOnly) {
  nextStatus = 'pending';
  autoPendingReason = pendingReasonFor(missing);
}
```

`pendingReasonFor` keeps its wording (`hb stale`), the cause rides beside it on `missing[]` and on the item.

### 5.3 Late actions

- `orderMissingLabs`: the `case_started` refusal is deleted; `orderPriorityForUrgency(urgency, { started: true })` → `'STAT'`; the audit row gains `ordered_after_start: true`; `started` is `Boolean(cathCase.attempt_start_recorded_at)`.
- `recordExternalLabResult`: the refusal is deleted; the audit row gains `recorded_after_start` (the same active-attempt comparison).
- Waive / un-waive: #1018's record-yes / lift-no; `isAfterCaseStart` reads `attempt_started_at`.
- `CATH_LAB_READINESS_CASE_STARTED`: **kept** with its one remaining thrower (`unwaiveLabItem`, verified on `main`); the overlay's `ERROR_CODES` keeps it; the order-missing and external-result operations lose their 409 entries; the `case_started` description is rewritten ("true once the ACTIVE attempt has started; nothing on this surface is refused after it except lifting a waiver").

### 5.4 Lateness markers (decision 24)

`afterCaseStartMs(ms, caseStartedAt)` is shared; `caseStartedAt` is the **active attempt's** start (epoch twin). Four booleans on every item, always present:

| Key | Instant compared | Meaning |
|---|---|---|
| `recorded_after_start` (#1018) | `waived_at` | the waiver was documented after the active attempt started |
| `ordered_after_start` | open order's `requested_at` | the in-flight order was placed after start |
| `received_after_start` | deciding result row's `received_at` | the result that decides the item was **received here** after start. A receipt marker, nothing more: a row received before start and signed after it reads `false` here. |
| `finalised_after_start` | deciding result row's `signed_off_at` | the deciding row was signed off after start; `false` unless the row is signed (`result_final`) |

**`*_after_start` semantics = transaction-start ordering**, said once here: `attempt_started_at` is `NOW()`, `received_at`, `requested_at`, `waived_at` and `signed_off_at` are `NOW()`/defaults of their writing transactions, and Postgres `NOW()` is `transaction_timestamp()`; "after" means "the transaction that wrote it began after the transaction that started the attempt", at millisecond resolution; equal instants answer `false`. The flags are markers, not chronology; the deep tests order their fixtures explicitly.

Not persisted on the item table; they ride into `metadata.live_evidence`; the OpenAPI pin derives the item key set from the resolver so all four reach the contract by construction.

### 5.5 Case status after start

`recomputeCaseStatusTx` rewrites only pre-start statuses; an `in_progress` case keeps its status while its `labs` row and items update. Pinned by a deep test.

### 5.6 `unavailability_cause` — how it is computed (decision 19)

Computed from the previous stored row, the last accepted evidence, and canonical fingerprints. Each item persists:

- `evidence_fingerprint`: SHA-256 of canonical `{ result_id, observed_instant, updated_at/version, status, signed_off_at, source/result_origin }` for the deciding evidence;
- `policy_fingerprint`: SHA-256 of canonical `{ required, effective_window_days, external_results_count, external_result_acceptance_policy_version }`;
- `last_accepted_evidence`: the last accepted evidence identity, observed instant, version/status/source and both fingerprints, retained even when an open repeat order becomes the displayed item;
- `classifier_initialized_at`: server timestamp distinguishing bootstrap from a policy edit.

```js
export const UNAVAILABILITY_CAUSES = Object.freeze([
  'aged_out', 'future_dated', 'unparseable', 'withdrawn', 'corrected', 'policy_changed', 'reordered',
]);
// null when the item is available. Otherwise the reason it is NOT, decided
// against the previous stored row for this item and the rows the resolver saw.
export function classifyUnavailability({ previous, resolved, previousResult, evidenceFingerprint, policyFingerprint, asOf })
```

Rules, in precedence order (the first that applies wins):

1. `resolved` available (`isItemAvailable`) → `null`.
2. If no classifier/fingerprints existed before, classify this refresh as **bootstrap**: initialize them without returning `policy_changed` or `withdrawn`.
3. A changed policy fingerprint → `policy_changed`.
4. Resolve the last accepted result by its id directly, independently of the bounded display lookback. Not appearing in the bounded query is `not_observed`, not withdrawal. Only an explicit cancelled/retracted status or a confirmed missing source row is `withdrawn`.
5. If the evidence fingerprint changed, classify from the changed material: unusable/future timestamp → `unparseable` / `future_dated`; same-id status/version/timestamp correction (including moving backward beyond the window) → `corrected`; explicit withdrawal → `withdrawn`. It can never inherit `aged_out`.
6. Only when both fingerprints match the last accepted evidence and its unchanged observed instant has merely crossed the effective window is the cause `aged_out`. Display state is irrelevant; an open repeat order may still display `ordered_awaiting_sample`.
7. `previous` was acceptable because of a **waiver** and the waiver is explicitly gone → `withdrawn`.
8. A persisted `aged_out` carries only while both fingerprints still match. Other persisted causes are recomputed from the current evidence.
9. No previously accepted evidence plus an open order → `reordered`; otherwise `null` with the resolved display state.

`missing[]` entries carry `cause`; `live_evidence[]` carries it; the item on the wire carries it as `unavailability_cause` (string or null; a code, never a value) — it is useful to the operator ("HGB aged out" vs "HGB result withdrawn") and costs nothing under the disclosure rule.

**Tests** (unit, `classifyUnavailability` and `computeCheckDecision` together; deep for the two that need the rail):

- aged-out, same row → `aged_out`; post-start → no retraction; pre-start → retraction.
- **aged-out with a repeat order already open at start** → state `ordered_awaiting_sample`, cause `aged_out`, post-start → no retraction (the owner's opposite failure).
- the same row's `performed_at` corrected into the future → `future_dated` → retraction even post-start.
- the same row's timestamp corrected into garbage (epoch twin `null`, `performed_at` unparseable string) → `unparseable` → retraction.
- validity window edited 30 → 7 days mid-procedure with an 8-day-old fresh-until-now value → `policy_changed` → retraction; the required set gaining an item nobody ordered → the new item `policy_changed` → retraction.
- the deciding row cancelled → `withdrawn` → retraction.
- age-out, then same-id timestamp/status correction into the future → not carried; age-out then explicit withdrawal → `withdrawn`; backward correction beyond the window → `corrected` rather than `aged_out`.
- result excluded only by bounded lookback → internal observation state `not_observed`, not the public `withdrawn` cause; direct previous-id lookup preserves or recomputes the public classification.
- first refresh of migrated rows with null fingerprints → bootstrap initialization, never `policy_changed`.
- two refreshes in a row with unchanged fingerprints → stable `aged_out`.

## 6. The readiness picture shows lateness

### 6.1 `CathLabReadiness` (the `lab_readiness` block and `GET …/readiness/labs`)

New top-level keys: `case_started` (from the active recording instant), `procedure_attempt`, `lifecycle_token`, `attempt_start_recorded_at`, nullable clinical `attempt_started_at`, `attempt_start_time_provenance`, `first_started_at`, `started_with_readiness_pending` (**tri-state**: `true` / `false` / `null` = no snapshot), `readiness_at_start`:

```json
"case_started": true,
"procedure_attempt": 2,
"attempt_started_at": "2026-09-06T05:02:11.000Z",
"first_started_at": "2026-09-06T03:10:00.000Z",
"started_with_readiness_pending": true,
"readiness_at_start": {
  "recorded_at": "2026-09-06T05:02:11.000Z",
  "procedure_attempt": 2,
  "via": "status",
  "command_id": "1f0f2c9e-…",
  "procedure_log_id": null,
  "urgency": "emergency",
  "reason": "Primary PCI, outside reports awaited",
  "blocking": [{ "check_type": "labs", "reason": "pending" }, { "check_type": "timeout", "reason": "pending" }],
  "missing_lab_items": ["hb"],
  "readiness_picture_at": "2026-09-06T05:01:40.201Z",
  "lab_component_status": "fresh",
  "consent_authority": "emergency_basis"
}
```

Every item gains `ordered_after_start`, `received_after_start`, `finalised_after_start` (beside `recorded_after_start`) and `unavailability_cause`. A clean start writes `blocking: []` so "started clean" (`false`) and "no snapshot" (`null`) are distinguishable, on this block, on the day list and in Staff.

### 6.2 Day list

`lab_readiness_summary` gains `started_with_readiness_pending` as a **tri-state**: `CASE WHEN jsonb_typeof(c.metadata->'readiness_at_start'->'blocking') = 'array' THEN jsonb_array_length(…) > 0 ELSE NULL END` — `NULL` is "not documented", never "no pending checks". The list row itself gains the two new columns (`procedure_attempt`, `attempt_started_at`); the raw `metadata` column is still **not** selected.

### 6.3 Staff — including live updates

- **Banner** (`cath-readiness-started-pending-banner`) when `startedWithReadinessPending == true`; a muted line "Start not documented under the checklist" (key `cath-readiness-start-undocumented`) when it is `null` on a started case; nothing when `false`.
- **Critical banner**, **header chip**, **after-start chips** (item chip when any of the three item booleans is true; check chip per §4.7 for `timeout`), the two write gates losing `caseStarted`, the start row, the reopen row, the consent choosers, the time-out `performed_at` field — as revision 1 amended above.
- **Live updates.** Baseline lab events remain nudges, but sign-off is not considered delivered from an injected widget event alone. The sequence is: lab/sign-off transaction commits → readiness resolver publishes and commits cache generation N → post-commit `emitLabEvent('cath-readiness-updated', { tenantId, case_id, cache_generation: N })` → WebSocket delivery → cached reload. The checklist filters a case-specific payload; generic tenant lab nudges merely schedule refresh. Reload uses a 400 ms trailing debounce with `maxWait: 2 s`, so continuous events cannot postpone it forever. Each request owns a monotonic generation; a response older than the last applied generation is discarded.
- **Staleness and disconnection.** Reconnect immediately performs a cached reload and schedules refresh; denied/disconnected states stay visible. The “Picture as of” line includes cache generation and never claims freshness beyond its timestamp.
- **Sign-off tests.** Backend integration proves commit order (no emission before either commit, one case/generation event after publish). WebSocket integration proves delivery. Widget tests then prove the delivered event shows the warning without reopen, continuous 100 ms events still reload by 2 s, reconnect reloads, and a deliberately delayed generation N response cannot replace already-applied N+1.
- Strings in all five locales with the `// REVIEW: AI first-pass` marker on the four non-English ones (OPEN-21).

### 6.4 Role projection and the canary

None of the new keys is serology: check types, item **codes**, causes, booleans and timestamps are the checklist. `projectLabReadinessForRole` blanks `readiness_at_start.reason` (key kept, `null`) for roles outside `roleSeesSerologyDetail`; `readiness_at_start_history[]` is **not** on the block at all (it is history for the audit and the timeline, and it is not selected by `caseRowTx`). Canary additions as revision 1 (poisoned snapshot with a second sentinel, `disclosures()` extension, positive control, liveness, summary key set, reachable set +2 report GETs), plus §6.5.

### 6.5 Free-text inventory and its readers (decision 25)

| # | Field | Written by | Stored | Readers | Cover |
|---|---|---|---|---|---|
| 1 | **start reason** | `startCaseTx` | snapshot; audit metadata; canonical event | readiness/report projection; workflow mutation responses; audit export; nested canonical timeline payload | canary on block/report JSON+CSV; timeline matrix across every role reachable through the two current `readCanonicalPatientTimeline` route callers (`clinicalTimelineRoutes`, `patientSearchRoutes`), both guarded by `patientAccessGuard`; nested `payload.reason` and `payload.readiness_at_start.reason` must be projected for non-entitled roles |
| 2 | **prior attempts' start reasons** | `reopenCaseTx` (moves #1 into `metadata.readiness_at_start_history[]`) | case metadata | `RETURNING *` on `/reopen`, `/status`, `/procedure-logs` (workflow roles, entitled); never on the block, the list or the report | the canary's write mirror on the reopen response as a workflow role (positive control); a unit test that `caseRowTx` and `listCases` do not select the history |
| 3 | **reopen reason** | `reopenCaseTx` | `cath_lab.case.reopened` audit metadata; canonical `cath_lab.case_reopened` payload | admin audit export (privileged); patient timeline (same Task 0 verification as #1; same projection if needed); the reopen response does not echo it (the case row carries no reopen reason) | third sentinel (`REOPEN-REASON-SENTINEL-…`) on the timeline reader test and on the write mirror |
| 4 | **copied cancel reason** | `reopenCaseTx` (`cancel_reason`, from the cancel event) | `cath_lab.case.reopened` audit metadata only | admin audit export (privileged) | covered by #3's audit-row test (same row) |
| 5 | **emergency-basis justification** | conditional consent write | attempt record current/at-start evidence; check projection; start snapshot carries only authority code | readiness detail, audit/export, canonical payload only where explicitly projected | distinct sentinel in direct and nested payloads for every reachable role; CSV if any export adds it. Prefer `basis_document_ref` to free text. |

The inventory is not closed by listing fields. Release requires a current reachable-role survey, response-shape capture for each route, and sentinel tests for nested payload projections. `rowsToCsv` formula neutralisation and blanking remain pinned.

## 7. Monthly report — starts with checks pending (decision 23)

### 7.1 Endpoint

`GET /api/v1/cath-lab/reports/starts-with-pending?month=YYYY-MM[&facility_id=N][&format=csv]`, and the same handler at `GET /api/v1/cath-reprocessing/reports/starts-with-pending`. `month` required, `^\d{4}-(0[1-9]|1[0-2])$`, else 400 `CATH_LAB_REPORT_MONTH_INVALID`; `facility_id` optional positive int, else 400 `CATH_LAB_REPORT_FACILITY_INVALID`. The month is the ward's IST calendar month. Registered **before** `router.get('/reports/:id', …)` on the cath router.

### 7.2 Query

```sql
SELECT a.id AS start_event_id, a.created_at AS started_at, a.actor_uid, a.role AS actor_role, u.name AS actor_name,
       a.resource_id AS case_id, a.metadata,
       f.id AS facility_id, f.display_name AS facility_name,
       t.at_start_status AS timeout_at_start_status,
       t.current_status AS timeout_followup_status,
       t.current_completed_at AS timeout_documented_at,
       t.current_metadata->'timeout' AS timeout_meta
  FROM audit_logs a
  LEFT JOIN facilities f ON f.tenant_id = a.tenant_id AND f.id = NULLIF(a.metadata->>'facility_id', '')::int
  LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.uid = a.actor_uid
  LEFT JOIN cath_lab_attempt_readiness_records t
         ON t.tenant_id = a.tenant_id
        AND t.case_id = NULLIF(a.resource_id, '')::bigint
        AND t.procedure_attempt = NULLIF(a.metadata->>'procedure_attempt', '')::int
        AND t.check_type = 'timeout'
 WHERE a.tenant_id = $1::uuid
   AND a.action = 'cath_lab.case.started_with_readiness_pending'
   -- audit_logs.created_at is timestamp(6) WITHOUT time zone written by NOW() under UTC-pinned sessions.
   -- Convert the BOUNDS to that naive-UTC shape, never the column, so idx_audit_logs_tenant_time_id
   -- (tenant_id, created_at DESC, id DESC) can range-scan it.
   AND a.created_at >= ($2::timestamptz AT TIME ZONE 'UTC')
   AND a.created_at <  ($3::timestamptz AT TIME ZONE 'UTC')
   AND ($4::int IS NULL OR NULLIF(a.metadata->>'facility_id', '')::int = $4::int)
 ORDER BY a.created_at DESC, a.id DESC
```

`$2` / `$3` are IST bounds as instants. EXPLAIN uses a statistically refreshed, representative fixture (at least 100,000 audit rows; target tenant-month at 1–5% selectivity). Acceptance is correctness plus bounded work: total shared hit+read blocks no more than `max(64, ceil(relation_blocks * 0.10))`, no spill/temp I/O, and actual returned rows equal the independent count. The chosen scan node is diagnostic, not a universal assertion: a tiny fixture may rationally use a sequential scan. The attempt join's unique key prevents later attempts from rewriting earlier outcomes.

### 7.3 Response

```json
{
  "month": "2026-09",
  "facility_id": null,
  "total_events": 3,
  "distinct_cases": 2,
  "facilities": [{ "facility_id": 4, "facility_name": "Main block", "events": 2, "cases": 1 }, { "facility_id": 7, "facility_name": "Annexe", "events": 1, "cases": 1 }],
  "timeout_outcomes": { "not_pending_at_start": 1, "performed_before_clinical_start_documented_late": 1, "performed_after_clinical_start": 0, "not_documented": 1, "not_performed": 0, "performance_unknown": 0 },
  "consent_authorities": { "patient": 2, "legally_authorised_representative": 0, "emergency_basis": 1, "not_recorded": 0 },
  "rows": [{
    "start_event_id": 88121, "case_id": 1201, "procedure_attempt": 2,
    "facility_id": 4, "facility_name": "Main block",
    "urgency": "emergency", "via": "status", "started_at": "2026-09-06T05:02:11.000Z",
    "blocking_check_types": ["labs", "timeout"], "missing_lab_items": ["hb"], "lab_component_status": "fresh",
    "consent_authority": "emergency_basis", "timeout_outcome": "performed_before_clinical_start_documented_late",
    "reason": "Primary PCI, outside reports awaited",
    "actor_uid": "…", "actor_role": "CONSULTANT", "actor_name": "Dr …"
  }]
}
```

`timeout_outcome` is attempt-specific. `not_pending_at_start` comes only from immutable at-start facts. Otherwise: an explicit attested omission is `not_performed`; no follow-up record is `not_documented`; performed evidence with no clinical start is `performance_unknown`; otherwise compare `performed_at` with clinical `attempt_started_at`, and compare documentation with `attempt_start_recorded_at`. Later attempt writes cannot change this row. `missing_lab_items: null` remains unknown.

### 7.4 What the report is, who sees it, and how far

**It is identifiable operational data.** Case ids are internal keys but they resolve to a patient in one join, and every row names the operator who started the case. It is not anonymous and is not described as such anywhere (the Admin tab's header says "This report identifies cases and operators").

**Role gate**: `CATH_READINESS_REPORT_ROLES = [ADMIN, SUPER_ADMIN, CATH_LAB_INCHARGE, QUALITY_OFFICER]`, `requireRole(...)` at route level on both mounts.

**Object-level scope (owner's point: object-level authorisation ≠ route role).** Verified on `main`: the platform has **no** general staff→facility membership primitive — the only one is `pharmacy_staff_facility_grants`, owned by pharmacy; `users` carries no facility; the cath guards (`cathLabAccessGuards.js`) are **patient**-access guards, not facility guards; and the cath lab in-charge's existing tenant-wide cath read, the day list (`GET /cases`, `listCases`), has no facility predicate and is "deliberately NOT guarded (no single patient subject — role gate only)". So today a `CATH_LAB_INCHARGE` sees every facility's cath cases. The report shows strictly less than the day list does about each case. **Decision, by precedent**: the in-charge reads the report tenant-wide, exactly as the day list; ADMIN / SUPER_ADMIN / QUALITY_OFFICER read it tenant-wide by their nature; every row carries `facility_id` and the `facility_id` filter narrows the view. **If the owner wants the in-charge scoped to their facilities, that is a platform primitive (a staff–facility grant table like pharmacy's) and a lane of its own; it is recorded as §10.2's one open confirmation with this default so implementation is not blocked.** The projection of `reason` by `roleSeesSerologyDetail` is unchanged (QUALITY_OFFICER reads `null`).

**Audit on both mounts is durable and fail-closed.** Baseline `logAudit` catches insert failures and omits explicit `tenant_id`, so this report does not use it. `recordCathReadinessReportAccessTx` runs an explicit-tenant insert through the tenant transaction and propagates failure; the handler sends neither JSON nor CSV unless it commits. Failure is 500 `CATH_LAB_REPORT_AUDIT_FAILED`. The DB test uses a non-default tenant and reads the actual row's `tenant_id`, action, mount and format.

### 7.5 Canary and OpenAPI

As revision 1 (+2 reachable entries, positive control ADMIN reads the sentinel, liveness QUALITY_OFFICER reads `null`), plus the CSV form of both (§6.5) and the `facility_id` parameter in the overlay.

### 7.6 Admin surface

The tab gains a facility filter, the `procedure_attempt`, `consent_authority` and `timeout_outcome` columns, the two breakdown blocks, and the header line about identifiability. Reads the governance mount as before.

## 8. Data model — migration NNN

### 8.1 Why a migration now (and why not in revision 1)

Revision 1 kept everything in `metadata` and existing columns. The owner's point 4 — "'no migration' must not determine clinical meaning" — is accepted: the attempt lifecycle is a clinical fact, it is read by every rule, it is compared against the process clock and against lab instants through epoch twins, and it must be enforceable by a CHECK. A JSON key can be none of those cleanly. The cause of unavailability, likewise, has to be **stable across refreshes**, which means it must be persisted beside the state it explains.

`apps/backend/src/migrations/NNN_cath_lab_case_attempts.sql` — NNN is the next free number **above 767** at push time. Current remote branches top at 766. The file is applied only inside the coordinated rollout in §13 after old writers are quiesced. Its internal order is expand → classified backfill → enforce:

```sql
-- NNN_cath_lab_case_attempts.sql — spec 2026-09-06 revision 3.
-- PRECONDITION: the inventory in §13 returned zero unresolved rows and all old
-- writers are quiesced. Do not invent clinical time from created_at.
ALTER TABLE cath_lab_cases
  ADD COLUMN procedure_attempt INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN lifecycle_token UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN attempt_start_recorded_at TIMESTAMPTZ(6),
  ADD COLUMN attempt_started_at TIMESTAMPTZ(6),
  ADD COLUMN attempt_start_time_provenance VARCHAR(40),
  ADD COLUMN lab_readiness_generation BIGINT NOT NULL DEFAULT 0;

-- Existing actual_start_at is known only as the legacy server recording time;
-- it is not proof of clinical occurrence time.
UPDATE cath_lab_cases
   SET attempt_start_recorded_at = actual_start_at,
       attempt_started_at = NULL,
       attempt_start_time_provenance = 'legacy_recording_only'
 WHERE actual_start_at IS NOT NULL;

ALTER TABLE cath_procedure_logs
  ADD COLUMN procedure_attempt INTEGER,
  ADD COLUMN lifecycle_token UUID,
  ADD COLUMN log_command_id VARCHAR(128);
UPDATE cath_procedure_logs l SET procedure_attempt = 1, lifecycle_token = c.lifecycle_token
  FROM cath_lab_cases c WHERE c.tenant_id = l.tenant_id AND c.id = l.case_id;
CREATE UNIQUE INDEX uq_cath_procedure_log_command
  ON cath_procedure_logs (tenant_id, case_id, log_command_id)
  WHERE log_command_id IS NOT NULL;

CREATE TABLE cath_lab_attempt_readiness_records (
  tenant_id UUID NOT NULL,
  case_id BIGINT NOT NULL,
  procedure_attempt INTEGER NOT NULL,
  check_type VARCHAR(40) NOT NULL CHECK (check_type IN ('consent','timeout')),
  lifecycle_token UUID NOT NULL,
  server_provenance VARCHAR(40),
  current_status VARCHAR(40) NOT NULL,
  current_completed_at TIMESTAMPTZ(6),
  current_completed_by UUID,
  current_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  at_start_status VARCHAR(40),
  at_start_completed_at TIMESTAMPTZ(6),
  at_start_metadata JSONB,
  at_start_evidence_refs JSONB,
  at_start_recorded_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, case_id, procedure_attempt, check_type),
  CONSTRAINT fk_cath_attempt_readiness_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_cath_attempt_readiness_case
    FOREIGN KEY (tenant_id, case_id) REFERENCES cath_lab_cases(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT cath_attempt_readiness_status_check
    CHECK (current_status IN ('pending','pass','fail','waived','not_applicable')),
  CONSTRAINT cath_attempt_readiness_refs_check
    CHECK (jsonb_typeof(current_evidence_refs) = 'array'
       AND (at_start_evidence_refs IS NULL OR jsonb_typeof(at_start_evidence_refs) = 'array'))
);
-- Backfill current consent/time-out rows for attempt 1. A consent pass without
-- structured evidence receives server_provenance='legacy_pre_NNN'; clients can
-- never write this column. Copy attachment/evidence references into the archive.
INSERT INTO cath_lab_attempt_readiness_records (
  tenant_id, case_id, procedure_attempt, check_type, lifecycle_token,
  server_provenance, current_status, current_completed_at, current_completed_by,
  current_metadata, current_evidence_refs
)
SELECT r.tenant_id, r.case_id, 1, r.check_type, c.lifecycle_token,
       CASE WHEN r.check_type = 'consent' AND r.status = 'pass'
            THEN 'legacy_pre_NNN' ELSE 'legacy_projection' END,
       r.status, r.completed_at, r.completed_by, COALESCE(r.metadata, '{}'::jsonb),
       CASE WHEN r.evidence_owner IS NULL AND r.source_name IS NULL
                  AND r.source_version IS NULL AND r.attachment_ref IS NULL
            THEN '[]'::jsonb
            ELSE jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
              'evidence_owner', r.evidence_owner,
              'source_name', r.source_name,
              'source_version', r.source_version,
              'attachment_ref', r.attachment_ref))) END
  FROM cath_lab_readiness_checks r
  JOIN cath_lab_cases c ON c.tenant_id = r.tenant_id AND c.id = r.case_id
 WHERE r.check_type IN ('consent', 'timeout');

ALTER TABLE cath_lab_attempt_readiness_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_lab_attempt_readiness_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cath_lab_attempt_readiness_records
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

ALTER TABLE cath_lab_cases
  ADD CONSTRAINT cath_lab_cases_attempt_check
    CHECK (procedure_attempt >= 1),
  ADD CONSTRAINT cath_lab_cases_attempt_record_check
    CHECK (attempt_start_recorded_at IS NULL OR actual_start_at IS NOT NULL),
  ADD CONSTRAINT cath_lab_cases_in_progress_attempt_check
    CHECK (status <> 'in_progress' OR (attempt_start_recorded_at IS NOT NULL AND actual_end_at IS NULL)),
  ADD CONSTRAINT cath_lab_cases_pre_start_attempt_check
    CHECK (status IN ('in_progress', 'completed', 'cancelled') OR attempt_start_recorded_at IS NULL),
  ADD CONSTRAINT cath_lab_cases_clinical_start_provenance_check
    CHECK (attempt_started_at IS NULL OR attempt_start_time_provenance IS NOT NULL);

ALTER TABLE cath_case_lab_readiness_items
  ADD COLUMN unavailability_cause VARCHAR(30),
  ADD COLUMN window_days INTEGER,
  ADD COLUMN evidence_fingerprint CHAR(64),
  ADD COLUMN policy_fingerprint CHAR(64),
  ADD COLUMN last_accepted_evidence JSONB,
  ADD COLUMN classifier_initialized_at TIMESTAMPTZ(6);

ALTER TABLE cath_case_lab_readiness_items
  ADD CONSTRAINT cath_case_lab_readiness_items_cause_check
    CHECK (unavailability_cause IS NULL OR unavailability_cause IN
      ('aged_out', 'future_dated', 'unparseable', 'withdrawn', 'corrected', 'policy_changed', 'reordered'));

ALTER TABLE cath_procedure_logs
  ALTER COLUMN procedure_attempt SET NOT NULL,
  ALTER COLUMN lifecycle_token SET NOT NULL;
```

The migration also enables/forces RLS and adds tenant policies on the new attempt table before data is readable. `schema.prisma` is updated for all affected models. The CHECKs prove only lifecycle timestamp/end-field shape; they do **not** prove consent or that `startCaseTx` was used.

### 8.2 The snapshot (rules module, pure)

```js
export const START_SNAPSHOT_KEYS = Object.freeze([
  'recorded_at', 'clinical_started_at', 'clinical_start_provenance', 'procedure_attempt', 'lifecycle_token',
  'via', 'command_id', 'procedure_log_id', 'urgency', 'reason',
  'blocking', 'missing_lab_items', 'readiness_picture_at', 'lab_component_status', 'consent_authority',
]);
export const START_VIAS = Object.freeze(['status', 'procedure_log']);
export const LAB_COMPONENT_STATUSES = Object.freeze(['fresh', 'stale', 'unavailable']);
export const START_PICTURE_FRESH_MS = 300_000;
export function buildStartSnapshot({ recordedAt, clinicalStartedAt = null, clinicalStartProvenance = null, procedureAttempt, lifecycleToken, via, commandId, procedureLogId = null, urgency = null, reason = null, blocking = [], missingLabItems = null, readinessPictureAt = null, labComponentStatus = 'unavailable', consentAuthority = null })
export function normalizeStartSnapshot(raw)        // exactly START_SNAPSHOT_KEYS, or null
export function startedWithReadinessPending(raw)   // true | false | null  (null when raw is not a snapshot)
export function missingLabItemCodes(items, settings)
export function labComponentStatus({ pictureAt, itemCount, now })
```

`missing_lab_items` is `null` when `lab_component_status === 'unavailable'` and an array otherwise (possibly empty).

### 8.3 Reserved keys at create

`CASE_START_METADATA_KEYS = ['readiness_at_start', 'readiness_at_start_history', 'start_commands']` stripped from `input.metadata` in `createCase`.

### 8.4 Reads

`caseRowTx`, `caseById` and `listCases` explicitly select the lifecycle token, both attempt clocks, provenance, attempt number and cache generation. Operational “started” reads use `attempt_start_recorded_at`; clinical comparisons use nullable `attempt_started_at`. No read path selects the full metadata/history object.

## 9. Error handling and idempotency

| Code | HTTP | When |
|---|---|---|
| `CATH_LAB_CONSENT_REQUIRED` | 400 | Either start path while the `consent` check is not `pass`. Raised by `assertConsentDocumented`, reached only through `startCaseTx`. |
| `CATH_LAB_CONSENT_AUTHORITY_REQUIRED` | 400 | Consent record missing its authority-conditional evidence fields. |
| `CATH_LAB_CONSENT_AUTHORITY_NOT_PERMITTED` | 400 | A `consent` pass whose authority the tenant's consent policy does not admit; `details.permitted`. |
| `CATH_LAB_TIMEOUT_PERFORMED_AT_REQUIRED` | 400 | A `timeout` pass written without a usable past `metadata.timeout.performed_at`. |
| `CATH_LAB_START_REASON_REQUIRED` | 400 | Status start, gate not clear, `reason` empty; `details.blocking`. |
| `CATH_LAB_START_COMMAND_REQUIRED` | 400 | Status start without a well-formed `command_id` (`normalizeCommandId` → `null`); `details.reason ∈ {missing, malformed}`. |
| `CATH_LAB_START_COMMAND_STALE` | 409 | The `command_id` started a different attempt of this case; `details: { command_attempt, current_attempt, case_status }`. |
| `CATH_LAB_LIFECYCLE_TOKEN_REQUIRED` / `CATH_LAB_LIFECYCLE_STALE` | 400 / 409 | Attempt-specific write lacks the server token, or the case has rotated to another lifecycle. |
| `CATH_LAB_PROCEDURE_LOG_COMMAND_REQUIRED` / `CATH_LAB_PROCEDURE_LOG_COMMAND_CONFLICT` | 400 / 409 | Log lacks independent idempotency identity, or the command is reused with a changed request. |
| `CATH_LAB_CASE_STATUS_NOT_CREATABLE` | 400 | `POST /cases` with a status outside `CREATABLE_STATUSES`; `details.creatable`. |
| `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED` | 409 | Any `POST /cases/:id/status` on a `cancelled` case, and `POST /cases/:id/procedure-logs` on one — before any write; `details.reopen_path`. |
| `CATH_LAB_CASE_START_NOT_ELIGIBLE` | 409 | `POST /cases/:id/procedure-logs` on a `requested` (or unexpected-status) case, before the insert; `details.next_action`. |
| `CATH_LAB_REOPEN_REASON_REQUIRED` | 400 | `POST /cases/:id/reopen` with an empty `reason`. |
| `INVALID_STATE_TRANSITION` | 400 | `in_progress` from `requested` / `completed` / `in_progress` as today; `POST /cases/:id/reopen` on a non-cancelled case (`allowed` = that status's real targets). |
| `CATH_LAB_REPORT_MONTH_INVALID` / `CATH_LAB_REPORT_FACILITY_INVALID` | 400 | Report parameters. |
| `CATH_LAB_REPORT_AUDIT_FAILED` | 500 | Required explicit-tenant report access audit did not commit; no report body is sent. |
| `CATH_LAB_START_VIA_INVALID` | 400 | Internal guard in `buildStartSnapshot`; unreachable from a client, documented because the pin will find it. |
| `CATH_LAB_READINESS_BLOCKED` | — | **Removed** with the full gate (and the function that raised it). |
| `CATH_LAB_READINESS_CASE_STARTED` | 409 | **Kept**, one thrower: `unwaiveLabItem` (#1018 lift-no, verified on `main`). |

**Machine-checked coverage.** `CASE_LIFECYCLE_ERROR_CODES` and the bidirectional scan include lifecycle and procedure-log-command families plus report audit failure. The OpenAPI prose for every affected operation names its request fence and error.

Idempotency: the status route claims no key (replay safety is the command id, §4.10); `cath_lab_case_reopen` on `POST /cases/:id/reopen`, one key per user decision.

## 10. Owner items

### 10.1 Recorded decisions (2026-09-06) — settled

1. Second signature / role restriction on "Start anyway" — **NO** (decision 4).
2. Monthly report — **YES**, as §7 (amended by decision 23).
3. Alert when consent is pending at start — **MOOT**.
4. The procedure record on a cancelled case — **REFUSE, BUT GIVE IT A DOOR** (decision 13; the two doors rejected in revision 1 stay rejected: a distinct `reopened` status, and `cancelled → in_progress` through `startCaseTx`).
5. Revision-2 decisions 14–25 are design decisions inside the owner's five, taken here with their reasons; the owner is asked to approve them as part of the documents. Three of them make a clinical-meaning choice and are called out so they are not missed: **a draft log does not start the case** (16); **consent and time-out reset on a new attempt** (17, §4.8); **Start = the beginning of the invasive procedure** (22).

### 10.2 Open — one owner confirmation, with a decided default

1. **Report scope for `CATH_LAB_INCHARGE`.** Default (decided by precedent, §7.4): tenant-wide, exactly as the day list the same role already reads; `facility_id` filter and per-row facility for narrowing. If the owner wants the in-charge limited to facilities they are assigned to, the platform first needs a staff–facility grant primitive (the only one today is pharmacy's), and that is a separate lane. Implementation is not blocked on this.

Not an owner-design question: the hospital's clinical/legal governance must approve each tenant consent-policy version and evidence requirements before activation; there is no implicit all-three production default. The principle applies to every urgency; #1018's record-yes / lift-no and `requested` not start-eligible remain settled.

## 11. Client scope

**Staff (Flutter).** Models expose server `lifecycleToken`, `labReadinessGeneration`, `attemptStartRecordedAt`, nullable clinical `attemptStartedAt`, provenance, the 15-key snapshot, fingerprints, conditional consent evidence, time-out outcome, and read-only attempt history. Client serializers cannot emit provenance/history/token except by copying the latest token to `expected_lifecycle_token`. Cached readiness renders immediately; refresh is scheduled without blocking the load. Patient/representative consent forms require policy-provided mode/evidence/scope (plus representative reference); emergency basis hides mode and requires an approved document reference or justification+attestation. Time-out distinguishes performed, explicitly not performed, and undocumented/unknown; clinical and recording times are labelled separately. The `staff:lab` path carries lifecycle token + monotonic generation, uses trailing debounce with a maximum wait, reloads on reconnect, and drops stale-token or lower-generation responses. Localization has exactly **53 keys × 5 locales**: revision 2's 40, with the emergency caption's `{mode}` placeholder removed, plus 13 keys for evidence reference, scope, representative reference, emergency document reference, emergency justification, emergency attestation, `not_documented`, `performance_unknown`, `not_performed`, clinical start time, server recording time, reconnecting, and stale-response suppression. The guard pins the exact set and placeholders.

**Admin (Next.js).** `StartsWithPendingTab.tsx` with the facility filter, the new columns and the two breakdowns; `lib/api/cathDevices.ts` gains the path constant and the two functions (`month`, `facilityId?`); `page.tsx` gains the tab; test.

## 12. Testing and gates

The plan carries the tests task by task; this section names the ones the owner asked for so their presence can be checked against the plan.

**Unit**: all revision-2 coverage plus status Start dispatch before transition validation; lifecycle-token validation/rotation on Start, cancel, reopen, consent, time-out and logs; independent log-command replay; conditional consent shapes; legacy server provenance; two-clock timeout outcomes; fingerprint bootstrap/corrections/lookback cases; exact 9+2 writer population plus synthetic new SQL and ORM writer rejection; attempt-keyed report join and required-audit failure policy.

**Deep**: same-command replay through the real status endpoint; delayed first Start and stale consent/time-out across both kinds of reopen; attempt-1 full documentation then attempt-2 document/amend with attempt-1 evidence/report unchanged; two-connection lock test and cached-load hung-refresh test; explicit not-performed versus not-documented; clinical-time unknown on retrospective log; fingerprint correction/withdrawal/lookback/bootstrap cases; required report audit persisted under a non-default tenant and fail-closed injection; commit→publish→emit ordering.

**Staff widget**: the revision-1 list, plus the **end-to-end live-warning test**, the paused / denied states, the consent choosers writing `metadata.consent`, the emergency-basis caption never containing "consent", the time-out `performed_at` field, the stale-command handling, the tri-state banner logic, the reopen dialog's new-attempt note.

**Admin**: facility filter, breakdowns, new columns, identifiability header, CSV.

**Canary**: CSV bodies, all free-text sentinels, current reachable-role survey, and nested canonical-timeline payload projections are release-blocking.

**Mutation checks** (each: apply, run the named test, confirm red, revert) — revision 1's 1–15 with these amendments and additions:

1–2. `agedOnly`: delete `started &&` → pre-start staleness tests red only; delete `!agedOnly` → post-start aged-out test red.
3. `assertConsentDocumented`: `!== 'pass'` → `!READINESS_CLEAR_STATES.includes(...)` → consent-waived tests red.
4. Move the consent assertion into `transitionCaseStatus` → pin red; procedure-log consent deep test red.
5. Delete `via === 'status'` → procedure-log "no reason needed" test red.
6. Delete the reason blanking → canary liveness red (block, report JSON, report CSV).
7. Restore `AND actual_start_at IS NULL` → sign-off-after-start deep test red.
8. Collapse the tri-state fold to a boolean → the legacy-snapshot day-list test red.
9. `afterCaseStartMs` returns `false` → marker tests red.
10. Delete `CASE_START_METADATA_KEYS` stripping → reserved-key unit test red (`start_commands` included).
11. Register the report route after `/reports/:id` → cath-mount route probe red.
12. Stray `UPDATE cath_lab_cases SET actual_start_at = NOW()` elsewhere → pin red; a stray `SET attempt_started_at = NOW()` elsewhere → pin red.
13. Delete the `cancelled` refusal in `recordProcedureLog` → unit + deep red.
14. Make `reopenCaseTx` write `in_progress` → pin red on two assertions.
15. Drop `actual_end_at = NULL` from reopen, then start with a preserved historical end → direct assertion that an `in_progress` row must have `actual_end_at IS NULL` fails (and `cath_lab_cases_in_progress_attempt_check` raises 23514). The proof does not compare the end with preserved `actual_start_at`.
16. **Restore `CASE_STATUSES` in `createCase`** → route-level creation test red **and** the INSERT pin red.
17. **Delete the `=== 'cancelled'` short-circuit in `transitionCaseStatus`** → the generic-status bypass deep test red (`readiness_pending` reached without a reason or an audit row).
18. **Replace the explicit `!== 'cancelled'` in `reopenCaseTx` with the table check alone** → the `/reopen` on `scheduled` test red.
19. **Let a draft log start the case** → the draft-does-not-start unit and deep tests red.
20. **Do not increment `procedure_attempt` on reopen of a started attempt** → the aged-out-before-next-attempt deep test red (attempt 2's snapshot reads `procedure_attempt: 1`; the second audit row collides).
21. **Compare markers / regime against `actual_start_at` instead of `attempt_started_at`** → the reopen test red (staleness suppressed before attempt 2 started; markers true pre-start).
22. **Hold the case-row lock during evidence resolution or await refresh in Start** → the real two-connection test red while connection A remains paused.
23. **Return `[]` instead of `null` for missing item rows** → the unknown-picture test red.
24. **`cause === 'aged_out'` → `state === 'stale'`, or carry age without equal fingerprints** → policy/correction tests red; repeat-order test red the other way.
25. **Move Start dispatch after `validateCaseTransition`, drop the lifecycle token, or omit token rotation on never-started reopen** → endpoint replay/delayed-first-delivery tests red.
26. **Say "Consent obtained" for `emergency_basis`** → the Staff caption test red.
27. **Transform the column instead of the bounds in the report predicate** → the SQL-text unit test red **and** the EXPLAIN gate fails (seq scan).
28. **Use catch-and-log `logAudit`, omit explicit tenant binding, or remove required audit from a mount** → non-default-tenant/failure-injection tests red and no body may be sent.
29. **Skip the consent/time-out reset on reopen** → the attempt-2 consent-required assertion red.
30. **Persist no `unavailability_cause`** → the two-refresh stability test red (second refresh retracts).
31. **Feed the guard a newly introduced parameterised SQL writer and ORM upsert** → it must reject both with the named unknown-writer errors; also keep the exact-list shrink mutation for interpolated table names.

**Gates** (Plan 3 Task 7 / Plan 2 Task 8 as template): backend lint; the **full** unit corpus; **two fresh-DB deep runs** of `cath-lab-readiness.deep|cath-reporting.deep|lab-signoff-safety.deep|bloodborne-markers.deep`; `openapi:check`; `check:migration-numbers` and `check:migration-immutability` (**live** this time — NNN is claimed); schema drift; `scripts/ci/security.mjs`; the EXPLAIN acceptance; Flutter analyze + `flutter test` for cath_lab and i18n; Admin lint + jest; the canary with the snapshot diff inspected; the mutation list above; a final `[full-ci]` commit; **draft PR only**, handed to the merge authority (dev-1b) with both gates named from the tier-verifying poller. Read `Suites failed` separately from `Tests passed`.

## 13. Rollout and compatibility

1. **Preflight, read-only.** Inventory by tenant/status: `in_progress` with null `actual_start_at`; pre-start with non-null `actual_start_at`; end before start; procedure logs with no case; consent passes without structured evidence; and every existing writer/build version. Save counts and ids. Production rollout stops until the owner approves a remediation disposition for every inconsistent row. Never infer historical start from `created_at` or log insertion time. Dev/test fixtures are repaired or deleted under their fixture policy, not silently backfilled.
2. **Quiesce old writers.** Drain the old backend and block cath mutations at ingress. `NOT VALID` is not used as a compatibility fiction: it would still enforce new writes. Record zero active old pods/connections before schema change.
3. **Execute NNN: expand.** With ingress blocked and old writers at zero, the immutable migration first adds nullable/new columns, attempt table, index, RLS and server defaults. No application version is started between internal phases.
4. **Execute NNN: classified backfill and enforce.** In the same controlled migration run, legacy `actual_start_at` becomes only `attempt_start_recorded_at` with `legacy_recording_only`; clinical start stays null. Logs and consent/time-out records are backfilled, preflight assertions are rerun, then CHECKs/not-null enforcement are applied and the migration commits. Failure before commit rolls the migration back; no partial schema is treated as compatible.
5. **Deploy/read back.** Deploy the token-aware backend, then Staff/Admin. Verify cached loading, token rotation, attempt joins and required audit under a non-default tenant before reopening ingress. After NNN commits, rollback means keep the schema and roll forward/fix the new writer; never restart an incompatible old writer.
6. **Bootstrap classifiers.** First refresh initializes evidence/policy fingerprints without calling it a policy change. No bounded-lookback absence becomes withdrawal.

Cases already `in_progress` have unknown clinical start and no snapshot (`started_with_readiness_pending: null`). The reachable canary snapshot changes by exactly two report GETs.

## 14. Risks accepted

- An emergency start is one tap and one line away for the whole workflow audience (owner decision B).
- Required consent evidence is conditional: mode is required only for patient/representative; emergency basis requires reference or attested justification. Clinical/legal policy approval is a deployment gate.
- The cached picture may lag until refresh completes; no bounded completion time is claimed.
- A check passed after start looks like any other pass on surfaces that do not compare server `completed_at` to `attempt_start_recorded_at`; clinical occurrence comparisons remain separate.
- Free text reaches every entitled role (five fields, §6.5) and is blanked for the rest.
- A tenant policy edit mid-procedure retracts the labs check (`policy_changed`) — rare, truthful, gates nothing once started.
- `cancelled` is no longer terminal; a reopen of a started case opens a new attempt with consent and time-out to re-document — one tap each, previous documentation in view.
- The in-charge's report scope is tenant-wide by precedent until the owner says otherwise (§10.2).
- Generic tenant `staff:lab` events are nudges; case-specific `cath-readiness-updated` events carry token/generation. Open checklists coalesce nudges with the bounded debounce, perform cached reloads and schedule resolution without putting a read-through refresh on the UI critical path.
- Ordinary creation historically could produce inconsistent running rows. Preflight and owner-approved remediation are mandatory before constraints; CHECKs do not establish consent.

## 15. Reconciliation with the merged baseline

1. **#1018 is merged** (`3f3959306`, head `a0144fc00`). `unwaiveLabItem` throws `CATH_LAB_READINESS_CASE_STARTED` after start; `waiveLabItem` does not; `recorded_after_start` on the item and the waive audit; no `lifted_after_start`. **Decision 9 = KEPT.** Only the `case_started` description and the order-missing / external-result 409 lists change in the overlay; `cathLabRouteGuards.test.js`'s deterministic-409 probe is untouched.
2. **#1022 is merged** (`35a231238`): `externalReportedMs` reads a date-only outside report as an IST calendar date. §5.6's `unparseable` / `future_dated` causes are computed on the resolver's `observedMs`, which already goes through it, so an outside report dated today is neither.
3. `isAfterCaseStart`, `resolveItemState`'s operational `caseStartedAt` and `computeCheckDecision`'s `started` all move from `actual_start_at` to server `attempt_start_recorded_at`; clinical comparisons alone use nullable `attempt_started_at`.
4. `recorded_after_start` stays #1018's; the three new markers sit beside it.
5. Staff panel gates, imports, OpenAPI regeneration — as revision 1.

## 16. Verification ledger (re-verified on `github/main` `db30fe80b`, 2026-09-07; cite by function name)

| Claim | Where | Status |
|---|---|---|
| `CASE_STATUSES` (7), `CASE_TRANSITIONS` — `in_progress` only from `ready`, `cancelled: []` | `cathLabService.js` | verified |
| `createCase` normalises `input.status` against **`CASE_STATUSES`** and inserts it; seeds eight pending checks; takes `metadata` from input | `cathLabService.js` — `createCase` (`const status = input.status ? normalizeStatus(input.status, CASE_STATUSES, 'status') : 'scheduled'`) | verified — **the creation bypass** |
| The creation route passes the body through | `routes/clinical/cathLabRoutes.js` — `router.post('/cases', requireCathWorkflow, guardCathCaseCreate, …)` → `createCase({ ...req.body, tenantId })` | verified |
| `guardCathCaseCreate` / `guardCathCaseById` are **patient**-access guards, not facility guards | `routes/clinical/cathLabAccessGuards.js` — `cathCaseCreateGuard`, `cathCaseGuard` over `routePatientGuard` | verified |
| Exactly two `INSERT INTO cath_lab_cases` in shipping code | `cathLabService.js` — `createCase`; `stemiPathwayService.js` — `spawnCathCase` (literal `'readiness_pending'`, `'emergency'`) | verified (grep over `apps/backend/src`, tests excluded; migration 753's UPDATEs are `.sql`, outside the pin's file set) |
| No `ON CONFLICT` / upsert on `cath_lab_cases` | grep | verified |
| The 8 `UPDATE cath_lab_cases` literals in shipping code and which assign `status` | `cathLabReadinessService.js:recomputeCaseStatusTx` (status, bound); `cathLabService.js`: `updateCaseCanonicalRefs` (refs), `updateReadinessCheck` (status, bound), `transitionCaseStatus` (status `$3`, `actual_start_at = CASE`), `recordProcedureLog` (status literal `'in_progress'`, `actual_start_at = COALESCE`), `resolveCathConsumableAuthorityRecovery` (facility_id, **metadata merge**); `cathSchedulingRegistryService.js:scheduleCase` (planned times, room); `stemiPathwayService.js:spawnCathCase` (refs) | verified — **corrects revision 1**: `metadata` has one existing UPDATE writer (a `\|\|` merge); after this lane the population is **nine** (§4.3 population pin) |
| `assertReadinessComplete` → `CATH_LAB_READINESS_BLOCKED`; exactly two callers | `cathLabService.js` — callers `transitionCaseStatus`, `recordProcedureLog` | verified |
| `transitionCaseStatus`: `validateCaseTransition` then the generic UPDATE with `actual_start_at = CASE WHEN $3 = 'in_progress' …` and `actual_end_at = CASE WHEN $3 IN ('completed','cancelled') …`; cancel reason on the canonical event payload and in `cancelWorkflowSla` metadata; no `cancelled` special case | `cathLabService.js` — `transitionCaseStatus` | verified — **2a: `readiness_pending` from `cancelled` would pass once the table entry exists** |
| `recordProcedureLog`: gate call, then INSERT with `status` normalised to `draft|finalized|amended` (default `finalized`), then `if (cathCase.status !== 'in_progress')` force-start UPDATE — **no branch for `requested` or `cancelled`** | `cathLabService.js` — `recordProcedureLog` | verified |
| `validateCaseTransition(from, to)` permits `scheduled → readiness_pending` | `cathLabService.js` — `validateCaseTransition`, `CASE_TRANSITIONS.scheduled` | verified — **2b** |
| `caseById` selects explicit columns (no `metadata`) | `cathLabService.js` — `caseById` | verified |
| `cleanText(value, max = 8000)`; `normalizeStatus` throws `CATH_LAB_BAD_STATUS` | `cathLabService.js` | verified |
| `AppError.conflict(message, code, details)`, `.badRequest`, `.invalidTransition(from, to, allowed)` → `INVALID_STATE_TRANSITION` with `{ from, to, allowed }` | `utils/AppError.js` | verified |
| `unwaiveLabItem` throws `CATH_LAB_READINESS_CASE_STARTED` after start; `waiveLabItem` derives `recorded_after_start`; `isAfterCaseStart(cathCase)` reads `actual_start_at`; `orderMissingLabs` and `recordExternalLabResult` still refuse with the same code; `orderPriorityForUrgency(urgency)` | `cathLabReadinessActions.js` | verified on `main` (post-#1018) — decision 9 KEPT |
| `computeCheckDecision` `!started` on both branches, `started = Boolean(caseRow?.actual_start_at)`; `missing` entries `{ item, state }` | `cathLabReadinessRules.js` — `computeCheckDecision` | verified |
| `resolveItemState`: open orders resolved **before** the stale fallback (aged result + open order → `ordered_awaiting_sample`); `withinWindow` rejects future instants; `observedMs` → `externalReportedMs` (#1022) / `performed_at` / `received_at`; `rankResult` ranks future/unusable last; `waivedAfterStart` | `cathLabReadinessRules.js` | verified — **6: `stale` is not the only state an aged value can land in** |
| `refreshCaseLabReadiness` takes the case through `caseRowTx(..., { lock: 'no key update' })` before settings/results/orders and holds the transaction through publish; the baseline comment confirms that lock conflicts with writers' `FOR UPDATE` | `cathLabReadinessService.js` — `refreshCaseLabReadiness`, `caseRowTx`, `CASE_LOCK_CLAUSES` | verified — revision-3 lock split required |
| `refreshOpenCasesForPatient` predicate `status IN ('scheduled','readiness_pending','ready') AND actual_start_at IS NULL` | `cathLabReadinessService.js` | verified |
| `scheduleReadinessRefresh({ tenantId, patientUid, source })` — synchronous, boolean, never throws, per-patient collapse, serial tail, `setImmediate` first | `cathLabReadinessHooks.js` | verified |
| `getCase` calls `refreshCaseLabReadiness` as `SYSTEM_READ_THROUGH_CONTEXT` and logs failures | `cathLabService.js` — `getCase` | verified |
| `recordReadinessAudit(tx, { tenantId, action, resource, resourceId, context, metadata })` → `audit_logs` (tenant_id, uid, role, action, resource, resource_id, metadata, actor_uid, created_at) | `cathLabReadinessService.js` | verified |
| `logAudit` catches all insert errors and its INSERT omits explicit `tenant_id` (tenant appears only in metadata) | `utils/logAudit.js` — `logAudit` | verified — unsuitable for required report audit |
| `cathDeviceHistoryHandler` awaits `logDeviceHistoryAccess` before responding; `logPhiAccessBatch` / `logPhiAccess` | `routes/clinical/cathDeviceHistoryHandler.js`; `cathDeviceReuseService.js` | verified |
| `updateReadinessCheck`: metadata replaced by the request (merged back for `labs` only); `completed_at = CASE WHEN pending THEN NULL ELSE COALESCE($7, NOW())` (client-suppliable); status rewrite pre-start only | `cathLabService.js` — `updateReadinessCheck` | verified |
| `cath_lab_readiness_checks` columns; `cath_lab_readiness_completion_check` (`pending ⇒ completed_at IS NULL`) | `schema.prisma`; migration 482 | verified |
| `cath_lab_cases` columns (no `procedure_attempt`, no `attempt_started_at`, no `cancelled_at`, no `cancel_reason`); `metadata JSONB NOT NULL DEFAULT '{}'`; `cath_lab_cases_status_check` (7); `cath_lab_cases_actual_time_check` | `schema.prisma`; migration 482 | verified |
| `cath_case_lab_readiness_items` columns (`state`, `required`, `source`, `lab_result_id`, `observed_at`, `ordered_at`, `waived_at`, `refreshed_at`; no cause, no window) ; `STORED_ITEM_SELECT` | migration 766; `cathLabReadinessService.js` | verified |
| `cath_lab_readiness_settings` (required_items, lab_validity_days, auto_pass, external_results_count, updated_at); `getReadinessSettings` returns defaults when absent | migration 766; `cathLabReadinessService.js` | verified |
| `tenants.settings Json @default("{}")` exists (per-tenant policy store for consent authorities) | `schema.prisma` — `tenants` | verified |
| `lab_results.received_at NOT NULL DEFAULT now()`, `signed_off_at` nullable, `status` | `schema.prisma` | verified |
| `audit_logs`: `created_at Timestamp(6)` (no zone); `idx_audit_logs_tenant_time_id (tenant_id, created_at DESC, id DESC)`; single-column `(action)` index (tenant-unaware) | `schema.prisma` — `audit_logs` | verified |
| `facilities.display_name`; `users.name`, `users.uid` | `schema.prisma` | verified |
| No staff→facility membership primitive except `pharmacy_staff_facility_grants`; `users` has no facility column; `listCases` has no facility predicate | `schema.prisma`; `cathLabService.js` — `listCases` | verified — §7.4 |
| `requireIdempotencyKey({ required, scope, … })` claims by (tenant, user, key, method, path, body hash); replay returns the cached response; 4xx cached | `middleware/idempotencyMiddleware.js` | verified |
| Staff idempotency convention: `IdempotencyAttempt(scope).keyFor(body)` mints one key per user decision and keeps it across retries, `reset()` after the write concluded; `IdempotencyKey.generate()` is a secure-random hex token (no `uuid` package in Staff or `vhhealth_core`) | `packages/vhhealth_core/lib/services/idempotency_key.dart`; `cath_lab_readiness_panel.dart` (`_orderAttempt`, `_externalAttempt`, `_waiveAttempt`, `_unwaiveAttempt`); `cath_lab_api_service.dart` (`waiveLabItem` takes `idempotencyKey`) | verified — why `command_id` is an opaque token, not a UUID |
| Checklist internals: `CathReadinessDependencies { loadReadiness, updateCheck }`, `_CathReadinessConfirmDialog` / `_CathReadinessConfirmResult`, `_setStatus`; `cathReadinessCheckLabel` | `cath_readiness_checklist.dart`; `cath_readiness_formatting.dart` | verified |
| i18n guard: `'Cath readiness copy has all five staff locale entries'` scans the checklist, panel and formatting files for the `s4.lib.cath_lab.readiness.` prefix | `apps/staff/test/i18n_guard_test.dart` | verified |
| Staff realtime: `RealtimeClient.events(channel)`, `connectionState`, `onConnectionStateChange`, denied channels; `RealtimeStatusBanner` (`watchChannels`, `deniedMessageKey`, `fallbackPoll`); cath screen listens to `staff:code-stemi` with a 400 ms debounce | `packages/vhhealth_core/lib/services/realtime_client.dart`; `apps/staff/lib/core/widgets/realtime_status_banner.dart`; `cath_lab_screen.dart` — `_attachStemiRealtime`, `_handleStemiRealtimeNudge` | verified |
| Backend `emitLabEvent(kind, { tenantId })` → `broadcast('staff:lab', …, { tenantId })`; kinds `result-signed`, `result-pending`, `alert-fired`, `alert-acked`; `staff:lab` in `CHANNEL_CATALOG`, staff-only | `utils/websocket/realtimeEmitter.js`; `labResultsService.js`; `utils/websocket/channelAuth.js` | verified |
| Checklist `_reload` → `CathLabApiService.fetchCaseReadiness` → `GET /cath-lab/cases/:id` (read-through) | `cath_readiness_checklist.dart`; `cath_lab_api_service.dart` | verified |
| Canary `disclosures()` serialises with `JSON.stringify`; no `text/csv` handling | `serologyDisclosureCanary.test.js` — `disclosures` | verified |
| `readCanonicalPatientTimeline` normalises canonical events without role-based nested payload projection. Current `main` has exactly two route callers, in `clinicalTimelineRoutes` and `patientSearchRoutes`; both use `patientAccessGuard`. | `canonicalClinicalPlatformService.js` — `readCanonicalPatientTimeline`; the two route modules | verified — reader/role matrix is a release condition |
| OpenAPI source pin: error-code scan = `/'(CATH_LAB_READINESS_[A-Z_]+)'/` over the three readiness modules + the cath router, both directions; `ERROR_CODES` (6) | `cathLabReadinessOpenApiSource.test.js`; `scripts/openapi/schemas/cathLabReadiness.mjs` | verified |
| `rowsToCsv` / formula neutralisation | `src/utils/csv.js` | as revision 1 |
| migration NNN free on every `refs/remotes/github/*` branch (all top at 766) | `git ls-tree` over the seven branches present at the check | verified 2026-09-07 — **re-check at push time** |
| `CATH_LAB_WORKFLOW_ROLES`, `CATH_LAB_INCHARGE`, `QUALITY_OFFICER`, `canUseCathWorkflow`, `normalizedRole` | `utils/roleHelpers.js` | verified |
| `router.get('/reports/:id', …)` exists (and `/reports/:id/pdf` before it) | `cathLabRoutes.js` | verified |
| Deep suite helpers: `seed`, `seedResult`, `labsCheck`, `caseStatus`, `pollForItem`, `asRlsRole`, `istDaysAgo`, `ctx`; `clinicalDate` imported from `services/clinical/bloodborneMarkerRules.js`; the regime test's **local** `age(days)` (rewrites `lab_results.performed_at`); **no** suite-level `setCheck` or `ageHgb` | `cath-lab-readiness.deep.test.js` | verified — the plan adds case-parameterised twins and lifts `age` to `ageHgb` |
