# Cath Readiness Never Restricts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pre-cath readiness checklist inform and record instead of restrict: any `scheduled` / `readiness_pending` / `ready` case may start with checks pending (consent is the one hard block), the checklist keeps living after start with lateness marked, and a monthly report of starts-with-pending exists — per the owner decisions of 2026-09-06.

**Architecture:** One start function (`startCaseTx`) behind the two existing start paths, asserting consent and writing an at-start snapshot to `cath_lab_cases.metadata` plus an `audit_logs` row; the pure rules module gains a post-start regime (staleness suppressed, new evidence applied) and two derived lateness markers; the three post-start refusals are lifted; one report handler over the audit rows is registered on the cath mount and the governance mount; Staff gains the start affordance and the lateness picture; Admin gains a report tab. No migration.

**Tech Stack:** Node 26 ESM backend (Express 5, Prisma raw SQL on Postgres 17, jest with `--experimental-vm-modules`), Flutter Staff app, Next.js Admin console, OpenAPI overlay scripts.

**Spec:** `docs/superpowers/specs/2026-09-06-cath-readiness-never-restricts-design.md` (read it first; section numbers below are its).

**One thing is open, and it gates Task 2:** spec **§10.2**, what a procedure log does to a **cancelled** case. `cancelled` is terminal, so the proposed refusal closes the only existing door and needs a companion the owner must choose. Task 0 Step 6 holds the gate and the code for both companions.

---

## Conventions

All of Plan 3's conventions apply (tenant transactions, raw SQL, `AppError`, npm-run jest, immutable migrations, scratch DB, commit trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`, `[full-ci]` on the last commit, draft PR, no merge — merge authority is dev-1b). Plus:

- **Build on #1018.** Branch from `github/feat/cath-readiness-followups` if #1018 has not merged when you start, else from `github/main`. Task 0 verifies #1018's final shape before any code.
- **Cite by function name.** Line numbers in the spec and here are illustrative; grep the function.
- **Never widen the picture with a value.** Every new payload key is a boolean, a check type, an item code or a timestamp; the one free-text field (`reason`) is projected through `roleSeesSerologyDetail`.
- **Post-start suppression is gated on `actual_start_at` and nothing else.** The pre-start staleness test is in the mutation list because it is the regime this lane is *not* changing.
- **Fixtures with `<col>_at` carry `<col>_at_epoch_ms`** (`epochTwinFixtureFidelity.test.js`), derived from the same instant.
- **No `git stash`, no `git restore`; commit with pathspecs.**
- Backend commands run from `apps/backend`; `npm test -- --testPathPatterns <pattern>`; deep suites need `DATABASE_URL`.

---

## File structure

| File | Responsibility |
|---|---|
| Modify `apps/backend/src/services/clinical/cathLabReadinessRules.js` | Regime-scoped `computeCheckDecision`; `afterCaseStartMs`; `ordered_after_start` / `resulted_after_start`; start-snapshot helpers (`START_SNAPSHOT_KEYS`, `buildStartSnapshot`, `normalizeStartSnapshot`, `startedWithReadinessPending`, `missingLabItemCodes`). |
| Modify `apps/backend/src/services/clinical/cathLabService.js` | `CASE_TRANSITIONS` + `START_ELIGIBLE_STATUSES`; `assertReadinessComplete` → consent-only; `startCaseTx`; both callers rewired; `createCase` reserved-key strip; day-list summary flag. |
| Modify `apps/backend/src/services/clinical/cathLabReadinessService.js` | `caseRowTx` selects the snapshot path + epoch twin; refresh passes the twin, returns the two new keys, audits `passed_after_start`; `refreshOpenCasesForPatient` predicate; facade re-exports. |
| Modify `apps/backend/src/services/clinical/cathLabReadinessActions.js` | Lift the two refusals; STAT after start; audit keys. |
| Modify `apps/backend/src/services/clinical/cathLabReadinessProjection.js` | Blank `readiness_at_start.reason` for non-entitled roles; export `projectStartReasonForRole`. |
| Create `apps/backend/src/services/clinical/cathStartsWithPendingReportService.js` | Month validation, query, per-facility fold, CSV, projection. |
| Create `apps/backend/src/routes/clinical/cathStartsWithPendingReportHandler.js` | One handler, registered on both mounts. |
| Modify `apps/backend/src/routes/clinical/cathLabRoutes.js`, `cathReprocessingPolicyRoutes.js` | Register the report route (before `/reports/:id` on the cath router). |
| Modify `apps/backend/src/utils/roleHelpers.js` | `CATH_READINESS_REPORT_ROLES`, `canReadCathReadinessReport`. |
| Modify `apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs` | Item + readiness keys; report schemas and operations; prose-only status / procedure-log operations. |
| Create `apps/backend/src/tests/unit/cathLabStartPathPin.test.js` | The one-start-path source pin. |
| Create `apps/backend/src/tests/unit/cathStartsWithPendingReportService.test.js` | Report unit tests. |
| Modify unit tests: `cathLabService.test.js`, `cathLabReadinessService.test.js`, `cathLabReadinessServiceOrders.test.js`, `cathLabReadinessOpenApiSource.test.js`, `cathLabReadinessProjection.test.js`, `cathLabRouteGuards.test.js` (decision 9 only), `serologyDisclosureCanary.test.js` (+ `fixtures/serologyDisclosureCanary.reachable.json`) | Per task. |
| Modify `apps/backend/src/tests/cath-lab-readiness.deep.test.js` | Deep coverage. |
| Staff: modify `features/cath_lab/models/cath_readiness_models.dart`, `services/cath_lab_api_service.dart`, `widgets/cath_readiness_checklist.dart`, `widgets/cath_lab_readiness_panel.dart`, `screens/cath_lab_screen.dart`, `l10n/app_strings.dart`; tests `test/features/cath_lab/cath_readiness_checklist_test.dart`, `cath_lab_screen_test.dart`, `test/i18n_guard_test.dart` | Start affordance, banners, chips, gates. |
| Admin: create `dashboard/quality/cath/components/StartsWithPendingTab.tsx`, `__tests__/dashboard/quality/cath-starts-with-pending.test.tsx`; modify `lib/api/cathDevices.ts`, `dashboard/quality/cath/page.tsx` | Report tab. |

---

## Task 0: Branch, worktree, #1018 shape, ledger, the owner gate

**Files:** none (verification only).

> **GATE — do not start Task 2 until owner item spec §10.2 is answered.** What a procedure log does to a **cancelled** case is open, not decided. The refusal Task 2 Step 5 ships is a placeholder behind `REFUSE_PROCEDURE_LOG_ON_CANCELLED`; it must not be handed back as the design. If the owner answers **(i)**, add the transition + reason + audit in **Task 2**. If the owner answers **(ii)**, add the record path in **Task 3**. Both branches are written out in full in **Step 6** below — code, consequent edits and the tests each needs — so the executor implements rather than designs. Tasks 1, 3–8 may proceed while the answer is outstanding; Task 2 may not.

- [ ] **Step 1: Cut the branch in a scratchpad worktree**

```bash
cd "/d/Dev/Projects/VH Health/VH-Health-Platform"
git fetch github '+refs/heads/*:refs/remotes/github/*'
# If #1018 has merged:
BASE=github/main
# Otherwise build on its head:
gh pr view 1018 --json state,headRefOid,mergedAt
# BASE=github/feat/cath-readiness-followups
git worktree add "$SCRATCH/wt/rr-impl" -b feat/cath-readiness-never-restricts "$BASE"
cd "$SCRATCH/wt/rr-impl/apps/backend" && npm ci
```

- [ ] **Step 2: Verify #1018's final shape (record-yes / lift-no) and settle decision 9**

```bash
cd "$SCRATCH/wt/rr-impl/apps/backend"
grep -n "CATH_LAB_READINESS_CASE_STARTED" src/services/clinical/*.js src/routes/clinical/*.js scripts/openapi/schemas/cathLabReadiness.mjs
grep -n "isAfterCaseStart\|recorded_after_start\|lifted_after_start" src/services/clinical/cathLabReadinessActions.js
```

Expected: `waiveLabItem` computes `recorded_after_start` and does not refuse; `unwaiveLabItem` refuses a started case. Write down (a) the code `unwaiveLabItem` raises, (b) whether `CATH_LAB_READINESS_CASE_STARTED` will keep exactly one thrower after Task 3 removes the order-missing and external-result throwers. **Branch KEPT** (one thrower remains): Task 3 Step 6 edits only the two operations' 409 lists and the `case_started` description. **Branch REMOVED** (no thrower remains): Task 3 Step 6 also removes the code from `ERROR_CODES`, the unwaive route comment, and re-targets the route-guard probe. If `unwaiveLabItem` does NOT refuse after start, stop and report to dev-1b before continuing — the spec's baseline (§2, decision 9) does not hold.

- [ ] **Step 3: Re-run the ledger (spec §16)**

For each row, grep the named function and confirm the claim. In particular confirm: `assertReadinessComplete` has exactly two callers; `refreshOpenCasesForPatient` still carries `actual_start_at IS NULL`; `computeCheckDecision` carries `!started` on both branches; `stemiPathwayService` inserts the case as `'readiness_pending'`; `router.get('/reports/:id'` exists in `cathLabRoutes.js`; `CATH_LAB_ROUTE_ROLES` does not include `QUALITY_OFFICER`:

```bash
grep -n "assertReadinessComplete" src/services/clinical/cathLabService.js
grep -n "actual_start_at IS NULL" src/services/clinical/cathLabReadinessService.js
grep -n "!started" src/services/clinical/cathLabReadinessRules.js
grep -n "'readiness_pending'" src/services/clinical/stemiPathwayService.js
grep -n "router.get('/reports/:id'" src/routes/clinical/cathLabRoutes.js
grep -n "QUALITY_OFFICER" src/tests/fixtures/serologyDisclosureCanary.reachable.json | grep cath-lab || echo "no cath-lab GET admits QUALITY_OFFICER (expected)"
```

- [ ] **Step 4: Confirm no migration is needed and 767 is unclaimed**

```bash
cd "$SCRATCH/wt/rr-impl"
for ref in $(git for-each-ref --format='%(refname)' refs/remotes/github/); do
  git ls-tree --name-only "$ref" apps/backend/src/migrations/ 2>/dev/null
done | sed -E 's#.*/([0-9]+)_.*#\1#' | sort -n | uniq | tail -2
grep -nE "ordered_at|waived_at" apps/backend/src/migrations/766_cath_lab_readiness.sql | head -3
grep -nE "received_at +DateTime +@default\(now\(\)\)|requested_at +DateTime +@default\(now\(\)\)" apps/backend/prisma/schema.prisma
```

Expected tail: `765`, `766`. Both timestamp defaults present. This plan claims **no** migration.

- [ ] **Step 5: Create the scratch DB for deep runs**

```bash
createdb -h 127.0.0.1 -p 55432 vh_crr_<initials>
cd "$SCRATCH/wt/rr-impl/apps/backend"
DATABASE_URL="postgresql://…@127.0.0.1:55432/vh_crr_<initials>" npm run test:db:setup
```

- [ ] **Step 6: The owner gate — spec §10.2, the procedure record on a cancelled case**

Confirm with dev-1b that the owner has answered spec §10.2 before starting Task 2. Record the answer here. Verify the dead end still holds before asking:

```bash
grep -n "cancelled: \[\]" src/services/clinical/cathLabService.js     # terminal today
grep -n "cathCase.status !== 'in_progress'" -A 12 src/services/clinical/cathLabService.js | head -16   # today's silent un-cancel
```

**If the answer is "refuse, no companion yet" — STOP and report to dev-1b.** That is a refusal with no in-app alternative and the spec (§1, §10.2) says it is not shippable. Do not proceed on the placeholder.

**If the answer is (i) — reopen through the same start path. Lands in Task 2.**

```js
// cathLabService.js — CASE_TRANSITIONS. §10.2 companion (i): cancelled stops
// being terminal. It is NOT a general un-cancel — the only target is
// in_progress, it is reachable only through startCaseTx, and only with a
// reason. Consent still blocks, because it is the same door.
  cancelled: ['in_progress'],

// START_ELIGIBLE_STATUSES is DERIVED from the table, so `cancelled` becomes
// start-eligible automatically — including on the procedure-log path, which is
// exempt from the pending-gate reason. It must NOT be exempt here: reopening a
// cancelled case is itself the exceptional act, so the reason is mandatory on
// both paths.
const REOPEN_ELIGIBLE_STATUSES = Object.freeze(['cancelled']);

// in startCaseTx, beside the existing CATH_LAB_START_REASON_REQUIRED guard:
const reopening = REOPEN_ELIGIBLE_STATUSES.includes(cathCase.status);
if (reopening && !cleanReason) {
  throw AppError.badRequest(
    'A reason is required to record a procedure on a cancelled case',
    'CATH_LAB_REOPEN_REASON_REQUIRED',
    { case_status: cathCase.status, via }
  );
}

// in startCaseTx's UPDATE — cancelling STAMPS actual_end_at (transitionCaseStatus's
// `actual_end_at = CASE … IN ('completed','cancelled') …`), and migration 482's
// cath_lab_cases_actual_time_check is `actual_end_at >= actual_start_at`. Without
// this line the reopen sets actual_start_at = NOW() after actual_end_at and
// Postgres raises 23514. Bind `reopening` as $5.
            actual_end_at = CASE WHEN $5::boolean THEN NULL ELSE actual_end_at END,

// after the UPDATE, beside the started_with_readiness_pending audit — its own
// action, so the monthly report can tell a reopen from an ordinary start:
if (reopening) {
  await recordReadinessAudit(tx, {
    tenantId: tenantOr(tenantId),
    action: 'cath_lab.case.reopened_for_procedure_record',
    resource: 'cath_lab_cases',
    resourceId: updated.id,
    context,
    metadata: {
      case_id: normalizeDbValue(updated.id),
      facility_id: updated.facility_id ?? null,
      reopened_from: 'cancelled',
      ...snapshot
    }
  });
}
```

Consequent edits (i) — do all of them or the suites disagree: `buildStartSnapshot` gains `reopened_from` (null on an ordinary start) and `START_SNAPSHOT_KEYS` grows by one, which moves `cathLabReadinessOpenApiSource.test.js`'s `readiness_at_start` key-set assertion, the overlay schema, the Staff `CathReadinessStartSnapshot` model and its parse test; spec §4.1's table and §3 decision 3's "`cancelled` … stay impossible" clause; Task 2 Step 1's `START_ELIGIBLE_STATUSES` test (now four statuses) and its cancelled unit test (now a reopen, not a refusal); the deep test "a log on a `cancelled` case writes nothing" is replaced by "a log on a cancelled case with a reason reopens it, with the reopen audit row and `actual_end_at` cleared"; a Staff affordance on a cancelled case (§4.4 gains a fourth state). The start-path pin is **unchanged** — the reopen goes through `startCaseTx`, which is the whole point of (i).

**If the answer is (ii) — a record path that leaves the case cancelled. Lands in Task 3.**

```js
// cathLabService.js. §10.2 companion (ii). The case STAYS cancelled: no status
// write, no actual_start_at, no snapshot, no startCaseTx — and therefore no
// consent block, which is why the audit row carries the consent status as it
// stood rather than asserting it.
const CANCELLED_RECORD_ACTION = 'cath_lab.case.procedure_performed_after_cancellation';

// in recordProcedureLog, replacing the REFUSE_PROCEDURE_LOG_ON_CANCELLED guard.
// The reason guard runs BEFORE the insert so a refusal writes nothing:
const cancelledRecord = cathCase.status === 'cancelled';
const cancelledReason = cleanText(input.start_reason, 500);
if (cancelledRecord && !cancelledReason) {
  throw AppError.badRequest(
    'A reason is required to record a procedure performed on a cancelled case',
    'CATH_LAB_CANCELLED_RECORD_REASON_REQUIRED',
    { case_status: 'cancelled' }
  );
}
… insert the log exactly as for any other status, then …
if (cancelledRecord) {
  const checks = await readinessForCase(tx, tenantId, cathCase.id);
  const consent = checks.find((check) => check.check_type === 'consent');
  await recordReadinessAudit(tx, {
    tenantId: tenantOr(tenantId),
    action: CANCELLED_RECORD_ACTION,
    resource: 'cath_lab_cases',
    resourceId: cathCase.id,
    context,
    metadata: {
      case_id: normalizeDbValue(cathCase.id),
      facility_id: cathCase.facility_id ?? null,
      procedure_log_id: normalizeDbValue(procedure.id),
      urgency: cathCase.urgency ?? null,
      reason: cancelledReason,
      consent_status: consent?.status ?? 'missing'
    }
  });
  // The case is NOT touched: it stays cancelled, actual_start_at stays NULL.
} else if (START_ELIGIBLE_STATUSES.includes(cathCase.status)) {
  await startCaseTx(tx, { … });    // unchanged
}
```

Consequent edits (ii): the transition table, `START_ELIGIBLE_STATUSES` and the start-path pin are **all unchanged** (nothing new writes `status` or `actual_start_at`) — that is (ii)'s cheapness. What grows is the number of shapes a performed procedure can have: the day list, the timeline and Staff must not read "has a procedure log" as "started", the deep test "a log on a `cancelled` case writes nothing" becomes "writes the log and the audit row and leaves the case cancelled", and `CATH_LAB_CANCELLED_RECORD_REASON_REQUIRED` joins spec §9 and the overlay's prose-only procedure-log operation. **Sub-question for the owner if (ii) is chosen:** the monthly report (§7) is *starts* with checks pending, and a cancelled-case record is not a start — keep Task 5's query on the single action and leave the new action out of the report unless the owner asks for it.

---

## Task 1: Pure rules — regime-scoped decision, lateness markers, start snapshot (TDD)

**Files:**
- Modify: `apps/backend/src/services/clinical/cathLabReadinessRules.js`
- Modify: `apps/backend/src/services/clinical/cathLabReadinessService.js` (facade re-exports only)
- Test: `apps/backend/src/tests/unit/cathLabReadinessService.test.js`

- [ ] **Step 1: Write the failing regime tests for `computeCheckDecision`**

