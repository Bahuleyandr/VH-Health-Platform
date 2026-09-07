# Cath Readiness Never Restricts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pre-cath readiness checklist inform and record instead of restrict: any `scheduled` / `readiness_pending` / `ready` case may start with checks pending once the applicable authority is documented; the checklist keeps living after start with lateness marked, a cancelled case has an audited door back, and a monthly report of starts-with-pending exists — per the owner decisions of 2026-09-06 and the final clinical/product decisions of 2026-09-07. These decisions are not implementation, activation, merge, or deployment approval.

**Architecture (revision 6):** One transactional `startCaseTx` remains behind the independent explicit Start action and the eligible finalized-log path; draft/amended logs never invoke it. Every lifecycle-changing command—Start, cancel, complete and reopen—and every attempt-specific write requires the expected server lifecycle token under the case lock. Server attribution records which attempt changed; the token proves which lifecycle the user intended. A recorded-start reopen creates N+1 and resets current consent/time-out without altering history; a pre-start reopen retains attempt/evidence and only rotates/rebinds the lifecycle fence. Both case and attempt records store nullable clinical `attempt_started_at` separately from operational `attempt_start_recorded_at`. Prior-attempt consent evidence requires approved-policy permission and a server-recorded applicability confirmation. `emergency_basis` never stores communication mode. Start and human readiness mutations invalidate in-flight candidates by incrementing `lab_readiness_generation`; publication has explicit lock/statement timeouts, a fixed lock order, and a dirty/no-op contract. One internal accepted-evidence type drives age-only carry; waivers are separate. Time-out remains non-blocking and retains its explicit outcome and both clocks. Finalized-log delivery/replay use `start_command_id` and finish common side effects before returning. The new attempt table is born with both platform RLS policies. Realtime forwards one generation field and Staff may adopt a new token only on an authoritative response. Report access for `CATH_LAB_INCHARGE` is tenant-wide with facility filtering; report month uses the stored/indexed bound Start recording instant.

**Tech Stack:** Node 26 ESM backend (Express 5, Prisma raw SQL on Postgres 17, jest with `--experimental-vm-modules`), Flutter Staff app, Next.js Admin console, OpenAPI overlay scripts.

**Spec:** `docs/superpowers/specs/2026-09-06-cath-readiness-never-restricts-design.md` — **revision 6 (2026-09-07)**. Read it first. This plan contains one operative version of each function and contract; obsolete executable examples have been removed or rewritten.

**Revision-2/3/4 requirements retained.** The prior reviews remain binding: first-start history versus active attempts, non-blocking live readiness, reachable replay, attempt records, nullable unknown snapshots, consent/time-out re-confirmation on a new attempt, event-based reporting, conditional consent, migration preflight, complete writer pins, privacy survey, and the six prior evidence controls.

### Revision-6 owner-decision map

| Owner decision | Operative plan section | Exact named acceptance test |
|---|---|---|
| 1. Draft never starts; explicit emergency Start is independent. | Task 3 Steps 3/8; Task 4 Step 8a | `R6-1 draft logs never start and emergency Start is independent` |
| 2. Only a recorded-start reopen creates N+1/reset; pre-start reopen retains evidence; prior-document reuse is governed and confirmed. | Task 3 Steps 4/6; Task 4 Step 8a | `R6-2 started reopen resets current evidence and preserves attempt history`; `R6-2 pre-start reopen retains evidence and rotates lifecycle` |
| 3. Both case and attempt records carry nullable clinical Start plus required operational Start recording time. | Tasks 1–3; Task 4 Step 8a; Tasks 6–7 | `R6-3 retrospective log records server Start with unknown clinical time` |
| 4. Report access is tenant-wide with facility filtering, not facility authorization. | Task 6; Task 8 | `R6-4 report access is tenant-wide and facility filter only narrows` |
| 5. Mode is patient/representative-only; emergency basis has no mode; prior evidence reuse records applicability. | Tasks 2–4; Task 7 | `R6-5 emergency basis stores no consent mode and prior evidence reuse is confirmed` |
| 6. Governed authority is the only Start block across urgency categories; roles/signature/waiver rules stay fixed. | Tasks 3–4; Task 7 | `R6-6 documented authority is the only Start block across urgency categories` |

### Revision-5 owner-return map retained

| Owner section | Operative plan change | Exact acceptance test |
|---|---|---|
| 1. Migration | Task 1 consumes the signed row-hash manifest inside NNN, preserves a valid never-started cancellation, and maps an evidenced reopen or explicit unknown attribution. | `R4-6 migration manifest preserves valid cancellation and evidenced reopen` |
| 2. Lifecycle | Task 3 requires/compares the token for cancel, complete and reopen as well as Start; Task 4 first-delivers old commands. | `R5-2 delayed lifecycle commands cannot cross a lifecycle token` |
| 3. Candidate | Tasks 3–4 bump the generation on Start/human edits, reject old candidates, bind publication timeouts and test connection progress. | `R4-3 paused candidate is invalidated and cannot block Start` |
| 4. Age-only | Task 2 defines one internal accepted-evidence type, waiver separation and baseline calendar-date canonicalization; Task 4 advances the clock without changing rows. | `R4-4 age-only carry uses complete accepted evidence` |
| 5. Time-out | Tasks 3/6 persist the performed outcome and map immutable at-start evidence, equality and unknown chronology correctly. | `R4-5 timeout history preserves outcome and clock uncertainty` |
| 6. Consent | Task 3 revalidates attempt status/projection, exact still-approved policy and evidence binding; fixtures use governed writers. | `R5-6 Start enforces governed consent attempt evidence` |
| 7. Finalized log | Task 3 uses `start_command_id` on first/replay, requires retrospective attestation, and returns after common side effects. | `R5-7 finalized-log first delivery and replay share one contract` |
| 8. RLS/privacy | Task 1 writes both dev-1b policies and real-role matrix; Tasks 4/5 keep fingerprints/evidence server-only and close five free-text fields. | `R5-8 attempt table is fail-closed under vhhealth_app` |
| 9. Realtime | Tasks 4/7 change `emitLabEvent`, test the delivered payload/no-op rule, and separate token adoption from stale suppression. | `R5-9 realtime delivers generation and survives remote reopen` |
| 10. Clocks | Tasks 2/3 require DB evaluation time and one bound Start instant; Task 6 stores/indexes that instant for month selection. | `R5-10 report month follows bound Start recording time` |
| 11. Reconciliation | Tasks 3/4/6/9 fix bind count, snapshot keys, BIGINT strings, reads, writer-guard scope and three-phase mutation evidence. | `R5-11 operative snippets preserve bind counts snapshots and bigint ids` |

### Decisive acceptance tests and executable mutation receipts

Each row below is a top-level Jest `test(...)`; therefore the full name is exactly the literal shown. The runner passes the literal anchored `-t` pattern in that row's second column, parses Jest JSON, and requires the same test to be the only selected test in all three phases: unmodified `selected=1, passed=1`; mutated `selected=1, failed=1` at the named assertion id; restored `selected=1, passed=1`. Every phase must have zero compile, suite and hook failures. Zero selection or an unrelated failure is invalid evidence.

| Assertion id | Exact full test name / exact `-t` pattern | Intended mutation and assertion |
|---|---|---|
| `r4-1-command-replay` | `R4-1 replay and delayed first delivery are fenced on both start entry points` / `^R4-1 replay and delayed first delivery are fenced on both start entry points$` | Break Start/log replay request binding; immutable replay assertion fails. |
| `r4-2-attribution` | `R4-2 lifecycle and readiness evidence remain attributable after reopen and metadata replacement` / `^R4-2 lifecycle and readiness evidence remain attributable after reopen and metadata replacement$` | Omit attempt/token from governed update; archived-byte assertion fails. |
| `r4-6-manifest` | `R4-6 migration manifest preserves valid cancellation and evidenced reopen` / `^R4-6 migration manifest preserves valid cancellation and evidenced reopen$` | Restore blanket cancellation abort or ignore the signed manifest; preservation assertion fails. |
| `r5-2-lifecycle` | `R5-2 delayed lifecycle commands cannot cross a lifecycle token` / `^R5-2 delayed lifecycle commands cannot cross a lifecycle token$` | Omit token comparison from cancel, complete or reopen; delayed-delivery assertion fails. |
| `r4-3-candidate` | `R4-3 paused candidate is invalidated and cannot block Start` / `^R4-3 paused candidate is invalidated and cannot block Start$` | Omit Start generation bump or lock evidence under the case row; generation/progress assertion fails. |
| `r4-4-age` | `R4-4 age-only carry uses complete accepted evidence` / `^R4-4 age-only carry uses complete accepted evidence$` | Drop classification/policy equality or dereference waived evidence; carry/waiver assertion fails. |
| `r4-5-timeout` | `R4-5 timeout history preserves outcome and clock uncertainty` / `^R4-5 timeout history preserves outcome and clock uncertainty$` | Drop `outcome: performed` or manufacture `blocking: []`; outcome/unknown assertion fails. |
| `r5-6-consent` | `R5-6 Start enforces governed consent attempt evidence` / `^R5-6 Start enforces governed consent attempt evidence$` | Trust projection pass without governed policy/evidence; Start-refusal assertion fails. |
| `r5-7-log` | `R5-7 finalized-log first delivery and replay share one contract` / `^R5-7 finalized-log first delivery and replay share one contract$` | Read `input.command_id`, auto-label provenance or return before common side effects; first/replay parity assertion fails. |
| `r5-8-rls` | `R5-8 attempt table is fail-closed under vhhealth_app` / `^R5-8 attempt table is fail-closed under vhhealth_app$` | Remove the restrictive policy or positive control; isolation assertion fails. |
| `r5-9-realtime` | `R5-9 realtime delivers generation and survives remote reopen` / `^R5-9 realtime delivers generation and survives remote reopen$` | Drop payload field/no-op guard/request epoch; delivered-state assertion fails. |
| `r5-10-clock` | `R5-10 report month follows bound Start recording time` / `^R5-10 report month follows bound Start recording time$` | Filter/order by audit `created_at` or default the classifier clock; month assertion fails. |
| `r5-11-executable` | `R5-11 operative snippets preserve bind counts snapshots and bigint ids` / `^R5-11 operative snippets preserve bind counts snapshots and bigint ids$` | Add reopen surplus bind, default snapshot blocking, or coerce BIGINT to Number; exact-value assertion fails. |
| `r6-1-draft-independent` | `R6-1 draft logs never start and emergency Start is independent` / `^R6-1 draft logs never start and emergency Start is independent$` | Let draft save call `startCaseTx`, or make emergency Start require a finalized log; lifecycle/count assertion fails. |
| `r6-2-started-reset` | `R6-2 started reopen resets current evidence and preserves attempt history` / `^R6-2 started reopen resets current evidence and preserves attempt history$` | Carry consent into N+1, omit time-out reset, or alter attempt-N bytes; reset/history assertion fails. |
| `r6-2-prestart-retain` | `R6-2 pre-start reopen retains evidence and rotates lifecycle` / `^R6-2 pre-start reopen retains evidence and rotates lifecycle$` | Increment the attempt, reset evidence, or fail to rebind the token; identity/evidence assertion fails. |
| `r6-3-two-clocks` | `R6-3 retrospective log records server Start with unknown clinical time` / `^R6-3 retrospective log records server Start with unknown clinical time$` | Fill clinical Start from log recording time or omit the attempt recording clock; clock assertion fails. |
| `r6-4-report-scope` | `R6-4 report access is tenant-wide and facility filter only narrows` / `^R6-4 report access is tenant-wide and facility filter only narrows$` | Treat facility as an authorization boundary or omit tenant/role/audit enforcement; access/population assertion fails. |
| `r6-5-consent-shape` | `R6-5 emergency basis stores no consent mode and prior evidence reuse is confirmed` / `^R6-5 emergency basis stores no consent mode and prior evidence reuse is confirmed$` | Accept/store emergency mode or reuse prior evidence without the server confirmation; shape/provenance assertion fails. |
| `r6-6-authority-only` | `R6-6 documented authority is the only Start block across urgency categories` / `^R6-6 documented authority is the only Start block across urgency categories$` | Consult readiness/urgency/signature outside `assertConsentDocumented`, or bypass it; per-urgency Start/refusal assertion fails. |

The machine-readable receipt schema is `{ schema: 'cath-readiness-mutation/v1', test_file, test_full_name, pattern, mutation_id, phases: { unmodified, mutated, restored } }`. Each phase records `{ selected, passed, failed, suite_failures, hook_failures, compile_failures, assertion_ids, exit_code, source_sha256 }`; the runner checks clean source, restores exact bytes in `finally`, verifies the hash, and only then runs the restored control.

### Revision-3 task map retained

| Owner review item | Controlling plan work |
|---|---|
| 1. Reachable replay and a server lifecycle fence | Task 3 dispatches Start replay before ordinary transition validation, uses distinct Start/log command identities, and fences Start, consent, time-out and procedure logs with a server-issued `lifecycle_token`; Task 4 proves delayed first delivery cannot affect a reopened lifecycle. |
| 2. Lock-independent refresh | Task 3 resolves lab evidence outside the case lock and publishes under a short generation-checked transaction; Task 7 makes Staff render cached readiness immediately; Task 4 uses two database connections to prove Start is not blocked by refresh resolution. |
| 3. Attempt history end to end | Task 1 creates server-owned attempt records and log provenance; Task 3 writes them transactionally; Task 6 reports by attempt; Task 4 covers attempt 1, cancel/reopen, attempt 2 and later amendment. |
| 4. Time-out and clocks | Tasks 2–3 distinguish `not_documented` / `performed_timing_unknown` from explicit `not_performed`, preserve clinical occurrence separately from recording, and reuse one database recording timestamp for projection, snapshot and event; Task 6 reports the distinction. |
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

**One activation approval remains intentionally external.** The owner has settled the procedure-start meaning, new-attempt reconfirmation rules, conditional emergency shape, and tenant-wide `CATH_LAB_INCHARGE` report access with facility filtering. Clinical/legal owners must still approve each tenant's authority-conditional evidence policy, including prior-attempt evidence reuse, before activation; implementation does not invent that policy.

---


> **Migration number.** `NNN` = the next free migration number ABOVE 767 at push time (768 unless claimed). **767 is NOT this lane's:** it is reserved by the merge-authority session's Phase 1 isolation-derivation lane (dev-1b). Task 0 must re-check the free number when the branch is pushed; any lane that claims a number it does not own collides with the immutability gate.

## Conventions

All of Plan 3's conventions apply (tenant transactions, raw SQL, `AppError`, npm-run jest, immutable migrations, scratch DB, commit trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`, `[full-ci]` on the last commit, draft PR, no merge — merge authority is dev-1b). Plus:

- **Verified code reference is current `github/main` at `e9bd6675dfb21ef5a1ef1540b24a406e31d28202` (or a newer fetched head at implementation time).** Task 0 re-verifies every named function before editing.
- **Cite by function name.** Line numbers are illustrative; grep the function.
- **Every operational "started" read uses the ACTIVE attempt's server recording instant:** `attempt_start_recorded_at` (and its epoch twin), never `actual_start_at`. `attempt_started_at` is nullable clinical occurrence; `actual_start_at` is the first server-recorded start and is never rewritten.
- **Post-start suppression is decided only by a matching accepted evidence-and-policy fingerprint whose classified cause is `aged_out`, never by `state === 'stale'`.** Bootstrap and bounded-lookback absence are not policy change or withdrawal.
- **Never widen the picture with a value.** New payload keys are booleans, codes, causes, enums or instants. There are exactly **five** free-text fields (spec §6.5), including emergency-basis justification; each has an explicit reader matrix, projection and sentinel.
- **migration NNN is claimed.** Reserve it in Task 1, re-check before the first push (Task 9), `NNN = max(highest number on any github/* branch, 767) + 1` - never 767 (reserved for the Phase 1 lane even before its file exists); never edit a migration after it is on a remote (add a new number instead).
- **Fixtures with `<col>_at` carry `<col>_at_epoch_ms`** (`epochTwinFixtureFidelity.test.js`), derived from the same instant.
- **Documentation examples use a zeroed UUID (`00000000-0000-4000-8000-000000000000`) or a `<lifecycle-token>` marker, never a random-looking token, so no future allowlist entry is needed.**
- **Every new error code** in the `CATH_LAB_(CONSENT|TIMEOUT|START|CLINICAL_START|LIFECYCLE|PROCEDURE_LOG|CASE_STATUS|CASE_CANCELLED|CASE_START|REOPEN|REPORT)_*` family must be in `CASE_LIFECYCLE_ERROR_CODES` (Task 5) — the scan is bidirectional, so an undocumented code and a documented-but-unraised code both fail.
- **Every verdict over a set proves population first.** Assert the expected size and that it is non-zero before iterating, folding, or applying `every`/`some`; an empty population is a failing fixture, never evidence that a control passed.
- **No `git stash`, no `git restore`; commit with pathspecs.**
- Backend commands run from `apps/backend`; `npm test -- --testPathPatterns <pattern>`; deep suites need `DATABASE_URL`. Read `Suites failed` separately from `Tests passed` — `Suites failed` with `Tests passed` is a hook failure, not a pass.

---

## File structure

| File | Responsibility |
|---|---|
| Create `apps/backend/src/migrations/NNN_cath_lab_case_attempts.sql` | Expand with lifecycle/recording/provenance columns, attempt-keyed readiness history, procedure-log attempt/token/idempotency columns and evidence/policy fingerprints; classify legacy data, backfill without inventing clinical occurrence, then enforce only after old-writer quiescence. |
| Modify `apps/backend/prisma/schema.prisma` | Mirror every migration-NNN column/table after the enforced phase (schema-drift gate). |
| Modify `apps/backend/src/services/clinical/cathLabReadinessRules.js` | Key operational timing on `attempt_start_recorded_at`; preserve nullable clinical occurrence; classify `not_documented`, `performed_timing_unknown` and explicit `not_performed`; retain accepted evidence/policy fingerprints independently from the live observation. |
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
git rev-parse github/main            # 1c970c16e17cb524a966994848625af070a2498a or later; record the fetched SHA in the PR body
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
: "${CATH_READINESS_SCRATCH_DATABASE_URL:?set CATH_READINESS_SCRATCH_DATABASE_URL to a dedicated empty Postgres database URI}"
createdb "$CATH_READINESS_SCRATCH_DATABASE_URL"
cd "$SCRATCH/wt/rr-impl/apps/backend"
DATABASE_URL="$CATH_READINESS_SCRATCH_DATABASE_URL" npm run test:db:setup
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

Known at fetched `github/main` `1c970c16e`: `recordCanonicalClinicalEvent` writes `visible_to_patient` **only** when the input says `true`, and `writeCanonicalEvent` never sets it. The complete direct production caller search for `readCanonicalPatientTimeline` finds exactly four sites: `emr/clinicalTimelineRoutes.js` and `patient/patientSearchRoutes.js` behind `patientAccessGuard`; `handoverService.generateHandoverDraft`, reached by the route guarded with `guardClinicalPatientView`; and `clinicalNotesService.getPatientTimeline`, reached by the route guarded with `guardClinicalNoteView`. Re-run the route/function search at implementation time, record every nested projection/copy/CSV/notification consumer, and fail the release survey if the measured caller set differs without a reviewed projection decision. For each reachable role, prove `payload.reason`, `payload.readiness_at_start.reason`, emergency justification, evidence references and provenance are absent unless `roleSeesSerologyDetail` (or the narrower approved predicate) admits them. Cath events remain `visible_to_patient = false`, but that writer flag is not a substitute for surveying readers. Survey evidence and sentinel tests are a release condition, not a best-effort note.

- [ ] **Step 10: The lifecycle error-code scan on the base tree**

```bash
grep -rnoE "'CATH_LAB_(CONSENT|TIMEOUT|START|CASE_STATUS|CASE_CANCELLED|CASE_START|REOPEN|REPORT)_[A-Z_]+'" apps/backend/src/services/clinical/cathLabService.js apps/backend/src/services/clinical/cathLabReadinessRules.js apps/backend/src/routes/clinical/cathLabRoutes.js || echo "zero matches on the base tree (expected)"
```

Expected: zero (the existing `CATH_LAB_CASE_*` codes are `_NOT_FOUND`, `_ENCOUNTER_INVALID`, `_FACILITY_*`, which the alternation does not match). Any match is reconciled by name in Task 5 before the bidirectional scan is written.

---

## Task 1: migration NNN — lifecycle, attempt evidence, fingerprints and staged enforcement

**Files:**
- Create: `apps/backend/src/migrations/NNN_cath_lab_case_attempts.sql`
- Create: `apps/backend/scripts/classify-cath-nnn.mjs` (sentinel extractor; no duplicate issue SQL)
- Modify: `apps/backend/prisma/schema.prisma` (all three affected models plus `cath_procedure_logs`)

> **Rollout invariant** (spec §8.1, §13): do not run NNN until the preflight inventory has classified every inconsistent `in_progress` row and all old writers are quiesced. The migration's order is expand → classified backfill → enforce. It adds both clocks to the case and attempt records, never derives clinical occurrence from `created_at`, log save time, or `actual_start_at`, and its CHECKs enforce timestamp/end-field shape only. Consent is enforced by transactional `startCaseTx` plus behavioural tests, not by this migration.

- [ ] **Step 1: Reserve the number — and plan to re-check it at push time**

```bash
cd "$SCRATCH/wt/rr-impl"
git fetch github '+refs/heads/*:refs/remotes/github/*'
for ref in $(git for-each-ref --format='%(refname)' refs/remotes/github/); do
  git ls-tree --name-only "$ref" apps/backend/src/migrations/ 2>/dev/null
done | sed -E 's#.*/([0-9]+)_.*#\1#' | sort -n | uniq | tail -2
```

Expected main tail after Phase 1: `766`, `767`; compute across every fetched `github/*` branch rather than trusting that snapshot. `NNN` is never 767 (owned and merged by the Phase 1 lane); if the candidate appears on any branch, take the next free number above it **now** and use it everywhere below; if it appears between now and the first push (Task 9 re-runs this), renumber **before** pushing, never after — the immutability gate pins a file by name once it is on a remote.

