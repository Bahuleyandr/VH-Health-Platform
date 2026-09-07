# Cath Readiness Never Restricts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pre-cath readiness checklist inform and record instead of restrict: any `scheduled` / `readiness_pending` / `ready` case may start with checks pending (the documented authority to proceed — consent — is the one hard block), the checklist keeps living after start with lateness marked, a cancelled case has an audited door back, and a monthly report of starts-with-pending exists — per the owner decisions of 2026-09-06, as corrected by the owner's review of the same day.

**Architecture (revision 2):** One start function (`startCaseTx`) behind the two existing start paths; it asserts the documented authority to proceed, reads the **last committed** lab picture (never awaiting the lab rail), binds a client **command id** to the **procedure attempt** so a stale retry can never restart a reopened case, and writes an attempt-keyed at-start snapshot plus an `audit_logs` row. Ordinary creation may create only pre-start statuses. A second, deliberately separate function (`reopenCaseTx`) takes a `cancelled` case — and only a cancelled case — back to `readiness_pending`; when the previous attempt had started it opens attempt N+1, clears the active start, moves the snapshot into history and resets consent and time-out. The generic status endpoint refuses every transition on a cancelled case and names `/reopen`. The pure rules module gains a post-start regime keyed on the **active attempt** and on a persisted **`unavailability_cause`** (ageing alone never retracts; any other change does), three lateness markers beside #1018's, a tri-state "started with pending" and time-out timing. Consent records `authority` and `mode`; time-out records `performed_at` apart from documentation time. One report handler over the audit rows, audited itself on both mounts, with facility scope and a bounds-converted predicate. **migration NNN** adds `procedure_attempt`, `attempt_started_at`, four CHECKs, and the item cause column. Staff gains Start / Reopen, live updates over the existing `staff:lab` rail, and the consent / time-out fields; Admin gains the report tab.

**Tech Stack:** Node 26 ESM backend (Express 5, Prisma raw SQL on Postgres 17, jest with `--experimental-vm-modules`), Flutter Staff app, Next.js Admin console, OpenAPI overlay scripts.

**Spec:** `docs/superpowers/specs/2026-09-06-cath-readiness-never-restricts-design.md` — **revision 2 (2026-09-07)**. Read it first; section numbers below are its; its §0 table maps every owner point to the section that answers it.

**Revision 2 of this plan** rebuilds revision 1 against the revised spec. What is new, task by task: **Task 1** is a migration (revision 1 had none); **Task 2** keys the regime on `attempt_started_at` and on `unavailability_cause` and adds `classifyUnavailability`, `finalised_after_start` (with `resulted_after_start` renamed `received_after_start`), the attempt-aware snapshot, `labComponentStatus`, `timeoutTiming` and the consent vocabularies; **Task 3** adds `CREATABLE_STATUSES`, the population pin, the generic-status short-circuit, the explicit reopen precondition, the exhaustive procedure-log table, the command-id binding, the non-blocking lab picture, consent authority/mode validation against the tenant policy, the time-out `performed_at` rule, and the attempt increment with consent/time-out reset on reopen; **Task 4** persists the cause, moves every "started" read to the active attempt, and carries the deep tests the owner asked for by name (aged-out-before-next-attempt, generic `/status` bypass, `/reopen` on `scheduled`, creation route + 23514, replay across attempts); **Task 5** adds the tri-state day-list flag, the four-field free-text inventory with CSV coverage, and the `CASE_LIFECYCLE_ERROR_CODES` bidirectional scan; **Task 6** gives the report facility scope, shared `logAudit` on both mounts, the bounds-converted predicate with an EXPLAIN gate, start-event identity with the attempt, and the time-out / consent breakdowns; **Task 7** adds the `staff:lab` subscription with the end-to-end live-warning test, the consent choosers, the time-out field and the stale-command handling; **Task 9** carries 31 mutations and the live migration gates.

**Nothing blocks a task.** The one open owner item (spec §10.2 — whether `CATH_LAB_INCHARGE` reads the report tenant-wide) has a decided default (tenant-wide, by the day-list precedent) and Task 6 implements the default; the three clinical-meaning decisions the owner is asked to approve as part of the documents (a draft log does not start; consent and time-out reset on a new attempt; Start = the beginning of the invasive procedure) are each **one constant** in the code below, named where they land.

---


> **Migration number.** `NNN` = the next free migration number at push time. **767 is NOT this lane's:** it is reserved by the merge-authority session's Phase 1 isolation-derivation lane (dev-1b). Task 0 must re-check the free number when the branch is pushed; any lane that claims a number it does not own collides with the immutability gate.

## Conventions

All of Plan 3's conventions apply (tenant transactions, raw SQL, `AppError`, npm-run jest, immutable migrations, scratch DB, commit trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`, `[full-ci]` on the last commit, draft PR, no merge — merge authority is dev-1b). Plus:

- **Base is `github/main` at `5857298dc`.** #1018 (merged as `3f3959306`, head `a0144fc00`), #1022 (`35a231238`) and #1024 are in it. There is no "#1018 not merged" arm any more; Task 0 confirms its shape (record-yes / lift-no) rather than choosing a branch.
- **Cite by function name.** Line numbers are illustrative; grep the function.
- **Every "started" read is the ACTIVE attempt:** `attempt_started_at` (and its epoch twin), never `actual_start_at`. `actual_start_at` is history — the first start — and is never rewritten.
- **Post-start suppression is decided by `unavailability_cause === 'aged_out'`, never by `state === 'stale'`.** The pre-start staleness test is in the mutation list because it is the regime this lane does *not* change.
- **Never widen the picture with a value.** New payload keys are booleans, codes, causes, enums or instants. There are **four** free-text fields (spec §6.5), each projected through `roleSeesSerologyDetail` or privileged, each with a named sentinel on each reader.
- **migration NNN is claimed.** Reserve it in Task 1, re-check before the first push (Task 9), renumber **before** pushing if taken, never edit it after it is on a remote (add 768).
- **Fixtures with `<col>_at` carry `<col>_at_epoch_ms`** (`epochTwinFixtureFidelity.test.js`), derived from the same instant.
- **Every new error code** in the `CATH_LAB_(CONSENT|TIMEOUT|START|CASE_STATUS|CASE_CANCELLED|CASE_START|REOPEN|REPORT)_*` family must be in `CASE_LIFECYCLE_ERROR_CODES` (Task 5) — the scan is bidirectional, so an undocumented code and a documented-but-unraised code both fail.
- **No `git stash`, no `git restore`; commit with pathspecs.**
- Backend commands run from `apps/backend`; `npm test -- --testPathPatterns <pattern>`; deep suites need `DATABASE_URL`. Read `Suites failed` separately from `Tests passed` — `Suites failed` with `Tests passed` is a hook failure, not a pass.

---

## File structure

| File | Responsibility |
|---|---|
| Create `apps/backend/src/migrations/NNN_cath_lab_case_attempts.sql` | `procedure_attempt`, `attempt_started_at`, four CHECKs on `cath_lab_cases`; `unavailability_cause`, `window_days` + CHECK on `cath_case_lab_readiness_items`; backfill. |
| Modify `apps/backend/prisma/schema.prisma` | The two models' new columns (schema-drift gate). |
| Modify `apps/backend/src/services/clinical/cathLabReadinessRules.js` | `computeCheckDecision` keyed on `attempt_started_at` + cause; `classifyUnavailability`, `UNAVAILABILITY_CAUSES`; `afterCaseStartMs`; `ordered_after_start` / `received_after_start` / `finalised_after_start`; snapshot helpers (`START_SNAPSHOT_KEYS` ×12, `buildStartSnapshot`, `normalizeStartSnapshot`, tri-state `startedWithReadinessPending`, `missingLabItemCodes`, `labComponentStatus`, `START_PICTURE_FRESH_MS`, `LAB_COMPONENT_STATUSES`); `timeoutTiming`; `CONSENT_AUTHORITIES`, `CONSENT_MODES`. |
| Modify `apps/backend/src/services/clinical/cathLabService.js` | `CASE_TRANSITIONS` (+ `cancelled: ['readiness_pending']`), `START_ELIGIBLE_STATUSES`, `REOPENABLE_STATUSES` / `REOPEN_TARGET_STATUS`, `CREATABLE_STATUSES`, `START_LOG_STATUSES`, `ATTEMPT_RESET_CHECKS`, `CASE_START_METADATA_KEYS`; `assertConsentDocumented` (replaces `assertReadinessComplete`); `consentPolicyFor`; consent / time-out validation in `updateReadinessCheck`; `caseById` widened; `normalizeCommandId`; `labsPictureForStartTx`; `startCaseTx`; `reopenCaseTx` + `reopenCase` + `latestCancelReasonTx`; `transitionCaseStatus` (short-circuit, rewire, post-commit refresh); `recordProcedureLog` (exhaustive); `createCase` (`CREATABLE_STATUSES`, reserved keys); `listCases` (two columns + tri-state fold). |
| Modify `apps/backend/src/services/clinical/cathLabReadinessService.js` | `caseRowTx` selects the attempt columns + twin + snapshot path; refresh passes the twin, computes and persists the cause + `window_days`, audits `passed_after_start`, returns the new keys; `refreshOpenCasesForPatient` predicate; facade re-exports. |
| Modify `apps/backend/src/services/clinical/cathLabReadinessActions.js` | Lift the two refusals; STAT after start; `isAfterCaseStart` on `attempt_started_at`; audit keys. |
| Modify `apps/backend/src/services/clinical/cathLabReadinessProjection.js` | Blank `readiness_at_start.reason` for non-entitled roles; export `projectStartReasonForRole`. |
| Create `apps/backend/src/services/clinical/cathStartsWithPendingReportService.js` | Month + facility validation, bounds-converted query with the time-out join, per-facility fold, breakdowns, `distinct_cases`, CSV, projection. |
| Create `apps/backend/src/routes/clinical/cathStartsWithPendingReportHandler.js` | One handler, registered on both mounts, `logAudit` awaited before the response. |
| Modify `apps/backend/src/routes/clinical/cathLabRoutes.js`, `cathReprocessingPolicyRoutes.js` | Report route (before `/reports/:id` on the cath router); `POST /cases/:id/reopen` (cath router only); creation route validates `status` against `CREATABLE_STATUSES`. |
| Modify `apps/backend/src/utils/roleHelpers.js` | `CATH_READINESS_REPORT_ROLES`, `canReadCathReadinessReport`. |
| Modify `apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs` | `CathLabCase` +2 columns; item +3 booleans + cause; readiness keys; snapshot schema; report schemas/operations (+ `facility_id`); prose-only status / procedure-log / reopen / creation notes; `CASE_LIFECYCLE_ERROR_CODES`; decision-9 edits. |
| Create `apps/backend/src/tests/unit/cathLabStartPathPin.test.js` | Caller pins, SQL-shape pin, `SET status =` list, **write-site population pin**, door pins, short-circuit order, absent old names. |
| Create `apps/backend/src/tests/unit/cathStartsWithPendingReportService.test.js` | Report unit tests (incl. the bounds literal). |
| Modify unit tests: `cathLabService.test.js`, `cathLabReadinessService.test.js`, `cathLabReadinessServiceOrders.test.js`, `cathLabReadinessOpenApiSource.test.js`, `cathLabReadinessProjection.test.js`, `serologyDisclosureCanary.test.js` (+ `fixtures/serologyDisclosureCanary.reachable.json`), the roleHelpers test, `cathLabRouteGuards.test.js` (report probes only — decision 9 is KEPT) | Per task. |
| Modify `apps/backend/src/tests/cath-lab-readiness.deep.test.js` | Deep coverage, case-parameterised helpers. |
| Staff: modify `features/cath_lab/models/cath_readiness_models.dart`, `services/cath_lab_api_service.dart`, `widgets/cath_readiness_checklist.dart`, `widgets/cath_lab_readiness_panel.dart`, `screens/cath_lab_screen.dart`, `l10n/app_strings.dart`; tests `test/features/cath_lab/cath_readiness_checklist_test.dart`, `cath_lab_screen_test.dart`, `test/i18n_guard_test.dart` | Start / Reopen affordances, live updates, banners, chips, consent choosers, time-out field, 40 keys. |
| Admin: create `dashboard/quality/cath/components/StartsWithPendingTab.tsx`, `__tests__/dashboard/quality/cath-starts-with-pending.test.tsx`; modify `lib/api/cathDevices.ts`, `dashboard/quality/cath/page.tsx` | Report tab with facility filter, breakdowns, identifiability header, CSV. |

---

## Task 0: Branch, worktree, baseline confirmation, the three surveys

**Files:** none (verification only).

- [ ] **Step 1: Cut the branch from `github/main` in a scratchpad worktree**

```bash
cd "/d/Dev/Projects/VH Health/VH-Health-Platform"
git fetch github '+refs/heads/*:refs/remotes/github/*'
git rev-parse github/main            # 5857298dc… or later; record it in the PR body
git worktree add "$SCRATCH/wt/rr-impl" -b feat/cath-readiness-never-restricts github/main
cd "$SCRATCH/wt/rr-impl/apps/backend" && npm ci
```

(`prisma generate` inside `npm ci` can run silently for a long time in a fresh worktree; if you borrow `node_modules` from another checkout through a junction, never `git worktree remove` this worktree afterwards — unlink the junction first.)

- [ ] **Step 2: Confirm #1018's final shape on `main` — decision 9 is KEPT**

```bash
grep -n "CATH_LAB_READINESS_CASE_STARTED" src/services/clinical/cathLabReadinessActions.js scripts/openapi/schemas/cathLabReadiness.mjs
grep -n "function isAfterCaseStart\|recorded_after_start\|lifted_after_start" src/services/clinical/cathLabReadinessActions.js
```

Expected: `unwaiveLabItem` throws the code (one thrower stays after Task 4 removes the order-missing and external-result ones); `waiveLabItem` derives `recorded_after_start`; no `lifted_after_start`. Task 5's overlay edit is the **KEPT** branch only (the two 409 lists and the `case_started` description). If `unwaiveLabItem` no longer refuses after start, stop and report to dev-1b — the spec's baseline (§2, decision 9, §15) does not hold.

- [ ] **Step 3: Re-run the ledger (spec §16)** — grep every row's function. The ones that carry the owner's findings, so the diff reads the way the spec says:

```bash
grep -n "normalizeStatus(input.status, CASE_STATUSES" src/services/clinical/cathLabService.js          # createCase — the creation bypass (point 1)
grep -n "cancelled: \[\]" src/services/clinical/cathLabService.js                                        # terminal today → ['readiness_pending']
grep -n "validateCaseTransition(cathCase.status, input.status)" src/services/clinical/cathLabService.js  # transitionCaseStatus: NO cancelled special case (point 2a)
grep -n "cathCase.status !== 'in_progress'" -A 8 src/services/clinical/cathLabService.js | head -12       # recordProcedureLog force-start: no requested / cancelled branch (point 3)
grep -n "actual_start_at IS NULL" src/services/clinical/cathLabReadinessService.js
grep -n "!started\|caseRow?.actual_start_at" src/services/clinical/cathLabReadinessRules.js
grep -n "state: item.state" src/services/clinical/cathLabReadinessRules.js                              # missing entries have no cause yet (point 6)
grep -n "'readiness_pending'" src/services/clinical/stemiPathwayService.js
grep -n "router.get('/reports/:id'" src/routes/clinical/cathLabRoutes.js
grep -n "router.post('/cases'," src/routes/clinical/cathLabRoutes.js                                     # passes req.body through
grep -n "QUALITY_OFFICER" src/tests/fixtures/serologyDisclosureCanary.reachable.json | grep cath-lab || echo "no cath-lab GET admits QUALITY_OFFICER (expected)"
```

