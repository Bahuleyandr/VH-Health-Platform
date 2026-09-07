# Cath Readiness Never Restricts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pre-cath readiness checklist inform and record instead of restrict: any `scheduled` / `readiness_pending` / `ready` case may start with checks pending (the documented authority to proceed — consent — is the one hard block), the checklist keeps living after start with lateness marked, a cancelled case has an audited door back, and a monthly report of starts-with-pending exists — per the owner decisions of 2026-09-06, as corrected by the owner's review of the same day.

**Architecture (revision 4):** One `startCaseTx` remains behind both start paths, but replay dispatch precedes ordinary transition validation and binds each Start command to a canonical request fingerprint. A server-issued `lifecycle_token` fences Start, consent, time-out and procedure-log writes and rotates on cancel/reopen; a never-started reopen rebinds the retained attempt evidence to the new server token without changing the attempt. Every lifecycle artifact receives a server-derived attempt envelope. Attempt history lives in an attempt-keyed server-owned table, and procedure logs carry attempt/token provenance. Clinical start time is nullable and separate from server recording time; one bound database clock value feeds the case projection, snapshot and event. Lab refresh resolves evidence outside the case-row critical section and publishes in a brief generation-checked transaction; Staff loads cached readiness without awaiting refresh. Age-only suppression requires exact canonical evidence and policy fingerprints. Consent has authority-conditional evidence and no fictitious emergency communication mode. Report joins are attempt-keyed, separates at-start/follow-up and clinical/recording times, and access auditing is explicit-tenant and fail-closed. Migration NNN is deployed only after class-specific, evidence-backed remediation, old-writer quiescence, classified backfill and enforcement with rollback points.

**Tech Stack:** Node 26 ESM backend (Express 5, Prisma raw SQL on Postgres 17, jest with `--experimental-vm-modules`), Flutter Staff app, Next.js Admin console, OpenAPI overlay scripts.

**Spec:** `docs/superpowers/specs/2026-09-06-cath-readiness-never-restricts-design.md` — **revision 4 (2026-09-07)**. Read it first; revision-4 §0 and the six controls below govern wherever an older retained snippet conflicts.

**Revision-2/3 baseline retained.** Revision 2 rebuilt revision 1 around first-start history, active attempts, non-blocking readiness and event-based reporting. Revision 3 added reachable replay, lifecycle tokens, lock separation, attempt records, fingerprints, conditional consent and staged migration. Revision 4 supersedes any older snippet that conflicts with the following decisive evidence controls.

### Revision-4 decisive acceptance tests

Exactly one named acceptance test anchors each owner bullet. “Exactly” is enforced by running the mutation command with `--runInBand -t '^<full test name>$'`; only that selected test executes, it must fail, and the mutation is reverted before the next control. The normal full unit/deep gates then run with unmodified code.

| ID / exact test name | Fixture and steps | Required outcome | Isolated mutation |
|---|---|---|---|
| **R4-1** `R4-1 replay and delayed first delivery are fenced on both start entry points` (`cath-lab-readiness.deep.test.js`) | Use separate cases for: successful status Start with lost response and identical retry; successful finalized-log Start with identical log/start retry; Start prepared under token A then first delivered after start→cancel(token B)→reopen attempt 2(token C); and Start prepared under token D then first delivered after never-started cancel(token E)→reopen same attempt(token F). Exercise stale first delivery through both `/status` and `/procedure-logs`; assert A/B/C and D/E/F are pairwise distinct, with same-attempt evidence rebound D→E on cancel and E→F on reopen. | Identical retries return the immutable original Start/log result with `replayed: true`, no extra attempt/event/audit/log. Every old-token first delivery returns 409 before any write. A fresh command/token can start the reopened lifecycle. | Omit the never-started cancellation rebind; run only exact R4-1; its D/E evidence-attribution assertion fails. |
| **R4-2** `R4-2 lifecycle and readiness evidence remain attributable after reopen and metadata replacement` (`cath-lab-readiness.deep.test.js`) | Drive every reachable pre-start transition, then attempt 1: governed consent + time-out, Start, procedure log, cancel. Reopen to attempt 2; deliver attempt-1 consent late; document attempt-2 time-out/finalized log (which starts attempt 2); replace the current readiness metadata projection; complete. Read attempt records, procedure logs and every lifecycle audit/canonical event emitted by the fixture. | Late consent is stale. Attempt 1 bytes/evidence refs remain unchanged; attempt-2 time-out exists only on attempt 2. Projection replacement cannot erase either archive. Every queried lifecycle event and log carries server-derived correct attempt/token, with both token sides on cancel/reopen. | Remove attempt/token from the attempt-record UPDATE predicate; run only exact R4-2; the attempt-1 immutability assertion fails. |
| **R4-3** `R4-3 a paused lab-evidence resolution cannot block Start or cached Staff load` (`cath-lab-readiness.deep.test.js`) | First, hold the resolver promise open and call the cached Staff GET. Separately check out exactly two pool connections: A locks the deciding `lab_results` row during resolution and pauses before publish; `pg_locks` confirms A has no case-row lock; B executes the valid Start transaction while A remains paused. | Cached GET returns the last committed picture/Start affordance without invoking resolution; B commits Start within 2 s; A's later publish detects token/generation drift and discards/re-resolves; no stale overwrite. No assertion promises refresh completion within a tick. | Move `FOR NO KEY UPDATE` before evidence resolution; run only exact R4-3; the Start deadline loses while A remains paused. |
| **R4-4** `R4-4 same-row correction breaks aged_out carry without misclassifying bootstrap or absence` (`cath-lab-readiness.deep.test.js`) | Accept row R, age it out and persist `aged_out`; UPDATE the same R id's timestamp/status/`updated_at`; then separately correct its timestamp backward beyond the window, hide it only from bounded lookback, and seed a migrated item with `previous.window_days = null`. | Fingerprint changes on the same-id update and age-only carry stops; backward correction is `corrected`; lookback exclusion is internal `not_observed`, never `withdrawn`; first post-migration refresh is bootstrap, never `policy_changed`. | Carry `aged_out` on matching row id without comparing the canonical evidence fingerprint; run only exact R4-4; the same-row correction assertion fails. |
| **R4-5** `R4-5 report history is attempt-scoped and preserves unknown and both clocks` (`cath-lab-readiness.deep.test.js`) | Attempt 1 starts with checks pending through a retrospective finalized log with no evidenced clinical start and no time-out documentation. Cancel/reopen; attempt 2 records performed time-out and starts. Query report before/after attempt-2 documentation. Seed a second event with explicit attested non-performance. | Attempt 1 remains `not_documented`, `clinical_started_at: null`, with distinct `start_recorded_at`; attempt 2 alone shows its performed follow-up; at-start and follow-up fields remain separate. Only the explicit attestation maps to `not_performed`. | Join the mutable current check by case; run only exact R4-5; attempt-1/unknown assertions fail. |
| **R4-6** `R4-6 migration refuses unresolved legacy contradictions and preserves only evidenced history` (`cath-lab-case-attempts-migration.deep.test.js`) | Create an isolated database at NNN-1; seed every §8.1 issue class plus one valid legacy started row. Run the read-only classifier. Attempt NNN with unresolved rows; then recreate, apply row-hash-bound approved fixture dispositions, rerun preflight, quiesce the test writer and apply NNN. | First run aborts before expansion and leaves no NNN columns/tracker row. Successful run has zero unresolved rows; valid legacy `actual_start_at` becomes only recording time, clinical time stays null with `legacy_recording_only`; an evidenced reopened pre-start row retains first-start history but active recording stays null; no produced timestamp equals a seeded `created_at` unless independently evidenced. CHECK allows a scheduled no-consent row but rejects a running row without recording time/null end. | Backfill missing start from `created_at` and bypass unresolved-row abort; run only exact R4-6; rollback/no-invented-time assertions fail. |

### Revision-3 task map retained

| Owner review item | Controlling plan work |
|---|---|
| 1. Reachable replay and a server lifecycle fence | Task 3 dispatches Start replay before ordinary transition validation, uses distinct Start/log command identities, and fences Start, consent, time-out and procedure logs with a server-issued `lifecycle_token`; Task 4 proves delayed first delivery cannot affect a reopened lifecycle. |
| 2. Lock-independent refresh | Task 3 resolves lab evidence outside the case lock and publishes under a short generation-checked transaction; Task 7 makes Staff render cached readiness immediately; Task 4 uses two database connections to prove Start is not blocked by refresh resolution. |
| 3. Attempt history end to end | Task 1 creates server-owned attempt records and log provenance; Task 3 writes them transactionally; Task 6 reports by attempt; Task 4 covers attempt 1, cancel/reopen, attempt 2 and later amendment. |
| 4. Time-out and clocks | Tasks 2–3 distinguish `not_documented` / `performance_unknown` from explicit `not_performed`, preserve clinical occurrence separately from recording, and reuse one database recording timestamp for projection, snapshot and event; Task 6 reports the distinction. |
| 5. Age-only fingerprint | Task 2 defines evidence and policy fingerprints plus an independently retained accepted decision; Task 4 covers corrections, withdrawals, bounded-lookback absence and bootstrap. |
| 6. Conditional consent | Tasks 2–3 require evidence/scope only when the authority needs it, disallow a fictitious emergency mode, and make provenance server-owned; Task 7 mirrors the conditional form. Clinical/legal approval remains a release condition. |
| 7. Migration rollout | Tasks 0–1 inventory inconsistent rows and every writer, then expand/backfill/enforce only after old-writer quiescence; Task 9 defines rollback gates. The SQL CHECK enforces timestamp shape, not consent authority. |
| Further: active-attempt end invariant | Tasks 1, 4 and 9 require `in_progress ⇒ actual_end_at IS NULL`; mutation 15 directly asserts the final row rather than comparing against first-start history. |
| Further: audit tenant binding | Task 6 replaces best-effort `logAudit` with an explicit-tenant, fail-closed report-access insert and tests a non-default tenant plus forced failure. |
| Further: realtime path | Tasks 4 and 7 test sign-off commit → publish commit → emission → delivery → reload, plus reconnect, 2-second maximum wait and stale response suppression. |
| Further: EXPLAIN criteria | Task 6 uses a representative 100,000-row, 1–5%-selectivity fixture and bounded block/temp-I/O criteria without requiring a fixed node type. |
| Further: new-writer pin | Tasks 3–4 and 9 test synthetic parameterized-SQL and ORM writers and assert the known 9 UPDATE + 2 INSERT post-lane population. |
| Further: privacy survey | Tasks 0, 5 and 9 make the complete timeline, nested-payload and export reader survey a release condition with reachable-role tests. |
| Further: PR migration claim | Tasks 0, 1 and 9 require the PR description to name NNN as the next free migration above 767 and never claim 767. |

**One release approval remains intentionally external.** The design records the owner-decided procedure-start meaning and new-attempt reconfirmation rules. Clinical/legal owners must approve the authority-conditional consent evidence policy before deployment; implementation does not invent that policy. `CATH_LAB_INCHARGE` report scope remains tenant-wide by the day-list precedent.

---


> **Migration number.** `NNN` = the next free migration number ABOVE 767 at push time (768 unless claimed). **767 is NOT this lane's:** it is reserved by the merge-authority session's Phase 1 isolation-derivation lane (dev-1b). Task 0 must re-check the free number when the branch is pushed; any lane that claims a number it does not own collides with the immutability gate.

## Conventions

All of Plan 3's conventions apply (tenant transactions, raw SQL, `AppError`, npm-run jest, immutable migrations, scratch DB, commit trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`, `[full-ci]` on the last commit, draft PR, no merge — merge authority is dev-1b). Plus:

- **Verified code reference is current `github/main` at `3d091a510bc5214ddc251cd4106ca967e36c7340` (or a newer fetched head at implementation time).** The cath functions named by this plan are unchanged from revision 3's reference. Task 0 re-verifies every named function before editing.
- **Cite by function name.** Line numbers are illustrative; grep the function.
- **Every operational "started" read uses the ACTIVE attempt's server recording instant:** `attempt_start_recorded_at` (and its epoch twin), never `actual_start_at`. `attempt_started_at` is nullable clinical occurrence; `actual_start_at` is the first server-recorded start and is never rewritten.
- **Post-start suppression is decided only by a matching accepted evidence-and-policy fingerprint whose classified cause is `aged_out`, never by `state === 'stale'`.** Bootstrap and bounded-lookback absence are not policy change or withdrawal.
- **Never widen the picture with a value.** New payload keys are booleans, codes, causes, enums or instants. There are exactly **five** free-text fields (spec §6.5), including emergency-basis justification; each has an explicit reader matrix, projection and sentinel.
- **migration NNN is claimed.** Reserve it in Task 1, re-check before the first push (Task 9), `NNN = max(highest number on any github/* branch, 767) + 1` - never 767 (reserved for the Phase 1 lane even before its file exists); never edit a migration after it is on a remote (add a new number instead).
- **Fixtures with `<col>_at` carry `<col>_at_epoch_ms`** (`epochTwinFixtureFidelity.test.js`), derived from the same instant.
- **Every new error code** in the `CATH_LAB_(CONSENT|TIMEOUT|START|LIFECYCLE|PROCEDURE_LOG|CASE_STATUS|CASE_CANCELLED|CASE_START|REOPEN|REPORT)_*` family must be in `CASE_LIFECYCLE_ERROR_CODES` (Task 5) — the scan is bidirectional, so an undocumented code and a documented-but-unraised code both fail.
- **No `git stash`, no `git restore`; commit with pathspecs.**
- Backend commands run from `apps/backend`; `npm test -- --testPathPatterns <pattern>`; deep suites need `DATABASE_URL`. Read `Suites failed` separately from `Tests passed` — `Suites failed` with `Tests passed` is a hook failure, not a pass.

---

## File structure

| File | Responsibility |
|---|---|
| Create `apps/backend/src/migrations/NNN_cath_lab_case_attempts.sql` | Expand with lifecycle/recording/provenance columns, attempt-keyed readiness history, procedure-log attempt/token/idempotency columns and evidence/policy fingerprints; classify legacy data, backfill without inventing clinical occurrence, then enforce only after old-writer quiescence. |
| Modify `apps/backend/prisma/schema.prisma` | Mirror every migration-NNN column/table after the enforced phase (schema-drift gate). |
| Modify `apps/backend/src/services/clinical/cathLabReadinessRules.js` | Key operational timing on `attempt_start_recorded_at`; preserve nullable clinical occurrence; classify `not_documented`, `performance_unknown` and explicit `not_performed`; retain accepted evidence/policy fingerprints independently from the live observation. |
| Modify `apps/backend/src/services/clinical/cathLabService.js` | Reachable replay before transition validation; server-issued lifecycle fencing; one bound recording clock; authority-conditional consent; attempt-history writes; cancelled-only token-rotating reopen; exhaustive attempt-aware procedure logs with a separate log command identity. |
| Modify `apps/backend/src/services/clinical/cathLabReadinessService.js` | Resolve lab evidence outside the case lock, then validate generation/token and publish in a short transaction; persist live and accepted fingerprints separately; expose a cached read that never awaits refresh. |
| Modify `apps/backend/src/services/clinical/cathLabReadinessActions.js` | Lift the two refusals; STAT after start; use the active attempt's server recording instant; fence consent/time-out writes by lifecycle token and record clinical occurrence separately. |
| Modify `apps/backend/src/services/clinical/cathLabReadinessProjection.js` | Blank `readiness_at_start.reason` for non-entitled roles; export `projectStartReasonForRole`. |
| Create `apps/backend/src/services/clinical/cathStartsWithPendingReportService.js` | Month + facility validation; event-to-attempt join; time-out clinical/recording outcomes; representative bounded-work EXPLAIN criteria; per-facility fold, CSV and projection. |
| Create `apps/backend/src/routes/clinical/cathStartsWithPendingReportHandler.js` | One handler on both mounts; explicit tenant-bound report-access audit that is awaited and fail-closed before response. |
| Modify `apps/backend/src/routes/clinical/cathLabRoutes.js`, `cathReprocessingPolicyRoutes.js` | Report route (before `/reports/:id` on the cath router); `POST /cases/:id/reopen` (cath router only); creation route validates `status` against `CREATABLE_STATUSES`. |
| Modify `apps/backend/src/utils/roleHelpers.js` | `CATH_READINESS_REPORT_ROLES`, `canReadCathReadinessReport`. |
| Modify `apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs` | `CathLabCase` +2 columns; item +3 booleans + cause; readiness keys; snapshot schema; report schemas/operations (+ `facility_id`); prose-only status / procedure-log / reopen / creation notes; `CASE_LIFECYCLE_ERROR_CODES`; decision-9 edits. |
| Create `apps/backend/src/tests/unit/cathLabStartPathPin.test.js` | Caller pins, SQL-shape pin, `SET status =` list, **write-site population pin**, door pins, short-circuit order, absent old names. |
| Create `apps/backend/src/tests/unit/cathStartsWithPendingReportService.test.js` | Report unit tests (incl. the bounds literal). |
| Modify unit tests: `cathLabService.test.js`, `cathLabReadinessService.test.js`, `cathLabReadinessServiceOrders.test.js`, `cathLabReadinessOpenApiSource.test.js`, `cathLabReadinessProjection.test.js`, `serologyDisclosureCanary.test.js` (+ `fixtures/serologyDisclosureCanary.reachable.json`), the roleHelpers test, `cathLabRouteGuards.test.js` (report probes only — decision 9 is KEPT) | Per task. |
| Modify `apps/backend/src/tests/cath-lab-readiness.deep.test.js` | Deep coverage, case-parameterised helpers. |
| Create `apps/backend/src/tests/cath-lab-case-attempts-migration.deep.test.js` | R4-6 isolated NNN-1 preflight/rollback/remediation/backfill proof. |
| Staff: modify `features/cath_lab/models/cath_readiness_models.dart`, `services/cath_lab_api_service.dart`, `widgets/cath_readiness_checklist.dart`, `widgets/cath_lab_readiness_panel.dart`, `screens/cath_lab_screen.dart`, `l10n/app_strings.dart`; tests `test/features/cath_lab/cath_readiness_checklist_test.dart`, `cath_lab_screen_test.dart`, `test/i18n_guard_test.dart` | Cached-first loading; lifecycle-token commands; conditional consent evidence; clinical and recording time labels; commit-to-delivery realtime with reconnect, maximum wait and stale-generation guards. |
| Admin: create `dashboard/quality/cath/components/StartsWithPendingTab.tsx`, `__tests__/dashboard/quality/cath-starts-with-pending.test.tsx`; modify `lib/api/cathDevices.ts`, `dashboard/quality/cath/page.tsx` | Report tab with facility filter, breakdowns, identifiability header, CSV. |

---

## Task 0: Branch, worktree, baseline confirmation, the three surveys

**Files:** none (verification only).

- [ ] **Step 1: Cut the branch from `github/main` in a scratchpad worktree**

```bash
cd "/d/Dev/Projects/VH Health/VH-Health-Platform"
git fetch github '+refs/heads/*:refs/remotes/github/*'
git rev-parse github/main            # db30fe80… or later; record the fetched SHA in the PR body
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

Known at fetched `github/main` `3d091a510`: `recordCanonicalClinicalEvent` writes `visible_to_patient` **only** when the input says `true`, and `writeCanonicalEvent` never sets it. The complete direct production caller search for `readCanonicalPatientTimeline` finds exactly four sites: `emr/clinicalTimelineRoutes.js` and `patient/patientSearchRoutes.js` behind `patientAccessGuard`; `handoverService.generateHandoverDraft`, reached by the route guarded with `guardClinicalPatientView`; and `clinicalNotesService.getPatientTimeline`, reached by the route guarded with `guardClinicalNoteView`. Re-run the route/function search at implementation time, record every nested projection/copy/CSV/notification consumer, and fail the release survey if the measured caller set differs without a reviewed projection decision. For each reachable role, prove `payload.reason`, `payload.readiness_at_start.reason`, emergency justification, evidence references and provenance are absent unless `roleSeesSerologyDetail` (or the narrower approved predicate) admits them. Cath events remain `visible_to_patient = false`, but that writer flag is not a substitute for surveying readers. Survey evidence and sentinel tests are a release condition, not a best-effort note.

- [ ] **Step 10: The lifecycle error-code scan on the base tree**

```bash
grep -rnoE "'CATH_LAB_(CONSENT|TIMEOUT|START|CASE_STATUS|CASE_CANCELLED|CASE_START|REOPEN|REPORT)_[A-Z_]+'" apps/backend/src/services/clinical/cathLabService.js apps/backend/src/services/clinical/cathLabReadinessRules.js apps/backend/src/routes/clinical/cathLabRoutes.js || echo "zero matches on the base tree (expected)"
```

Expected: zero (the existing `CATH_LAB_CASE_*` codes are `_NOT_FOUND`, `_ENCOUNTER_INVALID`, `_FACILITY_*`, which the alternation does not match). Any match is reconciled by name in Task 5 before the bidirectional scan is written.

---

## Task 1: migration NNN — lifecycle, attempt evidence, fingerprints and staged enforcement

**Files:**
- Create: `apps/backend/src/migrations/NNN_cath_lab_case_attempts.sql`
- Modify: `apps/backend/prisma/schema.prisma` (all three affected models plus `cath_procedure_logs`)

> **Rollout invariant** (spec §8.1, §13): do not run NNN until the preflight inventory has classified every inconsistent `in_progress` row and all old writers are quiesced. The migration's order is expand → classified backfill → enforce. It never derives clinical occurrence from `created_at` or `actual_start_at`, and its CHECKs enforce timestamp/end-field shape only—not consent or route use.

- [ ] **Step 1: Reserve the number — and plan to re-check it at push time**

```bash
cd "$SCRATCH/wt/rr-impl"
git fetch github '+refs/heads/*:refs/remotes/github/*'
for ref in $(git for-each-ref --format='%(refname)' refs/remotes/github/); do
  git ls-tree --name-only "$ref" apps/backend/src/migrations/ 2>/dev/null