- [ ] **Step 2: Write the migration** (spec §8.1, verbatim — the CHECK names are cited by the deep tests and the OpenAPI pin)

Write `NNN_cath_lab_case_attempts.sql` exactly as spec §8.1, including the transaction-local signed-manifest gate, valid never-started cancellation shape, manifest-derived attempt attribution, indexed Start recording clock, dirty/generation columns, procedure-log attribution, complete attempt table, both RLS policies from the 2026-09-07 dev-1b ruling, lifecycle constraints, readiness fingerprints and log-attribution constraint. The deployment wrapper must open one transaction, call `set_config('app.cath_nnn_signed_dispositions', manifest_json, true)` on that connection, execute NNN, and commit. The spec owns the single executable SQL block; this plan records how to extract and verify it without maintaining a second copy.

The sole operative migration text is the complete `sql` block in spec §8.1, beginning
`-- NNN_cath_lab_case_attempts.sql — spec 2026-09-06 revision 6.`. Do not keep a
second copy in this plan. Before implementation, extract that fenced block, hash it,
copy it byte-for-byte to `apps/backend/src/migrations/NNN_cath_lab_case_attempts.sql`,
and record both SHA-256 values; they must match. The migration deep test additionally
proves that the signed-manifest digest is recomputed and that a tampered envelope aborts
before persistent DDL.

Before applying it, run `node scripts/classify-cath-nnn.mjs --migration src/migrations/NNN_cath_lab_case_attempts.sql --output "$SCRATCH/cath-nnn-signed-dispositions.json"` from `apps/backend` through the separately governed migration role with `BYPASSRLS`; the unsupported tenant-GUC literal `'bypass'` is never set. The classifier opens a read-only transaction, refuses a migration with missing or duplicate sentinels, extracts and executes the exact SQL between `BEGIN CATH_NNN_LIVE_ISSUES_SQL` and `END CATH_NNN_LIVE_ISSUES_SQL`, and exports `_cath_nnn_live_issues` plus tenant/status counts. A row may correctly appear in more than one issue class; every emitted `(tenant_id, case_id, issue_class, row_hash)` needs its own disposition or remains unresolved.

There is no duplicated display query or compatibility hash path: the migration-delimited SQL is the one executable source and uses SHA-256. The migration recomputes that authoritative SHA-256 under table locks and joins the signed manifest on all four keys. Apply governed corrections before NNN; only `PRESTART_WITH_FIRST_START/EVIDENCED_HISTORICAL_REOPEN` and `LEGACY_CONSENT_WITHOUT_STRUCTURE/PRESERVE_LEGACY_AUTHORITY_UNKNOWN` may remain as manifest-backed exceptions. A dev/test fixture may be repaired only by its owning fixture script.

- [ ] **Step 2a: Write R4-6 as an isolated migration deep test**

Create `apps/backend/src/tests/cath-lab-case-attempts-migration.deep.test.js` with the top-level exact test name `R4-6 migration manifest preserves valid cancellation and evidenced reopen`. Create a temporary database at NNN-1 and seed every issue class, one valid running row, a **valid never-started cancellation** (`scheduled → cancelled`, `actual_start_at NULL`, distinct `actual_end_at` cancellation time), and an evidenced historical reopen with two logs. Run NNN with no/missing/stale manifest and assert rollback, no tracker row, and no persistent NNN columns. Recreate, repair non-migration-safe contradictions, provide a signed envelope whose exact SHA-256 rows preserve legacy consent and map the historical reopen to attempt 2 plus one log per attempt, and apply NNN on the same connection after `set_config`. Assert the cancellation's start remains null and cancellation time byte-equal; the reopened row retains first-start history, has current `procedure_attempt = 2`, null active clocks, correctly mapped log attempts, and any deliberately unmapped legacy log/readiness provenance is `legacy_attempt_unknown`; no timestamp is invented from case/log creation/end; legacy consent has only server provenance; a scheduled row without consent is CHECK-valid; and raw running invalid shapes fail the lifecycle CHECK.

Focused mutation command (replace `NNN` with the reserved number):

```bash
npm test -- --runInBand --testPathPatterns cath-lab-case-attempts-migration.deep -t '^R4-6 migration manifest preserves valid cancellation and evidenced reopen$'
```

Run Task 9's three-phase receipt with mutation `r4-6-manifest`: restore the blanket `actual_end_at IS NOT NULL AND actual_start_at IS NULL` abort and bypass manifest consumption. Unmodified selects/passes exactly one; mutated selects/fails exactly one at assertion `r4-6-manifest`; restored selects/passes exactly one.

- [ ] **Step 3: `schema.prisma`**

Mirror every NNN column and the new attempt table in Prisma: cases add procedure/token clocks, `lab_readiness_generation`, `readiness_dirty`, and legacy attribution; logs add nullable attempt/token, attribution, `log_command_id`, and the independent `start_command_id` column; attempt rows add both `attempt_start_recorded_at` and nullable `attempt_started_at`, attribution and policy version; readiness items add server-only fingerprint fields; audit logs add nullable indexed `start_recorded_at`. Keep CHECK documentation comments.

- [ ] **Step 4: Apply to the scratch DB and run the schema gates**

Before the remaining gates, run top-level acceptance `R5-8 attempt table is fail-closed under vhhealth_app` against two tenant rows. The fixture inserts through a privileged owner connection, then `SET ROLE vhhealth_app` and exercises: correct tenant → exactly its own row visible (positive control); wrong tenant, unset, empty and `'bypass'` → zero rows; malformed → SQLSTATE 22P02 and no returned data. This plan deliberately accepts malformed as deny-by-error for this new table. `'bypass'` is not supported; maintenance requires a separately governed `BYPASSRLS` role. Assert both policy definitions from `pg_policies`. Do not add a restrictive policy to any existing table in #1023; those tranches belong to dev-1b.

Run the exact single-test pattern and Task 9 receipt `r5-8-rls`:

```bash
npm test -- --runInBand --testPathPatterns cath-lab-case-attempts-migration.deep -t '^R5-8 attempt table is fail-closed under vhhealth_app$'
```

```bash
cd "$SCRATCH/wt/rr-impl/apps/backend"
npm run check:migration-numbers && npm run check:migration-immutability
DATABASE_URL="$CATH_READINESS_SCRATCH_DATABASE_URL" npm run test:db:setup
DATABASE_URL="$CATH_READINESS_SCRATCH_DATABASE_URL" node scripts/check-schema-drift.mjs
```

All green. Also run the preflight above, the explicit writer-population pin from Task 3, and a deployment probe proving the old application version has been quiesced before the migration begins. The immutability gate protects the file after first push; later corrections require another free number above NNN.

- [ ] **Step 5: Smoke lifecycle shape without pretending it enforces consent** (the deep tests in Task 4 make this permanent)

In the migration deep test, create three complete rows through the governed case fixture and assert each fixture id exists before mutation. On row A, raw-update `status = 'in_progress'` while `attempt_start_recorded_at` remains null and assert SQLSTATE 23514 names `cath_lab_cases_in_progress_attempt_check`; nullable clinical `attempt_started_at` is deliberately not the operational condition. On scheduled row B, raw-update `attempt_start_recorded_at = clock_timestamp()` and assert SQLSTATE 23514 names `cath_lab_cases_pre_start_attempt_check`. Leave scheduled row C without consent and prove it remains CHECK-valid. Zero selected fixture rows is a test failure. This demonstrates that the CHECKs enforce lifecycle shape while `assertConsentDocumented` inside transactional `startCaseTx`, proven by `R5-6 Start enforces governed consent attempt evidence` and `R6-6 documented authority is the only Start block across urgency categories`, enforces consent.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/migrations/NNN_cath_lab_case_attempts.sql apps/backend/scripts/classify-cath-nnn.mjs apps/backend/prisma/schema.prisma apps/backend/src/tests/cath-lab-case-attempts-migration.deep.test.js
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
  'readiness_exempt_at_start',
  'performed_at_or_before_start',
  'performed_after_start',
  'performed_timing_unknown',
  'not_performed',
]);

export function timeoutTiming({ outcome, performedAt, documentedAt, attemptStartedAt, attemptStartRecordedAt }) {
  if (outcome === 'not_performed') {
    return { timing: 'not_performed', documented_after_start: Boolean(attemptStartRecordedAt && documentedAt && Date.parse(documentedAt) > Date.parse(attemptStartRecordedAt)) };
  }
  if (outcome !== 'performed') return { timing: 'not_documented', documented_after_start: false };
  const recorded = attemptStartRecordedAt ? Date.parse(attemptStartRecordedAt) : NaN;
  const documented = documentedAt ? Date.parse(documentedAt) : NaN;
  // The outcome is known even when a legacy row lacks a usable clinical
  // occurrence instant. Never collapse known performance to not_documented.
  if (!performedAt) return {
    timing: 'performed_timing_unknown',
    documented_after_start: Number.isFinite(recorded) && Number.isFinite(documented) && documented > recorded,
  };
  const clinical = attemptStartedAt ? Date.parse(attemptStartedAt) : NaN;
  const performed = Date.parse(performedAt);
  if (!Number.isFinite(performed)) return {
    timing: 'performed_timing_unknown',
    documented_after_start: Number.isFinite(recorded) && Number.isFinite(documented) && documented > recorded,
  };
  if (!Number.isFinite(clinical)) return { timing: 'performed_timing_unknown', documented_after_start: Number.isFinite(recorded) && Number.isFinite(documented) && documented > recorded };
  if (Number.isFinite(clinical) && performed > clinical) {
    return { timing: 'performed_after_start', documented_after_start: Number.isFinite(recorded) && Number.isFinite(documented) && documented > recorded };
  }
  return {
    timing: 'performed_at_or_before_start',
    documented_after_start: Number.isFinite(recorded) && Number.isFinite(documented) && documented > recorded,
  };
}

export function canCarryAcceptedAgeDecision({ liveEvidenceFingerprint, livePolicyFingerprint, lastAcceptedEvidence }) {
  return Boolean(
    lastAcceptedEvidence?.classification === 'accepted'
    && lastAcceptedEvidence?.acceptance_kind === 'laboratory'
    && lastAcceptedEvidence?.evidence_fingerprint === liveEvidenceFingerprint
    && lastAcceptedEvidence?.accepted_policy_fingerprint === livePolicyFingerprint,
  );
}
```

The classifier canonicalizes and SHA-256 hashes exactly `{ result_id, performed_at, received_at, external_reported_on, observed_instant, updated_at, status, signed_off_at, result_origin, performed_by_lab, external_report_ref }` and `{ item_code, required, effective_window_days, external_results_count, external_result_acceptance_policy_version }`, using spec §5.6's null/string/instant rules. A same-id correction, withdrawal, backwards timestamp/version, or policy change forces re-evaluation. A bounded-lookback miss is `not_observed`; it does not manufacture `withdrawn`. Initial population—including `previous.window_days IS NULL`—sets `classifier_initialized_at` and is `bootstrap`, never `policy_changed`.

- [ ] **Step 1: Write the failing regime tests for `computeCheckDecision`** (spec §5.2)

Append inside `describe('computeCheckDecision', …)`. Items now carry `unavailability_cause`; `missing[]` entries are `{ item, state, cause }`:

```js
  const retainedHb = { classification: 'accepted', acceptance_kind: 'laboratory', result_id: '9', canonical: {}, evidence_fingerprint: 'e-hb', accepted_policy_fingerprint: 'p-hb', accepted_at: AS_OF.toISOString() };
  const agedHb = { item_code: 'hb', required: true, state: 'stale', unavailability_cause: 'aged_out', evidence_fingerprint: 'e-hb', policy_fingerprint: 'p-hb', last_accepted_evidence: retainedHb };
  const agedHbReordered = { ...agedHb, state: 'ordered_awaiting_sample' };
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

In `computeCheckDecision`, keep full internal items through the decision and project public `missing[]` only afterward. The body from `const started` to the return is:

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
  const unavailableInternal = required.filter((item) => !isItemAvailable(item, settings));
  const agedOnly = started && unavailableInternal.length > 0 && unavailableInternal.every((item) =>
    item.unavailability_cause === 'aged_out' && canCarryAcceptedAgeDecision({
      liveEvidenceFingerprint: item.evidence_fingerprint,
      livePolicyFingerprint: item.policy_fingerprint,
      lastAcceptedEvidence: item.last_accepted_evidence,
    }));
  const missing = unavailableInternal.map((item) => ({
    item: item.item_code,
    state: item.state,
    cause: item.unavailability_cause ?? null,
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
      last_accepted_evidence: { classification: 'accepted', acceptance_kind: 'laboratory', result_id: '9', canonical: canonicalEvidence(result), evidence_fingerprint: evidence, accepted_policy_fingerprint: policy, accepted_at: AS_OF.toISOString() },
      ...extra,
    };
  };
  const unavailable = (state, extra = {}) => ({ item_code: 'hb', required: true, state, lab_result_id: null, source: null, ...extra });

  const classify = ({ previous, resolved, deciding = null, direct = { kind: 'not_observed' }, settings: nextSettings = settings, windowDays = 30, evaluationAt = AS_OF }) => classifyUnavailability({
    previous, resolved, previousEvidenceLookup: direct,
    evidenceFingerprint: deciding ? evidenceFingerprintFor(deciding) : null,
    policyFingerprint: policyFingerprintFor({ itemCode: 'hb', required: resolved.required, windowDays, settings: nextSettings }),
    settings: nextSettings, windowDays, asOf: evaluationAt,
  });
  test('available → null', () => { const r = row(9, -1); expect(classify({ previous: accepted(r), resolved: { ...accepted(r) }, deciding: r })).toBeNull(); });
  test('unchanged accepted row crosses the window only because evaluation clock advances → aged_out', () => { const acceptedRow = Object.freeze(row(9, -1)); const before = JSON.stringify(acceptedRow); const later = new Date(AS_OF.getTime() + 45 * 86_400_000); expect(classify({ previous: accepted(acceptedRow), resolved: unavailable('stale'), deciding: acceptedRow, direct: { kind: 'found', row: acceptedRow }, evaluationAt: later })).toBe('aged_out'); expect(JSON.stringify(acceptedRow)).toBe(before); });
  test('unchanged accepted row plus repeat order remains age-only after clock advance', () => { const acceptedRow = Object.freeze(row(9, -1)); const later = new Date(AS_OF.getTime() + 45 * 86_400_000); expect(classify({ previous: accepted(acceptedRow), resolved: unavailable('ordered_awaiting_sample'), deciding: acceptedRow, direct: { kind: 'found', row: acceptedRow }, evaluationAt: later })).toBe('aged_out'); });
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

(`classify` always passes an explicit database-derived `evaluationAt`; no rules example defaults to the process clock. Age-only tests advance only that value and assert the accepted row is unchanged. Correction tests alone replace fields on the row.)

- [ ] **Step 6: Run to verify they fail** — not exported.

- [ ] **Step 7: Implement `classifyUnavailability`**

```js
import crypto from 'node:crypto';
import { calendarDateIso } from '../../utils/calendarDate.js';

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
    external_reported_on: row?.external_reported_on == null ? null : (calendarDateIso(row.external_reported_on) || null),
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
export function classifyUnavailability({ previous = null, resolved, previousEvidenceLookup = { kind: 'not_observed' }, evidenceFingerprint, policyFingerprint, settings, windowDays, asOf }) {
  const asOfMs = toMs(asOf);
  if (!Number.isFinite(asOfMs)) throw new TypeError('classifyUnavailability requires a database evaluation clock');
  if (isItemAvailable(resolved, settings)) return null;
  const inFlight = ['ordered_awaiting_sample', 'sample_sent_awaiting_result'].includes(resolved.state);
  const bootstrap = !previous?.classifier_initialized_at || previous?.window_days == null
    || !previous?.policy_fingerprint
    || (previous?.last_accepted_evidence != null && !previous?.evidence_fingerprint);
  if (bootstrap) return inFlight ? 'reordered' : null;
  if (previous.policy_fingerprint !== policyFingerprint) return 'policy_changed';
  const accepted = previous.last_accepted_evidence;
  if (accepted?.result_id != null) {
    if (accepted.classification !== 'accepted'
      || accepted.acceptance_kind !== 'laboratory'
      || accepted.accepted_policy_fingerprint !== policyFingerprint) return 'policy_changed';
    if (previousEvidenceLookup.kind === 'confirmed_missing') return 'withdrawn';
    if (previousEvidenceLookup.kind === 'found') {
      const row = previousEvidenceLookup.row;
      const status = normalized(row?.status);
      if (['cancelled', 'retracted', 'entered-in-error'].includes(status)) return 'withdrawn';
      const currentFingerprint = evidenceFingerprintFor(row);
      if (currentFingerprint !== accepted.evidence_fingerprint) {
        const ms = observedMs(row);
        if (!Number.isFinite(ms)) return 'unparseable';
        if (ms > asOfMs) return 'future_dated';
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

The resolver writes `evidence_fingerprint`, `policy_fingerprint`, `window_days` and `classifier_initialized_at` on every publish. Laboratory acceptance writes exactly `{ classification: 'accepted', acceptance_kind: 'laboratory', result_id, canonical, evidence_fingerprint, accepted_policy_fingerprint, accepted_at }`. A waiver never constructs/replaces this object and never dereferences a deciding result; later unavailable states never erase it. It performs the direct previous-id lookup outside the case-row critical section. `asOf` always comes from the database evaluation clock. `calendarDateIso` is the same Date/string calendar-date rail used by baseline `externalReportedMs`; `String(x).slice(0,10)` is forbidden.

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
// is not an assertion. Start uses bound clock_timestamp(); other writers may
// use transaction-start NOW(). Compare only stored TIMESTAMPTZ(6) instants;
// equality is at-or-before, never "after".
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
    const snap = buildStartSnapshot({ recordedAt: AS_OF, clinicalStartedAt: null, clinicalStartProvenance: 'retrospective_time_unknown', procedureAttempt: 2, lifecycleToken: '00000000-0000-4000-8000-000000000000', via: 'status', commandId: 'cmd-0123456789abcdef', urgency: 'emergency', reason: 'Primary PCI', blocking, missingLabItems: ['hcv', 'hb'], readinessPictureAt: AS_OF.toISOString(), labComponentStatus: 'fresh', consentAuthority: 'emergency_basis' });
    expect(Object.keys(snap)).toEqual([...START_SNAPSHOT_KEYS]);
    expect(START_SNAPSHOT_KEYS).toEqual(['recorded_at', 'clinical_started_at', 'clinical_start_provenance', 'procedure_attempt', 'lifecycle_token', 'via', 'command_id', 'procedure_log_id', 'urgency', 'reason', 'blocking', 'missing_lab_items', 'readiness_picture_at', 'lab_component_status', 'consent_authority']);
    expect(snap).toMatchObject({ recorded_at: AS_OF.toISOString(), procedure_attempt: 2, command_id: 'cmd-0123456789abcdef', missing_lab_items: ['hb', 'hcv'], lab_component_status: 'fresh', consent_authority: 'emergency_basis' });
  });
  test('missing_lab_items is null when unavailable and required snapshot keys cannot be omitted', () => {
    const base = { recordedAt: AS_OF, procedureAttempt: 1, lifecycleToken: '00000000-0000-4000-8000-000000000000', via: 'status', commandId: 'cmd-0123456789abcdef', blocking: [] };
    expect(buildStartSnapshot({ ...base, missingLabItems: null, labComponentStatus: 'unavailable' }).missing_lab_items).toBeNull();
    expect(() => buildStartSnapshot({ ...base, missingLabItems: [], labComponentStatus: 'unavailable' })).toThrow('unavailable');
    expect(() => buildStartSnapshot({ ...base, via: 'elsewhere' })).toThrow('via');
    expect(() => buildStartSnapshot({ ...base, recordedAt: null })).toThrow('recordedAt');
  });
  test('startedWithReadinessPending is TRI-state: true / false / null (no snapshot)', () => {
    expect(startedWithReadinessPending({ blocking })).toBe(true);
    expect(startedWithReadinessPending({ blocking: [] })).toBe(false);
    expect(startedWithReadinessPending(null)).toBeNull();
    expect(startedWithReadinessPending({ blocking: 'labs' })).toBeNull();
  });
  test('normalizeStartSnapshot preserves the fixed keys and incomplete snapshots remain unknown', () => {
    expect(normalizeStartSnapshot({ via: 'status', blocking, extra: 1 })).toBeNull();
    expect(normalizeStartSnapshot({ recorded_at: AS_OF.toISOString(), clinical_started_at: null, clinical_start_provenance: 'retrospective_time_unknown', procedure_attempt: 2, lifecycle_token: '00000000-0000-4000-8000-000000000000', via: 'status', command_id: 'cmd-0123456789abcdef', procedure_log_id: null, urgency: null, reason: null, blocking, missing_lab_items: null, readiness_picture_at: null, lab_component_status: 'unavailable', consent_authority: 'patient', extra: 1 })).toEqual({ recorded_at: AS_OF.toISOString(), clinical_started_at: null, clinical_start_provenance: 'retrospective_time_unknown', procedure_attempt: 2, lifecycle_token: '00000000-0000-4000-8000-000000000000', via: 'status', command_id: 'cmd-0123456789abcdef', procedure_log_id: null, urgency: null, reason: null, blocking, missing_lab_items: null, readiness_picture_at: null, lab_component_status: 'unavailable', consent_authority: 'patient' });
    expect(normalizeStartSnapshot(undefined)).toBeNull();
  });
  test('missingLabItemCodes returns only required unavailable items in canonical day-list order', () => {
    const items = [
      { item_code: 'hcv', required: true, state: 'not_ordered' },
      { item_code: 'hb', required: true, state: 'result_final' },
      { item_code: 'hbsag', required: false, state: 'not_ordered' },
      { item_code: 'creatinine', required: true, state: 'ordered_awaiting_sample' },
      { item_code: 'hcv', required: true, state: 'not_ordered' },
    ];
    expect(missingLabItemCodes(items, settings)).toEqual(['creatinine', 'hcv']);
  });
  test('labComponentStatus: no rows or no stamp → unavailable; ≤ 5 min → fresh; else stale', () => {
    expect(labComponentStatus({ pictureAt: null, itemCount: 7, evaluationAt: AS_OF })).toBe('unavailable');
    expect(labComponentStatus({ pictureAt: AS_OF.toISOString(), itemCount: 0, evaluationAt: AS_OF })).toBe('unavailable');
    expect(labComponentStatus({ pictureAt: new Date(AS_OF.getTime() - 299_000).toISOString(), itemCount: 7, evaluationAt: AS_OF })).toBe('fresh');
    expect(labComponentStatus({ pictureAt: new Date(AS_OF.getTime() - 301_000).toISOString(), itemCount: 7, evaluationAt: AS_OF })).toBe('stale');
    expect(START_PICTURE_FRESH_MS).toBe(300_000);
  });
});

describe('timeoutTiming (spec §4.7)', () => {
  const t = (offset) => new Date(AS_OF.getTime() + offset).toISOString();
  test('performed at or before clinical start, documented after recording → separate timing and lateness', () => {
    expect(timeoutTiming({ outcome: 'performed', performedAt: t(0), documentedAt: t(+600_000), attemptStartedAt: t(0), attemptStartRecordedAt: t(0) })).toEqual({ timing: 'performed_at_or_before_start', documented_after_start: true });
  });
  test('performed after clinical start → performed_after_start', () => {
    expect(timeoutTiming({ outcome: 'performed', performedAt: t(+30_000), documentedAt: t(+30_000), attemptStartedAt: t(0), attemptStartRecordedAt: t(0) }).timing).toBe('performed_after_start');
  });
  test('absence is unknown; known performance with unknown timing stays performed', () => {
    expect(timeoutTiming({ outcome: null, performedAt: null, documentedAt: null, attemptStartRecordedAt: t(0) }).timing).toBe('not_documented');
    expect(timeoutTiming({ outcome: 'performed', performedAt: t(-1), documentedAt: t(+1), attemptStartedAt: null, attemptStartRecordedAt: t(0) }).timing).toBe('performed_timing_unknown');
    expect(timeoutTiming({ outcome: 'not_performed', performedAt: null, documentedAt: t(+1), attemptStartRecordedAt: t(0) }).timing).toBe('not_performed');
  });
});

describe('consent vocabularies (spec §4.3)', () => {
  test('authorities and modes are the platform lists', () => {
    expect(CONSENT_AUTHORITIES).toEqual(['patient', 'legally_authorised_representative', 'emergency_basis']);
    expect(CONSENT_MODES).toEqual(['written', 'verbal', 'telephone']);
    expect(CONSENT_SCOPES).toEqual(['named_procedure', 'episode']);
  });
});
```

Import the new names from the facade: `START_SNAPSHOT_KEYS, START_VIAS, LAB_COMPONENT_STATUSES, START_PICTURE_FRESH_MS, buildStartSnapshot, normalizeStartSnapshot, startedWithReadinessPending, missingLabItemCodes, labComponentStatus, timeoutTiming, classifyUnavailability, UNAVAILABILITY_CAUSES, CONSENT_AUTHORITIES, CONSENT_MODES, CONSENT_SCOPES`.

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
export const CONSENT_SCOPES = Object.freeze(['named_procedure', 'episode']);

function orderedItemCodes(codes) {
  return [...new Set((codes || []).filter((code) => ITEM_CODES.includes(code)))].sort((a, b) => ITEM_CODES.indexOf(a) - ITEM_CODES.indexOf(b));
}

export function labComponentStatus({ pictureAt, itemCount, evaluationAt }) {
  const ms = toMs(pictureAt);
  const evaluationMs = toMs(evaluationAt);
  if (!Number.isFinite(evaluationMs)) throw new TypeError('labComponentStatus requires a database evaluation clock');
  if (!itemCount || !Number.isFinite(ms)) return 'unavailable';
  return evaluationMs - ms <= START_PICTURE_FRESH_MS ? 'fresh' : 'stale';
}

export function buildStartSnapshot({
  recordedAt, clinicalStartedAt = null, clinicalStartProvenance = null, procedureAttempt, lifecycleToken,
  via, commandId, procedureLogId = null, urgency = null, reason = null, blocking,
  missingLabItems = null, readinessPictureAt = null, labComponentStatus: componentStatus = 'unavailable', consentAuthority = null,
}) {
  if (!Number.isFinite(toMs(recordedAt))) throw new TypeError('recordedAt is required');
  if (!Number.isInteger(Number(procedureAttempt)) || Number(procedureAttempt) < 1) throw new TypeError('procedureAttempt is required');
  if (typeof lifecycleToken !== 'string' || !lifecycleToken) throw new TypeError('lifecycleToken is required');
  if (typeof commandId !== 'string' || !commandId) throw new TypeError('commandId is required');
  if (!Array.isArray(blocking)) throw new TypeError('blocking is required');
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
    procedure_log_id: procedureLogId == null ? null : String(procedureLogId),
    urgency: urgency ?? null,
    reason: reason ?? null,
    blocking: blocking.map((row) => ({ check_type: row.check_type, reason: row.reason })),
    missing_lab_items: componentStatus === 'unavailable' ? null : orderedItemCodes(missingLabItems),
    readiness_picture_at: readinessPictureAt ?? null,
    lab_component_status: componentStatus,
    consent_authority: CONSENT_AUTHORITIES.includes(consentAuthority) ? consentAuthority : null,
  };
}