Append inside `describe('computeCheckDecision', …)`:

```js
  // Spec §5.2 — the regime pair. The PRE-start test is in the mutation list:
  // it is the regime this lane does not change, and it is what goes red if
  // the post-start suppression is ever applied to both regimes.
  const staleHb = { item_code: 'hb', required: true, state: 'stale' };
  const missingHcv = { item_code: 'hcv', required: true, state: 'not_ordered' };
  const autoPass = { status: 'pass', metadata: { auto_managed: true } };

  test('pre-start: a stale required item still retracts an auto-managed pass', () => {
    const out = computeCheckDecision({
      items: [staleHb], settings, check: autoPass, caseRow: { actual_start_at: null },
    });
    expect(out.nextStatus).toBe('pending');
    expect(out.autoPendingReason).toBe('hb stale');
  });

  test('post-start: staleness alone never retracts', () => {
    const out = computeCheckDecision({
      items: [staleHb], settings, check: autoPass, caseRow: { actual_start_at: AS_OF.toISOString() },
    });
    expect(out.nextStatus).toBeNull();
    // The picture stays truthful: the item is still reported missing.
    expect(out.missing).toEqual([{ item: 'hb', state: 'stale' }]);
  });

  test('post-start: a non-stale missing item still retracts, and names both', () => {
    const out = computeCheckDecision({
      items: [staleHb, missingHcv], settings, check: autoPass, caseRow: { actual_start_at: AS_OF.toISOString() },
    });
    expect(out.nextStatus).toBe('pending');
    expect(out.autoPendingReason).toBe('hb stale; hcv not ordered');
  });

  test('post-start: new evidence completing the set passes a pending check', () => {
    const out = computeCheckDecision({
      items: [{ item_code: 'hb', required: true, state: 'result_final' }],
      settings, check: { status: 'pending', metadata: {} }, caseRow: { actual_start_at: AS_OF.toISOString() },
    });
    expect(out.nextStatus).toBe('pass');
  });

  test('post-start: a critical value is still reported, and does not move the status', () => {
    const out = computeCheckDecision({
      items: [{ item_code: 'potassium', required: true, state: 'result_final', is_critical: true }],
      settings, check: autoPass, caseRow: { actual_start_at: AS_OF.toISOString() },
    });
    expect(out.nextStatus).toBeNull();
    expect(out.criticalWarning).toBe(true);
    expect(out.criticalItems).toEqual(['potassium']);
  });
```

Also **rewrite** the two existing tests that pin the old rule — `'an auto-managed pass flips back to pending when an item goes missing before start, not after'` becomes the pre/post pair above (delete it), and `'a started case is never auto-passed, however complete the items are'` is inverted to `'a started case IS auto-passed once the items are complete (new evidence applies after start)'` asserting `nextStatus: 'pass'`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --testPathPatterns unit/cathLabReadinessService`
Expected: FAIL — `post-start: staleness alone never retracts` gets `'pending'`; `new evidence completing the set` gets `null`.

- [ ] **Step 3: Implement the regime-scoped decision**

Replace the body of `computeCheckDecision` from `const started = …` to the return:

```js
  const started = Boolean(caseRow?.actual_start_at);
  let nextStatus = null;
  let autoPendingReason = null;
  // Spec 2026-09-06 §5.2. BEFORE start Plan 3's rule stands in full: automation
  // passes when every required item is available and retracts a pass it made
  // when one goes missing — by age included; an old potassium is what the
  // pre-cath checklist exists to catch. AFTER start, new evidence always
  // applies (better: the pass branch below is open in both regimes; worse: the
  // critical flags are computed above regardless of regime) but STALENESS
  // ALONE never moves the check — the team acted on the value it had, and the
  // clock moving is noise mid-procedure. The suppression is gated strictly on
  // actual_start_at: delete `started &&` and the pre-start staleness test in
  // cathLabReadinessService.test.js goes red.
  const agedOnly = started && missing.length > 0 && missing.every((row) => row.state === 'stale');
  if (missing.length === 0) {
    if (settings.auto_pass === true && (status === 'pending' || (status === 'pass' && autoManaged))) {
      nextStatus = status === 'pass' ? null : 'pass';
    }
  } else if (status === 'pass' && autoManaged && !agedOnly) {
    // Deliberately not gated on settings.auto_pass: turning auto-pass off stops
    // automation making NEW assertions, but retracting one it already made is a
    // correction, and it moves the gate in the restrictive direction.
    nextStatus = 'pending';
    autoPendingReason = pendingReasonFor(missing);
  }
  return { nextStatus, criticalWarning: criticalItems.length > 0, criticalItems, missing, autoPendingReason };
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- --testPathPatterns unit/cathLabReadinessService`
Expected: PASS.

- [ ] **Step 5: Write the failing marker tests for `resolveItemState`**

Append inside `describe('resolveItemState', …)`:

```js
  describe('lateness markers (spec §5.4)', () => {
    const startedAt = BigInt(AS_OF.getTime() - 3_600_000); // one hour before AS_OF, as the epoch twin
    const resultAt = (offsetMs) => {
      const ms = AS_OF.getTime() + offsetMs;
      return {
        id: 9, test_code: 'K', value_text: '4.1', value_numeric: 4.1, unit: 'mmol/L', abnormal_flag: 'N',
        is_critical: false, status: 'final', result_origin: 'analyzer',
        signed_off_at: new Date(ms).toISOString(), signed_off_at_epoch_ms: BigInt(ms),
        performed_at: new Date(ms).toISOString(), performed_at_epoch_ms: BigInt(ms),
        received_at: new Date(ms).toISOString(), received_at_epoch_ms: BigInt(ms),
      };
    };
    const orderAt = (offsetMs) => {
      const ms = AS_OF.getTime() + offsetMs;
      return { id: 5, test_code: 'ELECTROLYTES', status: 'REQUESTED', requested_at: new Date(ms).toISOString(), requested_at_epoch_ms: BigInt(ms), booking_id: null };
    };

    test('every branch carries both keys, false, when the case has not started', () => {
      for (const args of [{}, { results: [resultAt(-60_000)] }, { orders: [orderAt(-60_000)] }]) {
        expect(resolveItemState({ ...base, ...args })).toMatchObject({ ordered_after_start: false, resulted_after_start: false });
      }
    });

    test('a result received after start is resulted_after_start; before start it is not', () => {
      expect(resolveItemState({ ...base, results: [resultAt(-60_000)], caseStartedAt: startedAt }).resulted_after_start).toBe(true);
      expect(resolveItemState({ ...base, results: [resultAt(-7_200_000)], caseStartedAt: startedAt }).resulted_after_start).toBe(false);
    });

    test('a stale result received after start (a late but already-old outside value) still marks resulted_after_start', () => {
      const old = { ...resultAt(-60_000), performed_at: daysAgo(45), performed_at_epoch_ms: epochAgo(45) };
      const out = resolveItemState({ ...base, results: [old], caseStartedAt: startedAt });
      expect(out.state).toBe('stale');
      expect(out.resulted_after_start).toBe(true);
    });

    test('an order placed after start is ordered_after_start; the result key stays false while awaiting', () => {
      const out = resolveItemState({ ...base, orders: [orderAt(-60_000)], caseStartedAt: startedAt });
      expect(out).toMatchObject({ state: 'ordered_awaiting_sample', ordered_after_start: true, resulted_after_start: false });
      expect(resolveItemState({ ...base, orders: [orderAt(-7_200_000)], caseStartedAt: startedAt }).ordered_after_start).toBe(false);
    });

    test('the epoch twin decides, not the driver Date beside it', () => {
      const row = { ...resultAt(-60_000), received_at: daysAgo(10) }; // Date says long ago, twin says one minute ago
      expect(resolveItemState({ ...base, results: [row], caseStartedAt: startedAt }).resulted_after_start).toBe(true);
    });

    test('an unusable start or instant answers false, never true', () => {
      expect(resolveItemState({ ...base, results: [resultAt(-60_000)], caseStartedAt: 'not-a-date' }).resulted_after_start).toBe(false);
    });

    test('the waiver marker is unchanged by the generalisation', () => {
      const waiver = { waived_by: CTX.actorUid, waived_at: new Date(AS_OF.getTime() - 60_000).toISOString(), waive_reason: 'late' };
      expect(resolveItemState({ ...base, waiver, caseStartedAt: startedAt }).recorded_after_start).toBe(true);
    });
  });
```

- [ ] **Step 6: Run to verify they fail**

Run: `npm test -- --testPathPatterns unit/cathLabReadinessService`
Expected: FAIL — `ordered_after_start` / `resulted_after_start` undefined.

- [ ] **Step 7: Implement the markers**

In `cathLabReadinessRules.js`, replace `waivedAfterStart` with:

```js
// Was an instant (ms since the epoch) after the case's actual_start_at?
//
// Shared by the three lateness markers (spec 2026-09-06 §5.4). False when the
// case has not started, when the instant predates the start, and when either
// side is unusable: each marker is an ASSERTION that something happened late,
// and an unknown is not one. Both sides are transaction_timestamp() values
// (NOW() at start; column defaults on the order / result / waiver rows), so
// "after" is transaction-start ordering at millisecond resolution.
function afterCaseStartMs(ms, caseStartedAt) {
  if (!caseStartedAt) return false;
  const startedMs = toMs(caseStartedAt);
  if (!Number.isFinite(ms) || !Number.isFinite(startedMs)) return false;
  return ms > startedMs;
}

// #1018's waiver-lateness marker, now a wrapper over the shared helper.
function waivedAfterStart(waivedAt, caseStartedAt) {
  return afterCaseStartMs(toMs(waivedAt), caseStartedAt);
}
```

In `resolveItemState`: add to `base` after `recorded_after_start: false,`:

```js
    // Lateness markers for the order and the result that decide this item —
    // present and false on every item for the same additionalProperties reason.
    ordered_after_start: false,
    resulted_after_start: false,
```

In `orderPointer`, add after `ordered_at: …`:

```js
      ordered_after_start: afterCaseStartMs(instantMs(openOrder, 'requested_at'), caseStartedAt),
```

In the `latestFresh` branch add `resulted_after_start: afterCaseStartMs(instantMs(latestFresh, 'received_at'), caseStartedAt),` after `...orderPointer,`; in the `else if (latest)` branch: `resolved = { ...base, ...resultFields(latest), state: 'stale', resulted_after_start: afterCaseStartMs(instantMs(latest, 'received_at'), caseStartedAt) };`. Update the `caseStartedAt` parameter comment to name all three markers.

- [ ] **Step 8: Run to verify they pass**

Run: `npm test -- --testPathPatterns unit/cathLabReadinessService`
Expected: PASS.

- [ ] **Step 9: Write the failing start-snapshot helper tests**

New `describe` in the same file:

```js
describe('start snapshot helpers (spec §8.2)', () => {
  const blocking = [{ check_type: 'labs', reason: 'pending' }, { check_type: 'timeout', reason: 'pending' }];

  test('buildStartSnapshot emits exactly START_SNAPSHOT_KEYS, in order', () => {
    const snap = buildStartSnapshot({ via: 'status', urgency: 'emergency', reason: 'Primary PCI', blocking, missingLabItems: ['hcv', 'hb'], labSnapshotAsOf: AS_OF.toISOString(), now: AS_OF });
    expect(Object.keys(snap)).toEqual([...START_SNAPSHOT_KEYS]);
    expect(snap).toMatchObject({ recorded_at: AS_OF.toISOString(), via: 'status', procedure_log_id: null, urgency: 'emergency', reason: 'Primary PCI', blocking, missing_lab_items: ['hb', 'hcv'], lab_snapshot_as_of: AS_OF.toISOString() });
  });

  test('missing_lab_items is ITEM_CODES-ordered and deduplicated; an unknown via is refused', () => {
    expect(buildStartSnapshot({ via: 'procedure_log', missingLabItems: ['hcv', 'hb', 'hcv'], now: AS_OF }).missing_lab_items).toEqual(['hb', 'hcv']);
    expect(() => buildStartSnapshot({ via: 'elsewhere', now: AS_OF })).toThrow('via');
  });

  test('startedWithReadinessPending is blocking.length > 0 and nothing else', () => {
    expect(startedWithReadinessPending({ blocking })).toBe(true);
    expect(startedWithReadinessPending({ blocking: [] })).toBe(false);
    expect(startedWithReadinessPending(null)).toBe(false);
    expect(startedWithReadinessPending({ blocking: 'labs' })).toBe(false);
  });

  test('normalizeStartSnapshot returns the fixed key set or null', () => {
    expect(normalizeStartSnapshot({ via: 'status', blocking, extra: 1 })).toEqual({
      recorded_at: null, via: 'status', procedure_log_id: null, urgency: null, reason: null,
      blocking, missing_lab_items: [], lab_snapshot_as_of: null,
    });
    expect(normalizeStartSnapshot(undefined)).toBeNull();
    expect(normalizeStartSnapshot('x')).toBeNull();
  });

  test('missingLabItemCodes applies the same availability rule as the day list', () => {
    const items = [
      { item_code: 'hcv', required: true, state: 'not_ordered' },
      { item_code: 'hb', required: true, state: 'stale' },
      { item_code: 'hiv', required: false, state: 'not_ordered' },
      { item_code: 'hbsag', required: true, state: 'external_recorded' },
    ];
    expect(missingLabItemCodes(items, { external_results_count: true })).toEqual(['hb', 'hcv']);
    expect(missingLabItemCodes(items, { external_results_count: false })).toEqual(['hb', 'hbsag', 'hcv']);
  });
});
```

Add `START_SNAPSHOT_KEYS, buildStartSnapshot, normalizeStartSnapshot, startedWithReadinessPending, missingLabItemCodes` to the file's import from the facade.

- [ ] **Step 10: Run to verify they fail**

Run: `npm test -- --testPathPatterns unit/cathLabReadinessService`
Expected: FAIL — not exported.

- [ ] **Step 11: Implement the helpers in the rules module**

```js
// ---------------------------------------------------------------------------
// The at-start snapshot (spec 2026-09-06 §8.2). Pure: codes, booleans, one
// free-text reason (projected before it leaves the server) and two instants.
// Never a lab value.
// ---------------------------------------------------------------------------
export const START_SNAPSHOT_KEYS = Object.freeze([
  'recorded_at', 'via', 'procedure_log_id', 'urgency', 'reason',
  'blocking', 'missing_lab_items', 'lab_snapshot_as_of',
]);
export const START_VIAS = Object.freeze(['status', 'procedure_log']);

function orderedItemCodes(codes) {
  return [...new Set((codes || []).filter((code) => ITEM_CODES.includes(code)))]
    .sort((a, b) => ITEM_CODES.indexOf(a) - ITEM_CODES.indexOf(b));
}

export function buildStartSnapshot({
  via, procedureLogId = null, urgency = null, reason = null, blocking = [],
  missingLabItems = [], labSnapshotAsOf = null, now = new Date(),
}) {
  if (!START_VIAS.includes(via)) {
    throw AppError.badRequest(`start via must be one of ${START_VIAS.join(', ')}`, 'CATH_LAB_START_VIA_INVALID');
  }
  return {
    recorded_at: new Date(now).toISOString(),
    via,
    procedure_log_id: procedureLogId == null ? null : Number(procedureLogId),
    urgency: urgency ?? null,
    reason: reason ?? null,
    blocking: (blocking || []).map((row) => ({ check_type: row.check_type, reason: row.reason })),
    missing_lab_items: orderedItemCodes(missingLabItems),
    lab_snapshot_as_of: labSnapshotAsOf ?? null,
  };
}

export function normalizeStartSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    recorded_at: raw.recorded_at ?? null,
    via: START_VIAS.includes(raw.via) ? raw.via : null,
    procedure_log_id: raw.procedure_log_id == null ? null : Number(raw.procedure_log_id),
    urgency: raw.urgency ?? null,
    reason: raw.reason ?? null,
    blocking: Array.isArray(raw.blocking) ? raw.blocking.map((row) => ({ check_type: row?.check_type, reason: row?.reason })) : [],
    missing_lab_items: orderedItemCodes(raw.missing_lab_items),
    lab_snapshot_as_of: raw.lab_snapshot_as_of ?? null,
  };
}

// Derived, never stored separately: one source of truth.
export function startedWithReadinessPending(raw) {
  return Array.isArray(raw?.blocking) && raw.blocking.length > 0;
}

// The day list's availability rule over stored item rows, as item codes.
export function missingLabItemCodes(items, settings) {
  return orderedItemCodes(
    (items || []).filter((item) => item.required !== false && !isItemAvailable(item, settings)).map((item) => item.item_code),
  );
}
```

Add the five names (and `START_VIAS`) to the facade's explicit re-export list in `cathLabReadinessService.js`. The facade test `'every export of every sibling module is re-exported by the facade'` will fail until you do.

- [ ] **Step 12: Run the suite and the facade test**

Run: `npm test -- --testPathPatterns unit/cathLabReadinessService`
Expected: PASS, including the facade describe.

- [ ] **Step 13: Commit**

```bash
git add apps/backend/src/services/clinical/cathLabReadinessRules.js apps/backend/src/services/clinical/cathLabReadinessService.js apps/backend/src/tests/unit/cathLabReadinessService.test.js
git commit -m "feat(cath): readiness rules — post-start regime (staleness held, evidence applied), lateness markers, start snapshot

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
## Task 2: One start path, consent as the one hard block, the source pin (TDD)

**Files:**
- Modify: `apps/backend/src/services/clinical/cathLabService.js` (`CASE_TRANSITIONS`, `START_ELIGIBLE_STATUSES`, `assertReadinessComplete`, new `startCaseTx`, `labsSnapshotForStartTx`, `transitionCaseStatus`, `recordProcedureLog`, `createCase`)
- Create: `apps/backend/src/tests/unit/cathLabStartPathPin.test.js`
- Test: `apps/backend/src/tests/unit/cathLabService.test.js`

> **Blocked by the Task 0 gate.** Spec §10.2 (the procedure record on a cancelled case) must be answered before this task starts. If the answer is (i), fold Task 0 Step 6's branch-(i) code into Steps 3–5 and its consequent edits into Step 1's tests.