done | sed -E 's#.*/([0-9]+)_.*#\1#' | sort -n | uniq | tail -2
```

Expected tail: `765`, `766` (re-checked 2026-09-07 over the seven `github/*` branches). `NNN` is never 767 (reserved for the Phase 1 lane); if `NNN` appears on any branch, take the next free number above it **now** and use it everywhere below; if it appears between now and the first push (Task 9 re-runs this), renumber **before** pushing, never after — the immutability gate pins a file by name once it is on a remote.

- [ ] **Step 2: Write the migration** (spec §8.1, verbatim — the CHECK names are cited by the deep tests and the OpenAPI pin)

Write `NNN_cath_lab_case_attempts.sql` exactly as spec §8.1, including: case lifecycle/recording/provenance/generation columns; legacy recording-only backfill; procedure-log attempt/token/log-command columns and partial uniqueness; `cath_lab_attempt_readiness_records` with its complete consent/time-out backfill; enable/force RLS plus `tenant_isolation`; lifecycle shape constraints; readiness cause/evidence/policy/last-accepted fields; and log-column enforcement. Copy the complete SQL block, not a prose placeholder, and compare the two fenced blocks byte-for-byte in the docs self-review.

```sql
-- NNN_cath_lab_case_attempts.sql — spec 2026-09-06 revision 4.
-- PRECONDITION: the classified inventory in §13 returned zero unresolved rows,
-- every changed production-like row has a signed row-hash-bound disposition,
-- and all old writers are quiesced. Do not invent start/clinical time from any
-- created_at, updated_at, log timestamp, end timestamp, or status.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM cath_lab_cases c
     WHERE (c.status = 'in_progress' AND c.actual_start_at IS NULL)
        OR (c.status = 'in_progress' AND c.actual_end_at IS NOT NULL)
        OR (c.actual_end_at IS NOT NULL AND (c.actual_start_at IS NULL OR c.actual_end_at < c.actual_start_at))
        OR (c.status IN ('completed','cancelled') AND c.actual_end_at IS NULL)
  ) OR EXISTS (
    SELECT 1
      FROM cath_procedure_logs l
      LEFT JOIN cath_lab_cases c ON c.tenant_id = l.tenant_id AND c.id = l.case_id
     WHERE c.id IS NULL
  ) THEN
    RAISE EXCEPTION 'NNN preflight failed: unresolved cath lifecycle contradiction or orphan procedure log';
  END IF;
END $$;

ALTER TABLE cath_lab_cases
  ADD COLUMN procedure_attempt INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN lifecycle_token UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN attempt_start_recorded_at TIMESTAMPTZ(6),
  ADD COLUMN attempt_started_at TIMESTAMPTZ(6),
  ADD COLUMN attempt_start_time_provenance VARCHAR(40),
  ADD COLUMN lab_readiness_generation BIGINT NOT NULL DEFAULT 0;

-- Existing actual_start_at is known only as historical first server-recording
-- time; it is not proof of clinical occurrence. A disposition-confirmed
-- reopened pre-start row retains that history but has no active-attempt clock.
UPDATE cath_lab_cases
   SET attempt_start_recorded_at = CASE
         WHEN status IN ('in_progress','completed','cancelled') THEN actual_start_at
         ELSE NULL
       END,
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

Before applying it, run this read-only preflight with tenant bypass and export its rows as rollout evidence. A row may correctly appear in more than one issue class; every emitted `(tenant_id, case_id, issue_class, row_hash)` needs its own disposition or remains unresolved:

```sql
WITH case_issues AS (
  SELECT c.*, 'RUNNING_WITHOUT_RECORDED_START'::text AS issue_class
    FROM cath_lab_cases c WHERE c.status = 'in_progress' AND c.actual_start_at IS NULL
  UNION ALL
  SELECT c.*, 'RUNNING_WITH_END' FROM cath_lab_cases c
   WHERE c.status = 'in_progress' AND c.actual_end_at IS NOT NULL
  UNION ALL
  SELECT c.*, 'PRESTART_WITH_FIRST_START' FROM cath_lab_cases c
   WHERE c.status IN ('requested','scheduled','readiness_pending','ready') AND c.actual_start_at IS NOT NULL
  UNION ALL
  SELECT c.*, 'END_WITHOUT_START_OR_BEFORE_START' FROM cath_lab_cases c
   WHERE c.actual_end_at IS NOT NULL AND (c.actual_start_at IS NULL OR c.actual_end_at < c.actual_start_at)
  UNION ALL
  SELECT c.*, 'TERMINAL_WITHOUT_END' FROM cath_lab_cases c
   WHERE c.status IN ('completed','cancelled') AND c.actual_end_at IS NULL
)
SELECT tenant_id, id AS case_id, issue_class, status, actual_start_at, actual_end_at, created_at, updated_at,
       md5(concat_ws('|', tenant_id::text, id::text, issue_class, status,
                     COALESCE(actual_start_at::text,''), COALESCE(actual_end_at::text,''), updated_at::text)) AS row_hash
  FROM case_issues
 ORDER BY tenant_id, id, issue_class;

SELECT tenant_id, status, count(*)
  FROM cath_lab_cases
 GROUP BY tenant_id, status
 ORDER BY tenant_id, status;

SELECT l.tenant_id, l.case_id, 'ORPHAN_PROCEDURE_LOG'::text AS issue_class,
       l.id AS procedure_log_id,
       md5(concat_ws('|', l.tenant_id::text, l.id::text, l.case_id::text,
                     l.status, COALESCE(l.started_at::text,''), l.updated_at::text)) AS row_hash
  FROM cath_procedure_logs l
  LEFT JOIN cath_lab_cases c ON c.tenant_id = l.tenant_id AND c.id = l.case_id
 WHERE c.id IS NULL
  ORDER BY l.tenant_id, l.id;

SELECT r.tenant_id, r.case_id, 'LEGACY_CONSENT_WITHOUT_STRUCTURE'::text AS issue_class,
       md5(concat_ws('|', r.tenant_id::text, r.case_id::text, r.status, r.updated_at::text)) AS row_hash,
       r.status, r.metadata,
       r.evidence_owner, r.source_name, r.source_version, r.attachment_ref
  FROM cath_lab_readiness_checks r
 WHERE r.check_type = 'consent' AND r.status = 'pass'
   AND jsonb_typeof(r.metadata->'consent') IS DISTINCT FROM 'object'
 ORDER BY r.tenant_id, r.case_id;
```

Join the exported inventory to the signed disposition manifest on all four keys. Enforce spec §8.1's class-specific allowed dispositions: no missing approval; no stale row hash; no unrecognized disposition; no correction without `evidence_ref`, `approved_by` and `approved_at`. Apply only those governed corrections, rerun the inventory, and require zero unresolved contradiction rows. `LEGACY_CONSENT_WITHOUT_STRUCTURE` is resolved only by the migration's server `legacy_pre_NNN` marker and never by synthesized authority. A dev/test fixture may be repaired only by its owning fixture script. No index is added until Task 6 demonstrates one from representative bounded-work evidence.

- [ ] **Step 2a: Write R4-6 as an isolated migration deep test**

Create `apps/backend/src/tests/cath-lab-case-attempts-migration.deep.test.js` with the exact test name `R4-6 migration refuses unresolved legacy contradictions and preserves only evidenced history`. Follow the repository's migration-upgrade test pattern: create a temporary database, apply migrations through NNN-1, and seed one row for each issue class with deliberately distinct `created_at`, `updated_at`, start and end instants, plus one valid legacy `in_progress` row with a non-null `actual_start_at`. Assert the classifier returns the seven class names and stable hashes. Run NNN without dispositions and assert the transaction/tracker entry is absent and `information_schema.columns` has no `lifecycle_token`. Recreate the database, apply fixture-owner dispositions matching spec §8.1, rerun to zero unresolved contradictions, mark the test writer quiesced, and apply NNN. Assert the valid running row has `attempt_start_recorded_at = old actual_start_at`, `attempt_started_at IS NULL`, provenance `legacy_recording_only`; the disposition-confirmed reopened pre-start row retains `actual_start_at` but has `attempt_start_recorded_at IS NULL`; no new start field equals any seeded case/log `created_at`, `updated_at` or end instant; legacy consent has only server provenance; a scheduled row without consent remains CHECK-valid; and raw `in_progress` without `attempt_start_recorded_at` or with `actual_end_at` fails `cath_lab_cases_in_progress_attempt_check`.

Focused mutation command (replace `NNN` with the reserved number):

```bash
npm test -- --runInBand --testPathPatterns cath-lab-case-attempts-migration.deep -t '^R4-6 migration refuses unresolved legacy contradictions and preserves only evidenced history$'
```

Temporarily make the migration fill a missing start from `created_at` and bypass the unresolved-row gate. The one selected test must fail its rollback/no-invented-time assertions; revert before continuing.

- [ ] **Step 3: `schema.prisma`**

Mirror every NNN column and the new attempt table in Prisma: `cath_lab_cases` gets `procedure_attempt`, server-owned `lifecycle_token`, `attempt_start_recorded_at`, nullable clinical `attempt_started_at`, `attempt_start_time_provenance`, and `lab_readiness_generation`; `cath_procedure_logs` gets `procedure_attempt`, `lifecycle_token`, and nullable legacy `log_command_id`; readiness items get the cause/window plus both fingerprints, `last_accepted_evidence`, and `classifier_initialized_at`. Keep existing CHECK documentation comments.

- [ ] **Step 4: Apply to the scratch DB and run the schema gates**

```bash
cd "$SCRATCH/wt/rr-impl/apps/backend"
npm run check:migration-numbers && npm run check:migration-immutability
DATABASE_URL="postgresql://…@127.0.0.1:55432/vh_crr_<initials>" npm run test:db:setup
DATABASE_URL="postgresql://…@127.0.0.1:55432/vh_crr_<initials>" node scripts/check-schema-drift.mjs
```

All green. Also run the preflight above, the explicit writer-population pin from Task 3, and a deployment probe proving the old application version has been quiesced before the migration begins. The immutability gate protects the file after first push; later corrections require another free number above NNN.

- [ ] **Step 5: Smoke lifecycle shape without pretending it enforces consent** (the deep tests in Task 4 make this permanent)

```bash
psql "$DATABASE_URL" -c "
  INSERT INTO cath_lab_cases (tenant_id, patient_uid, requested_procedure, status)
  VALUES ('00000000-0000-4000-8000-000000000001', gen_random_uuid(), 'probe', 'in_progress');"
# expect: ERROR 23514 ... violates check constraint "cath_lab_cases_in_progress_attempt_check"
psql "$DATABASE_URL" -c "UPDATE cath_lab_cases SET attempt_start_recorded_at = clock_timestamp() WHERE status = 'scheduled' AND id = (SELECT min(id) FROM cath_lab_cases WHERE status='scheduled');"
# expect: ERROR 23514 ... "cath_lab_cases_pre_start_attempt_check" (or 0 rows if no scheduled case exists — then skip)
```

Then create a scheduled case with no consent and confirm the row remains valid. This is intentional: application transaction logic, not the CHECK, enforces consent.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/migrations/NNN_cath_lab_case_attempts.sql apps/backend/prisma/schema.prisma
git commit -m "feat(cath): add lifecycle-fenced cath attempt history and readiness fingerprints

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 2: Pure rules — two clocks, fingerprinted age-only carry, snapshot, time-out outcomes and consent shapes (TDD)

**Files:**
- Modify: `apps/backend/src/services/clinical/cathLabReadinessRules.js`
- Modify: `apps/backend/src/services/clinical/cathLabReadinessService.js` (facade re-exports only)
- Test: `apps/backend/src/tests/unit/cathLabReadinessService.test.js`

Operational lateness in this task is keyed on **`caseRow.attempt_start_recorded_at`**. Nullable `attempt_started_at` is used only for claims about clinical occurrence. Age-only carry requires matching evidence and policy fingerprints attached to the independently retained last accepted decision; `unavailability_cause` or `state === 'stale'` alone is insufficient.

The controlling pure contracts are:

```js
export const TIMEOUT_OUTCOMES = Object.freeze([
  'not_documented',
  'performance_unknown',
  'performed_before_clinical_start',
  'performed_after_clinical_start',
  'not_performed',
]);

export function timeoutTiming({ outcome, performedAt, documentedAt, attemptStartedAt, attemptStartRecordedAt }) {
  if (outcome === 'not_performed') {
    return { timing: 'not_performed', documented_after_start: Boolean(attemptStartRecordedAt && documentedAt && Date.parse(documentedAt) > Date.parse(attemptStartRecordedAt)) };
  }
  if (outcome !== 'performed') {
    return { timing: documentedAt ? 'performance_unknown' : 'not_documented', documented_after_start: false };
  }
  if (!performedAt) return { timing: 'performance_unknown', documented_after_start: false };
  const clinical = attemptStartedAt ? Date.parse(attemptStartedAt) : NaN;
  const recorded = attemptStartRecordedAt ? Date.parse(attemptStartRecordedAt) : NaN;
  const performed = Date.parse(performedAt);
  const documented = documentedAt ? Date.parse(documentedAt) : NaN;
  if (!Number.isFinite(performed) || !Number.isFinite(clinical)) return { timing: 'performance_unknown', documented_after_start: Number.isFinite(recorded) && Number.isFinite(documented) && documented > recorded };
  if (Number.isFinite(clinical) && performed > clinical) {
    return { timing: 'performed_after_clinical_start', documented_after_start: Number.isFinite(recorded) && Number.isFinite(documented) && documented > recorded };
  }
  return {
    timing: 'performed_before_clinical_start',
    documented_after_start: Number.isFinite(recorded) && Number.isFinite(documented) && documented > recorded,
  };
}

export function canCarryAcceptedAgeDecision({ liveEvidenceFingerprint, livePolicyFingerprint, lastAcceptedEvidence }) {
  return Boolean(
    lastAcceptedEvidence?.classification === 'accepted'
    && lastAcceptedEvidence?.evidence_fingerprint === liveEvidenceFingerprint
    && lastAcceptedEvidence?.policy_fingerprint === livePolicyFingerprint,
  );
}
```

The classifier canonicalizes and SHA-256 hashes exactly `{ result_id, performed_at, received_at, external_reported_on, observed_instant, updated_at, status, signed_off_at, result_origin, performed_by_lab, external_report_ref }` and `{ item_code, required, effective_window_days, external_results_count, external_result_acceptance_policy_version }`, using spec §5.6's null/string/instant rules. A same-id correction, withdrawal, backwards timestamp/version, or policy change forces re-evaluation. A bounded-lookback miss is `not_observed`; it does not manufacture `withdrawn`. Initial population—including `previous.window_days IS NULL`—sets `classifier_initialized_at` and is `bootstrap`, never `policy_changed`.

- [ ] **Step 1: Write the failing regime tests for `computeCheckDecision`** (spec §5.2)

Append inside `describe('computeCheckDecision', …)`. Items now carry `unavailability_cause`; `missing[]` entries are `{ item, state, cause }`:

```js
  const agedHb = { item_code: 'hb', required: true, state: 'stale', unavailability_cause: 'aged_out' };
  const agedHbReordered = { item_code: 'hb', required: true, state: 'ordered_awaiting_sample', unavailability_cause: 'aged_out' };
  const policyHb = { item_code: 'hb', required: true, state: 'stale', unavailability_cause: 'policy_changed' };
  const futureHb = { item_code: 'hb', required: true, state: 'stale', unavailability_cause: 'future_dated' };
  const neverHcv = { item_code: 'hcv', required: true, state: 'not_ordered', unavailability_cause: null };
  const autoPass = { status: 'pass', metadata: { auto_managed: true } };
  const preStart = { attempt_start_recorded_at: null, attempt_started_at: null, actual_start_at: AS_OF.toISOString() };
  const postStart = { attempt_start_recorded_at: AS_OF.toISOString(), attempt_started_at: null, actual_start_at: AS_OF.toISOString() };

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
  const started = Boolean(caseRow?.attempt_start_recorded_at);
  let nextStatus = null;
  let autoPendingReason = null;
  // Spec 2026-09-06 §5.2 (decisions 7, 17, 19). BEFORE the ACTIVE attempt starts
  // Plan 3's rule stands in full: automation passes when every required item is
  // available and retracts a pass it made when one goes missing — by age
  // included. AFTER start, new evidence always applies (the pass branch is open
  // in both regimes; the critical flags are computed above regardless) but
  // AGEING ALONE never moves the check: the team acted on the value it had.
  // "Ageing alone" requires persisted cause plus evidence/policy fingerprints
  // equal to last_accepted_evidence. State or cause alone is insufficient.
  // Gated on attempt_start_recorded_at, not the nullable clinical instant or
  // historical actual_start_at.
  // Delete `started &&` → the pre-start test goes red. Replace
  // `cause === 'aged_out'` with `state === 'stale'` → the policy-change and
  // future-dated tests go red and the repeat-order test goes red the other way.
  const agedOnly = started && missing.length > 0 && missing.every((row) =>
    row.cause === 'aged_out' && canCarryAcceptedAgeDecision({
      liveEvidenceFingerprint: row.evidence_fingerprint,
      livePolicyFingerprint: row.policy_fingerprint,
      lastAcceptedEvidence: row.last_accepted_evidence,
    }));
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
  const accepted = (result = row(9, -1), extra = {}) => {
    const policy = policyFingerprintFor({ itemCode: 'hb', required: true, windowDays: 30, settings });
    const evidence = evidenceFingerprintFor(result);
    return {
      item_code: 'hb', required: true, state: 'result_final', lab_result_id: 9,
      source: 'lab', window_days: 30, unavailability_cause: null,
      classifier_initialized_at: AS_OF.toISOString(), evidence_fingerprint: evidence,
      policy_fingerprint: policy,
      last_accepted_evidence: { result_id: '9', canonical: canonicalEvidence(result), evidence_fingerprint: evidence, policy_fingerprint: policy, accepted_at: AS_OF.toISOString() },
      ...extra,
    };
  };
  const unavailable = (state, extra = {}) => ({ item_code: 'hb', required: true, state, lab_result_id: null, source: null, ...extra });

  const classify = ({ previous, resolved, deciding = null, direct = { kind: 'not_observed' }, settings: nextSettings = settings, windowDays = 30 }) => classifyUnavailability({
    previous, resolved, previousEvidenceLookup: direct,
    evidenceFingerprint: deciding ? evidenceFingerprintFor(deciding) : null,
    policyFingerprint: policyFingerprintFor({ itemCode: 'hb', required: resolved.required, windowDays, settings: nextSettings }),
    settings: nextSettings, windowDays, asOf: AS_OF,
  });
  test('available → null', () => { const r = row(9, -1); expect(classify({ previous: accepted(r), resolved: { ...accepted(r) }, deciding: r })).toBeNull(); });
  test('same accepted fingerprint crosses the window → aged_out', () => { const old = row(9, -45); expect(classify({ previous: accepted(old), resolved: unavailable('stale'), deciding: old, direct: { kind: 'found', row: old } })).toBe('aged_out'); });
  test('same accepted fingerprint with repeat order open → aged_out', () => { const old = row(9, -45); expect(classify({ previous: accepted(old), resolved: unavailable('ordered_awaiting_sample'), deciding: old, direct: { kind: 'found', row: old } })).toBe('aged_out'); });
  test('window narrowed 30 → 7 → policy_changed', () => { const r = row(9, -8); expect(classify({ previous: accepted(r), resolved: unavailable('stale'), deciding: r, direct: { kind: 'found', row: r }, windowDays: 7 })).toBe('policy_changed'); });
  test('required flips on after an initialized no-evidence state → policy_changed, not bootstrap', () => { const previous = { ...unavailable('not_ordered', { required: false }), classifier_initialized_at: AS_OF.toISOString(), window_days: 30, evidence_fingerprint: null, policy_fingerprint: policyFingerprintFor({ itemCode: 'hb', required: false, windowDays: 30, settings }), last_accepted_evidence: null }; expect(classify({ previous, resolved: unavailable('not_ordered', { required: true }) })).toBe('policy_changed'); });
  test('external acceptance policy changes → policy_changed', () => { const r = { ...row(9, -1), result_origin: 'external' }; const nextSettings = { ...settings, external_results_count: false, external_result_acceptance_policy_version: 'v2' }; expect(classify({ previous: accepted(r), resolved: unavailable('external_recorded'), deciding: r, direct: { kind: 'found', row: r }, settings: nextSettings })).toBe('policy_changed'); });
  test('same-id timestamp/status/version correction → corrected, never aged_out', () => { const before = row(9, -45); const corrected = { ...before, performed_at: daysAgo(60), performed_at_epoch_ms: epochAgo(60), updated_at: AS_OF.toISOString(), status: 'amended' }; expect(classify({ previous: accepted(before), resolved: unavailable('stale'), deciding: corrected, direct: { kind: 'found', row: corrected } })).toBe('corrected'); });
  test('same-id correction into the future → future_dated', () => { const before = row(9, -1); const corrected = row(9, +2); expect(classify({ previous: accepted(before), resolved: unavailable('stale'), deciding: corrected, direct: { kind: 'found', row: corrected } })).toBe('future_dated'); });
  test('same-id timestamp corrected into garbage → unparseable', () => { const before = row(9, -1); const corrected = { ...before, performed_at: 'not-a-date', performed_at_epoch_ms: null, updated_at: AS_OF.toISOString() }; expect(classify({ previous: accepted(before), resolved: unavailable('stale'), deciding: corrected, direct: { kind: 'found', row: corrected } })).toBe('unparseable'); });
  test('direct lookup confirms deciding row missing → withdrawn', () => { const before = row(9, -1); expect(classify({ previous: accepted(before), resolved: unavailable('not_ordered'), direct: { kind: 'confirmed_missing' } })).toBe('withdrawn'); });
  test('bounded-lookback absence alone → null, never withdrawn', () => { const before = row(9, -1); expect(classify({ previous: accepted(before), resolved: unavailable('not_ordered'), direct: { kind: 'not_observed' } })).toBeNull(); });
  test('an explicitly lifted waiver → withdrawn', () => { const previous = { ...unavailable('waived', { source: 'waiver' }), classifier_initialized_at: AS_OF.toISOString(), window_days: 30, evidence_fingerprint: null, policy_fingerprint: policyFingerprintFor({ itemCode: 'hb', required: true, windowDays: 30, settings }), last_accepted_evidence: null }; expect(classify({ previous, resolved: unavailable('not_ordered') })).toBe('withdrawn'); });
  test('window_days null migration row → bootstrap, never policy_changed', () => { const before = row(9, -1); expect(classify({ previous: accepted(before, { window_days: null }), resolved: unavailable('stale'), deciding: before, direct: { kind: 'found', row: before }, windowDays: 7 })).toBeNull(); });
  test('first population with a draw in flight → reordered', () => expect(classify({ previous: null, resolved: unavailable('ordered_awaiting_sample') })).toBe('reordered'));
  test('first population with nothing in flight → null', () => expect(classify({ previous: null, resolved: unavailable('not_ordered') })).toBeNull());
```

(`classify` = `classifyUnavailability` with `settings`, `windowDays: 30`, `asOf: AS_OF` defaulted; `row(id, offsetDays)` builds a final result row performed `offsetDays` from `AS_OF` with its epoch twin.)

- [ ] **Step 6: Run to verify they fail** — not exported.

- [ ] **Step 7: Implement `classifyUnavailability`**

```js
import crypto from 'node:crypto';

export const UNAVAILABILITY_CAUSES = Object.freeze([
  'aged_out', 'future_dated', 'unparseable', 'withdrawn', 'corrected', 'policy_changed', 'reordered',
]);

const iso = (value) => {
  const ms = toMs(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const normalized = (value) => value == null ? null : String(value).trim().toLowerCase();
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const sha256 = (value) => crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex');

export function canonicalEvidence(row) {
  return {
    external_report_ref: row?.external_report_ref == null ? null : String(row.external_report_ref).trim(),
    external_reported_on: row?.external_reported_on == null ? null : String(row.external_reported_on).slice(0, 10),
    observed_instant: iso(observedMs(row)),
    performed_at: iso(row?.performed_at_epoch_ms ?? row?.performed_at),
    performed_by_lab: normalized(row?.performed_by_lab),
    received_at: iso(row?.received_at_epoch_ms ?? row?.received_at),
    result_id: row?.id == null ? null : String(row.id),
    result_origin: normalized(row?.result_origin),
    signed_off_at: iso(row?.signed_off_at_epoch_ms ?? row?.signed_off_at),
    status: normalized(row?.status),
    updated_at: iso(row?.updated_at_epoch_ms ?? row?.updated_at),
  };
}
export const evidenceFingerprintFor = (row) => sha256(canonicalEvidence(row));
export const policyFingerprintFor = ({ itemCode, required, windowDays, settings }) => sha256({
  effective_window_days: Number(windowDays),
  external_result_acceptance_policy_version: settings?.external_result_acceptance_policy_version ?? null,
  external_results_count: settings?.external_results_count === true,
  item_code: String(itemCode),
  required: required !== false,
});

// previousEvidenceLookup is the direct lookup of last_accepted_evidence.result_id,
// independent of the bounded display query: { kind: 'found', row },
// { kind: 'confirmed_missing' }, or { kind: 'not_observed' }.
export function classifyUnavailability({ previous = null, resolved, previousEvidenceLookup = { kind: 'not_observed' }, evidenceFingerprint, policyFingerprint, settings, windowDays, asOf = new Date() }) {
  if (isItemAvailable(resolved, settings)) return null;
  const inFlight = ['ordered_awaiting_sample', 'sample_sent_awaiting_result'].includes(resolved.state);
  const bootstrap = !previous?.classifier_initialized_at || previous?.window_days == null
    || !previous?.policy_fingerprint
    || (previous?.last_accepted_evidence != null && !previous?.evidence_fingerprint);
  if (bootstrap) return inFlight ? 'reordered' : null;
  if (previous.policy_fingerprint !== policyFingerprint) return 'policy_changed';
  const accepted = previous.last_accepted_evidence;
  if (accepted?.result_id != null) {
    if (previousEvidenceLookup.kind === 'confirmed_missing') return 'withdrawn';
    if (previousEvidenceLookup.kind === 'found') {
      const row = previousEvidenceLookup.row;
      const status = normalized(row?.status);
      if (['cancelled', 'retracted', 'entered-in-error'].includes(status)) return 'withdrawn';
      const currentFingerprint = evidenceFingerprintFor(row);
      if (currentFingerprint !== accepted.evidence_fingerprint) {
        const ms = observedMs(row);
        if (!Number.isFinite(ms)) return 'unparseable';
        if (ms > asOf.getTime()) return 'future_dated';
        return 'corrected'; // includes a backward correction that remains outside the window
      }
      const acceptedMs = toMs(accepted.canonical?.observed_instant);
      if (currentFingerprint === evidenceFingerprint
        && currentFingerprint === previous.evidence_fingerprint
        && Number.isFinite(acceptedMs)
        && !withinWindow(acceptedMs, asOf, windowDays)) return 'aged_out';
    }
    // Bounded-query absence alone is not withdrawal. The direct lookup decides.
  }
  if (previous.source === 'waiver' && resolved.source !== 'waiver') return 'withdrawn';
  if (inFlight) return 'reordered';
  return null;
}
```

The resolver writes `evidence_fingerprint`, `policy_fingerprint`, `window_days` and `classifier_initialized_at` on every publish. When evidence is accepted, it writes `last_accepted_evidence = { result_id, canonical: canonicalEvidence(row), evidence_fingerprint, policy_fingerprint, accepted_at }`; later unavailable states never erase it. It performs the direct previous-id lookup outside the case-row critical section and passes the three-state lookup result above. `withinWindow(value, asOf, windowDays)` already rejects future values, so the explicit future branch remains before age classification.

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
    const snap = buildStartSnapshot({ recordedAt: AS_OF, clinicalStartedAt: null, clinicalStartProvenance: 'retrospective_time_unknown', procedureAttempt: 2, lifecycleToken: '11111111-1111-4111-8111-111111111111', via: 'status', commandId: 'cmd-0123456789abcdef', urgency: 'emergency', reason: 'Primary PCI', blocking, missingLabItems: ['hcv', 'hb'], readinessPictureAt: AS_OF.toISOString(), labComponentStatus: 'fresh', consentAuthority: 'emergency_basis' });
    expect(Object.keys(snap)).toEqual([...START_SNAPSHOT_KEYS]);
    expect(START_SNAPSHOT_KEYS).toEqual(['recorded_at', 'clinical_started_at', 'clinical_start_provenance', 'procedure_attempt', 'lifecycle_token', 'via', 'command_id', 'procedure_log_id', 'urgency', 'reason', 'blocking', 'missing_lab_items', 'readiness_picture_at', 'lab_component_status', 'consent_authority']);
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
  test('performed before clinical start, documented after recording → separate timing and lateness', () => {
    expect(timeoutTiming({ outcome: 'performed', performedAt: t(-60_000), documentedAt: t(+600_000), attemptStartedAt: t(0), attemptStartRecordedAt: t(0) })).toEqual({ timing: 'performed_before_clinical_start', documented_after_start: true });
  });
  test('performed after clinical start → performed_after_clinical_start', () => {
    expect(timeoutTiming({ outcome: 'performed', performedAt: t(+30_000), documentedAt: t(+30_000), attemptStartedAt: t(0), attemptStartRecordedAt: t(0) }).timing).toBe('performed_after_clinical_start');
  });
  test('absence is unknown; not_performed requires an explicit attested outcome', () => {
    expect(timeoutTiming({ outcome: null, performedAt: null, documentedAt: null, attemptStartRecordedAt: t(0) }).timing).toBe('not_documented');
    expect(timeoutTiming({ outcome: null, performedAt: null, documentedAt: t(+1), attemptStartRecordedAt: t(0) }).timing).toBe('performance_unknown');
    expect(timeoutTiming({ outcome: 'not_performed', performedAt: null, documentedAt: t(+1), attemptStartRecordedAt: t(0) }).timing).toBe('not_performed');
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
  'recorded_at', 'clinical_started_at', 'clinical_start_provenance', 'procedure_attempt', 'lifecycle_token',
  'via', 'command_id', 'procedure_log_id', 'urgency', 'reason',
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
  recordedAt, clinicalStartedAt = null, clinicalStartProvenance = null, procedureAttempt, lifecycleToken,
  via, commandId = null, procedureLogId = null, urgency = null, reason = null, blocking = [],
  missingLabItems = null, readinessPictureAt = null, labComponentStatus: componentStatus = 'unavailable', consentAuthority = null,
}) {
  if (!START_VIAS.includes(via)) throw AppError.badRequest(`start via must be one of ${START_VIAS.join(', ')}`, 'CATH_LAB_START_VIA_INVALID');
  if (!LAB_COMPONENT_STATUSES.includes(componentStatus)) throw AppError.badRequest('lab component status invalid', 'CATH_LAB_START_VIA_INVALID');
  // UNKNOWN is null, never []: an empty array would read as "nothing missing".
  if (componentStatus === 'unavailable' && Array.isArray(missingLabItems)) throw new Error('missing_lab_items must be null when the lab component is unavailable');
  return {
    recorded_at: new Date(recordedAt).toISOString(),
    clinical_started_at: clinicalStartedAt == null ? null : new Date(clinicalStartedAt).toISOString(),
    clinical_start_provenance: clinicalStartProvenance,
    procedure_attempt: Number(procedureAttempt),
    lifecycle_token: lifecycleToken,
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
    clinical_started_at: raw.clinical_started_at ?? null,
    clinical_start_provenance: raw.clinical_start_provenance ?? null,
    procedure_attempt: raw.procedure_attempt == null ? null : Number(raw.procedure_attempt),
    lifecycle_token: raw.lifecycle_token ?? null,
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

// Use the complete revision-4 timeoutTiming implementation at the start of
// Task 2. Pending/absent documentation never implies not_performed; only the
// explicit attested outcome does. Clinical ordering uses attemptStartedAt,
// while documentation lateness uses attemptStartRecordedAt.
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

> Revision-4 controlling order: land the cancelled-only door before refusals that name it. Then make replay reachable, introduce the server lifecycle fence on every attempt-specific write, bind one recording instant, archive attempt evidence, and split lab resolution from publication. Every snippet below uses these signatures and this order.

`transitionCaseStatus` must execute this exact sequence inside its tenant transaction:

1. Normalize `requestedTarget`, `command_id`, and `expected_lifecycle_token`.
2. Lock/read the case.
3. If the current status is `cancelled`, reject every generic status write with `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED`.
4. If `requestedTarget === 'in_progress'`, call `startCaseTx` immediately. Do **not** call `validateCaseTransition` first; replay on an already-running row must remain reachable.
5. For every other target, call `validateCaseTransition` and perform the generic update. If the target is `cancelled`, rotate `lifecycle_token = gen_random_uuid()` in that same statement—even when no attempt has started. For a never-started attempt, the same transaction rebinds its consent/time-out attempt rows from the prior token to the cancellation token without changing evidence; for a started attempt, the archived rows retain their Start token.

`startCaseTx(tx, { tenantId, cathCase, reason, via, commandId, expectedLifecycleToken, procedureLogId, clinicalStartedAt, clinicalStartProvenance, context })` then executes: normalize command/token and the exact spec §4.2 request fields; compute their canonical SHA-256 `request_fingerprint`; inspect `start_commands` before eligibility. A matching `(command_id, lifecycle_token, procedure_attempt, request_fingerprint)` returns `{ updated, snapshot, replayed: true }` with the stored immutable Start snapshot and current case, even if the case is now completed; same command/token/attempt with a changed fingerprint throws `CATH_LAB_START_COMMAND_CONFLICT`; another attempt/token is stale. Only a new command then compares the supplied token to the locked case, checks `START_ELIGIBLE_STATUSES`, asserts attempt-specific consent, reads cached lab/check projections without calling refresh, obtains exactly one `SELECT clock_timestamp() AS recorded_at`, derives status-start clinical time or validates retrospective nullable clinical time/provenance, freezes consent/time-out at-start fields, and updates the case under `WHERE lifecycle_token = expected`. Store `{ command_id, lifecycle_token, procedure_attempt, request_fingerprint, via, recorded_at, snapshot }`; write audit/canonical lifecycle envelope with the same `recorded_at`; return `{ updated, snapshot, replayed }`. `transitionCaseStatus` maps that only for the Start target to public `{ case: updated, start: snapshot, replayed }`; non-Start transition responses are unchanged. A zero-row update is `CATH_LAB_LIFECYCLE_STALE`.

`recordProcedureLog` requires both `log_command_id` and `expected_lifecycle_token` for every draft/finalized log. Under the case lock it checks the lifecycle token, looks up `(tenant_id, case_id, log_command_id)`, compares every normalized stored clinical/log field plus the independent `start_command_id`, and rejects changed content with `CATH_LAB_PROCEDURE_LOG_COMMAND_CONFLICT`. A duplicate draft/amended log returns the stored log with `replayed: true`. A duplicate finalized log that originally invoked Start calls `startCaseTx` with the stored log id and same normalized Start request, so command replay returns the immutable original snapshot without another INSERT/event/audit; the compound log/Start response has `replayed: true`. Every new INSERT stores server-derived `procedure_attempt` and `lifecycle_token`; only a newly inserted finalized row may invoke a new Start command/fingerprint. Drafts never start. A stale finalized request writes neither log nor Start. Requested cases refuse before INSERT; cancelled cases name the reopen door before INSERT.

`updateReadinessCheck` requires `expected_lifecycle_token` only for `consent` and `timeout`, compares it under the same case lock before either projection/attempt record changes, and conditionally upserts the attempt row by tenant/case/locked attempt/check. INSERT uses the locked token; `ON CONFLICT ... DO UPDATE` runs only `WHERE existing.lifecycle_token = EXCLUDED.lifecycle_token`, returns the governed row, and a zero-row result is stale. The upsert never changes frozen at-start fields. Both writes are one transaction; the existing metadata REPLACE affects only the current projection and has no path to archived attempt rows. It rejects client-owned `documented_at`, `documented_by`, `procedure_attempt`, `lifecycle_token`, `server_provenance`, `policy_version`, `previous_attempts`, or evidence archives. Patient/representative consent requires approved evidence and scope (plus representative reference for the latter); emergency basis requires an approved document reference or justification plus attestation and accepts no communication mode. The server supplies provenance, policy version, actor and recording time.

`reopenCaseTx` accepts only `cancelled`, preserves `actual_start_at`, clears `actual_end_at`, current snapshot and both active-attempt clocks, and always rotates `lifecycle_token`. It increments `procedure_attempt` and resets current consent/time-out only when `attempt_start_recorded_at` proves that the cancelled lifecycle had started; prior attempt rows retain their token. Otherwise the attempt number/checks remain and the server atomically rebinds those same-attempt rows from the cancelled token to the newly issued token without changing evidence. Start/cancel/reopen/complete audit and canonical events use a server-only lifecycle envelope; cancel/reopen include previous and resulting tokens. Prior consent/time-out evidence remains in `cath_lab_attempt_readiness_records`, never client-mergeable metadata.

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
const lockedCase = (status, extra = {}) => ({ ...cathCase(status), urgency: 'emergency', facility_id: 4, procedure_attempt: 1, lifecycle_token: TOKEN, attempt_start_recorded_at: null, attempt_started_at: null, actual_start_at: null, start_commands: [], readiness_at_start: null, ...extra });
const startedRow = (extra = {}) => ({ ...cathCase('in_progress'), urgency: 'emergency', facility_id: 4, actual_start_at: RECORDED, attempt_start_recorded_at: RECORDED, attempt_started_at: RECORDED, attempt_start_time_provenance: 'staff_confirmed_now', procedure_attempt: 1, lifecycle_token: TOKEN, metadata: {}, ...extra });
const CMD = 'a1b2c3d4e5f60718a1b2c3d4e5f60718';
const startBody = (extra = {}) => ({ status: 'in_progress', command_id: CMD, expected_lifecycle_token: TOKEN, ...extra });
const logBody = (extra = {}) => ({ procedure_type: 'PTCA', status: 'draft', log_command_id: crypto.randomUUID(), expected_lifecycle_token: TOKEN, ...extra });
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
      await expect(transitionCaseStatus(42, { tenantId: TENANT, status: 'in_progress', command_id, expected_lifecycle_token: TOKEN }, { actorUid: ACTOR }))
        .rejects.toMatchObject({ code: 'CATH_LAB_START_COMMAND_REQUIRED', statusCode: 400, details: { reason } });
    }
  });
  test('consent pending / waived / not_applicable refuses before anything is written', async () => {
    for (const consent of ['pending', 'waived', 'not_applicable']) {
      queryUnsafeMock.mockReset(); recordReadinessAuditMock.mockClear();
      queryUnsafeMock.mockResolvedValueOnce([lockedCase('readiness_pending')]).mockResolvedValueOnce(readinessRows({ consent, labs: 'pending' }));
      await expect(transitionCaseStatus(42, { tenantId: TENANT, ...startBody({ reason: 'x' }) }, { actorUid: ACTOR }))
        .rejects.toMatchObject({ code: 'CATH_LAB_CONSENT_REQUIRED', statusCode: 400, details: { consent_status: consent } });
      expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE cath_lab_cases/.test(sql))).toBe(false);
      expect(recordReadinessAuditMock).not.toHaveBeenCalled();
    }
  });
  test('only a migration-stamped legacy consent pass satisfies the block with consent_authority null', async () => { /* attempt record server_provenance=legacy_pre_NNN starts; an unmarked gap is refused */ });
  test('a pending gate needs a reason on the status path; the refusal names the checks', async () => { /* as revision 1, with command_id: CMD */ });
  test('consent pass + labs pending + reason: starts, snapshots 15 keys with one clock, binds command/token, audits, emits, schedules refresh after commit', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([lockedCase('readiness_pending')])
      .mockResolvedValueOnce(readinessRows({ labs: 'pending', timeout: 'pending' }, { consent: { consent: { authority: 'emergency_basis', justification: 'Immediate life threat', attested: true } } }))
      .mockResolvedValueOnce([{ item_code: 'hcv', required: true, state: 'not_ordered' }, { item_code: 'hb', required: true, state: 'result_final' }])
      .mockResolvedValueOnce([startedRow()])
      .mockResolvedValueOnce([]);
    const result = await transitionCaseStatus(42, { tenantId: TENANT, ...startBody({ reason: 'Primary PCI, outside reports awaited' }) }, { actorUid: ACTOR, actorRole: 'CONSULTANT' });
    expect(result.case.status).toBe('in_progress');
    const update = queryUnsafeMock.mock.calls.find(([sql]) => /UPDATE cath_lab_cases/.test(sql));
    expect(update[0]).toMatch(/status = 'in_progress'/);
    expect(update[0]).toMatch(/actual_start_at = COALESCE\(actual_start_at, \$6::timestamptz\)/);
    expect(update[0]).toMatch(/attempt_start_recorded_at = \$6::timestamptz/);
    expect(update[0]).toMatch(/attempt_started_at = \$7::timestamptz/);
    expect(update[0]).toMatch(/'start_commands'/);
    const snapshot = JSON.parse(update[3]);
    expect(Object.keys(snapshot)).toEqual([...START_SNAPSHOT_KEYS]);
    expect(snapshot).toMatchObject({ procedure_attempt: 1, via: 'status', command_id: CMD, missing_lab_items: ['hcv'], readiness_picture_at: '2026-09-06T04:31:05.001Z', lab_component_status: expect.stringMatching(/fresh|stale/), consent_authority: 'emergency_basis' });
    expect(JSON.parse(update[4])).toEqual([expect.objectContaining({ command_id: CMD, lifecycle_token: TOKEN, procedure_attempt: 1, request_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), via: 'status', recorded_at: snapshot.recorded_at, snapshot })]);
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
    const started = transitionCaseStatus(42, { tenantId: TENANT, ...startBody() }, { actorUid: ACTOR });
    const winner = await Promise.race([started.then(() => 'started'), new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000))]);
    expect(winner).toBe('started');
    expect(refreshCaseLabReadinessMock).not.toHaveBeenCalled();
    expect(scheduleRefreshMock).toHaveBeenCalledTimes(1);
  });
  test('no item rows → missing_lab_items null and lab_component_status unavailable (unknown, never clean)', async () => { /* stored items [] → snapshot.missing_lab_items === null, lab_component_status === 'unavailable' */ });
  test('a clean start writes blocking [] and no audit row', async () => { /* as revision 1 */ });
  test('command replay: same fingerprint after later completion returns original snapshot; changed request conflicts; another attempt is stale', async () => {
    const original = buildStartSnapshot({ recordedAt: RECORDED, clinicalStartedAt: RECORDED, clinicalStartProvenance: 'staff_confirmed_now', procedureAttempt: 1, lifecycleToken: TOKEN, via: 'status', commandId: CMD, procedureLogId: null, urgency: 'emergency', reason: null, blocking: [], missingLabItems: [], readinessPictureAt: RECORDED, labComponentStatus: 'fresh', consentAuthority: 'patient' });
    const fingerprint = stableSha256(normalizeStartCommand({ caseId: 42, lifecycleToken: TOKEN, procedureAttempt: 1, via: 'status', reason: null, procedureLogId: null, clinicalStartedAt: null, clinicalStartProvenance: null }));
    queryUnsafeMock.mockReset();
    queryUnsafeMock.mockResolvedValueOnce([lockedCase('completed', { attempt_start_recorded_at: RECORDED, start_commands: [{ command_id: CMD, lifecycle_token: TOKEN, procedure_attempt: 1, request_fingerprint: fingerprint, snapshot: original }] })]);
    const replay = await transitionCaseStatus(42, { tenantId: TENANT, ...startBody() }, { actorUid: ACTOR });
    expect(replay).toMatchObject({ case: { status: 'completed' }, start: original, replayed: true });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE cath_lab_cases/.test(sql))).toBe(false);
    queryUnsafeMock.mockResolvedValueOnce([lockedCase('completed', { attempt_start_recorded_at: RECORDED, start_commands: [{ command_id: CMD, lifecycle_token: TOKEN, procedure_attempt: 1, request_fingerprint: fingerprint, snapshot: original }] })]);
    await expect(transitionCaseStatus(42, { tenantId: TENANT, ...startBody({ reason: 'changed' }) }, { actorUid: ACTOR }))
      .rejects.toMatchObject({ code: 'CATH_LAB_START_COMMAND_CONFLICT', statusCode: 409 });
    queryUnsafeMock.mockReset();
    queryUnsafeMock.mockResolvedValueOnce([lockedCase('readiness_pending', { procedure_attempt: 2, lifecycle_token: '00000000-0000-4000-8000-000000000099', start_commands: [{ command_id: CMD, lifecycle_token: TOKEN, procedure_attempt: 1, request_fingerprint: fingerprint, snapshot: original }] })]);
    await expect(transitionCaseStatus(42, { tenantId: TENANT, ...startBody({ reason: 'old' }) }, { actorUid: ACTOR }))
      .rejects.toMatchObject({ code: 'CATH_LAB_START_COMMAND_STALE', statusCode: 409, details: { command_attempt: 1, current_attempt: 2, case_status: 'readiness_pending' } });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE cath_lab_cases/.test(sql))).toBe(false);
  });
});