export function normalizeStartSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isFinite(toMs(raw.recorded_at))
    || !Number.isInteger(Number(raw.procedure_attempt))
    || typeof raw.lifecycle_token !== 'string' || !raw.lifecycle_token
    || !START_VIAS.includes(raw.via)
    || typeof raw.command_id !== 'string' || !raw.command_id
    || !Array.isArray(raw.blocking)) return null;
  const componentStatus = LAB_COMPONENT_STATUSES.includes(raw.lab_component_status) ? raw.lab_component_status : 'unavailable';
  return {
    recorded_at: raw.recorded_at ?? null,
    clinical_started_at: raw.clinical_started_at ?? null,
    clinical_start_provenance: raw.clinical_start_provenance ?? null,
    procedure_attempt: raw.procedure_attempt == null ? null : Number(raw.procedure_attempt),
    lifecycle_token: raw.lifecycle_token ?? null,
    via: START_VIAS.includes(raw.via) ? raw.via : null,
    command_id: raw.command_id ?? null,
    procedure_log_id: raw.procedure_log_id == null ? null : String(raw.procedure_log_id),
    urgency: raw.urgency ?? null,
    reason: raw.reason ?? null,
    blocking: raw.blocking.map((row) => ({ check_type: row?.check_type, reason: row?.reason })),
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

// timeoutTiming is implemented once, at the start of Task 2. Pending/absent
// documentation never implies not_performed; only the explicit attested
// outcome does. Known performance with a missing or malformed occurrence
// instant remains performed_timing_unknown. Clinical ordering uses
// attemptStartedAt; documentation lateness uses attemptStartRecordedAt.
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
- Create: `apps/backend/src/services/clinical/cathConsentEvidenceResolver.js`
- Modify: `apps/backend/src/routes/clinical/cathLabRoutes.js` (`POST /cases/:id/reopen`; creation-route status validation)
- Create: `apps/backend/src/tests/unit/cathLabStartPathPin.test.js`
- Test: `apps/backend/src/tests/unit/cathLabService.test.js`

> Revision-5 controlling order: land the cancelled-only door before refusals that name it. Then make replay reachable, require the server lifecycle fence on every lifecycle-changing and attempt-specific write, bind one recording instant, archive attempt evidence, and split lab resolution from publication. Every snippet below uses these signatures and this order.

`transitionCaseStatus` must execute this exact sequence inside its tenant transaction:

1. Normalize `requestedTarget`, `command_id`, and `expected_lifecycle_token`; require the token for every target.
2. Lock/read the case.
3. If `requestedTarget === 'in_progress'`, call `startCaseTx` immediately. It resolves a matching stored command before current-state eligibility; only a new Start on a cancelled row receives `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED`. Do **not** call `validateCaseTransition` first.
4. For every non-Start target, compare `expected_lifecycle_token` under the case lock.
5. If the current status is `cancelled`, reject the generic status write with `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED`; otherwise call `validateCaseTransition` and perform the generic update. Completion retains the token. Cancellation rotates `lifecycle_token = gen_random_uuid()` in that same statement—even when no attempt has started. For a never-started attempt, the same transaction rebinds its consent/time-out attempt rows from the prior token to the cancellation token without changing evidence; for a started attempt, the archived rows retain their Start token.

`startCaseTx(tx, { tenantId, cathCase, reason, via, commandId, expectedLifecycleToken, procedureLogId, clinicalStartedAt, clinicalStartProvenance, context })` then executes: normalize command/token and the exact spec §4.2 request fields; compute their canonical SHA-256 `request_fingerprint`; inspect `start_commands` before eligibility. A matching `(command_id, lifecycle_token, procedure_attempt, request_fingerprint)` returns `{ updated, snapshot, replayed: true }` with the stored immutable Start snapshot and current case, even if the case is now completed or cancelled; same command/token/attempt with a changed fingerprint throws `CATH_LAB_START_COMMAND_CONFLICT`; another attempt/token is stale. Only a new command then compares the supplied token to the locked case, returns the named reopen-door error for `cancelled`, checks `START_ELIGIBLE_STATUSES`, asserts attempt-specific consent, reads cached lab/check projections without calling refresh, obtains exactly one `SELECT clock_timestamp() AS recorded_at`, derives status-start clinical time or validates retrospective nullable clinical time/provenance, freezes consent/time-out at-start fields, and updates the case under `WHERE lifecycle_token = expected`. Store `{ command_id, lifecycle_token, procedure_attempt, request_fingerprint, via, recorded_at, snapshot }`; write audit/canonical lifecycle envelope with the same `recorded_at`; return `{ updated, snapshot, replayed }`. `transitionCaseStatus` maps that only for the Start target to public `{ case: updated, start: snapshot, replayed }`; non-Start transition responses are unchanged. A zero-row update is `CATH_LAB_LIFECYCLE_STALE`.

`recordProcedureLog` requires both `log_command_id` and `expected_lifecycle_token` for every draft, finalized or amended log. Under the case lock it checks the lifecycle token, validates and canonicalizes the clinical-start attestation fields, then looks up `(tenant_id, case_id, log_command_id)`. It compares every normalized stored clinical/log field plus the independent `start_command_id`, and rejects changed content with `CATH_LAB_PROCEDURE_LOG_COMMAND_CONFLICT`. A duplicate draft/amended log returns the stored log with `replayed: true`. A duplicate finalized log that originally invoked Start calls `startCaseTx` with the stored log id and same normalized Start request, so command replay returns the immutable original snapshot without another INSERT/event/audit; the compound log/Start response has `replayed: true`. Every new INSERT stores server-derived `procedure_attempt`, `lifecycle_token`, `log_command_id`, and nullable `start_command_id`; only a newly inserted finalized row may invoke a new Start command/fingerprint. Drafts and amendments never start. A stale finalized request writes neither log nor Start. Requested cases refuse before INSERT; cancelled cases name the reopen door before INSERT.

`updateReadinessCheck` and every human readiness action require `expected_lifecycle_token`, compare it under the same case lock, and atomically increment `lab_readiness_generation`/set `readiness_dirty` before changing a projection or waiver. Consent/time-out additionally upsert the attempt row by tenant/case/locked attempt/check. INSERT uses the locked token; `ON CONFLICT ... DO UPDATE` runs only `WHERE existing.lifecycle_token = EXCLUDED.lifecycle_token`, returns the governed row, and a zero-row result is stale. The upsert never changes frozen at-start fields. All writes are one transaction; metadata replacement affects only the current projection and has no path to archived attempt rows. It rejects client-owned `documented_at`, `documented_by`, `procedure_attempt`, `lifecycle_token`, `server_provenance`, `policy_version`, `previous_attempts`, or evidence archives. Patient/representative consent requires approved evidence and scope (plus representative reference for the latter); emergency basis requires an approved document reference or justification plus attestation and accepts no communication mode. The server supplies provenance, policy version, actor and recording time.

`reopenCaseTx` requires `expectedLifecycleToken`, accepts only `cancelled`, compares that token under the lock, preserves `actual_start_at`, clears `actual_end_at`, current snapshot and both active-attempt clocks, and always rotates `lifecycle_token`. Its route-level idempotency receipt includes the reviewed cancellation token in the request hash, so a delayed retry cannot reopen a later cancellation. It increments `procedure_attempt` and resets current consent/time-out only when `attempt_start_recorded_at` proves that the cancelled lifecycle had started; prior attempt rows retain their token. Otherwise the attempt number/checks remain and the server atomically rebinds those same-attempt rows from the cancelled token to the newly issued token without changing evidence. Start/cancel/reopen/complete audit and canonical events use a server-only lifecycle envelope; cancel/reopen include previous and resulting tokens. Prior consent/time-out evidence remains in `cath_lab_attempt_readiness_records`, never client-mergeable metadata. Server attribution says which attempt the server changed; the token says which lifecycle the user intended to change. Both are required.

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

The mock sequence for a status start is: locked case → `readinessForCase` rows → governed attempt rows → approved consent policy → stored item rows → bound database clock → `UPDATE … RETURNING *` → canonical refs. The following is an assertion inventory, not code to copy; implement each case with the suite's concrete mock helpers and no placeholder bodies:

**Unit assertion matrix (write complete tests; no raw-row fixtures):**

- Creation permits only `requested`, `scheduled`, and `readiness_pending`; every other status fails before a query and reserved Start metadata is stripped.
- Status Start and finalized-log Start both use an approved test consent policy and consent evidence seeded through the governed writer. Missing, waived, not-applicable, mismatched projection/attempt status, wrong token, revoked policy, wrong tenant/patient/scope, or unowned evidence all refuse before Start writes.
- Start binds exactly one post-lock database `clock_timestamp()` to case, snapshot, command, audit `start_recorded_at`, and canonical event; audit `created_at` may differ because its baseline helper uses `NOW()`.
- Cached laboratory state can be absent without becoming clean; the snapshot stores `missing_lab_items: null` and `lab_component_status: unavailable`. Start increments `lab_readiness_generation` and sets `readiness_dirty`.
- Same-command replay after completion returns the immutable snapshot; changed content conflicts; another lifecycle is stale.
- For every case status × log status: drafts/amendments never Start; requested/cancelled refuse before insert; finalized start-eligible logs use distinct `log_command_id` and `start_command_id`; supplied clinical time requires attestation; first delivery and replay complete the same idempotent canonical/reference/registry side effects.
- Timeout pass persists `{ outcome: performed, performed_at, documented_at }`; explicit attested non-performance stays non-pass; future occurrence is rejected using the bound database documentation clock.
- Cancel and complete require the expected lifecycle token under lock. Delayed first deliveries fail without writes.
- Reopen requires cancelled status, reason, idempotency key, and the expected cancellation token. The receipt hash includes that token. A never-started reopen keeps the attempt/evidence and rebinds its token; a started reopen creates N+1, resets only current consent/time-out, preserves history, clears active clocks/end time, and rotates the token.
- All response identifiers originating from BIGINT columns remain decimal strings.

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

Import `CONSENT_AUTHORITIES, CONSENT_MODES, CONSENT_SCOPES, buildStartSnapshot, normalizeStartSnapshot, missingLabItemCodes, labComponentStatus` from `./cathLabReadinessRules.js`; `recordReadinessAudit, getReadinessSettings` from `./cathLabReadinessService.js`; `scheduleReadinessRefresh` from `./cathLabReadinessHooks.js`; and `validateConsentEvidenceRefTx` from the new `./cathConsentEvidenceResolver.js`.

- [ ] **Step 4: Implement — the hard block, the consent policy, the check-write validation** (spec §4.3, §4.7)

Replace `assertReadinessComplete` with `assertConsentDocumented` exactly as spec §4.3 (returns `{ gate, checks, consent }`; the old name must not survive anywhere — the pin greps for it). Add:

```js
function validateConsentAgainstPolicy(consent, policy) {
  if (!consent || !CONSENT_AUTHORITIES.includes(consent.authority)) {
    throw AppError.badRequest('A recognized consent authority is required',
      'CATH_LAB_CONSENT_AUTHORITY_REQUIRED');
  }
  if (!Array.isArray(policy?.authorities) || !policy.authorities.includes(consent.authority)) {
    throw AppError.badRequest('Consent authority is not admitted by the approved policy',
      'CATH_LAB_CONSENT_AUTHORITY_NOT_PERMITTED', { permitted: policy?.authorities ?? [] });
  }
  const refs = Array.isArray(consent.evidence_refs) ? consent.evidence_refs : [];
  if (consent.authority === 'emergency_basis') {
    if (consent.mode != null || consent.representative_ref != null || consent.scope != null) {
      throw AppError.badRequest('Emergency basis does not use consent mode, representative, or person-consent scope',
        'CATH_LAB_CONSENT_SHAPE_INVALID');
    }
    const attestedJustification = typeof consent.justification === 'string'
      && consent.justification.trim() !== '' && consent.attested === true;
    if (refs.length === 0 && !attestedJustification) {
      throw AppError.badRequest('Emergency basis requires approved evidence or an attested justification',
        'CATH_LAB_CONSENT_EVIDENCE_REQUIRED');
    }
    return;
  }
  if (!CONSENT_MODES.includes(consent.mode)
      || !CONSENT_SCOPES.includes(consent.scope)
      || !Array.isArray(policy.scopes) || !policy.scopes.includes(consent.scope)
      || refs.length === 0) {
    throw AppError.badRequest('Patient or representative authority requires an approved mode, scope, and evidence',
      'CATH_LAB_CONSENT_SHAPE_INVALID');
  }
  if (consent.authority === 'legally_authorised_representative'
      && (typeof consent.representative_ref !== 'string' || consent.representative_ref.trim() === '')) {
    throw AppError.badRequest('Representative authority requires representative_ref',
      'CATH_LAB_CONSENT_REPRESENTATIVE_REQUIRED');
  }
}

// cathConsentEvidenceResolver.js. Evidence is not arbitrary client text: it is
// a finalized, server-issued canonical event selected by the approved policy.
export async function validateConsentEvidenceRefTx(db, {
  tenantId, patientUid, caseId, encounterId, procedureCode, procedureAttempt,
  consent, policy, confirmationInput = null, documentedAt = null, actorUid = null,
}) {
  const refs = Array.isArray(consent?.evidence_refs) ? consent.evidence_refs : [];
  const required = consent?.authority === 'emergency_basis' && consent?.justification
    && consent?.attested === true ? 0 : 1;
  if (refs.length < required) throw AppError.badRequest(
    'The selected authority requires evidence', 'CATH_LAB_CONSENT_EVIDENCE_REQUIRED');
  const archived = [];
  const priorEvidenceIds = [];
  for (const ref of refs) {
    if (ref?.kind !== 'clinical_timeline_event' || !isUuid(ref.id)) throw AppError.badRequest(
      'Consent evidence reference is invalid', 'CATH_LAB_CONSENT_EVIDENCE_INVALID');
    const row = unwrapOrNull(await db.$queryRawUnsafe(
      `SELECT id, tenant_id, patient_uid, encounter_id, event_type, event_status,
              actor_uid, actor_role, source_table, source_id, payload
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantOr(tenantId), ref.id));
    const exactCase = consent.scope === 'named_procedure'
      && row?.source_table === 'cath_lab_cases' && row?.source_id === String(caseId);
    const exactEncounter = consent.scope === 'episode'
      && encounterId != null && String(row?.encounter_id) === String(encounterId);
    const recordedScope = row?.payload?.consent_scope ?? null;
    const expectedScope = consent.scope === 'named_procedure'
      ? `procedure:${procedureCode}` : `encounter:${encounterId}`;
    const sourceAttemptValue = row?.payload?.procedure_attempt;
    const sourceAttempt = sourceAttemptValue != null
      && Number.isInteger(Number(sourceAttemptValue)) && Number(sourceAttemptValue) > 0
      ? Number(sourceAttemptValue) : null;
    if (!row || String(row.patient_uid) !== String(patientUid)
        || (!exactCase && !exactEncounter) || recordedScope !== expectedScope
        || row.event_status !== 'finalized' || row.actor_uid == null
        || !policy.evidence_event_types.includes(row.event_type)
        || !policy.evidence_owner_roles.includes(row.actor_role)) {
      throw AppError.badRequest(
        'Consent evidence does not belong to this patient, case or approved scope',
        'CATH_LAB_CONSENT_EVIDENCE_SCOPE_INVALID');
    }
    if (sourceAttempt !== Number(procedureAttempt)) priorEvidenceIds.push(String(row.id));
    archived.push({ kind: 'clinical_timeline_event', id: String(row.id),
      event_type: row.event_type, scope: recordedScope,
      source_procedure_attempt: sourceAttempt });
  }
  if (priorEvidenceIds.length === 0) {
    if (confirmationInput != null) throw AppError.badRequest(
      'Applicability confirmation is only valid for prior-attempt evidence',
      'CATH_LAB_CONSENT_SHAPE_INVALID');
    return { archived, applicabilityConfirmation: null };
  }
  if (policy.allow_prior_attempt_evidence !== true) throw AppError.badRequest(
    'This approved policy does not permit prior-attempt consent evidence',
    'CATH_LAB_CONSENT_EVIDENCE_REUSE_NOT_PERMITTED');
  const ids = [...priorEvidenceIds].sort();
  if (confirmationInput === true) {
    if (!Number.isFinite(new Date(documentedAt).getTime()) || !actorUid) throw new TypeError(
      'Recording applicability requires the server documentation clock and actor');
    return { archived, applicabilityConfirmation: {
      procedure_attempt: Number(procedureAttempt), confirmed_at: new Date(documentedAt).toISOString(),
      confirmed_by: String(actorUid), evidence_ids: ids,
    } };
  }
  const recorded = confirmationInput && typeof confirmationInput === 'object'
    && Number(confirmationInput.procedure_attempt) === Number(procedureAttempt)
    && Number.isFinite(new Date(confirmationInput.confirmed_at).getTime())
    && typeof confirmationInput.confirmed_by === 'string'
    && JSON.stringify([...(confirmationInput.evidence_ids || [])].sort()) === JSON.stringify(ids);
  if (!recorded) throw AppError.badRequest(
    'Prior-attempt evidence requires explicit applicability confirmation for this attempt',
    'CATH_LAB_CONSENT_APPLICABILITY_REQUIRED');
  return { archived, applicabilityConfirmation: confirmationInput };
}

