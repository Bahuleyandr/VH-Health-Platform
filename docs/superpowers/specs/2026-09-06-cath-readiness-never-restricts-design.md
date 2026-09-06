# Cath-lab readiness checklist never restricts — design

- Date: 2026-09-06
- Status: **draft, awaiting owner design approval of the documents**. Docs only; no code on this branch. The owner decisions below are confirmed with the merge authority (dev-1b); the lane merges on dev-1b's green verification, with no further owner gate. **Nothing is open.** The last open question — the procedure record on a cancelled case — was answered by the owner on 2026-09-06 and is recorded as decision 13 (§3, §4.8, §10.1 item 4); implementation Task 2 is no longer gated.
- Base: `github/main` at `60ade8474` (#1021 merged), read together with draft PR **#1018** (`feat/cath-readiness-followups`, head `856efef7c` at the time of writing). This lane assumes #1018 merges first and builds on it. Every citation below is by **function name**; line numbers differ between `main` and the #1018 head and are not load-bearing (`main` reads 632 / 1276 / 1370 for `assertReadinessComplete` / `transitionCaseStatus` / `recordProcedureLog`; the #1018 head reads 642 / ~1387 / ~1481 — the same three sites).
- #1018's shape this lane builds on (do not re-open): `waiveLabItem` is unguarded after start and derives `recorded_after_start`; `unwaiveLabItem` is **refused** after start (record-yes / lift-no). The plan's Task 0 re-verifies that shape at the #1018 head before any code is written.
- Predecessors: `2026-09-04-cath-pre-procedure-lab-readiness-design.md` (Plan 3, shipped as #1008) and its plan `2026-09-04-cath-lab-readiness.md`; #1018 (waiver exit, day-list summary, rules/actions/persistence split, late waivers).
- Plan: `docs/superpowers/plans/2026-09-06-cath-readiness-never-restricts.md`.

## 1. Principle and problem

Owner principle, verbatim (2026-09-06):

> in emergencies with no reports immediately available we will proceed with no reports and we might add while the procedure is ongoing and the reports become available; we do not want the pre-cath checklist to be restrictive as principle.

The design goal that follows from it: **the pre-cath checklist informs and records; it never blocks and never freezes. Lateness is marked, never refused.** The principle is general — it is not scoped to `urgency = emergency` — so nothing below keys a permission on urgency; urgency is recorded so the pattern can be reviewed. There is exactly one hard block, and it is not a readiness check in the checklist's sense: **consent** (§4.3).

The owner's five decisions (2026-09-06), each confirmed with dev-1b:

1. **The principle** above.
2. **Post-start waivers: record-yes / lift-no** — built on #1018; this lane assumes it and does not re-open it.
3. **No second signature and no role restriction** on "start with checks pending": one reason line, the audit row and the at-start snapshot suffice.
4. **A monthly report** of starts-with-checks-pending (§7).
5. **Consent is compulsory before the procedure** — the single hard block (§4.3).

Facts, verified at the #1018 head (re-verify at build time; §16 is the citation ledger):

**(a) The checklist blocks a normal start, and there is no bypass today.** `CASE_TRANSITIONS` (`cathLabService.js`) reaches `in_progress` only from `ready`. `assertReadinessComplete` (`cathLabService.js`; throws 400 `CATH_LAB_READINESS_BLOCKED` unless `evaluateReadinessGate` finds every required check of `READINESS_TYPES` — consent, labs, allergy_renal_risk, anticoagulation, blood_bank, equipment, implants_device_rep, timeout — in `READINESS_CLEAR_STATES`: pass, waived, not_applicable) has **exactly two callers**: `transitionCaseStatus` (for the `in_progress` target) and `recordProcedureLog` (before its force-start). Both run before anything starts. `recordProcedureLog` does force `in_progress` + `actual_start_at` when the case is in any other status — but only after its own gate call, so the procedure record bypasses the transition table, not the checklist. `ready` itself is set only by `recomputeCaseStatusTx` (`cathLabReadinessService.js`, over its inlined `READINESS_CHECK_TYPES`) and `updateReadinessCheck` when the same gate is clear.

**(b) After start the checklist freezes.** `refreshOpenCasesForPatient` refreshes only `status IN ('scheduled','readiness_pending','ready') AND actual_start_at IS NULL`, so an in-house result signed off mid-procedure never reaches the item rows. `orderMissingLabs` and `recordExternalLabResult` (`cathLabReadinessActions.js`) refuse a started case with 409 `CATH_LAB_READINESS_CASE_STARTED`. `computeCheckDecision` (`cathLabReadinessRules.js`) gates **both** automation branches on `!started`: after start the auto-managed `labs` check neither improves nor regresses — Plan 3's STALENESS rule, whose pre-start half ("an old potassium is exactly what the pre-cath checklist exists to catch") must keep working. #1018 opened the waiver pair with `isAfterCaseStart` and the derived `recorded_after_start`; its own comment leaves order-missing and outside-result to "their own follow-up lane" — this one.

**(c) STEMI is display-only here, and it creates the emergency case as `readiness_pending`.** `stemiPathwayService` inserts the primary-PCI case with `status = 'readiness_pending'`, `urgency = 'emergency'`, seeds the eight checks pending, and never writes the case status or `actual_start_at`; `readinessWithoutLabEvidence` strips `live_evidence` / `critical_items` from the activation surface. So `readiness_pending → in_progress` (§4.1) is exactly the emergency path, and nothing in this lane touches the STEMI service.

**(d) The serology disclosure canary is a gate.** `serologyDisclosureCanary.test.js` poisons `lab_results` with a sentinel, walks every GET on the cath, STEMI and governance mounts as every platform role, and asserts (`disclosures()`) that no non-entitled 2xx body carries the sentinel, a serology code in `critical_items`, or a valued/critical serology item — in `items[]` and in `metadata.live_evidence[]`. It pins the day-list summary's exact key set, snapshots the reachable set per GET (`serologyDisclosureCanary.reachable.json`), and mirrors the rule onto writes. Every new payload key in this lane is a **boolean, a check type, an item code or a timestamp** — never a value — except one free-text field, which is projected (§6.4).

Two more facts that shape the design:

- **The Staff app cannot start a case today.** No client drives `POST /cath-lab/cases/:id/status` or `/procedure-logs` (0 hits under `apps/staff/lib` and `apps/admin/src`). "Start" is therefore the first start affordance in Staff, not a variant of an existing one.
- **The cath mount never admits QUALITY_OFFICER.** `/api/v1/cath-lab` is gated by `CATH_LAB_ROUTE_ROLES` (`routeRolePolicy.js`: the `cath_lab` capability group plus the doctor tiers, nursing, RECEPTIONIST and TECHNICIAN) and the canary's reachable snapshot confirms no cath GET answers a quality officer. A route-level gate under a prefix mount can only subtract (Plan 2's prefix-mount lockout, hit again by Plan 3 for the readiness settings). The monthly report therefore follows the platform's existing answer — `cathDeviceHistoryHandler`, one handler registered on both the cath mount and the governance mount (`/api/v1/cath-reprocessing`, `CATH_REPROCESSING_POLICY_ROUTE_ROLES`: QUALITY_OFFICER, INFECTION_CONTROL_OFFICER, ADMIN, SUPER_ADMIN) — §7.

## 2. What does NOT change

- **The gate still drives `ready` vs `readiness_pending` for the board.** `evaluateReadinessGate`, `recomputeCaseStatusTx` and `updateReadinessCheck`'s status rewrite keep deciding between those two pre-start statuses exactly as today. Once a case is `in_progress` neither touches its status (`WHEN status IN ('scheduled','readiness_pending','ready')`), confirmed by a deep test.
- **The STEMI pathway** (§1c).
- **The critical-warning safety review on a human `labs` pass** (`updateReadinessCheck`, `CATH_LAB_READINESS_REASON_REQUIRED`, `CRITICAL_LAB_ACKNOWLEDGED`). A critical value never blocks (Plan 3, owner decision).
- **Idempotency scopes**: `cath_lab_readiness_order`, `_external`, `_waive`, `_unwaive` unchanged; the status route claims none today and still claims none (a repeat start answers the invalid-transition error from `in_progress`, idempotent by state). One scope is **added**, `cath_lab_case_reopen`, on the one new route (§4.8) — a reopen is not idempotent by state the way a start is, because a replayed reopen of a case that has since started would answer the transition error rather than the original response.
- **#1018's record-yes / lift-no asymmetry**: `waiveLabItem` after start records with `recorded_after_start`; `unwaiveLabItem` after start refuses. The item key `recorded_after_start` keeps its meaning (a waiver documented after start), the waive audit key keeps its meaning, the Staff chip `cath-lab-waived-after-start-<item>` stays. This lane adds beside them; it redefines nothing and does not re-open the asymmetry.
- The eight `check_type` values; automation altering only rows it set (`auto_managed`); `AUTOMATION_METADATA_KEYS` stripping; RLS; the seven items; the resolver's state vocabulary; the roles on every existing route.
- **No new start route.** The existing `POST /cases/:id/status` with `{ status: 'in_progress', reason }` is the start; the existing `POST /cases/:id/procedure-logs` is the other start. One function behind both (§4.2). One route *is* added — `POST /cases/:id/reopen` (§4.8) — and it is deliberately **not** a start route: it writes `readiness_pending`, never `in_progress` and never `actual_start_at`.
- **No migration** (§8). Decision 13's reopen door reuses an existing status and existing columns, so it does not change that (§4.8, §8.1).

## 3. Decisions

1. **Consent is the one hard block, and it is enforced in one place.** `assertReadinessComplete` (its single definition) is **weakened** from the full gate to consent-only: the `consent` check must be `pass`; `waived` and `not_applicable` do not satisfy it, and its `required` flag is not consulted (marking consent not-required is not a way round the block). New code `CATH_LAB_CONSENT_REQUIRED`, 400 like the code it replaces. Emergency / relative / verbal consent is a `pass` whose type is recorded in the check's metadata (`consent_type`) — never a waiver. `CATH_LAB_READINESS_BLOCKED` goes with the full gate.
2. **One start path, one snapshot, one assertion.** `startCaseTx` in `cathLabService.js` is the only code that moves a case to `in_progress`, the only code that sets `actual_start_at`, and the only caller of `assertReadinessComplete`. `transitionCaseStatus` and `recordProcedureLog` are its only two callers; the inline force-start in `recordProcedureLog` is deleted. A source pin asserts all three counts (§4.3), so a third start path cannot quietly skip the consent block and the two existing paths cannot drift apart ("why can I start it but not record it").
3. **`scheduled` and `readiness_pending` may start; `ready` still may.** `CASE_TRANSITIONS` adds `in_progress` to `scheduled` and `readiness_pending`; `START_ELIGIBLE_STATUSES` is derived from the table. `requested` is not added: a requested case reaches `scheduled` in one ungated transition, and the emergency case STEMI creates is already `readiness_pending` (§1c). `completed → in_progress`, `cancelled → in_progress` and `in_progress → in_progress` stay impossible — a cancelled case reaches a startable state only through decision 13's audited reopen, never by starting directly.
4. **Reason required only on the explicit start with a pending gate.** `via: 'status'` + gate not clear + empty reason → 400 `CATH_LAB_START_REASON_REQUIRED` carrying `details.blocking`. The procedure-record start (`via: 'procedure_log'`) takes an optional `start_reason` and never refuses for its absence: it is the record of an act already under way. Owner decision B: a reason, the audit row and the snapshot are the controls — no second signature, no role restriction, no urgency restriction.
5. **The snapshot is codes and booleans.** `readiness_at_start` carries the gate's `blocking[]` (`{ check_type, reason }`), `missing_lab_items[]` (item codes), the reason line, urgency, the path (`via`), the procedure-log id when applicable, and two timestamps. Never a lab value.
6. **The audit row is the record; the case row is the projection.** `audit_logs` gets `cath_lab.case.started_with_readiness_pending` (only when something was pending; `urgency` and `facility_id` on every row); `cath_lab_cases.metadata.readiness_at_start` gets the same snapshot for the read path; the canonical `cath_lab.case_in_progress` event's payload carries both so the timeline shows it. The monthly report (§7) is a query over the audit rows — no new table.
7. **After start, the checklist keeps living; staleness alone never moves the check; new evidence always does.** `refreshOpenCasesForPatient` includes started, non-terminal cases. `computeCheckDecision`'s improve branch loses its `!started` guard. Its retraction branch keeps retracting **except** when the case has started and every missing required item is missing only because it is `stale` — age is noise mid-procedure. A critical or abnormal value arriving mid-procedure is written to `critical_warning` / `critical_items` / `live_evidence` exactly as before start, displayed prominently, and the check reflects it truthfully; the case status and the gate are untouched because started is a fact. The suppression is gated strictly on `actual_start_at` (§5.2); pre-start behaviour is unchanged and separately tested.
8. **Lateness is derived, not stored — three markers per item.** #1018's `recorded_after_start` (waiver documented after start) is kept as is. This lane adds `ordered_after_start` (the in-flight order was placed after `actual_start_at`) and `resulted_after_start` (the winning result row was received here after `actual_start_at`). All three are computed inside `resolveItemState` from `caseStartedAt` and columns that already exist (§8).
9. **The two remaining refusals go.** `orderMissingLabs` and `recordExternalLabResult` accept a started case; the order becomes `STAT`; their audit rows gain `ordered_after_start` / `recorded_after_start`. What happens to `CATH_LAB_READINESS_CASE_STARTED` depends on #1018's final shape and is resolved in the plan's Task 0: if `unwaiveLabItem` still raises it after start (lift-no), the code keeps exactly one thrower and stays in the overlay's enum; if #1018 landed without that refusal, the last thrower goes here and the enum, the two 409 responses and the route-guard probe are edited in the same commit (the OpenAPI source pin forces it).
10. **The only free text in the picture is projected.** `readiness_at_start.reason` (and the report's `reason` column) is blanked, key kept, for roles outside `roleSeesSerologyDetail` — the same predicate as every other cath projection; the canary asserts it.
11. **Monthly report on both mounts, one handler, one role constant.** `GET /api/v1/cath-lab/reports/starts-with-pending` and `GET /api/v1/cath-reprocessing/reports/starts-with-pending` share `cathStartsWithPendingReportHandler`; both are gated at route level by `CATH_READINESS_REPORT_ROLES = [ADMIN, SUPER_ADMIN, CATH_LAB_INCHARGE, QUALITY_OFFICER]` (`roleHelpers.js`, beside the other cath role sets). The quality officer reaches it through the governance mount; the cath lab in-charge through the cath mount (§7).
12. **`timeout` pending at start is expected** in an emergency and is recorded like any other check (§4.7).
13. **A procedure log on a `cancelled` case is refused, and the refusal names the door.** Owner decision 2026-09-06 — *refuse, but give it a door*. `recordProcedureLog` on a `cancelled` case throws 409 `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED` before the log row is written, and its message names the route that opens the door. The door is **`reopenCaseTx`: an audited `cancelled → readiness_pending` transition** with a mandatory reason, its own audit action `cath_lab.case.reopened`, and its own route `POST /cases/:id/reopen` (§4.8). Un-cancelling is therefore a **decision someone makes and the audit trail records**, never a side effect of writing a procedure log. `startCaseTx` stays the only writer of `in_progress` and `actual_start_at`, and after a reopen the ordinary start flow — consent block included — applies unchanged.

The first draft carried the cancelled-case question here as "decision 12" and then withdrew it into a §10.2 open owner item; §10.2 is now **gone** and its answer is recorded as §10.1 item 4. It lands here as **decision 13** because 12 is the `timeout` decision, and the existing numbers are not renumbered (both documents cite decisions 3, 4, 7 and 9 by number). The other half of that draft decision was never in question and is stated where it is implemented (§4.2): with one start path, `recordProcedureLog` on `in_progress` or `completed` inserts the log and leaves the case alone — an amendment after the fact, never a re-animation.

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
  // Decision 13, the door out of cancellation. EXACTLY ONE outbound target,
  // and it is a PRE-START status: a cancelled case is never started directly,
  // it is reopened (audited, with a reason) and then started by the ordinary
  // flow. cancelled -> in_progress stays impossible, which is what keeps
  // startCaseTx the only writer of in_progress / actual_start_at (§4.8).
  cancelled: ['readiness_pending']
});
// Every status the table lets start, DERIVED from the table so the two cannot disagree.
// `cancelled` is deliberately NOT in this list: its only target is readiness_pending.
export const START_ELIGIBLE_STATUSES = Object.freeze(
  Object.entries(CASE_TRANSITIONS)
    .filter(([, targets]) => targets.includes('in_progress'))
    .map(([from]) => from)
);   // ['scheduled', 'readiness_pending', 'ready']
// The one status the reopen door opens from, and the one status it opens onto.
// A literal pair, not a derivation: the door is a named act, and the unit test
// asserts CASE_TRANSITIONS.cancelled === [REOPEN_TARGET_STATUS] so the two
// cannot drift (§4.8's pins).
export const REOPENABLE_STATUSES = Object.freeze(['cancelled']);
export const REOPEN_TARGET_STATUS = 'readiness_pending';
```

### 4.2 `startCaseTx` — the one start path

Signature (internal, `cathLabService.js`):

```js
async function startCaseTx(tx, { tenantId, cathCase, reason = null, via, procedureLogId = null, context = {} })
// via: 'status' | 'procedure_log'
// returns { updated, snapshot }
```

Order of work, all on the caller's tenant transaction, case row already locked `FOR UPDATE` by `caseById(..., { lock: true })`:

1. `cathCase.status ∈ START_ELIGIBLE_STATUSES`, else `AppError.invalidTransition(status, 'in_progress', CASE_TRANSITIONS[status])` (the same error the transition table raises today). Nothing is written.
2. `gate = await assertReadinessComplete(tx, tenantId, caseId)` — the **consent** block (§4.3). Throws 400 `CATH_LAB_CONSENT_REQUIRED` before anything is written; returns the full gate evaluation (`ready`, `blocking`) for the snapshot.
3. `reason = cleanText(reason, 500)`. If `!gate.ready && via === 'status' && !reason` → 400 `CATH_LAB_START_REASON_REQUIRED`, `details: { blocking: gate.blocking }`. Nothing has been written.
4. `labs = labsSnapshotForStartTx(tx, …)`: the **stored** item rows (`cath_case_lab_readiness_items`) reduced by `missingLabItemCodes(items, settings)` — the same availability rule the day list uses — plus the `labs` check's `metadata.live_evidence_refreshed_at` as `lab_snapshot_as_of`. The start never waits on the lab rail (§4.5).
5. `snapshot = buildStartSnapshot({ via, procedureLogId, urgency, reason, blocking: gate.blocking, missingLabItems: labs.missing, labSnapshotAsOf: labs.as_of, now })` (pure, rules module — §8.2 for the shape).
6. `UPDATE cath_lab_cases SET status = 'in_progress', actual_start_at = COALESCE(actual_start_at, NOW()), metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('readiness_at_start', $3::jsonb), updated_by = $4, updated_at = NOW() … RETURNING *`. A merge, never a replacement: the column is caller-supplied at create and other keys (STEMI's `stemi_activation_id`) live in it.
7. Canonical event `cath_lab.case_in_progress` (the name `transitionCaseStatus` already emits as `` `cath_lab.case_${target}` ``), `eventStatus: 'in_progress'`, `payload: { status, reason, via, started_with_readiness_pending, readiness_at_start: snapshot }`, `beforeState` / `afterState` as today; `updateCaseCanonicalRefs`. The procedure-record start gains this event for the first time — today a force-start leaves no `case_in_progress` on the timeline, only `procedure_logged`.
8. **Only when `gate.blocking.length > 0`**: `recordReadinessAudit(tx, { action: 'cath_lab.case.started_with_readiness_pending', resource: 'cath_lab_cases', resourceId: caseId, context, metadata: { case_id, facility_id, ...snapshot } })` — the `audit_logs` row, same writer as every readiness audit. The actor is the person who started the case, from `context`.

`transitionCaseStatus`: after `validateCaseTransition`, `if (target === 'in_progress') { const { updated } = await startCaseTx(…, { reason: input.reason, via: 'status' }); … }` — the generic UPDATE loses its dead `actual_start_at` branch; the canonical event for the start is written by `startCaseTx`; SLA handling for `completed` / `cancelled` is unchanged.

`recordProcedureLog`: insert the log as today, then: status in `START_ELIGIBLE_STATUSES` → `startCaseTx(…, { reason: input.start_reason, via: 'procedure_log', procedureLogId })`; `in_progress` or `completed` → nothing (an amended log on a finished case does not reopen it). The inline `assertReadinessComplete` call and the inline force-start UPDATE are deleted; the consent block now runs inside `startCaseTx`, i.e. only when the log is the start — a log recorded against a case already `in_progress` is not re-gated, because the block is on starting, not on documenting.

**`cancelled` is refused, and the refusal names the door (decision 13).** `recordProcedureLog` on a `cancelled` case throws **409 `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED`** before the log row is written, message: *"This case was cancelled. Reopen the case (POST /cath-lab/cases/:id/reopen) with a reason before recording the procedure."*, `details: { case_status: 'cancelled', reopen_path: '/api/v1/cath-lab/cases/:id/reopen' }`. Today's silent force-start of a cancelled case is deleted with the rest of the inline force-start. This is a refusal *with* an in-app alternative, which is what the owner's principle requires; the alternative is §4.8. There is no `REFUSE_PROCEDURE_LOG_ON_CANCELLED` flag and no TODO-owner marker — the question is answered.

The transition path is refused by the table for the same case and needs no new code: `validateCaseTransition('cancelled', 'in_progress')` throws 400 `INVALID_STATE_TRANSITION` with `allowed: ['readiness_pending']`, and that `allowed` list is itself the pointer to the door. Keep it so — `startCaseTx`'s own eligibility guard (step 1 above) raises the same error from the same table, so neither start path can reach `in_progress` from `cancelled`.

### 4.3 Consent — the one hard block

`assertReadinessComplete` keeps its name and its single definition, and changes what it asserts:

```js
// The ONE hard block. Owner decision 2026-09-06: consent is compulsory before
// the procedure; every other readiness check informs and records. `pass` only
// — a waived or not-applicable consent is not consent, and `required` is not
// consulted because marking consent not-required must not be a way round it.
// Emergency / relative / verbal consent is a `pass` whose type is recorded in
// the check's metadata.consent_type, never a waiver. Called from startCaseTx
// and nowhere else (cathLabStartPathPin.test.js), so both start paths receive
// exactly this rule.
async function assertReadinessComplete(db, tenantId, caseId) {
  const checks = await readinessForCase(db, tenantId, caseId);
  const gate = evaluateReadinessGate(checks);
  const consent = checks.find((check) => check.check_type === 'consent');
  if (!consent || consent.status !== 'pass') {
    throw AppError.badRequest(
      'Consent must be recorded as passed before the procedure starts',
      'CATH_LAB_CONSENT_REQUIRED',
      { consent_status: consent?.status ?? 'missing', blocking: gate.blocking }
    );
  }
  return gate;
}
```

**Why weaken the one function rather than add a consent check at one site.** The two hazards, named so the tests can be read against them:

- (i) *Weaken only the transition.* The status route starts a case with labs pending; the procedure log, still demanding the full gate, refuses to record the procedure that is now under way — "why can I start it but not record it". Prevented by construction: there is one start function and one assertion inside it.
- (ii) *Weaken both but drop consent on one.* The hard block leaks through whichever path forgot it. Prevented by construction for the same reason, and pinned.

**The pin** (`cathLabStartPathPin.test.js`, textual, in the style of `labExternalResultCallSites.test.js` — comments stripped, shipping modules only):

- `assertReadinessComplete(` is **called** from exactly one function body in `apps/backend/src`: `startCaseTx`.
- `startCaseTx(` is **called** from exactly two function bodies: `transitionCaseStatus` and `recordProcedureLog`.
- **The third pin reads the SQL, not the call graph.** A fourth start path does not have to call anything this lane wrote — it only has to issue a raw `UPDATE cath_lab_cases SET actual_start_at = NOW()` of its own, and the two caller counts above would stay green while it did. So the pin scans the **source text** of every shipping module under `apps/backend/src` (services *and* routes and controllers; `tests/` excluded, comments stripped), extracts every backtick SQL literal that names `cath_lab_cases`, and matches three shapes inside those literals: `/actual_start_at\s*=/`, `/status\s*=\s*'in_progress'/`, and the `SET status = CASE … 'in_progress' … END` shape. Every matching line must sit in exactly one function — `cathLabService.js:startCaseTx` — and the **count of matching lines is pinned** (2: the `status` assignment and the `actual_start_at` assignment). A stray `UPDATE cath_lab_cases SET actual_start_at = NOW()` in any other service reddens it; so does a second one added inside `startCaseTx`. Scoping to literals that name the table is what makes the pin true at all: `status = 'in_progress'` and `actual_start_at =` are ordinary text elsewhere in the tree (`dialysis_sessions`, housekeeping requests, workflow tasks all carry both), and a tree-wide grep would be red on `main`.
- **The parameterised hole is closed with a literal list.** A start path could also write `SET status = $3` and bind `'in_progress'`, which no literal-text match can see. So the same pin asserts that, among SQL literals naming `cath_lab_cases`, *any* `SET status =` assignment (parameterised or not) occurs only in a named allow-list of **five** `path:function` pairs — `cathLabService.js`: `startCaseTx`, `reopenCaseTx`, `transitionCaseStatus`, `updateReadinessCheck`; `cathLabReadinessService.js`: `recomputeCaseStatusTx` — deliberately a literal list, not a prefix (the `labExternalResultCallSites.test.js` rule). A sixth writer of the case status has to be argued for in a diff. `reopenCaseTx` (§4.8, decision 13) is the one entry this lane adds to that list, and it is the reason the list is edited rather than the pin loosened.
- **The reopen door is pinned to one door and one writer** (decision 13). Two more assertions in the same file: `CASE_TRANSITIONS.cancelled` deep-equals `['readiness_pending']` — exactly one outbound transition, and it is a pre-start status, so no widening of the door passes silently; and among SQL literals naming `cath_lab_cases`, every line matching `/status\s*=\s*'readiness_pending'/` sits in exactly one function, `cathLabService.js:reopenCaseTx` (one line). `recomputeCaseStatusTx` and `updateReadinessCheck` also write `readiness_pending`, but they bind it as a **parameter** (`THEN $3`) and never as a literal, so they do not collide with this shape; the `SET status =` allow-list above is what covers them. Together the two say: `cancelled` has one way out, and only `reopenCaseTx` takes it.
- **The start-path counts are unchanged by the door.** `reopenCaseTx` writes `status = 'readiness_pending'` and `actual_end_at = NULL`, neither of which matches `/actual_start_at\s*=/`, `/status\s*=\s*'in_progress'/` or the `SET status = CASE … 'in_progress' … END` shape. The pinned line count therefore stays **2**, both in `startCaseTx`. That is the mechanical statement of the design's whole claim about the door: it leads to a startable state, it does not start anything.
- `CATH_LAB_READINESS_BLOCKED` occurs nowhere in shipping code.

**A deep test per path** (`cath-lab-readiness.deep.test.js`, own cases per test): status path — consent `pending`, everything else pass → `POST /status in_progress` refused `CATH_LAB_CONSENT_REQUIRED`, case still `scheduled`, no audit row, no `actual_start_at`; consent `waived` → refused the same way; consent `pass`, labs pending → started with the snapshot and the audit row. Procedure-log path — the same three, with "nothing written" meaning no `cath_procedure_logs` row either (the transaction rolled back); consent pass + labs pending → the log is inserted and the case starts with `via: 'procedure_log'` and `procedure_log_id`.

**Staff.** The start row (§4.4) is **disabled** while the consent check is not `pass`, with the reason under it: "Consent must be recorded as passed before the procedure can start" (key `cath-readiness-start-consent-blocked`). It never posts a start the server would refuse. The consent check's own confirm dialog (existing `_CathReadinessConfirmDialog`, status `pass`) gains a consent-type chooser — written, verbal (emergency), relative / legal representative, telephone — written to the check's `metadata.consent_type`; the backend records the value and enforces no vocabulary (recording, not restricting).

### 4.4 The Staff "Start" action

The checklist (`cath_readiness_checklist.dart`) gains a start row above the eight checks whenever the loaded case is in a start-eligible status:

- Consent not `pass` → the row is disabled with the consent reason (§4.3). Nothing else is evaluated first: consent is the door.
- Consent pass, gate clear → button **"Start procedure"**; a plain confirmation; posts `{ status: 'in_progress' }`.
- Consent pass, gate not clear → button **"Start anyway"**; the dialog **names the pending checks** from `readiness_gate.blocking` (already computed server-side by `getCase`), appends the missing lab items from `lab_readiness.missing[]` under the Labs entry, states that the procedure starts now and the pending checks will be recorded against it, and **requires a reason** (`_CathReadinessConfirmDialog` with `reasonRequired: true`). Posts `{ status: 'in_progress', reason }`.
- The case id is captured before the dialog awaits and the write is dropped silently if the card was rebound (the existing rule in `_setStatus`).
- Success reloads the case; the banner (§6.3) then shows.

New client: `CathLabApiService.startCase(caseId, { reason })` → `POST /cath-lab/cases/:id/status`. No idempotency key (the route claims none; a double tap answers the invalid-transition error and the reload shows the case started).

### 4.5 The start never waits on the lab rail

`getCase` runs the read-through lab refresh first. The start does the same **before** its transaction, best-effort: `refreshCaseLabReadiness({ tenantId, caseId, context: SYSTEM_READ_THROUGH_CONTEXT }).catch(log)`. Inside the transaction the snapshot reads the **stored** rows and stamps them with `lab_snapshot_as_of`. Running the refresh inside the start transaction was considered and rejected: a refresh failure there (a corrupt waived row answers 400 `CATH_LAB_READINESS_VALUE_INVALID`) would abort the start — the lab rail blocking the knife, which is the exact thing this lane removes. The refresh is the system's act (`actorUid: null, actorRole: 'SYSTEM'`), exactly as on `getCase`.

### 4.6 Audit and review

`audit_logs.action = 'cath_lab.case.started_with_readiness_pending'`, `resource = 'cath_lab_cases'`, `resource_id = <case id>`, `actor_uid` / `uid` = who started, `role` = their role, `metadata` = `{ case_id, facility_id, recorded_at, via, procedure_log_id, urgency, reason, blocking, missing_lab_items, lab_snapshot_as_of }`. `urgency` is recorded on every row so the pattern (how often does an elective case start with checks pending?) is the one-line query the monthly report runs (§7); nothing is permitted or refused on it. The canonical `cath_lab.case_in_progress` event carries the same snapshot in its payload for the timeline.

### 4.7 `timeout` semantics

`timeout` is the pre-incision team time-out — by its nature the last check, performed at the table. In an emergency start it is **expected** to be pending at "Start anyway", so it is recorded in `blocking` like any other check and never treated specially by the backend. After start the team records it through the existing human status control (the checklist keeps living, §5); its `completed_at > actual_start_at` marks it as recorded after start, and Staff shows the "Recorded after start" chip on the check row (§6.3). The Staff dialog does not pre-fill or auto-pass it: a time-out that was not performed must not read as performed.

### 4.8 `reopenCaseTx` — the door out of `cancelled` (decision 13)

Owner decision, 2026-09-06, verbatim: **"deliberate, auditable, and nothing stranded."** Recording a procedure must not silently resurrect a cancelled case, so the refusal in §4.2 stands; and a refusal cannot be a dead end, so the state change becomes **a decision someone makes and the audit trail records** — never a side effect of writing a procedure log.

**The shape.** A distinct, audited transition *into a startable state* — not a parallel record path. `cancelled → readiness_pending`, an **existing** pre-start status, so there is no status-vocabulary change, no `cath_lab_cases_status_check` widening, and **no migration**. After the reopen the case is an ordinary pre-start case and everything that already exists applies to it: `recomputeCaseStatusTx` moves it on to `ready` if the gate is clear (expected, and correct — the readiness picture is recomputed, not inherited), and starting it goes through `startCaseTx` with the consent block and, if the gate is not clear, the mandatory start reason. `startCaseTx` remains the only writer of `in_progress` and of `actual_start_at`.

Signature (internal, `cathLabService.js`, beside `startCaseTx`):

```js
async function reopenCaseTx(tx, { tenantId, cathCase, reason, context = {} })
// returns { updated }
```

Order of work, on the caller's tenant transaction, case row already locked `FOR UPDATE` by `caseById(..., { lock: true })`:

1. `cathCase.status ∈ REOPENABLE_STATUSES`, else `AppError.invalidTransition(status, REOPEN_TARGET_STATUS, CASE_TRANSITIONS[status] || [])` — the same error and the same table as every other transition. Nothing is written. (`validateCaseTransition(cathCase.status, 'readiness_pending')` is the equivalent call and is what the implementation uses.)
2. `reason = cleanText(input.reason, 500)`. If empty → **400 `CATH_LAB_REOPEN_REASON_REQUIRED`**, `details: { case_status: 'cancelled' }`. Nothing has been written. The reason is **mandatory here and has no exemption**: unlike the start reason (§3 decision 4, waived on the procedure-log path because the procedure is already under way) a reopen is never incidental — it is the exceptional act itself.
3. Capture `cancelled_at = cathCase.actual_end_at` **before** the UPDATE clears it, for the audit row.
4. The UPDATE — one statement, both writes:

```sql
UPDATE cath_lab_cases
   SET status = 'readiness_pending',
       -- Cancelling stamps actual_end_at (transitionCaseStatus's
       -- `actual_end_at = CASE WHEN $3 IN ('completed','cancelled') THEN COALESCE(actual_end_at, NOW()) …`).
       -- A case that is pre-start again has not ended, so the stamp goes. It is
       -- also load-bearing, not just tidy: migration 482's
       -- cath_lab_cases_actual_time_check is
       -- `actual_end_at IS NULL OR actual_start_at IS NULL OR actual_end_at >= actual_start_at`.
       -- For a case cancelled BEFORE it ever started the reopen itself passes
       -- that check (actual_start_at IS NULL) — but the next startCaseTx sets
       -- actual_start_at = COALESCE(actual_start_at, NOW()), which lands AFTER
       -- the stale actual_end_at, and Postgres raises 23514 on a start the user
       -- has every right to make. Clearing it here is what keeps the door from
       -- opening onto a wall.
       actual_end_at = NULL,
       updated_by = $3::uuid,
       updated_at = NOW()
 WHERE tenant_id = $1::uuid
   AND id = $2::bigint
 RETURNING *
```

**`actual_start_at` is KEPT, deliberately.** A case that started, was cancelled mid-procedure and is reopened keeps its true first start instant; `startCaseTx`'s `actual_start_at = COALESCE(actual_start_at, NOW())` then preserves it rather than overwriting it, so the record still says when the patient first went on the table. `metadata.readiness_at_start` from the earlier start is likewise left in place and is overwritten by the next start's snapshot (the `||` merge of §4.2 step 6), which is the wanted behaviour: the snapshot describes the start the case is currently living under, and the audit rows carry the history.

5. Canonical event `cath_lab.case_reopened`, `eventStatus: 'readiness_pending'`, `sourceTable: 'cath_lab_cases'`, `payload: { status: 'readiness_pending', reason, previous_status: 'cancelled' }`, `beforeState: { status: 'cancelled' }`, `afterState: { status: 'readiness_pending' }`; then `updateCaseCanonicalRefs`. Without it a reopen would leave no trace on the timeline, which is the same defect §4.2 step 7 fixes for the procedure-record start.
6. `recordReadinessAudit(tx, { action: 'cath_lab.case.reopened', resource: 'cath_lab_cases', resourceId: caseId, context, metadata })` — **always**, not conditionally: the audit row *is* the decision. `metadata`:

```json
{
  "case_id": 1201,
  "facility_id": 4,
  "reason": "Patient crashed post-cancellation, taken to the lab",
  "previous_status": "cancelled",
  "cancelled_at": "2026-09-06T03:58:11.004Z",
  "cancel_reason": "List overran, patient returned to ward",
  "urgency": "emergency"
}
```

`actor_uid` / `role` are the person who reopened, from `context`, exactly as every other readiness audit row. Two of these keys need their provenance stated, because neither is a column:

- **`cancelled_at` is `cath_lab_cases.actual_end_at` as it stood before step 4 cleared it.** There is no `cancelled_at` column on `cath_lab_cases` (verified); `actual_end_at` is what cancelling stamps, and it is the instant the cancellation was recorded.
- **`cancel_reason` is not stored on the case row either** (verified: `transitionCaseStatus` puts the cancel reason on the canonical `cath_lab.case_cancelled` event's `payload.reason` and in the `cancelWorkflowSla` metadata; no column holds it). The implementation reads it from the most recent canonical `cath_lab.case_cancelled` event for the case and writes `null` when there is none — a case cancelled before that event existed, or cancelled without a reason. It is recorded because "what was this cancelled for" is the first question anyone reviewing a reopen asks; it is `null`-tolerant because it is a convenience, not the record.

**Roles.** The **same role set that may cancel a case**, named from `cathLabRoutes.js`: cancelling is `POST /cases/:id/status` with `{ status: 'cancelled' }`, guarded by `requireCathWorkflow` (`roleGuard(canUseCathWorkflow, 'Cath-lab workflow access is required', 'CATH_LAB_WORKFLOW_FORBIDDEN')`) over **`CATH_LAB_WORKFLOW_ROLES`** (`roleHelpers.js`: the doctor tiers, `SENIOR_DOCTOR`, `CATH_LAB_STAFF`, `CATH_LAB_INCHARGE`, `NURSING_STAFF`, `ADMIN`, `SUPER_ADMIN`) plus `guardCathCaseById` for the facility/case scope. The reopen route carries **exactly that chain and no more** — no second signature, no narrower list. This follows owner decision 3 / §3 decision 4 in kind: whoever may end a case may reopen one, and the reason plus the audit row are the controls. Widening or narrowing it is an owner question, not an implementation choice.

**Route.**

```js
router.post(
  '/cases/:id/reopen',
  requireCathWorkflow,
  guardCathCaseById,
  requireIdempotencyKey({ required: true, scope: 'cath_lab_case_reopen' }),
  handler   // body: { reason }  →  { case: <the reopened case row> }
);
```

The guard order mirrors the readiness write routes (`/readiness/order-missing`, `/readiness/external`, `/readiness/waive`), which is the platform's existing shape for a guarded, idempotent cath write. `Idempotency-Key` is **required**, scope `cath_lab_case_reopen`: a replayed reopen must answer the original response rather than the transition error the case would now raise from `readiness_pending` (or from `in_progress`, if the team has since started it) — see §2's idempotency bullet. The route is registered on the cath mount only; there is no governance-mount twin (a reopen is a clinical workflow act, not a governance read).

**Staff.** A **"Reopen case"** action on a cancelled case's card (key `cath-readiness-reopen`), visible when `readiness.caseStatus == 'cancelled'`, opening the existing `_CathReadinessConfirmDialog` with `reasonRequired: true` and the notes label `reopen_reason`; on confirm it posts through `CathLabApiService.reopenCase(caseId, reason: …)` with a fresh idempotency key and reloads. After the reload the case is `readiness_pending` (or `ready`) and the ordinary **start** affordance of §4.4 appears — including its consent gate, so a reopened case still cannot start without consent recorded as `pass`. The dialog body says what the action does in one line: the case returns to the pre-procedure checklist and can then be started. The start row (§4.4) is not shown while the case is `cancelled` (`startable` is false), so the two affordances never appear together.

**The monthly report is untouched.** §7 counts *starts* with checks pending and queries the single action `cath_lab.case.started_with_readiness_pending`. A reopened case that is then started writes an ordinary start row like any other, so it is already in the report; `cath_lab.case.reopened` is a separate action and is deliberately **not** folded into that query. If the owner later wants a reopen count, it is the same one-line query against the other action — a follow-up, not this lane.

**Accepted consequences, stated rather than discovered:**

- **The workflow SLA instance stays cancelled.** Cancelling calls `cancelWorkflowSla` (`transitionCaseStatus`, `target === 'cancelled'`); the reopen does **not** restart or resurrect it. The clock on the original booking genuinely ended, and inventing a new one would misreport the SLA. The reopen audit row is the record of the second attempt.
- **`refreshOpenCasesForPatient` picks the case back up** the moment it leaves `cancelled` (its predicate is `status NOT IN ('completed','cancelled')` after §5.1), so the checklist starts living again by construction. Nothing extra is needed and nothing is scheduled by the reopen itself.
- **A reopened-then-cancelled-again case can be reopened again.** The door is not one-shot; each pass writes its own audit row. That is deliberate — a limit would be a restriction the owner's principle does not ask for — and the audit trail makes a pattern of it visible.

**Tests** (unit, deep and Staff) are listed in §12 with the rest; the three mutations that prove this section are §12 mutations 13–15.

## 5. The checklist keeps living after start

### 5.1 Lab events reach started cases

`refreshOpenCasesForPatient`: `WHERE status NOT IN ('completed', 'cancelled')` — the `actual_start_at IS NULL` predicate and the three-status list go. A result filed or signed off mid-procedure now reaches the item rows through the same post-commit scheduler (`cathLabReadinessHooks.js`) as before start.

### 5.2 Check-level rule after start — stated in words, then in code

**Before start, nothing changes.** Plan 3's rule stands in full: automation passes the `labs` check when every required item is available, and retracts a pass it made when one goes missing — including when it goes missing by age. An old potassium is exactly what the pre-cath checklist exists to catch. This regime gets its own test, and that test is in the mutation list (below), because it is the regime this lane is *not* changing.

**After start:**

- **NEW EVIDENCE always applies, better or worse.** A value arriving mid-procedure (in-house sign-off through the hook, an outside result through the checklist, a late order's result) makes its item available and the auto-pass branch may pass the check — after start as before it, marked by `completed_at > actual_start_at` and `passed_after_start: true` on the `cath_lab.readiness.labs.auto_pass` audit row. A critical or abnormal value arriving mid-procedure sets `critical_warning` / `critical_items` and rewrites `live_evidence` exactly as it would before start (the refresh writes them on every pass that changes them, in both regimes), Staff shows it as a red banner on the checklist, and the check reflects it truthfully. It does not flip the status: a critical value never blocks (Plan 3, owner decision), before or after start.
- **STALENESS alone never flips the check.** When the case has started and the only reason a required item is missing is that its value has aged past the window (`state === 'stale'`), the retraction branch does nothing. Age is noise mid-procedure: the team acted on the value it had. The item itself still reads `stale` in the picture — the picture is truthful; only the check's status is held.
- **Any other reason to retract still retracts.** After start the only non-staleness routes to `missing` are a tenant policy edit mid-procedure (a newly required item nobody ordered) and, once the OBX-11 retraction follow-up lands, a retracted result that leaves the item with nothing — both are new information and the check may say so. (Lifting a waiver after start is refused by #1018, so it is not a route.)
- **The case status and the gate are untouched** either way: `recomputeCaseStatusTx` rewrites only pre-start statuses (§5.5). Started is a fact; nobody is told to stop.

Plan 3's as-built note on `7dd54906b` ("a readiness claim stamped after the procedure it existed to gate") is superseded by the principle for the *improve* branch: a pass after start is not a claim about the pre-procedure gate, it is the record that the value became available — and it is marked as such.

**Regime scoping, in code** (`computeCheckDecision`, rules module):

```js
const started = Boolean(caseRow?.actual_start_at);
// POST-START ONLY: a value that has merely aged since the team acted on it is
// not a reason to move the check. Gated strictly on actual_start_at; before
// start, staleness retracts exactly as Plan 3 built it.
const agedOnly = started && missing.length > 0 && missing.every((row) => row.state === 'stale');
if (missing.length === 0) {
  // Both regimes.
  if (settings.auto_pass === true && (status === 'pending' || (status === 'pass' && autoManaged))) {
    nextStatus = status === 'pass' ? null : 'pass';
  }
} else if (status === 'pass' && autoManaged && !agedOnly) {
  nextStatus = 'pending';
  autoPendingReason = pendingReasonFor(missing);
}
```

**The pair of tests, and the mutation that proves the scope:**

- *Pre-start, stale evidence STILL flips the auto-managed `labs` check pass → pending* (unit: `computeCheckDecision` with `caseRow.actual_start_at = null`, one required item `stale`, check auto-managed pass → `nextStatus: 'pending'`; deep: the existing "a value going stale flips an auto-managed pass back to pending before start" half of `cath-lab-readiness.deep.test.js`, kept and named).
- *Post-start, stale age alone does NOT flip it* (unit: same items with `actual_start_at` set → `nextStatus: null`; deep: the started half of the same test, now also asserting the item reads `stale` while the check stays `pass`).
- *Post-start, a mid-procedure critical result → `critical_warning: true`, the item named in `critical_items`, the check status unchanged* (deep), and Staff shows the banner (widget test).
- *Post-start, a non-stale missing item still retracts* (unit: `started`, missing `[{ hb: 'stale' }, { hcv: 'not_ordered' }]` → `'pending'`).
- **Mutation**: delete `started &&` from `agedOnly` so the suppression applies in both regimes → the **pre-start** staleness test (unit and deep) goes red and **only it**; if it stays green the suppression was never scoped. Both tests are named in the mutation list (§12).

If, while building, the code cannot keep both halves — staleness suppressed *and* new evidence applied — it is an owner question raised through dev-1b, never a silent choice in either direction.

### 5.3 Late actions

- `orderMissingLabs`: the `case_started` refusal is deleted. Priority becomes `STAT` whenever the case has started (`orderPriorityForUrgency(urgency, { started: true })` → `'STAT'`): a draw for a patient on the table is by definition urgent, whatever the case's booked urgency. The order note says so; the `cath_lab.readiness.labs.orders_placed` audit row gains `ordered_after_start: true`.
- `recordExternalLabResult`: the `actual_start_at` refusal is deleted; the `CATH_LAB_EXTERNAL_RESULT_RECORDED` audit row gains `recorded_after_start` (the brief's word for it; on the item the same fact is `resulted_after_start`, because an outside value is a result row and its "recorded here" instant is `lab_results.received_at`).
- Waive / un-waive: #1018's record-yes / lift-no; untouched.
- `CATH_LAB_READINESS_CASE_STARTED`: decision 9. Task 0 of the plan settles which branch applies at the #1018 head; the OpenAPI source pin (`cathLabReadinessOpenApiSource.test.js`, which compares the overlay's `ERROR_CODES` to the throw sites in both directions) makes either outcome mechanical.

### 5.4 Lateness markers (derived, inside the resolver)

#1018 threads `caseStartedAt` into `resolveItemState` and computes `recorded_after_start` for a waiver with a private `waivedAfterStart(waivedAt, caseStartedAt)`. This lane generalises the helper and adds two keys to `base` and to the branches:

```js
// Was an instant (ms since the epoch) after the case's actual_start_at?
function afterCaseStartMs(ms, caseStartedAt) {
  if (!caseStartedAt) return false;
  const startedMs = toMs(caseStartedAt);
  if (!Number.isFinite(ms) || !Number.isFinite(startedMs)) return false;
  return ms > startedMs;
}
function waivedAfterStart(waivedAt, caseStartedAt) { return afterCaseStartMs(toMs(waivedAt), caseStartedAt); }
```

- `base` gains `ordered_after_start: false, resulted_after_start: false` (beside `recorded_after_start: false`).
- The order pointer gains `ordered_after_start: afterCaseStartMs(instantMs(openOrder, 'requested_at'), caseStartedAt)`.
- The fresh-result branch and the stale branch set `resulted_after_start: afterCaseStartMs(instantMs(row, 'received_at'), caseStartedAt)` — the row's `received_at_epoch_ms` twin is already selected by the refresh.
- `caseRowTx` also selects `(EXTRACT(EPOCH FROM actual_start_at) * 1000)::bigint AS actual_start_at_epoch_ms` and the refresh passes `caseStartedAt: cathCase.actual_start_at_epoch_ms ?? cathCase.actual_start_at`, so the start instant is compared to the order and result twins as an absolute value (the house rule of `check-timestamptz-clock-comparisons.mjs`). The waiver comparison stays as #1018 wrote it: `waived_at` comes back off the stored row as a driver Date and Prisma sessions are pinned to UTC.
- Meaning: `ordered_after_start` — the in-flight order the item points at was placed after start; `resulted_after_start` — the record that decides the item's state for `result_final` / `result_preliminary` / `external_recorded` / `stale` was received here after start; `recorded_after_start` (#1018) — the waiver was documented after start. `false` for `not_ordered`, for the two awaiting states on the result key, and for every item of a case that has not started.
- **`*_after_start` semantics = transaction-start ordering.** `actual_start_at` is written as `NOW()`, `lab_results.received_at` defaults to `now()`, `investigations.requested_at` defaults to `now()`, `cath_case_lab_readiness_items.waived_at` is written as `NOW()`: every one of these is `transaction_timestamp()`, the start of the writing transaction. "After start" therefore means "the transaction that wrote it began after the transaction that started the case", at millisecond resolution; two writes in the same millisecond compare equal and answer `false`. Said once, here; the deep tests order their fixtures explicitly (as #1018's late-waiver test does) rather than racing the clock.
- Not persisted on the item table (`itemWriteValues` / `storedItemMatches` ignore them, as they ignore `recorded_after_start`); they ride into `metadata.live_evidence`, so the first refresh after deploy rewrites each `labs` check row once.
- The OpenAPI pin derives the item key set by driving `resolveItemState` on all four branches, so the two new keys reach the contract by construction; the overlay's `required` list is edited to match.

### 5.5 Case status after start

`recomputeCaseStatusTx` runs after an automation flip and already rewrites only pre-start statuses; an `in_progress` case keeps its status while its `labs` check row and items update. Pinned by a deep test (start with labs pending → sign-off → item `result_final`, check `pass`, case still `in_progress`). The statement still bumps `updated_at` on the case; pre-existing, left alone.

## 6. The readiness picture shows lateness

### 6.1 `CathLabReadiness` (the `lab_readiness` block and `GET …/readiness/labs`)

Two new top-level keys (thirteen in all):

```json
"case_started": true,
"started_with_readiness_pending": true,
"readiness_at_start": {
  "recorded_at": "2026-09-06T04:31:07.412Z",
  "via": "status",
  "procedure_log_id": null,
  "urgency": "emergency",
  "reason": "Primary PCI, outside reports awaited",
  "blocking": [{ "check_type": "labs", "reason": "pending" }, { "check_type": "timeout", "reason": "pending" }],
  "missing_lab_items": ["hcv"],
  "lab_snapshot_as_of": "2026-09-06T04:31:05.001Z"
}
```

`readiness_at_start` is `null` for a case that has not started and for a case started before this lane shipped (no snapshot). `started_with_readiness_pending` is derived: `blocking.length > 0`, never stored separately (one source of truth). A clean start writes a snapshot with `blocking: []` so "started clean" and "no snapshot" are distinguishable. `blocking` can never name `consent` (§4.3). Every item gains `ordered_after_start` and `resulted_after_start` beside #1018's `recorded_after_start` (booleans, always present). `case_started`'s description changes: nothing on this surface is refused after it except lifting a waiver (#1018).

### 6.2 Day list

`lab_readiness_summary` gains exactly one key, `started_with_readiness_pending` (boolean), read in the same `listCases` statement as `CASE WHEN jsonb_typeof(c.metadata->'readiness_at_start'->'blocking') = 'array' THEN jsonb_array_length(c.metadata->'readiness_at_start'->'blocking') > 0 ELSE FALSE END` and folded into the summary in JS — the list row's own key set does not change, and the raw `metadata` column is **not** selected (it would carry the reason text to the day list unprojected). The summary stays `null` for a case whose readiness was never resolved; a started-with-pending case always has item rows because the start refreshes first (§4.5) — if that best-effort refresh failed and nobody ever opened the case, the flag is visible on the case detail and not on the list. Documented, accepted.

### 6.3 Staff

- **Banner** on the checklist (key `cath-readiness-started-pending-banner`) when `lab_readiness.started_with_readiness_pending`: "Started with checks pending: Labs (HCV), Time-out" and, for entitled roles, "Reason: …". Amber, not red: it is a fact about the record, not an alarm.
- **Critical banner** (key `cath-readiness-critical-banner`) when `case_started && critical_warning`: red, "Critical value on file during this procedure: {items}" (or the unnamed form when `critical_items` is empty for the role). Decision 7's "displays prominently".
- **Header chip** on the case card (key `cath-readiness-header-started-pending`), from the loaded block when present, else from the list summary — the same precedence `_headerSignals` already applies.
- **"After start" chips**: on an item row when `ordered_after_start || resulted_after_start` (key `cath-lab-item-after-start-<item>`; #1018's waiver chip `cath-lab-waived-after-start-<item>` stays as it is); on a check row when `completed_at > actual_start_at` (key `cath-readiness-check-after-start-<check_type>`, text "Recorded after start").
- **The panel's two remaining write gates lose `!labs.caseStarted`**: order-missing and outside result (#1018 already opened waive; un-waive stays closed after start per #1018). The order button's label does not change; the server makes the order STAT.
- The start row (§4.4) with its consent-disabled state; the consent-type chooser (§4.3).
- **The reopen row** (key `cath-readiness-reopen`) on a `cancelled` case, with its mandatory-reason dialog (§4.8). It replaces the start row rather than sitting beside it: `startable` is false while the case is cancelled, so exactly one of the two is ever on screen.
- Strings in all five locales with the `// REVIEW: AI first-pass` marker on the four non-English ones, pending OPEN-21.

### 6.4 Role projection and the canary

None of the new keys is serology: check types, item **codes**, booleans and timestamps are the checklist, which the front desk is admitted for (the same reasoning as `missing[]` today, and the same reasoning #1018 recorded for `recorded_after_start` in the projection's header). The one exception is `readiness_at_start.reason`: free text typed at the table, which could name a value ("HBsAg reactive, proceeding"). `cathLabReadinessProjection.projectLabReadinessForRole` blanks it (key kept, `null`) for roles outside `roleSeesSerologyDetail` — the same predicate, deliberately not a second list. `projectReadinessChecksForRole` is unaffected (the snapshot does not live on a check row). The audit row and the canonical event are privileged surfaces and are not projected. The report's `reason` column is projected by the same predicate (§7.4).

Canary additions, following the reprocessable-devices section's population / liveness discipline (a poisoned fixture, a positive control that an entitled role reads it, a liveness check that a non-entitled reachable role reads the *shape* and not the value):

- The case fixture carries a poisoned snapshot whose `reason` is a second sentinel (`START-REASON-SENTINEL-…`); `CASE_ROW` also carries the `readiness_at_start` / `started_with_readiness_pending` / `actual_start_at_epoch_ms` **aliases** the new SELECT expressions produce, because the prisma stub answers by column name.
- `disclosures()` additionally fails any non-entitled 2xx body whose serialisation contains the reason sentinel or whose `readiness_at_start.reason` / report row `reason` is non-null.
- **Positive control**: `CATH_LAB_STAFF` reads the reason sentinel, `started_with_readiness_pending: true`, `blocking` naming `labs`, `missing_lab_items: ['hbsag']` and the three item booleans. **Liveness**: a non-entitled reachable role (RECEPTIONIST, on `GET …/readiness/labs`) reads `started_with_readiness_pending: true`, the same `blocking` and `missing_lab_items` codes, `reason: null`, and boolean `ordered_after_start` / `resulted_after_start` / `recorded_after_start` on every item — entitled sees, non-entitled sees booleans and codes, never values.
- The day-list summary key-set assertion (canary and deep) gains `started_with_readiness_pending`.
- The reachable snapshot **changes by exactly two entries** — the two report GETs (§7.5). Any other difference is a defect to investigate, not a snapshot to regenerate.

## 7. Monthly report — starts with checks pending

### 7.1 Endpoint

`GET /api/v1/cath-lab/reports/starts-with-pending?month=YYYY-MM[&format=csv]`, and the same handler at `GET /api/v1/cath-reprocessing/reports/starts-with-pending` (§1, prefix-mount lockout; `cathDeviceHistoryHandler` is the precedent for one handler on both mounts). `month` is required and must match `^\d{4}-(0[1-9]|1[0-2])$`, else 400 `CATH_LAB_REPORT_MONTH_INVALID`. The month is the ward's calendar month — **IST** (`Asia/Kolkata`), the convention `clinicalDate()` and the day list already use. `audit_logs.created_at` is `timestamp(6)` without time zone written by `NOW()` under UTC-pinned sessions, so the bound is `(a.created_at AT TIME ZONE 'UTC') >= $2::timestamptz AND (a.created_at AT TIME ZONE 'UTC') < $3::timestamptz` with `$2` = `YYYY-MM-01T00:00:00+05:30` and `$3` = the first of the next month — said here, once, and again in the SQL's comment.

**Route order matters on the cath router**: `router.get('/reports/:id', …)` already exists and would capture `starts-with-pending` as an id; the new route is registered **before** it.

### 7.2 Query (no new table, no index)

`cathStartsWithPendingReportService.startsWithPendingReport({ tenantId, month })`:

```sql
SELECT a.id, a.created_at AS started_at, a.actor_uid, a.role AS actor_role, u.name AS actor_name,
       a.resource_id AS case_id, a.metadata,
       f.id AS facility_id, f.display_name AS facility_name
  FROM audit_logs a
  LEFT JOIN facilities f
    ON f.tenant_id = a.tenant_id
   AND f.id = NULLIF(a.metadata->>'facility_id', '')::int
  LEFT JOIN users u
    ON u.tenant_id = a.tenant_id
   AND u.uid = a.actor_uid
 WHERE a.tenant_id = $1::uuid
   AND a.action = 'cath_lab.case.started_with_readiness_pending'
   AND (a.created_at AT TIME ZONE 'UTC') >= $2::timestamptz
   AND (a.created_at AT TIME ZONE 'UTC') <  $3::timestamptz
 ORDER BY a.created_at DESC, a.id DESC
```

`idx_audit_logs_tenant_time_id` `(tenant_id, created_at DESC, id DESC)` and the `action` index already exist; a month of one tenant's cath starts is at most hundreds of rows. Migration 767 is not needed for this and is not claimed.

### 7.3 Response

```json
{
  "month": "2026-09",
  "total": 3,
  "facilities": [{ "facility_id": 4, "facility_name": "Main block", "count": 2 }, { "facility_id": 7, "facility_name": "Annexe", "count": 1 }],
  "rows": [{
    "case_id": 1201, "facility_id": 4, "facility_name": "Main block",
    "urgency": "emergency", "via": "status", "started_at": "2026-09-06T04:31:07.412Z",
    "blocking_check_types": ["labs", "timeout"], "missing_lab_items": ["hcv"],
    "reason": "Primary PCI, outside reports awaited",
    "actor_uid": "…", "actor_role": "CONSULTANT", "actor_name": "Dr …"
  }]
}
```

`format=csv` answers `text/csv; charset=utf-8` with `Content-Disposition: attachment; filename="cath-starts-with-pending-2026-09.csv"`, built with `rowsToCsv` from `src/utils/csv.js` (formula-injection safe): columns `month, facility_id, facility_name, case_id, urgency, via, started_at, blocking_check_types, missing_lab_items, reason, actor_uid, actor_role, actor_name`; the two list columns are `;`-joined.

### 7.4 Role gate and projection

`CATH_READINESS_REPORT_ROLES = [ROLES.ADMIN, 'SUPER_ADMIN', ROLES.CATH_LAB_INCHARGE, ROLES.QUALITY_OFFICER]` and `canReadCathReadinessReport(role)` in `roleHelpers.js`, beside `CATH_REPORT_*` / `CATH_LAB_WORKFLOW_ROLES` — the brief's ADMIN / QUALITY / cath-lab manager named from the platform's existing role vocabulary (`CATH_LAB_INCHARGE` is the cath lab's manager role; there is no `CATH_LAB_MANAGER`). Both registrations carry `requireRole(...CATH_READINESS_REPORT_ROLES)` at route level. On the cath mount the mount gate refuses QUALITY_OFFICER first — which is the whole reason the governance registration exists; on the governance mount the route gate removes INFECTION_CONTROL_OFFICER, whom the mount admits for device reuse.

`reason` is projected by `roleSeesSerologyDetail`: ADMIN and CATH_LAB_INCHARGE read it; QUALITY_OFFICER (outside `CLINICAL_STAFF_ROUTE_ROLES`, hence outside the canary's entitled allow-list) reads `null` — the pattern (counts, urgency, check types, codes, actor, time) is the quality officer's view; the free-text line is the clinical audience's. The CSV is projected identically. The report carries no patient identifier — case ids are internal keys — so neither mount needs the per-patient access rows `cathDeviceHistoryHandler` writes; the cath mount's `phiAccessLogger` records its usual request row.

### 7.5 Canary and OpenAPI

- The canary walks both new GETs. `serologyDisclosureCanary.reachable.json` gains exactly two entries: `GET /api/v1/cath-lab/reports/starts-with-pending → [ADMIN, CATH_LAB_INCHARGE, SUPER_ADMIN]` and `GET /api/v1/cath-reprocessing/reports/starts-with-pending → [ADMIN, QUALITY_OFFICER, SUPER_ADMIN]`; the regeneration (`CANARY_WRITE_SNAPSHOT=1`, which fails deliberately after writing) is run once and its diff read. The `audit_logs` fixture carries one start row whose `reason` is the reason sentinel and whose `missing_lab_items` is `['hbsag']`; positive control ADMIN reads the sentinel, liveness QUALITY_OFFICER (governance mount) reads the row with `reason: null` and the codes.
- OpenAPI overlay (`cathLabReadiness.mjs`): `CathLabStartsWithPendingReport` / `…Response` schemas; two operations (one per mount) with the `month` and `format` query parameters, the JSON and `text/csv` 200 contents and the 400 in prose; the source pin's operation list gains them under `READS`.

### 7.6 Admin surface

A fifth tab on `dashboard/quality/cath` — **"Starts with checks pending"** (`StartsWithPendingTab.tsx`): a month picker (default: current IST month), the per-facility counts, the rows table, and a "Download CSV" button; reads the governance-mount path (`CATH_LAB_STARTS_WITH_PENDING_PATH = "/api/v1/cath-reprocessing/reports/starts-with-pending"`) through `getCathStartsWithPendingReport(month)` / `downloadCathStartsWithPendingCsv(month)` in `lib/api/cathDevices.ts`, exactly as the lab-readiness settings tab reads its mount. The admin console's audience is ADMIN; the same page already talks to that mount.

## 8. Data model — no migration

### 8.1 Why nothing is added (columns verified)

- `cath_lab_cases.metadata JSONB NOT NULL DEFAULT '{}'` exists (`schema.prisma`; migration 482). It is written by `createCase` from `input.metadata`, by `stemiPathwayService` at create, and by **no** `UPDATE` anywhere (writers of `UPDATE cath_lab_cases`: `cathLabService.js` status / readiness recompute / canonical refs, `cathLabReadinessService.js` status, `cathSchedulingRegistryService.js` planned times and room, `stemiPathwayService.js` canonical refs — none sets `metadata`). The snapshot is merged in with `||`, so a caller's own keys survive.
- Every instant the markers need already exists: `cath_case_lab_readiness_items.ordered_at` and `waived_at` (migration 766); `lab_results.received_at` (`NOT NULL DEFAULT now()`); `investigations.requested_at` (`NOT NULL DEFAULT now()`, naive UTC — read through its `_epoch_ms` twin as the refresh already does); `cath_lab_cases.actual_start_at`; `cath_lab_readiness_checks.completed_at`. `external_recorded_at` does not exist and is not needed — an outside value's "recorded here" instant is its `lab_results.received_at`.
- The report reads `audit_logs` (`tenant_id`, `action`, `created_at`, `actor_uid`, `role`, `resource_id`, `metadata` — all present) under existing indexes (§7.2).
- **The reopen door (decision 13, §4.8) needs no migration either, and this is the reason it was shaped that way.** Its target status `readiness_pending` is already one of the seven `cath_lab_cases_status_check` permits (migration 482), so the CHECK is untouched and no status vocabulary anywhere — day-list filters, OpenAPI enums, Staff labels — gains a value. Its two writes are to columns that exist: `status`, and `actual_end_at` set back to `NULL` (nullable; migration 482's `cath_lab_cases_actual_time_check` is satisfied by a NULL on either side). Its record is an `audit_logs` row under a new `action` string, which is data, not schema. A `reopened` status of its own would have needed all of that — the CHECK widened, every vocabulary edited — which is exactly why it was not chosen.
- **Migration 767 is free** on every `github/*` branch as of 2026-09-06 (all top at `766_cath_lab_readiness.sql`; `fix/inf-006-release-authority` is stale at 724). It is **not** claimed by this lane. If a later volume finding wants a partial index for the report — `(tenant_id, created_at) WHERE action = 'cath_lab.case.started_with_readiness_pending'` — that is a one-line follow-up migration, numbered against every open branch at push time under the immutability rules.

### 8.2 The snapshot (rules module, pure)

```js
export const START_SNAPSHOT_KEYS = Object.freeze([
  'recorded_at', 'via', 'procedure_log_id', 'urgency', 'reason',
  'blocking', 'missing_lab_items', 'lab_snapshot_as_of',
]);
export const START_VIAS = Object.freeze(['status', 'procedure_log']);
export function buildStartSnapshot({ via, procedureLogId = null, urgency = null, reason = null, blocking = [], missingLabItems = [], labSnapshotAsOf = null, now = new Date() })
export function normalizeStartSnapshot(raw)        // object with exactly START_SNAPSHOT_KEYS, or null
export function startedWithReadinessPending(raw)   // Array.isArray(raw?.blocking) && raw.blocking.length > 0
export function missingLabItemCodes(items, settings) // required && !isItemAvailable, in ITEM_CODES order, deduplicated
```

`blocking` entries are `{ check_type, reason }` exactly as `evaluateReadinessGate` emits them.

### 8.3 Reserved keys at create

`createCase` strips `readiness_at_start` from `input.metadata` (`CASE_START_METADATA_KEYS`), the same discipline as `AUTOMATION_METADATA_KEYS` on the check row: a client must not be able to mint a start snapshot on a case that has not started.

### 8.4 Reads

`caseRowTx` (readiness service) selects `metadata->'readiness_at_start' AS readiness_at_start` and the `actual_start_at_epoch_ms` twin — the JSON path, never the whole column. `caseById` (cathLabService) is **not** widened: `getCase` spreads it into the response, and a raw `metadata` there would be a second, unprojected copy of the reason text. `transitionCaseStatus` already answers `RETURNING *` (metadata included) to the workflow roles, all of which are inside the entitled allow-list.

## 9. Error handling and idempotency

| Code | HTTP | When |
|---|---|---|
| `CATH_LAB_CONSENT_REQUIRED` | 400 | Either start path while the `consent` check is not `pass`. `details.consent_status` (`pending` / `fail` / `waived` / `not_applicable` / `missing`) and `details.blocking`. Raised by `assertReadinessComplete`, reached only through `startCaseTx`. |
| `CATH_LAB_START_REASON_REQUIRED` | 400 | `POST /cases/:id/status` with `status: in_progress`, gate not clear, `reason` empty. `details.blocking` names the checks. |
| `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED` | 409 | `POST /cases/:id/procedure-logs` on a `cancelled` case, raised before the log row is written (decision 13, §4.2). The message names the door — "reopen the case first" — and `details: { case_status: 'cancelled', reopen_path: '/api/v1/cath-lab/cases/:id/reopen' }`. 409, not 400: the request is well-formed and the state is the objection, and it is the code a client can branch on to offer the reopen action. |
| `CATH_LAB_REOPEN_REASON_REQUIRED` | 400 | `POST /cases/:id/reopen` with an empty `reason` (§4.8). Nothing is written. No exemption on any path: a reopen is the exceptional act itself. |
| `INVALID_STATE_TRANSITION` (`AppError.invalidTransition`) | 400 | `in_progress` from `requested` / `completed` / `cancelled` / `in_progress`, as today — from `cancelled` the error now carries `allowed: ['readiness_pending']`, which is itself the pointer to the reopen door. Also `POST /cases/:id/reopen` on a case that is not `cancelled` (`allowed` = that status's real targets). |
| `CATH_LAB_REPORT_MONTH_INVALID` | 400 | The report without a `month`, or one that is not `YYYY-MM`. |
| `CATH_LAB_READINESS_BLOCKED` | — | **Removed** with the full gate. |
| `CATH_LAB_READINESS_CASE_STARTED` | 409 | Decision 9: kept with one thrower (`unwaiveLabItem`, #1018 lift-no) or removed with its last thrower — settled in Task 0. |

None of the five new codes is prefixed `CATH_LAB_READINESS_`, deliberately: the readiness overlay's error-code pin scans the three readiness modules and the cath router for that prefix, and these codes belong to operations the overlay documents in prose (the status route, the procedure-log route, the reopen route, the report). Idempotency: the status route keeps claiming no key (§2); the one new scope is `cath_lab_case_reopen` on `POST /cases/:id/reopen` (§4.8).

## 10. Owner items — all recorded, none open

### 10.1 Recorded decisions (2026-09-06) — settled, not questions

The items the first draft listed for the owner are answered and are recorded here as decisions, not questions:

1. **Second signature / role restriction on "Start anyway" — NO.** Any `CATH_LAB_WORKFLOW_ROLES` member may start; one reason line, the audit row and the snapshot are the controls (decision 4).
2. **Monthly report of starts-with-pending — YES**, as §7: endpoint on both mounts, CSV, Admin tab, audit-log-backed, `CATH_READINESS_REPORT_ROLES`.
3. **Alert when consent is pending at start — MOOT.** Consent pending cannot start (decision 1); there is nothing to alert on.
4. **The procedure record on a cancelled case — REFUSE, BUT GIVE IT A DOOR.** Answered by the owner on 2026-09-06 and carried in the design proper as **decision 13** (§3) and **§4.8**. This was the one item that blocked implementation Task 2; it no longer does.

   The owner's words: recording a procedure must not silently resurrect a cancelled case — **the refusal stands** — and it cannot be a dead end: the state change must be **"deliberate, auditable, and nothing stranded"**, a decision someone makes and the audit trail records, not a side effect of writing a procedure log.

   The shape adopted, on the merge authority's steer: **a distinct audited transition into a startable state, not a parallel record path.** `reopenCaseTx` moves `cancelled → readiness_pending` with a mandatory reason and its own audit action; the procedure log on a cancelled case answers 409 `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED` naming that route.

   **Why the parallel record path was rejected.** The alternative on the table was a "performed after cancellation" path that writes the procedure log and an audit row and leaves the case `cancelled` — no status write, no `actual_start_at`, no `startCaseTx`, and therefore the cheapest thing to build. It was rejected because it buys that cheapness by creating **a second shape a performed procedure can have**: a started case with an at-start snapshot, or a cancelled case with a log, no snapshot and no start instant. Every reader would then have to learn the second shape — the day list, the timeline, the monthly report's audit query, Staff — and consent would never have been asserted on that path at all, so the record would carry a consent status rather than a consent block. The door instead keeps **one start path, one snapshot, one consent block**, which is the whole architecture of this lane (decision 2), and it costs no migration because `readiness_pending` already exists.

Also settled, not open: the principle applies to every urgency (decision 4); #1018's record-yes / lift-no is the baseline (§2); consent `pass` only, with emergency / relative consent as a typed pass (decision 1). One named default a reviewer should see in the PR body — `requested` not start-eligible (decision 3) — is a consequence of the one-start-path design, not a readiness restriction, and is not raised as an owner item.

## 11. Client scope

**Staff (Flutter).** Models (`cath_readiness_models.dart`): `CathReadinessCheck.completedAt` and `.metadata['consent_type']`; `CathLabReadinessItem.orderedAfterStart` / `.resultedAfterStart` (beside #1018's `recordedAfterStart`); `CathLabReadiness.startedWithReadinessPending` / `.readinessAtStart` (`CathReadinessStartSnapshot`: recordedAt, via, urgency, reason, blocking, missingLabItems); `CathReadinessBlocking { checkType, reason }`; `CathCaseReadiness.caseStatus` / `.actualStartAt` / `.blocking` / `.started` / `.startable` / `.consentPassed`; `CathLabReadinessSummary.startedWithReadinessPending`. API (`cath_lab_api_service.dart`): `startCase(int caseId, { String? reason })` and `reopenCase(int caseId, { required String reason })` (the latter sends an `Idempotency-Key`; §4.8). Checklist (`cath_readiness_checklist.dart`): `CathReadinessDependencies.startCase` and `.reopenCase`; the start row with its consent-disabled state; the reopen row on a cancelled case with its mandatory-reason dialog; the two banners; the consent-type chooser; check-row "Recorded after start" chip. Panel (`cath_lab_readiness_panel.dart`): order-missing and outside-result gates lose `caseStarted`; item "After start" chip. Screen (`cath_lab_screen.dart`): header chip. Strings: 23 keys × 5 locales (19 for the start/lateness picture, 4 for the reopen door); `i18n_guard_test.dart` pins them and that `start_anyway_body`, `started_pending_banner` and `critical_banner` keep their `{checks}` / `{items}` placeholder in every locale.

**Admin (Next.js).** `dashboard/quality/cath/components/StartsWithPendingTab.tsx`; `lib/api/cathDevices.ts` gains the path constant and the two functions; `page.tsx` gains the tab; test `__tests__/dashboard/quality/cath-starts-with-pending.test.tsx`.

## 12. Testing and gates

**Unit** — `cathLabService.test.js`: `START_ELIGIBLE_STATUSES` equals `['scheduled','readiness_pending','ready']`; `validateCaseTransition` accepts `scheduled|readiness_pending → in_progress`, refuses `requested|completed → in_progress`; consent pending → `CATH_LAB_CONSENT_REQUIRED` on both paths with no UPDATE issued; consent waived → refused; reason required on the status path (400, `details.blocking`, no UPDATE); snapshot shape (the bound JSON has exactly `START_SNAPSHOT_KEYS`; `via`, `urgency`, `blocking`, `missing_lab_items` as expected; `blocking` never names consent because consent is pass by then); canonical event payload; `recordReadinessAudit` called only when blocking is non-empty and with `facility_id`; `recordProcedureLog` on `scheduled` starts via `procedure_log` with `procedure_log_id` and no `start_reason`; on `completed` / `in_progress` issues no case UPDATE; on `cancelled` throws 409 `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED` **before** the log insert, with `details.reopen_path` naming the reopen route (decision 13); `createCase` strips the reserved key. **`reopenCaseTx` (§4.8)**: `CASE_TRANSITIONS.cancelled` equals `[REOPEN_TARGET_STATUS]` and `REOPENABLE_STATUSES` equals `['cancelled']`; reopen with an empty reason → 400 `CATH_LAB_REOPEN_REASON_REQUIRED` with **no** `UPDATE cath_lab_cases` issued and no audit call; reopen with a reason → the bound UPDATE matches `/status = 'readiness_pending'/` **and** `/actual_end_at = NULL/`, does **not** match `/actual_start_at/`, and `recordReadinessAudit` is called exactly once with `action: 'cath_lab.case.reopened'` and metadata carrying `reason`, `previous_status: 'cancelled'`, `cancelled_at` (the pre-clear `actual_end_at`), `facility_id` and `urgency`; reopen of a non-`cancelled` case → `INVALID_STATE_TRANSITION` with that status's real `allowed`. `cathLabStartPathPin.test.js`: seven pins (§4.3) — six textual (the two caller counts, the SQL-shape counts inside `cath_lab_cases` literals with their pinned line count of 2, the **five**-pair `SET status =` allow-list now including `reopenCaseTx`, the single-writer assertion on the `status = 'readiness_pending'` literal, and the absent `CATH_LAB_READINESS_BLOCKED`) and one on the imported value (`CASE_TRANSITIONS.cancelled` deep-equals `['readiness_pending']` while `START_ELIGIBLE_STATUSES` excludes `cancelled`) — the one place this otherwise-textual file imports from the service, deliberately limited to those two names. `cathLabReadinessService.test.js`: `computeCheckDecision` regime table — pre-start stale → `pending`; post-start stale-only → `null`; post-start stale + not_ordered → `pending`; post-start all available + pending → `pass`; human pass untouched in both regimes; `resolveItemState` marker table (not started; order before/after; result received before/after via the epoch twin; stale after; awaiting → result key false; waiver unchanged); `buildStartSnapshot` / `normalizeStartSnapshot` / `startedWithReadinessPending` / `missingLabItemCodes`; `orderPriorityForUrgency('elective', { started: true }) === 'STAT'`. `cathLabReadinessServiceOrders.test.js`: order-missing on a started case places STAT orders and audits `ordered_after_start: true`; the outside-result refusal test inverted. `cathStartsWithPendingReportService.test.js`: month validation, IST bounds, per-facility fold, CSV columns and escaping, reason projection by role. `cathLabReadinessOpenApiSource.test.js`: item key set (automatic via the resolver), readiness key set, `readiness_at_start` keys equal `START_SNAPSHOT_KEYS`, `blocking[].check_type` enum equals migration 482's type CHECK, `ERROR_CODES` per decision 9, the status, procedure-log **and reopen** operations in `PROSE_ONLY`, the two report operations in `READS`, day-list prose names `started_with_readiness_pending`. `cathLabReadinessProjection.test.js`: reason blanked for a non-entitled role, kept for an entitled one, key set unchanged, `null` snapshot passes through. `cathLabRouteGuards.test.js`: the cached-409 probe re-targeted only if decision 9 removes `CASE_STARTED`. `roleHelpers` test: `CATH_READINESS_REPORT_ROLES` exactly the four.

**Deep** (`cath-lab-readiness.deep.test.js`, own tenant, new cases seeded per test so #1018's late-waiver test keeps its fixture): the consent trio per path (§4.3); start with pending → 400 without reason, then `in_progress` with snapshot + audit row (with `urgency`, `facility_id`) + `started_with_readiness_pending` on the block and on the day list; after start a real sign-off reaches the item through the hook, the check improves to `pass` with `completed_at > actual_start_at` and `passed_after_start: true` on the audit, the case stays `in_progress`; **the regime pair** (§5.2) — pre-start stale still flips, post-start stale age alone does not, item reads `stale` while the check holds; mid-procedure critical result → `critical_warning: true`, named, status unchanged; late order (STAT, `ordered_after_start`) and late outside result (`resulted_after_start`) accepted and marked; clean start → empty `blocking`, no audit row; procedure-record start produces the same snapshot with `via: 'procedure_log'`; a log on a `completed` case leaves it completed; **the reopen door end to end (decision 13, §4.8)** — a log on a `cancelled` case answers 409 `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED` naming the reopen route and writes **no** `cath_procedure_logs` row; `POST /cases/:id/reopen` without a reason answers 400 `CATH_LAB_REOPEN_REASON_REQUIRED` and the case is still `cancelled`; with a reason the case reads `readiness_pending`, `actual_end_at IS NULL`, `actual_start_at` **preserved** when the case had started before it was cancelled (and still `NULL` when it had not), with the `cath_lab.case.reopened` audit row carrying the reason; a replay of the reopen under the same `Idempotency-Key` answers the original response and writes no second audit row; after the reopen a start via `startCaseTx` obeys the consent gate — consent pending → 400 `CATH_LAB_CONSENT_REQUIRED` and the case stays pre-start; consent `pass` with labs pending → the case starts with the pending snapshot, the start audit row, and `actual_start_at` equal to the preserved original where there was one; the report for the month returns the started case under its facility with `reason` present for ADMIN and null for QUALITY_OFFICER, and the CSV has one data row. `cath-reporting.deep.test.js`: unchanged, run.

**Staff widget tests** (`cath_readiness_checklist_test.dart`, `cath_lab_screen_test.dart`): consent not pass → start row disabled with the consent line and nothing posted; consent pass + gate clear → "Start procedure" posts without a reason; consent pass + gate pending → "Start anyway" names the checks and refuses an empty reason, then posts the reason; a started-with-pending case shows the amber banner and the after-start chips and now offers order / outside result (inverting #1018's "keeps the order and outside-result actions closed"); a started case with `critical_warning` shows the red banner; a clean start shows no banner; the header chip renders from the list summary; the consent-type chooser writes `metadata.consent_type`; **a cancelled case shows the "Reopen case" row and no start row, refuses an empty reason, then posts the reason through `reopenCase`, and a non-cancelled case shows no reopen row**; model parsing of every new key.

**Admin tests**: the tab renders counts and rows for a month, changes month, calls the CSV download, shows the projected-null reason as "—".

**Canary**: §6.4 and §7.5 (fixture poison, `disclosures()` extension, positive control, liveness, summary key set, snapshot diff of exactly two entries).

**Mutation checks** (each: apply, run the named test, confirm red, revert):

1. Delete `started &&` from `agedOnly` in `computeCheckDecision` → the **pre-start** staleness unit test (`'pre-start: a stale required item still retracts an auto-managed pass'`) and the pre-start half of the deep staleness test go red; the post-start tests stay green. If the pre-start test stays green, the suppression was never scoped.
2. Delete `!agedOnly` from the retraction branch → the post-start unit test (`'post-start: staleness alone never retracts'`) red.
3. Change `consent.status !== 'pass'` to `!READINESS_CLEAR_STATES.includes(consent.status)` → the consent-waived deep tests (both paths) red.
4. Move the `assertReadinessComplete` call from `startCaseTx` into `transitionCaseStatus` only → `cathLabStartPathPin.test.js` red (caller count) and the procedure-log consent deep test red (hazard ii, reproduced).
5. Delete `via === 'status'` from the reason guard → the procedure-log deep/unit test ("no reason, still starts") red.
6. Delete the reason blanking in `projectLabReadinessForRole` → canary's non-entitled reason assertion red.
7. Restore `AND actual_start_at IS NULL` in `refreshOpenCasesForPatient` → the sign-off-after-start deep test red.
8. Drop `started_with_readiness_pending` from the summary fold → canary summary key set and the day-list deep assertion red.
9. Make `afterCaseStartMs` return `false` → the late-order deep test and the resolver marker table red.
10. Delete `CASE_START_METADATA_KEYS` stripping in `createCase` → the reserved-key unit test red.
11. Register the report route after `/reports/:id` on the cath router → the report deep test (cath mount) red with a 400/404 from the report guard.
12. Add a stray `UPDATE cath_lab_cases SET actual_start_at = NOW()` in another service (a fourth start path that calls none of this lane's functions) → `cathLabStartPathPin.test.js` red on the SQL-shape assertion. The two caller counts stay green, which is the point of the third pin: it is the only one that would have caught it.
13. **Delete the `cancelled` refusal in `recordProcedureLog`** (let the log fall through to the insert) → the procedure-log-on-cancelled tests red, unit *and* deep. This is the mutation that proves the refusal half of decision 13 is real and not merely described: without it a procedure log silently lands on a cancelled case again.
14. **Make `reopenCaseTx` set `status = 'in_progress'`** (with `actual_start_at = COALESCE(actual_start_at, NOW())`) instead of `readiness_pending` → `cathLabStartPathPin.test.js` red on the **start-path** SQL assertion (three matching lines in two functions, not two in `startCaseTx`), and the `status = 'readiness_pending'` single-writer assertion red as well. The door must lead to a startable state, not do the starting; this is the mutation that proves it.
15. **Drop `actual_end_at = NULL` from the reopen UPDATE** → the reopen deep test red with Postgres **23514** on `cath_lab_cases_actual_time_check`. Read where it fires: for a case cancelled **before** it ever started, the reopen itself still passes (`actual_start_at IS NULL` satisfies the CHECK) and the violation lands on the *next* `startCaseTx`, whose `actual_start_at = COALESCE(actual_start_at, NOW())` is later than the stale `actual_end_at`. A test that only reopens and asserts the status would stay green, which is why the deep test reopens **and then starts**.

**Gates** (Plan 3 Task 7 / Plan 2 Task 8 as template): backend lint; the **full** unit corpus (not the readiness suites alone); **two fresh-DB deep runs** of `cath-lab-readiness.deep|cath-reporting.deep|lab-signoff-safety.deep|bloodborne-markers.deep` on a scratch database created for each run; `openapi:check` (regenerates `src/docs/openapi.json` and the `vhhealth_core` mirror); `check:migration-numbers` and `check:migration-immutability` (no-ops here, run anyway); schema drift (no-op); `scripts/ci/security.mjs`; Flutter analyze + `flutter test` for the cath_lab and i18n suites; Admin lint + jest for the quality tests; the canary with the snapshot diff inspected (exactly two new entries); the mutation list above; a final `[full-ci]` commit; **draft PR only**, handed to the merge authority (dev-1b) with both gates — `Merge Gate` and `Full Merge Gate` — named from the tier-verifying poller (the canonical run, not `gh run watch`). Read `Suites failed` separately from `Tests passed`.

## 13. Rollout and compatibility

- Cases already `in_progress` when this ships have no snapshot: `readiness_at_start: null`, `started_with_readiness_pending: false`, no banner; their checklists start living immediately (the hook predicate is status-based).
- The first refresh of every case after deploy rewrites its `labs` check row once (`live_evidence` gains two booleans per item); no backfill.
- Clients that read `case_started` as "writes are refused" (the Staff panel's two remaining gates) are updated in the same lane; no other client reads it.
- The generated OpenAPI document changes in `CathLabReadinessItem`, `CathLabReadiness`, the two report operations, the day-list prose, the **three** prose-only case operations (status, procedure-logs, and the new reopen) and (per decision 9) two operations' 409 lists.
- **Cases already `cancelled` when this ships gain the door retroactively**, with no backfill and nothing to migrate: the reopen reads the case row as it stands. Two of them will read a little thin — `cancelled_at` is whatever `actual_end_at` holds (`NULL` if the case was cancelled before that stamp existed), and `cancel_reason` is `null` when no canonical `cath_lab.case_cancelled` event carries one. Both are recorded as `null` rather than guessed.
- The reachable snapshot changes by exactly two entries — the two report **GET**s. `POST /cases/:id/reopen` is a write and the canary's reachable snapshot is per-GET, so the door adds nothing to it; the canary's write mirror covers the reopen response, which is a case row answered to workflow roles, all of which are inside the entitled allow-list.

## 14. Risks accepted

- **An emergency start is one tap and one line away for the whole workflow audience.** Owner decision B; the reason, the audit row and the monthly report are the controls.
- **A required reason is friction in the moment.** The dialog is a single field; the procedure-record path needs none.
- **The day-list flag can lag the case detail** in the failed-pre-start-refresh edge (§6.2).
- **A check passed after start looks like any other pass on surfaces that do not read `completed_at` against `actual_start_at`** (the day list's `readiness_cleared` count). The Staff card marks it; the audit row marks it; the count does not. A client may supply `completed_at` on a human check, so the check-row chip is as honest as the client that wrote the row; the labs auto-pass stamps `NOW()` and the audit row is authoritative.
- **The start reason is free text** and reaches every entitled role on the readiness block and the report; it is blanked for the rest. Same class as `waive_reason`, which is not blanked today — a follow-up may align them.
- **A tenant policy edit mid-procedure can retract the labs check** (§5.2, "any other reason"). Rare, truthful, and gates nothing once started.
- **The quality officer's report has no reason column.** By the projection rule; the clinical audience's export has it.
- **`cancelled` is no longer terminal, and the whole workflow audience can reopen** (§4.8). The controls are the mandatory reason, the `cath_lab.case.reopened` audit row and the consent block that still stands between the reopened case and its start. Two consequences are accepted rather than engineered around: the workflow SLA instance stays cancelled (the original booking's clock genuinely ended), and a case may be reopened more than once. Any reader that treated `cancelled` as "this row will never change again" has to be re-read — the audit of that assumption is a named step in the plan's Task 0.

## 15. Conflicts with #1018, and how this lane reconciles

1. **#1018's final shape.** This lane is written against record-yes / lift-no. Task 0 diffs the #1018 head against `856efef7c` and confirms: `unwaiveLabItem` refuses after start (with which code), `waiveLabItem` does not, `recorded_after_start` on the item and on the waive audit, and whether `lifted_after_start` exists. Decision 9 follows from the answer. If the head has moved elsewhere, re-run the ledger in §16 first.
2. **`CATH_LAB_READINESS_CASE_STARTED` citations** (decision 9, branch "removed"): `ERROR_CODES` in `cathLabReadiness.mjs`, the two 409 responses, the `case_started` description, the route-guard probe (`cathLabRouteGuards.test.js`, which drives that code as its deterministic-409 example — re-target to `CATH_LAB_CASE_FACILITY_MISMATCH`, a real deterministic 409 on the cath router, and rewrite its comment), the unwaive route comment in `cathLabRoutes.js`. Branch "kept": only the `case_started` description and the two operations' 409 lists change (order-missing and external-result no longer raise it; unwaive still does).
3. **`recorded_after_start` is #1018's and stays #1018's.** This lane's result marker is `resulted_after_start`, its order marker `ordered_after_start`; the item carries three booleans with three meanings.
4. **`resolveItemState`'s `caseStartedAt`.** #1018 passes the driver Date; this lane passes the epoch twin when present (§5.4). #1018's `waivedAfterStart` becomes a one-line wrapper over the shared `afterCaseStartMs`; its unit and deep tests keep passing unchanged.
5. **Staff panel gates.** #1018 opened waive (and closed un-waive after start); this lane opens order-missing and outside result, and adds the item chips beside #1018's waiver chip (different keys, different strings). #1018's test "a started case still offers the waiver, and keeps the order and outside-result actions closed" is inverted for the second half.
6. **`cathLabService` imports.** The service already imports `ITEM_CODES` / `isItemAvailable` from the rules module directly; this lane adds `buildStartSnapshot` / `missingLabItemCodes` beside them and `recordReadinessAudit` from the facade — the unit suite's facade mock gains that one `jest.fn()`.
7. **OpenAPI regeneration** touches the same `openapi.json` regions #1018 touches; regenerate after rebase, never hand-merge.
8. **RESOLVED — not a #1018 conflict, and no longer an open item.** The procedure record on a `cancelled` case was the one open owner question; the owner answered it on 2026-09-06 (*refuse, but give it a door*) and it is now **decision 13** (§3, §4.8, §10.1 item 4). Nothing about it gates plan Task 2, there is no `REFUSE_PROCEDURE_LOG_ON_CANCELLED` flag and no TODO-owner marker to carry, and the PR body records it under "Decided: reopen door" rather than under open items. What remains is ordinary implementation: the refusal (409 `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED`) and the door (`reopenCaseTx`, `POST /cases/:id/reopen`) land together in Task 2, and neither is shippable without the other.

## 16. Verification ledger (re-verify at build time; cite by function name)

| Claim | Where |
|---|---|
| `CASE_TRANSITIONS`; `in_progress` only from `ready` | `cathLabService.js` — `CASE_TRANSITIONS` |
| `READINESS_TYPES` (8), `READINESS_CLEAR_STATES` | `cathLabService.js` |
| `evaluateReadinessGate` builds `blocking[]` | `cathLabService.js` — `evaluateReadinessGate` |
| `assertReadinessComplete` → `CATH_LAB_READINESS_BLOCKED`; exactly two callers | `cathLabService.js` — `assertReadinessComplete`; callers `transitionCaseStatus`, `recordProcedureLog` |
| Procedure-record force start (after the gate) | `cathLabService.js` — `recordProcedureLog`, the `cathCase.status !== 'in_progress'` UPDATE |
| `transitionCaseStatus` canonical event name `cath_lab.case_${target}` | `cathLabService.js` — `transitionCaseStatus` |
| `recomputeCaseStatusTx` pre-start-only rewrite; inlined `READINESS_CHECK_TYPES` | `cathLabReadinessService.js` — `recomputeCaseStatusTx` |
| `updateReadinessCheck` pre-start-only rewrite; client-supplied `completed_at` | `cathLabService.js` — `updateReadinessCheck` |
| `refreshOpenCasesForPatient` predicate | `cathLabReadinessService.js` — `refreshOpenCasesForPatient` |
| `caseRowTx` SELECT (add JSON path + epoch twin here) | `cathLabReadinessService.js` — `caseRowTx` |
| Refresh passes `caseStartedAt`; selects `received_at_epoch_ms`; writes critical metadata in both regimes | `cathLabReadinessService.js` — `refreshCaseLabReadiness` |
| `computeCheckDecision` `!started` on both branches | `cathLabReadinessRules.js` — `computeCheckDecision` |
| `resolveItemState` signature with `caseStartedAt`; `base.recorded_after_start`; waiver branch; `waivedAfterStart` | `cathLabReadinessRules.js` |
| `orderMissingLabs` refusal; `orderPriorityForUrgency` | `cathLabReadinessActions.js` |
| `recordExternalLabResult` refusal | `cathLabReadinessActions.js` — `recordExternalLabResult` |
| `isAfterCaseStart`; waive / un-waive after start (#1018 final shape) | `cathLabReadinessActions.js` — `waiveLabItem`, `unwaiveLabItem` |
| `recordReadinessAudit` (audit_logs writer: tenant_id, uid, role, action, resource, resource_id, metadata, actor_uid, created_at) | `cathLabReadinessService.js` — `recordReadinessAudit` |
| `labReadinessSummaries` (day list); `listCases` selects explicit columns, not `metadata` | `cathLabService.js` — `labReadinessSummaries`, `listCases` |
| `createCase` metadata from input; seeds eight pending checks | `cathLabService.js` — `createCase` |
| `cath_lab_cases.metadata` never UPDATEd | grep `UPDATE cath_lab_cases` across `apps/backend/src` |
| The SQL-shape pin's baseline: the 8 `UPDATE cath_lab_cases` literals in shipping code, and which 4 assign `status` (`startCaseTx` after this lane; `transitionCaseStatus`; `updateReadinessCheck`; `recomputeCaseStatusTx`) | grep `UPDATE cath_lab_cases` and `SET status` across `apps/backend/src` excluding `tests/` |
| `status = 'in_progress'` / `actual_start_at =` are ordinary text on OTHER tables (so the pin must scope to `cath_lab_cases` literals) | `dialysisService.js` (`dialysis_sessions`), `housekeepingController.js`, `taskService.js`, `medicationReconciliationService.js` |
| `cath_lab_cases_status_check` pins the seven statuses — **`readiness_pending` is one of them, so decision 13 needs no migration**; `cath_lab_cases_actual_time_check` is `actual_end_at IS NULL OR actual_start_at IS NULL OR actual_end_at >= actual_start_at`; cancelling stamps `actual_end_at` | migration `482_cath_lab_cases_readiness.sql`; `cathLabService.js` — `transitionCaseStatus`'s `actual_end_at = CASE WHEN $3 IN ('completed','cancelled') …` (§4.8 clears it on reopen for exactly this reason) |
| No `cancelled_at` and no `cancel_reason` column on `cath_lab_cases`; the cancel reason lives on the canonical `cath_lab.case_cancelled` event's `payload.reason` and in the `cancelWorkflowSla` metadata | `prisma/schema.prisma` — `cath_lab_cases`; `cathLabService.js` — `transitionCaseStatus`'s `writeCanonicalEvent` payload and its `target === 'cancelled'` SLA branch (§4.8's audit-metadata provenance) |
| The cancel path's guard chain = the reopen's role set: `POST /cases/:id/status` is `requireCathWorkflow` + `guardCathCaseById`; `requireCathWorkflow` = `roleGuard(canUseCathWorkflow, …, 'CATH_LAB_WORKFLOW_FORBIDDEN')` over `CATH_LAB_WORKFLOW_ROLES` | `routes/clinical/cathLabRoutes.js` — `requireCathWorkflow`, the status route; `utils/roleHelpers.js` — `CATH_LAB_WORKFLOW_ROLES`, `canUseCathWorkflow` |
| The guarded-idempotent cath write shape the reopen route copies (`requireCathWorkflow`, `guardCathCaseById`, `requireIdempotencyKey({ required: true, scope })`) | `routes/clinical/cathLabRoutes.js` — the `/readiness/order-missing`, `/readiness/external`, `/readiness/waive` registrations |
| `writeCanonicalEvent` takes a free-form `eventType` (no enum, no CHECK) — confirm `recordCanonicalClinicalEvent`'s own vocabulary admits `cath_lab.case_reopened` before writing it | `cathLabService.js` — `writeCanonicalEvent`; the canonical-event writer it delegates to |
| Readers that assume `cancelled` is terminal (decision 13 makes it not) — re-read each before Task 2 | grep `'cancelled'` across `apps/backend/src/services/clinical/`, `apps/staff/lib/features/cath_lab/`, `apps/admin/src`; known today: `refreshOpenCasesForPatient`'s `NOT IN ('completed','cancelled')` (correct by construction), `CATH_CONSUMABLE_WASTAGE_STATUSES` (unaffected), `cancelWorkflowSla` (accepted, §14) |
| `lab_results.received_at NOT NULL DEFAULT now()`; `investigations.requested_at DEFAULT now()`; `cath_case_lab_readiness_items.ordered_at / waived_at` | `prisma/schema.prisma`; migration 766 |
| STEMI creates the case `readiness_pending` / `emergency`; never starts it; strips lab evidence | `stemiPathwayService.js` — the `INSERT INTO cath_lab_cases`, `readinessWithoutLabEvidence` |
| Canary `disclosures()`, summary key set, reachable snapshot, write mirror, `ENTITLED_ALLOW_LIST` (no QUALITY_OFFICER) | `serologyDisclosureCanary.test.js`; `fixtures/serologyDisclosureCanary.reachable.json` |
| `roleSeesSerologyDetail` = `CLINICAL_STAFF_ROUTE_ROLES` | `cathDeviceReuseService.js` |
| `CATH_LAB_ROUTE_ROLES` (no QUALITY_OFFICER); `CATH_REPROCESSING_POLICY_ROUTE_ROLES` | `config/routeRolePolicy.js`; mounts in `app.js` |
| One handler on two mounts precedent | `routes/clinical/cathDeviceHistoryHandler.js`; `cathReprocessingPolicyRoutes.js` |
| `router.get('/reports/:id', …)` precedes any static `/reports/*` | `routes/clinical/cathLabRoutes.js` |
| Workflow roles ⊂ entitled allow-list | `roleHelpers.js` — `CATH_LAB_WORKFLOW_ROLES` vs canary `ENTITLED_ALLOW_LIST` |
| Generic `Success` on the four case routes; `RETURNING *` on the status route | `src/docs/openapi.json`; `cathLabService.js` — `transitionCaseStatus` |
| No Staff/Admin client of the status or procedure-log routes | grep under `apps/staff/lib`, `apps/admin/src` |
| `ERROR_CODES`, item `required`, `case_started` description, 409s; source pin scans three readiness modules + router for `CATH_LAB_READINESS_*` | `scripts/openapi/schemas/cathLabReadiness.mjs`; `cathLabReadinessOpenApiSource.test.js` |
| `rowsToCsv` / `escapeCsvField` | `src/utils/csv.js` |
| `audit_logs` indexes `(tenant_id, created_at DESC, id DESC)`, `(action)`; `created_at` is `timestamp(6)` without zone | `prisma/schema.prisma` — `audit_logs` |
| Migration 767 free on every branch | `git ls-tree` over `refs/remotes/github/*` on `apps/backend/src/migrations/` |