- [ ] **Step 1: Write the failing unit tests**

In `cathLabService.test.js`, extend the readiness-module mock with `recordReadinessAudit: jest.fn(async () => undefined)` and keep it in a top-level `const recordReadinessAuditMock`. Add to the rules-module import list nothing — `cathLabService` imports `buildStartSnapshot` / `missingLabItemCodes` from `cathLabReadinessRules.js` directly, which this suite does not mock, so the real pure helpers run. Add helpers:

```js
function readinessRows(overrides = {}) {
  return READINESS_TYPES.map((check_type, index) => ({
    id: index + 1, check_type, required: true,
    status: overrides[check_type] ?? 'pass',
    metadata: check_type === 'labs' ? { live_evidence_refreshed_at: '2026-09-06T04:31:05.001Z' } : {},
  }));
}
const startedRow = (status = 'in_progress') => ({ ...cathCase(status), urgency: 'emergency', facility_id: 4, actual_start_at: '2026-09-06T04:31:07.412Z', metadata: {} });
```

Replace the two old guard tests (`'blocks procedure start until every required readiness check is clear'` keeps its `evaluateReadinessGate` assertions but is renamed `'evaluateReadinessGate still names every non-clear check'`; `'records a procedure log only after readiness …'` is rewritten below) and add:

```js
describe('startCaseTx — the one start path (spec §4)', () => {
  test('START_ELIGIBLE_STATUSES is derived from the table', () => {
    expect(START_ELIGIBLE_STATUSES).toEqual(['scheduled', 'readiness_pending', 'ready']);
    expect(validateCaseTransition('scheduled', 'in_progress')).toBe('in_progress');
    expect(validateCaseTransition('readiness_pending', 'in_progress')).toBe('in_progress');
    expect(() => validateCaseTransition('requested', 'in_progress')).toThrow('Invalid state transition');
    expect(() => validateCaseTransition('completed', 'in_progress')).toThrow('Invalid state transition');
  });

  test('consent pending refuses the status start before anything is written', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ ...cathCase('readiness_pending'), urgency: 'emergency', facility_id: 4 }])
      .mockResolvedValueOnce(readinessRows({ consent: 'pending', labs: 'pending' }));
    await expect(transitionCaseStatus(42, { tenantId: TENANT, status: 'in_progress', reason: 'x' }, { actorUid: ACTOR, actorRole: 'DOCTOR' }))
      .rejects.toMatchObject({ code: 'CATH_LAB_CONSENT_REQUIRED', statusCode: 400, details: { consent_status: 'pending' } });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE cath_lab_cases/.test(sql))).toBe(false);
    expect(recordReadinessAuditMock).not.toHaveBeenCalled();
  });

  test('a waived or not-applicable consent is not consent', async () => {
    for (const status of ['waived', 'not_applicable']) {
      queryUnsafeMock.mockReset();
      queryUnsafeMock
        .mockResolvedValueOnce([{ ...cathCase('ready'), urgency: 'routine', facility_id: 4 }])
        .mockResolvedValueOnce(readinessRows({ consent: status }));
      await expect(transitionCaseStatus(42, { tenantId: TENANT, status: 'in_progress' }, { actorUid: ACTOR }))
        .rejects.toMatchObject({ code: 'CATH_LAB_CONSENT_REQUIRED', details: { consent_status: status } });
    }
  });

  test('a pending gate needs a reason on the status path, and the refusal names the checks', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ ...cathCase('readiness_pending'), urgency: 'emergency', facility_id: 4 }])
      .mockResolvedValueOnce(readinessRows({ labs: 'pending', timeout: 'pending' }));
    await expect(transitionCaseStatus(42, { tenantId: TENANT, status: 'in_progress' }, { actorUid: ACTOR }))
      .rejects.toMatchObject({
        code: 'CATH_LAB_START_REASON_REQUIRED',
        details: { blocking: [{ check_type: 'labs', reason: 'pending' }, { check_type: 'timeout', reason: 'pending' }] },
      });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE cath_lab_cases/.test(sql))).toBe(false);
  });

  test('consent pass + labs pending + reason: starts, snapshots, audits, emits case_in_progress', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ ...cathCase('readiness_pending'), urgency: 'emergency', facility_id: 4 }])
      .mockResolvedValueOnce(readinessRows({ labs: 'pending', timeout: 'pending' }))
      .mockResolvedValueOnce([{ item_code: 'hcv', required: true, state: 'not_ordered' }, { item_code: 'hb', required: true, state: 'result_final' }]) // stored items
      .mockResolvedValueOnce([startedRow()]) // UPDATE … RETURNING *
      .mockResolvedValueOnce([]); // updateCaseCanonicalRefs
    const result = await transitionCaseStatus(42, { tenantId: TENANT, status: 'in_progress', reason: 'Primary PCI, outside reports awaited' }, { actorUid: ACTOR, actorRole: 'CONSULTANT' });
    expect(result.status).toBe('in_progress');
    const update = queryUnsafeMock.mock.calls.find(([sql]) => /UPDATE cath_lab_cases/.test(sql));
    expect(update[0]).toMatch(/status = 'in_progress'/);
    expect(update[0]).toMatch(/actual_start_at = COALESCE\(actual_start_at, NOW\(\)\)/);
    expect(update[0]).toMatch(/jsonb_build_object\('readiness_at_start'/);
    const snapshot = JSON.parse(update[3]);
    expect(Object.keys(snapshot)).toEqual(['recorded_at', 'via', 'procedure_log_id', 'urgency', 'reason', 'blocking', 'missing_lab_items', 'lab_snapshot_as_of']);
    expect(snapshot).toMatchObject({ via: 'status', urgency: 'emergency', reason: 'Primary PCI, outside reports awaited', missing_lab_items: ['hcv'], lab_snapshot_as_of: '2026-09-06T04:31:05.001Z' });
    expect(snapshot.blocking.map((row) => row.check_type)).toEqual(['labs', 'timeout']);
    expect(recordReadinessAuditMock).toHaveBeenCalledWith(__prismaDefaultMock, expect.objectContaining({
      action: 'cath_lab.case.started_with_readiness_pending', resource: 'cath_lab_cases', resourceId: 42,
      metadata: expect.objectContaining({ case_id: 42, facility_id: 4, urgency: 'emergency', via: 'status' }),
    }));
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'cath_lab.case_in_progress',
      payload: expect.objectContaining({ started_with_readiness_pending: true, via: 'status', readiness_at_start: expect.objectContaining({ missing_lab_items: ['hcv'] }) }),
    }), expect.anything());
  });

  test('a clean start writes an empty-blocking snapshot and no audit row', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ ...cathCase('ready'), urgency: 'routine', facility_id: 4 }])
      .mockResolvedValueOnce(readinessRows())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([startedRow()])
      .mockResolvedValueOnce([]);
    await transitionCaseStatus(42, { tenantId: TENANT, status: 'in_progress' }, { actorUid: ACTOR });
    const snapshot = JSON.parse(queryUnsafeMock.mock.calls.find(([sql]) => /UPDATE cath_lab_cases/.test(sql))[3]);
    expect(snapshot.blocking).toEqual([]);
    expect(recordReadinessAuditMock).not.toHaveBeenCalled();
  });

  test('the procedure log starts through the same function: no reason needed, via procedure_log, with the log id', async () => {
    const procedure = { id: 7, tenant_id: TENANT, case_id: 42, patient_uid: PATIENT, encounter_id: ENCOUNTER, procedure_type: 'Primary PCI', status: 'finalized' };
    queryUnsafeMock
      .mockResolvedValueOnce([{ ...cathCase('scheduled'), urgency: 'emergency', facility_id: 4 }])
      .mockResolvedValueOnce([procedure]) // INSERT log
      .mockResolvedValueOnce(readinessRows({ labs: 'pending' })) // assertReadinessComplete inside startCaseTx
      .mockResolvedValueOnce([]) // stored items
      .mockResolvedValueOnce([startedRow()]) // UPDATE case
      .mockResolvedValueOnce([]) // canonical refs
      .mockResolvedValueOnce([]) // UPDATE cath_procedure_logs ids
      .mockResolvedValueOnce([]); // complication registry rows
    const result = await recordProcedureLog(42, { tenantId: TENANT, procedure_type: 'Primary PCI' }, { actorUid: ACTOR, actorRole: 'CARDIOLOGIST' });
    expect(result).toMatchObject({ id: 7 });
    const snapshot = JSON.parse(queryUnsafeMock.mock.calls.find(([sql]) => /UPDATE cath_lab_cases/.test(sql))[3]);
    expect(snapshot).toMatchObject({ via: 'procedure_log', procedure_log_id: 7, reason: null });
    expect(recordReadinessAuditMock).toHaveBeenCalledTimes(1);
  });

  test('the procedure log is refused by the consent block too (hazard ii)', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ ...cathCase('scheduled'), urgency: 'emergency', facility_id: 4 }])
      .mockResolvedValueOnce([{ id: 7 }])
      .mockResolvedValueOnce(readinessRows({ consent: 'pending' }));
    await expect(recordProcedureLog(42, { tenantId: TENANT, procedure_type: 'Primary PCI' }, { actorUid: ACTOR }))
      .rejects.toMatchObject({ code: 'CATH_LAB_CONSENT_REQUIRED' });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE cath_lab_cases/.test(sql))).toBe(false);
  });

  test('a log on an in_progress or completed case never touches the case; on a cancelled case nothing is written', async () => {
    for (const status of ['in_progress', 'completed']) {
      queryUnsafeMock.mockReset();
      queryUnsafeMock
        .mockResolvedValueOnce([{ ...cathCase(status), urgency: 'routine', facility_id: 4 }])
        .mockResolvedValueOnce([{ id: 8, tenant_id: TENANT, case_id: 42, patient_uid: PATIENT, encounter_id: ENCOUNTER, status: 'amended' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      await recordProcedureLog(42, { tenantId: TENANT, procedure_type: 'Primary PCI', status: 'amended' }, { actorUid: ACTOR });
      expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE cath_lab_cases/.test(sql))).toBe(false);
    }
    // OPEN OWNER ITEM (spec §10.2): the cancelled half is the PROPOSED
    // behaviour behind REFUSE_PROCEDURE_LOG_ON_CANCELLED, not a decided
    // default. Companion (i) replaces this with a reopen assertion; companion
    // (ii) replaces it with "the log and the audit row are written and the
    // case stays cancelled". Do not treat a green here as the design settled.
    queryUnsafeMock.mockReset();
    queryUnsafeMock.mockResolvedValueOnce([{ ...cathCase('cancelled'), urgency: 'routine', facility_id: 4 }]);
    await expect(recordProcedureLog(42, { tenantId: TENANT, procedure_type: 'Primary PCI' }, { actorUid: ACTOR }))
      .rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO cath_procedure_logs/.test(sql))).toBe(false);
  });

  test('createCase strips a client-minted readiness_at_start', async () => {
    // Drive createCase far enough to read the INSERT's bound metadata; the
    // suite's existing createCase fixtures show the mock sequence (facility,
    // insert RETURNING, eight check inserts, canonical refs, getCase).
    // Assert: JSON.parse(insertCall[insertCall.length - 1]) has no key
    // 'readiness_at_start' while other caller keys survive.
  });
});
```

Import `START_ELIGIBLE_STATUSES` from the service in the destructured import. Fill the `createCase` test body from the suite's existing createCase fixture pattern (search the file for `INSERT INTO cath_lab_cases`), asserting the last bound argument's parsed JSON lacks `readiness_at_start` and keeps a sibling key such as `source`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --testPathPatterns unit/cathLabService.test`
Expected: FAIL — `START_ELIGIBLE_STATUSES` undefined; consent tests get `CATH_LAB_READINESS_BLOCKED`.

- [ ] **Step 3: Implement — transitions and the consent block**

In `cathLabService.js`:

```js
export const CASE_TRANSITIONS = Object.freeze({
  requested: ['scheduled', 'cancelled'],
  // Owner principle 2026-09-06: the pre-cath checklist informs and records; it
  // never restricts. A scheduled or readiness-pending case may start (the
  // emergency case STEMI creates is readiness_pending); consent is the one
  // hard block and is asserted inside startCaseTx, not here.
  scheduled: ['readiness_pending', 'ready', 'in_progress', 'cancelled'],
  readiness_pending: ['ready', 'in_progress', 'cancelled'],
  ready: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: []
});
// Derived from the table so the two cannot disagree.
export const START_ELIGIBLE_STATUSES = Object.freeze(
  Object.entries(CASE_TRANSITIONS)
    .filter(([, targets]) => targets.includes('in_progress'))
    .map(([from]) => from)
);
```

Replace `assertReadinessComplete` with the spec §4.3 body (consent `pass` only, `CATH_LAB_CONSENT_REQUIRED`, `details: { consent_status, blocking }`, returns the gate).

- [ ] **Step 4: Implement — `labsSnapshotForStartTx` and `startCaseTx`**

Add imports: `buildStartSnapshot, missingLabItemCodes` from `./cathLabReadinessRules.js` (beside `ITEM_CODES`, `isItemAvailable`); `recordReadinessAudit` from `./cathLabReadinessService.js` (beside the existing names). Then, after `assertReadinessComplete`:

```js
// The STORED lab items at the moment of start, reduced to the codes the day
// list would call missing. Stored rows, not a refresh: the start must never
// wait on — or fail because of — the lab rail (spec §4.5). The check rows have
// already been read by assertReadinessComplete; the labs row's evidence stamp
// is taken from that read.
async function labsSnapshotForStartTx(tx, tenantId, caseId, checks) {
  const items = normalizeRows(await tx.$queryRawUnsafe(
    `SELECT item_code, required, state
       FROM cath_case_lab_readiness_items
      WHERE tenant_id = $1::uuid
        AND case_id = $2::bigint`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id')
  ));
  const settings = await getReadinessSettings({ tenantId: tenantOr(tenantId), db: tx });
  const labsCheck = checks.find((check) => check.check_type === 'labs');
  return {
    missing: missingLabItemCodes(items, settings),
    as_of: labsCheck?.metadata?.live_evidence_refreshed_at ?? null
  };
}

// THE ONE START PATH (spec §4.2). transitionCaseStatus and recordProcedureLog
// both come here and nowhere else moves a case to in_progress or sets
// actual_start_at — cathLabStartPathPin.test.js pins all three counts. The
// caller holds the case row FOR UPDATE.
async function startCaseTx(tx, { tenantId, cathCase, reason = null, via, procedureLogId = null, context = {} }) {
  if (!START_ELIGIBLE_STATUSES.includes(cathCase.status)) {
    throw AppError.invalidTransition(cathCase.status, 'in_progress', CASE_TRANSITIONS[cathCase.status] || []);
  }
  // Consent: the one hard block. Throws before anything is written.
  const gate = await assertReadinessComplete(tx, tenantId, cathCase.id);
  const cleanReason = cleanText(reason, 500);
  // A reason is the owner's control on an explicit start with checks pending
  // (decision 4). The procedure record is the record of an act already under
  // way and never refuses for its absence.
  if (!gate.ready && via === 'status' && !cleanReason) {
    throw AppError.badRequest(
      'A reason is required to start the procedure while readiness checks are pending',
      'CATH_LAB_START_REASON_REQUIRED',
      { blocking: gate.blocking }
    );
  }
  const checks = await readinessForCase(tx, tenantId, cathCase.id);
  const labs = await labsSnapshotForStartTx(tx, tenantId, cathCase.id, checks);
  const snapshot = buildStartSnapshot({
    via,
    procedureLogId,
    urgency: cathCase.urgency ?? null,
    reason: cleanReason,
    blocking: gate.blocking,
    missingLabItems: labs.missing,
    labSnapshotAsOf: labs.as_of
  });
  const rows = await tx.$queryRawUnsafe(
    `UPDATE cath_lab_cases
        SET status = 'in_progress',
            actual_start_at = COALESCE(actual_start_at, NOW()),
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('readiness_at_start', $3::jsonb),
            updated_by = $4::uuid,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
      RETURNING *`,
    tenantOr(tenantId),
    cathCase.id,
    JSON.stringify(snapshot),
    maybeUuid(context.actorUid, 'actorUid')
  );
  const updated = unwrap(rows);
  const startedWithPending = gate.blocking.length > 0;
  const event = await writeCanonicalEvent(tx, {
    tenantId,
    patientUid: updated.patient_uid,
    encounterId: updated.encounter_id,
    eventType: 'cath_lab.case_in_progress',
    eventStatus: 'in_progress',
    sourceTable: 'cath_lab_cases',
    sourceId: updated.id,
    actorUid: context.actorUid,
    actorRole: context.actorRole,
    summary: `Cath-lab case in_progress: ${updated.requested_procedure}`,
    payload: {
      status: 'in_progress',
      reason: cleanReason,
      via,
      started_with_readiness_pending: startedWithPending,
      readiness_at_start: snapshot
    },
    beforeState: { status: cathCase.status },
    afterState: { status: 'in_progress' }
  });
  await updateCaseCanonicalRefs(tx, { tenantId, caseId: updated.id, event });
  if (startedWithPending) {
    await recordReadinessAudit(tx, {
      tenantId: tenantOr(tenantId),
      action: 'cath_lab.case.started_with_readiness_pending',
      resource: 'cath_lab_cases',
      resourceId: updated.id,
      context,
      metadata: { case_id: normalizeDbValue(updated.id), facility_id: updated.facility_id ?? null, ...snapshot }
    });
  }
  return { updated: normalizeDbValue(updated), snapshot };
}
```

Note: `assertReadinessComplete` reads the checks once; `startCaseTx` reads them again for the labs stamp. To keep it at one read, have `assertReadinessComplete` return `{ gate, checks }` and adjust the two lines — the unit mock sequence above assumes ONE `readinessForCase` read per start, so make that change and keep the tests' mock order.

- [ ] **Step 5: Implement — rewire both callers**

`transitionCaseStatus`, inside the transaction after `validateCaseTransition`:

```js
    if (target === 'in_progress') {
      const { updated } = await startCaseTx(tx, {
        tenantId, cathCase, reason: input.reason, via: 'status', context
      });
      return updated;
    }