describe('recordProcedureLog — the exhaustive table (spec §4.2, decision 16 — owner point 3)', () => {
  const log = (status) => ({ id: 7, tenant_id: TENANT, case_id: 42, patient_uid: PATIENT, encounter_id: ENCOUNTER, procedure_type: 'PTCA', status });
  test('start-eligible × finalized: log command is checked before insert, then independent Start command reaches startCaseTx with token and provenance', async () => { /* assert snapshot via/log id, one insert, one Start, one bound recording instant */ });
  test('start-eligible × draft: inserts, case UNTOUCHED (no consent read, no start, no snapshot, no refresh)', async () => {
    for (const status of ['scheduled', 'readiness_pending', 'ready']) {
      queryUnsafeMock.mockReset(); scheduleRefreshMock.mockClear();
      queryUnsafeMock.mockResolvedValueOnce([lockedCase(status)]).mockResolvedValueOnce([log('draft')]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await recordProcedureLog(42, { tenantId: TENANT, ...logBody() }, { actorUid: ACTOR });
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
    await expect(recordProcedureLog(42, { tenantId: TENANT, ...logBody() }, { actorUid: ACTOR }))
      .rejects.toMatchObject({ code: 'CATH_LAB_CASE_START_NOT_ELIGIBLE', statusCode: 409, details: { case_status: 'requested', next_action: { path: '/api/v1/cath-lab/cases/:id/status', body: { status: 'scheduled' } } } });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO cath_procedure_logs/.test(sql))).toBe(false);
  });
  test('an unexpected status: 409 START_NOT_ELIGIBLE before the insert (defensive row)', async () => { /* lockedCase('bogus') → details.case_status === 'bogus' */ });
  test('the finalized log is refused by the consent block too (hazard ii)', async () => { /* as revision 1 */ });
});