- [ ] **Step 4: Record the write-site population baseline** (the pin's expected lists in Task 3 are measured from this, +2 −1)

```bash
grep -rn "UPDATE cath_lab_cases\|INSERT INTO cath_lab_cases" src --include=*.js | grep -v "^src/tests/"
```

Expected on the base tree: **eight** `UPDATE` literals — `cathLabReadinessService.js` (`recomputeCaseStatusTx`), `cathLabService.js` ×5 (`updateCaseCanonicalRefs`, `updateReadinessCheck`, `transitionCaseStatus`, `recordProcedureLog`, `resolveCathConsumableAuthorityRecovery`), `cathSchedulingRegistryService.js` (`scheduleCase`), `stemiPathwayService.js` (`spawnCathCase`) — and **two** `INSERT` literals (`createCase`, `spawnCathCase`). No `ON CONFLICT` on the table. Write the function names down; if a name differs (an inner helper wraps a literal), the pin's list uses the measured name.

- [ ] **Step 5: migration NNN is unclaimed** (Task 1 Step 1 repeats this; Task 9 re-runs it before the push).

- [ ] **Step 6: Create the scratch DB for deep runs**

```bash
createdb -h 127.0.0.1 -p 55432 vh_crr_<initials>
cd "$SCRATCH/wt/rr-impl/apps/backend"
DATABASE_URL="postgresql://…@127.0.0.1:55432/vh_crr_<initials>" npm run test:db:setup
```

- [ ] **Step 7: Survey A — `cancelled` stops being terminal (spec decision 13 / 15)**

```bash
cd "$SCRATCH/wt/rr-impl"
grep -rn "'cancelled'" apps/backend/src/services/clinical/ apps/backend/src/routes/clinical/ | grep -v "/tests/"
grep -rn "cancelled" apps/staff/lib/features/cath_lab/ apps/admin/src --include=*.dart --include=*.ts --include=*.tsx
```

| Reader | Verdict |
|---|---|
| `refreshOpenCasesForPatient` — `status NOT IN ('completed','cancelled')` (after Task 4) | Correct by construction: a reopened case leaves `cancelled` and the checklist lives again. |
| `recomputeCaseStatusTx` / `updateReadinessCheck` — `WHEN status IN ('scheduled','readiness_pending','ready')` | Correct and wanted: a reopened case may move on to `ready`. |
| `CATH_CONSUMABLE_WASTAGE_STATUSES` | Unaffected. |
| `cancelWorkflowSla` on the cancel transition | Accepted, not fixed (spec §14): the reopen does not resurrect the SLA instance. |
| `transitionCaseStatus` on a cancelled case | **Changes**: refuses every target with `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED` before the table (Task 3). |
| Anything rendering `cancelled` as final in Staff / Admin | Check and report: a label is fine; a cache that never refetches a cancelled case is not. |

Confirm the two "not a column" facts §4.8 leans on: no `cancelled_at` / `cancel_reason` on `cath_lab_cases` (`grep -n "cancelled_at\|cancel_reason" apps/backend/prisma/schema.prisma | grep -i cath`), and `cath_lab_cases_actual_time_check` reads `actual_end_at IS NULL OR actual_start_at IS NULL OR actual_end_at >= actual_start_at` (migration 482) — which is why the reopen clears `actual_end_at` and the 23514 would land on the **next** start.

- [ ] **Step 8: Survey B — every reader of `actual_start_at` as "started" (spec decision 17)**

```bash
grep -rn "actual_start_at" apps/backend/src/services/clinical/cathLabReadiness*.js apps/backend/src/services/clinical/cathLabService.js | grep -v "/tests/"
grep -rn "actualStartAt\|caseStarted\|case_started" apps/staff/lib/features/cath_lab/
```

Each hit gets one of two verdicts: **moves to the active attempt** (`computeCheckDecision`'s `started`, `isAfterCaseStart`, the refresh's `caseStartedAt`, `case_started` on the block, Staff `caseStarted` / the panel gates / the checklist's `started`) or **stays history** (`caseById`'s select, `cath_lab_cases_actual_time_check`, the SLA and completion writes, `first_started_at` on the block). Anything not in either list is a finding — report it before Task 3.

- [ ] **Step 9: Survey C — who reads the canonical timeline payload (spec §6.5 rows 1 and 3)**

The start reason and the reopen reason ride on canonical events (`cath_lab.case_in_progress`, `cath_lab.case_reopened`) written by `writeCanonicalEvent` in `cathLabService.js` through `recordCanonicalClinicalEvent` (`canonicalClinicalPlatformService.js`) into `clinical_timeline_events`. The timeline reader in the same service maps rows with `payload: row.payload || {}` — **unprojected**.

```bash
grep -n "visibleToPatient\|visible_to_patient" apps/backend/src/services/clinical/cathLabService.js apps/backend/src/services/clinical/canonicalClinicalPlatformService.js
grep -n "^export async function\|^export function" apps/backend/src/services/clinical/canonicalClinicalPlatformService.js | grep -i "timeline"
grep -rln "canonicalClinicalPlatformService" apps/backend/src/routes
```

Known at the time of writing (verified on `main`): `recordCanonicalClinicalEvent` writes `visible_to_patient` **only** when the input says `true`, and `writeCanonicalEvent` never sets it — so the cath events are not patient-visible and the patient app is out; the reader is `readCanonicalPatientTimeline`, called from `emr/clinicalTimelineRoutes.js`, `clinical/encounterRoutes.js` and `patient/patientSearchRoutes.js`. Record the **roles** admitted on those three routes. **Verdict rule**: if any is outside `roleSeesSerologyDetail`, Task 5 projects `payload.reason` and `payload.readiness_at_start.reason` in `readCanonicalPatientTimeline` by the same predicate and adds the sentinel test on that reader; if only entitled staff reach it, record that, and the coverage is the unit assertion (Task 3) that the two cath events are written `visible_to_patient = false` plus the writer's payload-shape test. Either way the finding goes in the PR body.

- [ ] **Step 10: The lifecycle error-code scan on the base tree**

```bash
grep -rnoE "'CATH_LAB_(CONSENT|TIMEOUT|START|CASE_STATUS|CASE_CANCELLED|CASE_START|REOPEN|REPORT)_[A-Z_]+'" apps/backend/src/services/clinical/cathLabService.js apps/backend/src/services/clinical/cathLabReadinessRules.js apps/backend/src/routes/clinical/cathLabRoutes.js || echo "zero matches on the base tree (expected)"
```

Expected: zero (the existing `CATH_LAB_CASE_*` codes are `_NOT_FOUND`, `_ENCOUNTER_INVALID`, `_FACILITY_*`, which the alternation does not match). Any match is reconciled by name in Task 5 before the bidirectional scan is written.

---

## Task 1: migration NNN — the attempt columns and the cause column (DDL only)

**Files:**
- Create: `apps/backend/src/migrations/NNN_cath_lab_case_attempts.sql`
- Modify: `apps/backend/prisma/schema.prisma` (`cath_lab_cases`, `cath_case_lab_readiness_items`)

> **Why a migration now** (spec §8.1): the owner's point 4 — "'no migration' must not determine clinical meaning" — is accepted. The attempt lifecycle is read by every rule, compared against the process clock and lab instants, and must be enforceable by a CHECK; the cause of unavailability must be stable across refreshes, so it is persisted beside the state it explains. Revision 1's "no migration" is withdrawn. **Pure DDL plus one backfill UPDATE; no plpgsql body** (no plpgsql body is CI-validated after the baseline, so none is written).

- [ ] **Step 1: Reserve the number — and plan to re-check it at push time**

```bash
cd "$SCRATCH/wt/rr-impl"
git fetch github '+refs/heads/*:refs/remotes/github/*'
for ref in $(git for-each-ref --format='%(refname)' refs/remotes/github/); do
  git ls-tree --name-only "$ref" apps/backend/src/migrations/ 2>/dev/null
done | sed -E 's#.*/([0-9]+)_.*#\1#' | sort -n | uniq | tail -2
```

Expected tail: `765`, `766` (re-checked 2026-09-07 over the seven `github/*` branches). If `NNN` appears on any branch, take the next free number **now** and use it everywhere below; if it appears between now and the first push (Task 9 re-runs this), renumber **before** pushing, never after — the immutability gate pins a file by name once it is on a remote.

- [ ] **Step 2: Write the migration** (spec §8.1, verbatim — the CHECK names are cited by the deep tests and the OpenAPI pin)

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

No RLS change (row policies are unaffected by added columns). No index (the report's plan is checked in Task 6 before one is claimed).

- [ ] **Step 3: `schema.prisma`**

`model cath_lab_cases`: add `procedure_attempt Int @default(1)` and `attempt_started_at DateTime? @db.Timestamptz(6)` beside `actual_start_at`. `model cath_case_lab_readiness_items`: add `unavailability_cause String? @db.VarChar(30)` and `window_days Int?` after `refreshed_at`. Keep the `/// This table contains check constraints` doc comments as they are.

- [ ] **Step 4: Apply to the scratch DB and run the schema gates**

```bash
cd "$SCRATCH/wt/rr-impl/apps/backend"
npm run check:migration-numbers && npm run check:migration-immutability
DATABASE_URL="postgresql://…@127.0.0.1:55432/vh_crr_<initials>" npm run test:db:setup
DATABASE_URL="postgresql://…@127.0.0.1:55432/vh_crr_<initials>" node scripts/check-schema-drift.mjs
```

All green. The immutability gate is **live** on this lane (NNN is a new file, so it passes; what it protects is the file's content after the first push — do not edit it afterwards, add 768).

- [ ] **Step 5: Smoke the two CHECKs by hand** (the deep tests in Task 4 make them permanent)

```bash
psql "postgresql://…@127.0.0.1:55432/vh_crr_<initials>" -c "
  INSERT INTO cath_lab_cases (tenant_id, patient_uid, requested_procedure, status)
  VALUES ('00000000-0000-4000-8000-000000000001', gen_random_uuid(), 'probe', 'in_progress');"
# expect: ERROR 23514 ... violates check constraint "cath_lab_cases_in_progress_attempt_check"
psql "…" -c "UPDATE cath_lab_cases SET attempt_started_at = NOW() WHERE status = 'scheduled' AND id = (SELECT min(id) FROM cath_lab_cases WHERE status='scheduled');"
# expect: ERROR 23514 ... "cath_lab_cases_pre_start_attempt_check" (or 0 rows if no scheduled case exists — then skip)
```

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/migrations/NNN_cath_lab_case_attempts.sql apps/backend/prisma/schema.prisma
git commit -m "feat(cath): migration NNN — procedure attempt + attempt_started_at on cath_lab_cases, unavailability_cause + window_days on readiness items, four CHECKs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 2: Pure rules — cause-scoped regime, three markers, start snapshot, lab picture, time-out timing, consent vocabularies (TDD)

**Files:**
- Modify: `apps/backend/src/services/clinical/cathLabReadinessRules.js`
- Modify: `apps/backend/src/services/clinical/cathLabReadinessService.js` (facade re-exports only)
- Test: `apps/backend/src/tests/unit/cathLabReadinessService.test.js`

Everything in this task is pure and keyed on **`caseRow.attempt_started_at`** (never `actual_start_at`) and on **`unavailability_cause`** (never `state === 'stale'`) — the two substitutions the owner's points 4 and 6 required.

- [ ] **Step 1: Write the failing regime tests for `computeCheckDecision`** (spec §5.2)

Append inside `describe('computeCheckDecision', …)`. Items now carry `unavailability_cause`; `missing[]` entries are `{ item, state, cause }`:

```js
  const agedHb = { item_code: 'hb', required: true, state: 'stale', unavailability_cause: 'aged_out' };
  const agedHbReordered = { item_code: 'hb', required: true, state: 'ordered_awaiting_sample', unavailability_cause: 'aged_out' };
  const policyHb = { item_code: 'hb', required: true, state: 'stale', unavailability_cause: 'policy_changed' };
  const futureHb = { item_code: 'hb', required: true, state: 'stale', unavailability_cause: 'future_dated' };
  const neverHcv = { item_code: 'hcv', required: true, state: 'not_ordered', unavailability_cause: null };
  const autoPass = { status: 'pass', metadata: { auto_managed: true } };
  const preStart = { attempt_started_at: null, actual_start_at: AS_OF.toISOString() }; // attempt 2 not yet started: PRE-start regime
  const postStart = { attempt_started_at: AS_OF.toISOString(), actual_start_at: AS_OF.toISOString() };

  test('pre-start (active attempt not started): an aged-out item still retracts — even when actual_start_at is set', () => {
    const out = computeCheckDecision({ items: [agedHb], settings, check: autoPass, caseRow: preStart });
    expect(out.nextStatus).toBe('pending');
    expect(out.autoPendingReason).toBe('hb stale');
    expect(out.missing).toEqual([{ item: 'hb', state: 'stale', cause: 'aged_out' }]);
  });
  test('post-start: age alone never retracts, and the item still reads stale', () => {
    const out = computeCheckDecision({ items: [agedHb], settings, check: autoPass, caseRow: postStart });
    expect(out.nextStatus).toBeNull();
    expect(out.missing).toEqual([{ item: 'hb', state: 'stale', cause: 'aged_out' }]);
  });
  test('post-start: an aged-out item with a repeat order open is still age-only (state is not the discriminator)', () => {
    expect(computeCheckDecision({ items: [agedHbReordered], settings, check: autoPass, caseRow: postStart }).nextStatus).toBeNull();
  });
  test('post-start: a policy change or a future-dated correction retracts even though the state reads stale', () => {
    expect(computeCheckDecision({ items: [policyHb], settings, check: autoPass, caseRow: postStart }).nextStatus).toBe('pending');
    expect(computeCheckDecision({ items: [futureHb], settings, check: autoPass, caseRow: postStart }).nextStatus).toBe('pending');
  });
  test('post-start: any non-aged missing item retracts and names all of them', () => {
    const out = computeCheckDecision({ items: [agedHb, neverHcv], settings, check: autoPass, caseRow: postStart });
    expect(out.nextStatus).toBe('pending');
    expect(out.autoPendingReason).toBe('hb stale; hcv not ordered');
  });
  test('post-start: new evidence completing the set passes a pending check', () => {
    const out = computeCheckDecision({ items: [{ item_code: 'hb', required: true, state: 'result_final', unavailability_cause: null }], settings, check: { status: 'pending', metadata: {} }, caseRow: postStart });
    expect(out.nextStatus).toBe('pass');
  });
  test('post-start: a critical value is reported and does not move the status', () => {
    const out = computeCheckDecision({ items: [{ item_code: 'potassium', required: true, state: 'result_final', is_critical: true, unavailability_cause: null }], settings, check: autoPass, caseRow: postStart });
    expect(out).toMatchObject({ nextStatus: null, criticalWarning: true, criticalItems: ['potassium'] });
  });
```

Delete `'an auto-managed pass flips back to pending when an item goes missing before start, not after'` (replaced by the pair above) and invert `'a started case is never auto-passed, however complete the items are'` to `'a started case IS auto-passed once the items are complete (new evidence applies after start)'` asserting `nextStatus: 'pass'` with `caseRow: postStart`.

- [ ] **Step 2: Run to verify they fail** — `npm test -- --testPathPatterns unit/cathLabReadinessService`. Expected: FAIL (`missing` lacks `cause`; post-start aged-out gets `'pending'`).

- [ ] **Step 3: Implement the cause-scoped decision**

In `computeCheckDecision`, `missing` becomes `{ item: item.item_code, state: item.state, cause: item.unavailability_cause ?? null }` and the body from `const started` to the return is:

```js
  const started = Boolean(caseRow?.attempt_started_at);
  let nextStatus = null;
  let autoPendingReason = null;
  // Spec 2026-09-06 §5.2 (decisions 7, 17, 19). BEFORE the ACTIVE attempt starts
  // Plan 3's rule stands in full: automation passes when every required item is
  // available and retracts a pass it made when one goes missing — by age
  // included. AFTER start, new evidence always applies (the pass branch is open
  // in both regimes; the critical flags are computed above regardless) but
  // AGEING ALONE never moves the check: the team acted on the value it had.
  // "Ageing alone" is the item's persisted unavailability_cause === 'aged_out'
  // — never state === 'stale' (a policy change or a future-dated correction
  // also reads stale, and an aged value with a repeat draw open reads
  // ordered_awaiting_sample). Gated on attempt_started_at, not actual_start_at:
  // a reopened case is pre-start again until its next attempt starts.
  // Delete `started &&` → the pre-start test goes red. Replace
  // `cause === 'aged_out'` with `state === 'stale'` → the policy-change and
  // future-dated tests go red and the repeat-order test goes red the other way.
  const agedOnly = started && missing.length > 0 && missing.every((row) => row.cause === 'aged_out');
  if (missing.length === 0) {
    if (settings.auto_pass === true && (status === 'pending' || (status === 'pass' && autoManaged))) {
      nextStatus = status === 'pass' ? null : 'pass';
    }
  } else if (status === 'pass' && autoManaged && !agedOnly) {
    nextStatus = 'pending';
    autoPendingReason = pendingReasonFor(missing);
  }
  return { nextStatus, criticalWarning: criticalItems.length > 0, criticalItems, missing, autoPendingReason };
```

`pendingReasonFor` keeps its wording (`hb stale`); the cause rides beside it.

- [ ] **Step 4: Run** — expected PASS.

- [ ] **Step 5: Write the failing `classifyUnavailability` tests** (spec §5.6 — every row of the precedence list)

New `describe('classifyUnavailability (spec §5.6)')`. Build `results` rows with the suite's `resultAt`-style helper (give each an `id`, `status`, `performed_at` + epoch twin). Cases:

```js
  const prevFresh = (extra = {}) => ({ item_code: 'hb', required: true, state: 'result_final', lab_result_id: 9, source: 'lab', window_days: 30, unavailability_cause: null, ...extra });
  const unavailable = (state, extra = {}) => ({ item_code: 'hb', required: true, state, lab_result_id: null, source: null, ...extra });

  test('available → null', () => expect(classifyUnavailability({ previous: prevFresh(), resolved: { ...prevFresh() }, results: [row(9, -1)], settings, windowDays: 30, asOf: AS_OF })).toBeNull());
  test('same row, only older → aged_out', () => expect(classify({ previous: prevFresh(), resolved: unavailable('stale'), results: [row(9, -45)] })).toBe('aged_out'));
  test('same row aged, a repeat order open → still aged_out (state is ordered_awaiting_sample)', () => expect(classify({ previous: prevFresh(), resolved: unavailable('ordered_awaiting_sample'), results: [row(9, -45)] })).toBe('aged_out'));
  test('window narrowed 30 → 7 with an 8-day-old value → policy_changed (never aged_out)', () => expect(classify({ previous: prevFresh(), resolved: unavailable('stale'), results: [row(9, -8)], windowDays: 7 })).toBe('policy_changed'));
  test('required flipped on for an item nobody ordered → policy_changed', () => expect(classify({ previous: unavailable('not_ordered', { required: false, window_days: 30 }), resolved: unavailable('not_ordered', { required: true }) })).toBe('policy_changed'));
  test('external setting flipped off under a previously counted external result → policy_changed', () => expect(classify({ previous: prevFresh({ state: 'external_recorded', source: 'external', lab_result_id: null }), resolved: unavailable('external_recorded'), settings: { ...settings, external_results_count: false } })).toBe('policy_changed'));
  test('deciding row cancelled / gone → withdrawn', () => expect(classify({ previous: prevFresh(), resolved: unavailable('not_ordered'), results: [] })).toBe('withdrawn'));
  test('same row, performed_at corrected into the future → future_dated', () => expect(classify({ previous: prevFresh(), resolved: unavailable('stale'), results: [row(9, +2)] })).toBe('future_dated'));
  test('same row, timestamp corrected into garbage → unparseable', () => expect(classify({ previous: prevFresh(), resolved: unavailable('stale'), results: [{ ...row(9, -1), performed_at: 'not-a-date', performed_at_epoch_ms: null }] })).toBe('unparseable'));
  test('a different row now decides and is not acceptable → corrected', () => expect(classify({ previous: prevFresh(), resolved: unavailable('stale', { lab_result_id: 10 }), results: [row(9, -1), { ...row(10, 0), status: 'preliminary' }] })).toBe('corrected'));
  test('waiver lifted → withdrawn', () => expect(classify({ previous: prevFresh({ state: 'waived', source: 'waiver', lab_result_id: null }), resolved: unavailable('not_ordered') })).toBe('withdrawn'));
  test('already unavailable with a persisted cause and the same evidence → the cause carries (stability)', () => expect(classify({ previous: unavailable('stale', { lab_result_id: 9, unavailability_cause: 'aged_out', window_days: 30 }), resolved: unavailable('stale', { lab_result_id: 9 }), results: [row(9, -46)] })).toBe('aged_out'));
  test('never available, a draw now in flight → reordered', () => expect(classify({ previous: null, resolved: unavailable('ordered_awaiting_sample') })).toBe('reordered'));
  test('never available, nothing in flight → null', () => expect(classify({ previous: null, resolved: unavailable('not_ordered') })).toBeNull());
```

(`classify` = `classifyUnavailability` with `settings`, `windowDays: 30`, `asOf: AS_OF` defaulted; `row(id, offsetDays)` builds a final result row performed `offsetDays` from `AS_OF` with its epoch twin.)

- [ ] **Step 6: Run to verify they fail** — not exported.

- [ ] **Step 7: Implement `classifyUnavailability`**

```js
export const UNAVAILABILITY_CAUSES = Object.freeze([
  'aged_out', 'future_dated', 'unparseable', 'withdrawn', 'corrected', 'policy_changed', 'reordered',
]);

// Why an item is NOT available (spec §5.6) — decided against the PREVIOUS
// stored row and the rows the resolver saw, so it is stable across refreshes.
// null when the item is available, or when it never had evidence. A CAUSE,
// beside the display state; never a new state. Precedence: first match wins.
export function classifyUnavailability({ previous = null, resolved, results = [], settings, windowDays, asOf = new Date() }) {
  if (isItemAvailable(resolved, settings)) return null;
  const inFlight = ['ordered_awaiting_sample', 'sample_sent_awaiting_result'].includes(resolved.state);
  if (previous) {
    const externalNoLongerCounts = previous.state === 'external_recorded' && settings?.external_results_count === false;
    if (Number(previous.window_days) !== Number(windowDays)
      || (previous.required !== false) !== (resolved.required !== false)
      || externalNoLongerCounts) {
      return 'policy_changed';
    }
    const previousAcceptable = isItemAvailable(previous, { ...settings, external_results_count: true });
    if (previousAcceptable && previous.lab_result_id != null) {
      const row = results.find((candidate) => Number(candidate.id) === Number(previous.lab_result_id));
      if (!row) return 'withdrawn';
      const latest = latestCandidate(results); // the module's rankResult order; the open-order check does NOT enter here
      if (latest && Number(latest.id) === Number(row.id)) {
        const ms = observedMs(row);
        if (!Number.isFinite(ms)) return 'unparseable';
        if (ms > asOf.getTime()) return 'future_dated';
        if (!withinWindow(ms, asOf, windowDays)) return 'aged_out';
        return 'corrected';
      }
      return 'corrected';
    }
    if (previousAcceptable && previous.source === 'waiver') return 'withdrawn';
    if (!previousAcceptable && previous.unavailability_cause
      && Number(previous.lab_result_id ?? -1) === Number(latestCandidate(results)?.id ?? -1)) {
      return previous.unavailability_cause;
    }
  }
  if (inFlight) return 'reordered';
  return null;
}
```

`latestCandidate(results)` sorts by the module's existing `rankResult` and returns the first (write it beside `rankResult`; read `observedMs` / `withinWindow`'s real signatures before pasting — `withinWindow(value, asOf, windowDays)` takes an instant or an epoch and already rejects future values, so the `ms > asOf` branch must come **before** it, as above, or "future" would read as "aged"). The waiver test needs `isItemAvailable` to count `waived` as acceptable — it does today.

- [ ] **Step 8: Run** — expected PASS for the cause table and the regime table together.

- [ ] **Step 9: Write the failing marker tests for `resolveItemState`** (spec §5.4 — `received_after_start` is a RECEIPT marker; `finalised_after_start` is separate)

Append inside `describe('resolveItemState', …)`:

```js
  describe('lateness markers (spec §5.4) — against the ACTIVE attempt start', () => {
    const startedAt = BigInt(AS_OF.getTime() - 3_600_000);
    const resultAt = (receivedOffset, { signedOffset = receivedOffset, status = 'final' } = {}) => {
      const rms = AS_OF.getTime() + receivedOffset; const sms = AS_OF.getTime() + signedOffset;
      return { id: 9, test_code: 'K', value_text: '4.1', value_numeric: 4.1, unit: 'mmol/L', abnormal_flag: 'N', is_critical: false, status, result_origin: 'analyzer',
        performed_at: new Date(rms).toISOString(), performed_at_epoch_ms: BigInt(rms),
        received_at: new Date(rms).toISOString(), received_at_epoch_ms: BigInt(rms),
        signed_off_at: status === 'final' ? new Date(sms).toISOString() : null, signed_off_at_epoch_ms: status === 'final' ? BigInt(sms) : null };
    };
    const orderAt = (offsetMs) => { const ms = AS_OF.getTime() + offsetMs; return { id: 5, test_code: 'ELECTROLYTES', status: 'REQUESTED', requested_at: new Date(ms).toISOString(), requested_at_epoch_ms: BigInt(ms), booking_id: null }; };

    test('every branch carries the four booleans, false, when the attempt has not started', () => {
      for (const args of [{}, { results: [resultAt(-60_000)] }, { orders: [orderAt(-60_000)] }]) {
        expect(resolveItemState({ ...base, ...args })).toMatchObject({ recorded_after_start: false, ordered_after_start: false, received_after_start: false, finalised_after_start: false });
      }
    });
    test('received after start → received_after_start; received before start → false, whatever the sign-off time', () => {
      expect(resolveItemState({ ...base, results: [resultAt(-60_000)], caseStartedAt: startedAt }).received_after_start).toBe(true);
      // received BEFORE start, signed AFTER: the receipt marker is FALSE — that is the owner's distinction
      const out = resolveItemState({ ...base, results: [resultAt(-7_200_000, { signedOffset: -60_000 })], caseStartedAt: startedAt });
      expect(out.received_after_start).toBe(false);
      expect(out.finalised_after_start).toBe(true);
    });
    test('finalised_after_start is false for an unsigned row even when received after start', () => {
      expect(resolveItemState({ ...base, results: [resultAt(-60_000, { status: 'preliminary' })], caseStartedAt: startedAt })).toMatchObject({ received_after_start: true, finalised_after_start: false });
    });
    test('a stale result received after start still marks receipt', () => {
      const old = { ...resultAt(-60_000), performed_at: daysAgo(45), performed_at_epoch_ms: epochAgo(45) };
      expect(resolveItemState({ ...base, results: [old], caseStartedAt: startedAt })).toMatchObject({ state: 'stale', received_after_start: true });
    });
    test('an order placed after start → ordered_after_start; the result markers stay false while awaiting', () => {
      expect(resolveItemState({ ...base, orders: [orderAt(-60_000)], caseStartedAt: startedAt })).toMatchObject({ state: 'ordered_awaiting_sample', ordered_after_start: true, received_after_start: false, finalised_after_start: false });
    });
    test('the epoch twin decides; equal instants and unusable starts answer false', () => {
      expect(resolveItemState({ ...base, results: [{ ...resultAt(-60_000), received_at: daysAgo(10) }], caseStartedAt: startedAt }).received_after_start).toBe(true);
      expect(resolveItemState({ ...base, results: [resultAt(-3_600_000)], caseStartedAt: startedAt }).received_after_start).toBe(false);
      expect(resolveItemState({ ...base, results: [resultAt(-60_000)], caseStartedAt: 'not-a-date' }).received_after_start).toBe(false);
    });
    test('the waiver marker is unchanged', () => {
      const waiver = { waived_by: CTX.actorUid, waived_at: new Date(AS_OF.getTime() - 60_000).toISOString(), waive_reason: 'late' };
      expect(resolveItemState({ ...base, waiver, caseStartedAt: startedAt }).recorded_after_start).toBe(true);
    });
  });
```

- [ ] **Step 10: Run to verify they fail** — the three new keys are undefined.

- [ ] **Step 11: Implement the markers**

Replace `waivedAfterStart` with the shared helper and the wrapper:

```js
// Was an instant (ms since the epoch) after the ACTIVE attempt's start?
// Shared by the four lateness markers (spec §5.4). False when the attempt has
// not started, when the instant is not after it, and when either side is
// unusable: each marker ASSERTS that something happened late, and an unknown
// is not an assertion. Both sides are transaction_timestamp() values, so
// "after" is transaction-start ordering at millisecond resolution.
function afterCaseStartMs(ms, caseStartedAt) {
  if (!caseStartedAt) return false;
  const startedMs = toMs(caseStartedAt);
  if (!Number.isFinite(ms) || !Number.isFinite(startedMs)) return false;
  return ms > startedMs;
}
function waivedAfterStart(waivedAt, caseStartedAt) { return afterCaseStartMs(toMs(waivedAt), caseStartedAt); }
```

In `resolveItemState`'s `base`, after `recorded_after_start: false,`: `ordered_after_start: false, received_after_start: false, finalised_after_start: false, unavailability_cause: null,` (the cause is filled by the refresh, Task 4 — the resolver has no `previous`). In `orderPointer`: `ordered_after_start: afterCaseStartMs(instantMs(openOrder, 'requested_at'), caseStartedAt)`. In the `latestFresh` branch and the `else if (latest)` (stale) branch, add for the deciding row `row`: `received_after_start: afterCaseStartMs(instantMs(row, 'received_at'), caseStartedAt), finalised_after_start: row.signed_off_at != null && afterCaseStartMs(instantMs(row, 'signed_off_at'), caseStartedAt)`. Rename nothing else; `caseStartedAt`'s parameter comment now says "the ACTIVE attempt's start (epoch twin)".

- [ ] **Step 12: Run** — PASS.

- [ ] **Step 13: Write the failing snapshot / picture / time-out / consent tests** (spec §8.2, §4.5, §4.7, §4.3)

```js
describe('start snapshot helpers (spec §8.2)', () => {
  const blocking = [{ check_type: 'labs', reason: 'pending' }, { check_type: 'timeout', reason: 'pending' }];
  test('buildStartSnapshot emits exactly START_SNAPSHOT_KEYS, in order', () => {
    const snap = buildStartSnapshot({ procedureAttempt: 2, via: 'status', commandId: 'cmd-0123456789abcdef', urgency: 'emergency', reason: 'Primary PCI', blocking, missingLabItems: ['hcv', 'hb'], readinessPictureAt: AS_OF.toISOString(), labComponentStatus: 'fresh', consentAuthority: 'emergency_basis', now: AS_OF });
    expect(Object.keys(snap)).toEqual([...START_SNAPSHOT_KEYS]);
    expect(START_SNAPSHOT_KEYS).toEqual(['recorded_at', 'procedure_attempt', 'via', 'command_id', 'procedure_log_id', 'urgency', 'reason', 'blocking', 'missing_lab_items', 'readiness_picture_at', 'lab_component_status', 'consent_authority']);
    expect(snap).toMatchObject({ recorded_at: AS_OF.toISOString(), procedure_attempt: 2, command_id: 'cmd-0123456789abcdef', missing_lab_items: ['hb', 'hcv'], lab_component_status: 'fresh', consent_authority: 'emergency_basis' });
  });
  test('missing_lab_items is null when the lab component is unavailable, and never [] in that case', () => {
    expect(buildStartSnapshot({ procedureAttempt: 1, via: 'status', missingLabItems: null, labComponentStatus: 'unavailable', now: AS_OF }).missing_lab_items).toBeNull();
    expect(() => buildStartSnapshot({ procedureAttempt: 1, via: 'status', missingLabItems: [], labComponentStatus: 'unavailable', now: AS_OF })).toThrow('unavailable');
    expect(() => buildStartSnapshot({ procedureAttempt: 1, via: 'elsewhere', now: AS_OF })).toThrow('via');
  });
  test('startedWithReadinessPending is TRI-state: true / false / null (no snapshot)', () => {
    expect(startedWithReadinessPending({ blocking })).toBe(true);
    expect(startedWithReadinessPending({ blocking: [] })).toBe(false);
    expect(startedWithReadinessPending(null)).toBeNull();
    expect(startedWithReadinessPending({ blocking: 'labs' })).toBeNull();
  });
  test('normalizeStartSnapshot returns the fixed key set (legacy snapshots get nulls for the new keys) or null', () => {
    expect(normalizeStartSnapshot({ via: 'status', blocking, extra: 1 })).toEqual({ recorded_at: null, procedure_attempt: null, via: 'status', command_id: null, procedure_log_id: null, urgency: null, reason: null, blocking, missing_lab_items: null, readiness_picture_at: null, lab_component_status: 'unavailable', consent_authority: null });
    expect(normalizeStartSnapshot(undefined)).toBeNull();
  });
  test('missingLabItemCodes applies the day list rule', () => { /* as revision 1 */ });
  test('labComponentStatus: no rows or no stamp → unavailable; ≤ 5 min → fresh; else stale', () => {
    expect(labComponentStatus({ pictureAt: null, itemCount: 7, now: AS_OF })).toBe('unavailable');
    expect(labComponentStatus({ pictureAt: AS_OF.toISOString(), itemCount: 0, now: AS_OF })).toBe('unavailable');
    expect(labComponentStatus({ pictureAt: new Date(AS_OF.getTime() - 299_000).toISOString(), itemCount: 7, now: AS_OF })).toBe('fresh');
    expect(labComponentStatus({ pictureAt: new Date(AS_OF.getTime() - 301_000).toISOString(), itemCount: 7, now: AS_OF })).toBe('stale');
    expect(START_PICTURE_FRESH_MS).toBe(300_000);
  });
});

describe('timeoutTiming (spec §4.7)', () => {
  const t = (offset) => new Date(AS_OF.getTime() + offset).toISOString();
  test('performed before start, documented after → performed_before_start + documented_after_start', () => {
    expect(timeoutTiming({ performedAt: t(-60_000), documentedAt: t(+600_000), attemptStartedAt: t(0) })).toEqual({ timing: 'performed_before_start', documented_after_start: true });
  });
  test('performed after start → performed_after_start', () => {
    expect(timeoutTiming({ performedAt: t(+30_000), documentedAt: t(+30_000), attemptStartedAt: t(0) }).timing).toBe('performed_after_start');
  });
  test('not passed and the attempt started → not_performed; passed without performed_at → unknown; not started → unknown', () => {
    expect(timeoutTiming({ performedAt: null, documentedAt: null, attemptStartedAt: t(0) }).timing).toBe('not_performed');
    expect(timeoutTiming({ performedAt: null, documentedAt: t(+1), attemptStartedAt: t(0) }).timing).toBe('unknown');
    expect(timeoutTiming({ performedAt: t(-1), documentedAt: t(-1), attemptStartedAt: null }).timing).toBe('unknown');
  });
});

describe('consent vocabularies (spec §4.3)', () => {
  test('authorities and modes are the platform lists', () => {
    expect(CONSENT_AUTHORITIES).toEqual(['patient', 'legally_authorised_representative', 'emergency_basis']);
    expect(CONSENT_MODES).toEqual(['written', 'verbal', 'telephone']);
  });
});
```

Import the new names from the facade: `START_SNAPSHOT_KEYS, START_VIAS, LAB_COMPONENT_STATUSES, START_PICTURE_FRESH_MS, buildStartSnapshot, normalizeStartSnapshot, startedWithReadinessPending, missingLabItemCodes, labComponentStatus, timeoutTiming, classifyUnavailability, UNAVAILABILITY_CAUSES, CONSENT_AUTHORITIES, CONSENT_MODES`.

- [ ] **Step 14: Run to verify they fail** — not exported.

- [ ] **Step 15: Implement the helpers**

```js
// ---------------------------------------------------------------------------
// The at-start snapshot (spec §8.2). Pure: codes, booleans, instants, one
// free-text reason (projected before it leaves the server). Never a lab value.
// ---------------------------------------------------------------------------
export const START_SNAPSHOT_KEYS = Object.freeze([
  'recorded_at', 'procedure_attempt', 'via', 'command_id', 'procedure_log_id', 'urgency', 'reason',
  'blocking', 'missing_lab_items', 'readiness_picture_at', 'lab_component_status', 'consent_authority',
]);
export const START_VIAS = Object.freeze(['status', 'procedure_log']);
export const LAB_COMPONENT_STATUSES = Object.freeze(['fresh', 'stale', 'unavailable']);
// The same order as the read-through refresh's own EVIDENCE_STAMP_MAX_AGE_MS,
// and long enough that the previous getCase of the same case counts as fresh.
export const START_PICTURE_FRESH_MS = 300_000;
export const CONSENT_AUTHORITIES = Object.freeze(['patient', 'legally_authorised_representative', 'emergency_basis']);
export const CONSENT_MODES = Object.freeze(['written', 'verbal', 'telephone']);

function orderedItemCodes(codes) {
  return [...new Set((codes || []).filter((code) => ITEM_CODES.includes(code)))].sort((a, b) => ITEM_CODES.indexOf(a) - ITEM_CODES.indexOf(b));
}

export function labComponentStatus({ pictureAt, itemCount, now = new Date() }) {
  const ms = toMs(pictureAt);
  if (!itemCount || !Number.isFinite(ms)) return 'unavailable';
  return now.getTime() - ms <= START_PICTURE_FRESH_MS ? 'fresh' : 'stale';
}

export function buildStartSnapshot({
  procedureAttempt, via, commandId = null, procedureLogId = null, urgency = null, reason = null, blocking = [],
  missingLabItems = null, readinessPictureAt = null, labComponentStatus: componentStatus = 'unavailable', consentAuthority = null, now = new Date(),
}) {
  if (!START_VIAS.includes(via)) throw AppError.badRequest(`start via must be one of ${START_VIAS.join(', ')}`, 'CATH_LAB_START_VIA_INVALID');
  if (!LAB_COMPONENT_STATUSES.includes(componentStatus)) throw AppError.badRequest('lab component status invalid', 'CATH_LAB_START_VIA_INVALID');
  // UNKNOWN is null, never []: an empty array would read as "nothing missing".
  if (componentStatus === 'unavailable' && Array.isArray(missingLabItems)) throw new Error('missing_lab_items must be null when the lab component is unavailable');
  return {
    recorded_at: new Date(now).toISOString(),
    procedure_attempt: Number(procedureAttempt),
    via,
    command_id: commandId ?? null,
    procedure_log_id: procedureLogId == null ? null : Number(procedureLogId),
    urgency: urgency ?? null,
    reason: reason ?? null,
    blocking: (blocking || []).map((row) => ({ check_type: row.check_type, reason: row.reason })),
    missing_lab_items: componentStatus === 'unavailable' ? null : orderedItemCodes(missingLabItems),
    readiness_picture_at: readinessPictureAt ?? null,
    lab_component_status: componentStatus,
    consent_authority: CONSENT_AUTHORITIES.includes(consentAuthority) ? consentAuthority : null,
  };
}

export function normalizeStartSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const componentStatus = LAB_COMPONENT_STATUSES.includes(raw.lab_component_status) ? raw.lab_component_status : 'unavailable';
  return {
    recorded_at: raw.recorded_at ?? null,
    procedure_attempt: raw.procedure_attempt == null ? null : Number(raw.procedure_attempt),
    via: START_VIAS.includes(raw.via) ? raw.via : null,
    command_id: raw.command_id ?? null,
    procedure_log_id: raw.procedure_log_id == null ? null : Number(raw.procedure_log_id),
    urgency: raw.urgency ?? null,
    reason: raw.reason ?? null,
    blocking: Array.isArray(raw.blocking) ? raw.blocking.map((row) => ({ check_type: row?.check_type, reason: row?.reason })) : [],
    // A legacy (revision-1 shaped or absent) list reads as UNKNOWN, not clean.
    missing_lab_items: Array.isArray(raw.missing_lab_items) && componentStatus !== 'unavailable' ? orderedItemCodes(raw.missing_lab_items) : null,
    readiness_picture_at: raw.readiness_picture_at ?? null,
    lab_component_status: componentStatus,
    consent_authority: CONSENT_AUTHORITIES.includes(raw.consent_authority) ? raw.consent_authority : null,
  };
}

// TRI-state: true / false / null. null = no snapshot (a case started before this
// lane, or an attempt not yet started) — never "no pending checks".
export function startedWithReadinessPending(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.blocking)) return null;
  return raw.blocking.length > 0;
}

export function missingLabItemCodes(items, settings) {
  return orderedItemCodes((items || []).filter((item) => item.required !== false && !isItemAvailable(item, settings)).map((item) => item.item_code));
}

// The time-out's two instants (spec §4.7): performed (team) vs documented (server).
export function timeoutTiming({ performedAt, documentedAt, attemptStartedAt }) {
  const started = toMs(attemptStartedAt);
  const performed = toMs(performedAt);
  const documented = toMs(documentedAt);
  if (!Number.isFinite(started)) return { timing: 'unknown', documented_after_start: false };
  if (!Number.isFinite(documented)) return { timing: 'not_performed', documented_after_start: false };
  if (!Number.isFinite(performed)) return { timing: 'unknown', documented_after_start: documented > started };
  return { timing: performed > started ? 'performed_after_start' : 'performed_before_start', documented_after_start: documented > started };
}
```

Add every new name to the facade's explicit re-export list in `cathLabReadinessService.js` (the facade test fails until you do).

- [ ] **Step 16: Run the suite including the facade test** — PASS.

- [ ] **Step 17: Commit**

```bash
git add apps/backend/src/services/clinical/cathLabReadinessRules.js apps/backend/src/services/clinical/cathLabReadinessService.js apps/backend/src/tests/unit/cathLabReadinessService.test.js
git commit -m "feat(cath): readiness rules — regime keyed on the active attempt and on unavailability_cause, receipt + finalisation markers, attempt-aware start snapshot, lab picture status, time-out timing, consent vocabularies

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
## Task 3: The case service — creation restricted, one start path, consent authority, the reopen door, the exhaustive log, the pin (TDD)

**Files:**
- Modify: `apps/backend/src/services/clinical/cathLabService.js`
- Modify: `apps/backend/src/routes/clinical/cathLabRoutes.js` (`POST /cases/:id/reopen`; creation-route status validation)
- Create: `apps/backend/src/tests/unit/cathLabStartPathPin.test.js`
- Test: `apps/backend/src/tests/unit/cathLabService.test.js`

> Land the **door** (Step 6) before the **refusals** that name it (Steps 7–8), so no error message ever points at a route that does not exist. Every owner point 1–3 and 7 lands here; point 4's write side (attempt increment, check reset) lands in `reopenCaseTx`; point 5's read side (`labsPictureForStartTx`) lands in `startCaseTx`; point 8's write side (authority / mode / `performed_at`) lands in `updateReadinessCheck`.

- [ ] **Step 1: Write the failing unit tests**

In `cathLabService.test.js`: extend the readiness-module mock with `recordReadinessAudit: jest.fn(async () => undefined)` (kept as `recordReadinessAuditMock`), and add a mock for `../../services/clinical/cathLabReadinessHooks.js` exposing `scheduleReadinessRefresh: jest.fn(() => true)` (`scheduleRefreshMock`). `cathLabService` imports the pure helpers (`buildStartSnapshot`, `missingLabItemCodes`, `labComponentStatus`, `CONSENT_AUTHORITIES`, …) from `cathLabReadinessRules.js` directly, which this suite does **not** mock, so the real helpers run. Helpers:

```js
function readinessRows(overrides = {}, meta = {}) {
  return READINESS_TYPES.map((check_type, index) => ({
    id: index + 1, check_type, required: true, status: overrides[check_type] ?? 'pass',
    metadata: check_type === 'labs' ? { live_evidence_refreshed_at: '2026-09-06T04:31:05.001Z' }
      : check_type === 'consent' ? (meta.consent ?? { consent: { authority: 'patient', mode: 'written' } }) : {},
  }));
}
const lockedCase = (status, extra = {}) => ({ ...cathCase(status), urgency: 'emergency', facility_id: 4, procedure_attempt: 1, attempt_started_at: null, actual_start_at: null, start_commands: [], readiness_at_start: null, ...extra });
const startedRow = (extra = {}) => ({ ...cathCase('in_progress'), urgency: 'emergency', facility_id: 4, actual_start_at: '2026-09-06T04:31:07.412Z', attempt_started_at: '2026-09-06T04:31:07.412Z', procedure_attempt: 1, metadata: {}, ...extra });
const CMD = 'a1b2c3d4e5f60718a1b2c3d4e5f60718';
```

The mock sequence for a status start is: locked case → `readinessForCase` rows → stored item rows → `getReadinessSettings` row (if the suite does not already mock it) → `UPDATE … RETURNING *` → `updateCaseCanonicalRefs`. Rename the two old guard tests as revision 1 did (`evaluateReadinessGate` assertions kept under `'evaluateReadinessGate still names every non-clear check'`; the procedure-log test rewritten below). Then:

```js
describe('creation may only create a pre-start case (spec §4.11, decision 14)', () => {
  test('CREATABLE_STATUSES is the three booking states, and nothing that runs or ends a case', () => {
    expect(CREATABLE_STATUSES).toEqual(['requested', 'scheduled', 'readiness_pending']);
    for (const s of ['ready', 'in_progress', 'completed', 'cancelled']) expect(CREATABLE_STATUSES).not.toContain(s);
  });
  test('createCase refuses in_progress / completed / cancelled / ready before any read or write', async () => {
    for (const status of ['in_progress', 'completed', 'cancelled', 'ready']) {
      queryUnsafeMock.mockReset();
      await expect(createCase({ tenantId: TENANT, patient_uid: PATIENT, requested_procedure: 'PTCA', status }))
        .rejects.toMatchObject({ code: 'CATH_LAB_CASE_STATUS_NOT_CREATABLE', statusCode: 400, details: { status, creatable: ['requested', 'scheduled', 'readiness_pending'] } });
      expect(queryUnsafeMock).not.toHaveBeenCalled();
    }
  });
  test('createCase strips the three reserved metadata keys and never names the attempt columns', async () => {
    // Drive createCase with the suite's existing fixture sequence; assert on the INSERT literal and its bound metadata:
    // - JSON.parse(lastBoundArg) has none of readiness_at_start / readiness_at_start_history / start_commands, keeps `source`
    // - the INSERT literal does not mention procedure_attempt or attempt_started_at
  });
});

describe('transitionCaseStatus on a cancelled case (spec §4.2, decision 15 — owner point 2a)', () => {
  test('every target — readiness_pending included — is refused with the door named, BEFORE the table is consulted', async () => {
    for (const status of ['readiness_pending', 'scheduled', 'in_progress', 'completed', 'cancelled']) {
      queryUnsafeMock.mockReset();
      queryUnsafeMock.mockResolvedValueOnce([lockedCase('cancelled', { actual_end_at: '2026-09-06T03:58:11.004Z' })]);
      await expect(transitionCaseStatus(42, { tenantId: TENANT, status, reason: 'x', command_id: CMD }, { actorUid: ACTOR }))
        .rejects.toMatchObject({ code: 'CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED', statusCode: 409, details: { case_status: 'cancelled', requested_status: status, reopen_path: '/api/v1/cath-lab/cases/:id/reopen' } });
      // `scheduled` is NOT a legal table target from cancelled: if the table had been consulted first the
      // code would be INVALID_STATE_TRANSITION. Same door code for every target proves the short-circuit order.
      expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE cath_lab_cases/.test(sql))).toBe(false);
    }
  });
});