```

and delete the `actual_start_at = CASE … END` branch from the generic UPDATE (it is dead for every remaining target). `recordProcedureLog`, inside the transaction:

```js
// OPEN OWNER ITEM — spec §10.2. NOT a decided default. `cancelled` is terminal
// in CASE_TRANSITIONS, so refusing here means a procedure that was actually
// performed on a cancelled case cannot be recorded in-app by any route; today's
// silent un-cancel (the force-start UPDATE this task deletes) is the only
// existing path. The refusal ships behind this flag so the owner's answer is a
// one-line change plus the branch's own code, not a rewrite of recordProcedureLog.
// TODO(owner, spec §10.2): remove this flag when the companion lands —
//   (i) cancelled gains a reason-gated transition through startCaseTx  → Task 0 Step 6, into this task
//   (ii) a performed-after-cancellation record path that leaves the case cancelled → Task 0 Step 6, into Task 3
// Do not flip it silently and do not hand the PR back as complete while it stands.
const REFUSE_PROCEDURE_LOG_ON_CANCELLED = true;

    const cathCase = await caseById(tx, tenantId, caseId, { lock: true });
    if (REFUSE_PROCEDURE_LOG_ON_CANCELLED && cathCase.status === 'cancelled') {
      // The transition table's own error, before anything is written.
      validateCaseTransition('cancelled', 'in_progress');
    }
    // (the assertReadinessComplete line that was here is deleted)
    … insert the log exactly as today …
    const procedure = unwrap(rows);
    if (START_ELIGIBLE_STATUSES.includes(cathCase.status)) {
      // The other start path. Same function, same consent block, same
      // snapshot; the log's own id rides in it.
      await startCaseTx(tx, {
        tenantId, cathCase, reason: input.start_reason, via: 'procedure_log',
        procedureLogId: procedure.id, context
      });
    }
    // in_progress / completed: an amendment; the case is left alone.
```

Delete the inline `if (cathCase.status !== 'in_progress') { UPDATE … }` block.

- [ ] **Step 6: Implement — `createCase` reserved key**

```js
const CASE_START_METADATA_KEYS = Object.freeze(['readiness_at_start']);
// in createCase, after normalizeJson(input.metadata …):
const metadata = Object.fromEntries(
  Object.entries(normalizeJson(input.metadata, 'metadata', {}))
    .filter(([key]) => !CASE_START_METADATA_KEYS.includes(key))
);
```

- [ ] **Step 7: Run the unit suite**

Run: `npm test -- --testPathPatterns unit/cathLabService.test`
Expected: PASS. If the SLA tests broke, the generic UPDATE's parameter numbering shifted — re-read `transitionCaseStatus` and keep `$3`/`$4` positions.

- [ ] **Step 8: Write the source pin**

Create `apps/backend/src/tests/unit/cathLabStartPathPin.test.js`:

```js
/**
 * STRUCTURAL PIN for the one start path (spec 2026-09-06 §4.3).
 *
 * Consent is the one hard block on starting a cath case, and it lives in ONE
 * function (assertReadinessComplete) reached through ONE function (startCaseTx)
 * that both start paths call. The two hazards this pins against: weaken only
 * one path and the other still demands the old gate ("why can I start it but
 * not record it"); or weaken both and lose consent on one, and the block
 * leaks. A third start path — a new route, a job, a service that sets
 * in_progress itself — fails here and has to be argued for in a diff.
 *
 * The call-graph half of that is necessary and not sufficient. A fourth start
 * path does not have to call anything this lane wrote — it only has to issue a
 * raw `UPDATE cath_lab_cases SET actual_start_at = NOW()` of its own, and both
 * caller counts below would stay green while it did. So the third pin reads the
 * SOURCE TEXT of the SQL: every backtick literal that names cath_lab_cases,
 * matched for the shapes that start a case, and every hit must be in
 * startCaseTx. That is the only assertion here that a new raw UPDATE reddens.
 *
 * Textual, comments stripped, shipping modules only (tests excluded), in the
 * style of labExternalResultCallSites.test.js.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVICE = 'services/clinical/cathLabService.js';
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', 'generated']);

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(js|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out;
}
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line) => !/^\s*(\/\/|\*)/.test(line)).join('\n');
}
const FILES = sourceFiles(SRC_ROOT)
  .map((full) => ({ path: relative(SRC_ROOT, full).split(sep).join('/'), text: withoutComments(readFileSync(full, 'utf8')) }))
  .filter((file) => !file.path.startsWith('tests/'));
const service = FILES.find((file) => file.path === SERVICE);

// The name of the function whose body contains `index`, by scanning backwards
// for the nearest `function <name>(` declaration.
function enclosingFunction(text, index) {
  const before = text.slice(0, index);
  const match = [...before.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g)].pop();
  return match ? match[1] : null;
}
function callers(text, callee) {
  const out = [];
  const re = new RegExp(`(?<![A-Za-z0-9_$])${callee}\\(`, 'g');
  for (const match of text.matchAll(re)) {
    const name = enclosingFunction(text, match.index);
    if (name && name !== callee) out.push(name);
  }
  return out.sort();
}

// Raw SQL here lives in backtick template literals passed to $queryRawUnsafe /
// $executeRawUnsafe. SCOPE THE SHAPES BELOW TO THE LITERALS THAT NAME
// cath_lab_cases: `status = 'in_progress'` and `actual_start_at =` are ordinary
// text elsewhere in this tree — dialysis_sessions, housekeeping requests and
// workflow tasks all carry both — so a tree-wide match would be red on main and
// would say nothing about the cath case. Scoping by table is what makes the pin
// TRUE, and a stray `UPDATE cath_lab_cases SET actual_start_at = NOW()` in any
// other service still lands inside it, which is the whole point.
function sqlLiterals(file) {
  return [...file.text.matchAll(/`([^`]*)`/g)]
    .map((match) => ({ index: match.index, body: match[1] }))
    .filter((literal) => /\bcath_lab_cases\b/.test(literal.body));
}

// The functions allowed to assign cath_lab_cases.status AT ALL — parameterised
// or not. A start path could write `SET status = $3` and bind 'in_progress',
// which no literal-text match can see; this closes that hole the way
// labExternalResultCallSites.test.js closes its own — a literal list, never a
// prefix or a glob, so a fifth writer has to be argued for in a diff.
const STATUS_WRITERS = Object.freeze([
  'services/clinical/cathLabReadinessService.js:recomputeCaseStatusTx',
  'services/clinical/cathLabService.js:startCaseTx',
  'services/clinical/cathLabService.js:transitionCaseStatus',
  'services/clinical/cathLabService.js:updateReadinessCheck',
]);

describe('the cath case has exactly one start path', () => {
  test('the scan found the service', () => {
    expect(FILES.length).toBeGreaterThan(200);
    expect(service).toBeDefined();
  });

  test('assertReadinessComplete is called from startCaseTx and nowhere else', () => {
    expect(callers(service.text, 'assertReadinessComplete')).toEqual(['startCaseTx']);
    const elsewhere = FILES.filter((file) => file.path !== SERVICE && file.text.includes('assertReadinessComplete')).map((file) => file.path);
    expect(elsewhere).toEqual([]);
  });

  test('startCaseTx is called from transitionCaseStatus and recordProcedureLog and nowhere else', () => {
    expect(callers(service.text, 'startCaseTx')).toEqual(['recordProcedureLog', 'transitionCaseStatus']);
    const elsewhere = FILES.filter((file) => file.path !== SERVICE && file.text.includes('startCaseTx')).map((file) => file.path);
    expect(elsewhere).toEqual([]);
  });

  test('only startCaseTx writes in_progress or actual_start_at on a cath_lab_cases statement', () => {
    const sites = [];
    for (const file of FILES) {
      for (const literal of sqlLiterals(file)) {
        const fn = enclosingFunction(file.text, literal.index);
        for (const line of literal.body.split('\n')) {
          if (/actual_start_at\s*=/.test(line) || /status\s*=\s*'in_progress'/.test(line)) {
            sites.push({ at: `${file.path}:${fn}`, line: line.trim() });
          }
        }
        // A CASE expression can reach 'in_progress' across several lines, which
        // the two per-line shapes above would walk straight past.
        if (/SET\s+status\s*=\s*CASE[\s\S]*?'in_progress'[\s\S]*?END/.test(literal.body)) {
          sites.push({ at: `${file.path}:${fn}`, line: "SET status = CASE … 'in_progress' … END" });
        }
      }
    }
    sites.sort((a, b) => `${a.at}:${a.line}`.localeCompare(`${b.at}:${b.line}`));
    // The COUNT of matching lines is pinned, not just the set of functions:
    // startCaseTx makes exactly two such assignments. A third inside it, or a
    // first anywhere else, fails here.
    expect(sites.map((site) => site.at)).toEqual([`${SERVICE}:startCaseTx`, `${SERVICE}:startCaseTx`]);
    expect(sites.map((site) => site.line)).toEqual([
      'actual_start_at = COALESCE(actual_start_at, NOW()),',
      "SET status = 'in_progress',",
    ]);
  });

  test('the functions that assign cath_lab_cases.status are a literal list', () => {
    const writers = new Set();
    for (const file of FILES) {
      for (const literal of sqlLiterals(file)) {
        if (/\bSET\s+status\s*=/.test(literal.body)) writers.add(`${file.path}:${enclosingFunction(file.text, literal.index)}`);
      }
    }
    expect([...writers].sort()).toEqual([...STATUS_WRITERS]);
  });

  test('the full-gate code is gone from shipping code', () => {
    expect(FILES.filter((file) => file.text.includes('CATH_LAB_READINESS_BLOCKED')).map((file) => file.path)).toEqual([]);
  });
});
```

Three notes for whoever runs this.

**`localeCompare` ordering** is ICU, not ASCII: `actual_start_at = COALESCE(…)` sorts BEFORE `SET status = 'in_progress',` (base letter `a` < `s`; the capital `S` does not come first). If the assertion fails only on order, read the two lines before touching anything.

**Scope**: `FILES` is all of `apps/backend/src` with `tests/` excluded — services, routes and controllers alike, not `services/` alone. A route or controller that starts a case is exactly the fourth path this pins against, and the table scoping keeps `housekeepingController.js`'s own `SET status = 'in_progress'` (on housekeeping requests) out of it.

**The expected values were measured on the pre-lane tree**, so the failure you should see BEFORE Task 2's implementation lands is informative rather than confusing. Run this probe on the base commit and it reports three sites in two functions — `recordProcedureLog` (`SET status = 'in_progress',` + `actual_start_at = COALESCE(…)`, the force-start this task deletes) and `transitionCaseStatus` (`actual_start_at = CASE`, the dead branch this task deletes) — and `STATUS_WRITERS` with `recordProcedureLog` where the list has `startCaseTx`. Both collapse to the two pinned lines in `startCaseTx` once Step 4 and Step 5 land. If they do not, one of the two deletions was missed.

- [ ] **Step 9: Run the pin**

Run: `npm test -- --testPathPatterns unit/cathLabStartPathPin`
Expected: PASS. If `only startCaseTx writes …` lists a second site, that site is a start path this plan did not know about: stop, read it, and either route it through `startCaseTx` or report it.

- [ ] **Step 10: Mutation check for hazard (ii)**

Temporarily move the `assertReadinessComplete` call from `startCaseTx` into `transitionCaseStatus` (before `startCaseTx`). Run the pin and the service suite: expected the pin's caller test red and `'the procedure log is refused by the consent block too'` red. Revert.

- [ ] **Step 11: Commit**

```bash
git add apps/backend/src/services/clinical/cathLabService.js apps/backend/src/tests/unit/cathLabService.test.js apps/backend/src/tests/unit/cathLabStartPathPin.test.js
git commit -m "feat(cath): one start path — scheduled/readiness_pending may start, consent is the one hard block, at-start snapshot + audit

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 3: The checklist keeps living after start (TDD, unit then deep)

**Files:**
- Modify: `apps/backend/src/services/clinical/cathLabReadinessService.js` (`caseRowTx`, `refreshCaseLabReadiness`, `refreshOpenCasesForPatient`)
- Modify: `apps/backend/src/services/clinical/cathLabReadinessActions.js` (`orderPriorityForUrgency`, `orderMissingLabs`, `recordExternalLabResult`)
- Modify: `apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs` (decision 9 edits only — the rest in Task 4)
- Test: `apps/backend/src/tests/unit/cathLabReadinessServiceOrders.test.js`, `apps/backend/src/tests/unit/cathLabReadinessService.test.js`, `apps/backend/src/tests/cath-lab-readiness.deep.test.js`, `apps/backend/src/tests/unit/cathLabRouteGuards.test.js` (decision 9, branch REMOVED only)

- [ ] **Step 1: Write the failing unit tests for the late actions**

In `cathLabReadinessService.test.js`, `describe('orderPriorityForUrgency')`:

```js
  test('a started case orders STAT whatever its booked urgency', () => {
    for (const urgency of ['elective', 'routine', 'urgent', 'emergency', undefined]) {
      expect(orderPriorityForUrgency(urgency, { started: true })).toBe('STAT');
    }
    expect(orderPriorityForUrgency('elective')).toBe('NORMAL');
  });
```

In `cathLabReadinessServiceOrders.test.js`: find the existing test that asserts order-missing refuses a started case (`CATH_LAB_READINESS_CASE_STARTED`) and invert it: with `case_started: true` in the refresh stub, `createInvestigationOrder` is called with `priority: 'STAT'` for each code, and `recordReadinessAudit` is called with `metadata: expect.objectContaining({ ordered_after_start: true })`. Find the outside-result refusal test (if the suite has one) and invert it: the row is written and the audit metadata carries `recorded_after_start: true`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --testPathPatterns "unit/cathLabReadinessService"`
Expected: FAIL.

- [ ] **Step 3: Implement the late actions**

`cathLabReadinessActions.js`:

```js
export function orderPriorityForUrgency(urgency, { started = false } = {}) {
  // A draw for a patient already on the table is urgent by definition,
  // whatever the case was booked as (spec 2026-09-06 §5.3).
  if (started) return 'STAT';
  return CATH_URGENCY_ORDER_PRIORITY[String(urgency ?? '').trim().toLowerCase()] || 'NORMAL';
}
```

In `orderMissingLabs`: delete the `if (before.case_started) throw …` block; `const priority = orderPriorityForUrgency(patientRows[0].urgency, { started: before.case_started });`; the note becomes `` `Pre-cath lab readiness (case ${before.case_id})${before.case_started ? ' — ordered after procedure start' : ''}` ``; the audit metadata becomes `{ created, skipped, ordered_after_start: before.case_started }`. In `recordExternalLabResult`: delete the `if (cathCase.actual_start_at) throw …` block; compute `const recordedAfterStart = isAfterCaseStart(cathCase);` beside it and add `recorded_after_start: recordedAfterStart` to the `CATH_LAB_EXTERNAL_RESULT_RECORDED` audit metadata. Update `isAfterCaseStart`'s comment (the parenthetical about order-missing and external-result still refusing is now false — delete it).

- [ ] **Step 4: Implement the refresh changes**

`cathLabReadinessService.js` — `caseRowTx` SELECT:

```sql
SELECT id, tenant_id, patient_uid, encounter_id, facility_id, status, urgency, actual_start_at,
       (EXTRACT(EPOCH FROM actual_start_at) * 1000)::bigint AS actual_start_at_epoch_ms,
       metadata->'readiness_at_start' AS readiness_at_start
  FROM cath_lab_cases …
```

In `refreshCaseLabReadiness`: `caseStartedAt: cathCase.actual_start_at_epoch_ms ?? cathCase.actual_start_at,`; the `auto_pass` audit metadata gains `passed_after_start: decision.nextStatus === 'pass' && Boolean(cathCase.actual_start_at)`; the return gains, after `case_started`:

```js
      started_with_readiness_pending: startedWithReadinessPending(cathCase.readiness_at_start),
      readiness_at_start: normalizeStartSnapshot(cathCase.readiness_at_start),
```

`refreshOpenCasesForPatient` predicate:

```sql
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND status NOT IN ('completed', 'cancelled')
```

with its comment: a result filed mid-procedure reaches the started case too (spec §5.1).

- [ ] **Step 5: Run the unit suites**

Run: `npm test -- --testPathPatterns "unit/cathLabReadinessService|unit/cathLabReadinessServiceOrders"`
Expected: PASS.

- [ ] **Step 6: Decision 9 — `CATH_LAB_READINESS_CASE_STARTED`**

Per Task 0 Step 2. **Branch KEPT**: in `cathLabReadiness.mjs` remove the 409 `errorResponse` from the order-missing and external-result operations and delete "Refused once the procedure has started." from both descriptions; rewrite `case_started`'s description: "True once the procedure has an actual start. Nothing on this surface is refused after it except lifting a waiver (#1018, record-yes / lift-no): ordering, outside results and waivers stay open and are marked as after start." **Branch REMOVED**: additionally delete the code from `ERROR_CODES`, re-target `cathLabRouteGuards.test.js`'s `'POST unwaive CACHES any other deterministic 409'` to `CATH_LAB_CASE_FACILITY_MISMATCH` with a rewritten comment, and edit the unwaive route comment in `cathLabRoutes.js`. Run `npm test -- --testPathPatterns "unit/cathLabReadinessOpenApiSource|unit/cathLabRouteGuards"` — the source pin's error-code test must be green in whichever branch applies.

- [ ] **Step 7: Write the failing deep tests**

Append to `cath-lab-readiness.deep.test.js` a new `d('… never restricts (deep)')` block **or** new tests inside the existing describe — each test seeds its own case with `createCase` (the readiness refresh on create needs the tenant settings; the suite's `seed()` already provides them) so #1018's late-waiver fixture on `CASE_ID` is untouched. Helper:

```js
async function seedCase({ status = 'scheduled', consent = 'pass', labs = 'pending', others = 'pass', urgency = 'routine' } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO cath_lab_cases (tenant_id, patient_uid, facility_id, requested_procedure, urgency, status, created_by, updated_by)
     VALUES ($1::uuid, $2::uuid, $4::int, 'Never-restricts PTCA', $5, $6, $3::uuid, $3::uuid) RETURNING id`,
    TENANT, PATIENT, ACTOR, FACILITY_ID, urgency, status,
  );
  const id = Number(rows[0].id);
  for (const type of READINESS_TYPES) {
    const st = type === 'consent' ? consent : type === 'labs' ? labs : others;
    await prisma.$executeRawUnsafe(
      `INSERT INTO cath_lab_readiness_checks (tenant_id, case_id, check_type, status, required, metadata)
       VALUES ($1::uuid, $2::bigint, $3, $4, TRUE, '{}'::jsonb)`,
      TENANT, id, type, st,
    );
  }
  return id;
}
const caseRow = (id) => prisma.$queryRawUnsafe(
  `SELECT status, actual_start_at, metadata->'readiness_at_start' AS snapshot FROM cath_lab_cases WHERE tenant_id = $1::uuid AND id = $2::bigint`,
  TENANT, id,
).then((rows) => rows[0]);
const startAudits = (id) => prisma.$queryRawUnsafe(
  `SELECT metadata, actor_uid, role FROM audit_logs WHERE tenant_id = $1::uuid AND action = 'cath_lab.case.started_with_readiness_pending' AND resource_id = $2::text`,
  TENANT, String(id),
);
```

Tests (import `transitionCaseStatus`, `recordProcedureLog` from `cathLabService.js`):

```js
  test('consent pending refuses both start paths; consent waived is not consent; nothing is written', async () => {
    for (const consent of ['pending', 'waived']) {
      const id = await seedCase({ status: 'readiness_pending', consent });
      await expect(transitionCaseStatus(id, { tenantId: TENANT, status: 'in_progress', reason: 'r' }, ctx()))
        .rejects.toMatchObject({ code: 'CATH_LAB_CONSENT_REQUIRED', details: { consent_status: consent } });
      await expect(recordProcedureLog(id, { tenantId: TENANT, procedure_type: 'PTCA' }, ctx()))
        .rejects.toMatchObject({ code: 'CATH_LAB_CONSENT_REQUIRED' });
      const row = await caseRow(id);
      expect(row.status).toBe('readiness_pending');
      expect(row.actual_start_at).toBeNull();
      expect(row.snapshot).toBeNull();
      const logs = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM cath_procedure_logs WHERE tenant_id = $1::uuid AND case_id = $2::bigint`, TENANT, id);
      expect(logs[0].n).toBe(0);
      expect(await startAudits(id)).toHaveLength(0);
    }
  }, 60000);

  test('status path: a pending gate needs a reason; with one the case starts, snapshots, audits, and the day list shows it', async () => {
    const id = await seedCase({ status: 'readiness_pending', labs: 'pending', urgency: 'emergency' });
    await refreshCaseLabReadiness({ tenantId: TENANT, caseId: id, context: ctx() }); // item rows exist
    await expect(transitionCaseStatus(id, { tenantId: TENANT, status: 'in_progress' }, ctx()))
      .rejects.toMatchObject({ code: 'CATH_LAB_START_REASON_REQUIRED' });
    const started = await transitionCaseStatus(id, { tenantId: TENANT, status: 'in_progress', reason: 'Primary PCI, reports awaited' }, ctx());
    expect(started.status).toBe('in_progress');
    const row = await caseRow(id);
    expect(row.snapshot).toMatchObject({ via: 'status', urgency: 'emergency', reason: 'Primary PCI, reports awaited' });
    expect(row.snapshot.blocking.map((b) => b.check_type)).toEqual(['labs']);
    const audits = await startAudits(id);
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ case_id: id, facility_id: FACILITY_ID, urgency: 'emergency', via: 'status' });
    expect(audits[0].actor_uid).toBe(ACTOR);
    const block = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: id, context: ctx() });
    expect(block).toMatchObject({ case_started: true, started_with_readiness_pending: true });
    expect(block.readiness_at_start.reason).toBe('Primary PCI, reports awaited');
    const listed = (await listCases({ tenantId: TENANT, limit: 500 })).find((c) => Number(c.id) === id);
    expect(listed.lab_readiness_summary.started_with_readiness_pending).toBe(true);
    expect(listed).not.toHaveProperty('metadata');
  }, 60000);

  test('procedure-log path: same function, same snapshot, via procedure_log, no reason needed', async () => {
    const id = await seedCase({ status: 'scheduled', labs: 'pending' });
    const log = await recordProcedureLog(id, { tenantId: TENANT, procedure_type: 'PTCA' }, ctx());
    const row = await caseRow(id);
    expect(row.status).toBe('in_progress');
    expect(row.snapshot).toMatchObject({ via: 'procedure_log', procedure_log_id: Number(log.id), reason: null });
    expect(await startAudits(id)).toHaveLength(1);
  }, 60000);

  test('a clean start snapshots empty blocking and writes no audit row', async () => {
    const id = await seedCase({ status: 'ready', labs: 'pass' });
    await transitionCaseStatus(id, { tenantId: TENANT, status: 'in_progress' }, ctx());
    expect((await caseRow(id)).snapshot.blocking).toEqual([]);
    expect(await startAudits(id)).toHaveLength(0);
  }, 60000);

  test('a log on a completed case leaves it completed; on a cancelled case nothing is written', async () => {
    const done = await seedCase({ status: 'ready', labs: 'pass' });
    await transitionCaseStatus(done, { tenantId: TENANT, status: 'in_progress' }, ctx());
    await transitionCaseStatus(done, { tenantId: TENANT, status: 'completed' }, ctx());
    await recordProcedureLog(done, { tenantId: TENANT, procedure_type: 'PTCA', status: 'amended' }, ctx());
    expect((await caseRow(done)).status).toBe('completed');
    const gone = await seedCase({ status: 'scheduled' });
    await transitionCaseStatus(gone, { tenantId: TENANT, status: 'cancelled', reason: 'x' }, ctx());
    await expect(recordProcedureLog(gone, { tenantId: TENANT, procedure_type: 'PTCA' }, ctx())).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    const logs = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM cath_procedure_logs WHERE tenant_id = $1::uuid AND case_id = $2::bigint`, TENANT, gone);
    expect(logs[0].n).toBe(0);
  }, 60000);

  test('after start: a real sign-off reaches the item through the hook, the check passes late, the case stays in_progress', async () => {
    // Seed six fresh results (everything but HGB), start with labs pending, then
    // record + sign off HGB through the lab rail — the same path as the suite's
    // existing "real sign-off" test — and poll the item.
    …(follow the existing 'the real sign-off path moves the item to result_final' test for the lab calls)…
    expect(await pollForItemOnCase(id, 'hb', (row) => row?.state === 'result_final')).toBeTruthy();
    const check = await labsCheckFor(id);
    expect(check.status).toBe('pass');
    expect(new Date(check.completed_at).getTime()).toBeGreaterThan(new Date((await caseRow(id)).actual_start_at).getTime());
    const audit = await prisma.$queryRawUnsafe(`SELECT metadata FROM audit_logs WHERE tenant_id = $1::uuid AND action = 'cath_lab.readiness.labs.auto_pass' AND metadata->>'case_id' = $2::text ORDER BY id DESC LIMIT 1`, TENANT, String(id));
    expect(audit[0].metadata.passed_after_start).toBe(true);
    expect((await caseRow(id)).status).toBe('in_progress');
  }, 60000);

  test('REGIME PAIR: pre-start stale still flips; post-start stale age alone does not, and the item still reads stale', async () => {
    const id = await seedCase({ status: 'scheduled', labs: 'pending' });
    // seed all seven fresh → auto-pass
    …(seedResult for each item code as the suite's 'all results present' test does, for THIS patient; the items are per patient so use a second patient uid for isolation, or cancel earlier rows)…
    expect((await refreshCaseLabReadiness({ tenantId: TENANT, caseId: id, context: ctx() })).check_status).toBe('pass');
    await ageHgb(45);
    // PRE-start: Plan 3's rule — the regime this lane does not change.
    expect((await refreshCaseLabReadiness({ tenantId: TENANT, caseId: id, context: ctx() })).check_status).toBe('pending');
    await ageHgb(1);
    expect((await refreshCaseLabReadiness({ tenantId: TENANT, caseId: id, context: ctx() })).check_status).toBe('pass');
    await transitionCaseStatus(id, { tenantId: TENANT, status: 'in_progress' }, ctx());
    await ageHgb(45);
    // POST-start: age alone holds the check; the picture stays truthful.
    const after = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: id, context: ctx() });
    expect(after.check_status).toBe('pass');
    expect(after.items.find((i) => i.item_code === 'hb').state).toBe('stale');
    expect(after.missing).toEqual([{ item: 'hb', state: 'stale' }]);
  }, 60000);

  test('after start: a critical result arriving mid-procedure is reported and does not move the status', async () => {
    …(start a case with all seven fresh and the check auto-passed; then seedResult({ code: 'K', value: '6.9', numeric: 6.9, flag: 'HH', critical: true }) for the case's patient and refresh)…
    const block = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: id, context: ctx() });
    expect(block.check_status).toBe('pass');
    expect(block.critical_warning).toBe(true);
    expect(block.critical_items).toContain('potassium');
    expect(block.items.find((i) => i.item_code === 'potassium').resulted_after_start).toBe(true);
  }, 60000);

  test('after start: order-missing places STAT orders marked ordered_after_start; an outside result is accepted and marked', async () => {
    const id = await seedCase({ status: 'readiness_pending', labs: 'pending' });
    await transitionCaseStatus(id, { tenantId: TENANT, status: 'in_progress', reason: 'r' }, ctx());
    const ordered = await orderMissingLabs(id, { tenantId: TENANT }, ctx());
    expect(ordered.created.length).toBeGreaterThan(0);
    const inv = await prisma.$queryRawUnsafe(`SELECT priority FROM investigations WHERE tenant_id = $1::uuid AND id = $2::int`, TENANT, ordered.created[0].investigation_id);
    expect(inv[0].priority).toBe('STAT');
    expect(ordered.readiness.items.find((i) => i.item_code === 'hb').ordered_after_start).toBe(true);
    const ext = await recordExternalLabResult(id, 'hcv', { tenantId: TENANT, value_text: 'Non-reactive', external_lab_name: 'Outside Lab', external_reported_on: istDaysAgo(1) }, ctx());
    expect(ext.readiness.items.find((i) => i.item_code === 'hcv')).toMatchObject({ state: 'external_recorded', resulted_after_start: true });
  }, 60000);
```

Write the elided fixture lines fully when implementing, copying the suite's own `seedResult` / sign-off calls; add `pollForItemOnCase(id, …)` and `labsCheckFor(id)` as case-parameterised twins of the existing helpers.

- [ ] **Step 8: Run the deep suite on the scratch DB**

Run: `DATABASE_URL=… npm test -- --testPathPatterns cath-lab-readiness.deep`
Expected: PASS, with `Suites failed: 0` read separately from `Tests passed`.

- [ ] **Step 9: Mutation checks (apply, run, confirm red, revert)**

1. Delete `started &&` from `agedOnly` → `'pre-start: a stale required item still retracts …'` (unit) red and the REGIME PAIR deep test red at the pre-start assertion; `'post-start: staleness alone never retracts'` stays green.
2. Restore `AND actual_start_at IS NULL` in `refreshOpenCasesForPatient` → `'after start: a real sign-off reaches the item …'` red.
3. Make `afterCaseStartMs` return `false` → the late-order deep test and the resolver marker table red.

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/services/clinical/cathLabReadinessService.js apps/backend/src/services/clinical/cathLabReadinessActions.js apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs apps/backend/src/tests/unit/cathLabReadinessService.test.js apps/backend/src/tests/unit/cathLabReadinessServiceOrders.test.js apps/backend/src/tests/cath-lab-readiness.deep.test.js
# plus cathLabRouteGuards.test.js and cathLabRoutes.js only in decision 9's REMOVED branch
git commit -m "feat(cath): the checklist keeps living after start — refresh reaches started cases, late orders STAT, outside results accepted, lateness marked

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
## Task 4: The readiness picture — day list, projection, OpenAPI, canary

**Files:**
- Modify: `apps/backend/src/services/clinical/cathLabService.js` (`listCases`, `labReadinessSummaries`)
- Modify: `apps/backend/src/services/clinical/cathLabReadinessProjection.js`
- Modify: `apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs`
- Test: `apps/backend/src/tests/unit/cathLabReadinessProjection.test.js`, `apps/backend/src/tests/unit/cathLabReadinessOpenApiSource.test.js`, `apps/backend/src/tests/unit/serologyDisclosureCanary.test.js`, `apps/backend/src/tests/cath-lab-readiness.deep.test.js` (day-list key set)

- [ ] **Step 1: Write the failing projection tests**

In `cathLabReadinessProjection.test.js`:

```js
describe('the start reason is the one free-text field, and it is projected (spec §6.4)', () => {
  const block = {
    case_id: 1, items: [], critical_items: [], case_started: true, started_with_readiness_pending: true,
    readiness_at_start: { recorded_at: 'x', via: 'status', procedure_log_id: null, urgency: 'emergency', reason: 'HBsAg reactive, proceeding', blocking: [{ check_type: 'labs', reason: 'pending' }], missing_lab_items: ['hbsag'], lab_snapshot_as_of: null },
  };
  test('a non-entitled role reads the snapshot with reason null and every other key intact', () => {
    const out = projectLabReadinessForRole(block, 'RECEPTIONIST');
    expect(Object.keys(out.readiness_at_start)).toEqual(Object.keys(block.readiness_at_start));
    expect(out.readiness_at_start).toMatchObject({ reason: null, missing_lab_items: ['hbsag'], blocking: block.readiness_at_start.blocking });
    expect(out.started_with_readiness_pending).toBe(true);
  });
  test('an entitled role reads it unchanged; a null snapshot passes through', () => {
    expect(projectLabReadinessForRole(block, 'CATH_LAB_STAFF')).toBe(block);
    expect(projectLabReadinessForRole({ ...block, readiness_at_start: null }, 'RECEPTIONIST').readiness_at_start).toBeNull();
  });
  test('projectStartReasonForRole is the same predicate, exported for the report', () => {
    expect(projectStartReasonForRole('r', 'RECEPTIONIST')).toBeNull();
    expect(projectStartReasonForRole('r', 'QUALITY_OFFICER')).toBeNull();
    expect(projectStartReasonForRole('r', 'ADMIN')).toBe('r');
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `npm test -- --testPathPatterns unit/cathLabReadinessProjection`. Expected: FAIL.

- [ ] **Step 3: Implement the projection**

In `cathLabReadinessProjection.js`:

```js
/** The start reason for `role`: the one free-text field on the readiness picture. */
export function projectStartReasonForRole(reason, role) {
  return roleSeesSerologyDetail(role) ? (reason ?? null) : null;
}
```

and in `projectLabReadinessForRole`, after the entitled early return, treat a present `readiness_at_start` object as a third reason to project: `const hasSnapshot = readiness.readiness_at_start && typeof readiness.readiness_at_start === 'object';` include it in the `if (!hasItems && !hasCriticalItems && !hasSnapshot) return readiness;` guard, and `if (hasSnapshot) projected.readiness_at_start = { ...readiness.readiness_at_start, reason: null };`. Extend the header comment: the snapshot's codes and booleans are checklist provenance like `recorded_after_start`; the reason is typed at the table and may name a value, so it is blanked.

- [ ] **Step 4: Run** — expected PASS.

- [ ] **Step 5: Day-list summary flag**

`listCases` SELECT gains, beside `c.updated_at,`:

```sql
            CASE WHEN jsonb_typeof(c.metadata->'readiness_at_start'->'blocking') = 'array'
                 THEN jsonb_array_length(c.metadata->'readiness_at_start'->'blocking') > 0
                 ELSE FALSE END AS started_with_readiness_pending,