describe('consent and time-out writes (spec §4.3, §4.7 — owner point 8)', () => {
  test('a consent pass without its authority-conditional evidence → 400 before any write', async () => { /* patient/representative require evidence+scope; representative also requires representative_ref; emergency requires document_ref or justification+attested and rejects mode */ });
  test('a consent pass with an authority outside the tenant policy → 400 CONSENT_AUTHORITY_NOT_PERMITTED with details.permitted', async () => { /* tenants.settings mock → { cath_lab: { consent_authorities: ['patient'] } }; authority 'emergency_basis' → rejects */ });
  test('a permitted consent stores projected evidence while provenance/policy/actor/time are server-owned in the attempt record', async () => { /* client-owned provenance/history fields are rejected */ });
  test('time-out pending is not_documented; explicit attested omission is not_performed; performed carries clinical time and one server recording time', async () => { /* future performed_at refused */ });
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
  test('cancelled BEFORE it ever started: same attempt, token rotates, attempt evidence rebinds, no check reset', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([lockedCase('cancelled', { actual_end_at: 'e', attempt_started_at: null, actual_start_at: null })])
      .mockResolvedValueOnce([{ payload: { reason: 'List overran' } }])   // latest cath_lab.case_cancelled event
      .mockResolvedValueOnce([{ ...lockedCase('readiness_pending'), actual_end_at: null }])
      .mockResolvedValueOnce([])                                           // attempt-record token rebind
      .mockResolvedValueOnce([]);                                          // refs
    await reopenCase(42, { tenantId: TENANT, reason: 'Slot freed' }, { actorUid: ACTOR });
    const update = queryUnsafeMock.mock.calls.find(([sql]) => /UPDATE cath_lab_cases/.test(sql));
    expect(update[0]).toMatch(/status = 'readiness_pending'/); expect(update[0]).toMatch(/actual_end_at = NULL/); expect(update[0]).toMatch(/attempt_started_at = NULL/);
    expect(update[0]).not.toMatch(/actual_start_at =/); expect(update[0]).not.toMatch(/in_progress/);
    expect(update[4]).toBe(1);   // procedure_attempt unchanged
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE cath_lab_readiness_checks/.test(sql))).toBe(false);
    const rebind = queryUnsafeMock.mock.calls.find(([sql]) => /UPDATE cath_lab_attempt_readiness_records/.test(sql));
    expect(rebind[0]).toMatch(/procedure_attempt = \$3::int AND lifecycle_token = \$5::uuid/);
    expect(rebind[4]).not.toBe(TOKEN); expect(rebind[5]).toBe(TOKEN);
    expect(recordReadinessAuditMock).toHaveBeenCalledWith(__prismaDefaultMock, expect.objectContaining({ action: 'cath_lab.case.reopened', metadata: expect.objectContaining({ previous_attempt: 1, procedure_attempt: 1, previous_lifecycle_token: TOKEN, lifecycle_token: expect.not.stringMatching(TOKEN), attempt_record_token_rebound: true, checks_reset: [], cancel_reason: 'List overran', cancelled_at: 'e' }) }));
  });
  test('cancelled AFTER it had started: attempt N+1, prior attempt record preserved, consent + timeout reset, actual_start_at kept', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([lockedCase('cancelled', { actual_end_at: 'e', attempt_start_recorded_at: 's', attempt_started_at: null, actual_start_at: 's', procedure_attempt: 1 })])
      .mockResolvedValueOnce([])                                            // no cancel event
      .mockResolvedValueOnce([{ ...lockedCase('readiness_pending'), procedure_attempt: 2, actual_start_at: 's', actual_end_at: null }])
      .mockResolvedValueOnce([])                                            // checks reset UPDATE
      .mockResolvedValueOnce([]);                                           // refs
    await reopenCase(42, { tenantId: TENANT, reason: 'Resuming' }, { actorUid: ACTOR });
    const caseUpdate = queryUnsafeMock.mock.calls.find(([sql]) => /UPDATE cath_lab_cases/.test(sql));
    expect(caseUpdate[4]).toBe(2);
    expect(caseUpdate[0]).toMatch(/readiness_at_start_history/);
    expect(caseUpdate[0]).not.toMatch(/previous_attempts/);
    const checksUpdate = queryUnsafeMock.mock.calls.find(([sql]) => /UPDATE cath_lab_readiness_checks/.test(sql));
    expect(checksUpdate[0]).toMatch(/check_type IN \('consent', 'timeout'\)/);
    expect(checksUpdate[0]).toMatch(/status = 'pending'/); expect(checksUpdate[0]).toMatch(/completed_at = NULL/); expect(checksUpdate[0]).not.toMatch(/previous_attempts/);
    expect(recordReadinessAuditMock).toHaveBeenCalledWith(__prismaDefaultMock, expect.objectContaining({ metadata: expect.objectContaining({ previous_attempt: 1, procedure_attempt: 2, previous_lifecycle_token: TOKEN, lifecycle_token: expect.not.stringMatching(TOKEN), previous_attempt_start_recorded_at: 's', checks_reset: ['consent', 'timeout'] }) }));
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'cath_lab.case_reopened', payload: expect.objectContaining({ procedure_attempt: 2, previous_attempt: 1, previous_lifecycle_token: TOKEN, lifecycle_token: expect.not.stringMatching(TOKEN), checks_reset: ['consent', 'timeout'] }) }), expect.anything());
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
// Versioned, clinically/legally approved policy. Missing configuration is a
// deployment/configuration error; there is no permissive production default.
async function consentPolicyFor(tenantId, db) {
  const rows = normalizeRows(await db.$queryRawUnsafe(
    `SELECT settings->'cath_lab'->'consent_policy' AS policy FROM tenants WHERE id = $1::uuid LIMIT 1`, tenantOr(tenantId)));
  const policy = rows[0]?.policy;
  if (!policy?.approved_version || !Array.isArray(policy.authorities)) {
    throw AppError.serviceUnavailable('The approved cath consent policy is not configured', 'CATH_LAB_CONSENT_POLICY_UNAVAILABLE');
  }
  return policy;
}
```

(Read the `tenants` primary-key column name off `schema.prisma` before pasting; remember `tenants` may be unreadable without the tenant GUC under RLS — this runs inside the tenant transaction, which sets it.) In `updateReadinessCheck`, **before** the upsert and before any write:

```js
    if (checkType === 'consent' || checkType === 'timeout') {
      const token = normalizeLifecycleToken(input.expected_lifecycle_token);
      const cathCase = await caseById(tx, tenantId, caseId, { lock: true });
      if (!token || String(cathCase.lifecycle_token) !== token) {
        throw AppError.conflict('The case lifecycle changed; reload before writing', 'CATH_LAB_LIFECYCLE_STALE');
      }
      rejectClientOwnedAttemptFields(input);
    }
    if (checkType === 'consent' && status === 'pass') {
      const consent = input.metadata?.consent;
      const policy = await consentPolicyFor(tenantId, tx);
      validateConsentAgainstPolicy(consent, policy); // patient: mode+evidence+scope;
      // representative: same plus representative_ref; emergency: approved
      // document_ref OR justification+attested, and mode MUST be absent.
      metadata = { ...metadata, consent: projectConsentInput(consent) };
    }
    if (checkType === 'timeout' && status === 'pass') {
      if (input.metadata?.timeout?.outcome !== 'performed') {
        throw AppError.badRequest('A passed time-out must explicitly record performed', 'CATH_LAB_TIMEOUT_OUTCOME_INVALID');
      }
      const performedAt = optionalTimestamp(input.metadata?.timeout?.performed_at, 'performed_at');
      if (!performedAt || new Date(performedAt).getTime() > Date.now()) {
        throw AppError.badRequest('A time-out pass must record when the time-out was performed (a past instant)', 'CATH_LAB_TIMEOUT_PERFORMED_AT_REQUIRED');
      }
      metadata = { ...metadata, timeout: { performed_at: new Date(performedAt).toISOString(), documented_at: null } };  // documented_at = completed_at, set below
      completedAtOverride = null;   // the ONE check type whose client completed_at is ignored: the two instants must not be conflated
    }
    if (checkType === 'timeout' && input.metadata?.timeout?.outcome === 'not_performed') {
      if (input.metadata.timeout.attested !== true) throw AppError.badRequest('not_performed requires attestation', 'CATH_LAB_TIMEOUT_ATTESTATION_REQUIRED');
      status = 'pending';
      metadata = { ...metadata, timeout: { outcome: 'not_performed', attested: true } };
      completedAtOverride = null;
    }