describe('startCaseTx — the one start path (spec §4.2)', () => {
  test('START_ELIGIBLE_STATUSES is derived from the table; cancelled is not in it', () => {
    expect(START_ELIGIBLE_STATUSES).toEqual(['scheduled', 'readiness_pending', 'ready']);
    expect(() => validateCaseTransition('cancelled', 'in_progress')).toThrow('Invalid state transition');
  });
  test('the status path requires a well-formed command_id (missing and malformed)', async () => {
    for (const [command_id, reason] of [[undefined, 'missing'], ['short', 'malformed'], ['has spaces in it 0123456789', 'malformed']]) {
      queryUnsafeMock.mockReset();
      queryUnsafeMock.mockResolvedValueOnce([lockedCase('ready')]);
      await expect(transitionCaseStatus(42, { tenantId: TENANT, status: 'in_progress', command_id }, { actorUid: ACTOR }))
        .rejects.toMatchObject({ code: 'CATH_LAB_START_COMMAND_REQUIRED', statusCode: 400, details: { reason } });
    }
  });
  test('consent pending / waived / not_applicable refuses before anything is written', async () => {
    for (const consent of ['pending', 'waived', 'not_applicable']) {
      queryUnsafeMock.mockReset(); recordReadinessAuditMock.mockClear();
      queryUnsafeMock.mockResolvedValueOnce([lockedCase('readiness_pending')]).mockResolvedValueOnce(readinessRows({ consent, labs: 'pending' }));
      await expect(transitionCaseStatus(42, { tenantId: TENANT, status: 'in_progress', reason: 'x', command_id: CMD }, { actorUid: ACTOR }))
        .rejects.toMatchObject({ code: 'CATH_LAB_CONSENT_REQUIRED', statusCode: 400, details: { consent_status: consent } });
      expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE cath_lab_cases/.test(sql))).toBe(false);
      expect(recordReadinessAuditMock).not.toHaveBeenCalled();
    }
  });
  test('a legacy consent pass (no metadata.consent) satisfies the block with consent_authority null', async () => { /* readinessRows({}, { consent: {} }) → starts; snapshot.consent_authority === null */ });
  test('a pending gate needs a reason on the status path; the refusal names the checks', async () => { /* as revision 1, with command_id: CMD */ });
  test('consent pass + labs pending + reason: starts, snapshots (12 keys), binds the command, audits, emits, schedules the refresh AFTER commit', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([lockedCase('readiness_pending')])
      .mockResolvedValueOnce(readinessRows({ labs: 'pending', timeout: 'pending' }, { consent: { consent: { authority: 'emergency_basis', mode: 'verbal' } } }))
      .mockResolvedValueOnce([{ item_code: 'hcv', required: true, state: 'not_ordered' }, { item_code: 'hb', required: true, state: 'result_final' }])
      .mockResolvedValueOnce([startedRow()])
      .mockResolvedValueOnce([]);
    const result = await transitionCaseStatus(42, { tenantId: TENANT, status: 'in_progress', reason: 'Primary PCI, outside reports awaited', command_id: CMD }, { actorUid: ACTOR, actorRole: 'CONSULTANT' });
    expect(result.status).toBe('in_progress');
    const update = queryUnsafeMock.mock.calls.find(([sql]) => /UPDATE cath_lab_cases/.test(sql));
    expect(update[0]).toMatch(/status = 'in_progress'/);
    expect(update[0]).toMatch(/actual_start_at = COALESCE\(actual_start_at, NOW\(\)\)/);
    expect(update[0]).toMatch(/attempt_started_at = NOW\(\)/);
    expect(update[0]).toMatch(/'start_commands'/);
    const snapshot = JSON.parse(update[3]);
    expect(Object.keys(snapshot)).toEqual([...START_SNAPSHOT_KEYS]);
    expect(snapshot).toMatchObject({ procedure_attempt: 1, via: 'status', command_id: CMD, missing_lab_items: ['hcv'], readiness_picture_at: '2026-09-06T04:31:05.001Z', lab_component_status: expect.stringMatching(/fresh|stale/), consent_authority: 'emergency_basis' });
    expect(JSON.parse(update[4])).toEqual([{ command_id: CMD, procedure_attempt: 1, via: 'status', recorded_at: snapshot.recorded_at }]);
    expect(recordReadinessAuditMock).toHaveBeenCalledWith(__prismaDefaultMock, expect.objectContaining({
      action: 'cath_lab.case.started_with_readiness_pending', metadata: expect.objectContaining({ case_id: 42, facility_id: 4, procedure_attempt: 1, command_id: CMD, consent_authority: 'emergency_basis' }),
    }));
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'cath_lab.case_in_progress', payload: expect.objectContaining({ procedure_attempt: 1, command_id: CMD, started_with_readiness_pending: true }) }), expect.anything());
    // The refresh is scheduled by the CALLER after the transaction callback returned — never inside startCaseTx.
    expect(scheduleRefreshMock).toHaveBeenCalledTimes(1);
    expect(scheduleRefreshMock).toHaveBeenCalledWith({ tenantId: TENANT, patientUid: PATIENT, source: 'cath_case_start' });
  });
  test('THE OWNER\'S TEST: the start never waits on the lab rail', async () => {
    // refreshCaseLabReadiness is mocked to a promise that NEVER settles. If the start awaited it, this test would time out.
    refreshCaseLabReadinessMock.mockImplementation(() => new Promise(() => {}));
    queryUnsafeMock.mockResolvedValueOnce([lockedCase('ready')]).mockResolvedValueOnce(readinessRows()).mockResolvedValueOnce([]).mockResolvedValueOnce([startedRow()]).mockResolvedValueOnce([]);
    const started = transitionCaseStatus(42, { tenantId: TENANT, status: 'in_progress', command_id: CMD }, { actorUid: ACTOR });
    const winner = await Promise.race([started.then(() => 'started'), new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000))]);
    expect(winner).toBe('started');
    expect(refreshCaseLabReadinessMock).not.toHaveBeenCalled();
    expect(scheduleRefreshMock).toHaveBeenCalledTimes(1);
  });
  test('no item rows → missing_lab_items null and lab_component_status unavailable (unknown, never clean)', async () => { /* stored items [] → snapshot.missing_lab_items === null, lab_component_status === 'unavailable' */ });
  test('a clean start writes blocking [] and no audit row', async () => { /* as revision 1 */ });
  test('command replay: same attempt while in_progress → the case as it stands, nothing written; another attempt → 409 STALE', async () => {
    queryUnsafeMock.mockReset();
    queryUnsafeMock.mockResolvedValueOnce([lockedCase('in_progress', { attempt_started_at: 'x', start_commands: [{ command_id: CMD, procedure_attempt: 1 }] })]).mockResolvedValueOnce([startedRow()]); // SELECT * replay read
    const replay = await transitionCaseStatus(42, { tenantId: TENANT, status: 'in_progress', command_id: CMD }, { actorUid: ACTOR });
    expect(replay.status).toBe('in_progress');
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE cath_lab_cases/.test(sql))).toBe(false);
    queryUnsafeMock.mockReset();
    queryUnsafeMock.mockResolvedValueOnce([lockedCase('readiness_pending', { procedure_attempt: 2, start_commands: [{ command_id: CMD, procedure_attempt: 1 }] })]);
    await expect(transitionCaseStatus(42, { tenantId: TENANT, status: 'in_progress', reason: 'old', command_id: CMD }, { actorUid: ACTOR }))
      .rejects.toMatchObject({ code: 'CATH_LAB_START_COMMAND_STALE', statusCode: 409, details: { command_attempt: 1, current_attempt: 2, case_status: 'readiness_pending' } });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE cath_lab_cases/.test(sql))).toBe(false);
  });
});

describe('recordProcedureLog — the exhaustive table (spec §4.2, decision 16 — owner point 3)', () => {
  const log = (status) => ({ id: 7, tenant_id: TENANT, case_id: 42, patient_uid: PATIENT, encounter_id: ENCOUNTER, procedure_type: 'PTCA', status });
  test('start-eligible × finalized: inserts, then starts through startCaseTx (via procedure_log, log id in the snapshot, no reason needed, command optional)', async () => { /* mock: case, INSERT log, readiness rows, items, UPDATE, refs, log-id UPDATE, registry → snapshot.via === 'procedure_log', procedure_log_id 7, reason null; scheduleRefreshMock once */ });
  test('start-eligible × draft: inserts, case UNTOUCHED (no consent read, no start, no snapshot, no refresh)', async () => {
    for (const status of ['scheduled', 'readiness_pending', 'ready']) {
      queryUnsafeMock.mockReset(); scheduleRefreshMock.mockClear();
      queryUnsafeMock.mockResolvedValueOnce([lockedCase(status)]).mockResolvedValueOnce([log('draft')]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await recordProcedureLog(42, { tenantId: TENANT, procedure_type: 'PTCA', status: 'draft' }, { actorUid: ACTOR });
      expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE cath_lab_cases|FROM cath_lab_readiness_checks/.test(sql))).toBe(false);
      expect(scheduleRefreshMock).not.toHaveBeenCalled();
    }
  });
  test('start-eligible × amended: inserts, case untouched', async () => { /* same shape as draft */ });
  test('in_progress / completed × any log status: inserts, case untouched', async () => { /* as revision 1, all three log statuses */ });
  test('cancelled × any: 409 CANCELLED_REOPEN_REQUIRED before the insert', async () => { /* as revision 1; assert no INSERT INTO cath_procedure_logs */ });
  test('requested × any: 409 START_NOT_ELIGIBLE before the insert, next_action names the scheduled transition', async () => {
    queryUnsafeMock.mockReset();
    queryUnsafeMock.mockResolvedValueOnce([lockedCase('requested')]);
    await expect(recordProcedureLog(42, { tenantId: TENANT, procedure_type: 'PTCA' }, { actorUid: ACTOR }))
      .rejects.toMatchObject({ code: 'CATH_LAB_CASE_START_NOT_ELIGIBLE', statusCode: 409, details: { case_status: 'requested', next_action: { path: '/api/v1/cath-lab/cases/:id/status', body: { status: 'scheduled' } } } });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO cath_procedure_logs/.test(sql))).toBe(false);
  });
  test('an unexpected status: 409 START_NOT_ELIGIBLE before the insert (defensive row)', async () => { /* lockedCase('bogus') → details.case_status === 'bogus' */ });
  test('the finalized log is refused by the consent block too (hazard ii)', async () => { /* as revision 1 */ });
});

describe('consent and time-out writes (spec §4.3, §4.7 — owner point 8)', () => {
  test('a consent pass without authority/mode → 400 CONSENT_AUTHORITY_REQUIRED before any write', async () => { /* updateReadinessCheck(42, { check_type: 'consent', status: 'pass' }) with a locked case → rejects; no INSERT/UPDATE */ });
  test('a consent pass with an authority outside the tenant policy → 400 CONSENT_AUTHORITY_NOT_PERMITTED with details.permitted', async () => { /* tenants.settings mock → { cath_lab: { consent_authorities: ['patient'] } }; authority 'emergency_basis' → rejects */ });
  test('a consent pass with a permitted authority stores { consent: { authority, mode, documented_at } }, documented_at server-stamped', async () => { /* assert the bound metadata JSON; a client documented_at is ignored */ });
  test('a timeout pass without a usable past performed_at → 400 TIMEOUT_PERFORMED_AT_REQUIRED; with one, completed_at is NOW() (client value ignored)', async () => { /* future performed_at refused; assert the upsert binds NULL for $7 / NOW() branch for timeout */ });
});