```

In the row mapping where `lab_readiness_summary` is attached, fold it: `lab_readiness_summary: summary ? { ...summary, started_with_readiness_pending: row.started_with_readiness_pending === true } : null` and **delete** `started_with_readiness_pending` from the row object before returning (the row key set must not change). Update the deep test `'the case list carries the STORED readiness summary'` key-set array to include `'started_with_readiness_pending'` (sorted position: after `'missing_items'`).

- [ ] **Step 6: OpenAPI overlay**

In `cathLabReadiness.mjs`:
- `item.required` gains `'ordered_after_start', 'resulted_after_start'`; properties: both `{ type: 'boolean', description: … }` (order placed after `actual_start_at`; deciding result received here after `actual_start_at`; "after" is transaction-start ordering).
- `readiness.required` gains `'started_with_readiness_pending', 'readiness_at_start'`; properties: `started_with_readiness_pending: { type: 'boolean' }`, `readiness_at_start: { type: 'object', nullable: true, additionalProperties: false, required: [...START_SNAPSHOT_KEYS], properties: { recorded_at: {type:'string',format:'date-time'}, via: {type:'string', enum:['status','procedure_log']}, procedure_log_id: {type:'integer', nullable:true}, urgency: {type:'string', nullable:true}, reason: {type:'string', nullable:true, description:'Projected: null for roles outside the serology audience.'}, blocking: {type:'array', items:{type:'object', additionalProperties:false, required:['check_type','reason'], properties:{check_type:{type:'string', enum: CHECK_TYPES}, reason:{type:'string'}}}}, missing_lab_items: {type:'array', items:{type:'string', enum: ITEMS}}, lab_snapshot_as_of: {type:'string', format:'date-time', nullable:true} } }` — import `START_SNAPSHOT_KEYS` from the rules module the way the file already imports `ITEMS` etc., and define `CHECK_TYPES` as the eight names (the source pin compares them to migration 482's CHECK).
- `case_started` description per Task 3 Step 6.
- `operations` gains two prose-only entries: `'POST /api/v1/cath-lab/cases/{id}/status'` (describes `in_progress` from `scheduled|readiness_pending|ready`, `reason` required when the gate is not clear → 400 `CATH_LAB_START_REASON_REQUIRED` with `details.blocking`, consent not `pass` → 400 `CATH_LAB_CONSENT_REQUIRED`, the snapshot on the returned case's `metadata.readiness_at_start`) and `'POST /api/v1/cath-lab/cases/{id}/procedure-logs'` (a log on a start-eligible case starts it through the same path with `start_reason` optional; the same consent block; a log on `in_progress` / `completed` leaves the case alone; `cancelled` is refused). Both with `pathParameters: { id: BIGINT_WIRE }` and no `request` / `response`.
- The day-list description names `started_with_readiness_pending` as the seventh summary key.

In `cathLabReadinessOpenApiSource.test.js`: `PROSE_ONLY` gains the two keys (`STATUS`, `PROCEDURE_LOGS`); the readiness key-set assertion gains the two keys; add `it('readiness_at_start declares exactly START_SNAPSHOT_KEYS and its check_type enum is migration 482\'s')`; the item key set is derived by driving the resolver so it picks the two booleans up by construction — confirm the `required` list edit matches.

Run: `npm test -- --testPathPatterns unit/cathLabReadinessOpenApiSource` → PASS; then `npm run openapi:generate && npm run openapi:check` → clean, and commit the regenerated `src/docs/openapi.json` and `packages/vhhealth_core/swagger/openapi.json`.

- [ ] **Step 7: Canary — fixture, disclosure predicate, positive control, liveness**

In `serologyDisclosureCanary.test.js`:
- `const START_REASON_SENTINEL = 'START-REASON-SENTINEL-7f3a';` `CASE_ROW` gains `actual_start_at: OBSERVED, actual_start_at_epoch_ms: BigInt(new Date(OBSERVED).getTime()), started_with_readiness_pending: true, readiness_at_start: { recorded_at: OBSERVED, via: 'status', procedure_log_id: null, urgency: 'emergency', reason: START_REASON_SENTINEL, blocking: [{ check_type: 'labs', reason: 'pending' }], missing_lab_items: ['hbsag'], lab_snapshot_as_of: OBSERVED }, metadata: { readiness_at_start: <same object> }`.
- In `disclosures()`: `if (serialised.includes(START_REASON_SENTINEL)) leaks.push('the serialised body contains the start-reason sentinel');` and, in the walk, `if (node.readiness_at_start && typeof node.readiness_at_start === 'object' && node.readiness_at_start.reason != null) leaks.push(\`${path}.readiness_at_start.reason is populated\`);` plus the report-row form `if (Array.isArray(node.rows)) node.rows.forEach((row, i) => { if (row?.reason != null) leaks.push(\`${path}.rows[${i}].reason is populated\`); });`.
- Positive control (in the `'the poison really is in the persistence layer'` describe): CATH_LAB_STAFF on `GET /api/v1/cath-lab/cases/:id/readiness/labs` reads `readiness_at_start.reason === START_REASON_SENTINEL`, `started_with_readiness_pending: true`, `missing_lab_items: ['hbsag']`, and every item has boolean `ordered_after_start` / `resulted_after_start` / `recorded_after_start`.
- Liveness: RECEPTIONIST on the same route answers 200 with `readiness_at_start.reason === null`, the same `blocking` and `missing_lab_items`, and the three booleans present on every item.
- Summary key set (`'the case LIST really carries a readiness summary'`): add `'started_with_readiness_pending'`; assert it is `true` for the fixture.

Run: `npm test -- --testPathPatterns unit/serologyDisclosureCanary`. Expected: PASS with **no** reachable-set change yet (the report routes come in Task 5).

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/services/clinical/cathLabService.js apps/backend/src/services/clinical/cathLabReadinessProjection.js apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs apps/backend/src/docs/openapi.json packages/vhhealth_core/swagger/openapi.json apps/backend/src/tests/unit/cathLabReadinessProjection.test.js apps/backend/src/tests/unit/cathLabReadinessOpenApiSource.test.js apps/backend/src/tests/unit/serologyDisclosureCanary.test.js apps/backend/src/tests/cath-lab-readiness.deep.test.js
git commit -m "feat(cath): readiness picture shows lateness — snapshot + after-start booleans on the contract, day-list flag, reason projected, canary extended

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 5: Monthly report of starts with checks pending

**Files:**
- Modify: `apps/backend/src/utils/roleHelpers.js`
- Create: `apps/backend/src/services/clinical/cathStartsWithPendingReportService.js`
- Create: `apps/backend/src/routes/clinical/cathStartsWithPendingReportHandler.js`
- Modify: `apps/backend/src/routes/clinical/cathLabRoutes.js`, `apps/backend/src/routes/clinical/cathReprocessingPolicyRoutes.js`
- Modify: `apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs`
- Create: `apps/backend/src/tests/unit/cathStartsWithPendingReportService.test.js`
- Test: `apps/backend/src/tests/unit/cathLabReadinessOpenApiSource.test.js`, `apps/backend/src/tests/unit/serologyDisclosureCanary.test.js` + `apps/backend/src/tests/fixtures/serologyDisclosureCanary.reachable.json`, `apps/backend/src/tests/cath-lab-readiness.deep.test.js`, the roleHelpers unit test (find it: `grep -rl CATH_LAB_WORKFLOW_ROLES src/tests/unit`)

- [ ] **Step 1: Write the failing unit tests**

`cathStartsWithPendingReportService.test.js`:

```js
import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenant: jest.fn(async (_tenantId, fn) => fn({ $queryRawUnsafe: queryRawUnsafe })),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
}));

const {
  monthBoundsIst, startsWithPendingReport, reportToCsv, projectReportForRole,
} = await import('../../services/clinical/cathStartsWithPendingReportService.js');

const TENANT = '00000000-0000-4000-8000-0000000c1a00';
const ROW = {
  id: 1, started_at: new Date('2026-09-05T23:01:07.412Z'), actor_uid: 'a-uid', actor_role: 'CONSULTANT', actor_name: 'Dr A',
  case_id: '1201', facility_id: 4, facility_name: 'Main block',
  metadata: { case_id: 1201, facility_id: 4, via: 'status', urgency: 'emergency', reason: '=HBsAg reactive, proceeding', blocking: [{ check_type: 'labs', reason: 'pending' }, { check_type: 'timeout', reason: 'pending' }], missing_lab_items: ['hbsag'] },
};

beforeEach(() => queryRawUnsafe.mockReset());

describe('month', () => {
  test('bounds are the IST calendar month, as UTC instants', () => {
    expect(monthBoundsIst('2026-09')).toEqual({ start: '2026-08-31T18:30:00.000Z', end: '2026-09-30T18:30:00.000Z' });
    expect(monthBoundsIst('2026-12').end).toBe('2026-12-31T18:30:00.000Z');
  });
  test('a missing or malformed month is a 400 that names the code', async () => {
    for (const month of [undefined, '', '2026-13', '2026-9', 'September', '2026-09-01']) {
      await expect(startsWithPendingReport({ tenantId: TENANT, month })).rejects.toMatchObject({ code: 'CATH_LAB_REPORT_MONTH_INVALID', statusCode: 400 });
    }
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('the report', () => {
  test('binds the bounds, folds per facility, and maps a row to codes + the reason', async () => {
    queryRawUnsafe.mockResolvedValueOnce([ROW, { ...ROW, id: 2, case_id: '1202', facility_id: 7, facility_name: 'Annexe', metadata: { ...ROW.metadata, facility_id: 7, urgency: 'routine', missing_lab_items: [] } }]);
    const report = await startsWithPendingReport({ tenantId: TENANT, month: '2026-09' });
    const [sql, tenant, start, end] = queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/FROM audit_logs a/);
    expect(sql).toMatch(/action = 'cath_lab.case.started_with_readiness_pending'/);
    expect(sql).toMatch(/AT TIME ZONE 'UTC'\) >= \$2::timestamptz/);
    expect([tenant, start, end]).toEqual([TENANT, '2026-08-31T18:30:00.000Z', '2026-09-30T18:30:00.000Z']);
    expect(report.month).toBe('2026-09');
    expect(report.total).toBe(2);
    expect(report.facilities).toEqual([{ facility_id: 4, facility_name: 'Main block', count: 1 }, { facility_id: 7, facility_name: 'Annexe', count: 1 }]);
    expect(report.rows[0]).toEqual({
      case_id: 1201, facility_id: 4, facility_name: 'Main block', urgency: 'emergency', via: 'status',
      started_at: '2026-09-05T23:01:07.412Z', blocking_check_types: ['labs', 'timeout'], missing_lab_items: ['hbsag'],
      reason: '=HBsAg reactive, proceeding', actor_uid: 'a-uid', actor_role: 'CONSULTANT', actor_name: 'Dr A',
    });
  });
  test('a row with no facility on the audit metadata folds under facility_id null', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{ ...ROW, facility_id: null, facility_name: null, metadata: { ...ROW.metadata, facility_id: null } }]);
    const report = await startsWithPendingReport({ tenantId: TENANT, month: '2026-09' });
    expect(report.facilities).toEqual([{ facility_id: null, facility_name: null, count: 1 }]);
  });
});

describe('projection and CSV', () => {
  const report = { month: '2026-09', total: 1, facilities: [], rows: [{ case_id: 1201, facility_id: 4, facility_name: 'Main block', urgency: 'emergency', via: 'status', started_at: 'x', blocking_check_types: ['labs', 'timeout'], missing_lab_items: ['hbsag'], reason: '=HBsAg reactive, proceeding', actor_uid: 'a', actor_role: 'CONSULTANT', actor_name: 'Dr A' }] };
  test('reason is blanked for a role outside the serology audience and kept for one inside it', () => {
    expect(projectReportForRole(report, 'QUALITY_OFFICER').rows[0].reason).toBeNull();
    expect(projectReportForRole(report, 'ADMIN').rows[0].reason).toBe('=HBsAg reactive, proceeding');
    expect(Object.keys(projectReportForRole(report, 'QUALITY_OFFICER').rows[0])).toEqual(Object.keys(report.rows[0]));
  });
  test('CSV: fixed columns, lists joined with ;, formula-leading reason neutralised, CRLF', () => {
    const csv = reportToCsv(report);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('month,facility_id,facility_name,case_id,urgency,via,started_at,blocking_check_types,missing_lab_items,reason,actor_uid,actor_role,actor_name');
    expect(lines[1]).toBe(`2026-09,4,Main block,1201,emergency,status,x,labs;timeout,hbsag,"'=HBsAg reactive, proceeding",a,CONSULTANT,Dr A`);
    expect(reportToCsv(projectReportForRole(report, 'QUALITY_OFFICER')).split('\r\n')[1]).toContain(',hbsag,,a,');
  });
});
```

roleHelpers test: `expect(CATH_READINESS_REPORT_ROLES).toEqual(['ADMIN', 'SUPER_ADMIN', 'CATH_LAB_INCHARGE', 'QUALITY_OFFICER'])` and `canReadCathReadinessReport('QUALITY_OFFICER') === true`, `('INFECTION_CONTROL_OFFICER') === false`, `('RECEPTIONIST') === false`.

- [ ] **Step 2: Run to verify they fail** — `npm test -- --testPathPatterns "unit/cathStartsWithPendingReportService|roleHelpers"`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement roles and the service**

`roleHelpers.js`, after `CATH_LAB_WORKFLOW_ROLES`:

```js
// The monthly starts-with-checks-pending report (spec 2026-09-06 §7): the
// platform-admin, the cath lab's manager role and the quality officer. Named
// from the existing vocabulary — CATH_LAB_INCHARGE is the cath lab manager;
// there is no CATH_LAB_MANAGER role. The quality officer reaches the report on
// the governance mount, because the cath mount never admits that role.
export const CATH_READINESS_REPORT_ROLES = [
  ROLES.ADMIN,
  'SUPER_ADMIN',
  ROLES.CATH_LAB_INCHARGE,
  ROLES.QUALITY_OFFICER,
];
export const canReadCathReadinessReport = role => CATH_READINESS_REPORT_ROLES.includes(normalizedRole(role));
```

`cathStartsWithPendingReportService.js`:

```js
// apps/backend/src/services/clinical/cathStartsWithPendingReportService.js
//
// The monthly report of cath cases started with readiness checks pending
// (spec 2026-09-06 §7). A QUERY over the audit rows startCaseTx writes
// (action cath_lab.case.started_with_readiness_pending) — no table of its own,
// no index of its own: idx_audit_logs_tenant_time_id and the action index
// already cover a month of one tenant's starts.
import { setTenant } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { rowsToCsv } from '../../utils/csv.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { projectStartReasonForRole } from './cathLabReadinessProjection.js';

export const START_AUDIT_ACTION = 'cath_lab.case.started_with_readiness_pending';
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const CSV_COLUMNS = Object.freeze([
  'month', 'facility_id', 'facility_name', 'case_id', 'urgency', 'via', 'started_at',
  'blocking_check_types', 'missing_lab_items', 'reason', 'actor_uid', 'actor_role', 'actor_name',
]);

// The ward's month is the IST calendar month (the convention clinicalDate()
// and the day list use). Returned as UTC instants for the bind.
export function monthBoundsIst(month) {
  const match = MONTH.exec(String(month ?? '').trim());
  if (!match) {
    throw AppError.badRequest('month must be YYYY-MM', 'CATH_LAB_REPORT_MONTH_INVALID');
  }
  const year = Number(match[1]);
  const mon = Number(match[2]);
  const start = new Date(`${match[1]}-${match[2]}-01T00:00:00+05:30`);
  const nextYear = mon === 12 ? year + 1 : year;
  const nextMon = mon === 12 ? 1 : mon + 1;
  const end = new Date(`${nextYear}-${String(nextMon).padStart(2, '0')}-01T00:00:00+05:30`);
  return { start: start.toISOString(), end: end.toISOString() };
}

function codes(list) {
  return Array.isArray(list) ? list.map((value) => String(value)) : [];
}

function rowFrom(row) {
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return {
    case_id: Number(row.case_id),
    facility_id: row.facility_id == null ? null : Number(row.facility_id),
    facility_name: row.facility_name ?? null,
    urgency: meta.urgency ?? null,
    via: meta.via ?? null,
    started_at: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
    blocking_check_types: Array.isArray(meta.blocking) ? meta.blocking.map((entry) => String(entry?.check_type)) : [],
    missing_lab_items: codes(meta.missing_lab_items),
    reason: meta.reason ?? null,
    actor_uid: row.actor_uid ?? null,
    actor_role: row.actor_role ?? null,
    actor_name: row.actor_name ?? null,
  };
}

export async function startsWithPendingReport({ tenantId, month } = {}) {
  const tid = requireTenantId(tenantId);
  const { start, end } = monthBoundsIst(month);
  // audit_logs.created_at is timestamp(6) WITHOUT time zone, written by NOW()
  // under UTC-pinned sessions: read it back as UTC before comparing to the
  // IST month bounds (spec §7.1, said once there and once here).
  const rows = await setTenant(tid, (client) => client.$queryRawUnsafe(
    `SELECT a.id, a.created_at AS started_at, a.actor_uid, a.role AS actor_role, u.name AS actor_name,
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
        AND a.action = '${START_AUDIT_ACTION}'
        AND (a.created_at AT TIME ZONE 'UTC') >= $2::timestamptz
        AND (a.created_at AT TIME ZONE 'UTC') <  $3::timestamptz
      ORDER BY a.created_at DESC, a.id DESC`,
    tid, start, end,
  ));
  const mapped = rows.map(rowFrom);
  const byFacility = new Map();
  for (const row of mapped) {
    const key = row.facility_id ?? 'null';
    const entry = byFacility.get(key) || { facility_id: row.facility_id, facility_name: row.facility_name, count: 0 };
    entry.count += 1;
    byFacility.set(key, entry);
  }
  return {
    month: String(month).trim(),
    total: mapped.length,
    facilities: [...byFacility.values()].sort((a, b) => (a.facility_id ?? Infinity) - (b.facility_id ?? Infinity)),
    rows: mapped,
  };
}

export function projectReportForRole(report, role) {
  return { ...report, rows: report.rows.map((row) => ({ ...row, reason: projectStartReasonForRole(row.reason, role) })) };
}

export function reportToCsv(report) {
  return rowsToCsv([...CSV_COLUMNS], report.rows.map((row) => [
    report.month, row.facility_id, row.facility_name, row.case_id, row.urgency, row.via, row.started_at,
    row.blocking_check_types.join(';'), row.missing_lab_items.join(';'), row.reason,
    row.actor_uid, row.actor_role, row.actor_name,
  ]));
}
```

(`START_AUDIT_ACTION` is interpolated as a compile-time constant of this module, not a caller value; `lint:raw-params` accepts a module constant — if it does not, bind it as `$4`.)

- [ ] **Step 4: Run the unit tests** — expected PASS.

- [ ] **Step 5: The handler, registered on both mounts**

`cathStartsWithPendingReportHandler.js`:

```js
// apps/backend/src/routes/clinical/cathStartsWithPendingReportHandler.js
//
// GET .../reports/starts-with-pending?month=YYYY-MM[&format=csv] — ONE handler,
// registered twice (the cathDeviceHistoryHandler precedent):
//   /api/v1/cath-lab/reports/starts-with-pending           (cath mount: ADMIN,
//     SUPER_ADMIN, CATH_LAB_INCHARGE reach it; the mount never admits a
//     quality officer, and a route gate under a prefix mount cannot add one)
//   /api/v1/cath-reprocessing/reports/starts-with-pending  (governance mount:
//     QUALITY_OFFICER reaches it here)
// Both registrations carry requireRole(...CATH_READINESS_REPORT_ROLES). The
// report names no patient — case ids are internal keys — so it writes no
// per-patient access rows. The one free-text column, reason, is projected
// through the serology audience predicate before it leaves, JSON and CSV alike.
import {
  projectReportForRole,
  reportToCsv,
  startsWithPendingReport,
} from '../../services/clinical/cathStartsWithPendingReportService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { relayAppError, success } from '../../utils/responseHelper.js';

export default async function cathStartsWithPendingReportHandler(req, res) {
  try {
    const tenantId = resolveTenantOrThrow(req);
    const role = req.user?.role || req.user?.rawRole || null;
    const report = projectReportForRole(
      await startsWithPendingReport({ tenantId, month: req.query?.month }),
      role,
    );
    if (String(req.query?.format || '').toLowerCase() === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="cath-starts-with-pending-${report.month}.csv"`);
      return res.status(200).send(reportToCsv(report));
    }
    return success(res, report, 'Cath starts with readiness pending');
  } catch (err) {
    return relayAppError(res, err, 'Failed to build the starts-with-pending report');
  }
}
```

`cathLabRoutes.js`: import `requireRole` from `'../../middleware/rbacMiddleware.js'`, `CATH_READINESS_REPORT_ROLES` from roleHelpers, and the handler; register **immediately before** `router.get('/reports/:id/pdf', …)` (which itself precedes `/reports/:id`):

```js
// Static segment BEFORE `/reports/:id`, or the report guard would read
// "starts-with-pending" as a report id (spec §7.1).
router.get('/reports/starts-with-pending', requireRole(...CATH_READINESS_REPORT_ROLES), cathStartsWithPendingReportHandler);
```

`cathReprocessingPolicyRoutes.js`: the same line after the device-history registration, with a comment naming why the quality officer reads it here.

- [ ] **Step 6: Route-order and role tests**

Add to `cathLabRouteGuards.test.js` (or a sibling suite already driving the cath router with supertest) two probes: `GET /reports/starts-with-pending?month=2026-09` as ADMIN answers 200 (not the report guard's 400/404), and as RECEPTIONIST answers 403; and in a governance-router probe QUALITY_OFFICER answers 200 while INFECTION_CONTROL_OFFICER answers 403. Run them.

- [ ] **Step 7: OpenAPI**

`cathLabReadiness.mjs`: schemas `CathLabStartsWithPendingRow` (additionalProperties:false, the thirteen row keys), `CathLabStartsWithPendingReport` (`month`, `total`, `facilities[]`, `rows[]`), `CathLabStartsWithPendingReportResponse: envelope('CathLabStartsWithPendingReport')`; operations for both paths: `summary`, description (audit-backed, IST month, reason projected, CSV via `format=csv`, 400 `CATH_LAB_REPORT_MONTH_INVALID` in prose), `parameters: [{ name: 'month', in: 'query', required: true, schema: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' } }, { name: 'format', in: 'query', required: false, schema: { type: 'string', enum: ['json', 'csv'] } }]`, `response: 'CathLabStartsWithPendingReportResponse'`. In the source pin: `READS` gains both. `npm run openapi:generate && npm run openapi:check`.

- [ ] **Step 8: Canary — fixture and snapshot**

`SEEDED` gains `audit_logs: [START_AUDIT_ROW]` where `START_AUDIT_ROW = { id: 77, tenant_id: TENANT, started_at: OBSERVED, actor_uid: ACTOR, actor_role: 'DOCTOR', actor_name: 'Canary Staff', case_id: '10', metadata: { case_id: 10, facility_id: 4, via: 'status', urgency: 'emergency', reason: START_REASON_SENTINEL, blocking: [{ check_type: 'labs', reason: 'pending' }], missing_lab_items: ['hbsag'] }, facility_id: 4, facility_name: 'Canary facility' }`. Check `unstubbed` / the coverage note for any other `FROM audit_logs` reader now answered by this row. `fillParams` needs no change (no path params); the walker needs the query string: extend `mountUrl` (or the per-route request builder) to append `?month=2026-09` when the route path ends with `/reports/starts-with-pending`.

Regenerate the snapshot once, read the diff, rerun:

```bash
CANARY_WRITE_SNAPSHOT=1 npm test -- --testPathPatterns unit/serologyDisclosureCanary   # fails deliberately after writing
git diff --stat src/tests/fixtures/serologyDisclosureCanary.reachable.json
npm test -- --testPathPatterns unit/serologyDisclosureCanary
```

Expected diff: exactly two new keys — `GET /api/v1/cath-lab/reports/starts-with-pending: [ADMIN, CATH_LAB_INCHARGE, SUPER_ADMIN]` and `GET /api/v1/cath-reprocessing/reports/starts-with-pending: [ADMIN, QUALITY_OFFICER, SUPER_ADMIN]`; no existing entry grows or shrinks. Add the positive control (ADMIN reads the sentinel in `rows[0].reason` on the cath mount) and the liveness check (QUALITY_OFFICER on the governance mount answers 200 with `rows[0].reason === null`, `missing_lab_items: ['hbsag']`, `blocking_check_types: ['labs']`).

- [ ] **Step 9: Deep test**

Append to the deep suite: after the status-path test's case has started (or a fresh one), `startsWithPendingReport({ tenantId: TENANT, month: <current IST month via clinicalDate(new Date()).slice(0, 7)> })` returns it under `FACILITY_ID` with `reason` present; `projectReportForRole(report, 'QUALITY_OFFICER').rows[0].reason === null`; `reportToCsv(report).split('\r\n').length >= 2`. Run the deep suite.

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/utils/roleHelpers.js apps/backend/src/services/clinical/cathStartsWithPendingReportService.js apps/backend/src/routes/clinical/cathStartsWithPendingReportHandler.js apps/backend/src/routes/clinical/cathLabRoutes.js apps/backend/src/routes/clinical/cathReprocessingPolicyRoutes.js apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs apps/backend/src/docs/openapi.json packages/vhhealth_core/swagger/openapi.json apps/backend/src/tests/unit/cathStartsWithPendingReportService.test.js apps/backend/src/tests/unit/cathLabReadinessOpenApiSource.test.js apps/backend/src/tests/unit/serologyDisclosureCanary.test.js apps/backend/src/tests/fixtures/serologyDisclosureCanary.reachable.json apps/backend/src/tests/unit/cathLabRouteGuards.test.js apps/backend/src/tests/cath-lab-readiness.deep.test.js
# plus the roleHelpers unit test file
git commit -m "feat(cath): monthly report of starts with checks pending — audit-backed, both mounts, CSV, reason projected

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
## Task 6: Staff app — start affordance, banners, chips, open gates

**Files:**
- Modify: `apps/staff/lib/features/cath_lab/models/cath_readiness_models.dart`
- Modify: `apps/staff/lib/features/cath_lab/services/cath_lab_api_service.dart`
- Modify: `apps/staff/lib/features/cath_lab/widgets/cath_readiness_checklist.dart`
- Modify: `apps/staff/lib/features/cath_lab/widgets/cath_lab_readiness_panel.dart`
- Modify: `apps/staff/lib/features/cath_lab/screens/cath_lab_screen.dart`
- Modify: `apps/staff/lib/l10n/app_strings.dart`
- Test: `apps/staff/test/features/cath_lab/cath_readiness_checklist_test.dart`, `apps/staff/test/features/cath_lab/cath_lab_screen_test.dart`, `apps/staff/test/i18n_guard_test.dart`

- [ ] **Step 1: Models — failing parse tests**

In `cath_readiness_checklist_test.dart` (model group) add:

```dart
  test('parses the start snapshot, the after-start booleans and the summary flag', () {
    final labs = CathLabReadiness.fromJson({
      'case_id': 1, 'check_status': 'pending', 'auto_managed': true, 'critical_warning': false,
      'critical_items': [], 'items': [
        {'item_code': 'hb', 'required': true, 'state': 'result_final', 'is_critical': false,
         'ordered_after_start': true, 'resulted_after_start': true, 'recorded_after_start': false},
      ],
      'missing': [], 'orderable_now': [], 'open_order_codes': [],
      'settings': {'lab_validity_days': 30, 'serology_validity_days': 90, 'auto_pass': true, 'external_results_count': true, 'required_items': ['hb']},
      'case_started': true, 'started_with_readiness_pending': true,
      'readiness_at_start': {
        'recorded_at': '2026-09-06T04:31:07.412Z', 'via': 'status', 'procedure_log_id': null,
        'urgency': 'emergency', 'reason': null,
        'blocking': [{'check_type': 'labs', 'reason': 'pending'}, {'check_type': 'timeout', 'reason': 'pending'}],
        'missing_lab_items': ['hcv'], 'lab_snapshot_as_of': null,
      },
    });
    expect(labs.startedWithReadinessPending, isTrue);
    expect(labs.readinessAtStart!.blocking.map((b) => b.checkType), ['labs', 'timeout']);
    expect(labs.readinessAtStart!.missingLabItems, ['hcv']);
    expect(labs.readinessAtStart!.reason, isNull);
    expect(labs.items.single.orderedAfterStart, isTrue);
    expect(labs.items.single.resultedAfterStart, isTrue);
    final summary = CathLabReadinessSummary.fromJson({'check_status': 'pass', 'critical_warning': false, 'auto_managed': true, 'missing_count': 0, 'missing_items': [], 'live_evidence_refreshed_at': null, 'started_with_readiness_pending': true});
    expect(summary.startedWithReadinessPending, isTrue);
    final readiness = CathCaseReadiness.fromJson({'status': 'readiness_pending', 'actual_start_at': null, 'readiness': [{'check_type': 'consent', 'status': 'pass', 'required': true}], 'readiness_gate': {'ready': false, 'blocking': [{'check_type': 'labs', 'reason': 'pending'}]}, 'lab_readiness': null});
    expect(readiness.startable, isTrue);
    expect(readiness.consentPassed, isTrue);
    expect(readiness.started, isFalse);
    expect(readiness.blocking.single.checkType, 'labs');
  });
```

Run: `flutter test test/features/cath_lab/cath_readiness_checklist_test.dart` → compile error (expected).

- [ ] **Step 2: Models — implement**

`cath_readiness_models.dart`:

```dart
class CathReadinessBlocking {
  const CathReadinessBlocking({required this.checkType, required this.reason});
  final String checkType;
  final String reason;
  factory CathReadinessBlocking.fromJson(Map<String, dynamic> json) => CathReadinessBlocking(
        checkType: (json['check_type'] ?? '').toString(),
        reason: (json['reason'] ?? '').toString(),
      );
}

/// What was pending when the procedure started. Codes and booleans; the one
/// free-text line (`reason`) is null for roles outside the serology audience.
class CathReadinessStartSnapshot {
  const CathReadinessStartSnapshot({
    required this.recordedAt, required this.via, required this.urgency, required this.reason,
    required this.blocking, required this.missingLabItems,
  });
  final DateTime? recordedAt;
  final String via;
  final String? urgency;
  final String? reason;
  final List<CathReadinessBlocking> blocking;
  final List<String> missingLabItems;
  factory CathReadinessStartSnapshot.fromJson(Map<String, dynamic> json) => CathReadinessStartSnapshot(
        recordedAt: DateTime.tryParse((json['recorded_at'] ?? '').toString()),
        via: (json['via'] ?? '').toString(),
        urgency: json['urgency']?.toString(),
        reason: json['reason']?.toString(),
        blocking: (json['blocking'] is List)
            ? (json['blocking'] as List).whereType<Map>().map((m) => CathReadinessBlocking.fromJson(Map<String, dynamic>.from(m))).toList(growable: false)
            : const [],
        missingLabItems: _strings(json['missing_lab_items']),
      );
}
```

`CathLabReadinessItem`: `final bool orderedAfterStart; final bool resultedAfterStart;` parsed as `json['ordered_after_start'] == true` / `json['resulted_after_start'] == true`, both defaulting false in the constructor. `CathLabReadiness`: `final bool startedWithReadinessPending; final CathReadinessStartSnapshot? readinessAtStart;` parsed from `started_with_readiness_pending` and `readiness_at_start` (null-safe). `CathLabReadinessSummary`: `final bool startedWithReadinessPending;` parsed `== true`; `hasSignal` unchanged. `CathReadinessCheck`: `final DateTime? completedAt;` from `completed_at`; `String? get consentType => metadata['consent_type']?.toString();` (keep the raw metadata map on the model if it is not already). `CathCaseReadiness`: `final String caseStatus; final DateTime? actualStartAt; final List<CathReadinessBlocking> blocking;` from `status`, `actual_start_at`, `readiness_gate.blocking`; getters `bool get started => actualStartAt != null || caseStatus == 'in_progress';`, `bool get startable => const {'scheduled', 'readiness_pending', 'ready'}.contains(caseStatus);`, `bool get consentPassed => checks.any((c) => c.checkType == 'consent' && c.status == 'pass');`.

Run the model test → PASS.

- [ ] **Step 3: API — `startCase`**

`cath_lab_api_service.dart`, beside `refreshReadinessEvidence`:

```dart
  /// POST /cath-lab/cases/:id/status with in_progress. The route claims no
  /// idempotency key: a double tap answers the invalid-transition error from
  /// in_progress and the reload shows the case started. `reason` is required
  /// by the server only when the readiness gate is not clear
  /// (CATH_LAB_START_REASON_REQUIRED); consent not passed answers
  /// CATH_LAB_CONSENT_REQUIRED, which the checklist never lets a user reach.
  static Future<void> startCase(int caseId, {String? reason}) async {
    final response = await ApiClient.post(
      '/cath-lab/cases/$caseId/status',
      {'status': 'in_progress', if (reason != null && reason.trim().isNotEmpty) 'reason': reason.trim()},
    );
    if (response['success'] != true) {
      throw Exception(response['message']?.toString() ?? 'Could not start the procedure');
    }
  }
```

(Mirror the error-handling shape the neighbouring `refreshReadinessEvidence` uses.)

- [ ] **Step 4: Checklist — failing widget tests**

Add to `cath_readiness_checklist_test.dart`, using the suite's `_readiness(...)` builder extended with `caseStatus`, `actualStartAt`, `blocking` and per-check statuses, and a `startCase` capture in `CathReadinessDependencies`:

```dart
  testWidgets('consent not passed: the start row is disabled with the consent line and nothing posts', (tester) async { … expect(find.byKey(const ValueKey('cath-readiness-start-consent-blocked')), findsOneWidget); final button = tester.widget<FilledButton>(find.byKey(const ValueKey('cath-readiness-start'))); expect(button.onPressed, isNull); expect(started, isEmpty); });
  testWidgets('consent passed, gate clear: "Start procedure" confirms and posts without a reason', (tester) async { … tap start → tap confirm-ok → expect(started.single.reason, isNull); });
  testWidgets('consent passed, gate pending: "Start anyway" names the checks, refuses an empty reason, then posts it', (tester) async { … expect(find.textContaining('Labs'), findsWidgets); tap confirm-ok with empty notes → expect(find.text(reasonRequiredLabel), findsOneWidget); enter 'Primary PCI' → ok → expect(started.single.reason, 'Primary PCI'); });
  testWidgets('a started-with-pending case shows the amber banner, the after-start chips, and offers order / outside result', (tester) async { … findsOneWidget for 'cath-readiness-started-pending-banner', 'cath-lab-item-after-start-hb', 'cath-readiness-check-after-start-timeout', 'cath-lab-order-missing', 'cath-lab-external-hcv'; });
  testWidgets('a started case with a critical warning shows the red banner', (tester) async { … 'cath-readiness-critical-banner' findsOneWidget; });
  testWidgets('a clean start shows no banner; an unstarted case shows no start row after start', …);
  testWidgets('passing the consent check offers the consent-type chooser and sends metadata.consent_type', (tester) async { … choose 'Verbal (emergency)' → expect(updates.single.metadata?['consent_type'], 'verbal_emergency'); });
```

Invert #1018's `'a started case still offers the waiver, and keeps the order and outside-result actions closed'` second half: order and outside-result are now offered; un-waive stays closed after start per #1018.

Run → FAIL.

- [ ] **Step 5: Checklist — implement**

`cath_readiness_checklist.dart`:
- `CathReadinessDependencies` gains `this.startCase` (`typedef CathReadinessStarter = Future<void> Function(int caseId, {String? reason});`), defaulting to `CathLabApiService.startCase`. `CathReadinessCheckUpdater` gains an optional `Map<String, dynamic>? metadata` parameter, threaded to `CathLabApiService.updateReadinessCheck` (add the parameter there if absent).
- Above the eight check rows, when `readiness.startable`: a `_StartRow` widget — `FilledButton` key `cath-readiness-start`, label `s4.lib.cath_lab.readiness.start_procedure` when `readiness.blocking.isEmpty` else `s4.lib.cath_lab.readiness.start_anyway`; `onPressed: readiness.consentPassed ? () => _start(readiness) : null`; under it, when `!readiness.consentPassed`, a `Text` key `cath-readiness-start-consent-blocked` with `s4.lib.cath_lab.readiness.start_consent_blocked`.
- `_start(readiness)`: capture `caseId`; if blocking is empty, show `_CathReadinessConfirmDialog(title: start_title, body: start_body, criticalLine: null, automationNote: null, reasonRequired: false, notesLabel: confirm_notes, …)`; else body = `s.format('…start_anyway_body', {'checks': _blockingLine(s, readiness)})` where `_blockingLine` maps each blocking check through `cathReadinessCheckLabel` and appends `(hcv, hb)` from `labs?.missing` under the Labs entry, `reasonRequired: true`, `notesLabel: start_reason`. On confirm (and still mounted, same case): `await _startCase(caseId, reason: result.notes); await _reload();`. Errors go to the existing error/snackbar path.
- Banner `cath-readiness-started-pending-banner` when `labs?.startedWithReadinessPending == true`: amber container, `s.format('…started_pending_banner', {'checks': …})` from `labs.readinessAtStart!.blocking` + missing items; a second line `s.format('…started_pending_reason', {'reason': …})` only when `reason` is non-null.
- Banner `cath-readiness-critical-banner` when `labs?.caseStarted == true && labs.criticalWarning`: red, `critical_banner` with `{items}` or `critical_banner_unnamed`.
- Check-row chip `cath-readiness-check-after-start-<type>` when `check.completedAt != null && readiness.actualStartAt != null && check.completedAt!.isAfter(readiness.actualStartAt!)`, text `recorded_after_start`.
- Consent-type chooser: in `_setStatus`, when `check.checkType == 'consent' && status == 'pass'`, the dialog shows a `DropdownButtonFormField<String>` key `cath-readiness-consent-type` (values `written`, `verbal_emergency`, `relative`, `telephone`; labels from strings), default `written`; the result carries it and `_updateCheck` sends `metadata: {'consent_type': value}`.

`cath_lab_readiness_panel.dart`: `showOrderMissing = labs.orderableNow.isNotEmpty;` and `canEnterExternal = !item.available;` (drop `!labs.caseStarted` from both; leave un-waive's post-start closure as #1018 built it); item chip `cath-lab-item-after-start-<code>` when `item.orderedAfterStart || item.resultedAfterStart`, text `after_start`.

`cath_lab_screen.dart` `_headerSignals`: `final startedPending = loaded?.startedWithReadinessPending ?? fromList?.startedWithReadinessPending ?? false;` include it in the early-return condition and render a chip key `cath-readiness-header-started-pending` (amber, `header.started_pending`).

- [ ] **Step 6: Strings (five locales, four with the REVIEW marker)**

Keys under `s4.lib.cath_lab.readiness.`: `start_procedure`, `start_anyway`, `start_title`, `start_body`, `start_anyway_body` (`{checks}`), `start_reason`, `start_consent_blocked`, `started_pending_banner` (`{checks}`), `started_pending_reason` (`{reason}`), `critical_banner` (`{items}`), `critical_banner_unnamed`, `recorded_after_start`, `after_start`, `header.started_pending`, `consent_type_label`, `consent_type.written`, `consent_type.verbal_emergency`, `consent_type.relative`, `consent_type.telephone`. English first; hi/ta/te/ml with `// REVIEW: AI first-pass cath readiness never-restricts - confirm wording before production.` above each block. `i18n_guard_test.dart`: add the keys to the cath list and the three placeholder-bearing keys to the dynamic-placeholder check.

- [ ] **Step 7: Run and commit**

```bash
cd apps/staff && flutter analyze && flutter test test/features/cath_lab test/i18n_guard_test.dart
git add apps/staff/lib/features/cath_lab apps/staff/lib/l10n/app_strings.dart apps/staff/test/features/cath_lab apps/staff/test/i18n_guard_test.dart
git commit -m "feat(staff): cath start-with-checks-pending affordance (consent-gated), lateness banners and chips, order/outside result open after start

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 7: Admin — "Starts with checks pending" tab

**Files:**
- Modify: `apps/admin/src/lib/api/cathDevices.ts`
- Create: `apps/admin/src/app/(with-auth)/dashboard/quality/cath/components/StartsWithPendingTab.tsx`
- Modify: `apps/admin/src/app/(with-auth)/dashboard/quality/cath/page.tsx`
- Create: `apps/admin/src/__tests__/dashboard/quality/cath-starts-with-pending.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import StartsWithPendingTab from "@/app/(with-auth)/dashboard/quality/cath/components/StartsWithPendingTab";
import * as api from "@/lib/api/cathDevices";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/api/cathDevices", () => ({
  ...jest.requireActual("@/lib/api/cathDevices"),
  getCathStartsWithPendingReport: jest.fn(),
  downloadCathStartsWithPendingCsv: jest.fn(),
}));