// Reads one exact version from tenants.settings.cath_lab.consent_policy. The
// stored shape is { approved_version, versions: [{ version, status,
  // revoked_at, authorities, scopes, evidence_event_types,
  // evidence_owner_roles, allow_prior_attempt_evidence }] }. Missing,
  // unapproved, or revoked rows
// return null; there is no permissive production default.
async function consentPolicyForVersion(db, tenantId, policyVersion) {
  const rows = normalizeRows(await db.$queryRawUnsafe(
    `SELECT version.version, version.status, version.revoked_at,
            version.authorities, version.scopes,
            version.evidence_event_types, version.evidence_owner_roles,
            version.allow_prior_attempt_evidence
       FROM tenants t
       CROSS JOIN LATERAL jsonb_to_recordset(
         COALESCE(t.settings->'cath_lab'->'consent_policy'->'versions', '[]'::jsonb)
       ) AS version(version text, status text, revoked_at timestamptz,
                    authorities jsonb, scopes jsonb,
                    evidence_event_types jsonb, evidence_owner_roles jsonb,
                    allow_prior_attempt_evidence boolean)
      WHERE t.id = $1::uuid AND version.version = $2
      LIMIT 1`,
    tenantOr(tenantId), policyVersion));
  const policy = rows[0] ?? null;
  return policy?.status === 'approved' && policy.revoked_at == null ? policy : null;
}

async function currentApprovedConsentPolicy(db, tenantId) {
  const rows = normalizeRows(await db.$queryRawUnsafe(
    `SELECT settings->'cath_lab'->'consent_policy'->>'approved_version' AS approved_version
       FROM tenants WHERE id = $1::uuid LIMIT 1`, tenantOr(tenantId)));
  const approvedVersion = rows[0]?.approved_version ?? null;
  const policy = approvedVersion == null
    ? null
    : await consentPolicyForVersion(db, tenantId, approvedVersion);
  if (!policy) throw AppError.serviceUnavailable(
    'The approved cath consent policy is not configured', 'CATH_LAB_CONSENT_POLICY_UNAVAILABLE');
  return policy;
}

async function assertConsentDocumented(tx, tenantId, cathCase, lifecycleToken) {
  const checks = await readinessForCase(tx, tenantId, cathCase.id);
  const gate = evaluateReadinessGate(checks);
  const projection = checks.find((row) => row.check_type === 'consent');
  const governed = unwrapOrNull(await tx.$queryRawUnsafe(
    `SELECT current_status, current_metadata, current_evidence_refs,
            policy_version, server_provenance, lifecycle_token
       FROM cath_lab_attempt_readiness_records
      WHERE tenant_id = $1::uuid AND case_id = $2::bigint
        AND procedure_attempt = $3::int AND check_type = 'consent'`,
    tenantOr(tenantId), cathCase.id, Number(cathCase.procedure_attempt)));
  if (projection?.status !== 'pass' || governed?.current_status !== 'pass'
      || governed.current_status !== projection.status) {
    throw AppError.badRequest('Consent authority must be documented before Start', 'CATH_LAB_CONSENT_REQUIRED',
      { consent_status: governed?.current_status ?? projection?.status ?? 'missing' });
  }
  if (String(governed.lifecycle_token) !== String(lifecycleToken)) {
    throw AppError.conflict('The case lifecycle changed; reload before writing', 'CATH_LAB_LIFECYCLE_STALE');
  }
  // Start is unavailable when the tenant has no current approved policy,
  // including for a server-marked legacy record. The legacy exception affects
  // missing historical detail; it does not bypass present governance.
  const currentPolicy = await currentApprovedConsentPolicy(tx, tenantId);
  if (governed.server_provenance === 'legacy_pre_NNN') {
    return { gate, checks, consent: null, policy: currentPolicy };
  }
  const consent = governed.current_metadata?.consent ?? null;
  if (!consent) throw AppError.badRequest('Consent authority evidence is required', 'CATH_LAB_CONSENT_REQUIRED');
  // An earlier approved version remains acceptable until explicitly revoked.
  const policy = await consentPolicyForVersion(tx, tenantId, governed.policy_version);
  if (!policy) throw AppError.serviceUnavailable(
    'The consent evidence policy is not approved for Start', 'CATH_LAB_CONSENT_POLICY_UNAVAILABLE');
  validateConsentAgainstPolicy(consent, policy);
  const validatedEvidence = await validateConsentEvidenceRefTx(tx, {
    tenantId, patientUid: cathCase.patient_uid, caseId: cathCase.id,
    encounterId: cathCase.encounter_id, procedureCode: cathCase.requested_procedure,
    procedureAttempt: Number(cathCase.procedure_attempt), consent, policy,
    confirmationInput: consent.applicability_confirmation ?? null,
  });
  if (stableSha256(validatedEvidence.archived) !== stableSha256(governed.current_evidence_refs ?? [])) {
    throw AppError.badRequest('The governed consent evidence does not match its validated references',
      'CATH_LAB_CONSENT_EVIDENCE_SCOPE_INVALID');
  }
  return { gate, checks, consent, policy };
}
```

(Read the `tenants` primary-key column name off `schema.prisma` before pasting; remember `tenants` may be unreadable without the tenant GUC under RLS — this runs inside the tenant transaction, which sets it.) In `updateReadinessCheck`, **before** the upsert and before any write:

```js
    const token = normalizeLifecycleToken(input.expected_lifecycle_token);
    const cathCase = await caseById(tx, tenantId, caseId, { lock: true });
    if (!token) throw AppError.badRequest('A server lifecycle token is required', 'CATH_LAB_LIFECYCLE_TOKEN_REQUIRED');
    if (String(cathCase.lifecycle_token) !== token) {
      throw AppError.conflict('The case lifecycle changed; reload before writing', 'CATH_LAB_LIFECYCLE_STALE');
    }
    if (checkType === 'consent' || checkType === 'timeout') {
      rejectClientOwnedAttemptFields(input);
    }
    const [{ recorded_at: documentedAt }] = normalizeRows(
      await tx.$queryRawUnsafe('SELECT clock_timestamp() AS recorded_at'));
    if (checkType === 'consent' && status === 'pass') {
      const consent = input.metadata?.consent;
      const policy = await currentApprovedConsentPolicy(tx, tenantId);
      validateConsentAgainstPolicy(consent, policy); // patient: mode+evidence+scope;
      // representative: same plus representative_ref; emergency: approved
      // document_ref OR justification+attested, and mode MUST be absent.
      const applicabilityInput = consent?.existing_document_applicability_confirmed ?? null;
      if (applicabilityInput != null && applicabilityInput !== true) {
        throw AppError.badRequest('Applicability confirmation must be the explicit boolean true',
          'CATH_LAB_CONSENT_SHAPE_INVALID');
      }
      const validatedEvidence = await validateConsentEvidenceRefTx(tx, {
        tenantId, patientUid: cathCase.patient_uid, caseId: cathCase.id,
        encounterId: cathCase.encounter_id, procedureCode: cathCase.requested_procedure,
        procedureAttempt: Number(cathCase.procedure_attempt), consent, policy,
        confirmationInput: applicabilityInput,
        documentedAt, actorUid: context.actorUid,
      });
      evidenceRefs = validatedEvidence.archived;
      approvedPolicyVersion = policy.version;
      const storedConsent = projectConsentInput(consent);
      delete storedConsent.existing_document_applicability_confirmed;
      if (validatedEvidence.applicabilityConfirmation) {
        storedConsent.applicability_confirmation = validatedEvidence.applicabilityConfirmation;
      }
      metadata = { ...metadata, consent: storedConsent };
    }
    if (checkType === 'timeout' && status === 'pass') {
      if (input.metadata?.timeout?.outcome !== 'performed') {
        throw AppError.badRequest('A passed time-out must explicitly record performed', 'CATH_LAB_TIMEOUT_OUTCOME_INVALID');
      }
      const performedAt = optionalTimestamp(input.metadata?.timeout?.performed_at, 'performed_at');
      if (!performedAt || new Date(performedAt).getTime() > new Date(documentedAt).getTime()) {
        throw AppError.badRequest('A time-out pass must record when the time-out was performed (a past instant)', 'CATH_LAB_TIMEOUT_PERFORMED_AT_REQUIRED');
      }
      metadata = { ...metadata, timeout: { outcome: 'performed', performed_at: new Date(performedAt).toISOString(), documented_at: new Date(documentedAt).toISOString() } };
      completedAtOverride = null;   // the ONE check type whose client completed_at is ignored: the two instants must not be conflated
    }
    if (checkType === 'timeout' && input.metadata?.timeout?.outcome === 'not_performed') {
      if (input.metadata.timeout.attested !== true) throw AppError.badRequest('not_performed requires attestation', 'CATH_LAB_TIMEOUT_ATTESTATION_REQUIRED');
      status = 'pending';
      metadata = { ...metadata, timeout: { outcome: 'not_performed', attested: true, documented_at: new Date(documentedAt).toISOString() } };
      completedAtOverride = null;
    }
```

Use the one `documentedAt` obtained above to write the current projection and matching `cath_lab_attempt_readiness_records` row together, with server-owned actor, attempt, lifecycle token, exact approved policy version and validated archived evidence references. `existing_document_applicability_confirmed: true` is a one-shot staff assertion accepted only when the approved policy permits prior-attempt evidence; it is never stored. The server stores `applicability_confirmation` with the active attempt, actor, recording instant and sorted evidence ids, and later Start validation must reproduce the same evidence projection. At Start, derive the server-only `authority_clinical_timing` projection as `recorded_before_clinical_start`, `recorded_after_clinical_start`, or `timing_unknown`; authority recorded before the later recording operation does not by itself prove authority existed before an earlier clinical occurrence. The governed attempt mutation is:

```js
const attemptRows = normalizeRows(await tx.$queryRawUnsafe(
  `INSERT INTO cath_lab_attempt_readiness_records
     (tenant_id, case_id, procedure_attempt, check_type, lifecycle_token,
      server_provenance, policy_version, current_status, current_completed_at, current_completed_by,
      current_metadata, current_evidence_refs, created_at, updated_at)
   VALUES ($1::uuid, $2::bigint, $3::int, $4, $5::uuid,
           $6, $7, $8, $9::timestamptz, $10::uuid, $11::jsonb, $12::jsonb, $9::timestamptz, $9::timestamptz)
   ON CONFLICT (tenant_id, case_id, procedure_attempt, check_type) DO UPDATE
     SET current_status = EXCLUDED.current_status,
         current_completed_at = EXCLUDED.current_completed_at,
         current_completed_by = EXCLUDED.current_completed_by,
         current_metadata = EXCLUDED.current_metadata,
         current_evidence_refs = EXCLUDED.current_evidence_refs,
         server_provenance = EXCLUDED.server_provenance,
         policy_version = EXCLUDED.policy_version,
         updated_at = EXCLUDED.updated_at
   WHERE cath_lab_attempt_readiness_records.lifecycle_token = EXCLUDED.lifecycle_token
   RETURNING *`,
  tenantId, cathCase.id, Number(cathCase.procedure_attempt), checkType, token,
  serverProvenance, approvedPolicyVersion, status, documentedAt, actorUid, JSON.stringify(metadata), JSON.stringify(evidenceRefs),
));
if (attemptRows.length !== 1) throw AppError.conflict('The case lifecycle changed; reload before writing', 'CATH_LAB_LIFECYCLE_STALE');
```

After the human projection/waiver write and before commit, run this same invalidation in `updateReadinessCheck`, `waiveLabItem`, `unwaiveLabItem`, order-missing and outside-result actions. Each caller already holds the case lock and supplies the reviewed token:

```js
async function invalidateReadinessCandidateTx(tx, { tenantId, caseId, expectedLifecycleToken }) {
  const rows = await tx.$queryRawUnsafe(
    `UPDATE cath_lab_cases
        SET lab_readiness_generation = lab_readiness_generation + 1,
            readiness_dirty = TRUE,
            updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND id = $2::bigint
        AND lifecycle_token = $3::uuid
      RETURNING lab_readiness_generation`,
    tenantOr(tenantId), caseId, expectedLifecycleToken);
  if (rows.length !== 1) throw AppError.conflict(
    'The case lifecycle changed; reload before writing', 'CATH_LAB_LIFECYCLE_STALE');
  return String(rows[0].lab_readiness_generation);
}
```

The attempt-record conflict branch deliberately does not assign `lifecycle_token` or any `at_start_*` column. Legacy structured gaps are accepted only when the migration stamped `server_provenance = 'legacy_pre_NNN'`; no request may manufacture that marker.

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
async function labsPictureForStartTx(tx, tenantId, caseId, checks, evaluationAt) {
  const items = normalizeRows(await tx.$queryRawUnsafe(
    `SELECT item_code, required, state FROM cath_case_lab_readiness_items WHERE tenant_id = $1::uuid AND case_id = $2::bigint`,
    tenantOr(tenantId), normalizeId(caseId, 'case_id')));
  const settings = await getReadinessSettings({ tenantId: tenantOr(tenantId), db: tx });
  const labsCheck = checks.find((check) => check.check_type === 'labs');
  const pictureAt = labsCheck?.metadata?.live_evidence_refreshed_at ?? null;
  const status = labComponentStatus({ pictureAt, itemCount: items.length, evaluationAt });
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

async function recordStartReadinessAuditTx(tx, { tenantId, resourceId, actorUid, actorRole, snapshot }) {
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs
       (tenant_id, uid, role, action, resource, resource_id, metadata,
        actor_uid, start_recorded_at, created_at)
     VALUES ($1::uuid, $2::uuid, $3,
       'cath_lab.case.started_with_readiness_pending', 'cath_lab_cases', $4,
       $5::jsonb, $2::uuid, $6::timestamptz, NOW())`,
    tenantOr(tenantId), maybeUuid(actorUid, 'actorUid'), actorRole ?? null,
    String(resourceId), JSON.stringify(snapshot), snapshot.recorded_at);
}