describe('reopenCaseTx — the door out of cancelled (spec §4.8, decisions 13/15/17 — owner points 2b, 4)', () => {
  test('constants: cancelled → [readiness_pending]; REOPENABLE_STATUSES; REOPEN_TARGET_STATUS; ATTEMPT_RESET_CHECKS', () => {
    expect(CASE_TRANSITIONS.cancelled).toEqual(['readiness_pending']);
    expect(REOPENABLE_STATUSES).toEqual(['cancelled']);
    expect(REOPEN_TARGET_STATUS).toBe('readiness_pending');
    expect(ATTEMPT_RESET_CHECKS).toEqual(['consent', 'timeout']);
  });
  test('EVERY non-cancelled status is refused with INVALID_STATE_TRANSITION and its real allowed list — scheduled included (owner point 2b)', async () => {
    for (const status of ['requested', 'scheduled', 'readiness_pending', 'ready', 'in_progress', 'completed']) {
      queryUnsafeMock.mockReset(); recordReadinessAuditMock.mockClear();
      queryUnsafeMock.mockResolvedValueOnce([lockedCase(status)]);
      await expect(reopenCase(42, { tenantId: TENANT, reason: 'x' }, { actorUid: ACTOR }))
        .rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: { from: status, to: 'readiness_pending', allowed: CASE_TRANSITIONS[status] } });
      expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE/.test(sql))).toBe(false);
    }
  });
  test('no reason → 400 REOPEN_REASON_REQUIRED, nothing written', async () => { /* as revision 1 */ });
  test('cancelled BEFORE it ever started: same attempt, no check reset, actual_end_at cleared, audit row', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([lockedCase('cancelled', { actual_end_at: 'e', attempt_started_at: null, actual_start_at: null })])
      .mockResolvedValueOnce([{ payload: { reason: 'List overran' } }])   // latest cath_lab.case_cancelled event
      .mockResolvedValueOnce([{ ...lockedCase('readiness_pending'), actual_end_at: null }])
      .mockResolvedValueOnce([]);                                          // refs
    await reopenCase(42, { tenantId: TENANT, reason: 'Slot freed' }, { actorUid: ACTOR });
    const update = queryUnsafeMock.mock.calls.find(([sql]) => /UPDATE cath_lab_cases/.test(sql));
    expect(update[0]).toMatch(/status = 'readiness_pending'/); expect(update[0]).toMatch(/actual_end_at = NULL/); expect(update[0]).toMatch(/attempt_started_at = NULL/);
    expect(update[0]).not.toMatch(/actual_start_at =/); expect(update[0]).not.toMatch(/in_progress/);
    expect(update[4]).toBe(1);   // procedure_attempt unchanged
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE cath_lab_readiness_checks/.test(sql))).toBe(false);
    expect(recordReadinessAuditMock).toHaveBeenCalledWith(__prismaDefaultMock, expect.objectContaining({ action: 'cath_lab.case.reopened', metadata: expect.objectContaining({ previous_attempt: 1, procedure_attempt: 1, checks_reset: [], cancel_reason: 'List overran', cancelled_at: 'e' }) }));
  });
  test('cancelled AFTER it had started: attempt N+1, snapshot moved to history, consent + timeout reset with previous_attempts preserved, actual_start_at kept', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([lockedCase('cancelled', { actual_end_at: 'e', attempt_started_at: 's', actual_start_at: 's', procedure_attempt: 1 })])
      .mockResolvedValueOnce([])                                            // no cancel event
      .mockResolvedValueOnce([{ ...lockedCase('readiness_pending'), procedure_attempt: 2, actual_start_at: 's', actual_end_at: null }])
      .mockResolvedValueOnce([])                                            // checks reset UPDATE
      .mockResolvedValueOnce([]);                                           // refs
    await reopenCase(42, { tenantId: TENANT, reason: 'Resuming' }, { actorUid: ACTOR });
    const caseUpdate = queryUnsafeMock.mock.calls.find(([sql]) => /UPDATE cath_lab_cases/.test(sql));
    expect(caseUpdate[4]).toBe(2);
    expect(caseUpdate[0]).toMatch(/readiness_at_start_history/);
    const checksUpdate = queryUnsafeMock.mock.calls.find(([sql]) => /UPDATE cath_lab_readiness_checks/.test(sql));
    expect(checksUpdate[0]).toMatch(/check_type IN \('consent', 'timeout'\)/);
    expect(checksUpdate[0]).toMatch(/status = 'pending'/); expect(checksUpdate[0]).toMatch(/completed_at = NULL/); expect(checksUpdate[0]).toMatch(/'previous_attempts'/);
    expect(recordReadinessAuditMock).toHaveBeenCalledWith(__prismaDefaultMock, expect.objectContaining({ metadata: expect.objectContaining({ previous_attempt: 1, procedure_attempt: 2, previous_attempt_started_at: 's', checks_reset: ['consent', 'timeout'] }) }));
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'cath_lab.case_reopened', payload: expect.objectContaining({ procedure_attempt: 2, previous_attempt: 1, checks_reset: ['consent', 'timeout'] }) }), expect.anything());
  });
});
```

Import `CASE_TRANSITIONS, START_ELIGIBLE_STATUSES, REOPENABLE_STATUSES, REOPEN_TARGET_STATUS, CREATABLE_STATUSES, ATTEMPT_RESET_CHECKS, reopenCase, createCase, updateReadinessCheck` from the service and `START_SNAPSHOT_KEYS` from the rules module. `refreshCaseLabReadinessMock` is the readiness-module mock's `refreshCaseLabReadiness` (the suite already mocks that module; make sure the name is captured at top level).

- [ ] **Step 2: Run to verify they fail** — `npm test -- --testPathPatterns unit/cathLabService.test`. Expected: FAIL across the board (constants undefined; `createCase` accepts `in_progress`; the cancelled case answers `INVALID_STATE_TRANSITION` from the table; consent tests get `CATH_LAB_READINESS_BLOCKED`; the reopen loop lets `scheduled` through; the never-settling test hangs until the 2 s race).

- [ ] **Step 3: Implement — constants and transitions** (spec §4.1)

```js
export const CASE_TRANSITIONS = Object.freeze({
  requested: ['scheduled', 'cancelled'],
  // Owner principle 2026-09-06: the checklist informs and records; it never
  // restricts. scheduled / readiness_pending may start (STEMI's emergency case
  // is readiness_pending); the authority to proceed is asserted in startCaseTx.
  scheduled: ['readiness_pending', 'ready', 'in_progress', 'cancelled'],
  readiness_pending: ['ready', 'in_progress', 'cancelled'],
  ready: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  // Decision 13/15: the ONE way out of cancellation, and it is a pre-start
  // status. transitionCaseStatus refuses a cancelled case BEFORE reading this
  // table; only reopenCaseTx makes this transition.
  cancelled: ['readiness_pending']
});
export const START_ELIGIBLE_STATUSES = Object.freeze(Object.entries(CASE_TRANSITIONS).filter(([, t]) => t.includes('in_progress')).map(([from]) => from));
export const REOPENABLE_STATUSES = Object.freeze(['cancelled']);
export const REOPEN_TARGET_STATUS = 'readiness_pending';
// Decision 14: ordinary creation makes a BOOKING. `ready` is a gate result, not
// a booking state; in_progress / completed / cancelled are reachable only
// through the functions that record why. Historical import is a separate,
// explicitly governed path and does not exist yet — intended.
export const CREATABLE_STATUSES = Object.freeze(['requested', 'scheduled', 'readiness_pending']);
// Decision 16: only a FINALIZED log is the team's statement that the procedure
// occurred; a draft is preparation and starts nothing. One constant, one line
// of the deep test, if the owner decides otherwise.
export const START_LOG_STATUSES = Object.freeze(['finalized']);
// Decision 17: what a NEW attempt re-documents. The time-out is performed at the
// table immediately before the invasive act; the authority to proceed is
// documented for a procedure event, not a case row. One constant to change.
export const ATTEMPT_RESET_CHECKS = Object.freeze(['consent', 'timeout']);
const CASE_START_METADATA_KEYS = Object.freeze(['readiness_at_start', 'readiness_at_start_history', 'start_commands']);
```

Import `CONSENT_AUTHORITIES, CONSENT_MODES, buildStartSnapshot, normalizeStartSnapshot, missingLabItemCodes, labComponentStatus` from `./cathLabReadinessRules.js`; `recordReadinessAudit, getReadinessSettings` from `./cathLabReadinessService.js`; `scheduleReadinessRefresh` from `./cathLabReadinessHooks.js`.

- [ ] **Step 4: Implement — the hard block, the consent policy, the check-write validation** (spec §4.3, §4.7)

Replace `assertReadinessComplete` with `assertConsentDocumented` exactly as spec §4.3 (returns `{ gate, checks, consent }`; the old name must not survive anywhere — the pin greps for it). Add:

```js
// The hospital's consent policy: which authorities to proceed exist here.
// Per-tenant configuration (tenants.settings.cath_lab.consent_authorities),
// default all three. Hospital configuration, not an owner decision (spec §4.3).
async function consentPolicyFor(tenantId, db) {
  const rows = normalizeRows(await db.$queryRawUnsafe(
    `SELECT settings->'cath_lab'->'consent_authorities' AS authorities FROM tenants WHERE id = $1::uuid LIMIT 1`, tenantOr(tenantId)));
  const configured = Array.isArray(rows[0]?.authorities) ? rows[0].authorities.filter((a) => CONSENT_AUTHORITIES.includes(a)) : [];
  return configured.length ? configured : [...CONSENT_AUTHORITIES];
}
```

(Read the `tenants` primary-key column name off `schema.prisma` before pasting; remember `tenants` may be unreadable without the tenant GUC under RLS — this runs inside the tenant transaction, which sets it.) In `updateReadinessCheck`, **before** the upsert and before any write:

```js
    if (checkType === 'consent' && status === 'pass') {
      const consent = input.metadata?.consent;
      if (!consent || !CONSENT_AUTHORITIES.includes(consent.authority) || !CONSENT_MODES.includes(consent.mode)) {
        throw AppError.badRequest('A consent pass must record who gave the authority to proceed (authority) and how it was communicated (mode)', 'CATH_LAB_CONSENT_AUTHORITY_REQUIRED', { authorities: CONSENT_AUTHORITIES, modes: CONSENT_MODES });
      }
      const permitted = await consentPolicyFor(tenantId, tx);
      if (!permitted.includes(consent.authority)) {
        throw AppError.badRequest('This authority to proceed is not permitted by the hospital\'s consent policy', 'CATH_LAB_CONSENT_AUTHORITY_NOT_PERMITTED', { authority: consent.authority, permitted });
      }
      metadata = { ...metadata, consent: { authority: consent.authority, mode: consent.mode, documented_at: new Date().toISOString() } };  // server-stamped; a client documented_at is dropped
    }
    if (checkType === 'timeout' && status === 'pass') {
      const performedAt = optionalTimestamp(input.metadata?.timeout?.performed_at, 'performed_at');
      if (!performedAt || new Date(performedAt).getTime() > Date.now()) {
        throw AppError.badRequest('A time-out pass must record when the time-out was performed (a past instant)', 'CATH_LAB_TIMEOUT_PERFORMED_AT_REQUIRED');
      }
      metadata = { ...metadata, timeout: { performed_at: new Date(performedAt).toISOString(), documented_at: null } };  // documented_at = completed_at, set below
      completedAtOverride = null;   // the ONE check type whose client completed_at is ignored: the two instants must not be conflated
    }
```

and bind `$7` from `completedAtOverride` (defaulting to today's `optionalTimestamp(input.completed_at || input.completedAt)`) so the upsert's `COALESCE($7::timestamptz, NOW())` stamps NOW() for the time-out; after the upsert, for `timeout`, patch `metadata.timeout.documented_at` to the returned `completed_at` (one small `UPDATE … SET metadata = metadata || jsonb_build_object('timeout', …)` on `cath_lab_readiness_checks`, or fold it into the upsert with `NOW()` — either is fine; the deep test only checks the stored value equals `completed_at`).

- [ ] **Step 5: Implement — `caseById`, `normalizeCommandId`, `labsPictureForStartTx`, `startCaseTx`** (spec §4.2, §4.5, §4.10)

`caseById`'s SELECT gains `procedure_attempt, attempt_started_at, metadata->'start_commands' AS start_commands, metadata->'readiness_at_start' AS readiness_at_start` (JSON paths — never the whole `metadata` column).

```js
const COMMAND_ID = /^[A-Za-z0-9_.:-]{16,128}$/;
// An opaque client token, bound to (case, attempt). A UUID passes; so does the
// hex token IdempotencyKey.generate() mints in the Staff app.
function normalizeCommandId(value) {
  const text = cleanText(value, 128);
  return text && COMMAND_ID.test(text) ? text : null;
}

// The LAST COMMITTED lab picture (spec §4.5): the stored item rows and the labs
// check's evidence stamp. No refresh is called; nothing is awaited on the lab
// rail. Missing rows mean UNKNOWN, never "nothing missing".
async function labsPictureForStartTx(tx, tenantId, caseId, checks) {
  const items = normalizeRows(await tx.$queryRawUnsafe(
    `SELECT item_code, required, state FROM cath_case_lab_readiness_items WHERE tenant_id = $1::uuid AND case_id = $2::bigint`,
    tenantOr(tenantId), normalizeId(caseId, 'case_id')));
  const settings = await getReadinessSettings({ tenantId: tenantOr(tenantId), db: tx });
  const labsCheck = checks.find((check) => check.check_type === 'labs');
  const pictureAt = labsCheck?.metadata?.live_evidence_refreshed_at ?? null;
  const status = labComponentStatus({ pictureAt, itemCount: items.length, now: new Date() });
  return { missing: status === 'unavailable' ? null : missingLabItemCodes(items, settings), picture_at: pictureAt, lab_component_status: status };
}

// THE ONE START PATH (spec §4.2). transitionCaseStatus and recordProcedureLog
// come here and nowhere else moves a case to in_progress or sets
// actual_start_at / attempt_started_at — cathLabStartPathPin.test.js pins the
// counts, the SQL shapes and the write-site population. Caller holds the row
// FOR UPDATE. Never awaits the lab rail; the CALLER schedules the refresh after
// commit.
async function startCaseTx(tx, { tenantId, cathCase, reason = null, via, commandId = null, procedureLogId = null, context = {} }) {
  // 1. Command binding (decision 20). A replay against the SAME attempt answers
  //    the started case; against ANOTHER attempt it is refused — the sequence
  //    "start, response lost, cancel, reopen, retry" must not start attempt 2.
  const command = normalizeCommandId(commandId);
  if (via === 'status' && !command) {
    throw AppError.badRequest('A stable command_id is required to start the procedure', 'CATH_LAB_START_COMMAND_REQUIRED', { reason: commandId == null ? 'missing' : 'malformed' });
  }
  const priorCommands = Array.isArray(cathCase.start_commands) ? cathCase.start_commands : [];
  const prior = command ? priorCommands.find((entry) => entry?.command_id === command) : null;
  if (prior) {
    if (Number(prior.procedure_attempt) === Number(cathCase.procedure_attempt) && cathCase.status === 'in_progress') {
      const current = unwrap(await tx.$queryRawUnsafe(`SELECT * FROM cath_lab_cases WHERE tenant_id = $1::uuid AND id = $2::bigint`, tenantOr(tenantId), cathCase.id));
      return { updated: normalizeDbValue(current), snapshot: normalizeStartSnapshot(cathCase.readiness_at_start), replayed: true };
    }
    throw AppError.conflict('This start command belongs to an earlier attempt of this case; review the checklist and start again', 'CATH_LAB_START_COMMAND_STALE',
      { command_attempt: Number(prior.procedure_attempt), current_attempt: Number(cathCase.procedure_attempt), case_status: cathCase.status });
  }
  // 2. Eligibility. cancelled never reaches here (both callers refuse it first) — the guard stays.
  if (!START_ELIGIBLE_STATUSES.includes(cathCase.status)) {
    throw AppError.invalidTransition(cathCase.status, 'in_progress', CASE_TRANSITIONS[cathCase.status] || []);
  }
  // 3. The one hard block. Throws before anything is written.
  const { gate, checks, consent } = await assertConsentDocumented(tx, tenantId, cathCase.id);
  // 4. Reason: the owner's control on an EXPLICIT start with checks pending (decision 4).
  const cleanReason = cleanText(reason, 500);
  if (!gate.ready && via === 'status' && !cleanReason) {
    throw AppError.badRequest('A reason is required to start the procedure while readiness checks are pending', 'CATH_LAB_START_REASON_REQUIRED', { blocking: gate.blocking });
  }
  // 5. The last committed lab picture (decision 18).
  const labs = await labsPictureForStartTx(tx, tenantId, cathCase.id, checks);
  // 6. The snapshot, keyed by attempt (decisions 5, 17).
  const snapshot = buildStartSnapshot({
    procedureAttempt: cathCase.procedure_attempt, via, commandId: command, procedureLogId, urgency: cathCase.urgency ?? null, reason: cleanReason,
    blocking: gate.blocking, missingLabItems: labs.missing, readinessPictureAt: labs.picture_at, labComponentStatus: labs.lab_component_status,
    consentAuthority: consent?.authority ?? null
  });
  const commandEntries = command ? [{ command_id: command, procedure_attempt: Number(cathCase.procedure_attempt), via, recorded_at: snapshot.recorded_at }] : [];
  // 7. One UPDATE. A MERGE into metadata, never a replacement (STEMI's keys and the history array survive).
  const rows = await tx.$queryRawUnsafe(
    `UPDATE cath_lab_cases
        SET status = 'in_progress',
            actual_start_at = COALESCE(actual_start_at, NOW()),
            attempt_started_at = NOW(),
            metadata = COALESCE(metadata, '{}'::jsonb)
                       || jsonb_build_object('readiness_at_start', $3::jsonb)
                       || jsonb_build_object('start_commands', COALESCE(metadata->'start_commands', '[]'::jsonb) || $4::jsonb),
            updated_by = $5::uuid,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::bigint
      RETURNING *`,
    tenantOr(tenantId), cathCase.id, JSON.stringify(snapshot), JSON.stringify(commandEntries), maybeUuid(context.actorUid, 'actorUid'));
  const updated = unwrap(rows);
  const startedWithPending = gate.blocking.length > 0;
  const event = await writeCanonicalEvent(tx, {
    tenantId, patientUid: updated.patient_uid, encounterId: updated.encounter_id,
    eventType: 'cath_lab.case_in_progress', eventStatus: 'in_progress', sourceTable: 'cath_lab_cases', sourceId: updated.id,
    actorUid: context.actorUid, actorRole: context.actorRole,
    summary: `Cath-lab case in_progress: ${updated.requested_procedure}`,
    payload: { status: 'in_progress', reason: cleanReason, via, procedure_attempt: Number(cathCase.procedure_attempt), command_id: command, started_with_readiness_pending: startedWithPending, readiness_at_start: snapshot },
    beforeState: { status: cathCase.status }, afterState: { status: 'in_progress' }
    // + visibleToPatient: false if Task 0 Survey C found the writer defaults it on
  });
  await updateCaseCanonicalRefs(tx, { tenantId, caseId: updated.id, event });
  if (startedWithPending) {
    await recordReadinessAudit(tx, {
      tenantId: tenantOr(tenantId), action: 'cath_lab.case.started_with_readiness_pending', resource: 'cath_lab_cases', resourceId: updated.id, context,
      metadata: { case_id: normalizeDbValue(updated.id), facility_id: updated.facility_id ?? null, ...snapshot }
    });
  }
  return { updated: normalizeDbValue(updated), snapshot, replayed: false };
}
```

- [ ] **Step 6: Implement — `reopenCaseTx`, `reopenCase`, `latestCancelReasonTx`, the route (the door)** (spec §4.8)

```js
// THE DOOR OUT OF CANCELLATION (spec §4.8; owner: "deliberate, auditable, and
// nothing stranded"). Not a start: it writes readiness_pending, an existing
// pre-start status. Takes ONLY a cancelled case (decision 15 — the table check
// alone would also admit scheduled). If the previous attempt had started it
// opens attempt N+1 (decision 17): the active start is cleared, the snapshot
// moves to history, consent and time-out are reset with their previous
// documentation preserved; actual_start_at — the FIRST start — is kept.
async function reopenCaseTx(tx, { tenantId, cathCase, reason, context = {} }) {
  if (cathCase.status !== 'cancelled') {
    throw AppError.invalidTransition(cathCase.status, REOPEN_TARGET_STATUS, CASE_TRANSITIONS[cathCase.status] || []);
  }
  validateCaseTransition('cancelled', REOPEN_TARGET_STATUS);   // table consistency; cannot throw while the door pin holds
  const cleanReason = cleanText(reason, 500);                  // the PARAMETER (owner point 2b), not input.reason
  if (!cleanReason) throw AppError.badRequest('A reason is required to reopen a cancelled case', 'CATH_LAB_REOPEN_REASON_REQUIRED', { case_status: 'cancelled' });
  const cancelledAt = cathCase.actual_end_at ?? null;
  const previousAttemptStartedAt = cathCase.attempt_started_at ?? null;
  const previousAttempt = Number(cathCase.procedure_attempt);
  const newAttempt = previousAttemptStartedAt ? previousAttempt + 1 : previousAttempt;   // an attempt that never started is not a new attempt
  const cancelReason = await latestCancelReasonTx(tx, tenantId, cathCase.id);
  const rows = await tx.$queryRawUnsafe(
    `UPDATE cath_lab_cases
        SET status = 'readiness_pending',
            actual_end_at = NULL,
            attempt_started_at = NULL,
            procedure_attempt = $4::int,
            metadata = (COALESCE(metadata, '{}'::jsonb) - 'readiness_at_start')
                       || jsonb_build_object('readiness_at_start_history',
                            COALESCE(metadata->'readiness_at_start_history', '[]'::jsonb)
                            || CASE WHEN jsonb_typeof(metadata->'readiness_at_start') = 'object'
                                    THEN jsonb_build_array(metadata->'readiness_at_start') ELSE '[]'::jsonb END),
            updated_by = $3::uuid,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::bigint
      RETURNING *`,
    tenantOr(tenantId), cathCase.id, maybeUuid(context.actorUid, 'actorUid'), newAttempt);
  const updated = unwrap(rows);
  let checksReset = [];
  if (newAttempt > previousAttempt) {
    await tx.$executeRawUnsafe(
      `UPDATE cath_lab_readiness_checks
          SET status = 'pending', completed_at = NULL, completed_by = NULL,
              metadata = (COALESCE(metadata, '{}'::jsonb) - 'consent' - 'timeout')
                         || jsonb_build_object('previous_attempts',
                              COALESCE(metadata->'previous_attempts', '[]'::jsonb)
                              || jsonb_build_array(jsonb_build_object(
                                   'procedure_attempt', $3::int, 'status', status, 'completed_at', completed_at, 'completed_by', completed_by,
                                   'consent', metadata->'consent', 'timeout', metadata->'timeout'))),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND check_type IN ('consent', 'timeout')`,
      tenantOr(tenantId), cathCase.id, previousAttempt);
    checksReset = [...ATTEMPT_RESET_CHECKS];
  }
  const event = await writeCanonicalEvent(tx, {
    tenantId, patientUid: updated.patient_uid, encounterId: updated.encounter_id,
    eventType: 'cath_lab.case_reopened', eventStatus: REOPEN_TARGET_STATUS, sourceTable: 'cath_lab_cases', sourceId: updated.id,
    actorUid: context.actorUid, actorRole: context.actorRole, summary: `Cath-lab case reopened: ${updated.requested_procedure}`,
    payload: { status: REOPEN_TARGET_STATUS, reason: cleanReason, previous_status: 'cancelled', previous_attempt: previousAttempt, procedure_attempt: newAttempt, checks_reset: checksReset },
    beforeState: { status: 'cancelled' }, afterState: { status: REOPEN_TARGET_STATUS }
  });
  await updateCaseCanonicalRefs(tx, { tenantId, caseId: updated.id, event });
  await recordReadinessAudit(tx, {   // ALWAYS: the audit row IS the decision
    tenantId: tenantOr(tenantId), action: 'cath_lab.case.reopened', resource: 'cath_lab_cases', resourceId: updated.id, context,
    metadata: { case_id: normalizeDbValue(updated.id), facility_id: updated.facility_id ?? null, reason: cleanReason, previous_status: 'cancelled', cancelled_at: cancelledAt, cancel_reason: cancelReason,
      urgency: updated.urgency ?? null, previous_attempt: previousAttempt, procedure_attempt: newAttempt, previous_attempt_started_at: previousAttemptStartedAt, checks_reset: checksReset }
  });
  return { updated: normalizeDbValue(updated), procedureAttempt: newAttempt, checksReset };
}

export async function reopenCase(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  return setTenantTx(tenantId, async (tx) => {
    const cathCase = await caseById(tx, tenantId, caseId, { lock: true });
    const { updated } = await reopenCaseTx(tx, { tenantId, cathCase, reason: input.reason, context });
    return updated;
  });
}
```

`ATTEMPT_RESET_CHECKS` must equal the literal `('consent', 'timeout')` in the SQL — add a one-line unit assertion that the literal in the source contains each constant member (or bind the list as `$4::text[]`; either way the pin's `SET status =` scan is unaffected because the literal names `cath_lab_readiness_checks`, not `cath_lab_cases`). `latestCancelReasonTx` reads the most recent `cath_lab.case_cancelled` event for the case (`payload->>'reason'`, `LIMIT 1`, `null` when none) from the table `writeCanonicalEvent` actually writes (`clinical_timeline_events` — read the writer's column names off `recordCanonicalClinicalEvent` rather than assuming). The route is revision 1's, unchanged: `router.post('/cases/:id/reopen', requireCathWorkflow, guardCathCaseById, requireIdempotencyKey({ required: true, scope: 'cath_lab_case_reopen' }), …)`, **cath mount only**, the Staff dialog body now also noting the new-attempt consequence (Task 7).

- [ ] **Step 7: Implement — `transitionCaseStatus`** (spec §4.2; owner point 2a)

Inside the transaction, in this order:

```js
    const cathCase = await caseById(tx, tenantId, caseId, { lock: true });
    // Decision 15 (owner point 2a): a cancelled case has ONE door, and it is not
    // this endpoint — for ANY target, readiness_pending included. Refused BEFORE
    // validateCaseTransition, so the table entry cancelled → readiness_pending
    // (kept so the vocabulary is honest) is never reachable from here. The pin
    // asserts this text precedes the table call.
    if (cathCase.status === 'cancelled') {
      throw AppError.conflict('This case was cancelled. Reopen it (POST /cath-lab/cases/:id/reopen) with a reason before changing its status.',
        'CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED', { case_status: 'cancelled', requested_status: input.status, reopen_path: '/api/v1/cath-lab/cases/:id/reopen' });
    }
    const target = validateCaseTransition(cathCase.status, input.status);
    if (target === 'in_progress') {
      const { updated } = await startCaseTx(tx, { tenantId, cathCase, reason: input.reason, via: 'status', commandId: input.command_id, context });
      startedPatientUid = updated.patient_uid;   // closure variable read after commit
      return updated;
    }
    … the generic UPDATE as today MINUS its dead `actual_start_at = CASE … END` branch; SLA handling unchanged …
```

and **after** `setTenantTx` resolves: `if (startedPatientUid) scheduleReadinessRefresh({ tenantId, patientUid: startedPatientUid, source: 'cath_case_start' });` — synchronous, never awaited, never throws. Delete the `assertReadinessComplete` call. If the SLA tests break, the generic UPDATE's parameter numbering shifted — keep `$3`/`$4`.

- [ ] **Step 8: Implement — `recordProcedureLog`, the exhaustive table** (spec §4.2; owner point 3)

```js
  const logStatus = input.status ? normalizeStatus(input.status, ['draft', 'finalized', 'amended'], 'status') : 'finalized';  // BEFORE the case is read
  let startedPatientUid = null;
  const procedure = await setTenantTx(tenantId, async (tx) => {
    const cathCase = await caseById(tx, tenantId, caseId, { lock: true });
    // Decision 13: cancelled → refuse, name the door. BEFORE the insert.
    if (cathCase.status === 'cancelled') {
      throw AppError.conflict('This case was cancelled. Reopen the case (POST /cath-lab/cases/:id/reopen) with a reason before recording the procedure.',
        'CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED', { case_status: 'cancelled', reopen_path: '/api/v1/cath-lab/cases/:id/reopen' });
    }
    const startEligible = START_ELIGIBLE_STATUSES.includes(cathCase.status);
    const underWayOrDone = cathCase.status === 'in_progress' || cathCase.status === 'completed';
    // Decision 16: requested (and anything unexpected) → refuse BEFORE the insert with the next action.
    if (!startEligible && !underWayOrDone) {
      throw AppError.conflict('A procedure cannot be recorded on this case until it is scheduled', 'CATH_LAB_CASE_START_NOT_ELIGIBLE',
        { case_status: cathCase.status, next_action: cathCase.status === 'requested' ? { path: '/api/v1/cath-lab/cases/:id/status', body: { status: 'scheduled' } } : null });
    }
    … INSERT the log exactly as today, with status = logStatus …
    const row = unwrap(rows);
    // Decision 16: a FINALIZED log on a start-eligible case starts it — same function,
    // same block, same snapshot. A draft or an amendment is recorded and starts nothing.
    if (startEligible && START_LOG_STATUSES.includes(logStatus)) {
      const { updated } = await startCaseTx(tx, { tenantId, cathCase, reason: input.start_reason, via: 'procedure_log', commandId: input.command_id, procedureLogId: row.id, context });
      startedPatientUid = updated.patient_uid;
    }
    … the rest as today (log-id refs, complication registry) …
    return row;
  });
  if (startedPatientUid) scheduleReadinessRefresh({ tenantId, patientUid: startedPatientUid, source: 'cath_case_start' });
  return procedure;
```

Delete the inline `assertReadinessComplete` call and the inline `if (cathCase.status !== 'in_progress') { UPDATE … }` force-start. There is no row of the table without an outcome.

- [ ] **Step 9: Implement — `createCase` and the creation route** (spec §4.11; owner point 1)

```js
  // Decision 14. Raised before assertPatient and before the transaction. Its own
  // code so a client can tell "not a status" from "not creatable".
  const requestedStatus = input.status ? normalizeStatus(input.status, CASE_STATUSES, 'status') : 'scheduled';
  if (!CREATABLE_STATUSES.includes(requestedStatus)) {
    throw AppError.badRequest(`A case can only be created as ${CREATABLE_STATUSES.join(', ')}`, 'CATH_LAB_CASE_STATUS_NOT_CREATABLE', { status: requestedStatus, creatable: [...CREATABLE_STATUSES] });
  }
  const status = normalizeStatus(requestedStatus, CREATABLE_STATUSES, 'status');   // the text the INSERT pin reads: normalizeStatus(input.status, CASE_STATUSES … must NOT survive in createCase
  const metadata = Object.fromEntries(Object.entries(normalizeJson(input.metadata, 'metadata', {})).filter(([key]) => !CASE_START_METADATA_KEYS.includes(key)));