```

Obtain one server `documented_at` inside the transaction and write the current projection and matching `cath_lab_attempt_readiness_records` row together, with server-owned actor, attempt, lifecycle token, approved policy version and archived evidence references. The governed attempt mutation is:

```js
const attemptRows = normalizeRows(await tx.$queryRawUnsafe(
  `INSERT INTO cath_lab_attempt_readiness_records
     (tenant_id, case_id, procedure_attempt, check_type, lifecycle_token,
      server_provenance, current_status, current_completed_at, current_completed_by,
      current_metadata, current_evidence_refs, created_at, updated_at)
   VALUES ($1::uuid, $2::bigint, $3::int, $4, $5::uuid,
           $6, $7, $8::timestamptz, $9::uuid, $10::jsonb, $11::jsonb, $8::timestamptz, $8::timestamptz)
   ON CONFLICT (tenant_id, case_id, procedure_attempt, check_type) DO UPDATE
     SET current_status = EXCLUDED.current_status,
         current_completed_at = EXCLUDED.current_completed_at,
         current_completed_by = EXCLUDED.current_completed_by,
         current_metadata = EXCLUDED.current_metadata,
         current_evidence_refs = EXCLUDED.current_evidence_refs,
         server_provenance = EXCLUDED.server_provenance,
         updated_at = EXCLUDED.updated_at
   WHERE cath_lab_attempt_readiness_records.lifecycle_token = EXCLUDED.lifecycle_token
   RETURNING *`,
  tenantId, cathCase.id, Number(cathCase.procedure_attempt), checkType, token,
  serverProvenance, status, documentedAt, actorUid, JSON.stringify(metadata), JSON.stringify(evidenceRefs),
));
if (attemptRows.length !== 1) throw AppError.conflict('The case lifecycle changed; reload before writing', 'CATH_LAB_LIFECYCLE_STALE');
```

The conflict branch deliberately does not assign `lifecycle_token` or any `at_start_*` column. Legacy structured gaps are accepted only when the migration stamped `server_provenance = 'legacy_pre_NNN'`; no request may manufacture that marker.

- [ ] **Step 5: Implement — `caseById`, `normalizeCommandId`, `labsPictureForStartTx`, `startCaseTx`** (spec §4.2, §4.5, §4.10)

`caseById`'s SELECT gains `procedure_attempt, lifecycle_token, attempt_start_recorded_at, attempt_started_at, attempt_start_time_provenance, lab_readiness_generation, metadata->'start_commands' AS start_commands, metadata->'readiness_at_start' AS readiness_at_start` (JSON paths—never the whole `metadata` column).

```js
const COMMAND_ID = /^[A-Za-z0-9_.:-]{16,128}$/;
// An opaque client token, bound to (case, attempt). A UUID passes; so does the
// hex token IdempotencyKey.generate() mints in the Staff app.
function normalizeCommandId(value) {
  const text = cleanText(value, 128);
  return text && COMMAND_ID.test(text) ? text : null;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function stableSha256(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function normalizeStartCommand({ caseId, lifecycleToken, procedureAttempt, via, reason, procedureLogId, clinicalStartedAt, clinicalStartProvenance }) {
  return {
    case_id: String(caseId),
    clinical_start_provenance: clinicalStartProvenance ?? null,
    clinical_started_at: clinicalStartedAt == null ? null : new Date(clinicalStartedAt).toISOString(),
    lifecycle_token: String(lifecycleToken),
    procedure_attempt: Number(procedureAttempt),
    procedure_log_id: procedureLogId == null ? null : String(procedureLogId),
    reason: cleanText(reason, 500),
    via,
  };
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

async function ensureAttemptReadinessRecordsTx(tx, { tenantId, caseId, procedureAttempt, lifecycleToken, checks }) {
  for (const check of checks) {
    await tx.$executeRawUnsafe(
      `INSERT INTO cath_lab_attempt_readiness_records
         (tenant_id, case_id, procedure_attempt, check_type, lifecycle_token,
          server_provenance, current_status, current_completed_at, current_completed_by,
          current_metadata, current_evidence_refs)
       VALUES ($1::uuid, $2::bigint, $3::int, $4, $5::uuid,
               'server_projection_materialized', $6, $7::timestamptz, $8::uuid,
               $9::jsonb, $10::jsonb)
       ON CONFLICT (tenant_id, case_id, procedure_attempt, check_type) DO NOTHING`,
      tenantOr(tenantId), caseId, procedureAttempt, check.check_type, lifecycleToken,
      check.status, check.completed_at ?? null, check.completed_by ?? null,
      JSON.stringify(check.metadata ?? {}), JSON.stringify(evidenceRefsFor(check)),
    );
  }
  const governed = normalizeRows(await tx.$queryRawUnsafe(
    `SELECT check_type FROM cath_lab_attempt_readiness_records
      WHERE tenant_id = $1::uuid AND case_id = $2::bigint
        AND procedure_attempt = $3::int AND lifecycle_token = $4::uuid
        AND check_type = ANY($5::text[])`,
    tenantOr(tenantId), caseId, procedureAttempt, lifecycleToken, checks.map((row) => row.check_type),
  ));
  if (governed.length !== checks.length) throw AppError.conflict('The case lifecycle changed; reload before writing', 'CATH_LAB_LIFECYCLE_STALE');
}

// THE ONE START PATH (spec §4.2). transitionCaseStatus and recordProcedureLog
// come here and nowhere else moves a case to in_progress or sets
// actual_start_at / attempt_started_at — cathLabStartPathPin.test.js pins the
// counts, the SQL shapes and the write-site population. Caller holds the row
// FOR UPDATE. Never awaits the lab rail; the CALLER schedules the refresh after
// commit.
async function startCaseTx(tx, { tenantId, cathCase, reason = null, via, commandId, expectedLifecycleToken, procedureLogId = null, clinicalStartedAt = null, clinicalStartProvenance = null, context = {} }) {
  // 1. Command binding (decision 20). A replay against the SAME attempt answers
  //    the started case; against ANOTHER attempt it is refused — the sequence
  //    "start, response lost, cancel, reopen, retry" must not start attempt 2.
  const command = normalizeCommandId(commandId);
  if (!command) {
    throw AppError.badRequest('A stable command_id is required to start the procedure', 'CATH_LAB_START_COMMAND_REQUIRED', { reason: commandId == null ? 'missing' : 'malformed' });
  }
  const priorCommands = Array.isArray(cathCase.start_commands) ? cathCase.start_commands : [];
  const token = normalizeLifecycleToken(expectedLifecycleToken);
  if (!token) throw AppError.badRequest('A server lifecycle token is required', 'CATH_LAB_LIFECYCLE_TOKEN_REQUIRED');
  const requestFingerprint = stableSha256(normalizeStartCommand({
    caseId: cathCase.id, lifecycleToken: token, procedureAttempt: cathCase.procedure_attempt,
    via, reason: cleanText(reason, 500), procedureLogId, clinicalStartedAt, clinicalStartProvenance,
  }));
  const prior = priorCommands.find((entry) => entry?.command_id === command);
  if (prior) {
    const sameLifecycle = prior.lifecycle_token === token
      && token === String(cathCase.lifecycle_token)
      && Number(prior.procedure_attempt) === Number(cathCase.procedure_attempt);
    if (!sameLifecycle) throw AppError.conflict(
      'This start command belongs to another lifecycle; review the checklist and start again',
      'CATH_LAB_START_COMMAND_STALE',
      { command_attempt: Number(prior.procedure_attempt), current_attempt: Number(cathCase.procedure_attempt), case_status: cathCase.status });
    if (prior.request_fingerprint !== requestFingerprint) throw AppError.conflict(
      'This start command was reused with different content', 'CATH_LAB_START_COMMAND_CONFLICT');
    return { updated: normalizeDbValue(cathCase), snapshot: normalizeStartSnapshot(prior.snapshot), replayed: true };
  }
  if (String(cathCase.lifecycle_token) !== token) {
    throw AppError.conflict('The case lifecycle changed; reload before writing', 'CATH_LAB_LIFECYCLE_STALE');
  }
  // 2. Eligibility follows replay and lifecycle matching.
  if (!START_ELIGIBLE_STATUSES.includes(cathCase.status)) {
    throw AppError.invalidTransition(cathCase.status, 'in_progress', CASE_TRANSITIONS[cathCase.status] || []);
  }
  // 3. The one hard block. Throws before anything is written.
  const { gate, checks, consent } = await assertConsentDocumented(
    tx, tenantId, cathCase.id, Number(cathCase.procedure_attempt), token,
  );
  // Materialize a never-written pending time-out (and any legacy gap) now,
  // from the locked current projections. Existing rows must carry this token;
  // another-token conflict is stale. This never touches archived attempts.
  await ensureAttemptReadinessRecordsTx(tx, {
    tenantId, caseId: cathCase.id, procedureAttempt: Number(cathCase.procedure_attempt),
    lifecycleToken: token, checks: checks.filter((row) => ['consent', 'timeout'].includes(row.check_type)),
  });
  // 4. Reason: the owner's control on an EXPLICIT start with checks pending (decision 4).
  const cleanReason = cleanText(reason, 500);
  if (!gate.ready && via === 'status' && !cleanReason) {
    throw AppError.badRequest('A reason is required to start the procedure while readiness checks are pending', 'CATH_LAB_START_REASON_REQUIRED', { blocking: gate.blocking });
  }
  // 5. The last committed lab picture (decision 18).
  const labs = await labsPictureForStartTx(tx, tenantId, cathCase.id, checks);
  const [{ recorded_at: recordedAt }] = normalizeRows(await tx.$queryRawUnsafe('SELECT clock_timestamp() AS recorded_at'));
  const clinical = via === 'status' ? recordedAt : clinicalStartedAt;
  const provenance = via === 'status' ? 'staff_confirmed_now' : (clinicalStartProvenance ?? 'retrospective_time_unknown');
  const frozenAttemptRows = await tx.$executeRawUnsafe(
    `UPDATE cath_lab_attempt_readiness_records
        SET at_start_status = current_status,
            at_start_completed_at = current_completed_at,
            at_start_metadata = current_metadata,
            at_start_evidence_refs = current_evidence_refs,
            at_start_recorded_at = $5::timestamptz,
            updated_at = $5::timestamptz
      WHERE tenant_id = $1::uuid AND case_id = $2::bigint
        AND procedure_attempt = $3::int AND lifecycle_token = $4::uuid
        AND check_type IN ('consent','timeout') AND at_start_recorded_at IS NULL`,
    tenantOr(tenantId), cathCase.id, Number(cathCase.procedure_attempt), token, recordedAt);
  if (Number(frozenAttemptRows) !== 2) {
    throw AppError.conflict('Attempt readiness history was already frozen or changed; reload before starting', 'CATH_LAB_LIFECYCLE_STALE');
  }
  // 6. Snapshot and every start-side write share recordedAt.
  const snapshot = buildStartSnapshot({
    recordedAt, clinicalStartedAt: clinical, clinicalStartProvenance: provenance,
    procedureAttempt: cathCase.procedure_attempt, lifecycleToken: token, via, commandId: command, procedureLogId, urgency: cathCase.urgency ?? null, reason: cleanReason,
    blocking: gate.blocking, missingLabItems: labs.missing, readinessPictureAt: labs.picture_at, labComponentStatus: labs.lab_component_status,
    consentAuthority: consent?.authority ?? null
  });
  const commandEntries = [{ command_id: command, lifecycle_token: token, procedure_attempt: Number(cathCase.procedure_attempt), request_fingerprint: requestFingerprint, via, recorded_at: snapshot.recorded_at, snapshot }];
  // 7. One UPDATE. A MERGE into metadata, never a replacement (STEMI's keys and the history array survive).
  const rows = await tx.$queryRawUnsafe(
    `UPDATE cath_lab_cases
        SET status = 'in_progress',
            actual_start_at = COALESCE(actual_start_at, $6::timestamptz),
            attempt_start_recorded_at = $6::timestamptz,
            attempt_started_at = $7::timestamptz,
            attempt_start_time_provenance = $8::varchar,
            metadata = COALESCE(metadata, '{}'::jsonb)
                       || jsonb_build_object('readiness_at_start', $3::jsonb)
                       || jsonb_build_object('start_commands', COALESCE(metadata->'start_commands', '[]'::jsonb) || $4::jsonb),
            updated_by = $5::uuid,
            updated_at = $6::timestamptz
      WHERE tenant_id = $1::uuid AND id = $2::bigint AND lifecycle_token = $9::uuid
      RETURNING *`,
    tenantOr(tenantId), cathCase.id, JSON.stringify(snapshot), JSON.stringify(commandEntries), maybeUuid(context.actorUid, 'actorUid'),
    recordedAt, clinical, provenance, token);
  if (rows.length !== 1) throw AppError.conflict('The case lifecycle changed; reload before writing', 'CATH_LAB_LIFECYCLE_STALE');
  const updated = unwrap(rows);
  const startedWithPending = gate.blocking.length > 0;
  const event = await writeCanonicalEvent(tx, {
    tenantId, patientUid: updated.patient_uid, encounterId: updated.encounter_id,
    eventType: 'cath_lab.case_in_progress', eventStatus: 'in_progress', sourceTable: 'cath_lab_cases', sourceId: updated.id,
    actorUid: context.actorUid, actorRole: context.actorRole,
    summary: `Cath-lab case in_progress: ${updated.requested_procedure}`,
    payload: { status: 'in_progress', reason: cleanReason, via, ...lifecycleEventEnvelope(updated, recordedAt), command_id: command, started_with_readiness_pending: startedWithPending, readiness_at_start: snapshot },
    occurredAt: recordedAt, beforeState: { status: cathCase.status }, afterState: { status: 'in_progress' }
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
  const previousAttemptRecordedAt = cathCase.attempt_start_recorded_at ?? null;
  const previousAttempt = Number(cathCase.procedure_attempt);
  const previousLifecycleToken = String(cathCase.lifecycle_token);
  const newAttempt = previousAttemptRecordedAt ? previousAttempt + 1 : previousAttempt;
  const nextLifecycleToken = crypto.randomUUID();
  const cancelReason = await latestCancelReasonTx(tx, tenantId, cathCase.id);
  const rows = await tx.$queryRawUnsafe(
    `UPDATE cath_lab_cases
        SET status = 'readiness_pending',
            actual_end_at = NULL,
            attempt_start_recorded_at = NULL,
            attempt_started_at = NULL,
            attempt_start_time_provenance = NULL,
            procedure_attempt = $4::int,
            lifecycle_token = $5::uuid,
            metadata = (COALESCE(metadata, '{}'::jsonb) - 'readiness_at_start')
                       || jsonb_build_object('readiness_at_start_history',
                            COALESCE(metadata->'readiness_at_start_history', '[]'::jsonb)
                            || CASE WHEN jsonb_typeof(metadata->'readiness_at_start') = 'object'
                                    THEN jsonb_build_array(metadata->'readiness_at_start') ELSE '[]'::jsonb END),
            updated_by = $3::uuid,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::bigint
      RETURNING *`,
    tenantOr(tenantId), cathCase.id, maybeUuid(context.actorUid, 'actorUid'), newAttempt, nextLifecycleToken);
  const updated = unwrap(rows);
  let checksReset = [];
  if (newAttempt > previousAttempt) {
    await tx.$executeRawUnsafe(
      `UPDATE cath_lab_readiness_checks
          SET status = 'pending', completed_at = NULL, completed_by = NULL,
              metadata = COALESCE(metadata, '{}'::jsonb) - 'consent' - 'timeout',
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND check_type IN ('consent', 'timeout')`,
      tenantOr(tenantId), cathCase.id, previousAttempt);
    checksReset = [...ATTEMPT_RESET_CHECKS];
  } else {
    // Same attempt, new lifecycle: keep the evidence but move its server fence.
    await tx.$executeRawUnsafe(
      `UPDATE cath_lab_attempt_readiness_records
          SET lifecycle_token = $4::uuid, updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint
          AND procedure_attempt = $3::int AND lifecycle_token = $5::uuid`,
      tenantOr(tenantId), cathCase.id, previousAttempt, nextLifecycleToken, previousLifecycleToken);
  }
  const event = await writeCanonicalEvent(tx, {
    tenantId, patientUid: updated.patient_uid, encounterId: updated.encounter_id,
    eventType: 'cath_lab.case_reopened', eventStatus: REOPEN_TARGET_STATUS, sourceTable: 'cath_lab_cases', sourceId: updated.id,
    actorUid: context.actorUid, actorRole: context.actorRole, summary: `Cath-lab case reopened: ${updated.requested_procedure}`,
    payload: { status: REOPEN_TARGET_STATUS, reason: cleanReason, previous_status: 'cancelled', previous_attempt: previousAttempt, procedure_attempt: newAttempt, previous_lifecycle_token: previousLifecycleToken, lifecycle_token: nextLifecycleToken, checks_reset: checksReset },
    beforeState: { status: 'cancelled' }, afterState: { status: REOPEN_TARGET_STATUS }
  });
  await updateCaseCanonicalRefs(tx, { tenantId, caseId: updated.id, event });
  await recordReadinessAudit(tx, {   // ALWAYS: the audit row IS the decision
    tenantId: tenantOr(tenantId), action: 'cath_lab.case.reopened', resource: 'cath_lab_cases', resourceId: updated.id, context,
    metadata: { case_id: normalizeDbValue(updated.id), facility_id: updated.facility_id ?? null, reason: cleanReason, previous_status: 'cancelled', cancelled_at: cancelledAt, cancel_reason: cancelReason,
      urgency: updated.urgency ?? null, previous_attempt: previousAttempt, procedure_attempt: newAttempt, previous_attempt_start_recorded_at: previousAttemptRecordedAt,
      previous_lifecycle_token: previousLifecycleToken, lifecycle_token: nextLifecycleToken, lifecycle_token_rotated: true,
      attempt_record_token_rebound: !previousAttemptRecordedAt, checks_reset: checksReset }
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
    const target = normalizeStatus(input.status, CASE_STATUSES, 'status');
    const commandId = normalizeCommandId(input.command_id);
    const expectedLifecycleToken = normalizeLifecycleToken(input.expected_lifecycle_token);
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
    if (target === 'in_progress') {
      const { updated, snapshot, replayed } = await startCaseTx(tx, { tenantId, cathCase, reason: input.reason, via: 'status', commandId, expectedLifecycleToken, context });
      if (!replayed) startedPatientUid = updated.patient_uid;   // closure variable read after commit; replay has no side effect
      return { case: updated, start: snapshot, replayed };
    }
    validateCaseTransition(cathCase.status, target);
    // Run the existing generic UPDATE with its start branch removed. When
    // target is cancelled, the same UPDATE assigns lifecycle_token =
    // gen_random_uuid(); all existing SLA fields retain their measured binds.
```

Every generic status-transition audit/canonical payload calls `lifecycleEventEnvelope`: server-derived `case_id`, `procedure_attempt`, `lifecycle_token`, and recording instant. Cancellation generates its next token in the UPDATE and records both `previous_lifecycle_token` and resulting `lifecycle_token`. If `attempt_start_recorded_at` was null, it updates `cath_lab_attempt_readiness_records` under tenant/case/attempt/previous-token to the resulting token in the same transaction and records `attempt_record_token_rebound: true`; otherwise it preserves the started-attempt rows and records false. Completion retains and records the current token. The request body cannot override any envelope field.

After `setTenantTx` resolves: `if (startedPatientUid) scheduleReadinessRefresh({ tenantId, patientUid: startedPatientUid, source: 'cath_case_start' });` — synchronous, never awaited, never throws. Delete the `assertReadinessComplete` call. If the SLA tests break, the generic UPDATE's parameter numbering shifted — keep `$3`/`$4`.

- [ ] **Step 8: Implement — `recordProcedureLog`, the exhaustive table** (spec §4.2; owner point 3)

```js
  const logStatus = input.status ? normalizeStatus(input.status, ['draft', 'finalized', 'amended'], 'status') : 'finalized';  // BEFORE the case is read
  let startedPatientUid = null;
  const procedure = await setTenantTx(tenantId, async (tx) => {
    const cathCase = await caseById(tx, tenantId, caseId, { lock: true });
    const token = normalizeLifecycleToken(input.expected_lifecycle_token);
    const logCommandId = normalizeCommandId(input.log_command_id);
    if (!token || !logCommandId) throw AppError.badRequest('log_command_id and expected_lifecycle_token are required', 'CATH_LAB_PROCEDURE_LOG_COMMAND_REQUIRED');
    if (String(cathCase.lifecycle_token) !== token) throw AppError.conflict('The case lifecycle changed; reload before writing', 'CATH_LAB_LIFECYCLE_STALE');
    const requestHash = stableSha256(normalizeProcedureLogCommand(input));
    const existing = unwrapOrNull(await tx.$queryRawUnsafe(
      `SELECT *, metadata->>'server_command_hash' AS server_command_hash,
                 metadata->>'server_start_command_id' AS server_start_command_id
         FROM cath_procedure_logs
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND log_command_id = $3`,
      tenantId, cathCase.id, logCommandId));
    if (existing) {
      if (existing.server_command_hash !== requestHash) throw AppError.conflict('The log command was reused with different content', 'CATH_LAB_PROCEDURE_LOG_COMMAND_CONFLICT');
      if (existing.server_start_command_id) {
        const replay = await startCaseTx(tx, {
          tenantId, cathCase, reason: input.start_reason, via: 'procedure_log',
          commandId: existing.server_start_command_id, expectedLifecycleToken: token,
          procedureLogId: existing.id,
          clinicalStartedAt: optionalTimestamp(input.started_at || input.startedAt, 'started_at'),
          clinicalStartProvenance: input.started_at || input.startedAt ? 'retrospective_staff_supplied' : 'retrospective_time_unknown', context,
        });
        return { ...normalizeDbValue(existing), case: replay.updated, start: replay.snapshot, replayed: true };
      }
      return { ...normalizeDbValue(existing), replayed: true };
    }
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
    // Extend the existing INSERT with procedure_attempt, lifecycle_token and
    // log_command_id. Store server_command_hash and, only for a new finalized
    // log that will Start, server_start_command_id under reserved metadata keys;
    // strip both keys from client metadata before merging.
    const row = unwrap(rows);
    // Decision 16: a FINALIZED log on a start-eligible case starts it — same function,
    // same block, same snapshot. A draft or an amendment is recorded and starts nothing.
    if (startEligible && START_LOG_STATUSES.includes(logStatus)) {
      const { updated, snapshot } = await startCaseTx(tx, { tenantId, cathCase, reason: input.start_reason, via: 'procedure_log', commandId: input.command_id, expectedLifecycleToken: token, procedureLogId: row.id, clinicalStartedAt: optionalTimestamp(input.started_at || input.startedAt, 'started_at'), clinicalStartProvenance: input.started_at || input.startedAt ? 'retrospective_staff_supplied' : 'retrospective_time_unknown', context });
      startedPatientUid = updated.patient_uid;
      return { ...normalizeDbValue(row), case: updated, start: snapshot, replayed: false };
    }
    // Keep the measured canonical-event, log-reference and complication-
    // registry writes unchanged and inside this transaction.
    return { ...normalizeDbValue(row), replayed: false };
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
      `${SERVICE}:startCaseTx :: actual_start_at = COALESCE(actual_start_at, $6::timestamptz),`,
      `${SERVICE}:startCaseTx :: attempt_start_recorded_at = $6::timestamptz,`,
      `${SERVICE}:startCaseTx :: attempt_started_at = $7::timestamptz,`,
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
  test('a synthetic new writer makes the population assertion fail', () => {
    const synthetic = { path: 'services/clinical/__syntheticWriter.js', text: "async function syntheticWriter(tx) { return tx.$executeRawUnsafe(`UPDATE cath_lab_cases SET updated_at = NOW() WHERE id = $1`, 1); }" };
    const measured = measureWritePopulation([...FILES, synthetic]);
    expect(measured.updates).toContain('services/clinical/__syntheticWriter.js:syntheticWriter');
    expect(() => expect(measured.updates.sort()).toEqual([...UPDATE_SITES])).toThrow();
  });
  test('a synthetic ORM create/update/upsert is also rejected by name', () => {
    for (const method of ['create', 'update', 'updateMany', 'upsert']) {
      const synthetic = { path: 'services/clinical/__syntheticOrmWriter.js', text: `async function syntheticOrmWriter(tx) { return tx.cath_lab_cases.${method}({ data: {} }); }` };
      const measured = measureWritePopulation([...FILES, synthetic]);
      expect(measured.ormWriters).toEqual([`services/clinical/__syntheticOrmWriter.js:syntheticOrmWriter:${method}`]);
      expect(() => expect(measured.ormWriters).toEqual([])).toThrow();
    }
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

`measureWritePopulation(files)` contains the SQL loop shown above plus a scan for `.<cath case model>.(create|update|updateMany|upsert|delete|deleteMany)(`; it returns sorted `updates`, `inserts`, `upserts`, `ormWriters` and `unclassified`. The production assertion and both synthetic tests call the same function. **Measure before trusting constants:** current `github/main` has exactly eight UPDATE literals, two INSERT literals, zero case-table upserts and zero ORM writers; after this design it should have nine UPDATE and two INSERT sites and still zero upsert/ORM sites. A shorter as well as longer population fails.

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

Revision 4 splits refresh into two functions. `resolveCaseLabReadinessCandidate` reads the case token/generation, tenant settings, results, orders and accepted evidence **without any case-row lock** and returns a candidate containing both fingerprints. `publishCaseLabReadinessCandidate` starts a tenant transaction, locks only the case `FOR NO KEY UPDATE`, rechecks `lifecycle_token`, `lab_readiness_generation`, and `policy_fingerprint`, then upserts projections/attempt evidence and increments the generation. A mismatch discards and retries from resolution; expensive evidence queries never run while the case lock is held. `getCase` and Staff loading read the cached projection immediately and enqueue refresh after the response; they never await resolution.

Add a real two-connection integration test: connection A pauses evidence resolution after its initial generation read; connection B posts a valid Start and must commit within 2 seconds while A remains paused; then A resumes, detects the generation/token mismatch and discards/retries without overwriting the started lifecycle. A companion test pauses A only inside the brief publish transaction and proves B may wait for that bounded lock. Use two independent pool connections—promises on one mocked transaction do not prove lock independence.

The end-to-end history test creates attempt 1, records consent/time-out evidence, starts, adds a procedure log, cancels, reopens, proves token rotation and stale-token refusal, records new evidence, starts attempt 2, then amends time-out/procedure-log data after Start. Assert two immutable at-start records with distinct tokens/attempt numbers; mutable follow-up remains attached to its own attempt; every procedure log has the correct attempt/token; the monthly report returns one row per start event joined to that attempt; no `metadata.previous_attempts` exists.

Route-level replay coverage posts the same Start command/token twice through `POST /cases/:id/status` and asserts the second 200 returns the original snapshot with no additional case/event/audit write. A second sequence captures token A before any Start, cancels and reopens the never-started case (token B), then delivers the first Start with token A and receives `CATH_LAB_LIFECYCLE_STALE`. Repeat the stale matrix for consent, time-out, draft log and finalized log; each asserts zero attempt/check/log writes.

Fingerprint tests use stable canonical JSON and cover: unchanged evidence ageing out (carry permitted); same-id status/timestamp/version correction (carry denied); withdrawal (denied); backwards version/timestamp (denied); policy-window or external-acceptance change (denied); bounded-lookback absence (`not_observed`, not withdrawal); and first population (`bootstrap`, not policy change). Preserve `last_accepted_evidence` independently when the live deciding row disappears.

Mutation 15's permanent proof is direct: after reopen and second Start, query `cath_lab_cases` and assert `status = 'in_progress' AND actual_end_at IS NULL`. Do not compare the cleared end with preserved first-start history.

- [ ] **Step 1: Write the failing unit tests for the late actions and the attempt discriminator**

In `cathLabReadinessService.test.js`, `describe('orderPriorityForUrgency')`: a started case orders `STAT` whatever its booked urgency (`orderPriorityForUrgency(urgency, { started: true })` for every urgency and `undefined`); `orderPriorityForUrgency('elective')` stays `NORMAL`. New: `isAfterCaseStart({ actual_start_at: '2026-09-06T03:10:00Z', attempt_start_recorded_at: null })` is **false** (attempt 2 not yet recorded as started) and `isAfterCaseStart({ attempt_start_recorded_at: '2026-09-06T03:10:00Z' })` is true even when clinical time is unknown.

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
  const startedMs = toMs(cathCase?.attempt_start_recorded_at_epoch_ms ?? cathCase?.attempt_start_recorded_at);
  return Number.isFinite(startedMs) && at > startedMs;
}
```

`orderMissingLabs`: remove the old started-case refusal; use `priority = orderPriorityForUrgency(urgency, { started: before.case_started })`, append the after-start note, and audit `ordered_after_start`. `recordExternalLabResult` likewise remains open and audits `recorded_after_start: isAfterCaseStart(cathCase)`. Every case read selects `attempt_start_recorded_at` and its epoch twin for operational lateness, plus nullable clinical `attempt_started_at` and provenance for clinical display.

- [ ] **Step 4: Implement the refresh** (spec §4.9 reads, §5.1, §5.6)

`caseRowTx` SELECT:

```sql
SELECT id, tenant_id, patient_uid, encounter_id, facility_id, status, urgency,
       actual_start_at, attempt_start_recorded_at, attempt_started_at,
       attempt_start_time_provenance, procedure_attempt, lifecycle_token,
       (EXTRACT(EPOCH FROM attempt_start_recorded_at) * 1000)::bigint AS attempt_start_recorded_at_epoch_ms,
       metadata->'readiness_at_start' AS readiness_at_start
  FROM cath_lab_cases …
```

(never `readiness_at_start_history`, never bare `metadata` — Task 5 adds the unit test that reads this SQL text.) `STORED_ITEM_SELECT` gains `unavailability_cause, window_days, classifier_initialized_at, evidence_fingerprint, policy_fingerprint, last_accepted_evidence`; the item upsert's column list, `VALUES` and `DO UPDATE SET` gain all six; `storedItemMatches` compares all six with canonical JSON comparison for `last_accepted_evidence`.

`refreshCaseLabReadiness` is split into `resolveCaseLabReadinessCandidate` and `publishCaseLabReadinessCandidate`. Resolution takes no case-row lock. It reads settings, the bounded result/order set, and—when `stored.last_accepted_evidence.result_id` is present—performs a direct id lookup returning exactly `{ kind: 'found', row }`, `{ kind: 'confirmed_missing' }`, or `{ kind: 'not_observed' }`. The direct row projection includes every fingerprint field: `id, performed_at, received_at, external_reported_on, updated_at, status, signed_off_at, result_origin, performed_by_lab, external_report_ref`, plus epoch twins used by the existing resolver. The candidate captures the case `lifecycle_token`, `lab_readiness_generation`, settings-derived `policy_fingerprint`, and every proposed item value.

In the per-item resolution loop, after `resolveItemState(...)`:

```js
      const decidingEvidence = decidingEvidenceFor(values, resultsForItem);
      const evidenceFingerprint = decidingEvidence ? evidenceFingerprintFor(decidingEvidence) : null;
      const policyFingerprint = policyFingerprintFor({
        itemCode: values.item_code, required: values.required, windowDays, settings,
      });
      values.unavailability_cause = classifyUnavailability({
        previous: stored, resolved: values, previousEvidenceLookup,
        evidenceFingerprint, policyFingerprint, settings, windowDays, asOf,
      });
      values.window_days = windowDays;
      values.evidence_fingerprint = evidenceFingerprint;
      values.policy_fingerprint = policyFingerprint;
      values.classifier_initialized_at = stored?.classifier_initialized_at ?? asOf;
      values.last_accepted_evidence = isItemAvailable(values, settings)
        ? {
            result_id: String(decidingEvidence.id),
            canonical: canonicalEvidence(decidingEvidence),
            evidence_fingerprint: evidenceFingerprint,
            policy_fingerprint: policyFingerprint,
            accepted_at: asOf.toISOString(),
          }
        : stored?.last_accepted_evidence ?? null;
```

where `resultsForItem` is the bounded candidate set and `windowDays` the effective policy window. `caseStartedAt` is the active attempt's recording-time epoch twin. `computeCheckDecision` receives cause, both live fingerprints and independently retained accepted evidence. The `auto_pass` audit records whether `attempt_start_recorded_at` was present.

Publication opens a short transaction, locks only the case projection `FOR NO KEY UPDATE`, and compares all captured `{ lifecycle_token, lab_readiness_generation, policy_fingerprint }` values before upserting items/checks and incrementing generation. Any mismatch discards the candidate and retries from resolution after commit; no result/order/direct-evidence query occurs under that lock. This separation is the contract exercised by exact test R4-3, not a timing promise about the scheduler.

```js
      case_started: Boolean(cathCase.attempt_start_recorded_at),
      procedure_attempt: Number(cathCase.procedure_attempt ?? 1),
      attempt_started_at: cathCase.attempt_started_at ?? null,
      first_started_at: cathCase.actual_start_at ?? null,
      started_with_readiness_pending: startedWithReadinessPending(cathCase.readiness_at_start),   // true | false | null
      readiness_at_start: normalizeStartSnapshot(cathCase.readiness_at_start),
```

`missing[]` on the block is `decision.missing` (now `{ item, state, cause }`); each item on the wire carries `unavailability_cause`. `refreshOpenCasesForPatient`: `WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND status NOT IN ('completed', 'cancelled')` — the three-status list and `actual_start_at IS NULL` go (spec §5.1).

- [ ] **Step 5: Run the unit suites** — `npm test -- --testPathPatterns "unit/cathLabReadinessService|unit/cathLabReadinessServiceOrders"`. PASS.

- [ ] **Step 6: Decision 9 — KEPT** (Task 0 Step 2 confirmed it)

In `cathLabReadiness.mjs`, remove the order-missing/external-result started-case 409s. Define `case_started` from active `attempt_start_recorded_at`; nullable clinical `attempt_started_at` is not the operational discriminator. The record-yes/lift-no waiver exception remains the sole `CATH_LAB_READINESS_CASE_STARTED` thrower.

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
  `SELECT status, actual_start_at, attempt_start_recorded_at, attempt_started_at,
          attempt_start_time_provenance, lifecycle_token, procedure_attempt, actual_end_at,
          metadata->'readiness_at_start' AS snapshot, metadata->'readiness_at_start_history' AS history, metadata->'start_commands' AS commands
     FROM cath_lab_cases WHERE tenant_id = $1::uuid AND id = $2::bigint`, TENANT, id).then((rows) => rows[0]);
const startAudits = (id) => prisma.$queryRawUnsafe(
  `SELECT id, metadata, actor_uid, role FROM audit_logs WHERE tenant_id = $1::uuid AND action = 'cath_lab.case.started_with_readiness_pending' AND resource_id = $2::text ORDER BY id`, TENANT, String(id));
const auditRows = (id, action) => prisma.$queryRawUnsafe(`SELECT metadata FROM audit_logs WHERE tenant_id = $1::uuid AND action = $3 AND resource_id = $2::text ORDER BY id`, TENANT, String(id), action);
const setCheck = async (id, checkType, status, metadata = {}, token = null) => {
  const expected = token ?? String((await caseRow(id)).lifecycle_token);
  return updateReadinessCheck(id, { tenantId: TENANT, check_type: checkType, status, metadata, expected_lifecycle_token: expected }, ctx());
};
const checkRow = (id, checkType) => prisma.$queryRawUnsafe(`SELECT status, completed_at, metadata FROM cath_lab_readiness_checks WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND check_type = $3`, TENANT, id, checkType).then((rows) => rows[0]);
// Lifted from the regime test's local `age(days)`, parameterised by patient.
const ageHgb = (days, patientUid = PATIENT) => prisma.$executeRawUnsafe(
  `UPDATE lab_results SET performed_at = NOW() - ($3::int * INTERVAL '1 day'), received_at = NOW() - ($3::int * INTERVAL '1 day')
    WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_code = 'HGB'`, TENANT, patientUid, days);
const start = async (id, extra = {}) => {
  const expected = extra.expected_lifecycle_token ?? String((await caseRow(id)).lifecycle_token);
  return transitionCaseStatus(id, { tenantId: TENANT, status: 'in_progress', command_id: CMD(), ...extra, expected_lifecycle_token: expected }, ctx());
};
const writeLog = async (id, input = {}, token = null) => {
  const expected = token ?? String((await caseRow(id)).lifecycle_token);
  return recordProcedureLog(id, { tenantId: TENANT, log_command_id: CMD(), expected_lifecycle_token: expected, ...input }, ctx());
};
```

Add `pollForItemOnCase(id, code, predicate)` and `labsCheckFor(id)` as case-parameterised twins of the existing helpers. Import `transitionCaseStatus`, `recordProcedureLog`, `reopenCase`, `createCase`, `updateReadinessCheck` from `cathLabService.js`; import `app` (or the cath router harness the route-guard suite uses) and `supertest` for the two route-level tests.

- [ ] **Step 8: The deep tests** — write them all; the ones the owner named are given in full

```js
  test('consent: pending / waived / not_applicable refuse both paths; emergency_basis starts; a legacy pass starts with consent_authority null', async () => {
    for (const consent of ['pending', 'waived', 'not_applicable']) {
      const id = await seedCase({ status: 'readiness_pending', consent });
      await expect(start(id, { reason: 'r' })).rejects.toMatchObject({ code: 'CATH_LAB_CONSENT_REQUIRED', details: { consent_status: consent } });
      await expect(writeLog(id, { procedure_type: 'PTCA', status: 'finalized', start_command_id: CMD() })).rejects.toMatchObject({ code: 'CATH_LAB_CONSENT_REQUIRED' });
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
    expect(['performed_after_clinical_start', 'performed_before_clinical_start', 'performance_unknown']).toContain(timeout.timing);
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
    await expect(writeLog(requested, { procedure_type: 'PTCA', status: 'finalized', start_command_id: CMD() }))
      .rejects.toMatchObject({ code: 'CATH_LAB_CASE_START_NOT_ELIGIBLE', details: { next_action: { body: { status: 'scheduled' } } } });
    const drafted = await seedCase({ status: 'scheduled', labs: 'pending' });
    await writeLog(drafted, { procedure_type: 'PTCA', status: 'draft' });
    expect(await caseRow(drafted)).toMatchObject({ status: 'scheduled', attempt_started_at: null, snapshot: null });
    await writeLog(drafted, { procedure_type: 'PTCA', status: 'finalized', start_command_id: CMD() });
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
    const firstStart = (await caseRow(id)).attempt_start_recorded_at;
    expect(new Date((await caseRow(id)).actual_start_at).getTime()).toBe(new Date(firstStart).getTime());
    await transitionCaseStatus(id, { tenantId: TENANT, status: 'cancelled', reason: 'Abandoned — access failed' }, ctx());
    await ageHgb(45, patient);
    await reopenCase(id, { tenantId: TENANT, reason: 'Second attempt via radial' }, ctx());
    const reopened = await caseRow(id);
    expect(reopened).toMatchObject({ status: 'readiness_pending', procedure_attempt: 2, attempt_start_recorded_at: null, attempt_started_at: null, snapshot: null });
    expect(new Date(reopened.actual_start_at).getTime()).toBe(new Date(firstStart).getTime());     // history kept
    expect(reopened.history).toHaveLength(1); expect(reopened.history[0].procedure_attempt).toBe(1);
    expect((await checkRow(id, 'consent')).status).toBe('pending');                               // reset on a NEW attempt
    expect(await attemptCheckRow(id, 1, 'consent')).toMatchObject({ procedure_attempt: 1, current_status: 'pass', at_start_status: 'pass' });
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
    expect(new Date(second.attempt_start_recorded_at).getTime()).toBeGreaterThan(new Date(firstStart).getTime());
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
    await start(id, { command_id: commandA });
    const replaySame = await start(id, { command_id: commandA });   // response lost → retry
    expect(replaySame).toMatchObject({ replayed: true, case: { status: 'in_progress' } });
    expect(await startAudits(id)).toHaveLength(0);
    await transitionCaseStatus(id, { tenantId: TENANT, status: 'cancelled', reason: 'Abandoned' }, ctx());
    await reopenCase(id, { tenantId: TENANT, reason: 'Again' }, ctx());
    await setCheck(id, 'consent', 'pass', { consent: { authority: 'patient', mode: 'written' } });
    await expect(start(id, { command_id: commandA, reason: 'old reason' }))
      .rejects.toMatchObject({ code: 'CATH_LAB_START_COMMAND_STALE', details: { command_attempt: 1, current_attempt: 2 } });
    expect((await caseRow(id)).status).toBe('readiness_pending');
    const commandB = CMD();
    await setCheck(id, 'timeout', 'pass', { timeout: { performed_at: new Date().toISOString() } });
    await start(id, { command_id: commandB });
    await start(id, { command_id: commandB });   // replay B → 200, nothing new
    expect((await caseRow(id)).commands).toHaveLength(2);
    await expect(start(id, { command_id: undefined })).rejects.toMatchObject({ code: 'CATH_LAB_START_COMMAND_REQUIRED' });
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

- [ ] **Step 8a: Add the four revision-4 decisive deep tests (exact names; no combined/renamed substitutes)**

1. `R4-1 replay and delayed first delivery are fenced on both start entry points`. Use four independently seeded, consent-valid cases. Case S: capture token S0, POST `/status` with command S, repeat the identical body/token, and assert the second response has `replayed: true`, the original snapshot, one command entry and one Start event. Case L: do the same through `/procedure-logs` with distinct log command L and Start command LS; assert one log and one Start. Case A: prepare status and finalized-log requests with token A0, Start attempt 1 with another command, cancel (assert A1 differs), reopen to attempt 2 (assert A2 differs), then first-deliver both A0 requests; each is 409 stale and changes no counts. Case N: prepare both request kinds with token N0, cancel before Start (N1), assert same-attempt readiness rows were rebound to N1 without evidence changes, then reopen while `procedure_attempt` remains 1 (N2) and assert they were rebound again to N2. Assert N0/N1/N2 are pairwise distinct; first-deliver both N0 requests and assert 409/no writes. Finally a fresh N2 command starts once. The test explicitly exercises the real route handlers.

2. `R4-2 lifecycle and readiness evidence remain attributable after reopen and metadata replacement`. Seed the case as `requested` and drive every reachable pre-start lifecycle transition before attempt 1; capture its token and byte-for-byte consent/time-out attempt rows; Start, add a log, cancel and reopen to attempt 2. First-deliver the captured attempt-1 consent body and assert stale/no write. Write attempt-2 time-out and a finalized log using the new token so the one Start path records attempt 2, then perform a replace-style readiness metadata update and complete the case. Assert attempt-1 bytes/evidence refs unchanged; attempt 2 alone contains the new timeout; all logs have the expected attempt/token. Query every lifecycle audit and canonical event emitted by the fixture—not a hand-picked type list—and assert each has server `case_id`, `procedure_attempt`, `lifecycle_token`, and recording time; cancel/reopen also have previous/resulting tokens. Assert no client-supplied attribution key survives.

3. `R4-3 a paused lab-evidence resolution cannot block Start or cached Staff load`. First, make the resolver promise never settle and assert `GET /cases/:id?readiness_mode=cached` returns the prior picture/Start affordance without invoking it. Then check out exactly two independent `pg` clients. Client A runs the resolution phase with a test barrier immediately after its evidence query (the fixture query uses `FOR SHARE` on the deciding `lab_results` row so A demonstrably holds an evidence lock) and before publication. Client B queries `pg_locks` to assert A owns no case-table row lock, then executes the valid Start transaction and must commit before a 2-second race while A stays behind the barrier. Release A; require publication to see token/generation drift and discard/re-resolve, leaving the Start snapshot unchanged. Close both clients in `finally`.

4. `R4-4 same-row correction breaks aged_out carry without misclassifying bootstrap or absence`. Seed one isolated patient's accepted HGB row R, refresh, advance/age R and refresh until persisted cause is `aged_out`. UPDATE the same R id's `performed_at`, `status` and `updated_at` to a corrected usable state; assert the evidence fingerprint changes, the cause no longer carries and the check recomputes. Correct R backward beyond the window and assert `corrected`, not `aged_out`. Restrict only the bounded resolver query while leaving direct id lookup available and assert internal `not_observed`, not `withdrawn`. Seed a migrated item with `window_days = NULL`, null fingerprints and null classifier marker; first refresh initializes it without `policy_changed`.

Focused mutation commands:

```bash
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R4-1 replay and delayed first delivery are fenced on both start entry points$'
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R4-2 lifecycle and readiness evidence remain attributable after reopen and metadata replacement$'
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R4-3 a paused lab-evidence resolution cannot block Start or cached Staff load$'
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R4-4 same-row correction breaks aged_out carry without misclassifying bootstrap or absence$'
```

Apply only the matching §12 mutation for each command, confirm that one selected test turns red, and revert before the next mutation.

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

**Privacy release condition.** Re-run a repository-wide function/caller search for `readCanonicalPatientTimeline`, canonical-event copying, notification rendering, JSON/CSV exports and nested projections. At fetched `github/main` `3d091a510`, there are exactly four direct production call sites: the guarded route handlers in `emr/clinicalTimelineRoutes.js` and `patient/patientSearchRoutes.js`, plus `handoverService.generateHandoverDraft` and `clinicalNotesService.getPatientTimeline` behind their clinical patient/note route guards. Pin that known count and fail if a synthetic fifth direct reader is added without classification. Sentinel-test nested `reason`, emergency justification, evidence references and provenance for every admitted role and export shape. `visible_to_patient = false` is necessary but not sufficient.

**Files:**
- Modify: `apps/backend/src/services/clinical/cathLabService.js` (`listCases`)
- Modify: `apps/backend/src/services/clinical/cathLabReadinessProjection.js`
- Modify: `apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs`
- Test: `apps/backend/src/tests/unit/cathLabReadinessProjection.test.js`, `apps/backend/src/tests/unit/cathLabReadinessOpenApiSource.test.js`, `apps/backend/src/tests/unit/serologyDisclosureCanary.test.js`, `apps/backend/src/tests/unit/cathLabReadinessService.test.js` (the "never selects history" text test), `apps/backend/src/tests/cath-lab-readiness.deep.test.js` (day-list key set)

- [ ] **Step 1: Projection tests** — as revision 1 (`readiness_at_start.reason` → `null` for a non-entitled role, every other key intact; entitled role reads the object unchanged; a `null` snapshot passes through; `projectStartReasonForRole` exported), plus: a block with `started_with_readiness_pending: null` keeps `null` after projection (the tri-state is not a free-text field and is never touched), and `readiness_at_start.consent_authority` / `lab_component_status` / `missing_lab_items: null` survive projection unchanged.

- [ ] **Step 2: Implement the projection** — as revision 1 (`hasSnapshot` joins the guard; `projected.readiness_at_start = { ...snapshot, reason: null }`). Header comment: the snapshot's codes, causes, enums and booleans are checklist provenance; the reason is typed at the table and may name a value.

- [ ] **Step 3: Day list — two columns and the TRI-state fold** (spec §6.2)

`listCases` SELECT gains `c.procedure_attempt, c.lifecycle_token, c.attempt_start_recorded_at, c.attempt_started_at, c.attempt_start_time_provenance, c.lab_readiness_generation,` and, beside `c.updated_at,`:

```sql
            CASE WHEN jsonb_typeof(c.metadata->'readiness_at_start'->'blocking') = 'array'
                 THEN jsonb_array_length(c.metadata->'readiness_at_start'->'blocking') > 0
                 ELSE NULL END AS started_with_readiness_pending,
```

`ELSE NULL`, not `ELSE FALSE`: `NULL` is "not documented", never "no pending checks" (mutation 8 collapses this). Fold: `lab_readiness_summary: summary ? { ...summary, started_with_readiness_pending: row.started_with_readiness_pending ?? null } : null`, delete the scalar from the row, keep the two columns on the row (the `CathLabCase` schema gains them). The raw `metadata` column is still not selected. Update the deep test `'the case list carries the STORED readiness summary'` key-set array (+`started_with_readiness_pending`) and add a deep assertion that a case seeded `in_progress` with no snapshot lists `null`, a clean start lists `false`, a pending start lists `true`.

**Text test** (in `cathLabReadinessService.test.js`, textual): the SQL literals of `caseRowTx` and `listCases` contain `metadata->'readiness_at_start'` (or the `->'blocking'` path) and **do not** contain `readiness_at_start_history` or `\bc\.metadata,` / `SELECT \*` — the history is for the audit and the timeline, never for the block or the list (spec §6.4).

- [ ] **Step 4: OpenAPI overlay** (`cathLabReadiness.mjs`)

- `CathLabCase`: required `procedure_attempt`, server `lifecycle_token`, nullable `attempt_start_recorded_at`, nullable clinical `attempt_started_at`, nullable provenance, and integer `lab_readiness_generation`.
- `item.required` gains `'ordered_after_start', 'received_after_start', 'finalised_after_start', 'unavailability_cause'`; properties: three booleans with the spec's descriptions (**`received_after_start` = the deciding row was RECEIVED here after the active attempt's start; a row received before and signed after reads false — a receipt marker, transaction-start ordering**; `finalised_after_start` from `signed_off_at`, false unless signed); `unavailability_cause: { type: 'string', enum: UNAVAILABILITY_CAUSES, nullable: true }` imported from the rules module.
- `missing[]` items: `required: ['item', 'state', 'cause']`, `cause` the same nullable enum.
- `readiness.required` gains `procedure_attempt`, server-issued `lifecycle_token`, `attempt_start_recorded_at`, nullable clinical `attempt_started_at`, `attempt_start_time_provenance`, `first_started_at`, `started_with_readiness_pending`, and `readiness_at_start`. The snapshot declares exactly the 15 `START_SNAPSHOT_KEYS`, including both clocks/provenance and lifecycle token. `started_with_readiness_pending` remains tri-state; null is unknown, never clean.
- `case_started` description: Task 4 Step 6's text.
- Readiness-check write prose requires `expected_lifecycle_token` for consent/time-out. Patient/representative consent uses approved mode+evidence+scope; representative adds `representative_ref`; emergency basis uses approved `document_ref` or `justification`+`attested` and rejects `mode`. Server-owned provenance/policy/time/history fields are rejected. A time-out pass requires `{ outcome: 'performed', performed_at }`; `{ outcome: 'not_performed', attested: true }` stays non-pass; absence is `not_documented` / `performance_unknown`.
- `operations` gains **four** prose-only entries (`pathParameters: { id: BIGINT_WIRE }` where applicable, no `request` / `response`):
  - `'POST /api/v1/cath-lab/cases'` — `status` must be one of `CREATABLE_STATUSES` (400 `CATH_LAB_CASE_STATUS_NOT_CREATABLE`); a case is never created running or finished; `procedure_attempt` / `attempt_started_at` are not accepted; reserved metadata keys are stripped. (If the creation operation is already documented elsewhere in the overlay set, add the prose there and keep the pin's `PROSE_ONLY` count honest.)
  - `'POST /api/v1/cath-lab/cases/{id}/status'` — Start requires `command_id` and `expected_lifecycle_token`; same-command/same-token replay is checked before transition eligibility, token mismatch is 409, and cancellation rotates the token. The response exposes the next server token. The start reads cached readiness and never awaits evidence resolution.
  - `'POST /api/v1/cath-lab/cases/{id}/procedure-logs'` — every log requires `log_command_id` and `expected_lifecycle_token`; duplicate detection precedes INSERT. A finalized log on a start-eligible case also requires an independent Start `command_id` and uses the one start path; its clinical `started_at` needs provenance or remains unknown. Draft/amended logs never start; the remaining status table is unchanged.
  - `'POST /api/v1/cath-lab/cases/{id}/reopen'` — cancelled only; reason and idempotency key required; always rotates the lifecycle token; if server recording proves a prior Start, opens attempt N+1 and resets current consent/time-out while preserving server-owned attempt history. It never accepts history/provenance from a client and never starts.
- Day-list prose: `started_with_readiness_pending` is the seventh summary key and is tri-state.
- **`CASE_LIFECYCLE_ERROR_CODES`** (spec §9): a second exported enum listing `CATH_LAB_CONSENT_REQUIRED`, `CATH_LAB_CONSENT_AUTHORITY_REQUIRED`, `CATH_LAB_CONSENT_AUTHORITY_NOT_PERMITTED`, `CATH_LAB_CONSENT_POLICY_UNAVAILABLE`, `CATH_LAB_TIMEOUT_PERFORMED_AT_REQUIRED`, `CATH_LAB_TIMEOUT_OUTCOME_INVALID`, `CATH_LAB_TIMEOUT_ATTESTATION_REQUIRED`, `CATH_LAB_START_REASON_REQUIRED`, `CATH_LAB_START_COMMAND_REQUIRED`, `CATH_LAB_START_COMMAND_STALE`, `CATH_LAB_START_COMMAND_CONFLICT`, `CATH_LAB_LIFECYCLE_TOKEN_REQUIRED`, `CATH_LAB_LIFECYCLE_STALE`, `CATH_LAB_PROCEDURE_LOG_COMMAND_REQUIRED`, `CATH_LAB_PROCEDURE_LOG_COMMAND_CONFLICT`, `CATH_LAB_START_VIA_INVALID`, `CATH_LAB_CASE_STATUS_NOT_CREATABLE`, `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED`, `CATH_LAB_CASE_START_NOT_ELIGIBLE`, `CATH_LAB_REOPEN_REASON_REQUIRED`, `CATH_LAB_REPORT_MONTH_INVALID`, `CATH_LAB_REPORT_FACILITY_INVALID`, `CATH_LAB_REPORT_AUDIT_FAILED` — documented on the four prose-only operations and (Task 6) the two report operations; exported through `ENUMS` for the pin.

In `cathLabReadinessOpenApiSource.test.js`: `PROSE_ONLY` gains the four keys; the readiness key-set assertion gains the five keys; the item key set is derived by driving the resolver (it picks the four new keys up by construction — confirm the `required` list matches); `it('readiness_at_start declares exactly START_SNAPSHOT_KEYS; its check_type enum is migration 482\'s; its cause enum is migration NNN\'s')` — parse `NNN_cath_lab_case_attempts.sql`'s `cath_case_lab_readiness_items_cause_check` list the way the file already parses 482's type CHECK and compare to `UNAVAILABILITY_CAUSES`; **the second scan**: `/'(CATH_LAB_(?:CONSENT|TIMEOUT|START|LIFECYCLE|PROCEDURE_LOG|CASE_STATUS|CASE_CANCELLED|CASE_START|REOPEN|REPORT)_[A-Z_]+)'/g` over `cathLabService.js`, `cathLabReadinessRules.js`, `cathStartsWithPendingReportService.js` (Task 6 — add the file then) and the cath router, compared to `CASE_LIFECYCLE_ERROR_CODES` **in both directions**; the existing `CATH_LAB_READINESS_*` scan and its scope are unchanged.

Run `npm test -- --testPathPatterns unit/cathLabReadinessOpenApiSource` → PASS (it will list `CATH_LAB_REPORT_*` as documented-but-unraised until Task 6 — either add those two to the enum in Task 6 or accept a red here that Task 6 turns green; say which in the commit message). Then `npm run openapi:generate && npm run openapi:check`; commit the regenerated `src/docs/openapi.json` and `packages/vhhealth_core/swagger/openapi.json`.

- [ ] **Step 5: Canary — five free-text sentinels, CSV bodies, the write mirror** (spec §6.4, §6.5)

- Sentinels: distinct constants for start reason, prior-attempt start reason, reopen reason, copied cancel reason, and emergency-basis justification.
- `CASE_ROW` includes attempt 2, server lifecycle token, recording and clinical clocks/provenance, generation, first-start history, tri-state flag and a complete 15-key current snapshot. Server-owned snapshot history carries the prior reason only on entitled write responses; every readiness item includes lateness booleans, cause, both fingerprints and retained accepted evidence.
- `disclosures(body, contentType)`: for CSV, scan the response text; otherwise scan the serialized JSON and nested payloads. Assert each of the five sentinels appears only for its entitled positive control and never for any non-entitled role/export. Any `readiness_at_start_history` on a general read surface is also a failure.
- Positive control (`'the poison really is in the persistence layer'`): CATH_LAB_STAFF on `GET /api/v1/cath-lab/cases/:id/readiness/labs` reads `readiness_at_start.reason === START_REASON_SENTINEL`, `started_with_readiness_pending: true`, `missing_lab_items: ['hbsag']`, `procedure_attempt: 2`, and every item has the four booleans and a cause key.
- Liveness: RECEPTIONIST on the same route answers 200 with `readiness_at_start.reason === null`, the same `blocking`, `missing_lab_items`, `consent_authority` and `lab_component_status`, and the booleans on every item.
- **Write mirror**: `POST /api/v1/cath-lab/cases/:id/reopen` as CATH_LAB_STAFF (with the case fixture `cancelled` for that call and an `Idempotency-Key`) answers 2xx whose `RETURNING *` body contains `HISTORY_REASON_SENTINEL` inside `metadata.readiness_at_start_history` — positive control that the history exists and is reachable by the **entitled** workflow role only; RECEPTIONIST on the same POST answers 403 (route role), never a body.
- Summary key set (`'the case LIST really carries a readiness summary'`): + `started_with_readiness_pending`, asserted `true` for the fixture; a second list fixture with no snapshot asserts `null`.
- Timeline readers: pin the measured four direct production callers and drive the reachable role matrix for both direct routes and both service-mediated routes. Positive/liveness pairs cover all five sentinels in direct and nested payloads; `visible_to_patient = false` remains separately asserted but cannot replace reader projection tests.

Run: `npm test -- --testPathPatterns unit/serologyDisclosureCanary`. Expected: PASS with **no** reachable-set change yet (the report routes come in Task 6; the reopen route is a POST and adds none).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/services/clinical/cathLabService.js apps/backend/src/services/clinical/cathLabReadinessProjection.js apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs apps/backend/src/docs/openapi.json packages/vhhealth_core/swagger/openapi.json apps/backend/src/tests/unit/cathLabReadinessProjection.test.js apps/backend/src/tests/unit/cathLabReadinessOpenApiSource.test.js apps/backend/src/tests/unit/serologyDisclosureCanary.test.js apps/backend/src/tests/unit/cathLabReadinessService.test.js apps/backend/src/tests/cath-lab-readiness.deep.test.js
git commit -m "feat(cath): readiness picture — lifecycle and attempt clocks, fingerprinted items, five free-text sentinels and complete reader survey

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

Revision-4 control: report rows are Start events joined to `cath_lab_attempt_readiness_records` on tenant + case + `procedure_attempt` from the immutable event snapshot. They never join `cath_lab_readiness_checks`. The query selects `at_start_*` and same-attempt `current_*` into separate fields; no `COALESCE` crosses that boundary. `start_recorded_at` comes from the immutable snapshot, nullable `clinical_started_at` stays separate, and `audit_logs.created_at` is only the range/order key. Report access uses a dedicated `recordCathReadinessReportAccessTx({ tenantId, ... })` that inserts an explicit `tenant_id` and propagates every failure; the existing best-effort `logAudit` helper is not admissible because current `logAudit` catches errors and its INSERT does not bind `tenant_id`. No response body or CSV bytes are sent until that audit transaction commits.

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
  test('converts the BOUNDS, never the column; binds tenant, bounds, facility; joins the timeout ATTEMPT record', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);
    await startsWithPendingReport({ tenantId: TENANT, month: '2026-09', facilityId: '4' });
    const [sql, tenant, start, end, facility] = queryRawUnsafe.mock.calls[0];
    expect(sql).toContain("a.created_at >= ($2::timestamptz AT TIME ZONE 'UTC')");
    expect(sql).toContain("a.created_at <  ($3::timestamptz AT TIME ZONE 'UTC')");
    expect(sql).not.toMatch(/\(a\.created_at AT TIME ZONE/);           // mutation 27
    expect(sql).toContain("($4::int IS NULL OR NULLIF(a.metadata->>'facility_id', '')::int = $4::int)");
    expect(sql).toMatch(/LEFT JOIN cath_lab_attempt_readiness_records t/);
    expect(sql).toMatch(/t\.procedure_attempt = NULLIF\(a\.metadata->>'procedure_attempt'/);
    expect(sql).not.toMatch(/JOIN cath_lab_readiness_checks/);
    expect(sql).toMatch(/t\.at_start_metadata->'timeout' AS timeout_at_start_meta/);
    expect(sql).toMatch(/t\.current_metadata->'timeout' AS timeout_followup_meta/);
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
    expect(report.timeout_outcomes).toEqual({ not_pending_at_start: 1, performed_before_clinical_start_documented_late: 1, performed_after_clinical_start: 0, not_performed: 0, not_documented: 1, performance_unknown: 0 });
    expect(report.consent_authorities).toEqual({ patient: 1, legally_authorised_representative: 0, emergency_basis: 1, not_recorded: 1 });
    expect(report.rows[0]).toMatchObject({ start_event_id: 88121, case_id: 1201, procedure_attempt: 2, start_recorded_at: expect.any(String), clinical_started_at: expect.any(String), timeout_at_start_status: 'pending', timeout_followup_status: 'pass', timeout_outcome: 'performed_before_clinical_start_documented_late', consent_authority: 'emergency_basis' });
    expect(report.rows[2]).toMatchObject({ missing_lab_items: null, lab_component_status: 'unavailable', timeout_outcome: 'not_documented', consent_authority: null });
  });
  test('a legacy audit row (revision-1 snapshot shape) reads procedure_attempt 1, lab_component_status unavailable, missing_lab_items null — never a clean start', …);
});
describe('projection and CSV', () => {
  test('reason blanked for QUALITY_OFFICER, kept for ADMIN, key set unchanged', …);
  test('CSV: the 25 columns in order, start clocks and timeout phases separate, lists joined with ;, nulls empty, reason neutralised, CRLF', () => {
    expect(lines[0]).toBe('month,start_event_id,case_id,procedure_attempt,facility_id,facility_name,urgency,via,start_recorded_at,clinical_started_at,blocking_check_types,missing_lab_items,lab_component_status,consent_authority,timeout_at_start_status,timeout_at_start_performed_at,timeout_at_start_documented_at,timeout_followup_status,timeout_followup_performed_at,timeout_followup_documented_at,timeout_outcome,reason,actor_uid,actor_role,actor_name');
    …
  });
});
```

roleHelpers test as revision 1.

- [ ] **Step 2: Run to verify they fail** — module not found.

- [ ] **Step 3: Implement roles and the service** — roles as revision 1. The service:

```js
export const START_AUDIT_ACTION = 'cath_lab.case.started_with_readiness_pending';
export const CSV_COLUMNS = Object.freeze(['month', 'start_event_id', 'case_id', 'procedure_attempt', 'facility_id', 'facility_name', 'urgency', 'via',
  'start_recorded_at', 'clinical_started_at', 'blocking_check_types', 'missing_lab_items', 'lab_component_status', 'consent_authority',
  'timeout_at_start_status', 'timeout_at_start_performed_at', 'timeout_at_start_documented_at',
  'timeout_followup_status', 'timeout_followup_performed_at', 'timeout_followup_documented_at',
  'timeout_outcome', 'reason', 'actor_uid', 'actor_role', 'actor_name']);
const TIMEOUT_OUTCOMES = ['not_pending_at_start', 'performed_before_clinical_start_documented_late', 'performed_after_clinical_start', 'not_performed', 'not_documented', 'performance_unknown'];

function facilityFilter(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw AppError.badRequest('facility_id must be a positive integer', 'CATH_LAB_REPORT_FACILITY_INVALID');
  return n;
}
// The time-out's outcome for ONE Start event (spec §7.3), from its immutable
// snapshot and its exact attempt record. Absence never means non-performance.
function timeoutOutcomeFor(meta, row) {
  const blocking = Array.isArray(meta.blocking) ? meta.blocking.map((b) => b?.check_type) : [];
  if (!blocking.includes('timeout')) return 'not_pending_at_start';
  const followup = row.timeout_followup_meta ?? {};
  const outcome = followup?.outcome;
  if (outcome === 'not_performed' && followup?.attested === true) return 'not_performed';
  if (outcome !== 'performed') return row.timeout_documented_at ? 'performance_unknown' : 'not_documented';
  const performed = toMs(followup?.performed_at);
  const documented = toMs(row.timeout_documented_at);
  const clinical = toMs(meta.clinical_started_at);
  const recorded = toMs(meta.recorded_at);
  if (!Number.isFinite(performed)) return 'performance_unknown';
  if (!Number.isFinite(clinical)) return 'performance_unknown';
  if (performed > clinical) return 'performed_after_clinical_start';
  return Number.isFinite(documented) && documented > recorded ? 'performed_before_clinical_start_documented_late' : 'performance_unknown';
}
function rowFrom(row) {
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const snapshot = normalizeStartSnapshot(meta) ?? {};      // the audit metadata carries the snapshot keys flat (…snapshot)
  return {
    start_event_id: Number(row.start_event_id), case_id: Number(row.case_id), procedure_attempt: snapshot.procedure_attempt ?? 1,
    facility_id: row.facility_id == null ? null : Number(row.facility_id), facility_name: row.facility_name ?? null,
    urgency: snapshot.urgency, via: snapshot.via,
    start_recorded_at: snapshot.recorded_at ?? null, clinical_started_at: snapshot.clinical_started_at ?? null,
    blocking_check_types: snapshot.blocking.map((b) => String(b.check_type)), missing_lab_items: snapshot.missing_lab_items,   // null = unknown
    lab_component_status: snapshot.lab_component_status, consent_authority: snapshot.consent_authority,
    timeout_at_start_status: row.timeout_at_start_status ?? null,
    timeout_at_start_performed_at: row.timeout_at_start_meta?.performed_at ?? null,
    timeout_at_start_documented_at: row.timeout_at_start_documented_at == null ? null : new Date(row.timeout_at_start_documented_at).toISOString(),
    timeout_followup_status: row.timeout_followup_status ?? null,
    timeout_followup_performed_at: row.timeout_followup_meta?.performed_at ?? null,
    timeout_followup_documented_at: row.timeout_documented_at == null ? null : new Date(row.timeout_documented_at).toISOString(),
    timeout_outcome: timeoutOutcomeFor(meta, row),
    reason: snapshot.reason, actor_uid: row.actor_uid ?? null, actor_role: row.actor_role ?? null, actor_name: row.actor_name ?? null,
  };
}
export async function startsWithPendingReport({ tenantId, month, facilityId } = {}) {
  const tid = requireTenantId(tenantId);
  const { start, end } = monthBoundsIst(month);
  const facility = facilityFilter(facilityId);
  const rows = await setTenant(tid, (client) => client.$queryRawUnsafe(
    `SELECT a.id AS start_event_id, a.created_at AS event_created_at, a.actor_uid, a.role AS actor_role, u.name AS actor_name,
            a.resource_id AS case_id, a.metadata,
             f.id AS facility_id, f.display_name AS facility_name,
             t.at_start_status AS timeout_at_start_status,
             t.at_start_completed_at AS timeout_at_start_documented_at,
             t.at_start_metadata->'timeout' AS timeout_at_start_meta,
             t.current_status AS timeout_followup_status,
             t.current_completed_at AS timeout_documented_at,
             t.current_metadata->'timeout' AS timeout_followup_meta
       FROM audit_logs a
       LEFT JOIN facilities f ON f.tenant_id = a.tenant_id AND f.id = NULLIF(a.metadata->>'facility_id', '')::int
       LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.uid = a.actor_uid
       LEFT JOIN cath_lab_attempt_readiness_records t
         ON t.tenant_id = a.tenant_id
        AND t.case_id = NULLIF(a.resource_id, '')::bigint
        AND t.procedure_attempt = NULLIF(a.metadata->>'procedure_attempt', '')::int
        AND t.check_type = 'timeout'
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
  return rowsToCsv([...CSV_COLUMNS], report.rows.map((row) => [report.month, row.start_event_id, row.case_id, row.procedure_attempt, row.facility_id, row.facility_name, row.urgency, row.via,
    row.start_recorded_at, row.clinical_started_at, row.blocking_check_types.join(';'), row.missing_lab_items == null ? '' : row.missing_lab_items.join(';'), row.lab_component_status, row.consent_authority,
    row.timeout_at_start_status, row.timeout_at_start_performed_at, row.timeout_at_start_documented_at,
    row.timeout_followup_status, row.timeout_followup_performed_at, row.timeout_followup_documented_at,
    row.timeout_outcome, row.reason, row.actor_uid, row.actor_role, row.actor_name]));
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
      await recordCathReadinessReportAccessTx({
        tenantId,
        actorUid: req.user?.uid ?? null,
        actorRole: role,
        action: 'cath_lab.report.starts_with_pending.read',
        resource: 'cath_lab_report',
        resourceId: 'starts-with-pending',
        metadata: { month: report.month, facility_id: report.facility_id, format, total_events: report.total_events, distinct_cases: report.distinct_cases, mount },
      });
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

`recordCathReadinessReportAccessTx` uses `setTenantTx(tenantId, ...)` and a parameterized `INSERT INTO audit_logs (tenant_id, uid, role, action, resource, resource_id, metadata, actor_uid, created_at) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $2::uuid, NOW())`. It does not catch. Registration remains on both mounts, with the cath route placed before the parameterized report route.

- [ ] **Step 6: Route-order, role, tenant and fail-closed probes**: admitted roles receive 200 only after one explicit-tenant audit insert; denied roles receive 403; malformed parameters receive 400; a forced audit INSERT rejection returns an error with no JSON or CSV body emitted; two tenants cannot observe each other's report-access rows. Cover both mounts and both formats.

- [ ] **Step 7: OpenAPI** — `CathLabStartsWithPendingRow` (the 25 row keys: separate `start_recorded_at`/nullable `clinical_started_at`, six separate timeout-at-start/follow-up fields, plus `timeout_outcome`; `missing_lab_items` nullable, `consent_authority` nullable enum, `lab_component_status` enum), `CathLabStartsWithPendingReport` (`month`, `facility_id` nullable, `total_events`, `distinct_cases`, `facilities[]` with `events` + `cases`, `timeout_outcomes`, `consent_authorities`, `rows[]`), envelope; both operations with `parameters: month (required, pattern), facility_id (optional, integer ≥ 1), format (json|csv)`; description states: **identifiable operational data** (case ids resolve to patients; actors named), counts start **events** not distinct cases, IST month, reason projected, every read audited (`cath_lab.report.starts_with_pending.read`, `format` recorded), 400 codes in prose; `READS` gains both; `CATH_LAB_REPORT_*` in `CASE_LIFECYCLE_ERROR_CODES`; add `cathStartsWithPendingReportService.js` to the lifecycle scan's file set. `npm run openapi:generate && npm run openapi:check`.

- [ ] **Step 8: Canary** — seed a start audit with all 15 snapshot keys and a matching `cath_lab_attempt_readiness_records` timeout row for that exact attempt. Probe both report mounts as JSON and CSV, verify the same two reachable-route additions, positive-control the entitled reason, and prove non-entitled roles see projected nulls in nested JSON and empty CSV cells.

- [ ] **Step 9: Deep** — after the point-4 test's second start (attempt 2, pending): `startsWithPendingReport({ tenantId: TENANT, month: clinicalDate(new Date()).slice(0, 7) })` contains a row with that `start_event_id` (the audit row's id), `procedure_attempt: 2`, `consent_authority: 'patient'`, a `timeout_outcome` in the enum, and `distinct_cases ≤ total_events`; `facilityId: FACILITY_ID` returns the same row, a non-existent facility returns none; through the route, one GET on each mount → **two** `audit_logs` rows with `action = 'cath_lab.report.starts_with_pending.read'`, `metadata.mount` differing, and a third with `format: 'csv'` after a CSV read; `reportToCsv` has ≥ 2 lines.

- [ ] **Step 9a: Add the revision-4 decisive report test**

In `cath-lab-readiness.deep.test.js`, add exactly `R4-5 report history is attempt-scoped and preserves unknown and both clocks`. Seed case A with labs pending and time-out pending. Start attempt 1 through a finalized procedure log whose `started_at` is absent and whose server provenance is `retrospective_time_unknown`; capture the report row and its Start snapshot. Cancel/reopen, document an attempt-2 performed time-out, Start attempt 2 through `/status`, and query again. Assert the attempt-1 row is byte-stable for its timeout/start fields, remains `not_documented`, has `start_recorded_at` equal to its snapshot, and has `clinical_started_at: null`; assert attempt 2 alone carries the performed follow-up and has separate at-start/follow-up fields. Seed case B with an explicit `{ outcome: 'not_performed', attested: true }` on the event's attempt and assert only B maps to `not_performed`. Assert the generated SQL names `cath_lab_attempt_readiness_records`, all three join keys and both `at_start_*`/`current_*`, and does not name `cath_lab_readiness_checks`.

```bash
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R4-5 report history is attempt-scoped and preserves unknown and both clocks$'
```

Mutation: replace the attempt-table join with the current check-by-case join and map its absent outcome to `not_performed`. The one selected test must fail both the attempt-1 stability and unknown assertions; revert before continuing.

- [ ] **Step 10: The EXPLAIN gate** (spec §7.2 — "a few hundred report rows ≠ a few hundred audit rows examined")

```bash
# seed: ≥ 100 000 audit_logs rows across several actions/months and TWO tenants;
# target tenant-month selectivity 1–5%, followed by ANALYZE
psql "$DATABASE_URL" -f "$SCRATCH/seed-audit-explain.sql"     # write it: generate_series inserts; keep it out of the repo
psql "$DATABASE_URL" -c "EXPLAIN (ANALYZE, BUFFERS) <the exact query text with the bounds bound as literals and \$4 = NULL>"
```

Acceptance is bounded work, not a fixed plan-node name: the execution must touch no other tenant, return the independently counted events, use no spill/temp I/O, and keep shared hit+read blocks at no more than `max(64, ceil(relation_blocks × 0.10))`. A sequential scan is acceptable only when those bounds hold; an index scan is insufficient if it reads unbounded blocks. Paste `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, seed cardinalities and computed bounds into rollout evidence. If bounds fail, add the measured tenant/action/time index in a new free migration; never rewrite NNN after publication.

- [ ] **Step 11: Commit**

```bash
git add apps/backend/src/utils/roleHelpers.js apps/backend/src/services/clinical/cathStartsWithPendingReportService.js apps/backend/src/routes/clinical/cathStartsWithPendingReportHandler.js apps/backend/src/routes/clinical/cathLabRoutes.js apps/backend/src/routes/clinical/cathReprocessingPolicyRoutes.js apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs apps/backend/src/docs/openapi.json packages/vhhealth_core/swagger/openapi.json apps/backend/src/tests/unit/cathStartsWithPendingReportService.test.js apps/backend/src/tests/unit/cathLabReadinessOpenApiSource.test.js apps/backend/src/tests/unit/serologyDisclosureCanary.test.js apps/backend/src/tests/fixtures/serologyDisclosureCanary.reachable.json apps/backend/src/tests/unit/cathLabRouteGuards.test.js apps/backend/src/tests/cath-lab-readiness.deep.test.js
# plus the roleHelpers unit test file
git commit -m "feat(cath): monthly starts-with-pending report — start events with attempt id, facility scope, time-out and consent breakdowns, audited on both mounts, bounds-converted predicate with EXPLAIN gate, CSV

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
## Task 7: Staff app — Start / Reopen, live updates over `staff:lab`, consent authority, time-out instants, the picture

**Revision-4 load/realtime contract.** Opening a case renders the server's cached readiness projection immediately and schedules refresh without awaiting it. After a publish transaction commits, the backend emits a case-scoped event carrying `case_id`, `lifecycle_token`, and monotonically increasing `lab_readiness_generation`. Staff coalesces bursts with a trailing debounce **and** a maximum 2-second wait, fetches the case, and applies a response only when its token matches and its generation is not older than the displayed generation. Reconnect performs an unconditional case reload before resubscribing. Tests cover commit → emission → delivery → fetch → render, a burst that cannot postpone refresh forever, disconnect/reconnect catch-up, and an older response arriving after a newer one.

**Files:**
- Modify: `apps/staff/lib/features/cath_lab/models/cath_readiness_models.dart`, `services/cath_lab_api_service.dart`, `widgets/cath_readiness_checklist.dart`, `widgets/cath_lab_readiness_panel.dart`, `screens/cath_lab_screen.dart`, `apps/staff/lib/l10n/app_strings.dart`
- Test: `apps/staff/test/features/cath_lab/cath_readiness_checklist_test.dart`, `cath_lab_screen_test.dart`, `apps/staff/test/i18n_guard_test.dart`

- [ ] **Step 1: Models — failing parse tests** — cover `procedure_attempt`, server `lifecycle_token`, `attempt_start_recorded_at`, nullable clinical `attempt_started_at`, provenance, generation, tri-state snapshot with all 15 keys, fingerprints, conditional consent records, time-out outcome plus clinical/recording instants, and server-owned attempt history. `started` is true from `attempt_start_recorded_at`, not historical `actual_start_at` or nullable clinical time.

- [ ] **Step 2: Models — implement** — include both attempt clocks/provenance, lifecycle token, generation, 15-key snapshot, conditional consent evidence, time-out outcome, item fingerprints and read-only server attempt history. Attempt history has no client serializer. `started` derives from `attemptStartRecordedAt` (with `caseStatus == in_progress` only as a defensive inconsistency warning), and every attempt-specific API call posts the latest token as `expected_lifecycle_token`.

- [ ] **Step 3: API**

```dart
  /// POST /cath-lab/cases/:id/status with in_progress. [commandId] is the stable
  /// per-decision token the server binds to the attempt (CATH_LAB_START_COMMAND_
  /// REQUIRED without it; CATH_LAB_START_COMMAND_STALE if the case was reopened
  /// since). Mint it ONCE per confirmation with IdempotencyKey.generate() and
  /// reuse it on every retry — the caller owns it, this method never mints.
  static Future<void> startCase(int caseId, {required String commandId, required String expectedLifecycleToken, String? reason}) async {
    await apiClient.post('/api/v1/cath-lab/cases/$caseId/status', body: {
      'status': 'in_progress', 'command_id': commandId,
      'expected_lifecycle_token': expectedLifecycleToken,
      if (reason?.trim().isNotEmpty == true) 'reason': reason!.trim(),
    });
  }
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
  testWidgets('consent form follows authority-conditional policy and emergency basis has no mode', (tester) async {
    // Patient/representative require mode, evidence and scope; representative
    // also requires representative_ref. Emergency hides mode and requires an
    // approved document reference or justification plus attestation. Assert
    // the posted map has no emergency mode and its caption never says consent.
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
- **Start row** (`_StartRow`, key `cath-readiness-start`) uses a command id minted once per confirmation and the lifecycle token captured from the same displayed server response. Retries reuse both. `CATH_LAB_LIFECYCLE_STALE` or command conflict forces reload and a fresh review; the client never invents or edits a token. Reason/Start-definition/picture behavior remains as specified above.
- **Reopen row** (`cath-readiness-reopen`) when `caseStatus == 'cancelled'`: dialog body `reopen_body` + `reopen_new_attempt_note` when `readiness.attemptStartRecordedAt != null || readiness.firstStartedAt != null`; the server remains authoritative. Reopen keeps its existing idempotency-attempt convention and refreshes the returned server lifecycle token.
- **Banners**: `startedWithReadinessPending == true` → amber `cath-readiness-started-pending-banner` (checks from `readinessAtStart.blocking` + `missingLabItems`, `· lab picture unavailable at start` when `missingLabItems == null`); `== null && started` → muted `cath-readiness-start-undocumented`; `false` → nothing. Critical banner as revision 1.
- **Chips**: documentation lateness compares server `documentedAt` with `attemptStartRecordedAt`; clinical performance compares `performedAt` with nullable `attemptStartedAt`. The UI presents `performed_before_clinical_start`, `performed_after_clinical_start`, `not_documented`, explicit `not_performed`, or `performance_unknown` without collapsing the two clocks.
- **Consent form** is built from the approved server policy with no client default. Patient and representative show required mode, evidence reference and scope; representative also requires representative reference. Emergency basis hides/rejects mode and requires either an approved document reference or justification plus an attestation control. Every write sends `expected_lifecycle_token`; captions never call emergency basis “consent obtained.” Legacy server-marked rows display read-only provenance and require a fresh governed record to change.
- **Time-out form** makes the outcome explicit. Performed sends `{ outcome: 'performed', performed_at }`; not performed sends `{ outcome: 'not_performed', attested: true }` and does not mark the check passed. Empty/pending displays “not documented / performance unknown,” never “not performed.” Show clinical occurrence separately from server recording/documentation time and send `expected_lifecycle_token`.
- **Picture line** `cath-readiness-picture-as-of` (`picture_as_of` `{time}`) + `picture_paused` suffix when `connectionState != connected` (subscribed through `connectionStates`).
- **Live updates**: in `initState` / when the loaded case is started, `_labSub = _labEvents('staff:lab').listen(_onLabEvent)` with a 400 ms debounce into `_reload()`; cancel on dispose and when the case is no longer started. Pre-start: no subscription.

`cath_lab_readiness_panel.dart`: `showOrderMissing = labs.orderableNow.isNotEmpty;` `canEnterExternal = !item.available;` (drop `!labs.caseStarted` from both; un-waive keeps #1018's gate on `caseStarted`, which now means the active attempt); item chip `cath-lab-item-after-start-<code>` when any of the three booleans is true; the item caption shows the cause label when set (`item.unavailability_cause` → `s4.lib.cath_lab.readiness.cause.<cause>`; add the seven keys to the string list below if you render them — otherwise render the raw code in a muted style and note it).

`cath_lab_screen.dart`: `RealtimeStatusBanner(watchChannels: const {'staff:code-stemi', 'staff:lab'}, …)`; `_headerSignals` reads the tri-state (`== true` only) for the chip.

- [ ] **Step 6: Strings (five locales; hi/ta/te/ml carry `// REVIEW: AI first-pass cath readiness never-restricts (rev 2) - confirm wording before production.`)**

Under `s4.lib.cath_lab.readiness.`, implement exactly **53 keys × 5 locales**: revision 2's 40 with the emergency caption's `{mode}` placeholder removed, plus 13 keys for evidence reference, scope, representative reference, emergency document reference, emergency justification, emergency attestation, `not_documented`, `performance_unknown`, `not_performed`, clinical start time, server recording time, reconnecting, and stale-response suppression. The guard pins the exact key set and placeholder signatures in all locales.

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

- [ ] **Step 1: Failing test** — use the revision-4 report shape (`total_events`, `distinct_cases`, `facilities[].events/cases`, `timeout_outcomes`, `consent_authorities`, rows with `start_event_id`, `procedure_attempt`, separate `start_recorded_at`/nullable `clinical_started_at`, six separate time-out phase fields, `lab_component_status`, `consent_authority`, `timeout_outcome`, `missing_lab_items: null` rendered as "unknown"): renders the identifiability header text; the per-facility table; the two breakdown blocks; the rows with attempt and outcomes; a projected-null reason as a dash; changing the month re-queries; choosing a facility from the `Facility` select re-queries with `facilityId`; Download CSV calls the export with `(month, facilityId)`.

- [ ] **Step 2: API helpers** — `getCathStartsWithPendingReport(month, facilityId?)` and `downloadCathStartsWithPendingCsv(month, facilityId?)` (`apiFetch` from `../api-fetch`, `Accept: text/csv`); the `CathStartsWithPendingRow` / `CathStartsWithPendingReport` interfaces with the exact revision-4 25-column row keys.

- [ ] **Step 3: The tab and the page** — `"use client"`; month input (`aria-label="Month"`); facility `<select aria-label="Facility">` fed from the current report's `facilities[]` (plus "All"); header: "This report identifies cases and operators. It counts start events (one row per start; a reopened case can appear more than once) from the start audit trail. The authority to proceed can never be undocumented here. The reason column is shown to the clinical audience only."; KPI line `total_events` / `distinct_cases`; facilities table (`events`, `cases`); breakdown blocks for `timeout_outcomes` and `consent_authorities`; rows table (start event id, case id, attempt, facility, urgency, via, recorded start, clinical start or "unknown", time-out at start, same-attempt follow-up, blocking, missing items or "unknown", lab picture status, consent authority, time-out outcome, reason or —, actor); Download CSV via the `lib/exportToCsv.ts` anchor helper. `page.tsx`: `TABS` gains `{ key: "starts-with-pending", label: "Starts with checks pending", icon: AlertTriangle }`.

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

**Deployment gate (not authorized by this plan/PR).** A later authorized rollout must: save the read-only inconsistency/writer inventory; block cath mutations and prove zero old writers; execute NNN's internal expand → classified backfill → enforcement sequence as one controlled migration run with no application started between phases; deploy only the token-aware backend; verify non-default-tenant audit, cached load, token rotation and attempt joins; then reopen ingress and deploy clients. A failure before NNN commits rolls the migration back. After it commits, keep the schema and roll forward; never restart an incompatible old writer. Dev/test fixture repair follows fixture ownership, and production-like rows require approved per-row disposition.

- [ ] **Step 1: Merge main; re-check the migration number**

```bash
git fetch github '+refs/heads/*:refs/remotes/github/*'
git merge --no-ff github/main -m "chore: merge main into feat/cath-readiness-never-restricts [full-ci]"
for ref in $(git for-each-ref --format='%(refname)' refs/remotes/github/); do git ls-tree --name-only "$ref" apps/backend/src/migrations/ 2>/dev/null; done | sed -E 's#.*/([0-9]+)_.*#\1#' | sort -n | uniq | tail -2
```

This lane NEVER takes 767 - it is reserved for the Phase 1 isolation-derivation lane whether or not a `767_*` file exists yet (absence of a file is not evidence the number is unclaimed). Before pushing, compute `NNN = max(highest migration number on any github/* branch, 767) + 1` and apply it everywhere (file, `schema.prisma` comment, the OpenAPI pin's parse path, the spec cross-references in the PR body) — this branch has never been pushed, so nothing is immutable yet.

- [ ] **Step 2: Backend gates**

```bash
cd apps/backend
npm run lint
npm test -- --testPathPatterns unit/                       # the FULL unit corpus
npm test -- --runInBand --testPathPatterns cath-lab-case-attempts-migration.deep
npm run openapi:check && npm run check:migration-numbers && npm run check:migration-immutability   # LIVE: NNN is claimed
DATABASE_URL=… node scripts/check-schema-drift.mjs
cd ../.. && node scripts/ci/security.mjs
```

Read `Suites failed` separately from `Tests passed`.

- [ ] **Step 3: Two fresh-DB deep runs** — as revision 1 (`cath-lab-case-attempts-migration.deep|cath-lab-readiness.deep|cath-reporting.deep|lab-signoff-safety.deep|bloodborne-markers.deep`); both green with identical counts; record the counts and the EXPLAIN plan (Task 6 Step 10) for the PR body.

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
15. Drop `actual_end_at = NULL` from reopen, then Start attempt 2 → the direct end-state assertion (`in_progress` implies `actual_end_at IS NULL`) and lifecycle CHECK red; no comparison with preserved first-start history.
16. Restore `CASE_STATUSES` in `createCase` → the creation unit test, the route-level deep test **and** the INSERT pin red.
17. Delete the `=== 'cancelled'` short-circuit in `transitionCaseStatus` → the generic-status unit loop (`scheduled` → `INVALID_STATE_TRANSITION`), the generic-bypass deep test, and the order pin red.
18. Replace the explicit `!== 'cancelled'` in `reopenCaseTx` with the table check alone → the `scheduled` iteration of the reopen loop (unit + deep) red.
19. Let a draft log start the case (`START_LOG_STATUSES = ['draft','finalized']`) → the draft unit and deep tests red.
20. Do not increment `procedure_attempt` on reopen of a started attempt → the owner's point-4 deep test red (snapshot attempt 1; history; audit row).
21. Compare operational markers/regime against `actual_start_at` or nullable clinical `attempt_started_at` instead of `attempt_start_recorded_at` → the pre-attempt-2 and clinical-time-unknown cases red.
22. Acquire the case row lock before lab evidence resolution → the real two-connection test exceeds the 2-second Start bound.
23. Return `[]` instead of `null` for missing item rows → the unknown-picture unit test red and the report legacy-row test red.
24. Decide age-only from cause/state without matching both fingerprints to retained accepted evidence → same-id correction, policy-change and withdrawal tests red.
25. Drop lifecycle token from the command binding → delayed attempt-1 delivery starts or mutates the reopened lifecycle; sequence test red.
26. Say "Consent obtained" for `emergency_basis` → the Staff caption test red.
27. Transform the column instead of the bounds in the report predicate → the SQL-text unit test red **and** the EXPLAIN gate fails (seq scan).
28. Use best-effort `logAudit`, omit explicit tenant binding, or catch the audit error → fail-closed audit and cross-tenant tests red.
29. Skip the consent/time-out reset on reopen → the attempt-2 `CATH_LAB_CONSENT_REQUIRED` assertion red.
30. Persist no `unavailability_cause` → the two-refresh stability assertion red.
31. Splice the table name into `startCaseTx`'s UPDATE through `${…}` → the population pin red (eight UPDATE sites, not nine) **and** the SQL-shape pin red (three lines, not four) — the drift an exact-list assertion catches and a subset check cannot.
32. Validate the ordinary transition before dispatching `in_progress` → same-command replay on an already-running case returns invalid transition; replay-reachability test red.
33. Reuse Start `command_id` as log idempotency or insert before checking `log_command_id` → duplicate-log/conflict tests red.
34. Omit lifecycle fencing from consent, time-out or draft logs → stale-token matrix red for the mutated writer.
35. Stamp snapshot/event/case with separate clock reads → exact-instant equality test red.
36. Infer clinical start from retrospective log insertion time → clinical-time-unknown provenance test red.
37. Map a pending time-out to `not_performed` → outcome unit/report test red.
38. Permit emergency consent `mode`, or omit evidence/scope for patient/representative → conditional-policy matrix red.
39. Treat bounded-lookback absence as withdrawal or bootstrap as policy change → fingerprint classifier tests red.
40. Join the report to current readiness checks rather than the event attempt record → attempt-1-after-attempt-2-amendment report test red.
41. Remove maximum-wait/reconnect/stale-generation guards from Staff realtime → burst, reconnect or out-of-order widget test red.
42. Add a synthetic cath case writer or `ON CONFLICT` site without updating the exact population inventory → new-writer pin red.
43. R4-1 only: omit the never-started cancellation's attempt-record token rebind → run `-t '^R4-1 replay and delayed first delivery are fenced on both start entry points$'`; exactly that selected test is red on N0→N1→N2 evidence attribution.
44. R4-2 only: remove attempt/token from the governed attempt-record mutation predicate → run `-t '^R4-2 lifecycle and readiness evidence remain attributable after reopen and metadata replacement$'`; exactly that selected test is red on the attempt-1 byte comparison.
45. R4-3 only: move the case `FOR NO KEY UPDATE` before evidence resolution → run `-t '^R4-3 a paused lab-evidence resolution cannot block Start or cached Staff load$'`; exactly that selected test is red on `pg_locks`/the two-second Start bound.
46. R4-4 only: carry `aged_out` by result id while ignoring the canonical evidence fingerprint → run `-t '^R4-4 same-row correction breaks aged_out carry without misclassifying bootstrap or absence$'`; exactly that selected test is red on the backward same-row correction.
47. R4-5 only: join time-out follow-up by current case projection instead of tenant/case/attempt → run `-t '^R4-5 report history is attempt-scoped and preserves unknown and both clocks$'`; exactly that selected test is red on attempt-1 byte stability and unknown outcome.
48. R4-6 only: synthesize a missing recording time from `created_at` and bypass the unresolved-disposition abort → run `-t '^R4-6 migration refuses unresolved legacy contradictions and preserves only evidenced history$'`; exactly that selected test is red on rollback and no-invented-time assertions.

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
  --title "feat(cath): the pre-cath readiness checklist informs and records, never restricts (owner decisions 2026-09-06, revision 4)" \
  --body-file "$SCRATCH/rr-pr-body.md"
```

The implementation PR body records the exact migration number and fetched base SHA; the seven owner-review rows plus further corrections; the measured writer population (including INSERT/upsert); replay/lifecycle-token order; two-connection lock proof; attempt-history and report join proof; both clocks and one recording instant; fingerprint matrix; conditional consent policy approval; staged migration receipts; fail-closed tenant audit; realtime/reconnect evidence; bounded-work EXPLAIN evidence; and privacy-reader survey. It remains draft and explicitly says implementation awaits owner design approval; merge authority stays outside this lane.

- [ ] **Step 8: Drop the scratch DBs** — `dropdb -h 127.0.0.1 -p 55432 vh_crr_<initials>` (and `_1`, `_2`).

---

## Self-review against the spec (revision 4)

- **Owner 1:** status normalization and cancelled refusal precede Start dispatch; Start dispatch precedes ordinary transition validation; command replay precedes eligibility; lifecycle token fences Start/consent/time-out/log; log idempotency is separate; cancel/reopen rotate the token; delayed-first-delivery tests exist.
- **Owner 2:** evidence resolution holds no case lock; publication is generation-checked and brief; cached GET/Staff loading does not await refresh; the proof uses two real database connections.
- **Owner 3:** attempt evidence is server-owned and keyed by tenant/case/attempt; procedure logs store attempt/token; report joins the event attempt; the deep path covers attempt 1 → cancel/reopen → attempt 2 → amendment.
- **Owner 4:** absence maps to `not_documented` / `performance_unknown`; explicit attestation alone yields `not_performed`; nullable clinical occurrence is distinct from server recording; one database instant feeds projection, snapshot, command, audit and event.
- **Owner 5:** age-only carry requires both fingerprints to match retained accepted evidence; same-id correction, withdrawal, backwards change, bounded-lookback absence and bootstrap have named tests.
- **Owner 6:** consent evidence is conditional on authority; emergency basis has no mode; provenance, policy, actor, recording and legacy markers are server-owned; clinical/legal policy approval gates release.
- **Owner 7:** Task 0 inventories inconsistent rows and all writers; Task 1 expands, classifies/backfills and enforces only after old-writer quiescence; CHECK tests explicitly prove consent is not a database constraint.
- **Further corrections:** mutation 15 directly asserts the final end-field invariant; report audit is explicit-tenant/fail-closed; realtime tests span commit through render, reconnect, maximum wait and stale response; EXPLAIN uses cardinality/buffer bounds rather than a fixed node; writer pins assert the known current population and catch a synthetic addition; privacy surveys all current readers and nested/exported projections.
- **Revision-4 decisive evidence:** the six exact acceptance tests are independently selectable, each has a concrete fixture/trace/outcome and a single focused mutation that makes only that selected test red; the spec names the same test beside its mechanism.
- **Baseline:** every code claim is rechecked by function name against fetched `github/main` `3d091a510bc5214ddc251cd4106ca967e36c7340`; the cited cath functions are unchanged from revision 3's reference.
- **Type consistency:** `startCaseTx` takes command plus expected lifecycle token and both clinical/provenance inputs; `buildStartSnapshot` has exactly 15 ordered keys; operational rules use `attempt_start_recorded_at`; report and Staff use the same lifecycle/attempt/outcome vocabulary.