const REPORT = {
  month: "2026-09", total: 2,
  facilities: [{ facility_id: 4, facility_name: "Main block", count: 2 }],
  rows: [
    { case_id: 1201, facility_id: 4, facility_name: "Main block", urgency: "emergency", via: "status", started_at: "2026-09-06T04:31:07.412Z", blocking_check_types: ["labs", "timeout"], missing_lab_items: ["hcv"], reason: "Primary PCI", actor_uid: "a", actor_role: "CONSULTANT", actor_name: "Dr A" },
    { case_id: 1202, facility_id: 4, facility_name: "Main block", urgency: "routine", via: "procedure_log", started_at: "2026-09-07T04:31:07.412Z", blocking_check_types: ["labs"], missing_lab_items: [], reason: null, actor_uid: "b", actor_role: "DOCTOR", actor_name: "Dr B" },
  ],
};

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><StartsWithPendingTab initialMonth="2026-09" /></QueryClientProvider>);
}

test("renders the per-facility count and the rows, showing a projected-null reason as a dash", async () => {
  (api.getCathStartsWithPendingReport as jest.Mock).mockResolvedValue(REPORT);
  mount();
  expect(await screen.findByText("Main block")).toBeInTheDocument();
  expect(screen.getByText("2")).toBeInTheDocument();
  expect(screen.getByText("labs, timeout")).toBeInTheDocument();
  expect(screen.getByText("hcv")).toBeInTheDocument();
  expect(screen.getByText("Primary PCI")).toBeInTheDocument();
  expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  expect(api.getCathStartsWithPendingReport).toHaveBeenCalledWith("2026-09");
});