```

(Write it so the literal text `normalizeStatus(input.status, CREATABLE_STATUSES` appears in `createCase` and `normalizeStatus(input.status, CASE_STATUSES` does not — e.g. validate membership first with `CASE_STATUSES.includes(cleanText(input.status, 60))`, then `normalizeStatus(input.status, CREATABLE_STATUSES, 'status')`. The pin reads the text.) The INSERT does not name `procedure_attempt` or `attempt_started_at` (defaults apply). In `cathLabRoutes.js`, `router.post('/cases', …)` validates `req.body?.status` against the exported `CREATABLE_STATUSES` before calling the service (400 with the same code — defence in depth; the service check is the one the pin reads).

- [ ] **Step 10: Run the unit suite** — `npm test -- --testPathPatterns unit/cathLabService.test`. Expected: PASS.

- [ ] **Step 11: Write the source pin** — `apps/backend/src/tests/unit/cathLabStartPathPin.test.js`

Keep revision 1's scaffolding (`sourceFiles`, `withoutComments`, `FILES`, `enclosingFunction`, `callers`, `sqlLiterals` scoped to literals naming `cath_lab_cases`, the ICU-ordering note) and its header comment, extended with: the population pin exists because a subset check cannot see a write site that drifts out of a regex. The assertions:

```js
import { CASE_TRANSITIONS, START_ELIGIBLE_STATUSES, CREATABLE_STATUSES } from '../../services/clinical/cathLabService.js';  // the only non-textual imports

// Every function that assigns cath_lab_cases.status AT ALL — bound or literal.
const STATUS_WRITERS = Object.freeze([
  'services/clinical/cathLabReadinessService.js:recomputeCaseStatusTx',
  'services/clinical/cathLabService.js:reopenCaseTx',
  'services/clinical/cathLabService.js:startCaseTx',
  'services/clinical/cathLabService.js:transitionCaseStatus',
  'services/clinical/cathLabService.js:updateReadinessCheck',
]);
// THE WRITE-SITE POPULATION (spec §4.3; owner point 1; dev-1b's post-landing
// check). Exact lists, measured on the tree: nine UPDATE literals and two
// INSERT literals name cath_lab_cases. `toEqual`, never "each hit is
// allow-listed": a site reformatted out of a regex makes a list SHORTER, which
// a subset check would never see. Adding a writer is paid for in a diff here.
const UPDATE_SITES = Object.freeze([
  'services/clinical/cathLabReadinessService.js:recomputeCaseStatusTx',
  'services/clinical/cathLabService.js:reopenCaseTx',
  'services/clinical/cathLabService.js:resolveCathConsumableAuthorityRecovery',
  'services/clinical/cathLabService.js:startCaseTx',
  'services/clinical/cathLabService.js:transitionCaseStatus',
  'services/clinical/cathLabService.js:updateCaseCanonicalRefs',
  'services/clinical/cathLabService.js:updateReadinessCheck',
  'services/clinical/cathSchedulingRegistryService.js:scheduleCase',
  'services/clinical/stemiPathwayService.js:spawnCathCase',
]);
const INSERT_SITES = Object.freeze([
  'services/clinical/cathLabService.js:createCase',
  'services/clinical/stemiPathwayService.js:spawnCathCase',
]);

function classify(body) {
  if (/\bINSERT\s+INTO\s+cath_lab_cases\b/.test(body)) return 'insert';
  if (/\bUPDATE\s+cath_lab_cases\b/.test(body)) return 'update';
  if (/\bDELETE\s+FROM\s+cath_lab_cases\b/.test(body)) return 'delete';
  if (/\bSET\b|\bINSERT\b/.test(body)) return 'unclassified-write';   // names the table, writes something, matches neither shape → fail loudly
  return 'read';
}

describe('the cath case has exactly one start path', () => {
  test('the scan found the service', …);
  test('assertConsentDocumented is called from startCaseTx and nowhere else; the old names are gone', () => {
    expect(callers(service.text, 'assertConsentDocumented')).toEqual(['startCaseTx']);
    expect(FILES.filter((f) => f.text.includes('assertReadinessComplete') || f.text.includes('CATH_LAB_READINESS_BLOCKED')).map((f) => f.path)).toEqual([]);
  });
  test('startCaseTx is called from transitionCaseStatus and recordProcedureLog and nowhere else', …);
  test('only startCaseTx writes in_progress / actual_start_at / attempt_started_at on a cath_lab_cases statement — except reopenCaseTx clearing the attempt', () => {
    … collect lines matching /actual_start_at\s*=/, /attempt_started_at\s*=/, /status\s*=\s*'in_progress'/ and the SET status = CASE … 'in_progress' … END shape …
    expect(sites.map((s) => `${s.at} :: ${s.line}`)).toEqual([
      `${SERVICE}:reopenCaseTx :: attempt_started_at = NULL,`,
      `${SERVICE}:startCaseTx :: actual_start_at = COALESCE(actual_start_at, NOW()),`,
      `${SERVICE}:startCaseTx :: attempt_started_at = NOW(),`,
      `${SERVICE}:startCaseTx :: SET status = 'in_progress',`,
    ]);
  });
  test('the functions that assign cath_lab_cases.status are a literal list', () => { … expect([...writers].sort()).toEqual([...STATUS_WRITERS]); });

  // ---- THE WRITE-SITE POPULATION ----
  test('every literal naming cath_lab_cases is classified, and the UPDATE and INSERT populations are exactly the known lists', () => {
    const updates = [], inserts = [], unclassified = [], upserts = [];
    for (const file of FILES) for (const literal of sqlLiterals(file)) {
      const at = `${file.path}:${enclosingFunction(file.text, literal.index)}`;
      const kind = classify(literal.body);
      if (kind === 'update') updates.push(at); else if (kind === 'insert') inserts.push(at); else if (kind !== 'read') unclassified.push({ at, kind });
      if (/\bON\s+CONFLICT\b/.test(literal.body)) upserts.push(at);
    }
    expect(unclassified).toEqual([]);
    expect(upserts).toEqual([]);                       // no upsert on the case table; one would have to be argued for
    expect(updates.sort()).toEqual([...UPDATE_SITES]);  // nine — the COUNT is the assertion
    expect(inserts.sort()).toEqual([...INSERT_SITES]);  // two
  });
  test('ordinary creation normalises against CREATABLE_STATUSES, and STEMI creates readiness_pending (decision 14)', () => {
    const createCaseSrc = functionSource(service.text, 'createCase');
    expect(createCaseSrc).toMatch(/normalizeStatus\(input\.status, CREATABLE_STATUSES/);
    expect(createCaseSrc).not.toMatch(/normalizeStatus\(input\.status, CASE_STATUSES/);
    expect(CREATABLE_STATUSES).toEqual(['requested', 'scheduled', 'readiness_pending']);
    const stemi = FILES.find((f) => f.path === 'services/clinical/stemiPathwayService.js');
    const insert = sqlLiterals(stemi).find((l) => classify(l.body) === 'insert');
    expect(insert.body).toMatch(/'readiness_pending'/);
    expect(CREATABLE_STATUSES.includes('readiness_pending')).toBe(true);
  });

  // ---- THE DOOR ----
  test('cancelled has exactly one outbound transition, and it is a pre-start status', () => {
    expect(CASE_TRANSITIONS.cancelled).toEqual(['readiness_pending']);
    expect(START_ELIGIBLE_STATUSES).not.toContain('cancelled');
  });
  test('only reopenCaseTx writes readiness_pending as a literal on a cath_lab_cases statement', …);
  test('transitionCaseStatus refuses a cancelled case BEFORE consulting the table (decision 15)', () => {
    const src = functionSource(service.text, 'transitionCaseStatus');
    expect(src.indexOf("=== 'cancelled'")).toBeGreaterThan(-1);
    expect(src.indexOf("=== 'cancelled'")).toBeLessThan(src.indexOf('validateCaseTransition('));
  });
});
```

`functionSource(text, name)` returns the text from `function <name>(` to the next top-level `function` declaration — good enough for these three textual assertions. **Measure before you trust**: run the pin on the base commit first; it reports the pre-lane population (eight UPDATE sites including `recordProcedureLog`, the start shapes in `recordProcedureLog` and `transitionCaseStatus`, `STATUS_WRITERS` with `recordProcedureLog` in place of `startCaseTx` / `reopenCaseTx`, `CASE_TRANSITIONS.cancelled` = `[]`). If `enclosingFunction` names an inner helper for the recovery UPDATE, the measured name goes in the list — the list is a snapshot, not a guess.

- [ ] **Step 12: Run the pin** — `npm test -- --testPathPatterns unit/cathLabStartPathPin`. Expected: PASS. A tenth UPDATE site or a third INSERT site is a write path this plan did not know about: stop, read it, and either route it or report it.

- [ ] **Step 13: Early mutation checks** (apply, run, confirm red, revert)

1. Move the `assertConsentDocumented` call into `transitionCaseStatus` → the pin's caller test red and `'the finalized log is refused by the consent block too'` red.
2. Make `reopenCaseTx` write `status = 'in_progress', actual_start_at = COALESCE(…), attempt_started_at = NOW()` → the SQL-shape test red (its exact line list changes) **and** the `readiness_pending` literal test red.
3. Splice the table name into `startCaseTx`'s UPDATE (`` `UPDATE ${CASES} SET …` ``) → the population test red (eight UPDATE sites, not nine) **and** the SQL-shape test red (three lines, not four). This is mutation 31; it proves the exact-list assertion catches what a subset check cannot.
4. Restore `normalizeStatus(input.status, CASE_STATUSES` in `createCase` → the creation unit test red and the INSERT pin red.
5. Delete the `=== 'cancelled'` short-circuit in `transitionCaseStatus` → the cancelled-case unit test red (`scheduled` answers `INVALID_STATE_TRANSITION`, `readiness_pending` reaches the table) and the order pin red.
6. Replace `if (cathCase.status !== 'cancelled') throw …` in `reopenCaseTx` with the table check alone → the `scheduled` iteration of the reopen loop red.

- [ ] **Step 14: Commit**

```bash
git add apps/backend/src/services/clinical/cathLabService.js apps/backend/src/routes/clinical/cathLabRoutes.js apps/backend/src/tests/unit/cathLabService.test.js apps/backend/src/tests/unit/cathLabStartPathPin.test.js
git commit -m "feat(cath): creation restricted to booking states, one attempt-aware start path with command binding and a non-blocking lab picture, consent authority + time-out instants, cancelled-only reopen with attempt N+1, exhaustive procedure-log outcomes, write-site population pin

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
## Task 4: The checklist keeps living after start — cause persisted, every "started" read on the active attempt, late actions, the deep suite (TDD, unit then deep)

**Files:**
- Modify: `apps/backend/src/services/clinical/cathLabReadinessService.js` (`caseRowTx`, `STORED_ITEM_SELECT`, the item upsert, `refreshCaseLabReadiness`, `refreshOpenCasesForPatient`)
- Modify: `apps/backend/src/services/clinical/cathLabReadinessActions.js` (`orderPriorityForUrgency`, `isAfterCaseStart`, `orderMissingLabs`, `recordExternalLabResult`)
- Modify: `apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs` (decision 9 KEPT edits only — the rest in Task 5)
- Test: `apps/backend/src/tests/unit/cathLabReadinessServiceOrders.test.js`, `apps/backend/src/tests/unit/cathLabReadinessService.test.js`, `apps/backend/src/tests/cath-lab-readiness.deep.test.js`

- [ ] **Step 1: Write the failing unit tests for the late actions and the attempt discriminator**

In `cathLabReadinessService.test.js`, `describe('orderPriorityForUrgency')`: a started case orders `STAT` whatever its booked urgency (`orderPriorityForUrgency(urgency, { started: true })` for every urgency and `undefined`); `orderPriorityForUrgency('elective')` stays `NORMAL`. New: `isAfterCaseStart({ actual_start_at: '2026-09-06T03:10:00Z', attempt_started_at: null })` is **false** (attempt 2 not started — history is not "started") and `isAfterCaseStart({ attempt_started_at: '…' })` is true.

In `cathLabReadinessServiceOrders.test.js`: invert the started-case refusal — with `case_started: true` in the refresh stub, `createInvestigationOrder` is called with `priority: 'STAT'` and `recordReadinessAudit` with `metadata: expect.objectContaining({ ordered_after_start: true })`; invert the outside-result refusal (if the suite has one): the row is written and the audit metadata carries `recorded_after_start: true`.

- [ ] **Step 2: Run to verify they fail** — `npm test -- --testPathPatterns "unit/cathLabReadinessService"`.

- [ ] **Step 3: Implement the late actions** (spec §5.3)

```js
export function orderPriorityForUrgency(urgency, { started = false } = {}) {
  // A draw for a patient already on the table is urgent by definition (spec §5.3).
  if (started) return 'STAT';
  return CATH_URGENCY_ORDER_PRIORITY[String(urgency ?? '').trim().toLowerCase()] || 'NORMAL';
}
// "After start" is the ACTIVE attempt's start (decision 17): a reopened case
// whose attempt 2 has not started is pre-start again, whatever actual_start_at says.
function isAfterCaseStart(cathCase, at = Date.now()) {
  const startedMs = toMs(cathCase?.attempt_started_at_epoch_ms ?? cathCase?.attempt_started_at);
  return Number.isFinite(startedMs) && at > startedMs;
}
```

`orderMissingLabs`: delete the `if (before.case_started) throw …` block; `priority = orderPriorityForUrgency(urgency, { started: before.case_started })`; the note gains `' — ordered after procedure start'` when started; audit metadata `{ created, skipped, ordered_after_start: before.case_started }`. `recordExternalLabResult`: delete the `if (cathCase.actual_start_at) throw …` block; `recorded_after_start: isAfterCaseStart(cathCase)` on the `CATH_LAB_EXTERNAL_RESULT_RECORDED` audit metadata. Every `caseById`-style read these functions make must now select `attempt_started_at` (and the twin where one exists). Delete the parenthetical in `isAfterCaseStart`'s comment that says the two operations still refuse.

- [ ] **Step 4: Implement the refresh** (spec §4.9 reads, §5.1, §5.6)

`caseRowTx` SELECT:

```sql
SELECT id, tenant_id, patient_uid, encounter_id, facility_id, status, urgency,
       actual_start_at, attempt_started_at, procedure_attempt,
       (EXTRACT(EPOCH FROM attempt_started_at) * 1000)::bigint AS attempt_started_at_epoch_ms,
       metadata->'readiness_at_start' AS readiness_at_start
  FROM cath_lab_cases …
```

(never `readiness_at_start_history`, never bare `metadata` — Task 5 adds the unit test that reads this SQL text.) `STORED_ITEM_SELECT` gains `unavailability_cause, window_days`; the item upsert's column list, `VALUES` and `DO UPDATE SET` gain both; `storedItemMatches` compares both. In the per-item loop of `refreshCaseLabReadiness`, after `resolveItemState(...)`:

```js
      values.unavailability_cause = classifyUnavailability({ previous: stored, resolved: values, results: resultsForItem, settings, windowDays, asOf });
      values.window_days = windowDays;
```

where `resultsForItem` is the candidate rows the resolver was given for this item and `windowDays` the window it was given (both already in scope). `caseStartedAt: cathCase.attempt_started_at_epoch_ms ?? cathCase.attempt_started_at`. `computeCheckDecision` receives the items **with** the cause (it reads `item.unavailability_cause`). The `auto_pass` audit metadata gains `passed_after_start: decision.nextStatus === 'pass' && Boolean(cathCase.attempt_started_at)`. The return gains / changes:

```js
      case_started: Boolean(cathCase.attempt_started_at),
      procedure_attempt: Number(cathCase.procedure_attempt ?? 1),
      attempt_started_at: cathCase.attempt_started_at ?? null,
      first_started_at: cathCase.actual_start_at ?? null,
      started_with_readiness_pending: startedWithReadinessPending(cathCase.readiness_at_start),   // true | false | null
      readiness_at_start: normalizeStartSnapshot(cathCase.readiness_at_start),
```

`missing[]` on the block is `decision.missing` (now `{ item, state, cause }`); each item on the wire carries `unavailability_cause`. `refreshOpenCasesForPatient`: `WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND status NOT IN ('completed', 'cancelled')` — the three-status list and `actual_start_at IS NULL` go (spec §5.1).

- [ ] **Step 5: Run the unit suites** — `npm test -- --testPathPatterns "unit/cathLabReadinessService|unit/cathLabReadinessServiceOrders"`. PASS.

- [ ] **Step 6: Decision 9 — KEPT** (Task 0 Step 2 confirmed it)

In `cathLabReadiness.mjs`: remove the 409 `errorResponse` from the order-missing and external-result operations and the sentence "Refused once the procedure has started." from both; rewrite `case_started`: "True once the ACTIVE attempt has started (`attempt_started_at`; a reopened case is pre-start again until its next attempt starts). Nothing on this surface is refused after it except lifting a waiver (#1018, record-yes / lift-no): ordering, outside results and waivers stay open and are marked as after start." `CATH_LAB_READINESS_CASE_STARTED` stays in `ERROR_CODES` (one thrower, `unwaiveLabItem`). `cathLabRouteGuards.test.js`'s deterministic-409 probe is untouched. Run `npm test -- --testPathPatterns "unit/cathLabReadinessOpenApiSource|unit/cathLabRouteGuards"` — green.

- [ ] **Step 7: Deep helpers** (append to `cath-lab-readiness.deep.test.js`; every new test seeds its own case so #1018's fixture on `CASE_ID` is untouched)

```js
import { randomUUID } from 'node:crypto';
const CMD = () => randomUUID();
async function seedCase({ status = 'scheduled', consent = 'pass', labs = 'pending', others = 'pass', urgency = 'routine', patientUid = PATIENT, consentMeta = { consent: { authority: 'patient', mode: 'written' } } } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO cath_lab_cases (tenant_id, patient_uid, facility_id, requested_procedure, urgency, status, created_by, updated_by)
     VALUES ($1::uuid, $2::uuid, $4::int, 'Never-restricts PTCA', $5, $6, $3::uuid, $3::uuid) RETURNING id`,
    TENANT, patientUid, ACTOR, FACILITY_ID, urgency, status);
  const id = Number(rows[0].id);
  for (const type of READINESS_TYPES) {
    const st = type === 'consent' ? consent : type === 'labs' ? labs : others;
    const meta = type === 'consent' && st === 'pass' ? consentMeta : {};
    await prisma.$executeRawUnsafe(
      `INSERT INTO cath_lab_readiness_checks (tenant_id, case_id, check_type, status, required, completed_at, metadata)
       VALUES ($1::uuid, $2::bigint, $3, $4, TRUE, CASE WHEN $4 = 'pending' THEN NULL ELSE NOW() END, $5::jsonb)`,
      TENANT, id, type, st, JSON.stringify(meta));
  }
  return id;
}
const caseRow = (id) => prisma.$queryRawUnsafe(
  `SELECT status, actual_start_at, attempt_started_at, procedure_attempt, actual_end_at,
          metadata->'readiness_at_start' AS snapshot, metadata->'readiness_at_start_history' AS history, metadata->'start_commands' AS commands
     FROM cath_lab_cases WHERE tenant_id = $1::uuid AND id = $2::bigint`, TENANT, id).then((rows) => rows[0]);
const startAudits = (id) => prisma.$queryRawUnsafe(
  `SELECT id, metadata, actor_uid, role FROM audit_logs WHERE tenant_id = $1::uuid AND action = 'cath_lab.case.started_with_readiness_pending' AND resource_id = $2::text ORDER BY id`, TENANT, String(id));
const auditRows = (id, action) => prisma.$queryRawUnsafe(`SELECT metadata FROM audit_logs WHERE tenant_id = $1::uuid AND action = $3 AND resource_id = $2::text ORDER BY id`, TENANT, String(id), action);
const setCheck = (id, checkType, status, metadata = {}) => updateReadinessCheck(id, { tenantId: TENANT, check_type: checkType, status, metadata }, ctx());
const checkRow = (id, checkType) => prisma.$queryRawUnsafe(`SELECT status, completed_at, metadata FROM cath_lab_readiness_checks WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND check_type = $3`, TENANT, id, checkType).then((rows) => rows[0]);
// Lifted from the regime test's local `age(days)`, parameterised by patient.
const ageHgb = (days, patientUid = PATIENT) => prisma.$executeRawUnsafe(
  `UPDATE lab_results SET performed_at = NOW() - ($3::int * INTERVAL '1 day'), received_at = NOW() - ($3::int * INTERVAL '1 day')
    WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_code = 'HGB'`, TENANT, patientUid, days);
const start = (id, extra = {}) => transitionCaseStatus(id, { tenantId: TENANT, status: 'in_progress', command_id: CMD(), ...extra }, ctx());
```

Add `pollForItemOnCase(id, code, predicate)` and `labsCheckFor(id)` as case-parameterised twins of the existing helpers. Import `transitionCaseStatus`, `recordProcedureLog`, `reopenCase`, `createCase`, `updateReadinessCheck` from `cathLabService.js`; import `app` (or the cath router harness the route-guard suite uses) and `supertest` for the two route-level tests.

- [ ] **Step 8: The deep tests** — write them all; the ones the owner named are given in full

```js
  test('consent: pending / waived / not_applicable refuse both paths; emergency_basis starts; a legacy pass starts with consent_authority null', async () => {
    for (const consent of ['pending', 'waived', 'not_applicable']) {
      const id = await seedCase({ status: 'readiness_pending', consent });
      await expect(start(id, { reason: 'r' })).rejects.toMatchObject({ code: 'CATH_LAB_CONSENT_REQUIRED', details: { consent_status: consent } });
      await expect(recordProcedureLog(id, { tenantId: TENANT, procedure_type: 'PTCA' }, ctx())).rejects.toMatchObject({ code: 'CATH_LAB_CONSENT_REQUIRED' });
      const row = await caseRow(id);
      expect(row).toMatchObject({ status: 'readiness_pending', actual_start_at: null, attempt_started_at: null, snapshot: null });
      expect((await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM cath_procedure_logs WHERE tenant_id = $1::uuid AND case_id = $2::bigint`, TENANT, id))[0].n).toBe(0);
    }
    const emergency = await seedCase({ status: 'readiness_pending', labs: 'pending', urgency: 'emergency', consentMeta: { consent: { authority: 'emergency_basis', mode: 'verbal' } } });
    await start(emergency, { reason: 'No representative present; primary PCI' });
    expect((await caseRow(emergency)).snapshot.consent_authority).toBe('emergency_basis');
    expect((await startAudits(emergency))[0].metadata.consent_authority).toBe('emergency_basis');
    const legacy = await seedCase({ status: 'ready', labs: 'pass', consentMeta: {} });
    await start(legacy);
    expect((await caseRow(legacy)).snapshot.consent_authority).toBeNull();
  }, 90000);

  test('consent write: authority required; authority outside the tenant policy refused; a permitted one is stored with a server documented_at', async () => {
    const id = await seedCase({ status: 'scheduled', consent: 'pending' });
    await expect(setCheck(id, 'consent', 'pass')).rejects.toMatchObject({ code: 'CATH_LAB_CONSENT_AUTHORITY_REQUIRED' });
    await prisma.$executeRawUnsafe(`UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || '{"cath_lab":{"consent_authorities":["patient"]}}'::jsonb WHERE id = $1::uuid`, TENANT);
    try {
      await expect(setCheck(id, 'consent', 'pass', { consent: { authority: 'emergency_basis', mode: 'verbal' } })).rejects.toMatchObject({ code: 'CATH_LAB_CONSENT_AUTHORITY_NOT_PERMITTED', details: { permitted: ['patient'] } });
      await setCheck(id, 'consent', 'pass', { consent: { authority: 'patient', mode: 'telephone', documented_at: '2000-01-01T00:00:00Z' } });
      const row = await checkRow(id, 'consent');
      expect(row.metadata.consent).toMatchObject({ authority: 'patient', mode: 'telephone' });
      expect(new Date(row.metadata.consent.documented_at).getFullYear()).toBeGreaterThan(2000);   // server-stamped, client value dropped
    } finally {
      await prisma.$executeRawUnsafe(`UPDATE tenants SET settings = settings - 'cath_lab' WHERE id = $1::uuid`, TENANT);
    }
  }, 60000);

  test('time-out write: performed_at required and past; completed_at is NOW() whatever the client sent; timing derives on the block', async () => {
    const id = await seedCase({ status: 'ready', labs: 'pass', others: 'pass' });
    await prisma.$executeRawUnsafe(`UPDATE cath_lab_readiness_checks SET status='pending', completed_at=NULL WHERE tenant_id=$1::uuid AND case_id=$2::bigint AND check_type='timeout'`, TENANT, id);
    await expect(setCheck(id, 'timeout', 'pass')).rejects.toMatchObject({ code: 'CATH_LAB_TIMEOUT_PERFORMED_AT_REQUIRED' });
    await expect(setCheck(id, 'timeout', 'pass', { timeout: { performed_at: new Date(Date.now() + 3_600_000).toISOString() } })).rejects.toMatchObject({ code: 'CATH_LAB_TIMEOUT_PERFORMED_AT_REQUIRED' });
    await start(id, { reason: 'time-out at the table' });                       // starts with timeout pending
    const performedAt = new Date(Date.now() - 120_000).toISOString();            // performed 2 min ago = BEFORE start? No — start was just now; make it after:
    await setCheck(id, 'timeout', 'pass', { timeout: { performed_at: new Date().toISOString() } });
    const row = await checkRow(id, 'timeout');
    expect(row.metadata.timeout.documented_at).toBe(new Date(row.completed_at).toISOString());
    const block = await getCase(id, { tenantId: TENANT }, ctx());                // whichever read surfaces the check's derived timing
    const timeout = block.readiness.find((c) => c.check_type === 'timeout');
    expect(['performed_after_start', 'performed_before_start']).toContain(timeout.timing);
    expect(timeout.documented_after_start).toBe(true);
  }, 60000);

  test('creation cannot manufacture a running case (route-level), and the database refuses one too (23514)', async () => {
    const countBefore = (await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM cath_lab_cases WHERE tenant_id = $1::uuid`, TENANT))[0].n;
    for (const status of ['in_progress', 'completed', 'cancelled', 'ready']) {
      const res = await request(app).post('/api/v1/cath-lab/cases').set(authFor('CATH_LAB_STAFF')).send({ patient_uid: PATIENT, facility_id: FACILITY_ID, requested_procedure: 'PTCA', status });
      expect(res.status).toBe(400);
      expect(res.body.code ?? res.body.error?.code).toBe('CATH_LAB_CASE_STATUS_NOT_CREATABLE');
    }
    expect((await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM cath_lab_cases WHERE tenant_id = $1::uuid`, TENANT))[0].n).toBe(countBefore);
    const ok = await request(app).post('/api/v1/cath-lab/cases').set(authFor('CATH_LAB_STAFF')).send({ patient_uid: PATIENT, facility_id: FACILITY_ID, requested_procedure: 'PTCA', status: 'readiness_pending' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.case ?? ok.body.data).toMatchObject({ status: 'readiness_pending', procedure_attempt: 1, attempt_started_at: null });
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO cath_lab_cases (tenant_id, patient_uid, facility_id, requested_procedure, status, created_by, updated_by)
       VALUES ($1::uuid, $2::uuid, $3::int, 'raw', 'in_progress', $4::uuid, $4::uuid)`, TENANT, PATIENT, FACILITY_ID, ACTOR))
      .rejects.toMatchObject({ code: expect.stringMatching(/23514|P2010/), message: expect.stringContaining('cath_lab_cases_in_progress_attempt_check') });
  }, 60000);

  test('the generic status endpoint cannot reopen a cancelled case — every target answers the door (owner point 2a)', async () => {
    const id = await seedCase({ status: 'scheduled' });
    await transitionCaseStatus(id, { tenantId: TENANT, status: 'cancelled', reason: 'List overran' }, ctx());
    for (const status of ['readiness_pending', 'scheduled', 'in_progress']) {
      await expect(transitionCaseStatus(id, { tenantId: TENANT, status, reason: 'sneak', command_id: CMD() }, ctx()))
        .rejects.toMatchObject({ code: 'CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED', statusCode: 409, details: { requested_status: status } });
    }
    expect((await caseRow(id)).status).toBe('cancelled');
    expect(await auditRows(id, 'cath_lab.case.reopened')).toHaveLength(0);
  }, 60000);

  test('/reopen acts on a cancelled case only — scheduled and every other status refused with the real allowed list (owner point 2b)', async () => {
    const scheduled = await seedCase({ status: 'scheduled' });
    await expect(reopenCase(scheduled, { tenantId: TENANT, reason: 'x' }, ctx()))
      .rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: { from: 'scheduled', to: 'readiness_pending', allowed: ['readiness_pending', 'ready', 'in_progress', 'cancelled'] } });
    expect((await caseRow(scheduled)).status).toBe('scheduled');
    for (const status of ['requested', 'readiness_pending', 'ready']) {
      const id = await seedCase({ status });
      await expect(reopenCase(id, { tenantId: TENANT, reason: 'x' }, ctx())).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    }
    const running = await seedCase({ status: 'ready', labs: 'pass' }); await start(running);
    await expect(reopenCase(running, { tenantId: TENANT, reason: 'x' }, ctx())).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: { from: 'in_progress' } });
    await transitionCaseStatus(running, { tenantId: TENANT, status: 'completed' }, ctx());
    await expect(reopenCase(running, { tenantId: TENANT, reason: 'x' }, ctx())).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: { from: 'completed', allowed: [] } });
  }, 60000);

  test('procedure log: cancelled → 409 naming the door; requested → 409 naming the scheduled transition; nothing inserted; a draft on a scheduled case starts nothing', async () => {
    … cancelled arc as revision 1 …
    const requested = await seedCase({ status: 'requested' });
    await expect(recordProcedureLog(requested, { tenantId: TENANT, procedure_type: 'PTCA' }, ctx()))
      .rejects.toMatchObject({ code: 'CATH_LAB_CASE_START_NOT_ELIGIBLE', details: { next_action: { body: { status: 'scheduled' } } } });
    const drafted = await seedCase({ status: 'scheduled', labs: 'pending' });
    await recordProcedureLog(drafted, { tenantId: TENANT, procedure_type: 'PTCA', status: 'draft' }, ctx());
    expect(await caseRow(drafted)).toMatchObject({ status: 'scheduled', attempt_started_at: null, snapshot: null });
    await recordProcedureLog(drafted, { tenantId: TENANT, procedure_type: 'PTCA', status: 'finalized', command_id: CMD() }, ctx());
    expect((await caseRow(drafted)).status).toBe('in_progress');
  }, 60000);

  test('reopen of a case cancelled BEFORE it started: same attempt, consent kept, then the ordinary start', async () => {
    const id = await seedCase({ status: 'scheduled', labs: 'pending' });
    await transitionCaseStatus(id, { tenantId: TENANT, status: 'cancelled', reason: 'Deferred' }, ctx());
    await reopenCase(id, { tenantId: TENANT, reason: 'Back on the list' }, ctx());
    expect(await caseRow(id)).toMatchObject({ status: 'readiness_pending', procedure_attempt: 1, attempt_started_at: null, actual_start_at: null, actual_end_at: null });
    expect((await checkRow(id, 'consent')).status).toBe('pass');   // not reset: no attempt had started
    expect((await auditRows(id, 'cath_lab.case.reopened'))[0].metadata).toMatchObject({ previous_attempt: 1, procedure_attempt: 1, checks_reset: [] });
    await start(id, { reason: 'go' });
    expect((await caseRow(id)).snapshot.procedure_attempt).toBe(1);
  }, 60000);

  test('THE OWNER\'S TEST (point 4): start → cancel → evidence ages out → reopen → attempt 2 with its own start, snapshot, audit row; actual_start_at preserved', async () => {
    const patient = randomUUID(); await seedPatient(patient);                 // isolate the lab rows from PATIENT's
    for (const code of ITEM_CODES) await seedResult({ patientUid: patient, code: TEST_CODE_FOR[code], daysAgo: 1 });
    const id = await seedCase({ status: 'scheduled', labs: 'pending', patientUid: patient });
    expect((await refreshCaseLabReadiness({ tenantId: TENANT, caseId: id, context: ctx() })).check_status).toBe('pass');   // auto-passed, all seven fresh
    await start(id);
    const firstStart = (await caseRow(id)).attempt_started_at;
    expect(new Date((await caseRow(id)).actual_start_at).getTime()).toBe(new Date(firstStart).getTime());
    await transitionCaseStatus(id, { tenantId: TENANT, status: 'cancelled', reason: 'Abandoned — access failed' }, ctx());
    await ageHgb(45, patient);
    await reopenCase(id, { tenantId: TENANT, reason: 'Second attempt via radial' }, ctx());
    const reopened = await caseRow(id);
    expect(reopened).toMatchObject({ status: 'readiness_pending', procedure_attempt: 2, attempt_started_at: null, snapshot: null });
    expect(new Date(reopened.actual_start_at).getTime()).toBe(new Date(firstStart).getTime());     // history kept
    expect(reopened.history).toHaveLength(1); expect(reopened.history[0].procedure_attempt).toBe(1);
    expect((await checkRow(id, 'consent')).status).toBe('pending');                               // reset on a NEW attempt
    expect((await checkRow(id, 'consent')).metadata.previous_attempts[0]).toMatchObject({ procedure_attempt: 1, status: 'pass' });
    expect((await checkRow(id, 'timeout')).status).toBe('pending');
    // PRE-start regime again: the aged value RETRACTS the labs check (Plan 3's rule) — exactly right for a patient going back on the table
    const block = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: id, context: ctx() });
    expect(block).toMatchObject({ check_status: 'pending', case_started: false, procedure_attempt: 2, started_with_readiness_pending: null });
    expect(block.items.find((i) => i.item_code === 'hb')).toMatchObject({ state: 'stale', unavailability_cause: 'aged_out' });
    await expect(start(id, { reason: 'go' })).rejects.toMatchObject({ code: 'CATH_LAB_CONSENT_REQUIRED' });                 // the hard block again
    await setCheck(id, 'consent', 'pass', { consent: { authority: 'patient', mode: 'verbal' } });
    await start(id, { reason: 'Radial attempt; repeat Hb sent' });
    const second = await caseRow(id);
    expect(second.status).toBe('in_progress');
    expect(new Date(second.attempt_started_at).getTime()).toBeGreaterThan(new Date(firstStart).getTime());
    expect(new Date(second.actual_start_at).getTime()).toBe(new Date(firstStart).getTime());
    expect(second.snapshot).toMatchObject({ procedure_attempt: 2, missing_lab_items: ['hb'] });
    expect(second.snapshot.blocking.map((b) => b.check_type)).toContain('labs');
    const audits = await startAudits(id);
    expect(audits).toHaveLength(1);                     // attempt 1 started CLEAN (no audit row); attempt 2 started with pending → one row
    expect(audits[0].metadata.procedure_attempt).toBe(2);
    // POST-start (attempt 2): ageing alone holds; a repeat draw ordered now is STAT
    const ordered = await orderMissingLabs(id, { tenantId: TENANT }, ctx());
    expect(ordered.readiness.items.find((i) => i.item_code === 'hb')).toMatchObject({ ordered_after_start: true, unavailability_cause: 'aged_out' });
  }, 120000);

  test('THE OWNER\'S TEST (point 7): a stale start command cannot start the next attempt', async () => {
    const id = await seedCase({ status: 'ready', labs: 'pass' });
    const commandA = CMD();
    await transitionCaseStatus(id, { tenantId: TENANT, status: 'in_progress', command_id: commandA }, ctx());
    const replaySame = await transitionCaseStatus(id, { tenantId: TENANT, status: 'in_progress', command_id: commandA }, ctx());   // response lost → retry
    expect(replaySame.status).toBe('in_progress');
    expect(await startAudits(id)).toHaveLength(0);
    await transitionCaseStatus(id, { tenantId: TENANT, status: 'cancelled', reason: 'Abandoned' }, ctx());
    await reopenCase(id, { tenantId: TENANT, reason: 'Again' }, ctx());
    await setCheck(id, 'consent', 'pass', { consent: { authority: 'patient', mode: 'written' } });
    await expect(transitionCaseStatus(id, { tenantId: TENANT, status: 'in_progress', command_id: commandA, reason: 'old reason' }, ctx()))
      .rejects.toMatchObject({ code: 'CATH_LAB_START_COMMAND_STALE', details: { command_attempt: 1, current_attempt: 2 } });
    expect((await caseRow(id)).status).toBe('readiness_pending');
    const commandB = CMD();
    await setCheck(id, 'timeout', 'pass', { timeout: { performed_at: new Date().toISOString() } });
    await transitionCaseStatus(id, { tenantId: TENANT, status: 'in_progress', command_id: commandB }, ctx());
    await transitionCaseStatus(id, { tenantId: TENANT, status: 'in_progress', command_id: commandB }, ctx());   // replay B → 200, nothing new
    expect((await caseRow(id)).commands).toHaveLength(2);
    await expect(transitionCaseStatus(id, { tenantId: TENANT, status: 'in_progress' }, ctx())).rejects.toMatchObject({ code: expect.stringMatching(/CATH_LAB_START_COMMAND_REQUIRED|INVALID_STATE_TRANSITION/) });
  }, 90000);

  test('REGIME PAIR + CAUSES: pre-start age flips; post-start age holds (also with a repeat order open); a policy change, a withdrawn row, retract; two refreshes are stable', async () => {
    … seed seven fresh for an isolated patient; auto-pass; ageHgb(45) → pending (pre-start); ageHgb(1) → pass; start; ageHgb(45) → pass held, item stale / aged_out; refresh again → still pass (stability, mutation 30);
      orderMissingLabs → item ordered_awaiting_sample, cause aged_out, check still pass (the owner's opposite failure);
      UPDATE cath_lab_readiness_settings SET lab_validity_days = 7 for the tenant (restore in finally) with an 8-day-old value → refresh → cause policy_changed, check pending;
      restore; fresh value; cancel the deciding lab_results row (status='cancelled') → cause withdrawn, check pending …
  }, 120000);

  test('after start: order-missing is STAT and ordered_after_start; an outside result is received_after_start; a real sign-off is finalised_after_start and passes the check late; the case stays in_progress', async () => {
    … as revision 1's late-action test plus the sign-off path: pollForItemOnCase(id, 'hb', row => row?.state === 'result_final'); the item reads { received_after_start: true, finalised_after_start: true }; the auto_pass audit row carries passed_after_start: true; caseRow(id).status === 'in_progress' …
  }, 90000);

  test('after start: a critical result mid-procedure is reported, does not move the status', async () => { … as revision 1 … }, 60000);
  test('a log on a completed case leaves it completed', async () => { … as revision 1 … }, 60000);
  test('a replayed reopen under the same Idempotency-Key writes one audit row; a new key on the reopened case is refused by the precondition', async () => { … through the route with supertest; second decision → INVALID_STATE_TRANSITION (readiness_pending) … }, 60000);
```

`seedPatient` / `TEST_CODE_FOR` — reuse whatever the suite already has for seeding a second patient and mapping item codes to test codes (the `seed()` helper shows both); do not invent a second convention.

- [ ] **Step 9: Run the deep suite on the scratch DB** — `DATABASE_URL=… npm test -- --testPathPatterns cath-lab-readiness.deep`. PASS, `Suites failed: 0` read separately from `Tests passed`.

- [ ] **Step 10: Early mutation checks**

1. `computeCheckDecision`: delete `started &&` → the pre-start unit test and the REGIME PAIR's pre-start assertion red; the post-start test green.
2. `computeCheckDecision`: `cause === 'aged_out'` → `state === 'stale'` → the policy-change and future-dated unit tests red; the repeat-order-open (unit and deep) red the other way.
3. Restore `AND actual_start_at IS NULL` in `refreshOpenCasesForPatient` → the sign-off-after-start deep test red.
4. Compare `isAfterCaseStart` / `caseStartedAt` / `case_started` against `actual_start_at` → the owner's point-4 deep test red (labs check held pre-attempt-2, `case_started: true` while `readiness_pending`).
5. Do not increment `procedure_attempt` in `reopenCaseTx` → the same test red (`snapshot.procedure_attempt` 1; history length; audit row attempt 1).
6. Skip the consent/time-out reset → the `CATH_LAB_CONSENT_REQUIRED` assertion after reopen red.
7. Drop the attempt from the command binding (compare command id only) → the point-7 deep test red (attempt 2 started by command A).
8. Persist no `unavailability_cause` (compute but do not write) → the two-refresh stability assertion red.

- [ ] **Step 11: Commit**

```bash
git add apps/backend/src/services/clinical/cathLabReadinessService.js apps/backend/src/services/clinical/cathLabReadinessActions.js apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs apps/backend/src/tests/unit/cathLabReadinessService.test.js apps/backend/src/tests/unit/cathLabReadinessServiceOrders.test.js apps/backend/src/tests/cath-lab-readiness.deep.test.js
git commit -m "feat(cath): the checklist keeps living after start — cause persisted per item, every started-read on the active attempt, late orders STAT, outside results and sign-offs marked, refresh reaches started cases; deep suite for creation, reopen, attempts, replay and age-only staleness

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
## Task 5: The readiness picture — day list (tri-state), projection, OpenAPI (+ lifecycle error codes), canary (+ CSV, three sentinels)

**Files:**
- Modify: `apps/backend/src/services/clinical/cathLabService.js` (`listCases`)
- Modify: `apps/backend/src/services/clinical/cathLabReadinessProjection.js`
- Modify: `apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs`
- Test: `apps/backend/src/tests/unit/cathLabReadinessProjection.test.js`, `apps/backend/src/tests/unit/cathLabReadinessOpenApiSource.test.js`, `apps/backend/src/tests/unit/serologyDisclosureCanary.test.js`, `apps/backend/src/tests/unit/cathLabReadinessService.test.js` (the "never selects history" text test), `apps/backend/src/tests/cath-lab-readiness.deep.test.js` (day-list key set)

- [ ] **Step 1: Projection tests** — as revision 1 (`readiness_at_start.reason` → `null` for a non-entitled role, every other key intact; entitled role reads the object unchanged; a `null` snapshot passes through; `projectStartReasonForRole` exported), plus: a block with `started_with_readiness_pending: null` keeps `null` after projection (the tri-state is not a free-text field and is never touched), and `readiness_at_start.consent_authority` / `lab_component_status` / `missing_lab_items: null` survive projection unchanged.

- [ ] **Step 2: Implement the projection** — as revision 1 (`hasSnapshot` joins the guard; `projected.readiness_at_start = { ...snapshot, reason: null }`). Header comment: the snapshot's codes, causes, enums and booleans are checklist provenance; the reason is typed at the table and may name a value.

- [ ] **Step 3: Day list — two columns and the TRI-state fold** (spec §6.2)

`listCases` SELECT gains `c.procedure_attempt, c.attempt_started_at,` and, beside `c.updated_at,`:

```sql
            CASE WHEN jsonb_typeof(c.metadata->'readiness_at_start'->'blocking') = 'array'
                 THEN jsonb_array_length(c.metadata->'readiness_at_start'->'blocking') > 0
                 ELSE NULL END AS started_with_readiness_pending,
```

`ELSE NULL`, not `ELSE FALSE`: `NULL` is "not documented", never "no pending checks" (mutation 8 collapses this). Fold: `lab_readiness_summary: summary ? { ...summary, started_with_readiness_pending: row.started_with_readiness_pending ?? null } : null`, delete the scalar from the row, keep the two columns on the row (the `CathLabCase` schema gains them). The raw `metadata` column is still not selected. Update the deep test `'the case list carries the STORED readiness summary'` key-set array (+`started_with_readiness_pending`) and add a deep assertion that a case seeded `in_progress` with no snapshot lists `null`, a clean start lists `false`, a pending start lists `true`.

**Text test** (in `cathLabReadinessService.test.js`, textual): the SQL literals of `caseRowTx` and `listCases` contain `metadata->'readiness_at_start'` (or the `->'blocking'` path) and **do not** contain `readiness_at_start_history` or `\bc\.metadata,` / `SELECT \*` — the history is for the audit and the timeline, never for the block or the list (spec §6.4).

- [ ] **Step 4: OpenAPI overlay** (`cathLabReadiness.mjs`)

- `CathLabCase`: `procedure_attempt` (integer, minimum 1) and `attempt_started_at` (date-time, nullable) — required.
- `item.required` gains `'ordered_after_start', 'received_after_start', 'finalised_after_start', 'unavailability_cause'`; properties: three booleans with the spec's descriptions (**`received_after_start` = the deciding row was RECEIVED here after the active attempt's start; a row received before and signed after reads false — a receipt marker, transaction-start ordering**; `finalised_after_start` from `signed_off_at`, false unless signed); `unavailability_cause: { type: 'string', enum: UNAVAILABILITY_CAUSES, nullable: true }` imported from the rules module.
- `missing[]` items: `required: ['item', 'state', 'cause']`, `cause` the same nullable enum.
- `readiness.required` gains `'procedure_attempt', 'attempt_started_at', 'first_started_at', 'started_with_readiness_pending', 'readiness_at_start'`; `started_with_readiness_pending: { type: 'boolean', nullable: true, description: 'true / false / null — null means no snapshot (a case started before the checklist recorded starts, or an attempt not yet started); never read null as "no pending checks".' }`; `readiness_at_start: { type: 'object', nullable: true, additionalProperties: false, required: [...START_SNAPSHOT_KEYS], properties: { recorded_at, procedure_attempt (integer), via (enum START_VIAS), command_id (string nullable), procedure_log_id (integer nullable), urgency (nullable), reason (nullable, 'Projected: null for roles outside the serology audience.'), blocking (array of { check_type: enum CHECK_TYPES, reason }), missing_lab_items: { type: 'array', items: { enum: ITEMS }, nullable: true, description: 'null = lab picture unavailable at start (unknown), never []' }, readiness_picture_at (date-time nullable), lab_component_status (enum LAB_COMPONENT_STATUSES), consent_authority (enum CONSENT_AUTHORITIES nullable) } }`.
- `case_started` description: Task 4 Step 6's text.
- Readiness-check write operation prose: a `consent` pass requires `metadata.consent = { authority ∈ CONSENT_AUTHORITIES, mode ∈ CONSENT_MODES }` (400 `CATH_LAB_CONSENT_AUTHORITY_REQUIRED`; authority outside the tenant policy → 400 `CATH_LAB_CONSENT_AUTHORITY_NOT_PERMITTED` with `details.permitted`); `emergency_basis` is an authority to proceed, **not** consent, and is never rendered as "consent obtained"; a `timeout` pass requires `metadata.timeout.performed_at` (400 `CATH_LAB_TIMEOUT_PERFORMED_AT_REQUIRED`) and the server stamps `completed_at` itself. Document the derived `timing` / `documented_after_start` on the check row.
- `operations` gains **four** prose-only entries (`pathParameters: { id: BIGINT_WIRE }` where applicable, no `request` / `response`):
  - `'POST /api/v1/cath-lab/cases'` — `status` must be one of `CREATABLE_STATUSES` (400 `CATH_LAB_CASE_STATUS_NOT_CREATABLE`); a case is never created running or finished; `procedure_attempt` / `attempt_started_at` are not accepted; reserved metadata keys are stripped. (If the creation operation is already documented elsewhere in the overlay set, add the prose there and keep the pin's `PROSE_ONLY` count honest.)
  - `'POST /api/v1/cath-lab/cases/{id}/status'` — `in_progress` from `scheduled|readiness_pending|ready`; **`command_id` required** (400 `CATH_LAB_START_COMMAND_REQUIRED`), stable per user decision, replay-safe (same attempt → the started case; another attempt → 409 `CATH_LAB_START_COMMAND_STALE`); `reason` required when the gate is not clear (400 `CATH_LAB_START_REASON_REQUIRED`); authority not documented → 400 `CATH_LAB_CONSENT_REQUIRED`; **any** status on a cancelled case → 409 `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED` naming the reopen operation; the snapshot on `metadata.readiness_at_start`; the start never waits on the lab rail (a refresh is scheduled after commit).
  - `'POST /api/v1/cath-lab/cases/{id}/procedure-logs'` — the exhaustive table in prose: finalized log on a start-eligible case starts it through the same path (`start_reason` and `command_id` optional); a **draft or amended** log never starts a case; `in_progress` / `completed` → recorded, case untouched; `cancelled` → 409 `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED`; `requested` or unexpected → 409 `CATH_LAB_CASE_START_NOT_ELIGIBLE` with `details.next_action`.
  - `'POST /api/v1/cath-lab/cases/{id}/reopen'` — **cancelled only** (any other status → `INVALID_STATE_TRANSITION`); `reason` required (400 `CATH_LAB_REOPEN_REASON_REQUIRED`); `Idempotency-Key` required, one per user decision (scope `cath_lab_case_reopen`); clears `actual_end_at` and the active attempt, keeps `actual_start_at`; **if the previous attempt had started, opens attempt N+1, moves the snapshot to `readiness_at_start_history`, and resets `consent` and `timeout` to pending (previous documentation kept in `metadata.previous_attempts`)**; starts nothing.
- Day-list prose: `started_with_readiness_pending` is the seventh summary key and is tri-state.
- **`CASE_LIFECYCLE_ERROR_CODES`** (spec §9): a second exported enum listing `CATH_LAB_CONSENT_REQUIRED`, `CATH_LAB_CONSENT_AUTHORITY_REQUIRED`, `CATH_LAB_CONSENT_AUTHORITY_NOT_PERMITTED`, `CATH_LAB_TIMEOUT_PERFORMED_AT_REQUIRED`, `CATH_LAB_START_REASON_REQUIRED`, `CATH_LAB_START_COMMAND_REQUIRED`, `CATH_LAB_START_COMMAND_STALE`, `CATH_LAB_START_VIA_INVALID`, `CATH_LAB_CASE_STATUS_NOT_CREATABLE`, `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED`, `CATH_LAB_CASE_START_NOT_ELIGIBLE`, `CATH_LAB_REOPEN_REASON_REQUIRED`, `CATH_LAB_REPORT_MONTH_INVALID`, `CATH_LAB_REPORT_FACILITY_INVALID` — documented on the four prose-only operations and (Task 6) the two report operations; exported through `ENUMS` for the pin.

In `cathLabReadinessOpenApiSource.test.js`: `PROSE_ONLY` gains the four keys; the readiness key-set assertion gains the five keys; the item key set is derived by driving the resolver (it picks the four new keys up by construction — confirm the `required` list matches); `it('readiness_at_start declares exactly START_SNAPSHOT_KEYS; its check_type enum is migration 482\'s; its cause enum is migration NNN\'s')` — parse `NNN_cath_lab_case_attempts.sql`'s `cath_case_lab_readiness_items_cause_check` list the way the file already parses 482's type CHECK and compare to `UNAVAILABILITY_CAUSES`; **the second scan**: `/'(CATH_LAB_(?:CONSENT|TIMEOUT|START|CASE_STATUS|CASE_CANCELLED|CASE_START|REOPEN|REPORT)_[A-Z_]+)'/g` over `cathLabService.js`, `cathLabReadinessRules.js`, `cathStartsWithPendingReportService.js` (Task 6 — add the file then) and the cath router, compared to `CASE_LIFECYCLE_ERROR_CODES` **in both directions**; the existing `CATH_LAB_READINESS_*` scan and its scope are unchanged.

Run `npm test -- --testPathPatterns unit/cathLabReadinessOpenApiSource` → PASS (it will list `CATH_LAB_REPORT_*` as documented-but-unraised until Task 6 — either add those two to the enum in Task 6 or accept a red here that Task 6 turns green; say which in the commit message). Then `npm run openapi:generate && npm run openapi:check`; commit the regenerated `src/docs/openapi.json` and `packages/vhhealth_core/swagger/openapi.json`.

- [ ] **Step 5: Canary — three sentinels, CSV bodies, the write mirror** (spec §6.4, §6.5)

- Sentinels: `START_REASON_SENTINEL = 'START-REASON-SENTINEL-7f3a'`, `HISTORY_REASON_SENTINEL = 'HISTORY-REASON-SENTINEL-5c1d'`, `REOPEN_REASON_SENTINEL = 'REOPEN-REASON-SENTINEL-9b2e'`.
- `CASE_ROW` gains `procedure_attempt: 2, attempt_started_at: OBSERVED, attempt_started_at_epoch_ms: BigInt(…), actual_start_at: OBSERVED, first_started_at: OBSERVED, started_with_readiness_pending: true, readiness_at_start: { …12 keys…, reason: START_REASON_SENTINEL, missing_lab_items: ['hbsag'], lab_component_status: 'fresh', consent_authority: 'patient' }, metadata: { readiness_at_start: <same>, readiness_at_start_history: [{ …, procedure_attempt: 1, reason: HISTORY_REASON_SENTINEL }], start_commands: [...] }`; every item fixture gains the three booleans and `unavailability_cause`.
- `disclosures(body, contentType)`: **if the response is `text/csv`, the body text itself is the serialised form**; otherwise `JSON.stringify` as today. Add the three sentinel substring checks; in the JSON walk add `readiness_at_start.reason` populated, `rows[i].reason` populated, and **any key named `readiness_at_start_history`** (it must never appear on a read surface — the block, the list and the report never select it).
- Positive control (`'the poison really is in the persistence layer'`): CATH_LAB_STAFF on `GET /api/v1/cath-lab/cases/:id/readiness/labs` reads `readiness_at_start.reason === START_REASON_SENTINEL`, `started_with_readiness_pending: true`, `missing_lab_items: ['hbsag']`, `procedure_attempt: 2`, and every item has the four booleans and a cause key.
- Liveness: RECEPTIONIST on the same route answers 200 with `readiness_at_start.reason === null`, the same `blocking`, `missing_lab_items`, `consent_authority` and `lab_component_status`, and the booleans on every item.
- **Write mirror**: `POST /api/v1/cath-lab/cases/:id/reopen` as CATH_LAB_STAFF (with the case fixture `cancelled` for that call and an `Idempotency-Key`) answers 2xx whose `RETURNING *` body contains `HISTORY_REASON_SENTINEL` inside `metadata.readiness_at_start_history` — positive control that the history exists and is reachable by the **entitled** workflow role only; RECEPTIONIST on the same POST answers 403 (route role), never a body.
- Summary key set (`'the case LIST really carries a readiness summary'`): + `started_with_readiness_pending`, asserted `true` for the fixture; a second list fixture with no snapshot asserts `null`.
- Timeline reader: **per Task 0 Survey C's verdict** — if projection was required, a fourth positive/liveness pair on the timeline route with `START_REASON_SENTINEL` and `REOPEN_REASON_SENTINEL` in the event payload fixtures; otherwise a unit assertion on `writeCanonicalEvent`'s two cath events (`visible_to_patient` false) lives in `cathLabService.test.js`.

Run: `npm test -- --testPathPatterns unit/serologyDisclosureCanary`. Expected: PASS with **no** reachable-set change yet (the report routes come in Task 6; the reopen route is a POST and adds none).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/services/clinical/cathLabService.js apps/backend/src/services/clinical/cathLabReadinessProjection.js apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs apps/backend/src/docs/openapi.json packages/vhhealth_core/swagger/openapi.json apps/backend/src/tests/unit/cathLabReadinessProjection.test.js apps/backend/src/tests/unit/cathLabReadinessOpenApiSource.test.js apps/backend/src/tests/unit/serologyDisclosureCanary.test.js apps/backend/src/tests/unit/cathLabReadinessService.test.js apps/backend/src/tests/cath-lab-readiness.deep.test.js
git commit -m "feat(cath): readiness picture — attempt fields, tri-state started-with-pending, three markers and cause on the contract, lifecycle error codes machine-checked, canary reads CSV and three sentinels

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 6: Monthly report of starts with checks pending — start events, facility scope, both mounts audited, bounds-converted predicate, EXPLAIN gate

**Files:**
- Modify: `apps/backend/src/utils/roleHelpers.js`
- Create: `apps/backend/src/services/clinical/cathStartsWithPendingReportService.js`
- Create: `apps/backend/src/routes/clinical/cathStartsWithPendingReportHandler.js`
- Modify: `apps/backend/src/routes/clinical/cathLabRoutes.js`, `apps/backend/src/routes/clinical/cathReprocessingPolicyRoutes.js`
- Modify: `apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs`
- Create: `apps/backend/src/tests/unit/cathStartsWithPendingReportService.test.js`
- Test: `apps/backend/src/tests/unit/cathLabReadinessOpenApiSource.test.js`, `apps/backend/src/tests/unit/serologyDisclosureCanary.test.js` + reachable fixture, `apps/backend/src/tests/unit/cathLabRouteGuards.test.js` (route probes), the roleHelpers unit test, `apps/backend/src/tests/cath-lab-readiness.deep.test.js`

- [ ] **Step 1: Failing unit tests** (`cathStartsWithPendingReportService.test.js`; mocks as revision 1)

```js
describe('parameters', () => {
  test('IST month bounds as UTC instants', …as revision 1…);
  test('malformed month → 400 CATH_LAB_REPORT_MONTH_INVALID, no query', …);
  test('facility_id must be a positive int when given → 400 CATH_LAB_REPORT_FACILITY_INVALID', async () => {
    for (const facilityId of ['abc', '0', '-1', '1.5']) await expect(startsWithPendingReport({ tenantId: TENANT, month: '2026-09', facilityId })).rejects.toMatchObject({ code: 'CATH_LAB_REPORT_FACILITY_INVALID' });
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });
});
describe('the query', () => {
  test('converts the BOUNDS, never the column; binds tenant, bounds, facility; joins the timeout check', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);
    await startsWithPendingReport({ tenantId: TENANT, month: '2026-09', facilityId: '4' });
    const [sql, tenant, start, end, facility] = queryRawUnsafe.mock.calls[0];
    expect(sql).toContain("a.created_at >= ($2::timestamptz AT TIME ZONE 'UTC')");
    expect(sql).toContain("a.created_at <  ($3::timestamptz AT TIME ZONE 'UTC')");
    expect(sql).not.toMatch(/\(a\.created_at AT TIME ZONE/);           // mutation 27
    expect(sql).toContain("($4::int IS NULL OR NULLIF(a.metadata->>'facility_id', '')::int = $4::int)");
    expect(sql).toMatch(/LEFT JOIN cath_lab_readiness_checks t/);
    expect([tenant, start, end, facility]).toEqual([TENANT, '2026-08-31T18:30:00.000Z', '2026-09-30T18:30:00.000Z', 4]);
  });
  test('maps a row: start_event_id, procedure_attempt, lab_component_status, consent_authority, timeout_outcome; counts EVENTS and distinct cases; folds per facility with events and cases; breakdowns', async () => {
    queryRawUnsafe.mockResolvedValueOnce([
      row({ start_event_id: 88121, case_id: '1201', attempt: 2, blocking: ['labs', 'timeout'], timeout: { status: 'pass', documented_at: T(+10), meta: { performed_at: T(-1) } }, consent: 'emergency_basis' }),
      row({ start_event_id: 88100, case_id: '1201', attempt: 1, blocking: ['labs'], consent: 'patient' }),
      row({ start_event_id: 88090, case_id: '1202', attempt: 1, facility: 7, blocking: ['timeout'], timeout: { status: 'pending' }, consent: null, missing: null, labStatus: 'unavailable' }),
    ]);
    const report = await startsWithPendingReport({ tenantId: TENANT, month: '2026-09' });
    expect(report).toMatchObject({ month: '2026-09', facility_id: null, total_events: 3, distinct_cases: 2 });
    expect(report.facilities).toEqual([{ facility_id: 4, facility_name: 'Main block', events: 2, cases: 1 }, { facility_id: 7, facility_name: 'Annexe', events: 1, cases: 1 }]);
    expect(report.timeout_outcomes).toEqual({ not_pending_at_start: 1, performed_before_start_documented_late: 1, performed_after_start: 0, not_performed: 1, unknown: 0 });
    expect(report.consent_authorities).toEqual({ patient: 1, legally_authorised_representative: 0, emergency_basis: 1, not_recorded: 1 });
    expect(report.rows[0]).toMatchObject({ start_event_id: 88121, case_id: 1201, procedure_attempt: 2, timeout_outcome: 'performed_before_start_documented_late', consent_authority: 'emergency_basis' });
    expect(report.rows[2]).toMatchObject({ missing_lab_items: null, lab_component_status: 'unavailable', timeout_outcome: 'not_performed', consent_authority: null });
  });
  test('a legacy audit row (revision-1 snapshot shape) reads procedure_attempt 1, lab_component_status unavailable, missing_lab_items null — never a clean start', …);
});
describe('projection and CSV', () => {
  test('reason blanked for QUALITY_OFFICER, kept for ADMIN, key set unchanged', …);
  test('CSV: the 18 columns in order, lists joined with ;, null missing_lab_items rendered empty, formula-leading reason neutralised, CRLF', () => {
    expect(lines[0]).toBe('month,start_event_id,case_id,procedure_attempt,facility_id,facility_name,urgency,via,started_at,blocking_check_types,missing_lab_items,lab_component_status,consent_authority,timeout_outcome,reason,actor_uid,actor_role,actor_name');
    …
  });
});
```

roleHelpers test as revision 1.

- [ ] **Step 2: Run to verify they fail** — module not found.

- [ ] **Step 3: Implement roles and the service** — roles as revision 1. The service:

```js
export const START_AUDIT_ACTION = 'cath_lab.case.started_with_readiness_pending';
export const CSV_COLUMNS = Object.freeze(['month', 'start_event_id', 'case_id', 'procedure_attempt', 'facility_id', 'facility_name', 'urgency', 'via', 'started_at',
  'blocking_check_types', 'missing_lab_items', 'lab_component_status', 'consent_authority', 'timeout_outcome', 'reason', 'actor_uid', 'actor_role', 'actor_name']);
const TIMEOUT_OUTCOMES = ['not_pending_at_start', 'performed_before_start_documented_late', 'performed_after_start', 'not_performed', 'unknown'];

function facilityFilter(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw AppError.badRequest('facility_id must be a positive integer', 'CATH_LAB_REPORT_FACILITY_INVALID');
  return n;
}
// The time-out's outcome for ONE start event (spec §7.3), from the snapshot's
// blocking list, the joined check row and the event's recorded_at.
function timeoutOutcomeFor(meta, row) {
  const blocking = Array.isArray(meta.blocking) ? meta.blocking.map((b) => b?.check_type) : [];
  if (!blocking.includes('timeout')) return 'not_pending_at_start';
  if (row.timeout_status !== 'pass') return 'not_performed';
  const performed = toMs(row.timeout_meta?.performed_at); const documented = toMs(row.timeout_documented_at); const started = toMs(meta.recorded_at);
  if (!Number.isFinite(performed)) return 'unknown';
  if (performed > started) return 'performed_after_start';
  return documented > started ? 'performed_before_start_documented_late' : 'unknown';
}
function rowFrom(row) {
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const snapshot = normalizeStartSnapshot(meta) ?? {};      // the audit metadata carries the snapshot keys flat (…snapshot)
  return {
    start_event_id: Number(row.start_event_id), case_id: Number(row.case_id), procedure_attempt: snapshot.procedure_attempt ?? 1,
    facility_id: row.facility_id == null ? null : Number(row.facility_id), facility_name: row.facility_name ?? null,
    urgency: snapshot.urgency, via: snapshot.via, started_at: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
    blocking_check_types: snapshot.blocking.map((b) => String(b.check_type)), missing_lab_items: snapshot.missing_lab_items,   // null = unknown
    lab_component_status: snapshot.lab_component_status, consent_authority: snapshot.consent_authority, timeout_outcome: timeoutOutcomeFor(meta, row),
    reason: snapshot.reason, actor_uid: row.actor_uid ?? null, actor_role: row.actor_role ?? null, actor_name: row.actor_name ?? null,
  };
}
export async function startsWithPendingReport({ tenantId, month, facilityId } = {}) {
  const tid = requireTenantId(tenantId);
  const { start, end } = monthBoundsIst(month);
  const facility = facilityFilter(facilityId);
  const rows = await setTenant(tid, (client) => client.$queryRawUnsafe(
    `SELECT a.id AS start_event_id, a.created_at AS started_at, a.actor_uid, a.role AS actor_role, u.name AS actor_name,
            a.resource_id AS case_id, a.metadata,
            f.id AS facility_id, f.display_name AS facility_name,
            t.status AS timeout_status, t.completed_at AS timeout_documented_at, t.metadata->'timeout' AS timeout_meta
       FROM audit_logs a
       LEFT JOIN facilities f ON f.tenant_id = a.tenant_id AND f.id = NULLIF(a.metadata->>'facility_id', '')::int
       LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.uid = a.actor_uid
       LEFT JOIN cath_lab_readiness_checks t ON t.tenant_id = a.tenant_id AND t.case_id = NULLIF(a.resource_id, '')::bigint AND t.check_type = 'timeout'
      WHERE a.tenant_id = $1::uuid
        AND a.action = '${START_AUDIT_ACTION}'
        -- audit_logs.created_at is timestamp(6) WITHOUT time zone written by NOW() under UTC-pinned sessions.
        -- Convert the BOUNDS to that shape, never the column, so idx_audit_logs_tenant_time_id can range-scan.
        AND a.created_at >= ($2::timestamptz AT TIME ZONE 'UTC')
        AND a.created_at <  ($3::timestamptz AT TIME ZONE 'UTC')
        AND ($4::int IS NULL OR NULLIF(a.metadata->>'facility_id', '')::int = $4::int)
      ORDER BY a.created_at DESC, a.id DESC`,
    tid, start, end, facility));
  const mapped = rows.map(rowFrom);
  const byFacility = new Map();
  for (const row of mapped) {
    const key = row.facility_id ?? 'null';
    const entry = byFacility.get(key) || { facility_id: row.facility_id, facility_name: row.facility_name, events: 0, cases: new Set() };
    entry.events += 1; entry.cases.add(row.case_id); byFacility.set(key, entry);
  }
  const count = (list, keys, pick, fallback) => Object.fromEntries(keys.map((k) => [k, list.filter((r) => (pick(r) ?? fallback) === k).length]));
  return {
    month: String(month).trim(), facility_id: facility,
    total_events: mapped.length, distinct_cases: new Set(mapped.map((r) => r.case_id)).size,
    facilities: [...byFacility.values()].map((e) => ({ facility_id: e.facility_id, facility_name: e.facility_name, events: e.events, cases: e.cases.size })).sort((a, b) => (a.facility_id ?? Infinity) - (b.facility_id ?? Infinity)),
    timeout_outcomes: count(mapped, TIMEOUT_OUTCOMES, (r) => r.timeout_outcome),
    consent_authorities: count(mapped, [...CONSENT_AUTHORITIES, 'not_recorded'], (r) => r.consent_authority, 'not_recorded'),
    rows: mapped,
  };
}
export function projectReportForRole(report, role) { return { ...report, rows: report.rows.map((row) => ({ ...row, reason: projectStartReasonForRole(row.reason, role) })) }; }
export function reportToCsv(report) {
  return rowsToCsv([...CSV_COLUMNS], report.rows.map((row) => [report.month, row.start_event_id, row.case_id, row.procedure_attempt, row.facility_id, row.facility_name, row.urgency, row.via, row.started_at,
    row.blocking_check_types.join(';'), row.missing_lab_items == null ? '' : row.missing_lab_items.join(';'), row.lab_component_status, row.consent_authority, row.timeout_outcome, row.reason, row.actor_uid, row.actor_role, row.actor_name]));
}
```

(`normalizeStartSnapshot` reads the flat snapshot keys off the audit metadata — `recordReadinessAudit` spreads `...snapshot` into it; a revision-1-shaped legacy row therefore reads `procedure_attempt: null → 1`, `lab_component_status: 'unavailable'`, `missing_lab_items: null`. `START_AUDIT_ACTION` is a module constant — if `lint:raw-params` objects, bind it as `$5`.)

- [ ] **Step 4: Run the unit tests** — PASS.

- [ ] **Step 5: The handler — audited on both mounts, before the response** (spec §7.4)

```js
export default function cathStartsWithPendingReportHandler({ mount }) {
  return async function handler(req, res) {
    try {
      const tenantId = resolveTenantOrThrow(req);
      const role = req.user?.role || req.user?.rawRole || null;
      const format = String(req.query?.format || 'json').toLowerCase() === 'csv' ? 'csv' : 'json';
      const report = projectReportForRole(await startsWithPendingReport({ tenantId, month: req.query?.month, facilityId: req.query?.facility_id }), role);
      // The cathDeviceHistoryHandler rule: the reader never receives the rows on a
      // request whose access row was not even attempted. Shared writer, both mounts,
      // format recorded so an export is distinguishable from a screen read.
      await logAudit(req, 'cath_lab.report.starts_with_pending.read',
        { month: report.month, facility_id: report.facility_id, format, total_events: report.total_events, distinct_cases: report.distinct_cases, mount },
        { resource: 'cath_lab_report', resourceId: 'starts-with-pending' });
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="cath-starts-with-pending-${report.month}.csv"`);
        return res.status(200).send(reportToCsv(report));
      }
      return success(res, report, 'Cath starts with readiness pending');
    } catch (err) { return relayAppError(res, err, 'Failed to build the starts-with-pending report'); }
  };
}
```

Registration: cath router `router.get('/reports/starts-with-pending', requireRole(...CATH_READINESS_REPORT_ROLES), cathStartsWithPendingReportHandler({ mount: 'cath-lab' }))` **immediately before** `router.get('/reports/:id/pdf', …)`; governance router the same with `{ mount: 'cath-reprocessing' }` after the device-history registration. Read `logAudit`'s real option names off `utils/logAudit.js` before pasting.

- [ ] **Step 6: Route-order, role and parameter probes** (`cathLabRouteGuards.test.js` or the sibling suite): ADMIN → 200 (not the report guard's 400/404); RECEPTIONIST → 403; `?month=2026-09&facility_id=abc` → 400 `CATH_LAB_REPORT_FACILITY_INVALID`; governance: QUALITY_OFFICER → 200, INFECTION_CONTROL_OFFICER → 403; each 200 leaves **one** `logAudit` call (mock it) with `format: 'json'` and the right `mount`; `?format=csv` → `text/csv` and `format: 'csv'` in the audit call.

- [ ] **Step 7: OpenAPI** — `CathLabStartsWithPendingRow` (the 18 row keys, `missing_lab_items` nullable, `timeout_outcome` enum, `consent_authority` nullable enum, `lab_component_status` enum), `CathLabStartsWithPendingReport` (`month`, `facility_id` nullable, `total_events`, `distinct_cases`, `facilities[]` with `events` + `cases`, `timeout_outcomes`, `consent_authorities`, `rows[]`), envelope; both operations with `parameters: month (required, pattern), facility_id (optional, integer ≥ 1), format (json|csv)`; description states: **identifiable operational data** (case ids resolve to patients; actors named), counts start **events** not distinct cases, IST month, reason projected, every read audited (`cath_lab.report.starts_with_pending.read`, `format` recorded), 400 codes in prose; `READS` gains both; `CATH_LAB_REPORT_*` in `CASE_LIFECYCLE_ERROR_CODES`; add `cathStartsWithPendingReportService.js` to the lifecycle scan's file set. `npm run openapi:generate && npm run openapi:check`.

- [ ] **Step 8: Canary** — `SEEDED` gains an `audit_logs` row (`START_AUDIT_ROW` with the 12-key snapshot flat in `metadata`, `reason: START_REASON_SENTINEL`) and a matching `cath_lab_readiness_checks` timeout row for the join; the walker appends `?month=2026-09` for the two report paths and probes each **twice**, JSON and `&format=csv` (`disclosures` reads the CSV text); regenerate the snapshot once, inspect the diff — exactly two new keys: `GET /api/v1/cath-lab/reports/starts-with-pending: [ADMIN, CATH_LAB_INCHARGE, SUPER_ADMIN]` and `GET /api/v1/cath-reprocessing/reports/starts-with-pending: [ADMIN, QUALITY_OFFICER, SUPER_ADMIN]`; positive control ADMIN reads the sentinel in `rows[0].reason` (JSON) and in the CSV text; liveness QUALITY_OFFICER on the governance mount answers 200 with `rows[0].reason === null`, `missing_lab_items: ['hbsag']`, `blocking_check_types: ['labs']`, and a CSV whose `reason` column is empty.

- [ ] **Step 9: Deep** — after the point-4 test's second start (attempt 2, pending): `startsWithPendingReport({ tenantId: TENANT, month: clinicalDate(new Date()).slice(0, 7) })` contains a row with that `start_event_id` (the audit row's id), `procedure_attempt: 2`, `consent_authority: 'patient'`, a `timeout_outcome` in the enum, and `distinct_cases ≤ total_events`; `facilityId: FACILITY_ID` returns the same row, a non-existent facility returns none; through the route, one GET on each mount → **two** `audit_logs` rows with `action = 'cath_lab.report.starts_with_pending.read'`, `metadata.mount` differing, and a third with `format: 'csv'` after a CSV read; `reportToCsv` has ≥ 2 lines.

- [ ] **Step 10: The EXPLAIN gate** (spec §7.2 — "a few hundred report rows ≠ a few hundred audit rows examined")

```bash
# seed: ≥ 5 000 audit_logs rows across several actions and TWO tenants, ~300 of them the start action in the report month
psql "$DATABASE_URL" -f "$SCRATCH/seed-audit-explain.sql"     # write it: generate_series inserts; keep it out of the repo
psql "$DATABASE_URL" -c "EXPLAIN (ANALYZE, BUFFERS) <the exact query text with the bounds bound as literals and \$4 = NULL>"
```

Acceptance: an Index Scan or Bitmap Index Scan on `idx_audit_logs_tenant_time_id` bounded by the month; **no** `Seq Scan on audit_logs`; rows examined of the order of the tenant's rows in that month. Paste the plan into the PR body. If the planner prefers the tenant-unaware single-column `action` index, the fix is a partial index `(tenant_id, created_at DESC, id DESC) WHERE action = 'cath_lab.case.started_with_readiness_pending'` in a **follow-up** migration numbered at push time — never a rewrite of the predicate (mutation 27 pins the predicate's text).

- [ ] **Step 11: Commit**

```bash
git add apps/backend/src/utils/roleHelpers.js apps/backend/src/services/clinical/cathStartsWithPendingReportService.js apps/backend/src/routes/clinical/cathStartsWithPendingReportHandler.js apps/backend/src/routes/clinical/cathLabRoutes.js apps/backend/src/routes/clinical/cathReprocessingPolicyRoutes.js apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs apps/backend/src/docs/openapi.json packages/vhhealth_core/swagger/openapi.json apps/backend/src/tests/unit/cathStartsWithPendingReportService.test.js apps/backend/src/tests/unit/cathLabReadinessOpenApiSource.test.js apps/backend/src/tests/unit/serologyDisclosureCanary.test.js apps/backend/src/tests/fixtures/serologyDisclosureCanary.reachable.json apps/backend/src/tests/unit/cathLabRouteGuards.test.js apps/backend/src/tests/cath-lab-readiness.deep.test.js
# plus the roleHelpers unit test file
git commit -m "feat(cath): monthly starts-with-pending report — start events with attempt id, facility scope, time-out and consent breakdowns, audited on both mounts, bounds-converted predicate with EXPLAIN gate, CSV

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
## Task 7: Staff app — Start / Reopen, live updates over `staff:lab`, consent authority, time-out instants, the picture