// THE ONE START PATH (spec §4.2). transitionCaseStatus and recordProcedureLog
// come here and nowhere else moves a case to in_progress or sets
// actual_start_at / attempt_start_recorded_at / attempt_started_at —
// cathLabStartPathPin.test.js pins the
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
  if (cathCase.status === 'cancelled') {
    throw AppError.conflict(
      'This case was cancelled. Reopen it before starting the procedure.',
      'CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED',
      { case_status: 'cancelled', reopen_path: '/api/v1/cath-lab/cases/:id/reopen' });
  }
  // 2. Eligibility follows replay and lifecycle matching.
  if (!START_ELIGIBLE_STATUSES.includes(cathCase.status)) {
    throw AppError.invalidTransition(cathCase.status, 'in_progress', CASE_TRANSITIONS[cathCase.status] || []);
  }
  // 3. The one hard block. Throws before anything is written.
  const { gate, checks, consent } = await assertConsentDocumented(tx, tenantId, cathCase, token);
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
  const [{ recorded_at: recordedAt }] = normalizeRows(await tx.$queryRawUnsafe('SELECT clock_timestamp() AS recorded_at'));
  const labs = await labsPictureForStartTx(tx, tenantId, cathCase.id, checks, recordedAt);
  const clinical = via === 'status' ? recordedAt : clinicalStartedAt;
  const provenance = via === 'status' ? 'staff_confirmed_now' : clinicalStartProvenance;
  if (via === 'procedure_log' && clinical != null && provenance !== 'retrospective_staff_attested') {
    throw AppError.badRequest('A supplied clinical started_at requires staff attestation', 'CATH_LAB_CLINICAL_START_PROVENANCE_REQUIRED');
  }
  if (via === 'procedure_log' && clinical == null && provenance !== 'retrospective_time_unknown') {
    throw AppError.badRequest('An omitted clinical started_at must retain unknown timing', 'CATH_LAB_CLINICAL_START_PROVENANCE_REQUIRED');
  }
  const frozenAttemptRows = await tx.$executeRawUnsafe(
    `UPDATE cath_lab_attempt_readiness_records
        SET at_start_status = current_status,
            at_start_completed_at = current_completed_at,
            at_start_metadata = CASE WHEN check_type = 'consent' THEN
              current_metadata || jsonb_build_object(
                'authority_clinical_timing',
                CASE WHEN $6::timestamptz IS NULL OR current_completed_at IS NULL THEN 'timing_unknown'
                     WHEN current_completed_at <= $6::timestamptz THEN 'recorded_before_clinical_start'
                     ELSE 'recorded_after_clinical_start' END)
              ELSE current_metadata END,
            at_start_evidence_refs = current_evidence_refs,
            at_start_recorded_at = $5::timestamptz,
            attempt_start_recorded_at = $5::timestamptz,
            attempt_started_at = $6::timestamptz,
            updated_at = $5::timestamptz
      WHERE tenant_id = $1::uuid AND case_id = $2::bigint
        AND procedure_attempt = $3::int AND lifecycle_token = $4::uuid
        AND check_type IN ('consent','timeout') AND at_start_recorded_at IS NULL`,
    tenantOr(tenantId), cathCase.id, Number(cathCase.procedure_attempt), token, recordedAt, clinical);
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
            lab_readiness_generation = lab_readiness_generation + 1,
            readiness_dirty = TRUE,
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
    await recordStartReadinessAuditTx(tx, { tenantId, resourceId: updated.id,
      actorUid: context.actorUid, actorRole: context.actorRole,
      snapshot: { case_id: String(updated.id), facility_id: updated.facility_id ?? null, ...snapshot } });
  }
  return { updated: normalizeDbValue(updated), snapshot, replayed: false };
}
```

The Start UPDATE's `lab_readiness_generation + 1` is intentional candidate invalidation: every resolver candidate captured before Start now disagrees at publish time. `readiness_dirty = TRUE` schedules one post-commit refresh; the publisher clears it only after a successful current-state publish.

- [ ] **Step 6: Implement — `reopenCaseTx`, `reopenCase`, `latestCancelReasonTx`, the route (the door)** (spec §4.8)

```js
// THE DOOR OUT OF CANCELLATION (spec §4.8; owner: "deliberate, auditable, and
// nothing stranded"). Not a start: it writes readiness_pending, an existing
// pre-start status. Takes ONLY a cancelled case (decision 15 — the table check
// alone would also admit scheduled). If the previous attempt had started it
// opens attempt N+1 (decision 17): the active start is cleared, the snapshot
// moves to history, consent and time-out are reset with their previous
// documentation preserved; actual_start_at — the FIRST start — is kept.
async function reopenCaseTx(tx, { tenantId, cathCase, reason, expectedLifecycleToken, context = {} }) {
  if (cathCase.status !== 'cancelled') {
    throw AppError.invalidTransition(cathCase.status, REOPEN_TARGET_STATUS, CASE_TRANSITIONS[cathCase.status] || []);
  }
  validateCaseTransition('cancelled', REOPEN_TARGET_STATUS);   // table consistency; cannot throw while the door pin holds
  const expected = normalizeLifecycleToken(expectedLifecycleToken);
  if (!expected) throw AppError.badRequest('A server lifecycle token is required', 'CATH_LAB_LIFECYCLE_TOKEN_REQUIRED');
  if (String(cathCase.lifecycle_token) !== expected) throw AppError.conflict(
    'The cancellation lifecycle changed; reload before reopening', 'CATH_LAB_LIFECYCLE_STALE');
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
      WHERE tenant_id = $1::uuid AND id = $2::bigint AND lifecycle_token = $6::uuid
      RETURNING *`,
    tenantOr(tenantId), cathCase.id, maybeUuid(context.actorUid, 'actorUid'), newAttempt, nextLifecycleToken, expected);
  if (rows.length !== 1) throw AppError.conflict('The cancellation lifecycle changed; reload before reopening', 'CATH_LAB_LIFECYCLE_STALE');
  const updated = unwrap(rows);
  let checksReset = [];
  if (newAttempt > previousAttempt) {
    await tx.$executeRawUnsafe(
      `UPDATE cath_lab_readiness_checks
          SET status = 'pending', completed_at = NULL, completed_by = NULL,
              metadata = COALESCE(metadata, '{}'::jsonb) - 'consent' - 'timeout',
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND check_type IN ('consent', 'timeout')`,
      tenantOr(tenantId), cathCase.id);
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
    const expectedLifecycleToken = normalizeLifecycleToken(input.expected_lifecycle_token);
    const requestHash = stableSha256({ reason: cleanText(input.reason, 500), expected_lifecycle_token: expectedLifecycleToken });
    await assertIdempotencyReceiptMatches(tx, context.idempotencyKey, requestHash);
    const { updated } = await reopenCaseTx(tx, { tenantId, cathCase, reason: input.reason, expectedLifecycleToken, context });
    await storeIdempotencyReceipt(tx, context.idempotencyKey, requestHash, updated);
    return updated;
  });
}
```

`ATTEMPT_RESET_CHECKS` must equal the literal `('consent', 'timeout')` in the SQL — add a one-line unit assertion that the literal in the source contains each constant member (or bind the list as `$4::text[]`; either way the pin's `SET status =` scan is unaffected because the literal names `cath_lab_readiness_checks`, not `cath_lab_cases`). `latestCancelReasonTx` reads the most recent `cath_lab.case_cancelled` event for the case (`payload->>'reason'`, `LIMIT 1`, `null` when none) from the table `writeCanonicalEvent` actually writes (`clinical_timeline_events` — read the writer's column names off `recordCanonicalClinicalEvent` rather than assuming). Register `router.post('/cases/:id/reopen', requireCathWorkflow, guardCathCaseById, requireIdempotencyKey({ required: true, scope: 'cath_lab_case_reopen' }), handler)` on the **cath mount only**; the handler passes `req.params.id`, `req.body.reason`, `req.body.expected_lifecycle_token`, `req.idempotencyKey`, tenant and actor context to `reopenCase`. The Staff dialog also states the new-attempt consequence (Task 7).

- [ ] **Step 7: Implement — `transitionCaseStatus`** (spec §4.2; owner point 2a)

Inside the transaction, in this order:

```js
    const target = normalizeStatus(input.status, CASE_STATUSES, 'status');
    const commandId = target === 'in_progress' ? normalizeCommandId(input.command_id) : null;
    const expectedLifecycleToken = normalizeLifecycleToken(input.expected_lifecycle_token);
    if (!expectedLifecycleToken) throw AppError.badRequest(
      'A server lifecycle token is required', 'CATH_LAB_LIFECYCLE_TOKEN_REQUIRED');
    const cathCase = await caseById(tx, tenantId, caseId, { lock: true });
    if (target === 'in_progress') {
      const { updated, snapshot, replayed } = await startCaseTx(tx, { tenantId, cathCase, reason: input.reason, via: 'status', commandId, expectedLifecycleToken, context });
      if (!replayed) startedPatientUid = updated.patient_uid;
      return { case: updated, start: snapshot, replayed };
    }
    if (String(cathCase.lifecycle_token) !== expectedLifecycleToken) throw AppError.conflict(
      'The case lifecycle changed; reload before writing', 'CATH_LAB_LIFECYCLE_STALE');
    // Decision 15 (owner point 2a): a cancelled case has ONE door, and it is not
    // this generic branch — readiness_pending included. Refused BEFORE
    // validateCaseTransition, so the table entry cancelled → readiness_pending
    // (kept so the vocabulary is honest) is never reachable from here. The pin
    // asserts this text precedes the table call.
    if (cathCase.status === 'cancelled') {
      throw AppError.conflict('This case was cancelled. Reopen it (POST /cath-lab/cases/:id/reopen) with a reason before changing its status.',
        'CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED', { case_status: 'cancelled', requested_status: input.status, reopen_path: '/api/v1/cath-lab/cases/:id/reopen' });
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
async function ensureProcedureLogSideEffectsTx(tx, { tenantId, cathCase, procedure, procedureType, complications, context }) {
  let event = procedure.timeline_event_id ? null : await writeCanonicalEvent(tx, {
    tenantId, patientUid: procedure.patient_uid, encounterId: procedure.encounter_id,
    eventType: 'cath_lab.procedure_logged', eventStatus: procedure.status,
    sourceTable: 'cath_procedure_logs', sourceId: procedure.id,
    actorUid: context.actorUid, actorRole: context.actorRole,
    summary: `Cath procedure logged: ${procedureType}`,
    payload: { case_id: cathCase.id, procedure_attempt: procedure.procedure_attempt,
      lifecycle_token: procedure.lifecycle_token, procedure_type: procedureType,
      access_site: procedure.access_site }, afterState: procedure,
  });
  if (event) {
    await tx.$queryRawUnsafe(
      `UPDATE cath_procedure_logs SET timeline_event_id = $3::uuid,
              audit_event_id = $4::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      tenantId, procedure.id, event.timeline?.id ?? null, event.audit?.id ?? null);
  }
  const [{ n }] = normalizeRows(await tx.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM cath_complication_registry
      WHERE tenant_id = $1::uuid AND procedure_log_id = $2::bigint
        AND source = 'procedure_log'`, tenantId, procedure.id));
  if (Number(n) === 0) {
    await deriveComplicationRegistryRows(tx, {
      tenantId, caseId: cathCase.id, procedureLogId: procedure.id,
      patientUid: procedure.patient_uid, encounterId: procedure.encounter_id,
      complications, occurredAt: procedure.ended_at ?? procedure.started_at ?? null,
    }, context);
  }
  return normalizeDbValue({ ...procedure,
    timeline_event_id: procedure.timeline_event_id ?? event?.timeline?.id ?? null,
    audit_event_id: procedure.audit_event_id ?? event?.audit?.id ?? null });
}

export async function recordProcedureLog(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  const logStatus = input.status ? normalizeStatus(input.status, ['draft', 'finalized', 'amended'], 'status') : 'finalized';  // BEFORE the case is read
  let startedPatientUid = null;
  const procedure = await setTenantTx(tenantId, async (tx) => {
    const cathCase = await caseById(tx, tenantId, caseId, { lock: true });
    const token = normalizeLifecycleToken(input.expected_lifecycle_token);
    const logCommandId = normalizeCommandId(input.log_command_id);
    if (!token || !logCommandId) throw AppError.badRequest('log_command_id and expected_lifecycle_token are required', 'CATH_LAB_PROCEDURE_LOG_COMMAND_REQUIRED');
    if (String(cathCase.lifecycle_token) !== token) throw AppError.conflict('The case lifecycle changed; reload before writing', 'CATH_LAB_LIFECYCLE_STALE');
    const startCommandId = normalizeCommandId(input.start_command_id);
    const suppliedClinicalStart = input.started_at ?? input.startedAt ?? null;
    const clinicalStartedAt = optionalTimestamp(suppliedClinicalStart, 'started_at');
    const clinicalStartProvenance = input.clinical_start_provenance ?? null;
    if (suppliedClinicalStart != null && (clinicalStartProvenance !== 'retrospective_staff_attested'
        || input.clinical_start_attested !== true)) {
      throw AppError.badRequest('A supplied started_at requires retrospective staff attestation',
        'CATH_LAB_CLINICAL_START_PROVENANCE_REQUIRED');
    }
    if (suppliedClinicalStart == null && clinicalStartProvenance != null) {
      throw AppError.badRequest('clinical_start_provenance requires started_at',
        'CATH_LAB_CLINICAL_START_PROVENANCE_REQUIRED');
    }
    // The canonical hash includes every stored clinical/log field plus the
    // independent Start identity and attestation fields; no raw alias survives.
    const normalizedCommand = normalizeProcedureLogCommand({
      ...input, start_command_id: startCommandId, started_at: clinicalStartedAt,
      clinical_start_provenance: clinicalStartProvenance,
      clinical_start_attested: input.clinical_start_attested === true,
    });
    const requestHash = stableSha256(normalizedCommand);
    const existing = unwrapOrNull(await tx.$queryRawUnsafe(
      `SELECT *, metadata->>'server_command_hash' AS server_command_hash
         FROM cath_procedure_logs
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND log_command_id = $3`,
      tenantId, cathCase.id, logCommandId));
    if (existing) {
      if (existing.server_command_hash !== requestHash) throw AppError.conflict('The log command was reused with different content', 'CATH_LAB_PROCEDURE_LOG_COMMAND_CONFLICT');
      if (existing.start_command_id) {
        const replay = await startCaseTx(tx, {
          tenantId, cathCase, reason: input.start_reason, via: 'procedure_log',
          commandId: existing.start_command_id, expectedLifecycleToken: token,
          procedureLogId: existing.id,
          clinicalStartedAt,
          clinicalStartProvenance: clinicalStartedAt == null ? 'retrospective_time_unknown' : clinicalStartProvenance,
          context,
        });
        const finished = await ensureProcedureLogSideEffectsTx(tx, { tenantId, cathCase, procedure: existing,
          procedureType: existing.procedure_type, complications: existing.complications, context });
        return { ...finished, case: replay.updated, start: replay.snapshot, replayed: true };
      }
      const finished = await ensureProcedureLogSideEffectsTx(tx, { tenantId, cathCase, procedure: existing,
        procedureType: existing.procedure_type, complications: existing.complications, context });
      return { ...finished, replayed: true };
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
    if (startEligible && START_LOG_STATUSES.includes(logStatus) && !startCommandId) {
      throw AppError.badRequest('start_command_id is required for a finalized log that starts a case',
        'CATH_LAB_START_COMMAND_REQUIRED');
    }
    const clientMetadata = normalizeJson(input.metadata, 'metadata', {});
    delete clientMetadata.server_command_hash;
    delete clientMetadata.start_command_id;
    const serverMetadata = { ...clientMetadata, server_command_hash: requestHash };
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_procedure_logs
         (tenant_id, case_id, patient_uid, encounter_id, procedure_type, access_site,
          operators, sedation_anesthesia_ref, devices, findings_summary, complications,
          status, started_at, ended_at, logged_by, metadata,
          procedure_attempt, lifecycle_token, log_command_id, start_command_id)
       VALUES ($1::uuid, $2::bigint, $3::uuid, $4::uuid, $5, $6,
               $7::jsonb, $8, $9::jsonb, $10, $11::jsonb,
               $12, $13::timestamptz, $14::timestamptz, $15::uuid, $16::jsonb,
               $17::int, $18::uuid, $19, $20)
       RETURNING *`,
      tenantId, cathCase.id, cathCase.patient_uid, cathCase.encounter_id,
      cleanText(input.procedure_type || input.procedureType, 120),
      cleanText(input.access_site || input.accessSite, 120),
      JSON.stringify(normalizeJson(input.operators, 'operators', [])),
      cleanText(input.sedation_anesthesia_ref || input.sedationAnesthesiaRef, 160),
      JSON.stringify(normalizeJson(input.devices, 'devices', [])),
      cleanText(input.findings_summary || input.findingsSummary),
      JSON.stringify(normalizeJson(input.complications, 'complications', [])),
      logStatus, clinicalStartedAt,
      optionalTimestamp(input.ended_at || input.endedAt, 'ended_at'),
      maybeUuid(context.actorUid, 'actorUid'), JSON.stringify(serverMetadata),
      Number(cathCase.procedure_attempt), token, logCommandId, startCommandId);
    const row = unwrap(rows);
    // Decision 16: a FINALIZED log on a start-eligible case starts it — same function,
    // same block, same snapshot. A draft or an amendment is recorded and starts nothing.
    if (startEligible && START_LOG_STATUSES.includes(logStatus)) {
      const { updated, snapshot } = await startCaseTx(tx, { tenantId, cathCase, reason: input.start_reason,
        via: 'procedure_log', commandId: startCommandId, expectedLifecycleToken: token,
        procedureLogId: row.id, clinicalStartedAt,
        clinicalStartProvenance: clinicalStartedAt == null ? 'retrospective_time_unknown' : clinicalStartProvenance, context });
      startedPatientUid = updated.patient_uid;
      const finished = await ensureProcedureLogSideEffectsTx(tx, { tenantId, cathCase, procedure: row,
        procedureType: row.procedure_type, complications: row.complications, context });
      return { ...finished, case: updated, start: snapshot, replayed: false };
    }
    const finished = await ensureProcedureLogSideEffectsTx(tx, { tenantId, cathCase, procedure: row,
      procedureType: row.procedure_type, complications: row.complications, context });
    return { ...finished, replayed: false };
  });
  if (startedPatientUid) scheduleReadinessRefresh({ tenantId, patientUid: startedPatientUid, source: 'cath_case_start' });
  return procedure;
}
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

(Write it so the literal text `normalizeStatus(input.status, CREATABLE_STATUSES` appears in `createCase` and `normalizeStatus(input.status, CASE_STATUSES` does not — e.g. validate membership first with `CASE_STATUSES.includes(cleanText(input.status, 60))`, then `normalizeStatus(input.status, CREATABLE_STATUSES, 'status')`. The pin reads the text.) The INSERT does not name `procedure_attempt`, `attempt_start_recorded_at` or `attempt_started_at` (defaults apply). In `cathLabRoutes.js`, `router.post('/cases', …)` validates `req.body?.status` against the exported `CREATABLE_STATUSES` before calling the service (400 with the same code — defence in depth; the service check is the one the pin reads).

- [ ] **Step 10: Run the unit suite** — `npm test -- --testPathPatterns unit/cathLabService.test`. Expected: PASS.

- [ ] **Step 11: Write the source pin** — `apps/backend/src/tests/unit/cathLabStartPathPin.test.js`

Keep the existing concrete scaffolding (`sourceFiles`, `withoutComments`, `FILES`, `enclosingFunction`, `callers`, `sqlLiterals` scoped to literals naming `cath_lab_cases`, the ICU-ordering note), extended with the population regression rationale. The following is the required assertion inventory, not a copyable code block; implement it using that tested scanner:

The pin must make these exact assertions:

- Post-lane case-table population is exactly nine UPDATE literals and two INSERT literals, with zero upserts/ORM writers/unclassified shapes. UPDATE owners: `recomputeCaseStatusTx`, `reopenCaseTx`, `resolveCathConsumableAuthorityRecovery`, `startCaseTx`, `transitionCaseStatus`, `updateCaseCanonicalRefs`, `updateReadinessCheck`, `scheduleCase`, and `spawnCathCase`. INSERT owners: `createCase` and `spawnCathCase`.
- Status writers are exactly `recomputeCaseStatusTx`, `reopenCaseTx`, `startCaseTx`, `transitionCaseStatus`, and `updateReadinessCheck`.
- Only `startCaseTx` assigns `status='in_progress'`, `actual_start_at`, a non-null `attempt_start_recorded_at`, or a non-null `attempt_started_at`; only `reopenCaseTx` clears the active attempt clocks and writes literal `readiness_pending`.
- `assertConsentDocumented` is called only by `startCaseTx`; `startCaseTx` is called only by `transitionCaseStatus` and `recordProcedureLog`; old readiness-block names are absent.
- The generic cancelled-case refusal precedes transition-table validation. Every lifecycle-changing route body requires `expected_lifecycle_token`.
- The scanner asserts exact equality, not subset membership. Feed the same scanner a synthetic parameterized-SQL writer and a synthetic ORM upsert; both must fail with their source/function name. This is a regression check for supported source shapes, not proof that arbitrary future syntax cannot evade a text scanner.

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

Revision 5 splits refresh into two functions. `resolveCaseLabReadinessCandidate` reads the case token/generation, tenant settings, results, orders and accepted evidence **without any case-row lock** and returns a candidate containing both fingerprints and the human-state revision. `publishCaseLabReadinessCandidate` applies explicit lock/statement timeouts, locks the case first and ordered readiness rows second, rechecks token/generation/policy/human revision, then recomputes from locked current human state. Start and human mutations invalidate old candidates. A mismatch discards and retries; an equal projection is a no-op with no emit. `getCase` and Staff loading read cached state immediately and enqueue refresh only when dirty/stale; they never await resolution.

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
  FROM cath_lab_cases
 WHERE tenant_id = $1::uuid AND id = $2::bigint
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
      const laboratoryAccepted = isLaboratoryEvidenceAccepted(values, settings, decidingEvidence);
      values.last_accepted_evidence = laboratoryAccepted
        ? {
            classification: 'accepted',
            acceptance_kind: 'laboratory',
            result_id: String(decidingEvidence.id),
            canonical: canonicalEvidence(decidingEvidence),
            evidence_fingerprint: evidenceFingerprint,
            accepted_policy_fingerprint: policyFingerprint,
            accepted_at: asOf.toISOString(),
          }
        : stored?.last_accepted_evidence ?? null;
```

where `resultsForItem` is the bounded candidate set and `windowDays` the effective policy window. `isLaboratoryEvidenceAccepted` requires a deciding result and never treats a waiver as laboratory acceptance; a waived item therefore does not dereference `decidingEvidence`. The one internal accepted-evidence type above is used unchanged by writer, classifier, decision and fixtures. The public `missing[]` remains `{ item, state, cause }` and is projected only after `computeCheckDecision` has evaluated the full internal item. `caseStartedAt` is the active attempt's recording-time epoch twin. `computeCheckDecision` receives cause, both live fingerprints and independently retained accepted evidence. The `auto_pass` audit records whether `attempt_start_recorded_at` was present.

Publication uses `setTenantTx` with `SET LOCAL lock_timeout = '500ms'` and `SET LOCAL statement_timeout = '2s'`. The reviewed lock order is case projection `FOR NO KEY UPDATE`, then readiness items in `item_code` order, then readiness checks in `check_type` order; no result/order/direct-evidence query occurs under that lock. It compares captured `{ lifecycle_token, lab_readiness_generation, policy_fingerprint }`, then recomputes the final decision from the locked current human check/waiver state. Start and every human check/waiver update increment the same generation and set `readiness_dirty = TRUE`, so any intervening human edit rejects the candidate rather than being overwritten. A mismatch returns `{ published: false, reason: 'obsolete_candidate' }` and schedules a fresh resolution after commit. If the locked current projection is byte-equal to the candidate, publication is a no-op: it clears dirty only when appropriate, does not increment generation, and does not emit. A changed publish increments generation once, clears dirty and emits once. This dirty/no-op rule prevents publish → emit → GET → refresh → publish loops. The exact R4-3 test uses two connections to prove Start progress; `pg_locks` is diagnostic only.

```js
async function publishCaseLabReadinessCandidate(candidate) {
  return setTenantTx(candidate.tenantId, async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '500ms'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '2s'");
    const cathCase = unwrap(await tx.$queryRawUnsafe(
      `SELECT id, lifecycle_token, lab_readiness_generation, readiness_dirty,
              attempt_start_recorded_at
         FROM cath_lab_cases
        WHERE tenant_id = $1::uuid AND id = $2::bigint FOR NO KEY UPDATE`,
      candidate.tenantId, candidate.caseId));
    if (String(cathCase.lifecycle_token) !== candidate.lifecycleToken
        || String(cathCase.lab_readiness_generation) !== String(candidate.labReadinessGeneration)
        || candidate.policyFingerprint !== await policyFingerprintForCaseTx(tx, candidate.tenantId, candidate.caseId)) {
      return { published: false, reason: 'obsolete_candidate' };
    }
    const human = await lockedHumanReadinessStateTx(tx, candidate.tenantId, candidate.caseId); // ordered check/item locks
    if (human.revision !== candidate.humanRevision) return { published: false, reason: 'obsolete_candidate' };
    const finalDecision = computeCheckDecision({ ...candidate.internalItem, ...human, started: cathCase.attempt_start_recorded_at != null });
    const nextProjection = projectPersistedReadiness(candidate, finalDecision);
    if (canonicalJson(nextProjection) === canonicalJson(human.persistedProjection)) {
      if (cathCase.readiness_dirty) await tx.$executeRawUnsafe(
        `UPDATE cath_lab_cases SET readiness_dirty = FALSE, updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND id = $2::bigint AND lifecycle_token = $3::uuid
            AND lab_readiness_generation = $4::bigint`,
        candidate.tenantId, candidate.caseId, candidate.lifecycleToken, candidate.labReadinessGeneration);
      return { published: false, reason: 'no_change' };
    }
    await persistReadinessProjectionTx(tx, candidate, nextProjection);
    const updated = unwrap(await tx.$queryRawUnsafe(
      `UPDATE cath_lab_cases
          SET lab_readiness_generation = lab_readiness_generation + 1,
              readiness_dirty = FALSE, updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND id = $2::bigint AND lifecycle_token = $3::uuid
          AND lab_readiness_generation = $4::bigint RETURNING lab_readiness_generation`,
      candidate.tenantId, candidate.caseId, candidate.lifecycleToken, candidate.labReadinessGeneration));
    return { published: true, lifecycle_token: candidate.lifecycleToken,
      lab_readiness_generation: String(updated.lab_readiness_generation) };
  });
}
```

After this transaction commits, the caller emits only when `published === true`; `obsolete_candidate` schedules one fresh resolution and `no_change` schedules nothing.

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
const dbClockMinus = async (minutes) => (await prisma.$queryRawUnsafe(
  `SELECT clock_timestamp() - ($1::int * INTERVAL '1 minute') AS at`, minutes))[0].at;
async function seedCase({ status = 'scheduled', consent = 'pass', labs = 'pending', others = 'pass', urgency = 'routine', patientUid = PATIENT, consentMeta = { consent: { authority: 'patient', mode: 'written' } } } = {}) {
  await installApprovedCathConsentTestPolicy({ tenantId: TENANT, version: 'test-v1',
    authorities: ['patient', 'legally_authorised_representative', 'emergency_basis'],
    scopes: ['named_procedure', 'episode'],
    evidence_event_types: ['cath_lab.consent_documented'],
    evidence_owner_roles: [ctx().actorRole],
    allow_prior_attempt_evidence: false });
  const created = await createCase({ tenantId: TENANT, patient_uid: patientUid,
    facility_id: FACILITY_ID, requested_procedure: 'Never-restricts PTCA', urgency, status }, ctx());
  const id = String(created.id);
  let lifecycleToken = String((await caseRow(id)).lifecycle_token);
  const requestedConsent = consentMeta?.consent ?? null;
  let governedConsent = requestedConsent;
  if (consent === 'pass' && requestedConsent?.authority !== 'emergency_basis') {
    const evidenceId = await seedApprovedConsentEvidence({
      tenantId: TENANT, patientUid, caseId: id,
      eventType: 'cath_lab.consent_documented',
      consentScope: 'procedure:Never-restricts PTCA', procedureAttempt: 1, actor: ctx(),
    });
    governedConsent = {
      ...requestedConsent,
      scope: requestedConsent.scope ?? 'named_procedure',
      evidence_refs: [{ kind: 'clinical_timeline_event', id: String(evidenceId) }],
    };
  }
  for (const type of READINESS_TYPES) {
    const st = type === 'consent' ? consent : type === 'labs' ? labs : others;
    const metadata = type === 'consent' && st === 'pass'
      ? { consent: governedConsent }
      : type === 'timeout' && st === 'pass'
        ? { timeout: { outcome: 'performed', performed_at: await dbClockMinus(1) } }
        : {};
    await updateReadinessCheck(id, { tenantId: TENANT, check_type: type, status: st,
      metadata, expected_lifecycle_token: lifecycleToken }, ctx());
    lifecycleToken = String((await caseRow(id)).lifecycle_token);
  }
  return id;
}
const caseRow = (id) => prisma.$queryRawUnsafe(
  `SELECT id::text AS id, status, actual_start_at, attempt_start_recorded_at, attempt_started_at,
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