test("changing the month re-queries; Download CSV calls the export for that month", async () => {
  (api.getCathStartsWithPendingReport as jest.Mock).mockResolvedValue(REPORT);
  (api.downloadCathStartsWithPendingCsv as jest.Mock).mockResolvedValue(new Blob(["x"]));
  mount();
  await screen.findByText("Main block");
  fireEvent.change(screen.getByLabelText("Month"), { target: { value: "2026-08" } });
  await waitFor(() => expect(api.getCathStartsWithPendingReport).toHaveBeenLastCalledWith("2026-08"));
  fireEvent.click(screen.getByRole("button", { name: /download csv/i }));
  await waitFor(() => expect(api.downloadCathStartsWithPendingCsv).toHaveBeenCalledWith("2026-08"));
});
```

Run: `cd apps/admin && npx jest src/__tests__/dashboard/quality/cath-starts-with-pending.test.tsx` → FAIL.

- [ ] **Step 2: API helpers**

`cathDevices.ts`:

```ts
/**
 * The monthly starts-with-checks-pending report (spec 2026-09-06 §7). Read
 * from the GOVERNANCE mount, where the quality officer reads it; the cath
 * mount carries the same handler for the cath lab in-charge.
 */
export const CATH_LAB_STARTS_WITH_PENDING_PATH =
  "/api/v1/cath-reprocessing/reports/starts-with-pending" as const;