**Files:**
- Modify: `apps/staff/lib/features/cath_lab/models/cath_readiness_models.dart`, `services/cath_lab_api_service.dart`, `widgets/cath_readiness_checklist.dart`, `widgets/cath_lab_readiness_panel.dart`, `screens/cath_lab_screen.dart`, `apps/staff/lib/l10n/app_strings.dart`
- Test: `apps/staff/test/features/cath_lab/cath_readiness_checklist_test.dart`, `cath_lab_screen_test.dart`, `apps/staff/test/i18n_guard_test.dart`

- [ ] **Step 1: Models — failing parse tests** — extend revision 1's test with the new shape: `procedure_attempt`, `attempt_started_at`, `first_started_at`, `started_with_readiness_pending: null` parses to `null` (tri-state `bool?`), the 12-key snapshot with `missing_lab_items: null`, item `finalised_after_start` and `unavailability_cause`, a check with `metadata.consent { authority, mode, documented_at }` and one with `metadata.timeout { performed_at, documented_at }` plus the server-derived `timing` / `documented_after_start`, `previous_attempts`, and `CathCaseReadiness` `started` true when `attempt_started_at` is set and **false** when only `actual_start_at` is (attempt 2 not started).

- [ ] **Step 2: Models — implement** — `CathReadinessBlocking`; `CathReadinessStartSnapshot` (recordedAt, procedureAttempt, via, commandId, procedureLogId, urgency, reason, blocking, `List<String>? missingLabItems`, readinessPictureAt, labComponentStatus, consentAuthority); `CathConsentRecord { authority, mode, documentedAt }`; `CathTimeoutRecord { performedAt, documentedAt, timing, documentedAfterStart }`; `CathReadinessCheck.completedAt / .consent / .timeout / .previousAttempts`; `CathLabReadinessItem.orderedAfterStart / .receivedAfterStart / .finalisedAfterStart / .unavailabilityCause`; `CathLabReadiness.procedureAttempt / .attemptStartedAt / .firstStartedAt / .startedWithReadinessPending (bool?) / .readinessAtStart`; `CathLabReadinessSummary.startedWithReadinessPending (bool?)`; `CathCaseReadiness.caseStatus / .procedureAttempt / .attemptStartedAt / .blocking` with `started => attemptStartedAt != null || caseStatus == 'in_progress'`, `startable => {'scheduled','readiness_pending','ready'}.contains(caseStatus)`, `consentPassed`.