`seedApprovedConsentEvidence` must call the real canonical-event writer, bind the event payload to the supplied `procedureAttempt`, and return its server-issued event id; it may not insert an arbitrary evidence row. Tests that exercise prior-attempt reuse install a distinct approved policy with `allow_prior_attempt_evidence: true`; all others retain false. Add `pollForItemOnCase(id, code, predicate)` and `labsCheckFor(id)` as case-parameterised twins of the existing helpers. Import `transitionCaseStatus`, `recordProcedureLog`, `reopenCase`, `createCase`, `updateReadinessCheck` from `cathLabService.js`; import `app` (or the cath router harness the route-guard suite uses) and `supertest` for the two route-level tests.

- [ ] **Step 8: Implement the non-R deep regression matrix**

Use the governed helpers from Step 7. Every consent-pass fixture installs an approved test policy and calls the real readiness writer with a finalized server-issued evidence event. Only the migration suite may create `legacy_pre_NNN`; ordinary deep fixtures never manufacture legacy provenance.

Implement complete, executable tests for the following matrix. Do not copy a partial body or refer to an earlier revision:

- Consent pending, waived, not-applicable, projection/attempt mismatch, wrong token, revoked policy, wrong tenant/patient/scope and unowned evidence refuse both Start paths before any case/log/event write. Patient and representative success fixtures use the admitted mode/scope/evidence shape; representative includes `representative_ref`; emergency success omits `mode` and uses either an approved document event or `justification` plus `attested: true`.
- Time-out pass persists `outcome: 'performed'`, clinical `performed_at`, and one server `documented_at`; attested `not_performed` stays non-pass; missing evidence is `not_documented`; known performance with unavailable clinical timing is `performed_timing_unknown`; equal stored instants are at-or-before.
- Start via status and finalized log use the same hard block and immutable snapshot. Draft/amended logs never Start. Requested/cancelled cases refuse before INSERT. Completed cases remain completed. First delivery and replay use `start_command_id` and produce one log, one Start, one canonical event/reference, and one set of derived complication-registry rows.
- Cancel, complete, and reopen each require the current lifecycle token. Never-started cancel/reopen preserves attempt 1 and rebinds its governed evidence; started cancel/reopen archives attempt N, creates N+1, resets only consent/time-out, clears the active clocks/end, and preserves first-start history.
- Age-only behavior uses an isolated patient: advance only the database evaluation clock for the accepted row; repeat refresh is stable; a repeat order does not change `aged_out`; a policy change, correction, or confirmed withdrawal retracts carry. Waiver acceptance never constructs laboratory accepted evidence.
- After Start, order-missing is STAT, external recording and final sign-off carry their distinct late markers, new accepted evidence may pass the live check, and a critical result warns without changing the case status.
- Route idempotency replays one reopen audit for the same complete request and rejects a reused key with a different cancellation token. Every response and report assertion keeps BIGINT identifiers as decimal strings.

Each test seeds its own case and asserts population counts before set-wide checks. Add the named top-level acceptance tests in Step 8a for the mutation receipts; this regression matrix may use descriptive non-R names but no incomplete executable example.
- [ ] **Step 8a: Add the fourteen decisive deep tests owned by Tasks 3–4 (exact names; no combined/renamed substitutes)**

1. `R4-1 replay and delayed first delivery are fenced on both start entry points`. Use four independently seeded, consent-valid cases. Case S: capture token S0, POST `/status` with command S, repeat the identical body/token, and assert the second response has `replayed: true`, the original snapshot, one command entry and one Start event. Case L: do the same through `/procedure-logs` with distinct log command L and Start command LS; assert one log and one Start. Case A: prepare status and finalized-log requests with token A0, Start attempt 1 with another command, cancel (assert A1 differs), reopen to attempt 2 (assert A2 differs), then first-deliver both A0 requests; each is 409 stale and changes no counts. Case N: prepare both request kinds with token N0, cancel before Start (N1), assert same-attempt readiness rows were rebound to N1 without evidence changes, then reopen while `procedure_attempt` remains 1 (N2) and assert they were rebound again to N2. Assert N0/N1/N2 are pairwise distinct; first-deliver both N0 requests and assert 409/no writes. Finally a fresh N2 command starts once. The test explicitly exercises the real route handlers.

2. `R4-2 lifecycle and readiness evidence remain attributable after reopen and metadata replacement`. Seed the case as `requested` and drive every reachable pre-start lifecycle transition before attempt 1; capture its token and byte-for-byte consent/time-out attempt rows; Start, add a log, cancel and reopen to attempt 2. First-deliver the captured attempt-1 consent body and assert stale/no write. Write attempt-2 time-out and a finalized log using the new token so the one Start path records attempt 2, then perform a replace-style readiness metadata update and complete the case. Assert attempt-1 bytes/evidence refs unchanged; attempt 2 alone contains the new timeout; all logs have the expected attempt/token. Query every lifecycle audit and canonical event emitted by the fixture—not a hand-picked type list—and assert each has server `case_id`, `procedure_attempt`, `lifecycle_token`, and recording time; cancel/reopen also have previous/resulting tokens. Assert no client-supplied attribution key survives.

3. Top-level `R4-3 paused candidate is invalidated and cannot block Start`. First, make the resolver promise never settle and assert `GET /cases/:id?readiness_mode=cached` returns the prior picture/Start affordance without invoking it. Then check out exactly two independent `pg` clients. Client A runs resolution with a test barrier after its evidence query and before publication. Client B records generation `G`, executes valid Start, and must commit before a 2-second race while A stays behind the barrier; assert Start changed the row to `G+1`. Release A; require publication to return `obsolete_candidate`, write nothing and emit nothing. The two-connection progress assertion is decisive; any `pg_locks` sample is diagnostic only. Close both clients in `finally`.

4. Top-level `R4-4 age-only carry uses complete accepted evidence`. Seed one isolated patient's governed accepted HGB row R and preserve its bytes. Advance only the database evaluation clock until it ages out; assert persisted cause `aged_out`, `classification: accepted`, `acceptance_kind: laboratory`, and both matching fingerprints while R remains byte-identical. A separately seeded waiver has no deciding result and does not throw or create accepted laboratory evidence. Correction cases alone update R's timestamp/status/`updated_at`; assert the fingerprint changes and carry stops. Restrict only the bounded resolver query while leaving direct id lookup available and assert internal `not_observed`, not `withdrawn`. Seed a migrated item with `window_days = NULL`; first refresh is bootstrap, never `policy_changed`.

5. Top-level `R5-2 delayed lifecycle commands cannot cross a lifecycle token`. On separate governed cases, prepare cancel, complete and reopen requests under token A without delivering them. Advance each case to a different server token, then first-deliver the old request. Each returns `CATH_LAB_LIFECYCLE_STALE` with no case, attempt, audit or event write. Reopen's idempotency hash includes A; reusing the key with token B conflicts. A fresh token/request succeeds and server attribution names the attempt actually changed.

6. Top-level `R5-6 Start enforces governed consent attempt evidence`. Install an approved test policy and seed consent only through `updateReadinessCheck`. Start passes when projection and attempt record both say pass, the lifecycle token agrees, the exact evidence belongs to the tenant/patient/scope and its policy version remains approved. Independently mutate each binding and assert Start refuses. An earlier approved version passes until its `revoked_at` is set; then Start becomes unavailable. No-policy also refuses. Retrospective authority timing reports `recorded_before_clinical_start`, `recorded_after_clinical_start`, or `timing_unknown`; documentation before the later recording operation alone never becomes pre-clinical proof.

7. Top-level `R5-7 finalized-log first delivery and replay share one contract`. First-deliver a finalized log with distinct `log_command_id` and `start_command_id`, an attested clinical time, and complications. Assert one log, one Start, one procedure canonical event/reference and the expected registry rows. Replay identical input; assert the same ids/snapshot and no duplicates, with the return occurring after the common side-effect verifier. Missing attestation for supplied `started_at` refuses before insert. Mutation to `input.command_id`, automatic provenance, or an early return fails assertion `r5-7-log`.

8. Top-level `R5-11 operative snippets preserve bind counts snapshots and bigint ids`. Exercise the reopen reset statement and assert placeholder count equals bind count, build/normalize with `recordedAt`, reject a snapshot missing `blocking`, and map adjacent ids `9007199254740992`/`9007199254740993` to distinct strings. The source regression guard is also fed synthetic parameterized-SQL and ORM-upsert unsupported shapes and must fail closed with their function names; it is a regression check, not proof of all possible writers.

9. Top-level `R6-1 draft logs never start and emergency Start is independent`. On one eligible governed emergency case, save and update a draft log and assert the case status, both Start clocks, Start event count, snapshot and command ledger remain unchanged. On a second eligible emergency case with documented `emergency_basis` authority (no mode), invoke explicit status Start without creating any log and assert one Start succeeds. On a third case, finalize a log and assert only that finalized transition may invoke the shared Start path. Mutation `r6-1-draft-independent` makes the draft call `startCaseTx` or adds a finalized-log prerequisite to status Start and must fail the named lifecycle/count assertion.

10. Top-level `R6-2 started reopen resets current evidence and preserves attempt history`. Seed governed attempt 1, record explicit performed time-out, Start, and capture the attempt rows byte-for-byte. Cancel/reopen with current tokens. Assert attempt 2, both active clocks null, consent and time-out projections pending, Start still refuses only for consent, and attempt-1 evidence/at-start snapshot/attribution/clocks are byte-identical. With reuse disabled, attempt-1 evidence refuses. Enable an approved reuse policy, submit the same document plus `existing_document_applicability_confirmed: true`, and assert the server stores an attempt-2 `applicability_confirmation` with actor/time/evidence ids; no request-supplied server object survives. Time-out remains non-blocking after consent is restored.

11. Top-level `R6-2 pre-start reopen retains evidence and rotates lifecycle`. Record governed consent and time-out before Start, capture their rows, cancel, then reopen. Assert `procedure_attempt` stays 1, current evidence/status/metadata are byte-identical, the rows are rebound to the new token, and both Start clocks stay null; old-token delivery is stale. No consent/time-out reset or applicability reconfirmation occurs because no new attempt was created.

12. Top-level `R6-3 retrospective log records server Start with unknown clinical time`. Finalize a governed log with no clinical `started_at` and explicit `retrospective_time_unknown`. Assert the case and attempt row have `attempt_started_at = NULL`, a real equal `attempt_start_recorded_at`, and `actual_start_at` equal to that first recording instant. The log save/finalization timestamp is never copied into the clinical field; the snapshot/report preserve clinical unknown and use the recording instant operationally.

13. Top-level `R6-5 emergency basis stores no consent mode and prior evidence reuse is confirmed`. Under an approved policy, patient and representative records require an admitted mode; an emergency-basis request containing any communication-mode field is rejected, and an evidence-backed or attested-justification emergency record succeeds with no mode in current, attempt, snapshot, read or audit projections. Then reopen a started case: prior evidence refuses when policy disallows reuse or confirmation is absent, and succeeds only with policy permission plus the one-shot boolean, producing the server confirmation bound to attempt/actor/time/evidence ids.

14. Top-level `R6-6 documented authority is the only Start block across urgency categories`. For each supported urgency, seed all non-consent checks pending or unavailable and governed consent pass, supply the settled pending-check reason where required, then assert explicit Start succeeds without role expansion or signature. For the same urgency population, set consent pending and assert both explicit Start and finalized-log Start refuse at `assertConsentDocumented`. The test first asserts the exact non-empty urgency population; mutation `r6-6-authority-only` either consults another readiness result/urgency/signature or bypasses the assertion and fails the named per-urgency result.

Focused mutation commands:

```bash
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R4-1 replay and delayed first delivery are fenced on both start entry points$'
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R4-2 lifecycle and readiness evidence remain attributable after reopen and metadata replacement$'
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R4-3 paused candidate is invalidated and cannot block Start$'
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R4-4 age-only carry uses complete accepted evidence$'
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R5-2 delayed lifecycle commands cannot cross a lifecycle token$'
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R5-6 Start enforces governed consent attempt evidence$'
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R5-7 finalized-log first delivery and replay share one contract$'
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R5-11 operative snippets preserve bind counts snapshots and bigint ids$'
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R6-1 draft logs never start and emergency Start is independent$'
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R6-2 started reopen resets current evidence and preserves attempt history$'
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R6-2 pre-start reopen retains evidence and rotates lifecycle$'
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R6-3 retrospective log records server Start with unknown clinical time$'
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R6-5 emergency basis stores no consent mode and prior evidence reuse is confirmed$'
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R6-6 documented authority is the only Start block across urgency categories$'
```

Apply only the matching §12 mutation for each command, confirm that one selected test turns red, and revert before the next mutation.

- [ ] **Step 9: Run the deep suite on the scratch DB** — `DATABASE_URL="$CATH_READINESS_SCRATCH_DATABASE_URL" npm test -- --testPathPatterns cath-lab-readiness.deep`. PASS, `Suites failed: 0` read separately from `Tests passed`.

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

**Privacy release condition.** Re-run a repository-wide function/caller search for `readCanonicalPatientTimeline`, canonical-event copying, notification rendering, JSON/CSV exports and nested projections against the fetched implementation base. The current measured count is exactly four direct production call sites: the guarded route handlers in `emr/clinicalTimelineRoutes.js` and `patient/patientSearchRoutes.js`, plus `handoverService.generateHandoverDraft` and `clinicalNotesService.getPatientTimeline` behind their clinical patient/note route guards. Pin that known count and fail if a synthetic fifth direct reader is added without classification. Sentinel-test nested `reason`, emergency justification, evidence references and provenance for every admitted role and export shape. `visible_to_patient = false` is necessary but not sufficient.

**Files:**
- Modify: `apps/backend/src/services/clinical/cathLabService.js` (`listCases`)
- Modify: `apps/backend/src/services/clinical/cathLabReadinessProjection.js`
- Modify: `apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs`
- Test: `apps/backend/src/tests/unit/cathLabReadinessProjection.test.js`, `apps/backend/src/tests/unit/cathLabReadinessOpenApiSource.test.js`, `apps/backend/src/tests/unit/serologyDisclosureCanary.test.js`, `apps/backend/src/tests/unit/cathLabReadinessService.test.js` (the "never selects history" text test), `apps/backend/src/tests/cath-lab-readiness.deep.test.js` (day-list key set)

- [ ] **Step 1: Projection tests** — build a complete 15-key snapshot. Assert a non-entitled role receives the identical block and key set except `readiness_at_start.reason === null`; an entitled role receives the block unchanged; a null snapshot passes through; `projectStartReasonForRole` is exported. Also assert `started_with_readiness_pending: null` stays null and `consent_authority`, `lab_component_status`, and `missing_lab_items: null` survive unchanged.

- [ ] **Step 2: Implement the projection** — keep the snapshot's codes, causes, enums and booleans because they are checklist provenance; only the free-text reason is role-projected:

```js
export function projectStartReasonForRole(reason, role) {
  return roleSeesSerologyDetail(role) ? (reason ?? null) : null;
}

export function projectLabReadinessForRole(readiness, role) {
  if (!readiness || typeof readiness !== 'object') return readiness;
  const projected = { ...readiness };
  const snapshot = readiness.readiness_at_start;
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    projected.readiness_at_start = {
      ...snapshot,
      reason: projectStartReasonForRole(snapshot.reason, role),
    };
  }
  return projected;
}
```

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

