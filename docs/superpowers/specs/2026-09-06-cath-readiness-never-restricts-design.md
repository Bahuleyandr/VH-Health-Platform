# Cath-lab readiness checklist never restricts — design

- Date: 2026-09-06 (revision 1); **revision 2: 2026-09-07** — the owner review of PR #1023 (2026-09-06) addressed point by point
- Status: **draft, revision 2, awaiting owner design approval of the documents**. Docs only; no code on this branch. Revision 1 was returned by the owner on 2026-09-06 with the verdict "the overall direction is good, but I would not approve this exact revision yet"; every numbered point of that review is answered below and cross-referenced in §0. The five owner decisions and the non-restrictive principle stand unchanged; the owner's words: "these are corrections needed to implement the agreed decisions, not a request to restore the full readiness gate".
- Base: `github/main` at **`5857298dc`** (#1024 merged). That tree **includes #1018** (`feat/cath-readiness-followups`, head `a0144fc00`, merged as `3f3959306`) and **#1022** (`fix/cath-readiness-date-only-external-evidence`, head `9d730a417`, merged as `35a231238`). This lane builds on `main`; nothing is pending upstream. Every citation is by **function name** against that tree, re-verified 2026-09-07 (§16); line numbers are not load-bearing.
- #1018's shape, **verified on `main`** (no longer a Task 0 question): `waiveLabItem` is unguarded after start and derives `recorded_after_start`; `unwaiveLabItem` **still throws 409 `CATH_LAB_READINESS_CASE_STARTED`** (record-yes / lift-no). Decision 9's branch is therefore **KEPT** (§3 decision 9, §5.3): the code keeps exactly one thrower after this lane removes the order-missing and outside-result ones.
- Predecessors: `2026-09-04-cath-pre-procedure-lab-readiness-design.md` (Plan 3, shipped as #1008) and its plan `2026-09-04-cath-lab-readiness.md`; #1018 (waiver exit, day-list summary, rules/actions/persistence split, late waivers); #1022 (date-only outside reports read as calendar dates — it is why `externalReportedMs` exists and why "unparseable" and "future-dated" are distinct causes in §5.6).
- Plan: `docs/superpowers/plans/2026-09-06-cath-readiness-never-restricts.md`.


> **Migration number.** `NNN` = the next free migration number at push time. **767 is NOT this lane's:** it is reserved by the merge-authority session's Phase 1 isolation-derivation lane (dev-1b). Task 0 must re-check the free number when the branch is pushed; any lane that claims a number it does not own collides with the immutability gate.

## 0. What revision 2 changes, point by point (owner review 2026-09-06)

| Owner point | Answer | Where |
|---|---|---|
| 1. Creation bypass — `createCase` accepts any `CASE_STATUSES` value | Ordinary creation restricted to `CREATABLE_STATUSES = ['requested','scheduled','readiness_pending']`; the route validates; `in_progress` / `completed` / `cancelled` / `ready` refused with 400 `CATH_LAB_CASE_STATUS_NOT_CREATABLE`; migration NNN's CHECK makes a running row without an attempt start impossible at the database; the source pin covers every `INSERT INTO cath_lab_cases` **and** every `UPDATE cath_lab_cases` as a named population with a **known count** (9 UPDATE + 2 INSERT sites after the lane, by `path:function`; a write site reformatted out of the regex shrinks the list and fails loudly); no upsert on the table; route-level test. Historical import is a separate, explicitly governed path and is **out of scope**. | §3 d.14, §4.11, §4.3 pins, §8, §12 |
| 2a. Generic status endpoint reopens | `transitionCaseStatus` short-circuits on `status === 'cancelled'` **before** the table check and answers 409 `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED` naming `/reopen`; the table entry stays for consistency; tested. | §3 d.15, §4.2, §4.8 |
| 2b. Reopen precondition; signature mismatch | `reopenCaseTx` asserts `cathCase.status === 'cancelled'` explicitly, then the table check; `/reopen` tested against every non-cancelled status (incl. `scheduled`); signature is `reopenCaseTx(tx, { tenantId, cathCase, reason, context })` and it cleans `reason`, not `input.reason`. | §3 d.15, §4.8 |
| 3. `recordProcedureLog` leaves `requested` undefined; draft logs | Exhaustive outcome table by case status × log status; a **draft log does not start the case**; `requested` / unexpected refused before insertion with 409 `CATH_LAB_CASE_START_NOT_ELIGIBLE` naming the next action. | §3 d.16, §4.2 |
| 4. Reopen of a previously started case | An **attempt** concept: `cath_lab_cases.procedure_attempt` + `attempt_started_at` (columns, migration NNN, justified); reopen of a started attempt opens attempt N+1 and clears the active start; `actual_start_at` stays the historical first start; every rule keys on the active attempt; consent and time-out are reset to pending on a new attempt; snapshot history preserved; report counts start events with an attempt id; the aged-out-before-next-attempt test. | §3 d.17, §4.9, §8 |
| 5. Start waits on the lab rail | The start reads the **last committed** readiness picture, never awaits a refresh, schedules one after commit through `scheduleReadinessRefresh`; snapshot records `readiness_picture_at` and `lab_component_status`; missing cached rows → `missing_lab_items: null` and `lab_component_status: 'unavailable'`, never `[]`; tested with a never-settling refresh. | §3 d.18, §4.5 |
| 6. `state === 'stale'` ≠ age-only | Internal `unavailability_cause` per item, computed from the previous stored row and the current evidence, persisted on the item row (migration NNN); post-start suppression only when every missing item is `aged_out`; display state untouched; tests for future-dated, unparseable, policy change, and aged-out with a repeat order open. | §3 d.19, §5.2, §5.6 |
| 7. Start replay after cancel → reopen | The start command carries a stable `command_id`; the server binds it to `(case_id, procedure_attempt)` in `metadata.start_commands[]`; a replay against another attempt is 409 `CATH_LAB_START_COMMAND_STALE`; a replay against the same attempt answers the started case; reopen idempotency key is minted once per user decision. | §3 d.20, §4.10 |
| 8. Consent vs emergency authority; time-out | Consent `pass` carries `authority ∈ {patient, legally_authorised_representative, emergency_basis}` and `mode ∈ {written, verbal, telephone}`; the hard block is "the applicable authority has been documented"; the allowed authorities come from the hospital's consent policy (`tenants.settings`, per tenant); UI and audit never say "consent obtained" for `emergency_basis`; Samira Kohli in one sentence. Start is defined; `timeout.performed_at` (team) is separate from `completed_at` (server); documented-late vs performed-late vs not-performed distinguished and reported. | §3 d.21–22, §4.3, §4.7 |
| Live updates | Staff subscribes to the existing `staff:lab` realtime channel (`RealtimeClient.events`), debounced reload; `RealtimeStatusBanner` shows paused / stale / denied; "picture as of" line; end-to-end widget test. | §6.3, §12 |
| `resulted_after_start` semantics | Renamed **`received_after_start`** (a receipt marker, `lab_results.received_at`) with the transaction-timestamp limitation stated; a separate **`finalised_after_start`** defined from `signed_off_at`. | §3 d.24, §5.4 |
| Monthly report: identifiable, scope, audit, predicate, count | Stated as identifiable operational data; facility scope defined against what the platform has (§7.4, one owner confirmation with a decided default); shared `logAudit` on both mounts, awaited before the response; predicate converts the bounds, not the column; EXPLAIN required in the plan; counts start **events** with `start_event_id` + `procedure_attempt`; tri-state `started_with_readiness_pending` so an absent legacy snapshot never reads as a clean start. | §3 d.23, §7 |
| Free-text disclosure | Every free-text field this design writes is enumerated with its readers; sentinel tests extended to each reader and to CSV. | §6.5 |
| Error-code coverage | A second overlay enum, `CASE_LIFECYCLE_ERROR_CODES`, and the source pin scans the case-lifecycle throw sites for it in both directions. | §9 |
| Dependency baseline | `main` `5857298dc`; #1018 and #1022 merged; `unwaiveLabItem` still throws `CATH_LAB_READINESS_CASE_STARTED` (decision 9 KEPT). | header, §15, §16 |

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

Facts, verified on `main` `5857298dc` (§16 is the citation ledger):

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
- **Idempotency scopes**: `cath_lab_readiness_order`, `_external`, `_waive`, `_unwaive` unchanged. The status route still claims no `Idempotency-Key`; replay protection for the start is the **command id** of §4.10, which is stronger for this case because it is bound to the attempt. One scope is added, `cath_lab_case_reopen`, on `POST /cases/:id/reopen` (§4.8).
- **#1018's record-yes / lift-no asymmetry**: `waiveLabItem` after start records with `recorded_after_start`; `unwaiveLabItem` after start refuses. What "after start" means for that refusal is now the **active attempt** (§4.9) — the decision is untouched, its discriminator is made precise.
- The eight `check_type` values; automation altering only rows it set (`auto_managed`); `AUTOMATION_METADATA_KEYS` stripping; RLS; the seven items; the resolver's state vocabulary (`unavailability_cause` is a **cause**, beside the state, never a new state); the roles on every existing route.
- **No new start route.** `POST /cases/:id/status` with `{ status: 'in_progress', reason, command_id }` is the start; `POST /cases/:id/procedure-logs` with a `finalized` log is the other. One function behind both (§4.2). `POST /cases/:id/reopen` is added and is deliberately **not** a start route.

## 3. Decisions

Decisions 1–13 are revision 1's, kept by number (both documents cite them); where revision 2 amends one, the amendment is stated inline. Decisions 14–25 are revision 2's.

1. **Consent is the one hard block, and it is enforced in one place.** `assertReadinessComplete` is **replaced** by `assertConsentDocumented` (the old name goes with the full gate; the pin asserts the old name is gone from shipping code): the `consent` check must be `pass` **with a documented authority** (§4.3); `waived` and `not_applicable` do not satisfy it and its `required` flag is not consulted. New code `CATH_LAB_CONSENT_REQUIRED`, 400. *Amended by decision 21*: the pass records **who gave the authority and on what basis** (`authority`) separately from **how it was communicated** (`mode`); `emergency_basis` is an authority, never a waiver, and is never described as "consent obtained".
2. **One start path, one snapshot, one assertion.** `startCaseTx` is the only code that moves a case to `in_progress`, the only code that sets `actual_start_at` / `attempt_started_at`, and the only caller of `assertConsentDocumented`. `transitionCaseStatus` and `recordProcedureLog` are its only two callers; the inline force-start in `recordProcedureLog` is deleted. A source pin asserts all counts and, *amended by decision 14*, pins the **whole write-site population** of `cath_lab_cases` — every `INSERT INTO` and every `UPDATE` literal, by `path:function`, as an exact list of known length — so a site that drifts out of the regex shrinks the list and fails, rather than silently leaving the population.
3. **`scheduled` and `readiness_pending` may start; `ready` still may.** `START_ELIGIBLE_STATUSES` is derived from the table. `requested` is not added. `cancelled → in_progress` stays impossible.
4. **Reason required only on the explicit start with a pending gate.** `via: 'status'` + gate not clear + empty reason → 400 `CATH_LAB_START_REASON_REQUIRED`. The procedure-record start takes an optional `start_reason`. No second signature, no role restriction, no urgency restriction.
5. **The snapshot is codes and booleans.** *Amended*: it also carries `procedure_attempt`, `command_id`, `readiness_picture_at`, `lab_component_status` and `consent_authority`; `missing_lab_items` is **nullable** (§4.5, §8.2). Never a lab value.
6. **The audit row is the record; the case row is the projection.** `cath_lab.case.started_with_readiness_pending` (only when something was pending); `metadata.readiness_at_start` for the read path; the canonical `cath_lab.case_in_progress` event carries both. *Amended*: every audit row and the snapshot carry `procedure_attempt`; prior attempts' snapshots are kept in `metadata.readiness_at_start_history[]`.
7. **After start, the checklist keeps living; staleness alone never moves the check; new evidence always does.** *Amended by decision 19*: "staleness alone" is decided by the item's **`unavailability_cause === 'aged_out'`**, never by `state === 'stale'`; and *by decision 17*: "after start" is the **active attempt's** start.
8. **Lateness is derived, not stored.** *Amended by decision 24*: the three markers beside #1018's `recorded_after_start` are `ordered_after_start`, `received_after_start` and `finalised_after_start`, all against the active attempt's start.
9. **The two remaining refusals go.** `orderMissingLabs` and `recordExternalLabResult` accept a started case; the order becomes `STAT`. **Settled on `main`**: `unwaiveLabItem` still throws `CATH_LAB_READINESS_CASE_STARTED`, so the code keeps **one** thrower and stays in the overlay's `ERROR_CODES`; only the two operations' 409 lists and the `case_started` description change (§5.3, §15).
10. **The only free text in the picture is projected.** *Amended by decision 25*: there are now four free-text fields, each enumerated with its readers and each covered by a sentinel (§6.5).
11. **Monthly report on both mounts, one handler, one role constant.** *Amended by decision 23* (scope, audit, predicate, event count).
12. **`timeout` pending at start** — *replaced by decision 22*. The old sentence ("expected in an emergency") is withdrawn.
13. **A procedure log on a `cancelled` case is refused, and the refusal names the door.** `reopenCaseTx`, `cancelled → readiness_pending`, mandatory reason, own audit action, own route. *Amended by decisions 15, 17 and 20.*
14. **Ordinary creation may only create a pre-start case.** `createCase` normalises `input.status` against `CREATABLE_STATUSES = ['requested','scheduled','readiness_pending']` (400 `CATH_LAB_CASE_STATUS_NOT_CREATABLE` otherwise, raised before any write); `ready` is excluded because it is a gate result, not a booking state; `in_progress`, `completed`, `cancelled` are excluded because a case that starts, ends or is cancelled must do so through the functions that record why. The creation route validates the same list. A **historical-import workflow** (bringing already-finished cases into the register) is a separate, explicitly governed path with its own authority and audit and is **out of this lane's scope**; until it exists there is no way to create a finished case, and that is intended. migration NNN's CHECK (`status <> 'in_progress' OR attempt_started_at IS NOT NULL`) makes the bypass impossible at the database as well (§8).
15. **Only `reopenCaseTx` takes a case out of `cancelled`, and it takes only a `cancelled` case.** `transitionCaseStatus` refuses **every** target on a `cancelled` case with 409 `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED` before consulting the table (the table entry `cancelled: ['readiness_pending']` stays so the vocabulary is honest and `START_ELIGIBLE_STATUSES` derives correctly). `reopenCaseTx` asserts `cathCase.status === 'cancelled'` explicitly and only then runs the table check; `scheduled → readiness_pending` being a legal table transition no longer makes `/reopen` act on a scheduled case.
16. **Procedure-log handling is exhaustive, and a draft never starts a case.** Case status × log status table in §4.2. Starting on a log requires the log to be **`finalized`** (`START_LOG_STATUSES = ['finalized']`): the service accepts `draft` / `finalized` / `amended`, and only a finalized log is the team's statement that the procedure occurred; a draft is preparation and must not start the clock, assert consent, or write a snapshot. A draft on a pre-start case is inserted and the case is left alone; the explicit Start (status route) remains available and is the emergency path. `requested` and any unexpected status are refused before insertion with 409 `CATH_LAB_CASE_START_NOT_ELIGIBLE` whose `details.next_action` names the transition to make first.
17. **A procedure attempt is a first-class lifecycle concept.** `cath_lab_cases.procedure_attempt INTEGER NOT NULL DEFAULT 1` and `attempt_started_at TIMESTAMPTZ(6)` (migration **NNN**, §8). `actual_start_at` is the **historical first start** and is never rewritten; `attempt_started_at` is the start of the **current attempt** and is what every rule, marker, refusal and snapshot keys on. A reopen of a case whose attempt had started (`attempt_started_at IS NOT NULL`) increments `procedure_attempt`, clears `attempt_started_at`, moves the current snapshot into history, and **resets `consent` and `timeout` to pending** (previous documentation kept in the check's `metadata.previous_attempts[]`); a reopen of a case cancelled before it ever started changes none of that (the attempt never happened). Rationale in §4.9. There is deliberately no "continuation of the same attempt" through reopen: a cancelled case is pre-start again by decision 13's own shape, so the only way back to the table is Start, and a mistaken cancellation of a running case is recorded as two attempts whose reasons say so.
18. **The start never waits on the lab rail.** `startCaseTx` reads the **last committed** readiness picture (the stored item rows and the labs check's `live_evidence_refreshed_at`), never calls or awaits `refreshCaseLabReadiness`, and the caller schedules a refresh **after commit** through the existing `scheduleReadinessRefresh` hook. The snapshot records `readiness_picture_at` and `lab_component_status ∈ {fresh, stale, unavailable}`; when no item rows exist the snapshot says `missing_lab_items: null` (unknown), never `[]`.
19. **Age-only staleness is a cause, not a state.** Each item carries an internal `unavailability_cause ∈ {aged_out, future_dated, unparseable, withdrawn, corrected, policy_changed, reordered} | null`, computed by the rules from the **previous stored row** and the **current evidence** and persisted on the item row (migration NNN). The post-start suppression applies **only** when every missing required item's cause is `aged_out` — previously acceptable evidence, the same result row, only time elapsed, no policy change. The display state is unchanged (`stale`, or `ordered_awaiting_sample` when a repeat draw is open).
20. **Start is replay-safe across attempts.** The start command carries a stable `command_id` (an opaque token, `^[A-Za-z0-9_.:-]{16,128}$`; Staff mints one per user decision with `IdempotencyKey.generate()`, before the first send, and reuses it across transport retries); `startCaseTx` binds it to `(case_id, procedure_attempt)` in `metadata.start_commands[]`. A replay against the same attempt answers the started case (200, nothing written); a replay against a different attempt is refused with 409 `CATH_LAB_START_COMMAND_STALE`. Required on the status path (400 `CATH_LAB_START_COMMAND_REQUIRED`), honoured when present on the procedure-log path. The reopen's `Idempotency-Key` is likewise one per user decision.
21. **Consent records the authority to proceed, not a checkbox.** A `consent` pass carries `metadata.consent = { authority, mode }` with `authority ∈ CONSENT_AUTHORITIES = ['patient', 'legally_authorised_representative', 'emergency_basis']` and `mode ∈ CONSENT_MODES = ['written', 'verbal', 'telephone']`; the check write refuses a pass without them (400 `CATH_LAB_CONSENT_AUTHORITY_REQUIRED`) and a pass whose authority the hospital's consent policy does not admit (400 `CATH_LAB_CONSENT_AUTHORITY_NOT_PERMITTED`). The policy is per-tenant configuration (`tenants.settings.cath_lab.consent_authorities`, default all three), not a second signature and not an urgency gate. The hard block (decision 1) is satisfied when **the applicable authority has been documented**. UI and audit say "Consent obtained (patient, written)" / "Consent obtained (legally authorised representative, telephone)" and, for `emergency_basis`, **"Emergency basis for proceeding documented"** — never "consent obtained". In one sentence, the distinction the Supreme Court drew in *Samira Kohli*: a competent adult's own informed consent is what authorises a procedure, and the narrowly defined emergency necessity that can justify proceeding without it is a different basis, not a relative's consent standing in for the patient's. Legacy passes recorded before this lane (no `metadata.consent`) satisfy the block — they were the hospital's record at the time — and Staff shows "authority not recorded" beside them until re-documented.
22. **Start is defined, and the time-out's two instants are separate.** **Start** is the moment the team records the beginning of the invasive procedure — vascular access (arterial or venous puncture) or, for a procedure without access, the first invasive act; room entry, positioning, preparation, draping and sedation are **not** Start, and the Start dialog says so in one line. The `timeout` check's pass carries `metadata.timeout.performed_at` (team-entered, the instant the WHO time-out — identity / procedure / site confirmation before incision — was performed) separately from the server-stamped `completed_at` (when it was documented; for `timeout` the client's `completed_at` is ignored). From those and `attempt_started_at` the system derives `timeout_timing ∈ {performed_before_start, performed_after_start, not_performed, unknown}` and `documented_after_start`, so a time-out performed at the table and typed in ten minutes later reads as **documented late**, not performed late. The time-out may still be undocumented when Start is recorded; it is recorded in `blocking` like any check, and the monthly report breaks starts down by `timeout_outcome` (§7.3).
23. **The monthly report is identifiable operational data with defined scope, audit and count.** It names cases (internal ids that link to patients) and actors, so it is not anonymous. It counts start **events** (one audit row = one row, `start_event_id`, `procedure_attempt`), reports `distinct_cases` beside `total_events`, takes an optional `facility_id` filter, is audited on **both** mounts through the shared `logAudit` writer before the response is sent, converts the **bounds** rather than the indexed column, and its plan is checked with EXPLAIN in the implementation plan. Scope: §7.4.
24. **The receipt marker is named for what it measures.** `received_after_start` = the deciding result row's `lab_results.received_at` is after the active attempt's start (receipt here, transaction-start ordering, stated once in §5.4). `finalised_after_start` = the deciding row's `signed_off_at` is after the active attempt's start (false unless the row is signed). Neither claims "became available after start"; nothing does.
25. **Every free-text field is enumerated, and every reader is tested.** Start reason, snapshot-history reasons, reopen reason, copied cancel reason: §6.5 lists each writer, each reader (readiness block, day list, `RETURNING *` responses, canonical timeline event, audit rows and their export, report JSON, report CSV) and the sentinel that covers it. The error-code pin is extended to the case-lifecycle codes (§9).

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
async function startCaseTx(tx, { tenantId, cathCase, reason = null, via, commandId = null, procedureLogId = null, context = {} })
// via: 'status' | 'procedure_log'
// returns { updated, snapshot, replayed }   // replayed: true when the command id had already started this attempt
```

`caseById` (the locked read both callers make) is widened to select `procedure_attempt`, `attempt_started_at`, `metadata->'start_commands' AS start_commands` and `metadata->'readiness_at_start' AS readiness_at_start` — the JSON paths, never the whole column (§8.4). A same-attempt replay (step 1) answers a fresh `SELECT *` of the row so the response has exactly the shape `RETURNING *` gave the first time.

Order of work, on the caller's tenant transaction, case row locked `FOR UPDATE`:

1. **Command binding (decision 20, §4.10).** `commandId = normalizeCommandId(commandId)` — an opaque client token: `cleanText(value, 128)` matching `/^[A-Za-z0-9_.:-]{16,128}$/`, else `null` (a UUID passes; so does the hex token `IdempotencyKey.generate()` mints in the Staff app, which is why the shape is not "UUID"). If `via === 'status'` and there is none → 400 `CATH_LAB_START_COMMAND_REQUIRED`, `details: { reason: 'missing' | 'malformed' }`. If one is given and `start_commands[]` already holds it: same `procedure_attempt` and status `in_progress` → return `{ updated: <current row>, snapshot: <current metadata.readiness_at_start>, replayed: true }` with nothing written; any other attempt → 409 `CATH_LAB_START_COMMAND_STALE`, `details: { command_attempt, current_attempt, case_status }`. Nothing written.
2. `cathCase.status ∈ START_ELIGIBLE_STATUSES`, else `AppError.invalidTransition(status, 'in_progress', CASE_TRANSITIONS[status] || [])`. (A `cancelled` case never reaches here from either caller — both refuse it first — but the guard stays: `START_ELIGIBLE_STATUSES` excludes it.)
3. `{ gate, checks, consent } = await assertConsentDocumented(tx, tenantId, caseId)` — the hard block (§4.3). Throws 400 `CATH_LAB_CONSENT_REQUIRED` before anything is written; returns the full gate evaluation for the snapshot and the consent check's `metadata.consent` for `consent_authority`.
4. `reason = cleanText(reason, 500)`. If `!gate.ready && via === 'status' && !reason` → 400 `CATH_LAB_START_REASON_REQUIRED`, `details: { blocking: gate.blocking }`.
5. `labs = labsPictureForStartTx(tx, tenantId, caseId, checks)` — the **stored** item rows and the labs check's `live_evidence_refreshed_at`, reduced to `{ missing: string[] | null, picture_at, lab_component_status }` (§4.5). No refresh is called.
6. `snapshot = buildStartSnapshot({ procedureAttempt: cathCase.procedure_attempt, via, commandId, procedureLogId, urgency, reason, blocking: gate.blocking, missingLabItems: labs.missing, readinessPictureAt: labs.picture_at, labComponentStatus: labs.lab_component_status, consentAuthority: consent?.authority ?? null, now })`.
7. The UPDATE — one statement:

```sql
UPDATE cath_lab_cases
   SET status = 'in_progress',
       actual_start_at = COALESCE(actual_start_at, NOW()),      -- historical first start, never rewritten
       attempt_started_at = NOW(),                               -- the ACTIVE attempt's start
       metadata = COALESCE(metadata, '{}'::jsonb)
                  || jsonb_build_object('readiness_at_start', $3::jsonb)
                  || jsonb_build_object('start_commands',
                       COALESCE(metadata->'start_commands', '[]'::jsonb) || $4::jsonb),
       updated_by = $5::uuid,
       updated_at = NOW()
 WHERE tenant_id = $1::uuid AND id = $2::bigint
 RETURNING *
```

`$4` is `[{ command_id, procedure_attempt, via, recorded_at }]` (or `[]` when the procedure-log path carried no command id). A merge, never a replacement: other keys (STEMI's `stemi_activation_id`, the history array) survive.

8. Canonical event `cath_lab.case_in_progress`, `payload: { status, reason, via, procedure_attempt, command_id, started_with_readiness_pending, readiness_at_start: snapshot }`; `updateCaseCanonicalRefs`.
9. **Only when `gate.blocking.length > 0`**: `recordReadinessAudit(tx, { action: 'cath_lab.case.started_with_readiness_pending', resource: 'cath_lab_cases', resourceId, context, metadata: { case_id, facility_id, ...snapshot } })`. The audit row's own `id` is the report's `start_event_id`.

**After the transaction commits**, the caller (not `startCaseTx`) calls `scheduleReadinessRefresh({ tenantId, patientUid, source: 'cath_case_start' })` — synchronous, never awaited, never throws (§4.5).

**`transitionCaseStatus`**, inside the transaction, in this order:

1. `caseById(..., { lock: true })`.
2. **Decision 15**: `if (cathCase.status === 'cancelled') throw AppError.conflict('This case was cancelled. Reopen it (POST /cath-lab/cases/:id/reopen) with a reason before changing its status.', 'CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED', { case_status: 'cancelled', requested_status: input.status, reopen_path: '/api/v1/cath-lab/cases/:id/reopen' })` — **before** `validateCaseTransition`, so `{ status: 'readiness_pending' }` on a cancelled case never reaches the table. The same code as the procedure-log refusal, so a client branches once.
3. `target = validateCaseTransition(cathCase.status, input.status)`.
4. `if (target === 'in_progress') { const { updated } = await startCaseTx(tx, { tenantId, cathCase, reason: input.reason, via: 'status', commandId: input.command_id, context }); return updated; }`
5. Otherwise the generic UPDATE as today **minus** its dead `actual_start_at = CASE … END` branch; SLA handling for `completed` / `cancelled` unchanged.

**`recordProcedureLog`** — decision 16, the exhaustive table. `logStatus = input.status ? normalizeStatus(input.status, ['draft','finalized','amended'], 'status') : 'finalized'` is computed **before** the case is read so the table below is decided on validated inputs:

| Case status | Log `draft` | Log `finalized` | Log `amended` |
|---|---|---|---|
| `scheduled` / `readiness_pending` / `ready` (start-eligible) | Insert the log; **case untouched** (no start, no consent assertion, no snapshot). A draft is preparation. | Insert the log, then **`startCaseTx(…, { via: 'procedure_log', procedureLogId, reason: input.start_reason, commandId: input.command_id })`** atomically — consent block, snapshot, event, audit, attempt start. | Insert; case untouched. (An amendment of a log on a case that has not started is unusual; it is recorded, and it does not start anything — starting requires a finalized statement.) |
| `in_progress` / `completed` | Insert; case untouched. | Insert; case untouched (an additional or corrected record of a procedure already under way or finished). | Insert; case untouched. |
| `cancelled` | **409 `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED`** before the insert; `details.reopen_path` names `/reopen`. | same | same |
| `requested` | **409 `CATH_LAB_CASE_START_NOT_ELIGIBLE`** before the insert; `details: { case_status: 'requested', next_action: { path: '/api/v1/cath-lab/cases/:id/status', body: { status: 'scheduled' } } }`. | same | same |
| anything else (defensive) | **409 `CATH_LAB_CASE_START_NOT_ELIGIBLE`** before the insert, `details.case_status` = the value found. | same | same |

There is no row in that table without an outcome. The inline `assertReadinessComplete` call and the inline force-start UPDATE are deleted. After a start through this path the caller schedules the refresh exactly as the status path does.

### 4.3 Consent — the one hard block

```js
export const CONSENT_AUTHORITIES = Object.freeze(['patient', 'legally_authorised_representative', 'emergency_basis']);
export const CONSENT_MODES = Object.freeze(['written', 'verbal', 'telephone']);

// THE ONE HARD BLOCK (owner decisions 1 and 5; §3 decisions 1 and 21). Every
// other readiness check informs and records. `pass` only — a waived or
// not-applicable consent is not an authority to proceed — and `required` is
// not consulted, because marking consent not-required must not be a way round
// it. What the pass documents (patient / legally authorised representative /
// emergency basis) is enforced where the pass is WRITTEN (updateReadinessCheck,
// against the tenant's consent policy); here the question is only whether the
// applicable authority has been documented. A legacy pass with no
// metadata.consent (recorded before this lane) satisfies the block — it was the
// hospital's record at the time — and is surfaced as "authority not recorded".
// Called from startCaseTx and nowhere else (cathLabStartPathPin.test.js).
async function assertConsentDocumented(db, tenantId, caseId) {
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
  const consent = consentCheck.metadata?.consent && typeof consentCheck.metadata.consent === 'object'
    ? { authority: consentCheck.metadata.consent.authority ?? null, mode: consentCheck.metadata.consent.mode ?? null }
    : null;
  return { gate, checks, consent };
}
```

`CONSENT_AUTHORITIES` and `CONSENT_MODES` live in the pure rules module (`cathLabReadinessRules.js`), re-exported by the facade and imported by `cathLabService.js` and the OpenAPI overlay.

**Where the authority is enforced: the check write.** `updateReadinessCheck` with `check_type === 'consent' && status === 'pass'` requires `input.metadata.consent.authority ∈ CONSENT_AUTHORITIES` and `.mode ∈ CONSENT_MODES` (400 `CATH_LAB_CONSENT_AUTHORITY_REQUIRED` otherwise, before any write) and requires the authority to be in the tenant's policy (400 `CATH_LAB_CONSENT_AUTHORITY_NOT_PERMITTED`, `details: { authority, permitted }`). The policy is read by `consentPolicyFor(tenantId, db)` from `tenants.settings->'cath_lab'->'consent_authorities'` (`tenants.settings` is an existing JSONB column, `schema.prisma`), default `CONSENT_AUTHORITIES` when absent; it is hospital configuration and is not an owner decision. The stored metadata is `{ consent: { authority, mode, documented_at } }` (`documented_at` = server NOW); `documented_at` is stamped by the server and a client value is ignored. This is **recording, not restricting**, in the sense of the principle: the hospital's own consent policy decides which authorities exist; the readiness checklist never decides whether the procedure may go ahead on any of them.

**Why the hard block is not "consent obtained".** A competent adult who cannot consent and has no legally authorised representative present can still be treated in an emergency; forcing staff to tick "consent obtained" to get past a block would put a false statement on the record. The block therefore reads "the applicable authority has been documented", the record says which, and the pattern (how often `emergency_basis` is the authority) is one column of the monthly report.

**Hazards, stated so the tests can be read against them:** (i) weaken only the transition and the procedure log still demands the old gate — prevented by construction (one function); (ii) weaken both but drop consent on one — prevented by construction and pinned; (iii) **manufacture a running case that never met the block** — closed by decision 14 (`CREATABLE_STATUSES`), by the INSERT pin, and by migration NNN's CHECK.

**The pin** (`cathLabStartPathPin.test.js`, textual, comments stripped, shipping modules under `apps/backend/src` excluding `tests/`):

- `assertConsentDocumented(` is **called** from exactly one function body: `startCaseTx`. `assertReadinessComplete` and `CATH_LAB_READINESS_BLOCKED` occur nowhere in shipping code.
- `startCaseTx(` is **called** from exactly two function bodies: `transitionCaseStatus` and `recordProcedureLog`.
- **SQL-shape pin, scoped to backtick literals that name `cath_lab_cases`**: every line matching `/actual_start_at\s*=/`, `/attempt_started_at\s*=/` or `/status\s*=\s*'in_progress'/`, and every `SET status = CASE … 'in_progress' … END` literal, sits in `cathLabService.js:startCaseTx`, **except** the one `attempt_started_at = NULL` line in `reopenCaseTx`; the pinned line set is exactly `startCaseTx: [status = 'in_progress', actual_start_at = COALESCE(actual_start_at, NOW()), attempt_started_at = NOW()]` and `reopenCaseTx: [attempt_started_at = NULL]`. (Scoping to the table's literals is what makes the pin true: `status = 'in_progress'` and `actual_start_at =` are ordinary text on `dialysis_sessions`, housekeeping requests and workflow tasks.)
- **`SET status =` allow-list, literal**: `cathLabReadinessService.js:recomputeCaseStatusTx`, `cathLabService.js:{startCaseTx, reopenCaseTx, transitionCaseStatus, updateReadinessCheck}` — five pairs.
- **INSERT pin (decision 14, owner point 1)**: every backtick literal containing `INSERT INTO cath_lab_cases` sits in an allow-list of exactly two `path:function` pairs — `cathLabService.js:createCase` and `stemiPathwayService.js:spawnCathCase` — and no literal naming `cath_lab_cases` contains `ON CONFLICT` (there is no upsert on the case table today, and one would have to be argued for). Inside `createCase`'s source the text `normalizeStatus(input.status, CREATABLE_STATUSES` is present and `normalizeStatus(input.status, CASE_STATUSES` is absent; inside `spawnCathCase`'s literal the bound status literal is `'readiness_pending'`, and the test asserts `CREATABLE_STATUSES.includes('readiness_pending')` on the imported value.
- **Population pin (owner point 1; dev-1b's post-landing check)**: the pin classifies **every** backtick literal that names `cath_lab_cases` and asserts, as **exact lists** (`toEqual`, never "each hit is allow-listed"): the `UPDATE\s+cath_lab_cases` sites are exactly **nine** — `cathLabReadinessService.js:recomputeCaseStatusTx`; `cathLabService.js:{updateCaseCanonicalRefs, updateReadinessCheck, transitionCaseStatus, startCaseTx, reopenCaseTx, resolveCathConsumableAuthorityRecovery}`; `cathSchedulingRegistryService.js:scheduleCase`; `stemiPathwayService.js:spawnCathCase` (the base tree has eight: `recordProcedureLog`'s force-start goes, `startCaseTx` and `reopenCaseTx` arrive); the `INSERT\s+INTO\s+cath_lab_cases` sites are exactly **two** (above); no literal naming the table contains `ON CONFLICT`; and any literal naming the table that contains `\bSET\b` or `\bINSERT\b` yet sits on neither list fails as an *unclassified write*. The count is the point: a write site reformatted so a regex misses it makes a list shorter than its expected length, which a subset check would never see (§12 mutation 31). A write whose table name never appears in a literal is outside every textual pin; `lint:raw-params` is the other half of that guard.
- **Door pins**: `CASE_TRANSITIONS.cancelled` deep-equals `['readiness_pending']`; `START_ELIGIBLE_STATUSES` excludes `cancelled`; the literal `status = 'readiness_pending'` on a `cath_lab_cases` statement occurs only in `reopenCaseTx`; and `transitionCaseStatus`'s source contains the text `=== 'cancelled'` **before** the text `validateCaseTransition(` (decision 15, the short-circuit order).

**A deep test per path** (`cath-lab-readiness.deep.test.js`, own case per test): consent `pending` → both paths refused `CATH_LAB_CONSENT_REQUIRED`, nothing written (no log row either — the transaction rolled back); consent `waived` and `not_applicable` → refused; consent pass with `authority: 'emergency_basis'` → starts, snapshot `consent_authority: 'emergency_basis'`, and the audit metadata carries it; a pass write without an authority → 400 `CATH_LAB_CONSENT_AUTHORITY_REQUIRED`; a pass write with an authority outside the tenant policy (policy set to `['patient']` for the test tenant) → 400 `CATH_LAB_CONSENT_AUTHORITY_NOT_PERMITTED`; a legacy pass (row seeded with `metadata: {}`) → starts with `consent_authority: null`.

**Staff.** The start row (§4.4) is **disabled** while the consent check is not `pass` (key `cath-readiness-start-consent-blocked`, text "The authority to proceed must be recorded before the procedure can start"). The consent check's confirm dialog (`_CathReadinessConfirmDialog`, status `pass`) gains two choosers: **authority** (patient / legally authorised representative / emergency basis for proceeding — labels from the tenant policy's permitted list, in that order) and **mode** (written / verbal / telephone); the write sends `metadata: { consent: { authority, mode } }`. The check row's caption reads "Consent obtained — patient, written" or "Emergency basis for proceeding documented — verbal" (key `cath-readiness-consent-caption`); the string for `emergency_basis` never contains the word "consent". A legacy pass shows "Authority not recorded" with a one-tap "Record" that opens the same dialog.

### 4.4 The Staff "Start" action

Unchanged from revision 1 except: the dialog body carries the Start definition line ("Start records the beginning of the invasive procedure — vascular access or the first invasive act. Room entry and preparation are not Start.", key `start_definition`); `CathLabApiService.startCase(caseId, { reason, commandId })` posts `{ status: 'in_progress', reason, command_id }` with a `commandId` minted **once per confirmation, before the first send** — `IdempotencyKey.generate()` from `packages/vhhealth_core/lib/services/idempotency_key.dart`, the generator already behind `IdempotencyAttempt`, no new dependency — and reused on every transport retry (§4.10); a 200 with `replayed` semantics is indistinguishable to the user from the first success (the reload shows the case started); a 409 `CATH_LAB_START_COMMAND_STALE` reloads the case and shows "This case was reopened since you pressed Start; review the checklist and start again" (key `start_command_stale`).

### 4.5 The start never waits on the lab rail (decision 18)

Revision 1 called `refreshCaseLabReadiness(...).catch(log)` before the transaction. That still **waits**: a slow query, a lock or a hung dependency in the refresh delays the start, and a bounded timeout would abandon a database operation that keeps holding its resources. Revision 2 removes the call.

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

**After commit** both callers schedule `scheduleReadinessRefresh({ tenantId, patientUid: updated.patient_uid, source: 'cath_case_start' })` (`cathLabReadinessHooks.js`): synchronous, `setImmediate`-first, per-patient collapsed, serial, swallowing its own failures — the hook the lab writers already use, so the start inherits every guarantee it has. Because `refreshOpenCasesForPatient` includes started cases after §5.1, that refresh reaches the case that has just started and repairs the picture within one tick.

**The test the owner asked for**: mock `refreshCaseLabReadiness` to return `new Promise(() => {})` (a deferred that is never settled) **and** stub `scheduleReadinessRefresh`; the start must resolve (asserted with `Promise.race` against a 2 s timer, fake timers off), `scheduleReadinessRefresh` must have been called exactly once with `source: 'cath_case_start'` after the transaction callback returned, and `refreshCaseLabReadiness` must **not** have been called by the start at all. A second test seeds a case with **no** item rows and asserts `missing_lab_items: null`, `lab_component_status: 'unavailable'`, and that the Staff banner text for it is the "unknown" form, not "no lab items missing".

### 4.6 Audit and review

`audit_logs.action = 'cath_lab.case.started_with_readiness_pending'`, `resource = 'cath_lab_cases'`, `resource_id = <case id>`, actor from `context`, `metadata = { case_id, facility_id, recorded_at, procedure_attempt, via, command_id, procedure_log_id, urgency, reason, blocking, missing_lab_items, readiness_picture_at, lab_component_status, consent_authority }`. The row's `id` is the **start event id** the report exposes. The canonical `cath_lab.case_in_progress` event carries the same snapshot for the timeline.

### 4.7 `timeout` semantics (decision 22)

The old sentence ("expected to be pending in an emergency") is withdrawn. What stands: the time-out may still be **undocumented** when Start is recorded, and the system must be able to tell three things apart afterwards.

- **Start** is defined in decision 22 and restated in the Start dialog.
- `updateReadinessCheck` with `check_type === 'timeout' && status === 'pass'` requires `input.metadata.timeout.performed_at` (ISO instant, team-entered, not in the future; 400 `CATH_LAB_TIMEOUT_PERFORMED_AT_REQUIRED` otherwise) and stamps `completed_at = NOW()` itself (**the client's `completed_at` is ignored for `timeout`**, the one check type where the two instants must not be conflated). Stored: `metadata.timeout = { performed_at, documented_at }` with `documented_at = completed_at`.
- Derived (rules module, `timeoutTiming({ performedAt, documentedAt, attemptStartedAt })`, pure, surfaced on the check row in `GET /cases/:id` and in the report): `timing ∈ {performed_before_start, performed_after_start, not_performed, unknown}` — `not_performed` while the check is not `pass` and the attempt has started; `unknown` when passed without `performed_at` (legacy); and `documented_after_start = documented_at > attempt_started_at`.
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
3. Capture `cancelledAt = cathCase.actual_end_at` and `previousAttemptStartedAt = cathCase.attempt_started_at` before the UPDATE; `cancelReason = latestCancelReasonTx(...)` (the most recent canonical `cath_lab.case_cancelled` event's `payload->>'reason'`, `null` when none).
4. `newAttempt = previousAttemptStartedAt ? cathCase.procedure_attempt + 1 : cathCase.procedure_attempt` (decision 17: an attempt that never started is not a new attempt).
5. The case UPDATE — one statement:

```sql
UPDATE cath_lab_cases
   SET status = 'readiness_pending',
       actual_end_at = NULL,                         -- pre-start again; also keeps cath_lab_cases_actual_time_check satisfied on the next start
       attempt_started_at = NULL,                    -- the ACTIVE attempt has not started
       procedure_attempt = $4::int,                  -- N+1 when the previous attempt had started, else unchanged
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

6. **Check reset on a new attempt only** (`newAttempt > cathCase.procedure_attempt`): for `check_type IN ('consent','timeout')`, `UPDATE cath_lab_readiness_checks SET status = 'pending', completed_at = NULL, completed_by = NULL, metadata = (metadata - 'consent' - 'timeout') || jsonb_build_object('previous_attempts', COALESCE(metadata->'previous_attempts','[]'::jsonb) || jsonb_build_array(jsonb_build_object('procedure_attempt', $N, 'status', status, 'completed_at', completed_at, 'completed_by', completed_by, 'consent', metadata->'consent', 'timeout', metadata->'timeout'))) WHERE …` — the previous documentation is preserved on the row and shown as "recorded for attempt 1 at 04:12" so re-confirmation is one tap, not re-consenting from scratch. Migration 482's `cath_lab_readiness_completion_check` (`status = 'pending' AND completed_at IS NULL`) is satisfied. `checksReset = ['consent','timeout']`; otherwise `[]`. The other six checks carry over unchanged: they are facts about the patient, the equipment and the blood bank, not events of a procedure; `labs` is recomputed by automation anyway.
7. Canonical event `cath_lab.case_reopened`, `payload: { status: 'readiness_pending', reason, previous_status: 'cancelled', previous_attempt, procedure_attempt: newAttempt, checks_reset }`; `updateCaseCanonicalRefs`.
8. `recordReadinessAudit(tx, { action: 'cath_lab.case.reopened', … metadata: { case_id, facility_id, reason, previous_status: 'cancelled', cancelled_at, cancel_reason, urgency, previous_attempt, procedure_attempt, previous_attempt_started_at, checks_reset } })` — **always**.

**Why consent and time-out reset, stated so it can be argued with.** A new attempt is a new procedure event: the WHO time-out is performed at the table immediately before the invasive act, so a time-out performed for attempt 1 says nothing about attempt 2; and the authority to proceed is documented for a procedure event, not for a case row — the patient may since have regained capacity, a representative may have arrived, the emergency basis may have lapsed. Re-confirmation costs one tap per check with the previous documentation in view; not resetting would let attempt 2 start on attempt 1's time-out, which is the exact failure the time-out exists to prevent. The owner may choose otherwise; the change is one constant (`ATTEMPT_RESET_CHECKS`) and one line of the deep test.

**Roles, route, Staff, SLA, re-cancel** — as revision 1: the cancel path's guard chain (`requireCathWorkflow`, `guardCathCaseById`), `requireIdempotencyKey({ required: true, scope: 'cath_lab_case_reopen' })`, cath mount only; Staff "Reopen case" with a mandatory reason and an `Idempotency-Key` minted **once per confirmation** through `IdempotencyAttempt('cath-lab-reopen-$caseId').keyFor(body)` (`packages/vhhealth_core/lib/services/idempotency_key.dart`; the readiness panel already mints its order / outside-result / waive keys this way, and calls `reset()` only after the write concluded), reused across retries; the workflow SLA instance stays cancelled; the door is not one-shot. The Staff dialog body now also says: "If the procedure had already started, this opens a new attempt: consent and the time-out will be re-confirmed."

### 4.9 The attempt lifecycle (decision 17)

Two questions revision 1 conflated, now separate:

| Question | Field | Set by | Cleared by |
|---|---|---|---|
| Has this case **ever** started? | `actual_start_at` | first `startCaseTx` (`COALESCE(actual_start_at, NOW())`) | never |
| Is this case in an **active** procedural attempt, and since when? | `attempt_started_at` | every `startCaseTx` (`NOW()`) | `reopenCaseTx` (`NULL`) |
| Which attempt is this? | `procedure_attempt` | default 1; `reopenCaseTx` increments when the previous attempt had started | never decremented |

What each field controls — **every rule keys on the active attempt**:

| Behaviour | Keyed on | Effect after start → cancel → reopen (attempt 2, not yet started) |
|---|---|---|
| Board / `case_started` / Staff `started` | `attempt_started_at IS NOT NULL` | pre-start: start row shown, banners hidden |
| Automation regime (`computeCheckDecision`'s `started`) | `caseRow.attempt_started_at` | pre-start regime: staleness retracts again — Plan 3's rule, which is exactly right for a patient about to go back on the table |
| Un-waive refusal (#1018 `isAfterCaseStart`) | `attempt_started_at` | a waiver may be lifted again (the case is pre-start); lifting one recorded in attempt 1 is a lift before attempt 2's start |
| Late actions (`orderMissingLabs` STAT, outside result marker) | `attempt_started_at` | ordinary pre-start orders |
| Lateness markers (`*_after_start`) | `attempt_started_at` (epoch twin) | all false (nothing is "after" a start that has not happened); the audit rows from attempt 1 keep their own booleans as history |
| Consent / time-out | reset to pending on attempt N+1 (§4.8 step 6) | must be re-documented before attempt 2 starts; consent is the hard block again |
| Snapshot `readiness_at_start` | keyed by `procedure_attempt`; prior ones in `readiness_at_start_history[]` | `null` until attempt 2 starts |
| `readiness_gate` / `recomputeCaseStatusTx` | unchanged (status-based) | may move the case to `ready` when clear |
| Report | one row per start **event** with `procedure_attempt` | attempt 2's start is its own row |
| `cath_lab_cases_actual_time_check` (482) | `actual_start_at` / `actual_end_at` | reopen clears `actual_end_at`; completion stamps it ≥ the first start |

**Reads.** `caseRowTx` (readiness service) selects `attempt_started_at` and `(EXTRACT(EPOCH FROM attempt_started_at) * 1000)::bigint AS attempt_started_at_epoch_ms` and passes `caseStartedAt: cathCase.attempt_started_at_epoch_ms ?? cathCase.attempt_started_at`; `case_started` on the block is `Boolean(cathCase.attempt_started_at)`; the block gains `procedure_attempt`, `attempt_started_at`, `first_started_at` (= `actual_start_at`). `caseById` selects the two new columns. `listCases` selects them into the row (`CathLabCase` gains two properties in the overlay).

**The test the owner asked for** (deep): attempt 1 starts with all seven items fresh and the check auto-passed; cancelled; the HGB result is aged 45 days (`ageHgb(45)` — the deep suite's regime test has a local `age(days)` that rewrites `lab_results.performed_at`; the plan lifts it to suite level, case-parameterised); reopened → the case is `readiness_pending`, `procedure_attempt = 2`, `attempt_started_at IS NULL`, `actual_start_at` = the attempt-1 instant; a refresh **retracts** the labs check to pending (`hb aged_out`, pre-start regime) and the item reads `stale`; consent is `pending` again; a start without consent → `CATH_LAB_CONSENT_REQUIRED`; after re-documenting consent, a start with a reason → attempt 2 starts, `attempt_started_at` new, `actual_start_at` unchanged, snapshot `procedure_attempt: 2` with `blocking` naming `labs` and `missing_lab_items: ['hb']`, `readiness_at_start_history` holding attempt 1's snapshot, and a **second** start audit row with `procedure_attempt: 2`.

### 4.10 Start replay across attempts (decision 20)

The sequence the owner named: start succeeds but the response is lost → the case is cancelled and reopened → the client's automatic retry of the original start arrives, finds a startable case, and starts attempt 2 with attempt 1's reason.

- Staff mints `commandId` (`IdempotencyKey.generate()`, an opaque hex token; the server accepts `^[A-Za-z0-9_.:-]{16,128}$`) **when the user confirms the Start dialog**, before the first send; `ApiClient` retries reuse the same body, so the retry carries the same `command_id`.
- `startCaseTx` step 1 (§4.2): a `command_id` already in `metadata.start_commands[]` for the **same** `procedure_attempt` while the case is `in_progress` → the case is answered as it stands (200, `replayed: true` internally, no write, no second audit row); for a **different** attempt → 409 `CATH_LAB_START_COMMAND_STALE`. An unknown `command_id` proceeds and is recorded with the attempt it started.
- `start_commands[]` is stripped from `createCase`'s metadata (`CASE_START_METADATA_KEYS`, §8.3) and survives reopen.
- The procedure-log path honours a `command_id` when the client sends one (same two outcomes); it is not required there because that path has no Staff client and its own replay (a second log row) is pre-existing behaviour outside this lane.
- **Reopen**: `Idempotency-Key` per user decision (§4.8). A replay of a reopen under its own key answers the original response (middleware); a **new** decision to reopen an already reopened-and-restarted case gets a new key and is refused by the explicit precondition (the case is not `cancelled`).

**Tests**: unit — the three command outcomes with the mock row's `start_commands` and `procedure_attempt`; deep — start (command A) → cancel → reopen → replay command A → 409 `CATH_LAB_START_COMMAND_STALE`, case still `readiness_pending`, no second audit row; then a fresh command B starts attempt 2; replay B → 200, still one attempt-2 audit row; a status start without `command_id` → 400 `CATH_LAB_START_COMMAND_REQUIRED`.

### 4.11 Creation may only create a pre-start case (decision 14)

`createCase`: `const status = input.status ? normalizeStatus(input.status, CREATABLE_STATUSES, 'status') : 'scheduled';` — `normalizeStatus` already throws 400 `CATH_LAB_BAD_STATUS` with the allowed list in its message; this lane gives the refusal its own code so a client can tell "not a status" from "not creatable": a value in `CASE_STATUSES` but not in `CREATABLE_STATUSES` → 400 `CATH_LAB_CASE_STATUS_NOT_CREATABLE`, `details: { status, creatable: CREATABLE_STATUSES }`, raised before `assertPatient` and before the transaction. The creation route validates `req.body.status` against the same exported list before calling the service (defence in depth; the service check is the one the pin reads). `input.metadata` is stripped of `CASE_START_METADATA_KEYS = ['readiness_at_start', 'readiness_at_start_history', 'start_commands']`. `procedure_attempt` and `attempt_started_at` are not accepted from the body at all (the INSERT does not name them; defaults apply).

**Route-level test** (supertest against the cath router, in the suite that already drives `POST /cases` for facility authority): `POST /cases { patient_uid, facility_id, requested_procedure, status: 'in_progress' }` as a workflow role → 400 `CATH_LAB_CASE_STATUS_NOT_CREATABLE`, no `cath_lab_cases` row (count unchanged), no readiness check rows; the same for `completed`, `cancelled` and `ready`; `readiness_pending` → 201 with `attempt_started_at: null`, `procedure_attempt: 1`; and a follow-up `POST /cases/:id/procedure-logs` on the refused id answers 404 (the case does not exist), proving the running-case-with-pending-consent cannot be manufactured this way. migration NNN's CHECK is separately proved by a deep test that issues the raw `INSERT … status = 'in_progress'` with `attempt_started_at` NULL and asserts Postgres 23514.

## 5. The checklist keeps living after start

### 5.1 Lab events reach started cases

`refreshOpenCasesForPatient`: `WHERE status NOT IN ('completed', 'cancelled')` — the `actual_start_at IS NULL` predicate and the three-status list go. A result filed or signed off mid-procedure reaches the item rows through the same post-commit scheduler as before start.

### 5.2 Check-level rule after start — cause, not state (decision 19)

**Before start (of the active attempt), nothing changes.** Plan 3's rule stands: automation passes when every required item is available and retracts a pass it made when one goes missing — by age included. This regime has its own test and that test is in the mutation list.

**After start:**

- **NEW EVIDENCE always applies, better or worse.** A value arriving mid-procedure makes its item available and the auto-pass branch may pass the check, marked `passed_after_start: true` on the `auto_pass` audit row; a critical value sets `critical_warning` / `critical_items` / `live_evidence`, Staff shows the red banner, the check reflects it; the case status and the gate are untouched.
- **AGEING alone never flips the check.** When every missing required item's `unavailability_cause` is `aged_out`, the retraction branch does nothing. The item still reads `stale` (or `ordered_awaiting_sample` when a repeat draw is already open) — the picture is truthful; only the check's status is held.
- **Any other cause still retracts**: `policy_changed` (a validity window or the required set edited mid-procedure), `future_dated` / `unparseable` (the evidence's timestamp was corrected into something unusable), `withdrawn` (the deciding result was cancelled or retracted), `corrected` (a different result now decides and it is not acceptable). Each is new information.

```js
// computeCheckDecision, rules module. `missing` entries are { item, state, cause }.
const started = Boolean(caseRow?.attempt_started_at);
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

- `orderMissingLabs`: the `case_started` refusal is deleted; `orderPriorityForUrgency(urgency, { started: true })` → `'STAT'`; the audit row gains `ordered_after_start: true`; `started` is `Boolean(cathCase.attempt_started_at)`.
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

Computed in `refreshCaseLabReadiness` for every item by a pure rules function, from the **previous stored row** (`storedByCode`, already read once per refresh) and the **current resolution**, and persisted on the item row (`cath_case_lab_readiness_items.unavailability_cause`, with `window_days`, migration NNN), so the answer is stable across refreshes and does not depend on which refresh happened to run first.

```js
export const UNAVAILABILITY_CAUSES = Object.freeze([
  'aged_out', 'future_dated', 'unparseable', 'withdrawn', 'corrected', 'policy_changed', 'reordered',
]);
// null when the item is available. Otherwise the reason it is NOT, decided
// against the previous stored row for this item and the rows the resolver saw.
export function classifyUnavailability({ previous, resolved, results, settings, windowDays, asOf })
```

Rules, in precedence order (the first that applies wins):

1. `resolved` available (`isItemAvailable`) → `null`.
2. **`policy_changed`** — `previous` existed and (`previous.window_days !== windowDays` or `previous.required !== resolved.required` or the external-results setting flipped so a previously counted `external_recorded` no longer counts). A policy edit is never "only time elapsed".
3. `previous` was **acceptable** (available under the settings it was written with) and its deciding evidence was a lab row (`previous.lab_result_id`):
   - that row is **absent** from `results` (cancelled, retracted, deleted, or outside the lookback) → **`withdrawn`**;
   - that row is present and is still the latest candidate: its observed instant is `NaN` → **`unparseable`**; is `> asOf` → **`future_dated`**; is in the past and older than the window → **`aged_out`** (the same row, only time elapsed — the open-order check that turns the display state into `ordered_awaiting_sample` does not enter here, which is the owner's repeat-order case); otherwise (present, in window, yet not acceptable — e.g. its status changed) → **`corrected`**;
   - a **different** row now decides and is not acceptable → **`corrected`**.
4. `previous` was acceptable because of a **waiver** (`previous.source === 'waiver'`) and the waiver is gone → **`withdrawn`** (only reachable pre-start; lifting is refused after start).
5. `previous` was already unavailable with a persisted cause and its deciding evidence identity is unchanged → **carry the previous cause** (this is what keeps `aged_out` stable across the refreshes that follow a suppressed retraction, when the stored row already says `stale`).
6. No acceptable evidence before either (never available, or `previous` null) and an open order now covers the item → **`reordered`** (unavailable because a draw is in flight; never counts as ageing).
7. Otherwise → `null` with the state as resolved (never had evidence; `not_ordered`).

`missing[]` entries carry `cause`; `live_evidence[]` carries it; the item on the wire carries it as `unavailability_cause` (string or null; a code, never a value) — it is useful to the operator ("HGB aged out" vs "HGB result withdrawn") and costs nothing under the disclosure rule.

**Tests** (unit, `classifyUnavailability` and `computeCheckDecision` together; deep for the two that need the rail):

- aged-out, same row → `aged_out`; post-start → no retraction; pre-start → retraction.
- **aged-out with a repeat order already open at start** → state `ordered_awaiting_sample`, cause `aged_out`, post-start → no retraction (the owner's opposite failure).
- the same row's `performed_at` corrected into the future → `future_dated` → retraction even post-start.
- the same row's timestamp corrected into garbage (epoch twin `null`, `performed_at` unparseable string) → `unparseable` → retraction.
- validity window edited 30 → 7 days mid-procedure with an 8-day-old fresh-until-now value → `policy_changed` → retraction; the required set gaining an item nobody ordered → the new item `policy_changed` → retraction.
- the deciding row cancelled → `withdrawn` → retraction.
- two refreshes in a row post-start with an aged-out item → both `aged_out`, check held both times (stability).

## 6. The readiness picture shows lateness

### 6.1 `CathLabReadiness` (the `lab_readiness` block and `GET …/readiness/labs`)

New top-level keys: `case_started` (now: active attempt started), `procedure_attempt`, `attempt_started_at`, `first_started_at`, `started_with_readiness_pending` (**tri-state**: `true` / `false` / `null` = no snapshot — a case started before this lane, or attempt N+1 not yet started), `readiness_at_start`:

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
- **Live updates (owner's "further corrections", first bullet).** The checklist subscribes to **`staff:lab`** through `RealtimeClient.instance.events('staff:lab')` (injectable as `CathReadinessDependencies.labEvents`, the same `Stream<RealtimeEvent> Function(String channel)` shape `cath_lab_screen.dart` already injects for `staff:code-stemi`), and on every event debounces 400 ms and calls `_reload()` — which is a read-through refresh server-side, so the picture the operator sees is the picture the server just recomputed. The backend emits on that channel today: `emitLabEvent('result-signed', { tenantId })` on pathologist sign-off and `'result-pending'` on manual / outside-result entry (`labResultsService.js`), tenant-scoped (`broadcast(channel, payload, { tenantId })`), staff-only (`channelAuth.js`). No new channel, no new emitter. The subscription is held only while the checklist is mounted and the case is started (pre-start, the existing pull-to-refresh and the screen's fallback poll suffice, and the read-through cost of a reload per lab event across a whole ward is not worth paying for a case not on the table).
- **Staleness and disconnection.** The cath screen's `RealtimeStatusBanner` `watchChannels` gains `'staff:lab'` — amber "live updates paused / data may be stale" while the socket is reconnecting or disconnected, red when the channel is denied, `fallbackPoll: _refreshWorkbench` as today. The checklist itself shows **"Picture as of 05:01"** (key `cath-readiness-picture-as-of`, from the block's `live_evidence_refreshed_at` — already on the summary) and appends " · live updates paused" (key `cath-readiness-picture-paused`) whenever `RealtimeClient.instance.connectionState != connected` (subscribed through `onConnectionStateChange`, injectable).
- **End-to-end widget test** (`cath_readiness_checklist_test.dart`): pump the checklist for a started case with an injected loader whose first answer has `critical_warning: false`; assert no red banner; push `RealtimeEvent(channel: 'staff:lab', data: {'kind': 'result-signed'}, at: …)` on the injected stream; the loader's second answer carries `critical_warning: true`, `critical_items: ['potassium']`, `received_after_start: true`; pump 400 ms; assert the red banner and the item chip appear **without** the checklist being rebuilt or reopened, and that `_reload` ran exactly once for two events pushed 100 ms apart (debounce). A second test drives the injected connection-state stream to `reconnecting` and asserts the "live updates paused" suffix; a third pumps the screen with `staff:lab` denied and asserts the banner's red form.
- Strings in all five locales with the `// REVIEW: AI first-pass` marker on the four non-English ones (OPEN-21).

### 6.4 Role projection and the canary

None of the new keys is serology: check types, item **codes**, causes, booleans and timestamps are the checklist. `projectLabReadinessForRole` blanks `readiness_at_start.reason` (key kept, `null`) for roles outside `roleSeesSerologyDetail`; `readiness_at_start_history[]` is **not** on the block at all (it is history for the audit and the timeline, and it is not selected by `caseRowTx`). Canary additions as revision 1 (poisoned snapshot with a second sentinel, `disclosures()` extension, positive control, liveness, summary key set, reachable set +2 report GETs), plus §6.5.

### 6.5 Free-text inventory and its readers (decision 25)

| # | Field | Written by | Stored | Readers | Cover |
|---|---|---|---|---|---|
| 1 | **start reason** | `startCaseTx` | `metadata.readiness_at_start.reason`; audit row metadata; canonical `cath_lab.case_in_progress` payload | readiness block (`caseRowTx` JSON path → `projectLabReadinessForRole`, **projected**); `transitionCaseStatus` / `recordProcedureLog` responses (`RETURNING *`, workflow roles only, all inside the entitled allow-list); day list (**not selected**); report JSON and CSV (**projected**); admin audit export (`exportAuditEvents`, ADMIN — privileged); clinical timeline — `readCanonicalPatientTimeline` (`canonicalClinicalPlatformService.js`) maps `payload: row.payload \|\| {}` **unprojected**, reached from `emr/clinicalTimelineRoutes.js`, `clinical/encounterRoutes.js` and `patient/patientSearchRoutes.js`; the cath events are **not patient-visible** (`recordCanonicalClinicalEvent` writes `visible_to_patient` only when the input says `true`, and `writeCanonicalEvent` never does), so the patient app is out; **Task 0 verifies the staff roles on those three routes; if any is outside `roleSeesSerologyDetail`, the reader projects `payload.reason` and `payload.readiness_at_start.reason` by the same predicate** | canary second sentinel on the block, on both report mounts, JSON **and CSV** (`disclosures()` learns to treat a `text/csv` 2xx body as text); a unit test on `writeCanonicalEvent` that the two cath events are written with `visible_to_patient = false`; a sentinel test on the timeline reader if it turns out to need projection |
| 2 | **prior attempts' start reasons** | `reopenCaseTx` (moves #1 into `metadata.readiness_at_start_history[]`) | case metadata | `RETURNING *` on `/reopen`, `/status`, `/procedure-logs` (workflow roles, entitled); never on the block, the list or the report | the canary's write mirror on the reopen response as a workflow role (positive control); a unit test that `caseRowTx` and `listCases` do not select the history |
| 3 | **reopen reason** | `reopenCaseTx` | `cath_lab.case.reopened` audit metadata; canonical `cath_lab.case_reopened` payload | admin audit export (privileged); patient timeline (same Task 0 verification as #1; same projection if needed); the reopen response does not echo it (the case row carries no reopen reason) | third sentinel (`REOPEN-REASON-SENTINEL-…`) on the timeline reader test and on the write mirror |
| 4 | **copied cancel reason** | `reopenCaseTx` (`cancel_reason`, from the cancel event) | `cath_lab.case.reopened` audit metadata only | admin audit export (privileged) | covered by #3's audit-row test (same row) |
| — | consent / time-out | `updateReadinessCheck` | `metadata.consent` / `metadata.timeout` | — | **no free text added**: authority and mode are enums, instants are instants; the check's existing `notes` field is unchanged and out of scope |

"Only one free-text field" is withdrawn; the statement that stands is: **four free-text fields, each projected or privileged, each with a named sentinel test on each reader that can reach it.** `rowsToCsv` (`src/utils/csv.js`) already neutralises formula-leading text; the CSV sentinel test asserts both that a non-entitled role's CSV has an empty `reason` column and that an entitled role's CSV neutralises `=HBsAg…`.

## 7. Monthly report — starts with checks pending (decision 23)

### 7.1 Endpoint

`GET /api/v1/cath-lab/reports/starts-with-pending?month=YYYY-MM[&facility_id=N][&format=csv]`, and the same handler at `GET /api/v1/cath-reprocessing/reports/starts-with-pending`. `month` required, `^\d{4}-(0[1-9]|1[0-2])$`, else 400 `CATH_LAB_REPORT_MONTH_INVALID`; `facility_id` optional positive int, else 400 `CATH_LAB_REPORT_FACILITY_INVALID`. The month is the ward's IST calendar month. Registered **before** `router.get('/reports/:id', …)` on the cath router.

### 7.2 Query

```sql
SELECT a.id AS start_event_id, a.created_at AS started_at, a.actor_uid, a.role AS actor_role, u.name AS actor_name,
       a.resource_id AS case_id, a.metadata,
       f.id AS facility_id, f.display_name AS facility_name,
       t.status AS timeout_status, t.completed_at AS timeout_documented_at, t.metadata->'timeout' AS timeout_meta
  FROM audit_logs a
  LEFT JOIN facilities f ON f.tenant_id = a.tenant_id AND f.id = NULLIF(a.metadata->>'facility_id', '')::int
  LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.uid = a.actor_uid
  LEFT JOIN cath_lab_readiness_checks t
         ON t.tenant_id = a.tenant_id AND t.case_id = NULLIF(a.resource_id, '')::bigint AND t.check_type = 'timeout'
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

`$2` / `$3` are the IST month bounds as instants. **EXPLAIN is a gate in the plan**: `EXPLAIN (ANALYZE, BUFFERS)` on the scratch DB after seeding ≥ 5 000 `audit_logs` rows across several actions and two tenants; acceptance = an index scan (or bitmap scan) on `idx_audit_logs_tenant_time_id` bounded by the month, **no** `Seq Scan` on `audit_logs`, and rows examined of the order of the tenant's rows in that month, not the table. "A few hundred report rows" is a statement about the output; the plan is the statement about the work. If the planner prefers the tenant-unaware single-column `action` index, the fix is a partial index `(tenant_id, created_at DESC, id DESC) WHERE action = '…'` in a **follow-up** migration numbered at push time, never a rewrite of the predicate. The `timeout` join is by the unique `(tenant_id, case_id, check_type)` key and adds one row per event.

### 7.3 Response

```json
{
  "month": "2026-09",
  "facility_id": null,
  "total_events": 3,
  "distinct_cases": 2,
  "facilities": [{ "facility_id": 4, "facility_name": "Main block", "events": 2, "cases": 1 }, { "facility_id": 7, "facility_name": "Annexe", "events": 1, "cases": 1 }],
  "timeout_outcomes": { "not_pending_at_start": 1, "performed_before_start_documented_late": 1, "performed_after_start": 0, "not_performed": 1, "unknown": 0 },
  "consent_authorities": { "patient": 2, "legally_authorised_representative": 0, "emergency_basis": 1, "not_recorded": 0 },
  "rows": [{
    "start_event_id": 88121, "case_id": 1201, "procedure_attempt": 2,
    "facility_id": 4, "facility_name": "Main block",
    "urgency": "emergency", "via": "status", "started_at": "2026-09-06T05:02:11.000Z",
    "blocking_check_types": ["labs", "timeout"], "missing_lab_items": ["hb"], "lab_component_status": "fresh",
    "consent_authority": "emergency_basis", "timeout_outcome": "performed_before_start_documented_late",
    "reason": "Primary PCI, outside reports awaited",
    "actor_uid": "…", "actor_role": "CONSULTANT", "actor_name": "Dr …"
  }]
}
```

`timeout_outcome` per row: `not_pending_at_start` when `timeout ∉ blocking`; otherwise from the joined check and the event's `recorded_at`: `performed_before_start_documented_late` (`performed_at ≤ recorded_at < documented_at`), `performed_after_start` (`performed_at > recorded_at`), `not_performed` (check not `pass`), `unknown` (pass without `performed_at`). `missing_lab_items` is `null` when the snapshot's was (unknown). CSV columns: `month, start_event_id, case_id, procedure_attempt, facility_id, facility_name, urgency, via, started_at, blocking_check_types, missing_lab_items, lab_component_status, consent_authority, timeout_outcome, reason, actor_uid, actor_role, actor_name`.

### 7.4 What the report is, who sees it, and how far

**It is identifiable operational data.** Case ids are internal keys but they resolve to a patient in one join, and every row names the operator who started the case. It is not anonymous and is not described as such anywhere (the Admin tab's header says "This report identifies cases and operators").

**Role gate**: `CATH_READINESS_REPORT_ROLES = [ADMIN, SUPER_ADMIN, CATH_LAB_INCHARGE, QUALITY_OFFICER]`, `requireRole(...)` at route level on both mounts.

**Object-level scope (owner's point: object-level authorisation ≠ route role).** Verified on `main`: the platform has **no** general staff→facility membership primitive — the only one is `pharmacy_staff_facility_grants`, owned by pharmacy; `users` carries no facility; the cath guards (`cathLabAccessGuards.js`) are **patient**-access guards, not facility guards; and the cath lab in-charge's existing tenant-wide cath read, the day list (`GET /cases`, `listCases`), has no facility predicate and is "deliberately NOT guarded (no single patient subject — role gate only)". So today a `CATH_LAB_INCHARGE` sees every facility's cath cases. The report shows strictly less than the day list does about each case. **Decision, by precedent**: the in-charge reads the report tenant-wide, exactly as the day list; ADMIN / SUPER_ADMIN / QUALITY_OFFICER read it tenant-wide by their nature; every row carries `facility_id` and the `facility_id` filter narrows the view. **If the owner wants the in-charge scoped to their facilities, that is a platform primitive (a staff–facility grant table like pharmacy's) and a lane of its own; it is recorded as §10.2's one open confirmation with this default so implementation is not blocked.** The projection of `reason` by `roleSeesSerologyDetail` is unchanged (QUALITY_OFFICER reads `null`).

**Audit on both mounts (owner's point).** The handler calls the shared writer `logAudit(req, 'cath_lab.report.starts_with_pending.read', { month, facility_id, format, total_events, distinct_cases, mount }, { resource: 'cath_lab_report', resourceId: 'starts-with-pending' })` (`src/utils/logAudit.js`, the platform's audit-trail writer) and **awaits it before sending** — the `cathDeviceHistoryHandler` rule: a reader must never receive the rows on a request whose access row was not even attempted. `format=csv` writes the same row with `format: 'csv'`, so an export is distinguishable from a screen read. The cath mount's `phiAccessLogger` row is written as today (no patient subject → `patient_id = NULL`); the governance mount has none, which is why the explicit row exists.

### 7.5 Canary and OpenAPI

As revision 1 (+2 reachable entries, positive control ADMIN reads the sentinel, liveness QUALITY_OFFICER reads `null`), plus the CSV form of both (§6.5) and the `facility_id` parameter in the overlay.

### 7.6 Admin surface

The tab gains a facility filter, the `procedure_attempt`, `consent_authority` and `timeout_outcome` columns, the two breakdown blocks, and the header line about identifiability. Reads the governance mount as before.

## 8. Data model — migration NNN

### 8.1 Why a migration now (and why not in revision 1)

Revision 1 kept everything in `metadata` and existing columns. The owner's point 4 — "'no migration' must not determine clinical meaning" — is accepted: the attempt lifecycle is a clinical fact, it is read by every rule, it is compared against the process clock and against lab instants through epoch twins, and it must be enforceable by a CHECK. A JSON key can be none of those cleanly. The cause of unavailability, likewise, has to be **stable across refreshes**, which means it must be persisted beside the state it explains.

`apps/backend/src/migrations/NNN_cath_lab_case_attempts.sql` — **number reserved at push time under the immutability rules** (re-checked 2026-09-07: every `refs/remotes/github/*` branch — seven at that check — tops at `766_cath_lab_readiness.sql`; the plan re-runs the check before the first push and renumbers **before** pushing if NNN has been taken, never after). Pure DDL + one backfill, no plpgsql body:

```sql
-- NNN_cath_lab_case_attempts.sql — spec 2026-09-06 (revision 2) §4.9, §5.6, §8.
ALTER TABLE cath_lab_cases
  ADD COLUMN procedure_attempt INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN attempt_started_at TIMESTAMPTZ(6);

-- A case that had started when this lands is in its (first) attempt; a case that
-- had not has no active attempt. Runs BEFORE the constraints below.
UPDATE cath_lab_cases SET attempt_started_at = actual_start_at WHERE actual_start_at IS NOT NULL;

ALTER TABLE cath_lab_cases
  ADD CONSTRAINT cath_lab_cases_attempt_check
    CHECK (procedure_attempt >= 1),
  -- The active attempt cannot start before the first start, and cannot exist without one.
  ADD CONSTRAINT cath_lab_cases_attempt_start_check
    CHECK (attempt_started_at IS NULL OR (actual_start_at IS NOT NULL AND attempt_started_at >= actual_start_at)),
  -- A running case IS a started attempt: closes the creation bypass at the database (decision 14).
  ADD CONSTRAINT cath_lab_cases_in_progress_attempt_check
    CHECK (status <> 'in_progress' OR attempt_started_at IS NOT NULL),
  -- A pre-start case has no active attempt (a reopened case is pre-start again).
  ADD CONSTRAINT cath_lab_cases_pre_start_attempt_check
    CHECK (status IN ('in_progress', 'completed', 'cancelled') OR attempt_started_at IS NULL);

ALTER TABLE cath_case_lab_readiness_items
  ADD COLUMN unavailability_cause VARCHAR(30),
  ADD COLUMN window_days INTEGER;

ALTER TABLE cath_case_lab_readiness_items
  ADD CONSTRAINT cath_case_lab_readiness_items_cause_check
    CHECK (unavailability_cause IS NULL OR unavailability_cause IN
      ('aged_out', 'future_dated', 'unparseable', 'withdrawn', 'corrected', 'policy_changed', 'reordered'));
```

No RLS change (row policies are unaffected by added columns); `schema.prisma` is updated for both models (the schema-drift gate); the OpenAPI pin compares the cause CHECK's list to `UNAVAILABILITY_CAUSES` the way it compares migration 482's type CHECK today. No index is added: the report's plan is checked before one is claimed (§7.2).

### 8.2 The snapshot (rules module, pure)

```js
export const START_SNAPSHOT_KEYS = Object.freeze([
  'recorded_at', 'procedure_attempt', 'via', 'command_id', 'procedure_log_id', 'urgency', 'reason',
  'blocking', 'missing_lab_items', 'readiness_picture_at', 'lab_component_status', 'consent_authority',
]);
export const START_VIAS = Object.freeze(['status', 'procedure_log']);
export const LAB_COMPONENT_STATUSES = Object.freeze(['fresh', 'stale', 'unavailable']);
export const START_PICTURE_FRESH_MS = 300_000;
export function buildStartSnapshot({ procedureAttempt, via, commandId = null, procedureLogId = null, urgency = null, reason = null, blocking = [], missingLabItems = null, readinessPictureAt = null, labComponentStatus = 'unavailable', consentAuthority = null, now = new Date() })
export function normalizeStartSnapshot(raw)        // exactly START_SNAPSHOT_KEYS, or null
export function startedWithReadinessPending(raw)   // true | false | null  (null when raw is not a snapshot)
export function missingLabItemCodes(items, settings)
export function labComponentStatus({ pictureAt, itemCount, now })
```

`missing_lab_items` is `null` when `lab_component_status === 'unavailable'` and an array otherwise (possibly empty).

### 8.3 Reserved keys at create

`CASE_START_METADATA_KEYS = ['readiness_at_start', 'readiness_at_start_history', 'start_commands']` stripped from `input.metadata` in `createCase`.

### 8.4 Reads

`caseRowTx` selects `attempt_started_at`, its epoch twin, `procedure_attempt`, `metadata->'readiness_at_start' AS readiness_at_start`; `caseById` selects `procedure_attempt`, `attempt_started_at`, `metadata->'start_commands' AS start_commands`, `metadata->'readiness_at_start' AS readiness_at_start` — never the whole column; `listCases` selects the two columns and the tri-state flag expression. **Correction to revision 1's ledger**: `cath_lab_cases.metadata` **is** UPDATEd by one existing writer, `resolveCathConsumableAuthorityRecovery` (`cathLabService.js`), with a `||` merge — which is exactly why every write in this lane is a merge too, and why the reopen uses `- 'readiness_at_start'` rather than a replacement.

## 9. Error handling and idempotency

| Code | HTTP | When |
|---|---|---|
| `CATH_LAB_CONSENT_REQUIRED` | 400 | Either start path while the `consent` check is not `pass`. Raised by `assertConsentDocumented`, reached only through `startCaseTx`. |
| `CATH_LAB_CONSENT_AUTHORITY_REQUIRED` | 400 | A `consent` pass written without `metadata.consent.authority` / `.mode` in the platform vocabularies. |
| `CATH_LAB_CONSENT_AUTHORITY_NOT_PERMITTED` | 400 | A `consent` pass whose authority the tenant's consent policy does not admit; `details.permitted`. |
| `CATH_LAB_TIMEOUT_PERFORMED_AT_REQUIRED` | 400 | A `timeout` pass written without a usable past `metadata.timeout.performed_at`. |
| `CATH_LAB_START_REASON_REQUIRED` | 400 | Status start, gate not clear, `reason` empty; `details.blocking`. |
| `CATH_LAB_START_COMMAND_REQUIRED` | 400 | Status start without a well-formed `command_id` (`normalizeCommandId` → `null`); `details.reason ∈ {missing, malformed}`. |
| `CATH_LAB_START_COMMAND_STALE` | 409 | The `command_id` started a different attempt of this case; `details: { command_attempt, current_attempt, case_status }`. |
| `CATH_LAB_CASE_STATUS_NOT_CREATABLE` | 400 | `POST /cases` with a status outside `CREATABLE_STATUSES`; `details.creatable`. |
| `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED` | 409 | Any `POST /cases/:id/status` on a `cancelled` case, and `POST /cases/:id/procedure-logs` on one — before any write; `details.reopen_path`. |
| `CATH_LAB_CASE_START_NOT_ELIGIBLE` | 409 | `POST /cases/:id/procedure-logs` on a `requested` (or unexpected-status) case, before the insert; `details.next_action`. |
| `CATH_LAB_REOPEN_REASON_REQUIRED` | 400 | `POST /cases/:id/reopen` with an empty `reason`. |
| `INVALID_STATE_TRANSITION` | 400 | `in_progress` from `requested` / `completed` / `in_progress` as today; `POST /cases/:id/reopen` on a non-cancelled case (`allowed` = that status's real targets). |
| `CATH_LAB_REPORT_MONTH_INVALID` / `CATH_LAB_REPORT_FACILITY_INVALID` | 400 | Report parameters. |
| `CATH_LAB_START_VIA_INVALID` | 400 | Internal guard in `buildStartSnapshot`; unreachable from a client, documented because the pin will find it. |
| `CATH_LAB_READINESS_BLOCKED` | — | **Removed** with the full gate (and the function that raised it). |
| `CATH_LAB_READINESS_CASE_STARTED` | 409 | **Kept**, one thrower: `unwaiveLabItem` (#1018 lift-no, verified on `main`). |

**Machine-checked coverage (owner's contract point).** The readiness overlay (`cathLabReadiness.mjs`) gains a second enum, `CASE_LIFECYCLE_ERROR_CODES`, listing every `CATH_LAB_(CONSENT|TIMEOUT|START|CASE_STATUS|CASE_CANCELLED|CASE_START|REOPEN|REPORT)_*` code above, documented on the three prose-only case operations and the two report operations. `cathLabReadinessOpenApiSource.test.js` gains a second scan, `/'(CATH_LAB_(?:CONSENT|TIMEOUT|START|CASE_STATUS|CASE_CANCELLED|CASE_START|REOPEN|REPORT)_[A-Z_]+)'/g`, over `cathLabService.js`, `cathStartsWithPendingReportService.js`, `cathLabReadinessRules.js` and the cath router, compared to that enum **in both directions** — the existing `CATH_LAB_READINESS_*` scan and its narrow scope are unchanged. The plan's first step for this test is to run the new scan on the base tree and reconcile any pre-existing match by name (none is expected: the existing `CATH_LAB_CASE_*` codes are `_NOT_FOUND`, `_ENCOUNTER_INVALID`, `_FACILITY_*`, which the alternation does not match).

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

Not open: the allowed consent authorities per tenant (hospital configuration, `tenants.settings.cath_lab.consent_authorities`, default all three — decision 21); the principle applies to every urgency; #1018's record-yes / lift-no; `requested` not start-eligible.

## 11. Client scope

**Staff (Flutter).** Models: `CathReadinessCheck.completedAt`, `.consent` (`CathConsentRecord { authority, mode, documentedAt }`), `.timeout` (`CathTimeoutRecord { performedAt, documentedAt, timing, documentedAfterStart }`), `.previousAttempts`; `CathLabReadinessItem.orderedAfterStart` / `.receivedAfterStart` / `.finalisedAfterStart` / `.unavailabilityCause`; `CathLabReadiness.procedureAttempt` / `.attemptStartedAt` / `.firstStartedAt` / `.startedWithReadinessPending` (`bool?`) / `.readinessAtStart` (`CathReadinessStartSnapshot`: recordedAt, procedureAttempt, via, urgency, reason, blocking, missingLabItems (`List<String>?`), readinessPictureAt, labComponentStatus, consentAuthority); `CathCaseReadiness.caseStatus` / `.procedureAttempt` / `.attemptStartedAt` / `.started` / `.startable` / `.consentPassed`. API: `startCase(caseId, { reason, commandId })`, `reopenCase(caseId, { reason, idempotencyKey })`, `updateReadinessCheck(..., { metadata })`. Checklist: `CathReadinessDependencies.startCase` / `.reopenCase` / `.labEvents` / `.connectionStates`; start row; reopen row; banners; consent choosers; time-out `performed_at` field; picture-as-of line; `staff:lab` subscription. Panel: gates lose `caseStarted`; item chip. Screen: header chip; `watchChannels` + `staff:lab`. Strings: **40 keys × 5 locales** — revision 1's 23 minus its five `consent_type*` keys (18 kept), plus 22: `start_definition`, `start_command_stale`, `start_lab_picture` (`{time}`), `start_lab_picture_unavailable`, `consent_authority_label`, `consent_authority.patient`, `consent_authority.legally_authorised_representative`, `consent_authority.emergency_basis`, `consent_mode_label`, `consent_mode.written`, `consent_mode.verbal`, `consent_mode.telephone`, `consent_caption_obtained` (`{authority}`, `{mode}`), `consent_caption_emergency` (`{mode}`), `timeout_performed_at`, `timeout_timing` (`{performed}`, `{documented}`), `timeout_documented_after_start`, `timeout_performed_after_start`, `picture_as_of` (`{time}`), `picture_paused`, `start_undocumented`, `reopen_new_attempt_note`. `i18n_guard_test.dart`'s cath-readiness test scans the widget files for the `s4.lib.cath_lab.readiness.` prefix, so every key used must exist in all five locales; the placeholder-bearing keys are added to its dynamic-placeholder check.

**Admin (Next.js).** `StartsWithPendingTab.tsx` with the facility filter, the new columns and the two breakdowns; `lib/api/cathDevices.ts` gains the path constant and the two functions (`month`, `facilityId?`); `page.tsx` gains the tab; test.

## 12. Testing and gates

The plan carries the tests task by task; this section names the ones the owner asked for so their presence can be checked against the plan.

**Unit**: `CREATABLE_STATUSES` / `createCase` refusal before any write; `transitionCaseStatus` refuses `cancelled → readiness_pending` (and every target) with the door named, before `validateCaseTransition` is consulted (the mock asserts no table lookup happened — or, equivalently, that a target the table would reject answers the door code, not `INVALID_STATE_TRANSITION`); `reopenCaseTx` against `requested`, `scheduled`, `readiness_pending`, `ready`, `in_progress`, `completed` → `INVALID_STATE_TRANSITION`, no UPDATE; the procedure-log table — every cell; the command outcomes; the attempt increment rule (started vs never started); `labsPictureForStartTx` with no rows → `null` / `unavailable`; `classifyUnavailability` table (§5.6); `computeCheckDecision` regime table keyed on `attempt_started_at`; markers incl. `finalised_after_start`; snapshot helpers with the new keys; `timeoutTiming`; consent write validation and policy; report month/facility validation, bound conversion in the SQL text (`a.created_at >= ($2::timestamptz AT TIME ZONE 'UTC')` matched literally), per-facility fold, breakdowns, CSV columns, projection; the pin file (caller counts, SQL shapes incl. `attempt_started_at`, `SET status =` list, the **write-site population list** — 9 `UPDATE` + 2 `INSERT` sites by `path:function`, exact, no `ON CONFLICT` — door pins, short-circuit order, absent old names); the lifecycle error-code scan.

**Deep**: the consent trio per path plus emergency-basis and legacy-pass starts; creation route refusal + 23514 on a raw running INSERT without an attempt start; the generic `/status` bypass; `/reopen` against a `scheduled` case; the reopen arc (refusal → reason → reopen → consent gate → start) with attempt numbers and history; **the aged-out-before-next-attempt test** (§4.9); **start with a never-settling refresh** (§4.5); **the replay sequence** (§4.10); the regime pair plus the four cause tests that need the rail (policy change, withdrawn, repeat-order-open, stability); late order / outside result / sign-off after start with the three markers; the report for the month with `start_event_id`, `procedure_attempt`, `timeout_outcome`, `consent_authority`, `distinct_cases`, facility filter, both mounts' `logAudit` rows (one per read, `format` recorded), CSV; EXPLAIN acceptance recorded.

**Staff widget**: the revision-1 list, plus the **end-to-end live-warning test**, the paused / denied states, the consent choosers writing `metadata.consent`, the emergency-basis caption never containing "consent", the time-out `performed_at` field, the stale-command handling, the tri-state banner logic, the reopen dialog's new-attempt note.

**Admin**: facility filter, breakdowns, new columns, identifiability header, CSV.

**Canary**: revision 1's additions plus CSV bodies, the reopen write mirror, the third sentinel.

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
15. Drop `actual_end_at = NULL` from the reopen → deep red with 23514 on the next start.
16. **Restore `CASE_STATUSES` in `createCase`** → route-level creation test red **and** the INSERT pin red.
17. **Delete the `=== 'cancelled'` short-circuit in `transitionCaseStatus`** → the generic-status bypass deep test red (`readiness_pending` reached without a reason or an audit row).
18. **Replace the explicit `!== 'cancelled'` in `reopenCaseTx` with the table check alone** → the `/reopen` on `scheduled` test red.
19. **Let a draft log start the case** → the draft-does-not-start unit and deep tests red.
20. **Do not increment `procedure_attempt` on reopen of a started attempt** → the aged-out-before-next-attempt deep test red (attempt 2's snapshot reads `procedure_attempt: 1`; the second audit row collides).
21. **Compare markers / regime against `actual_start_at` instead of `attempt_started_at`** → the reopen test red (staleness suppressed before attempt 2 started; markers true pre-start).
22. **Await the refresh in the start** → the never-settling-refresh test red (race timer wins).
23. **Return `[]` instead of `null` for missing item rows** → the unknown-picture test red.
24. **`cause === 'aged_out'` → `state === 'stale'`** → the policy-change and future-dated tests red; the repeat-order-open test red the other way.
25. **Drop the attempt from the command binding** → the replay deep test red (attempt 2 started by command A).
26. **Say "Consent obtained" for `emergency_basis`** → the Staff caption test red.
27. **Transform the column instead of the bounds in the report predicate** → the SQL-text unit test red **and** the EXPLAIN gate fails (seq scan).
28. **Remove `logAudit` from the governance mount registration** → the report audit deep test red (one row where two are expected).
29. **Skip the consent/time-out reset on reopen** → the attempt-2 consent-required assertion red.
30. **Persist no `unavailability_cause`** → the two-refresh stability test red (second refresh retracts).
31. **Splice the table name into `startCaseTx`'s UPDATE through `${…}`** (the literal no longer names `cath_lab_cases`) → the population pin red (the `UPDATE` list is one short of its expected length) **and** the SQL-shape pin red (its pinned line set shrinks). A set-only assertion — "every hit is on the allow-list" — stays green under this mutation, because a shrinking set is still a subset; pinning the exact list is what makes the drift visible. The boundary is stated honestly: a write whose table name never appears in a literal is outside every textual pin, and `lint:raw-params` is the other half of that guard.

**Gates** (Plan 3 Task 7 / Plan 2 Task 8 as template): backend lint; the **full** unit corpus; **two fresh-DB deep runs** of `cath-lab-readiness.deep|cath-reporting.deep|lab-signoff-safety.deep|bloodborne-markers.deep`; `openapi:check`; `check:migration-numbers` and `check:migration-immutability` (**live** this time — NNN is claimed); schema drift; `scripts/ci/security.mjs`; the EXPLAIN acceptance; Flutter analyze + `flutter test` for cath_lab and i18n; Admin lint + jest; the canary with the snapshot diff inspected; the mutation list above; a final `[full-ci]` commit; **draft PR only**, handed to the merge authority (dev-1b) with both gates named from the tier-verifying poller. Read `Suites failed` separately from `Tests passed`.

## 13. Rollout and compatibility

- migration NNN backfills `attempt_started_at` for every case that has an `actual_start_at` (running, completed, or cancelled after starting); `procedure_attempt` is 1 everywhere. Cases already `in_progress` have no snapshot: `readiness_at_start: null`, `started_with_readiness_pending: null` (**not** `false`), the muted "not documented" line, no banner; their checklists start living immediately.
- Legacy consent passes (no `metadata.consent`) satisfy the block and show "authority not recorded"; legacy time-out passes read `timing: 'unknown'`.
- The first refresh of every case after deploy rewrites its `labs` row once (four booleans and a cause per item) and stamps `window_days` on the item rows; no backfill.
- Clients that read `case_started` as "writes are refused" (the Staff panel gates) are updated in the same lane.
- The generated OpenAPI document changes in `CathLabCase` (two columns), `CathLabReadinessItem`, `CathLabReadiness`, the two report operations, the day-list prose, the three prose-only case operations, the consent / time-out prose on the readiness-check operation, and the order-missing / external-result 409 lists.
- Cases already `cancelled` gain the door retroactively; a case cancelled after starting reopens as attempt 2.
- The reachable snapshot changes by exactly two entries (the two report GETs).

## 14. Risks accepted

- An emergency start is one tap and one line away for the whole workflow audience (owner decision B).
- A required reason, a required authority/mode and a required `performed_at` are friction in the moment: one field each, and the procedure-record path needs no reason.
- The day-list flag lags the case detail until the post-commit refresh lands (a tick, not a failed pre-start refresh as in revision 1).
- A check passed after start looks like any other pass on surfaces that do not compare `completed_at` to `attempt_started_at`.
- Free text reaches every entitled role (four fields, §6.5) and is blanked for the rest.
- A tenant policy edit mid-procedure retracts the labs check (`policy_changed`) — rare, truthful, gates nothing once started.
- `cancelled` is no longer terminal; a reopen of a started case opens a new attempt with consent and time-out to re-document — one tap each, previous documentation in view.
- The in-charge's report scope is tenant-wide by precedent until the owner says otherwise (§10.2).
- `staff:lab` fires for every lab event in the tenant, not only this patient's; a started checklist reloads (a read-through refresh) on each, debounced. Bounded by the number of open started checklists, which is small by nature.
- migration NNN adds four CHECKs to `cath_lab_cases`; a row that violated them could only exist through a path outside this lane's (an import), which is exactly what the CHECKs are for.

## 15. Reconciliation with the merged baseline

1. **#1018 is merged** (`3f3959306`, head `a0144fc00`). `unwaiveLabItem` throws `CATH_LAB_READINESS_CASE_STARTED` after start; `waiveLabItem` does not; `recorded_after_start` on the item and the waive audit; no `lifted_after_start`. **Decision 9 = KEPT.** Only the `case_started` description and the order-missing / external-result 409 lists change in the overlay; `cathLabRouteGuards.test.js`'s deterministic-409 probe is untouched.
2. **#1022 is merged** (`35a231238`): `externalReportedMs` reads a date-only outside report as an IST calendar date. §5.6's `unparseable` / `future_dated` causes are computed on the resolver's `observedMs`, which already goes through it, so an outside report dated today is neither.
3. `isAfterCaseStart`, `resolveItemState`'s `caseStartedAt` and `computeCheckDecision`'s `started` all move from `actual_start_at` to `attempt_started_at`; #1018's unit and deep tests keep passing because for a first attempt the two instants are equal.
4. `recorded_after_start` stays #1018's; the three new markers sit beside it.
5. Staff panel gates, imports, OpenAPI regeneration — as revision 1.

## 16. Verification ledger (re-verified on `main` `5857298dc`, 2026-09-06; cite by function name)

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
| `refreshCaseLabReadiness` reads stored rows once (`storedByCode`), passes `caseStartedAt: cathCase.actual_start_at`, writes `live_evidence_refreshed_at` under `EVIDENCE_STAMP_MAX_AGE_MS = 60_000`; `caseRowTx` selects `actual_start_at` (no epoch twin yet) | `cathLabReadinessService.js` | verified |
| `refreshOpenCasesForPatient` predicate `status IN ('scheduled','readiness_pending','ready') AND actual_start_at IS NULL` | `cathLabReadinessService.js` | verified |
| `scheduleReadinessRefresh({ tenantId, patientUid, source })` — synchronous, boolean, never throws, per-patient collapse, serial tail, `setImmediate` first | `cathLabReadinessHooks.js` | verified |
| `getCase` calls `refreshCaseLabReadiness` as `SYSTEM_READ_THROUGH_CONTEXT` and logs failures | `cathLabService.js` — `getCase` | verified |
| `recordReadinessAudit(tx, { tenantId, action, resource, resourceId, context, metadata })` → `audit_logs` (tenant_id, uid, role, action, resource, resource_id, metadata, actor_uid, created_at) | `cathLabReadinessService.js` | verified |
| `logAudit(req, action, metadata, { resource, resourceId })` — the shared audit-trail writer (actor, subject, acting-as, ip, user agent) | `utils/logAudit.js` | verified |
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
| Canonical events land in `clinical_timeline_events` via `recordCanonicalClinicalEvent`; `visible_to_patient` is written **only** when the input says `true`; `writeCanonicalEvent` (cath) never sets it; the reader `readCanonicalPatientTimeline` returns `payload` unprojected; routes: `emr/clinicalTimelineRoutes.js`, `clinical/encounterRoutes.js`, `patient/patientSearchRoutes.js` | `canonicalClinicalPlatformService.js`; `cathLabService.js` — `writeCanonicalEvent` | verified — §6.5 rows 1 and 3; roles on the three routes are Task 0's Survey C |
| OpenAPI source pin: error-code scan = `/'(CATH_LAB_READINESS_[A-Z_]+)'/` over the three readiness modules + the cath router, both directions; `ERROR_CODES` (6) | `cathLabReadinessOpenApiSource.test.js`; `scripts/openapi/schemas/cathLabReadiness.mjs` | verified |
| `rowsToCsv` / formula neutralisation | `src/utils/csv.js` | as revision 1 |
| migration NNN free on every `refs/remotes/github/*` branch (all top at 766) | `git ls-tree` over the seven branches present at the check | verified 2026-09-07 — **re-check at push time** |
| `CATH_LAB_WORKFLOW_ROLES`, `CATH_LAB_INCHARGE`, `QUALITY_OFFICER`, `canUseCathWorkflow`, `normalizedRole` | `utils/roleHelpers.js` | verified |
| `router.get('/reports/:id', …)` exists (and `/reports/:id/pdf` before it) | `cathLabRoutes.js` | verified |
| Deep suite helpers: `seed`, `seedResult`, `labsCheck`, `caseStatus`, `pollForItem`, `asRlsRole`, `istDaysAgo`, `ctx`; `clinicalDate` imported from `services/clinical/bloodborneMarkerRules.js`; the regime test's **local** `age(days)` (rewrites `lab_results.performed_at`); **no** suite-level `setCheck` or `ageHgb` | `cath-lab-readiness.deep.test.js` | verified — the plan adds case-parameterised twins and lifts `age` to `ageHgb` |