- [ ] **Step 3: API**

```dart
  /// POST /cath-lab/cases/:id/status with in_progress. [commandId] is the stable
  /// per-decision token the server binds to the attempt (CATH_LAB_START_COMMAND_
  /// REQUIRED without it; CATH_LAB_START_COMMAND_STALE if the case was reopened
  /// since). Mint it ONCE per confirmation with IdempotencyKey.generate() and
  /// reuse it on every retry — the caller owns it, this method never mints.
  static Future<void> startCase(int caseId, {required String commandId, String? reason}) async { … body: {'status': 'in_progress', 'command_id': commandId, if (reason?.trim().isNotEmpty == true) 'reason': reason!.trim()} … }
  /// POST /cath-lab/cases/:id/reopen. Idempotency-Key REQUIRED server-side; the
  /// caller mints it through IdempotencyAttempt (one per user decision).
  static Future<void> reopenCase(int caseId, {required String reason, required String idempotencyKey}) async { … }
  // updateReadinessCheck gains an optional `Map<String, dynamic>? metadata` sent as `metadata`.
```

Mirror `waiveLabItem`'s error handling (`_successfulData`).

- [ ] **Step 4: Checklist — failing widget tests** (extend `_readiness(...)` with `caseStatus`, `procedureAttempt`, `attemptStartedAt`, `blocking`, per-check statuses/metadata, and `labs` fields; inject `startCase`, `reopenCase`, `updateCheck`, `labEvents`, `connectionStates` through `CathReadinessDependencies`)