export interface CathStartsWithPendingRow {
  case_id: number; facility_id: number | null; facility_name: string | null;
  urgency: string | null; via: "status" | "procedure_log" | null; started_at: string;
  blocking_check_types: string[]; missing_lab_items: string[]; reason: string | null;
  actor_uid: string | null; actor_role: string | null; actor_name: string | null;
}
export interface CathStartsWithPendingReport {
  month: string; total: number;
  facilities: Array<{ facility_id: number | null; facility_name: string | null; count: number }>;
  rows: CathStartsWithPendingRow[];
}

export function getCathStartsWithPendingReport(month: string) {
  return getJSON<CathStartsWithPendingReport>(
    `${CATH_LAB_STARTS_WITH_PENDING_PATH}?month=${encodeURIComponent(month)}`,
  );
}

export async function downloadCathStartsWithPendingCsv(month: string): Promise<Blob> {
  const res = await apiFetch(
    `${CATH_LAB_STARTS_WITH_PENDING_PATH}?month=${encodeURIComponent(month)}&format=csv`,
    { method: "GET", headers: { Accept: "text/csv" } },
  );
  if (!res.ok) throw new Error(`CSV export failed with HTTP ${res.status}`);
  return res.blob();
}
```

(`apiFetch` is the raw fetch `clinicalGovernance.ts` uses for its CSV — import it from the same place.)

- [ ] **Step 3: The tab and the page**

`StartsWithPendingTab.tsx`: `"use client"`; props `{ initialMonth?: string }` (default: current IST month, computed as `new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).format(new Date())`); `useQuery({ queryKey: ["cath", "starts-with-pending", month], queryFn: () => getCathStartsWithPendingReport(month) })`; a labelled `<input type="month" aria-label="Month">`; a facilities table (`facility_name` / `count`), a rows table (case id, facility, urgency, via, started at, blocking check types joined with `, `, missing lab items joined with `, `, reason or `—`, actor name / role); a "Download CSV" button that calls `downloadCathStartsWithPendingCsv(month)` and saves the blob via `exportCsvText`-style anchor download (`lib/exportToCsv.ts` has the anchor helper; reuse it, feeding the blob text). Header text: "Cases that started with readiness checks pending, from the start audit trail. Consent can never be pending here. The reason column is shown to the clinical audience only." `page.tsx`: `TABS` gains `{ key: "starts-with-pending", label: "Starts with checks pending", icon: AlertTriangle }` and the render branch.

- [ ] **Step 4: Run, lint, commit**

```bash
cd apps/admin && npx jest src/__tests__/dashboard/quality && npm run lint
git add "apps/admin/src/app/(with-auth)/dashboard/quality/cath" apps/admin/src/lib/api/cathDevices.ts apps/admin/src/__tests__/dashboard/quality/cath-starts-with-pending.test.tsx
git commit -m "feat(admin): cath quality — monthly starts-with-checks-pending report tab with CSV export

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 8: Gates and hand-back

Plan 3 Task 7 / Plan 2 Task 8 are the template. Merge authority is dev-1b; **draft PR only; do not mark ready; do not merge.**

- [ ] **Step 1: Merge main, re-verify #1018**

```bash
git fetch github main feat/cath-readiness-followups
git merge --no-ff github/main -m "chore: merge main into feat/cath-readiness-never-restricts"
gh pr view 1018 --json state,headRefOid,mergedAt
```

If #1018 has merged since Task 0, confirm the merge brought its final shape and re-run Task 0 Step 2's greps. If #1018 moved without merging, rebase-merge its head and re-run them.

- [ ] **Step 2: Backend gates**

```bash
cd apps/backend
npm run lint
npm test -- --testPathPatterns unit/                       # the FULL unit corpus, not the readiness suites alone
npm run openapi:check && npm run check:migration-numbers && npm run check:migration-immutability
DATABASE_URL=… node scripts/check-schema-drift.mjs
cd ../.. && node scripts/ci/security.mjs
```

Read the jest summary for `Suites failed` separately from `Tests passed` — `Suites failed` with `Tests passed` is a hook failure, not a pass.

- [ ] **Step 3: Two fresh-DB deep runs**

```bash
for run in 1 2; do
  dropdb -h 127.0.0.1 -p 55432 --if-exists vh_crr_<initials>_$run && createdb -h 127.0.0.1 -p 55432 vh_crr_<initials>_$run
  export DATABASE_URL="postgresql://…@127.0.0.1:55432/vh_crr_<initials>_$run"
  npm run test:db:setup
  npm test -- --testPathPatterns "cath-lab-readiness.deep|cath-reporting.deep|lab-signoff-safety.deep|bloodborne-markers.deep"
done
```

Both runs green with identical counts; record the counts for the PR body.

- [ ] **Step 4: The mutation list** (apply → named test red → revert; record each result)

1. `computeCheckDecision`: delete `started &&` from `agedOnly` → `'pre-start: a stale required item still retracts an auto-managed pass'` (unit) and the REGIME PAIR deep test red **and only those**; `'post-start: staleness alone never retracts'` green.
2. `computeCheckDecision`: delete `!agedOnly` → `'post-start: staleness alone never retracts'` red.
3. `assertReadinessComplete`: `consent.status !== 'pass'` → `!READINESS_CLEAR_STATES.includes(consent.status)` → the consent-waived unit test and the deep consent test red.
4. Move the `assertReadinessComplete` call into `transitionCaseStatus` → `cathLabStartPathPin.test.js` red; `'the procedure log is refused by the consent block too'` red.
5. Delete `via === 'status'` from the reason guard → `'the procedure log starts through the same function: no reason needed'` red.
6. Delete the reason blanking in `projectLabReadinessForRole` → the canary liveness assertion red.
7. Restore `AND actual_start_at IS NULL` in `refreshOpenCasesForPatient` → `'after start: a real sign-off reaches the item through the hook'` red.
8. Drop the `started_with_readiness_pending` fold in `listCases` → canary summary key set and the day-list deep assertion red.
9. `afterCaseStartMs` returns `false` → the late-order deep test and the resolver marker table red.
10. Delete `CASE_START_METADATA_KEYS` stripping → the reserved-key unit test red.
11. Move the cath-router report registration below `router.get('/reports/:id', …)` → the ADMIN route probe red.
12. Add a stray `UPDATE cath_lab_cases SET actual_start_at = NOW()` in another service — e.g. a two-line helper in `cathSchedulingRegistryService.js` that calls nothing this lane wrote → `cathLabStartPathPin.test.js`'s `'only startCaseTx writes in_progress or actual_start_at on a cath_lab_cases statement'` red (three sites, not two). **Both caller-count tests stay green**, which is the point: this is the only pin that would have caught a fourth start path. Revert.

- [ ] **Step 5: Staff and Admin gates**

```bash
cd apps/staff && flutter analyze && flutter test test/features/cath_lab test/i18n_guard_test.dart
cd ../admin && npm run lint && npx jest src/__tests__/dashboard/quality
```

- [ ] **Step 6: Canary snapshot diff**

`git diff github/main -- apps/backend/src/tests/fixtures/serologyDisclosureCanary.reachable.json` shows exactly the two new report entries and nothing else.

- [ ] **Step 7: `[full-ci]` and the draft PR**

```bash
git commit --allow-empty -m "chore(ci): [full-ci] cath readiness never restricts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u github feat/cath-readiness-never-restricts
gh pr create --repo Bahuleyandr/VH-Health-Platform --draft --base main --head feat/cath-readiness-never-restricts \
  --title "feat(cath): the pre-cath readiness checklist informs and records, never restricts (owner decisions 2026-09-06)" \
  --body-file "$SCRATCH/rr-pr-body.md"
```

The PR body states: the spec path; the owner principle verbatim and the five decisions; **no migration** (the columns relied on, 767 unclaimed); that consent is the one hard block enforced in `assertReadinessComplete` reached only through `startCaseTx`, with the pin; the regime rule in one sentence each for pre- and post-start and the mutation that proves the scope; the two lifted refusals and decision 9's branch as resolved in Task 0; the report on both mounts and why; the named default `requested` is not start-eligible; **an "Open owner item: procedure record on a cancelled case" section carrying spec §10.2's dead-end sentence verbatim and the two companions (i)/(ii), with the answer the owner gave and which companion shipped — or, if it is still unanswered, a bold line that the PR is NOT complete**; the deep counts from both fresh-DB runs; the canary snapshot diff (two entries); OpenAPI regeneration; Staff strings pending OPEN-21; `Merge Gate` / `Full Merge Gate` by name with the head SHA **from the tier-verifying poller** once the canonical run lands (not `gh run watch`). End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Hand back to dev-1b.

- [ ] **Step 8: Drop the scratch DBs** — `dropdb -h 127.0.0.1 -p 55432 vh_crr_<initials>` (and `_1`, `_2`).

---

## Self-review against the spec

- §3.1 / §4.3 consent as the one hard block, weakened `assertReadinessComplete`, `CATH_LAB_CONSENT_REQUIRED`, `pass` only, `required` ignored, both paths, hazards (i)/(ii), the pin — two caller counts, the SQL-shape count inside `cath_lab_cases` literals, the four-pair `SET status =` allow-list, the absent `CATH_LAB_READINESS_BLOCKED`: Task 2 Steps 3–4, 8–10; the stray-UPDATE mutation: Task 8 Step 4 item 12; deep trio per path: Task 3 Step 7.
- §3.2 / §4.2 one start path, snapshot, canonical event, audit row with `urgency` + `facility_id`: Task 2 Step 4.
- §3.3 / §4.1 transitions `scheduled|readiness_pending|ready`, derived `START_ELIGIBLE_STATUSES`, `requested` excluded: Task 2 Step 3.
- §3.4 reason on the explicit start only: Task 2 Step 4 (the `via === 'status'` guard) and the procedure-log unit/deep tests.
- §3.7 / §5.2 regime scoping with the pre-start test in the mutation list: Task 1 Steps 1–4; Task 3 Step 7 REGIME PAIR; Task 8 mutation 1.
- §3.8 / §5.4 markers with the epoch twin and the transaction-timestamp note: Task 1 Steps 5–7; Task 3 Step 4 (`caseRowTx`, `caseStartedAt`).
- §3.9 / §5.3 refusals lifted, STAT, audit keys, decision 9: Task 3 Steps 3, 6.
- §3.10 / §6.4 reason projection + canary: Task 4 Steps 3, 7; report projection: Task 5 Step 3.
- §3.11 / §7 report on both mounts, role constant, IST month, CSV, OpenAPI, canary snapshot (+2), Admin tab: Task 5; Task 7.
- §4.2 procedure log on `completed` / `in_progress` (an amendment, the case untouched): Task 2 Step 5, unit + deep. §10.2 the `cancelled` case is the **open owner item**, gated in Task 0 Step 6, placeholder refusal behind `REFUSE_PROCEDURE_LOG_ON_CANCELLED` in Task 2 Step 5, both companions' code in Task 0 Step 6.
- §5.1 refresh predicate: Task 3 Step 4; §5.5 case status untouched: the sign-off deep test.
- §6.1 contract keys; §6.2 day-list flag; §6.3 Staff banners/chips/gates/start row/consent chooser: Task 4 Steps 5–6; Task 6.
- §8 no migration, reserved key at create, `caseRowTx` reads the JSON path: Task 0 Step 4; Task 2 Step 6; Task 3 Step 4.
- §9 codes: `CATH_LAB_CONSENT_REQUIRED`, `CATH_LAB_START_REASON_REQUIRED`, `CATH_LAB_REPORT_MONTH_INVALID`, `CATH_LAB_START_VIA_INVALID` (internal, from `buildStartSnapshot`), none `CATH_LAB_READINESS_`-prefixed.
- §12 gates and hand-back: Task 8.
- Type consistency: `startCaseTx(tx, { tenantId, cathCase, reason, via, procedureLogId, context })` returns `{ updated, snapshot }` in Task 2 and is called that way from both callers; `computeCheckDecision({ items, settings, check, caseRow })` keeps its signature; `resolveItemState({ …, caseStartedAt })` keeps #1018's; `buildStartSnapshot` / `START_SNAPSHOT_KEYS` are the same names in the rules module, `cathLabService`, the overlay and the unit tests; `startsWithPendingReport({ tenantId, month })`, `projectReportForRole(report, role)`, `reportToCsv(report)` are used identically by the handler, the unit test and the deep test; the Staff `CathReadinessDependencies.startCase` matches `CathLabApiService.startCase(int, {String? reason})`.