- `CathLabCase`: required `procedure_attempt`, server `lifecycle_token`, nullable `attempt_start_recorded_at`, nullable clinical `attempt_started_at`, nullable provenance, and decimal-string `lab_readiness_generation`.
- `item.required` gains `'ordered_after_start', 'received_after_start', 'finalised_after_start', 'unavailability_cause'`; properties: three booleans with the spec's descriptions (**`received_after_start` = the deciding row was RECEIVED here after the active attempt's start; a row received before and signed after reads false — a receipt marker, transaction-start ordering**; `finalised_after_start` from `signed_off_at`, false unless signed); `unavailability_cause: { type: 'string', enum: UNAVAILABILITY_CAUSES, nullable: true }` imported from the rules module.
- `missing[]` items: `required: ['item', 'state', 'cause']`, `cause` the same nullable enum.
- `readiness.required` gains `procedure_attempt`, server-issued `lifecycle_token`, `attempt_start_recorded_at`, nullable clinical `attempt_started_at`, `attempt_start_time_provenance`, `first_started_at`, `started_with_readiness_pending`, and `readiness_at_start`. The snapshot declares exactly the 15 `START_SNAPSHOT_KEYS`, including both clocks/provenance and lifecycle token. `started_with_readiness_pending` remains tri-state; null is unknown, never clean.
- `case_started` description: Task 4 Step 6's text.
- Readiness-check write prose requires `expected_lifecycle_token` for consent/time-out. Patient/representative consent uses approved mode+evidence+scope; representative adds `representative_ref`; emergency basis uses an approved evidence reference or `justification`+`attested` and rejects `mode`. When a prior-attempt reference is admitted by the approved policy, the request may carry only `existing_document_applicability_confirmed: true`; the read model returns the server-stamped attempt/actor/time confirmation. Server-owned provenance/policy/time/history fields are rejected. A time-out pass requires `{ outcome: 'performed', performed_at }`; `{ outcome: 'not_performed', attested: true }` stays non-pass; absence is `not_documented`, while known performance with unknown chronology is `performed_timing_unknown`.
- `operations` gains **four** prose-only entries (`pathParameters: { id: BIGINT_WIRE }` where applicable, no `request` / `response`):
  - `'POST /api/v1/cath-lab/cases'` — `status` must be one of `CREATABLE_STATUSES` (400 `CATH_LAB_CASE_STATUS_NOT_CREATABLE`); a case is never created running or finished; `procedure_attempt`, `attempt_start_recorded_at` and `attempt_started_at` are not accepted; reserved metadata keys are stripped. (If the creation operation is already documented elsewhere in the overlay set, add the prose there and keep the pin's `PROSE_ONLY` count honest.)
  - `'POST /api/v1/cath-lab/cases/{id}/status'` — every lifecycle target requires `expected_lifecycle_token`; Start additionally requires `command_id`. Same-command/same-token replay is checked before transition eligibility, token mismatch is 409, cancellation rotates the token, and completion retains it. The response exposes the resulting server token. Start reads cached readiness and never awaits evidence resolution.
  - `'POST /api/v1/cath-lab/cases/{id}/procedure-logs'` — every log requires `log_command_id` and `expected_lifecycle_token`; duplicate detection precedes INSERT. A finalized log on a start-eligible case also requires independent `start_command_id` on both first delivery and replay and uses the one Start path. Supplied clinical `started_at` requires `retrospective_staff_attested` plus attestation; otherwise clinical timing remains unknown. Draft/amended logs never start; common canonical/log-reference/registry side effects complete before either response.
  - `'POST /api/v1/cath-lab/cases/{id}/reopen'` — cancelled only; reason, idempotency key and `expected_lifecycle_token` required; the idempotency receipt binds the reviewed cancellation token. It always rotates the token; if server recording proves a prior Start, opens attempt N+1 and resets current consent/time-out while preserving server-owned attempt history. It never accepts history/provenance from a client and never starts.
- **Consent-policy READ:** `GET /api/v1/cath-lab/cases/{id}/consent-policy` uses the existing cath workflow and case/patient guards and returns only `{ approved_version, authorities[], patient_representative_modes[], scopes[], allow_prior_attempt_evidence, conditional_required_fields[] }`; emergency basis has no mode. It omits signatures, internal approval records, evidence details and revoked versions. No approved current policy returns 503 `CATH_LAB_CONSENT_POLICY_UNAVAILABLE`.
- **Attempt-history READ:** `GET /api/v1/cath-lab/cases/{id}/attempts` is guarded by the existing cath case/patient workflow guards and returns ordered `{ procedure_attempt, lifecycle_token, attempt_start_recorded_at, attempt_started_at, attempt_start_time_provenance, consent_status, consent_authority, consent_policy_version, authority_clinical_timing, applicability_confirmation: { confirmed: boolean, confirmed_by, confirmed_at }, timeout_at_start_status, timeout_followup_status, timeout_outcome }`. It never returns raw metadata, evidence ids/refs, fingerprints, retained canonical evidence, external report text, free-text justification or server provenance internals. BIGINT ids are decimal strings.
- Day-list prose: `started_with_readiness_pending` is the seventh summary key and is tri-state.
- **`CASE_LIFECYCLE_ERROR_CODES`** (spec §9): a second exported enum listing `CATH_LAB_CONSENT_REQUIRED`, `CATH_LAB_CONSENT_AUTHORITY_REQUIRED`, `CATH_LAB_CONSENT_AUTHORITY_NOT_PERMITTED`, `CATH_LAB_CONSENT_POLICY_UNAVAILABLE`, `CATH_LAB_CONSENT_SHAPE_INVALID`, `CATH_LAB_CONSENT_EVIDENCE_REQUIRED`, `CATH_LAB_CONSENT_EVIDENCE_INVALID`, `CATH_LAB_CONSENT_EVIDENCE_SCOPE_INVALID`, `CATH_LAB_CONSENT_EVIDENCE_REUSE_NOT_PERMITTED`, `CATH_LAB_CONSENT_APPLICABILITY_REQUIRED`, `CATH_LAB_CONSENT_REPRESENTATIVE_REQUIRED`, `CATH_LAB_TIMEOUT_PERFORMED_AT_REQUIRED`, `CATH_LAB_TIMEOUT_OUTCOME_INVALID`, `CATH_LAB_TIMEOUT_ATTESTATION_REQUIRED`, `CATH_LAB_START_REASON_REQUIRED`, `CATH_LAB_START_COMMAND_REQUIRED`, `CATH_LAB_START_COMMAND_STALE`, `CATH_LAB_START_COMMAND_CONFLICT`, `CATH_LAB_CLINICAL_START_PROVENANCE_REQUIRED`, `CATH_LAB_LIFECYCLE_TOKEN_REQUIRED`, `CATH_LAB_LIFECYCLE_STALE`, `CATH_LAB_PROCEDURE_LOG_COMMAND_REQUIRED`, `CATH_LAB_PROCEDURE_LOG_COMMAND_CONFLICT`, `CATH_LAB_START_VIA_INVALID`, `CATH_LAB_CASE_STATUS_NOT_CREATABLE`, `CATH_LAB_CASE_CANCELLED_REOPEN_REQUIRED`, `CATH_LAB_CASE_START_NOT_ELIGIBLE`, `CATH_LAB_REOPEN_REASON_REQUIRED`, `CATH_LAB_REPORT_MONTH_INVALID`, `CATH_LAB_REPORT_FACILITY_INVALID`, `CATH_LAB_REPORT_AUDIT_FAILED` — documented on the four prose-only operations and (Task 6) the two report operations; exported through `ENUMS` for the pin.

In `cathLabReadinessOpenApiSource.test.js`: `PROSE_ONLY` gains the four keys; the readiness key-set assertion gains the five keys; the item key set is derived by driving the resolver (it picks the four new keys up by construction — confirm the `required` list matches); `it('readiness_at_start declares exactly START_SNAPSHOT_KEYS; its check_type enum is migration 482\'s; its cause enum is migration NNN\'s')` — parse `NNN_cath_lab_case_attempts.sql`'s `cath_case_lab_readiness_items_cause_check` list the way the file already parses 482's type CHECK and compare to `UNAVAILABILITY_CAUSES`; **the second scan**: `/'(CATH_LAB_(?:CONSENT|TIMEOUT|START|CLINICAL_START|LIFECYCLE|PROCEDURE_LOG|CASE_STATUS|CASE_CANCELLED|CASE_START|REOPEN|REPORT)_[A-Z_]+)'/g` over `cathLabService.js`, `cathConsentEvidenceResolver.js`, `cathLabReadinessRules.js`, `cathStartsWithPendingReportService.js` (Task 6 — add the report file then) and the cath router, compared to `CASE_LIFECYCLE_ERROR_CODES` **in both directions**; the existing `CATH_LAB_READINESS_*` scan and its scope are unchanged.

Run `npm test -- --testPathPatterns unit/cathLabReadinessOpenApiSource` → PASS (it will list `CATH_LAB_REPORT_*` as documented-but-unraised until Task 6 — either add those two to the enum in Task 6 or accept a red here that Task 6 turns green; say which in the commit message). Then `npm run openapi:generate && npm run openapi:check`; commit the regenerated `src/docs/openapi.json` and `packages/vhhealth_core/swagger/openapi.json`.

- [ ] **Step 5: Canary — five free-text sentinels, CSV bodies, the write mirror** (spec §6.4, §6.5)

- Sentinels: distinct constants for start reason, prior-attempt start reason, reopen reason, copied cancel reason, and emergency-basis justification.
- `CASE_ROW` includes attempt 2, server lifecycle token, recording and clinical clocks/provenance, generation, first-start history, tri-state flag and a complete 15-key current snapshot. Server-owned snapshot history carries the prior reason only on entitled write responses; every readiness item includes lateness booleans and approved cause/status fields, and explicitly excludes both fingerprints and retained accepted evidence.
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

## Task 6: Monthly report of starts with checks pending — start events, tenant-wide access with facility filtering, both mounts audited, bounds-converted predicate, EXPLAIN gate

**Files:**
- Modify: `apps/backend/src/utils/roleHelpers.js`
- Create: `apps/backend/src/services/clinical/cathStartsWithPendingReportService.js`
- Create: `apps/backend/src/routes/clinical/cathStartsWithPendingReportHandler.js`
- Modify: `apps/backend/src/routes/clinical/cathLabRoutes.js`, `apps/backend/src/routes/clinical/cathReprocessingPolicyRoutes.js`
- Modify: `apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs`
- Create: `apps/backend/src/tests/unit/cathStartsWithPendingReportService.test.js`
- Test: `apps/backend/src/tests/unit/cathLabReadinessOpenApiSource.test.js`, `apps/backend/src/tests/unit/serologyDisclosureCanary.test.js` + reachable fixture, `apps/backend/src/tests/unit/cathLabRouteGuards.test.js` (route probes), the roleHelpers unit test, `apps/backend/src/tests/cath-lab-readiness.deep.test.js`

Revision-6 control: report rows are Start events joined to `cath_lab_attempt_readiness_records` on tenant + case + `procedure_attempt` from the immutable event snapshot. They never join `cath_lab_readiness_checks`. The query selects `at_start_*` and same-attempt `current_*` into separate fields; no `COALESCE` crosses that boundary. `audit_logs.start_recorded_at` is the bound Start recording instant and the only range/order key; nullable `clinical_started_at` stays separate, while `audit_logs.created_at`/`NOW()` is bookkeeping. `CATH_LAB_INCHARGE` has tenant-wide access subject to the same tenant isolation, role projection and access auditing as every other admitted role. `facility_id` only narrows rows within that authorized tenant; it is not an authorization boundary and never expands access. Report access uses a dedicated `recordCathReadinessReportAccessTx({ tenantId, ... })` that inserts an explicit `tenant_id` and propagates every failure; the existing best-effort `logAudit` helper is not admissible because current `logAudit` catches errors and its INSERT does not bind `tenant_id`. No response body or CSV bytes are sent until that audit transaction commits.

- [ ] **Step 1: Failing unit tests** (`cathStartsWithPendingReportService.test.js`). The following is an assertion inventory, not copyable source; use the file's concrete mock factory and write complete test bodies.

The unit matrix must assert:

- IST month parsing and invalid month/facility rejection before a query.
- The SQL binds tenant, start, end and optional facility; filters and orders only by indexed `audit_logs.start_recorded_at`; joins timeout by tenant/case/attempt; and never names `cath_lab_readiness_checks`.
- Two rows with BIGINT ids `9007199254740992` and `9007199254740993` remain distinct decimal strings in rows and `distinct_cases`.
- Timeout outcomes cover readiness exemption, explicit non-performance, undocumented, performed at-or-before (including equality at stored precision), performed after, and performed with unknown timing. Stored `outcome: performed` is never lost.
- Incomplete/legacy snapshots preserve null attempt/blocking/missing state; they never become a clean start.
- Role projection preserves the key set and blanks only the permitted reason; CSV keeps the exact 25-column order and emits empty cells for unknown arrays.

In the role-helper unit test, assert the exact ordered role population below, a positive for each member, and negatives for `CATH_LAB_STAFF`, `RECEPTIONIST`, `PATIENT`, null and an unknown role. Assert the input is normalized before membership is checked.

- [ ] **Step 2: Run to verify they fail** — module not found.

- [ ] **Step 3: Implement roles and the service** — add the role contract, then the service:

```js
export const CATH_READINESS_REPORT_ROLES = Object.freeze([
  ROLES.ADMIN,
  'SUPER_ADMIN',
  ROLES.CATH_LAB_INCHARGE,
  ROLES.QUALITY_OFFICER,
]);
export const canReadCathReadinessReport = (role) =>
  CATH_READINESS_REPORT_ROLES.includes(normalizeCanonicalRole(role));
```

```js
export const START_AUDIT_ACTION = 'cath_lab.case.started_with_readiness_pending';
export const CSV_COLUMNS = Object.freeze(['month', 'start_event_id', 'case_id', 'procedure_attempt', 'facility_id', 'facility_name', 'urgency', 'via',
  'start_recorded_at', 'clinical_started_at', 'blocking_check_types', 'missing_lab_items', 'lab_component_status', 'consent_authority',
  'timeout_at_start_status', 'timeout_at_start_performed_at', 'timeout_at_start_documented_at',
  'timeout_followup_status', 'timeout_followup_performed_at', 'timeout_followup_documented_at',
  'timeout_outcome', 'reason', 'actor_uid', 'actor_role', 'actor_name']);
const TIMEOUT_OUTCOMES = ['readiness_exempt_at_start', 'performed_at_or_before_start', 'performed_after_start', 'performed_timing_unknown', 'not_performed', 'not_documented'];

function facilityFilter(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw AppError.badRequest('facility_id must be a positive integer', 'CATH_LAB_REPORT_FACILITY_INVALID');
  return n;
}
// The time-out's outcome for ONE Start event (spec §7.3), from its immutable
// snapshot and its exact attempt record. Absence never means non-performance.
function timeoutOutcomeFor(snapshot, row) {
  const atStartStatus = row.timeout_at_start_status ?? null;
  if (atStartStatus === 'waived' || atStartStatus === 'not_applicable') return 'readiness_exempt_at_start';
  const atStart = row.timeout_at_start_meta ?? {};
  const followup = row.timeout_followup_meta ?? {};
  // Same-attempt follow-up is the latest documented outcome; immutable
  // at-start evidence is the fallback and remains projected separately.
  const evidence = followup.outcome ? followup : atStart;
  if (evidence.outcome === 'not_performed' && evidence.attested === true) return 'not_performed';
  if (evidence.outcome !== 'performed') return 'not_documented';
  const performed = toMs(evidence.performed_at);
  // Performance is known from the immutable governed outcome even when a
  // legacy clinical occurrence instant is absent or malformed.
  if (!Number.isFinite(performed)) return 'performed_timing_unknown';
  const clinical = toMs(snapshot?.clinical_started_at);
  if (!Number.isFinite(clinical)) return 'performed_timing_unknown';
  // Timestamps are stored at microsecond precision; equality is at-or-before.
  return performed <= clinical ? 'performed_at_or_before_start' : 'performed_after_start';
}
function rowFrom(row) {
  const raw = row.metadata && typeof row.metadata === 'object' ? row.metadata : null;
  const snapshot = normalizeStartSnapshot(raw);
  return {
    start_event_id: String(row.start_event_id), case_id: String(row.case_id), procedure_attempt: snapshot?.procedure_attempt ?? null,
    facility_id: row.facility_id == null ? null : Number(row.facility_id), facility_name: row.facility_name ?? null,
    urgency: snapshot?.urgency ?? null, via: snapshot?.via ?? null,
    start_recorded_at: row.start_recorded_at == null ? null : new Date(row.start_recorded_at).toISOString(),
    clinical_started_at: snapshot?.clinical_started_at ?? null,
    blocking_check_types: snapshot ? snapshot.blocking.map((b) => String(b.check_type)) : null,
    missing_lab_items: snapshot?.missing_lab_items ?? null,
    lab_component_status: snapshot?.lab_component_status ?? 'unavailable', consent_authority: snapshot?.consent_authority ?? null,
    timeout_at_start_status: row.timeout_at_start_status ?? null,
    timeout_at_start_performed_at: row.timeout_at_start_meta?.performed_at ?? null,
    timeout_at_start_documented_at: row.timeout_at_start_documented_at == null ? null : new Date(row.timeout_at_start_documented_at).toISOString(),
    timeout_followup_status: row.timeout_followup_status ?? null,
    timeout_followup_performed_at: row.timeout_followup_meta?.performed_at ?? null,
    timeout_followup_documented_at: row.timeout_documented_at == null ? null : new Date(row.timeout_documented_at).toISOString(),
    timeout_outcome: timeoutOutcomeFor(snapshot, row),
    reason: snapshot?.reason ?? null, actor_uid: row.actor_uid ?? null, actor_role: row.actor_role ?? null, actor_name: row.actor_name ?? null,
  };
}
export async function startsWithPendingReport({ tenantId, month, facilityId } = {}) {
  const tid = requireTenantId(tenantId);
  const { start, end } = monthBoundsIst(month);
  const facility = facilityFilter(facilityId);
  const rows = await setTenant(tid, (client) => client.$queryRawUnsafe(
    `SELECT a.id::text AS start_event_id, a.start_recorded_at, a.created_at AS event_created_at,
            a.actor_uid, a.role AS actor_role, u.name AS actor_name,
            NULLIF(a.resource_id, '')::bigint::text AS case_id, a.metadata,
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
        AND a.action = $5
        -- The bound Start recording instant is stored and indexed separately;
        -- audit created_at/NOW() is bookkeeping and never selects the month.
        AND a.start_recorded_at >= $2::timestamptz
        AND a.start_recorded_at <  $3::timestamptz
        AND ($4::int IS NULL OR NULLIF(a.metadata->>'facility_id', '')::int = $4::int)
      ORDER BY a.start_recorded_at DESC, a.id DESC`,
    tid, start, end, facility, START_AUDIT_ACTION));
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
    row.start_recorded_at, row.clinical_started_at, row.blocking_check_types == null ? '' : row.blocking_check_types.join(';'), row.missing_lab_items == null ? '' : row.missing_lab_items.join(';'), row.lab_component_status, row.consent_authority,
    row.timeout_at_start_status, row.timeout_at_start_performed_at, row.timeout_at_start_documented_at,
    row.timeout_followup_status, row.timeout_followup_performed_at, row.timeout_followup_documented_at,
    row.timeout_outcome, row.reason, row.actor_uid, row.actor_role, row.actor_name]));
}
```

(`normalizeStartSnapshot` reads the flat snapshot keys off the audit metadata — the dedicated Start audit writer spreads `...snapshot` into it. A legacy incomplete row normalizes to `null`; the report preserves unknown fields and never manufactures `blocking: []` or attempt 1. `START_AUDIT_ACTION` is bound as `$5`; it is never interpolated into SQL.)

- [ ] **Step 4: Run the unit tests** — PASS.

- [ ] **Step 5: The handler — audited on both mounts, before the response** (spec §7.4)

```js
export default function cathStartsWithPendingReportHandler({ mount }) {
  return async function handler(req, res) {
    try {
      const tenantId = resolveTenantOrThrow(req);
      const role = req.user?.role || req.user?.rawRole || null;
      if (!canReadCathReadinessReport(role)) {
        throw AppError.forbidden('This role cannot read the cath readiness report');
      }
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

`recordCathReadinessReportAccessTx` is fail-closed and names its error without swallowing it:

```js
async function recordCathReadinessReportAccessTx({ tenantId, actorUid, actorRole, action, resource, resourceId, metadata }) {
  try {
    await setTenantTx(tenantId, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO audit_logs
         (tenant_id, uid, role, action, resource, resource_id, metadata, actor_uid, created_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $2::uuid, NOW())`,
      requireTenantId(tenantId), actorUid, actorRole, action, resource, resourceId,
      JSON.stringify(metadata ?? {})));
  } catch {
    throw AppError.internal('Cath readiness report access audit failed',
      'CATH_LAB_REPORT_AUDIT_FAILED');
  }
}
```

Registration remains on both mounts, with the cath route placed before the parameterized report route. Neither mount adds a facility membership guard: tenant context plus `canReadCathReadinessReport` authorizes, and the optional facility value only narrows the query.

- [ ] **Step 6: Route-order, role, tenant and fail-closed probes**: admitted roles receive 200 only after one explicit-tenant audit insert; denied roles receive 403; malformed parameters receive 400; a forced audit INSERT rejection returns an error with no JSON or CSV body emitted; two tenants cannot observe each other's report-access rows. Cover both mounts and both formats.

- [ ] **Step 7: OpenAPI** — `CathLabStartsWithPendingRow` (the 25 row keys: separate `start_recorded_at`/nullable `clinical_started_at`, six separate timeout-at-start/follow-up fields, plus `timeout_outcome`; `missing_lab_items` nullable, `consent_authority` nullable enum, `lab_component_status` enum), `CathLabStartsWithPendingReport` (`month`, `facility_id` nullable, `total_events`, `distinct_cases`, `facilities[]` with `events` + `cases`, `timeout_outcomes`, `consent_authorities`, `rows[]`), envelope; both operations with `parameters: month (required, pattern), facility_id (optional, integer ≥ 1), format (json|csv)`; description states: **identifiable operational data** (case ids resolve to patients; actors named), counts start **events** not distinct cases, IST month, reason projected, every read audited (`cath_lab.report.starts_with_pending.read`, `format` recorded), 400 codes in prose; `READS` gains both; `CATH_LAB_REPORT_*` in `CASE_LIFECYCLE_ERROR_CODES`; add `cathStartsWithPendingReportService.js` to the lifecycle scan's file set. `npm run openapi:generate && npm run openapi:check`.

- [ ] **Step 8: Canary** — seed a start audit with all 15 snapshot keys and a matching `cath_lab_attempt_readiness_records` timeout row for that exact attempt. Probe both report mounts as JSON and CSV, verify the same two reachable-route additions, positive-control the entitled reason, and prove non-entitled roles see projected nulls in nested JSON and empty CSV cells.

- [ ] **Step 9: Deep** — after the point-4 test's second start (attempt 2, pending), derive the report month from that Start snapshot's `recorded_at` and assert `startsWithPendingReport` contains its decimal-string `start_event_id`, `procedure_attempt: 2`, `consent_authority: 'patient'`, a valid `timeout_outcome`, and `distinct_cases ≤ total_events`; `facilityId: FACILITY_ID` returns the same row, a non-existent facility returns none. Through the route, one GET on each mount creates two explicit-tenant access-audit rows with different `metadata.mount`, and a CSV read creates a third with `format: csv`; `reportToCsv` has at least two lines.

- [ ] **Step 9a: Add the decisive report and clock tests**

In `cath-lab-readiness.deep.test.js`, add top-level `R4-5 timeout history preserves outcome and clock uncertainty`. Seed case A through the approved policy and governed readiness writers with labs/time-out pending. Start attempt 1 through a finalized procedure log with clinical timing explicitly unknown; capture the report row and snapshot. Cancel/reopen using the current token, write attempt-2 `{ outcome: 'performed', performed_at }`, then Start attempt 2. Assert attempt 1 is byte-stable/`not_documented`; attempt 2 retains `outcome: performed` and maps to at-or-before, after, or `performed_timing_unknown` from clinical time, never from absence in `blocking`. Seed explicit attested non-performance and waived-at-start cases. Equal stored timestamps map to `performed_at_or_before_start`. An incomplete snapshot stays unknown and never becomes clean.

Also add top-level `R5-10 report month follows bound Start recording time`. In a transaction whose `NOW()` is pinned before a month boundary, advance wall time so bound `clock_timestamp()` falls in the next month; call Start and assert audit `created_at` remains transaction-start bookkeeping while `start_recorded_at` equals the snapshot and the event appears only in the latter month. The SQL must filter/order the indexed `a.start_recorded_at`. A classifier call without explicit database evaluation time must throw.

Add top-level `R6-4 report access is tenant-wide and facility filter only narrows`. Seed two facilities in tenant A and one in tenant B, each with a qualifying Start event. As `CATH_LAB_INCHARGE` for tenant A, the unfiltered request returns both tenant-A facilities and never tenant B; each facility filter returns only the selected tenant-A subset, and a tenant-B facility id returns no rows rather than granting or revealing access. Assert identical role projection and one committed access audit per read. The test first asserts the exact seeded event/facility population. Mutation `r6-4-report-scope` adds a facility-membership authorization precondition or removes tenant/role/audit enforcement and must fail the named population/access assertion.

```bash
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R4-5 timeout history preserves outcome and clock uncertainty$'
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R5-10 report month follows bound Start recording time$'
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R6-4 report access is tenant-wide and facility filter only narrows$'
```

Run Task 9's receipts `r4-5-timeout`, `r5-10-clock` and `r6-4-report-scope`. Mutate only the named mechanism, require exactly one selected failure at its assertion id, restore exact source bytes, and require the same one selected pass.

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
git commit -m "feat(cath): monthly starts-with-pending report — start events with attempt id, tenant-wide access with facility filtering, time-out and consent breakdowns, audited on both mounts, bounds-converted predicate with EXPLAIN gate, CSV

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
## Task 7: Staff app — Start / Reopen, live updates over `staff:lab`, consent authority, time-out instants, the picture

**Revision-5 load/realtime contract.** Opening a case renders the server's cached readiness projection immediately and schedules refresh only when `readiness_dirty` or the stored freshness state requires it. After a changed publish transaction commits, the backend emits a case-scoped event carrying `case_id`, `lifecycle_token`, and monotonically increasing `lab_readiness_generation`; a no-op publish emits nothing. Staff coalesces bursts with a trailing debounce **and** a maximum 2-second wait. An authoritative reload caused by remote cancel/reopen or reconnect may adopt a new lifecycle token and invalidates older request epochs. An obsolete response may never restore the previous token; within one token, a lower generation is also discarded. Tests cover commit → emission → delivery → fetch → render, delivered payload fields, no-op silence, a burst that cannot postpone refresh forever, remote cancel/reopen, disconnect/reconnect catch-up, and an older response arriving after a newer one.

**Files:**
- Modify: `apps/backend/src/utils/websocket/realtimeEmitter.js`
- Test: `apps/backend/src/tests/unit/realtimeEmitter.test.js`
- Modify: `apps/staff/lib/features/cath_lab/models/cath_readiness_models.dart`, `services/cath_lab_api_service.dart`, `widgets/cath_readiness_checklist.dart`, `widgets/cath_lab_readiness_panel.dart`, `screens/cath_lab_screen.dart`, `apps/staff/lib/l10n/app_strings.dart`
- Test: `apps/staff/test/features/cath_lab/cath_readiness_checklist_test.dart`, `cath_lab_screen_test.dart`, `apps/staff/test/i18n_guard_test.dart`

- [ ] **Step 0: Backend emitter payload** — change `emitLabEvent` itself; the baseline currently broadcasts only `{ kind, at }`.

```js
export function emitLabEvent(kind, { tenantId, caseId = null, lifecycleToken = null, labReadinessGeneration = null } = {}) {
  const payload = { kind, at: new Date().toISOString() };
  if (kind === 'cath-readiness-updated') {
    if (caseId == null || lifecycleToken == null || labReadinessGeneration == null) {
      throw new TypeError('cath-readiness-updated requires caseId, lifecycleToken and labReadinessGeneration');
    }
    Object.assign(payload, { case_id: String(caseId), lifecycle_token: String(lifecycleToken),
      lab_readiness_generation: String(labReadinessGeneration) });
  }
  try {
    broadcast('staff:lab', payload, { tenantId });
  } catch (err) {
    logger.warn('emitLabEvent failed:', err.message);
  }
}
```

The unit test subscribes through the real tenant broadcaster and asserts the delivered object—not just mock call arguments—has exactly `kind`, `at`, `case_id`, `lifecycle_token`, and `lab_readiness_generation` for this kind. Generic kinds retain `{ kind, at }`. The publisher calls this only after a changed commit; `obsolete_candidate` and `no_change` emit nothing.

Add top-level backend integration test `R5-9 realtime delivers generation and survives remote reopen`. It drives changed publish → actual delivered payload → cached reload, then remote cancel and remote reopen. Each authoritative response adopts the new token and invalidates earlier request epochs; release an older response last and assert it cannot restore the prior token. A no-op publish produces no event and no reload loop. Run and receipt it exactly:

```bash
npm test -- --runInBand --testPathPatterns cath-lab-readiness.deep -t '^R5-9 realtime delivers generation and survives remote reopen$'
```

Task 9 mutation `r5-9-realtime` removes one of the emitter field, no-op guard or request-epoch check; the same selected test must fail at `r5-9-realtime`, then pass after exact-byte restoration.

- [ ] **Step 1: Models — failing parse tests** — cover `procedure_attempt`, server `lifecycle_token`, case and attempt-record `attempt_start_recorded_at`, nullable clinical `attempt_started_at`, approved provenance/status/cause codes, generation, tri-state snapshot with all 15 keys, conditional consent records, server-projected applicability confirmation, time-out outcome plus clinical/recording instants, and projected read-only attempt history. Assert that fingerprints, retained canonical evidence, `external_report_ref` and `performed_by_lab` are absent. `started` is true from `attempt_start_recorded_at`, not historical `actual_start_at` or nullable clinical time.

- [ ] **Step 2: Models — implement** — include both clocks on the case and each projected attempt record, provenance, lifecycle token, generation, 15-key snapshot, conditional consent policy fields including `allow_prior_attempt_evidence`, projected applicability confirmation, time-out outcome, approved item state/cause and projected read-only attempt history. Attempt history has no client serializer. Server-only fingerprints and canonical evidence have no Staff fields. `started` derives from `attemptStartRecordedAt` (with `caseStatus == in_progress` only as a defensive inconsistency warning), and every attempt-specific API call posts the latest token as `expected_lifecycle_token`.

- [ ] **Step 3: API**

```dart
  /// POST /cath-lab/cases/:id/status with in_progress. [commandId] is the stable
  /// per-decision token the server binds to the attempt (CATH_LAB_START_COMMAND_
  /// REQUIRED without it; CATH_LAB_START_COMMAND_STALE if the case was reopened
  /// since). Mint it ONCE per confirmation with IdempotencyKey.generate() and
  /// reuse it on every retry — the caller owns it, this method never mints.
  static Future<CathCaseReadiness> startCase(int caseId, {required String commandId, required String expectedLifecycleToken, String? reason}) async {
    final response = await ApiClient.post('/cath-lab/cases/$caseId/status', body: {
      'status': 'in_progress', 'command_id': commandId,
      'expected_lifecycle_token': expectedLifecycleToken,
      if (reason?.trim().isNotEmpty == true) 'reason': reason!.trim(),
    });
    final data = _successfulData(response, 'Failed to start Cath Lab case');
    return CathCaseReadiness.fromJson(Map<String, dynamic>.from(data['case'] as Map));
  }
  static Future<CathCaseReadiness> transitionCaseStatus(int caseId, {required String status,
      required String expectedLifecycleToken, String? reason}) async {
    final response = await ApiClient.post('/cath-lab/cases/$caseId/status', body: {
      'status': status, 'expected_lifecycle_token': expectedLifecycleToken,
      if (reason?.trim().isNotEmpty == true) 'reason': reason!.trim(),
    });
    final data = _successfulData(response, 'Failed to update Cath Lab case status');
    final raw = data['case'] is Map ? data['case'] as Map : data;
    return CathCaseReadiness.fromJson(Map<String, dynamic>.from(raw));
  }
  /// POST /cath-lab/cases/:id/reopen. The Idempotency-Key and the reviewed
  /// cancellation token are both reused for transport retries of one decision.
  static Future<CathCaseReadiness> reopenCase(int caseId, {required String reason,
      required String idempotencyKey, required String expectedLifecycleToken}) async {
    final response = await ApiClient.post('/cath-lab/cases/$caseId/reopen',
      idempotencyKey: idempotencyKey,
      body: {'reason': reason.trim(), 'expected_lifecycle_token': expectedLifecycleToken});
    final data = _successfulData(response, 'Failed to reopen Cath Lab case');
    final raw = data['case'] is Map ? data['case'] as Map : data;
    return CathCaseReadiness.fromJson(Map<String, dynamic>.from(raw));
  }
  // updateReadinessCheck and recordProcedureLog likewise require
  // expectedLifecycleToken and serialize expected_lifecycle_token. No Staff
  // dependency may omit it.
```

Mirror `waiveLabItem`'s error handling (`_successfulData`).

- [ ] **Step 4: Checklist — failing widget tests** (extend `_readiness(...)` with `caseStatus`, `procedureAttempt`, `attemptStartedAt`, `blocking`, per-check statuses/metadata, and `labs` fields; inject every lifecycle dependency plus `labEvents`/`connectionStates`). The following is an assertion inventory, not copyable Dart; write complete widget tests with the existing host and dependency fakes.

The widget matrix must assert:

- Start is disabled until governed consent passes; a clean Start posts one minted `commandId` and displayed `expectedLifecycleToken`; a pending-check Start additionally requires a reason. A transport retry reuses both, while a new decision mints a new command.
- Every dependency callback has the required lifecycle token: Start, cancel, complete, reopen, consent, time-out and procedure log. Stale/conflict forces authoritative reload.
- Reopen appears only for cancelled cases, requires reason + idempotency key + displayed cancellation token, reuses all three on retry, and adopts the returned token only from the authoritative response.
- Conditional consent forms follow the approved policy. Emergency basis has no mode and never says consent was obtained. When permitted prior evidence is selected, “applies to this attempt” is required and only its boolean is sent; the server confirmation remains read-only. Timeout posts explicit outcome and separates clinical occurrence from server documentation.
- Tri-state start banners, critical/late item chips, picture timestamp and disconnected state render without altering the non-restrictive Start control.
- A delivered `staff:lab` event with `case_id`, token and `lab_readiness_generation` triggers one bounded-debounce reload. No-op publication emits nothing. Reconnect and remote cancel/reopen permit authoritative token adoption; a later obsolete response cannot restore the old token.
- Pre-start screens do not subscribe, and all stream/timer resources are cancelled on dispose.

`cath_lab_screen_test.dart`: the `RealtimeStatusBanner` watches `staff:lab` too — a denied `staff:lab` shows the red form; the header chip `cath-readiness-header-started-pending` renders on `true` only.

- [ ] **Step 5: Checklist — implement**

- `CathReadinessDependencies` gains `startCase` (`Future<CathCaseReadiness> Function(int caseId, {required String commandId, required String expectedLifecycleToken, String? reason})`), `transitionStatus` (`Future<CathCaseReadiness> Function(int caseId, {required String status, required String expectedLifecycleToken, String? reason})`), `reopenCase` (`Future<CathCaseReadiness> Function(int caseId, {required String reason, required String idempotencyKey, required String expectedLifecycleToken})`), `recordProcedureLog` (`Future<CathProcedureLogResult> Function(int caseId, {required String logCommandId, required String expectedLifecycleToken, String? startCommandId, Map<String,dynamic>? body})`), `updateCheck` (`Future<CathCaseReadiness> Function(int caseId, {required String checkType, required String status, required String expectedLifecycleToken, Map<String,dynamic>? metadata})`), `labEvents` and `connectionStates`. Every production default and test callback has the exact token parameter. Start/cancel/complete/reopen return the authoritative case projection so the caller can adopt the resulting server token; finalized-log results include the authoritative case when they start one.
- **Start row** (`_StartRow`, key `cath-readiness-start`) uses a command id minted once per confirmation and the lifecycle token captured from the same displayed server response. Retries reuse both. `CATH_LAB_LIFECYCLE_STALE` or command conflict forces reload and a fresh review; the client never invents or edits a token. Reason/Start-definition/picture behavior remains as specified above.
- **Reopen row** (`cath-readiness-reopen`) when `caseStatus == 'cancelled'`: dialog body `reopen_body` + `reopen_new_attempt_note` when `readiness.attemptStartRecordedAt != null || readiness.firstStartedAt != null`; the server remains authoritative. Reopen keeps its existing idempotency-attempt convention and refreshes the returned server lifecycle token.
- **Banners**: `startedWithReadinessPending == true` → amber `cath-readiness-started-pending-banner` (checks from `readinessAtStart.blocking` + `missingLabItems`, `· lab picture unavailable at start` when `missingLabItems == null`); `== null && started` → muted `cath-readiness-start-undocumented`; `false` → nothing. Independently, when any live item has `isCritical == true`, render the existing red critical-result banner with the affected item codes; it warns and never disables or changes Start/status actions.
- **Chips**: documentation lateness compares server `documentedAt` with `attemptStartRecordedAt`; clinical performance compares `performedAt` with nullable `attemptStartedAt`. The UI presents `performed_at_or_before_start`, `performed_after_start`, `performed_timing_unknown`, `not_documented`, explicit `not_performed`, or `readiness_exempt_at_start` without collapsing the two clocks. Known performance with unknown clinical timing is never labelled “Performed after start”.
- **Consent form** is built from the approved server policy with no client default. Patient and representative show required mode, evidence reference and scope; representative also requires representative reference. Emergency basis hides/rejects mode and requires either an approved documentation reference or justification plus an attestation control. When the server policy permits prior-attempt evidence and the selected reference is prior/unknown-attempt, show a required “applies to this attempt” confirmation and send only `existing_document_applicability_confirmed: true`; Staff never serializes the server confirmation object. Every write sends `expected_lifecycle_token`; captions never call emergency basis “consent obtained.” Legacy server-marked rows display read-only provenance and require a fresh governed record to change.
- **Time-out form** makes the outcome explicit. Performed sends `{ outcome: 'performed', performed_at }`; not performed sends `{ outcome: 'not_performed', attested: true }` and does not mark the check passed. Empty/pending displays “not documented”; known performance without a comparable clinical instant displays “performed — timing unknown,” never “Performed after start.” Show clinical occurrence separately from server recording/documentation time and send `expected_lifecycle_token`.
- **Picture line** `cath-readiness-picture-as-of` (`picture_as_of` `{time}`) + `picture_paused` suffix when `connectionState != connected` (subscribed through `connectionStates`).
- **Live updates**: in `initState` / when the loaded case is started, `_labSub = _labEvents('staff:lab').listen(_onLabEvent)` with a 400 ms trailing debounce and a 2-second maximum wait into `_reload(authoritative: true)`; cancel on dispose and when the case is no longer started. Each reload carries an incrementing request epoch. An authoritative remote cancel/reopen or reconnect response may adopt its new lifecycle token and then invalidates older epochs; any older response is discarded before token comparison and cannot restore the previous token. Within the current token, a lower `lab_readiness_generation` is discarded. Pre-start: no subscription.

`cath_lab_readiness_panel.dart`: `showOrderMissing = labs.orderableNow.isNotEmpty;` `canEnterExternal = !item.available;` (drop `!labs.caseStarted` from both; un-waive keeps #1018's gate on `caseStarted`, which now means the active attempt); item chip `cath-lab-item-after-start-<code>` when any of the three booleans is true; the item caption shows the cause label when set (`item.unavailability_cause` → `s4.lib.cath_lab.readiness.cause.<cause>`; add the seven keys to the string list below if you render them — otherwise render the raw code in a muted style and note it).

`cath_lab_screen.dart`: configure the existing `RealtimeStatusBanner` with `watchChannels: const {'staff:code-stemi', 'staff:lab'}` while preserving its existing child/builder arguments; `_headerSignals` reads the tri-state (`== true` only) for the chip.

- [ ] **Step 6: Strings (five locales; hi/ta/te/ml carry `// REVIEW: AI first-pass cath readiness never-restricts (rev 2) - confirm wording before production.`)**

Under `s4.lib.cath_lab.readiness.`, retain every existing readiness key and implement this additive pinned set in all five locales: evidence reference, scope, representative reference, emergency document reference, emergency justification, emergency attestation, `not_documented`, `performed_timing_unknown`, `not_performed`, `readiness_exempt_at_start`, clinical start time, server recording time, reconnecting, and stale-response suppression. Remove `{mode}` from the emergency caption in all locales. The guard compares the exact full key set and placeholder signatures across all five locales.

- [ ] **Step 7: Run and commit**

```bash
cd apps/staff && flutter analyze && flutter test test/features/cath_lab test/i18n_guard_test.dart
git add apps/staff/lib/features/cath_lab apps/staff/lib/l10n/app_strings.dart apps/staff/test/features/cath_lab apps/staff/test/i18n_guard_test.dart
git commit -m "feat(staff): cath start with a stable command id and the Start definition, reopen with the new-attempt note, live warnings over staff:lab, consent authority/mode, time-out performed-at, tri-state started-with-pending, cause on items

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 8: Admin — "Starts with checks pending" tab (tenant-wide access with facility filtering, breakdowns, identifiability)

**Files:**
- Modify: `apps/admin/src/lib/api/cathDevices.ts`
- Create: `apps/admin/src/app/(with-auth)/dashboard/quality/cath/components/StartsWithPendingTab.tsx`
- Modify: `apps/admin/src/app/(with-auth)/dashboard/quality/cath/page.tsx`
- Create: `apps/admin/src/__tests__/dashboard/quality/cath-starts-with-pending.test.tsx`

- [ ] **Step 1: Failing test** — use the exact Task 6 report contract: `total_events`, `distinct_cases`, `facilities[].events/cases`, `timeout_outcomes`, `consent_authorities`, and rows with `start_event_id`, `procedure_attempt`, separate `start_recorded_at`/nullable `clinical_started_at`, the six separate time-out phase fields, `lab_component_status`, `consent_authority`, `timeout_outcome`, and `missing_lab_items: null`. Assert “unknown” for null missing items, the identifiability header, per-facility table, both breakdown blocks, attempt/outcome rows, a dash for projected-null reason, month and facility re-query behavior, and CSV export with `(month, facilityId)`.

- [ ] **Step 2: API helpers** — `getCathStartsWithPendingReport(month, facilityId?)` and `downloadCathStartsWithPendingCsv(month, facilityId?)` (`apiFetch` from `../api-fetch`, `Accept: text/csv`); the `CathStartsWithPendingRow` interface has exactly the 25 ordered `CSV_COLUMNS` fields defined in Task 6, while `CathStartsWithPendingReport` adds the aggregate and facility/breakdown objects stated in §7.3.

- [ ] **Step 3: The tab and the page** — `"use client"`; month input (`aria-label="Month"`); facility `<select aria-label="Facility">` fed from the current report's `facilities[]` (plus "All"); header: "This identifiable report counts Start events (one row per Start; a reopened case can appear more than once). Consent authority and evidence are revalidated by the server when known; legacy or retrospective timing may remain explicitly unknown. The reason column is shown to the clinical audience only."; KPI line `total_events` / `distinct_cases`; facilities table (`events`, `cases`); breakdown blocks for `timeout_outcomes` and `consent_authorities`; rows table (start event id, case id, attempt, facility, urgency, via, recorded start, clinical start or "unknown", time-out at start, same-attempt follow-up, blocking, missing items or "unknown", lab picture status, consent authority, time-out outcome, reason or —, actor); Download CSV via the `lib/exportToCsv.ts` anchor helper. `page.tsx`: `TABS` gains `{ key: "starts-with-pending", label: "Starts with checks pending", icon: AlertTriangle }`.

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
DATABASE_URL="$CATH_READINESS_SCRATCH_DATABASE_URL" node scripts/check-schema-drift.mjs
cd ../.. && node scripts/ci/security.mjs
```

Read `Suites failed` separately from `Tests passed`.

- [ ] **Step 3: Two fresh-DB deep runs** — run `npm test -- --runInBand --testPathPatterns "cath-lab-case-attempts-migration.deep|cath-lab-readiness.deep|cath-reporting.deep|lab-signoff-safety.deep|bloodborne-markers.deep"` against each of two independently created empty databases. Both runs must be green with identical selected/passed/suite counts; record both receipts and the Task 6 Step 10 EXPLAIN receipt in the implementation PR body.

- [ ] **Step 4: Machine-readable mutation evidence** (spec §12; all twenty rows are mandatory)

Create `scripts/test-cath-readiness-mutations.mjs`. It takes one assertion id from the table at the top of this plan, verifies the target file is clean, hashes it, runs the anchored unmodified Jest command with `--json --outputFile`, applies that row's single source mutation, reruns the identical command, restores the exact bytes in `finally`, verifies the hash, and reruns the identical command. It writes `cath-readiness-mutation/v1` JSON and exits non-zero unless the phases are exactly pass-one / intended-fail-one / pass-one with zero compile, suite or hook failures.

The required ids are: `r4-1-command-replay`, `r4-2-attribution`, `r4-6-manifest`, `r5-2-lifecycle`, `r4-3-candidate`, `r4-4-age`, `r4-5-timeout`, `r5-6-consent`, `r5-7-log`, `r5-8-rls`, `r5-9-realtime`, `r5-10-clock`, `r5-11-executable`, `r6-1-draft-independent`, `r6-2-started-reset`, `r6-2-prestart-retain`, `r6-3-two-clocks`, `r6-4-report-scope`, `r6-5-consent-shape`, and `r6-6-authority-only`. Run each separately; a broader suite never substitutes for its receipt. The mutation implementation is the exact one in the top table. Store receipts outside the repo and attach their SHA-256 list to the implementation PR.

In addition, keep the broader mutation regression set from revisions 1–4, updated to the revision-6 contracts: lifecycle tokens on all four commands; `start_command_id`; Start/human generation bumps; one accepted-evidence shape; performed outcome; bound report clock; fail-closed RLS; Staff request epochs; both attempt clocks; conditional emergency shape and governed prior-evidence reuse; direct `in_progress => actual_end_at IS NULL`; exact 9 UPDATE + 2 INSERT writer population. The source-writer guard is expressly a regression check: feed it synthetic unsupported parameterized-SQL and ORM-upsert shapes and require a named failure, but do not claim it proves absence of every future writer form.

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

- [ ] **Step 8: Drop the scratch DBs** — run `dropdb "$CATH_READINESS_SCRATCH_DATABASE_URL"`, `dropdb "$CATH_READINESS_SCRATCH_DATABASE_URL_1"`, and `dropdb "$CATH_READINESS_SCRATCH_DATABASE_URL_2"` after each variable has been checked to name only its dedicated cath-readiness scratch database.

---

## Self-review against the spec (revision 6)

- **Owner 1:** status normalization and cancelled refusal precede Start dispatch; Start dispatch precedes ordinary transition validation; command replay precedes eligibility; lifecycle token fences Start/consent/time-out/log; log idempotency is separate; cancel/reopen rotate the token; delayed-first-delivery tests exist.
- **Owner 2:** evidence resolution holds no case lock; publication is generation-checked and brief; cached GET/Staff loading does not await refresh; the proof uses two real database connections.
- **Owner 3:** attempt evidence is server-owned and keyed by tenant/case/attempt; procedure logs store attempt/token; report joins the event attempt; the deep path covers attempt 1 → cancel/reopen → attempt 2 → amendment.
- **Owner 4:** absence maps to `not_documented`; known performance with unknown chronology maps to `performed_timing_unknown`; explicit attestation alone yields `not_performed`; nullable clinical occurrence is distinct from server recording; one database instant feeds projection, snapshot, command, and canonical event while audit bookkeeping may use transaction-start `NOW()`.
- **Owner 5:** age-only carry requires both fingerprints to match retained accepted evidence; same-id correction, withdrawal, backwards change, bounded-lookback absence and bootstrap have named tests.
- **Owner 6:** consent evidence is conditional on authority; emergency basis has no mode; provenance, policy, actor, recording and legacy markers are server-owned; clinical/legal policy approval gates release.
- **Owner 7:** Task 0 inventories inconsistent rows and all writers; Task 1 expands, classifies/backfills and enforces only after old-writer quiescence; CHECK tests explicitly prove consent is not a database constraint.
- **Further corrections:** mutation 15 directly asserts the final end-field invariant; report audit is explicit-tenant/fail-closed; realtime tests span commit through render, reconnect, maximum wait and stale response; EXPLAIN uses cardinality/buffer bounds rather than a fixed node; writer pins assert the known current population and catch a synthetic addition; privacy surveys all current readers and nested/exported projections.
- **Revision-4 decisive evidence:** the six exact acceptance tests are independently selectable, each has a concrete fixture/trace/outcome and a single focused mutation that makes only that selected test red; the spec names the same test beside its mechanism.
- **Revision-6 decisions:** draft/amended logs cannot Start, explicit emergency Start remains independent, started and pre-start reopen paths have distinct reset semantics, both clocks live on case and attempt rows, `CATH_LAB_INCHARGE` access is tenant-wide with facility filtering, emergency basis has no mode, and transactional behaviour—not CHECKs or source enumeration—proves the authority block.
- **Baseline:** every code claim is rechecked by function name against fetched `github/main` `e9bd6675dfb21ef5a1ef1540b24a406e31d28202`.
- **Type consistency:** `startCaseTx` takes command plus expected lifecycle token and both clinical/provenance inputs; `buildStartSnapshot` has exactly 15 ordered keys; operational rules use `attempt_start_recorded_at`; report and Staff use the same lifecycle/attempt/outcome vocabulary.