```dart
  testWidgets('consent not passed: start row disabled with the authority line; nothing posts', …);
  testWidgets('gate clear: "Start procedure" shows the Start definition line and posts with a command id and no reason', … expect(find.byKey(const ValueKey('cath-readiness-start-definition')), findsOneWidget); expect(started.single.commandId, isNotEmpty); expect(started.single.reason, isNull); …);
  testWidgets('gate pending: "Start anyway" names the checks, refuses an empty reason, then posts it', …);
  testWidgets('the command id is minted once per confirmation and reused on retry', (tester) async {
    var calls = 0; final ids = <String>[];
    deps.startCase = (id, {required commandId, reason}) async { ids.add(commandId); if (++calls == 1) throw const SocketException('lost'); };
    … tap start → confirm → (error surfaced) → tap start again on the SAME confirmation? No: the checklist retries the same command internally once on a transport error; assert ids.length == 2 && ids[0] == ids[1] …
    … a NEW confirmation after a success mints a different id …
  });
  testWidgets('409 CATH_LAB_START_COMMAND_STALE reloads and shows the stale message', …);
  testWidgets('started-with-pending banner (true); muted "not documented" line (null); nothing (false)', …);
  testWidgets('critical banner on a started case; item chip when any of the three item booleans is true; time-out chip reads Documented-after-start vs Performed-after-start', …);
  testWidgets('consent pass: authority and mode choosers (from the policy list, in order); sends metadata.consent; caption for emergency_basis never contains "consent"', (tester) async {
    … choose 'Emergency basis for proceeding' + 'Verbal' → expect(updates.single.metadata?['consent'], {'authority': 'emergency_basis', 'mode': 'verbal'});
    … rebuild with the check passed emergency_basis → final caption = tester.widget<Text>(find.byKey(const ValueKey('cath-readiness-consent-caption'))).data!; expect(caption.toLowerCase(), isNot(contains('consent'))); expect(caption, contains('Emergency basis'));
  });
  testWidgets('a legacy consent pass shows "Authority not recorded" with a Record action that opens the same dialog', …);
  testWidgets('time-out pass requires performed_at; the row shows performed vs documented', …);
  testWidgets('"Picture as of" line from live_evidence_refreshed_at; " · live updates paused" when the connection state is not connected', …);
  testWidgets('END TO END: a lab event on staff:lab reloads the started checklist and the red banner appears without rebuilding; two events 100 ms apart reload once', (tester) async {
    final events = StreamController<RealtimeEvent>.broadcast();
    var loads = 0;
    deps.loadReadiness = (_) async { loads++; return _readiness(caseStatus: 'in_progress', attemptStartedAt: t0, labs: _labs(criticalWarning: loads > 1, criticalItems: loads > 1 ? ['potassium'] : const [], receivedAfterStart: loads > 1)); };
    deps.labEvents = (channel) { expect(channel, 'staff:lab'); return events.stream; };
    await tester.pumpWidget(_host(deps)); await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('cath-readiness-critical-banner')), findsNothing);
    events.add(RealtimeEvent(channel: 'staff:lab', data: const {'kind': 'result-signed'}, at: DateTime.now()));
    await tester.pump(const Duration(milliseconds: 100));
    events.add(RealtimeEvent(channel: 'staff:lab', data: const {'kind': 'result-signed'}, at: DateTime.now()));
    await tester.pump(const Duration(milliseconds: 400)); await tester.pumpAndSettle();
    expect(loads, 2);                                                           // one initial + ONE debounced reload for two events
    expect(find.byKey(const ValueKey('cath-readiness-critical-banner')), findsOneWidget);
    expect(find.byKey(const ValueKey('cath-lab-item-after-start-potassium')), findsOneWidget);
  });
  testWidgets('pre-start the checklist does not subscribe to staff:lab', …);
  testWidgets('cancelled case: "Reopen case" with the new-attempt note, no start row; empty reason refused; the Idempotency-Key is reused across a retry and reset after success', …);
  testWidgets('non-cancelled statuses offer no reopen row', …);
```

`cath_lab_screen_test.dart`: the `RealtimeStatusBanner` watches `staff:lab` too — a denied `staff:lab` shows the red form; the header chip `cath-readiness-header-started-pending` renders on `true` only.

- [ ] **Step 5: Checklist — implement**

- `CathReadinessDependencies` gains `startCase` (`Future<void> Function(int caseId, {required String commandId, String? reason})`), `reopenCase` (`Future<void> Function(int caseId, {required String reason, required String idempotencyKey})`), `labEvents` (`Stream<RealtimeEvent> Function(String channel)?`, default `RealtimeClient.instance.events`), `connectionStates` (`Stream<RealtimeConnectionState>?` + a `connectionState` getter, default the client's). `CathReadinessCheckUpdater` gains `Map<String, dynamic>? metadata`.
- **Start row** (`_StartRow`, key `cath-readiness-start`) when `readiness.startable`: label `start_procedure` / `start_anyway`; `onPressed: consentPassed ? _start : null`; `cath-readiness-start-consent-blocked` line when not. `_start`: dialog with the **Start definition line** (key `cath-readiness-start-definition`, string `start_definition`), the blocking line, `reasonRequired` when blocking; on confirm mint `final commandId = IdempotencyKey.generate();` **before** the first send; call `_startCase(caseId, commandId: commandId, reason: …)`; on a transport error retry once with the **same** `commandId`; on a `CATH_LAB_START_COMMAND_STALE` response show `start_command_stale` and `_reload()`; on success `_reload()`. The dialog shows `start_lab_picture` (`{time}` from `labs.liveEvidenceRefreshedAt`) or `start_lab_picture_unavailable` when the block has no item rows.
- **Reopen row** (`cath-readiness-reopen`) when `caseStatus == 'cancelled'`: dialog body `reopen_body` + `reopen_new_attempt_note` when `readiness.attemptStartedAt != null || readiness.firstStartedAt != null` (the server decides; the note states the consequence when it applies); the key is `_reopenAttempt.keyFor({'reason': reason})` with `late final IdempotencyAttempt _reopenAttempt = IdempotencyAttempt('cath-lab-reopen-${widget.caseId}')`, `reset()` after success — the panel's convention.
- **Banners**: `startedWithReadinessPending == true` → amber `cath-readiness-started-pending-banner` (checks from `readinessAtStart.blocking` + `missingLabItems`, `· lab picture unavailable at start` when `missingLabItems == null`); `== null && started` → muted `cath-readiness-start-undocumented`; `false` → nothing. Critical banner as revision 1.
- **Chips**: check row `cath-readiness-check-after-start-<type>` when `completedAt` is after `attemptStartedAt`; for `timeout` the chip text is `timeout_documented_after_start` when `timeout.timing == 'performed_before_start'` else `timeout_performed_after_start`; row caption `timeout_timing` with `{performed}` / `{documented}`.
- **Consent choosers** in `_setStatus` for `consent` + `pass`: two `DropdownButtonFormField<String>` (keys `cath-readiness-consent-authority`, `cath-readiness-consent-mode`), authorities in the order `patient`, `legally_authorised_representative`, `emergency_basis` (filtered by a `permittedAuthorities` list the dependencies expose; default all three), modes `written` / `verbal` / `telephone`; sends `metadata: {'consent': {'authority': a, 'mode': m}}`. Caption (key `cath-readiness-consent-caption`): `consent_caption_obtained` (`{authority}`, `{mode}`) or, for `emergency_basis`, `consent_caption_emergency` (`{mode}`) — **the English string must not contain the word "consent"**; the widget test pins it. Legacy pass → "Authority not recorded" + `Record` (opens the same dialog with status pass).
- **Time-out** in `_setStatus` for `timeout` + `pass`: a `performed_at` field (key `cath-readiness-timeout-performed-at`, a time picker defaulting to now, never pre-passed), sent as `metadata: {'timeout': {'performed_at': iso}}`.
- **Picture line** `cath-readiness-picture-as-of` (`picture_as_of` `{time}`) + `picture_paused` suffix when `connectionState != connected` (subscribed through `connectionStates`).
- **Live updates**: in `initState` / when the loaded case is started, `_labSub = _labEvents('staff:lab').listen(_onLabEvent)` with a 400 ms debounce into `_reload()`; cancel on dispose and when the case is no longer started. Pre-start: no subscription.

`cath_lab_readiness_panel.dart`: `showOrderMissing = labs.orderableNow.isNotEmpty;` `canEnterExternal = !item.available;` (drop `!labs.caseStarted` from both; un-waive keeps #1018's gate on `caseStarted`, which now means the active attempt); item chip `cath-lab-item-after-start-<code>` when any of the three booleans is true; the item caption shows the cause label when set (`item.unavailability_cause` → `s4.lib.cath_lab.readiness.cause.<cause>`; add the seven keys to the string list below if you render them — otherwise render the raw code in a muted style and note it).

`cath_lab_screen.dart`: `RealtimeStatusBanner(watchChannels: const {'staff:code-stemi', 'staff:lab'}, …)`; `_headerSignals` reads the tri-state (`== true` only) for the chip.

- [ ] **Step 6: Strings (five locales; hi/ta/te/ml carry `// REVIEW: AI first-pass cath readiness never-restricts (rev 2) - confirm wording before production.`)**

Under `s4.lib.cath_lab.readiness.` — **40 keys**: revision 1's 18 kept (`start_procedure`, `start_anyway`, `start_title`, `start_body`, `start_anyway_body` `{checks}`, `start_reason`, `start_consent_blocked`, `started_pending_banner` `{checks}`, `started_pending_reason` `{reason}`, `critical_banner` `{items}`, `critical_banner_unnamed`, `recorded_after_start`, `after_start`, `header.started_pending`, `reopen_case`, `reopen_title`, `reopen_body`, `reopen_reason`) plus 22: `start_definition`, `start_command_stale`, `start_lab_picture` `{time}`, `start_lab_picture_unavailable`, `consent_authority_label`, `consent_authority.patient`, `consent_authority.legally_authorised_representative`, `consent_authority.emergency_basis`, `consent_mode_label`, `consent_mode.written`, `consent_mode.verbal`, `consent_mode.telephone`, `consent_caption_obtained` `{authority}` `{mode}`, `consent_caption_emergency` `{mode}`, `timeout_performed_at`, `timeout_timing` `{performed}` `{documented}`, `timeout_documented_after_start`, `timeout_performed_after_start`, `picture_as_of` `{time}`, `picture_paused`, `start_undocumented`, `reopen_new_attempt_note`. English `start_definition`: "Start records the beginning of the invasive procedure — vascular access or the first invasive act. Room entry and preparation are not Start." English `consent_caption_emergency`: "Emergency basis for proceeding documented — {mode}". `i18n_guard_test.dart`'s cath-readiness test scans the widget files for the prefix (so every used key must exist in all five locales); add the placeholder-bearing keys to its dynamic-placeholder check; if the screen's header chip key lives in `cath_lab_screen.dart`, that file is already in the guard's other scan.

- [ ] **Step 7: Run and commit**

```bash
cd apps/staff && flutter analyze && flutter test test/features/cath_lab test/i18n_guard_test.dart
git add apps/staff/lib/features/cath_lab apps/staff/lib/l10n/app_strings.dart apps/staff/test/features/cath_lab apps/staff/test/i18n_guard_test.dart
git commit -m "feat(staff): cath start with a stable command id and the Start definition, reopen with the new-attempt note, live warnings over staff:lab, consent authority/mode, time-out performed-at, tri-state started-with-pending, cause on items

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 8: Admin — "Starts with checks pending" tab (facility filter, breakdowns, identifiability)

**Files:**
- Modify: `apps/admin/src/lib/api/cathDevices.ts`
- Create: `apps/admin/src/app/(with-auth)/dashboard/quality/cath/components/StartsWithPendingTab.tsx`
- Modify: `apps/admin/src/app/(with-auth)/dashboard/quality/cath/page.tsx`
- Create: `apps/admin/src/__tests__/dashboard/quality/cath-starts-with-pending.test.tsx`

- [ ] **Step 1: Failing test** — as revision 1's shape with the revision-2 report (`total_events`, `distinct_cases`, `facilities[].events/cases`, `timeout_outcomes`, `consent_authorities`, rows with `start_event_id`, `procedure_attempt`, `lab_component_status`, `consent_authority`, `timeout_outcome`, `missing_lab_items: null` rendered as "unknown"): renders the identifiability header text; the per-facility table; the two breakdown blocks; the rows with attempt and outcomes; a projected-null reason as a dash; changing the month re-queries; choosing a facility from the `Facility` select re-queries with `facilityId`; Download CSV calls the export with `(month, facilityId)`.

- [ ] **Step 2: API helpers** — `getCathStartsWithPendingReport(month, facilityId?)` and `downloadCathStartsWithPendingCsv(month, facilityId?)` (`apiFetch` from `../api-fetch`, `Accept: text/csv`); the `CathStartsWithPendingRow` / `CathStartsWithPendingReport` interfaces with the revision-2 keys.

- [ ] **Step 3: The tab and the page** — `"use client"`; month input (`aria-label="Month"`); facility `<select aria-label="Facility">` fed from the current report's `facilities[]` (plus "All"); header: "This report identifies cases and operators. It counts start events (one row per start; a reopened case can appear more than once) from the start audit trail. The authority to proceed can never be undocumented here. The reason column is shown to the clinical audience only."; KPI line `total_events` / `distinct_cases`; facilities table (`events`, `cases`); breakdown blocks for `timeout_outcomes` and `consent_authorities`; rows table (start event id, case id, attempt, facility, urgency, via, started at, blocking, missing items or "unknown", lab picture status, consent authority, time-out outcome, reason or —, actor); Download CSV via the `lib/exportToCsv.ts` anchor helper. `page.tsx`: `TABS` gains `{ key: "starts-with-pending", label: "Starts with checks pending", icon: AlertTriangle }`.

- [ ] **Step 4: Run, lint, commit**

```bash
cd apps/admin && npx jest src/__tests__/dashboard/quality && npm run lint
git add "apps/admin/src/app/(with-auth)/dashboard/quality/cath" apps/admin/src/lib/api/cathDevices.ts apps/admin/src/__tests__/dashboard/quality/cath-starts-with-pending.test.tsx
git commit -m "feat(admin): cath quality — starts-with-checks-pending tab with facility filter, time-out and consent breakdowns, identifiability header, CSV

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 9: Gates and hand-back

Plan 3 Task 7 / Plan 2 Task 8 are the template. Merge authority is dev-1b; **draft PR only; do not mark ready; do not merge.**

- [ ] **Step 1: Merge main; re-check the migration number**

```bash
git fetch github '+refs/heads/*:refs/remotes/github/*'
git merge --no-ff github/main -m "chore: merge main into feat/cath-readiness-never-restricts"
for ref in $(git for-each-ref --format='%(refname)' refs/remotes/github/); do git ls-tree --name-only "$ref" apps/backend/src/migrations/ 2>/dev/null; done | sed -E 's#.*/([0-9]+)_.*#\1#' | sort -n | uniq | tail -2
```

If any branch now carries a `767_*` that is not ours, **renumber before pushing** (file, `schema.prisma` comment, the OpenAPI pin's parse path, the spec cross-references in the PR body) — this branch has never been pushed, so nothing is immutable yet.

- [ ] **Step 2: Backend gates**

```bash
cd apps/backend
npm run lint
npm test -- --testPathPatterns unit/                       # the FULL unit corpus
npm run openapi:check && npm run check:migration-numbers && npm run check:migration-immutability   # LIVE: NNN is claimed
DATABASE_URL=… node scripts/check-schema-drift.mjs
cd ../.. && node scripts/ci/security.mjs
```

Read `Suites failed` separately from `Tests passed`.

- [ ] **Step 3: Two fresh-DB deep runs** — as revision 1 (`cath-lab-readiness.deep|cath-reporting.deep|lab-signoff-safety.deep|bloodborne-markers.deep`); both green with identical counts; record the counts and the EXPLAIN plan (Task 6 Step 10) for the PR body.

- [ ] **Step 4: The mutation list** (spec §12; apply → the named test red → revert; record each)

1. `computeCheckDecision`: delete `started &&` → the pre-start unit test and the REGIME PAIR's pre-start assertion red, only those.
2. Delete `!agedOnly` → `'post-start: age alone never retracts'` red.
3. `assertConsentDocumented`: `!== 'pass'` → `!READINESS_CLEAR_STATES.includes(…)` → consent-waived unit and deep red.
4. Move the consent assertion into `transitionCaseStatus` → pin red; procedure-log consent test red.
5. Delete `via === 'status'` from the reason guard → the procedure-log "no reason needed" test red.
6. Delete the reason blanking → canary liveness red (block, report JSON, report CSV).
7. Restore `AND actual_start_at IS NULL` → sign-off-after-start deep test red.
8. Collapse the day-list tri-state (`ELSE FALSE`) → the legacy-snapshot day-list deep assertion red.
9. `afterCaseStartMs` returns `false` → marker unit table and the late-action deep test red.
10. Delete `CASE_START_METADATA_KEYS` stripping → the reserved-key unit test red (`start_commands` included).
11. Register the report route after `/reports/:id` → the ADMIN route probe red.
12. A stray `UPDATE cath_lab_cases SET actual_start_at = NOW()` in another service → SQL-shape pin red **and** population pin red (ten sites); both caller counts green — the point.
13. Delete the `cancelled` refusal in `recordProcedureLog` → unit + deep red.
14. Make `reopenCaseTx` write `in_progress` → SQL-shape pin red on its exact list and the `readiness_pending` literal test red.
15. Drop `actual_end_at = NULL` from the reopen → deep red with 23514 (`cath_lab_cases_actual_time_check`) on the **next** start.
16. Restore `CASE_STATUSES` in `createCase` → the creation unit test, the route-level deep test **and** the INSERT pin red.
17. Delete the `=== 'cancelled'` short-circuit in `transitionCaseStatus` → the generic-status unit loop (`scheduled` → `INVALID_STATE_TRANSITION`), the generic-bypass deep test, and the order pin red.
18. Replace the explicit `!== 'cancelled'` in `reopenCaseTx` with the table check alone → the `scheduled` iteration of the reopen loop (unit + deep) red.
19. Let a draft log start the case (`START_LOG_STATUSES = ['draft','finalized']`) → the draft unit and deep tests red.
20. Do not increment `procedure_attempt` on reopen of a started attempt → the owner's point-4 deep test red (snapshot attempt 1; history; audit row).
21. Compare markers / regime / `isAfterCaseStart` against `actual_start_at` → the point-4 deep test red (labs held pre-attempt-2; `case_started` true while `readiness_pending`; markers true pre-start).
22. Await `refreshCaseLabReadiness` inside the start → the never-settling unit test red (the 2 s race wins).
23. Return `[]` instead of `null` for missing item rows → the unknown-picture unit test red and the report legacy-row test red.
24. `cause === 'aged_out'` → `state === 'stale'` → the policy-change and future-dated tests red; the repeat-order-open test red the other way.
25. Drop the attempt from the command binding → the point-7 deep test red (attempt 2 started by command A).
26. Say "Consent obtained" for `emergency_basis` → the Staff caption test red.
27. Transform the column instead of the bounds in the report predicate → the SQL-text unit test red **and** the EXPLAIN gate fails (seq scan).
28. Remove `logAudit` from the governance mount registration → the report audit deep test red (one row where two are expected).
29. Skip the consent/time-out reset on reopen → the attempt-2 `CATH_LAB_CONSENT_REQUIRED` assertion red.
30. Persist no `unavailability_cause` → the two-refresh stability assertion red.
31. Splice the table name into `startCaseTx`'s UPDATE through `${…}` → the population pin red (eight UPDATE sites, not nine) **and** the SQL-shape pin red (three lines, not four) — the drift an exact-list assertion catches and a subset check cannot.

- [ ] **Step 5: Staff and Admin gates**

```bash
cd apps/staff && flutter analyze && flutter test test/features/cath_lab test/i18n_guard_test.dart
cd ../admin && npm run lint && npx jest src/__tests__/dashboard/quality
```

- [ ] **Step 6: Canary snapshot diff** — `git diff github/main -- apps/backend/src/tests/fixtures/serologyDisclosureCanary.reachable.json` shows exactly the two report entries (the reopen route is a POST and adds none).

- [ ] **Step 7: `[full-ci]` and the draft PR**

```bash
git commit --allow-empty -m "chore(ci): [full-ci] cath readiness never restricts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u github feat/cath-readiness-never-restricts
gh pr create --repo Bahuleyandr/VH-Health-Platform --draft --base main --head feat/cath-readiness-never-restricts \
  --title "feat(cath): the pre-cath readiness checklist informs and records, never restricts (owner decisions 2026-09-06, revision 2)" \
  --body-file "$SCRATCH/rr-pr-body.md"
```

The PR body states: the spec path and revision; the owner principle verbatim and the five decisions; **migration NNN** (what it adds, why revision 1's "no migration" was withdrawn — the owner's point 4 — the four CHECKs, the number re-checked at push time); the hard block = the documented authority to proceed, in `assertConsentDocumented` reached only through `startCaseTx`, with the pin's four families (callers, SQL shapes, `SET status =` list, **write-site population** 9 + 2); `CREATABLE_STATUSES` and the route-level proof that creation cannot manufacture a running case; the exhaustive procedure-log table in one line per row; the door: cancelled-only, generic `/status` refuses everything on a cancelled case, attempt N+1 with consent/time-out reset and history, `actual_start_at` preserved; the command id bound to the attempt and the replay sequence proved; the non-blocking start (last committed picture, refresh after commit, never-settling test); the regime by cause with the repeat-order case; the three markers and what `received_after_start` does **not** claim; consent authority/mode and the tenant policy (emergency basis never rendered as consent); the time-out's two instants and the three outcomes; the report: identifiable, start events with attempt id, facility scope default (tenant-wide by precedent — the one owner confirmation, §10.2), `logAudit` on both mounts, the bounds predicate with the pasted EXPLAIN plan; the four free-text fields and their sentinels incl. CSV; Survey C's finding on the timeline reader; the reader survey for `cancelled`; the deep counts from both fresh-DB runs; the canary diff (two entries); OpenAPI regeneration; Staff strings pending OPEN-21 (40 keys); `Merge Gate` / `Full Merge Gate` by name with the head SHA **from the tier-verifying poller** once the canonical run lands (not `gh run watch`). **Open items: one owner confirmation with a decided default (report scope), nothing blocking.** End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Hand back to dev-1b.

- [ ] **Step 8: Drop the scratch DBs** — `dropdb -h 127.0.0.1 -p 55432 vh_crr_<initials>` (and `_1`, `_2`).

---

## Self-review against the spec (revision 2)

- **§0 / owner point 1** — `CREATABLE_STATUSES` (Task 3 Step 3), `createCase` refusal before any read (Step 9), the creation route's validation, the INSERT pin, the **population pin** (Step 11), the route-level deep test + 23514 (Task 4 Step 8), migration NNN's `cath_lab_cases_in_progress_attempt_check` (Task 1); mutations 16, 31.
- **Point 2a** — the `=== 'cancelled'` short-circuit before `validateCaseTransition` (Task 3 Step 7), the unit loop over every target, the generic-bypass deep test, the order pin; mutation 17.
- **Point 2b** — the explicit precondition and the parameter `reason` (Task 3 Step 6), the reopen loop over every non-cancelled status incl. `scheduled` (unit + deep); mutation 18.
- **Point 3** — the exhaustive table with `requested` / unexpected refused before the insert and **a draft never starts** (`START_LOG_STATUSES`, Task 3 Step 8), the unit cells and the deep twin; mutation 19.
- **Point 4** — migration NNN (Task 1); `attempt_started_at` as the discriminator everywhere (Task 2 Step 3, Task 4 Steps 3–4, Task 7 models), `actual_start_at` preserved (Task 3 Step 5's `COALESCE`, Step 6's UPDATE never naming it), attempt N+1 with history and `ATTEMPT_RESET_CHECKS` (Step 6), the owner's point-4 deep test (Task 4 Step 8), the report's attempt id (Task 6); mutations 20, 21, 29.
- **Point 5** — `labsPictureForStartTx` on the stored rows (Task 3 Step 5), `scheduleReadinessRefresh` by the **caller after commit** (Steps 7–8), `readiness_picture_at` / `lab_component_status`, `missing_lab_items: null` never `[]` (Task 2 Step 15), the never-settling unit test (Task 3 Step 1); mutations 22, 23.
- **Point 6** — `classifyUnavailability` with the full precedence table and persistence (Task 2 Steps 5–7, Task 4 Step 4), `agedOnly` on the cause (Task 2 Step 3), the repeat-order-open, policy-change, future-dated, unparseable, withdrawn and stability tests; mutations 2, 24, 30.
- **Point 7** — `normalizeCommandId`, `start_commands[]` bound to the attempt, the three outcomes (Task 3 Step 5), the point-7 deep test, `IdempotencyKey.generate()` once per confirmation in Staff (Task 7); reopen key per user decision through `IdempotencyAttempt`; mutation 25.
- **Point 8** — `CONSENT_AUTHORITIES` / `CONSENT_MODES` (Task 2), the check-write validation against `consentPolicyFor` (Task 3 Step 4), `consent_authority` on the snapshot and the report, Staff choosers and the caption that never says "consent" for `emergency_basis` (Task 7); time-out `performed_at` required, `completed_at` server-stamped, `timeoutTiming`, `timeout_outcome` in the report, the Staff chip wording; the Start definition line; mutation 26.
- **Live updates** — `staff:lab` subscription with debounce, `RealtimeStatusBanner` watching it, picture-as-of + paused, the end-to-end widget test (Task 7 Steps 4–5).
- **`received_after_start`** — renamed, receipt-only, `finalised_after_start` beside it, the received-before/signed-after unit case (Task 2 Step 9), the overlay descriptions (Task 5 Step 4).
- **Report** — identifiable header, facility scope default with the `facility_id` filter, `logAudit` awaited on both mounts with `format`, the bounds-converted predicate pinned by text and by EXPLAIN, `start_event_id` + `procedure_attempt`, `distinct_cases`, the tri-state / legacy-row handling (Task 6); mutations 11, 27, 28.
- **Free text** — the four fields, three sentinels, CSV bodies read as text, the history never on a read surface, the write mirror, Survey C's verdict on the timeline reader (Task 0 Step 9, Task 5 Step 5); mutation 6.
- **Error codes** — `CASE_LIFECYCLE_ERROR_CODES` and the bidirectional scan (Task 5 Step 4, Task 6 Step 7); the base-tree scan in Task 0 Step 10.
- **Baseline** — `github/main` `5857298dc`, #1018 KEPT branch confirmed in Task 0 Step 2, the ledger re-run in Step 3.
- **Type consistency** — `startCaseTx(tx, { tenantId, cathCase, reason, via, commandId, procedureLogId, context })` → `{ updated, snapshot, replayed }` from both callers; `reopenCaseTx(tx, { tenantId, cathCase, reason, context })` → `{ updated, procedureAttempt, checksReset }` with one caller (`reopenCase`); `assertConsentDocumented(db, tenantId, caseId)` → `{ gate, checks, consent }`; `labsPictureForStartTx(tx, tenantId, caseId, checks)` → `{ missing, picture_at, lab_component_status }`; `classifyUnavailability({ previous, resolved, results, settings, windowDays, asOf })`; `computeCheckDecision({ items, settings, check, caseRow })` reading `caseRow.attempt_started_at` and `item.unavailability_cause`; `buildStartSnapshot` / `START_SNAPSHOT_KEYS` (12) the same names in the rules module, the service, the overlay, the report and the tests; `timeoutTiming({ performedAt, documentedAt, attemptStartedAt })`; `startsWithPendingReport({ tenantId, month, facilityId })`, `projectReportForRole`, `reportToCsv` used identically by the handler, the unit test and the deep test; Staff `startCase(int, {required String commandId, String? reason})` and `reopenCase(int, {required String reason, required String idempotencyKey})` match `CathReadinessDependencies`.
