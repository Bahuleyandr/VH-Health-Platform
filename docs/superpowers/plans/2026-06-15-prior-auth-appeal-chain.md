# Prior-Auth → Appeal Automation Chain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a prior-auth is denied, auto-draft a payer appeal from the PA's own evidence into the review queue as one resumable workflow run; a human approves & submits via existing endpoints (no auto-submit).

**Architecture:** A new `workflowGraphRunner` graph (`prior_auth_appeal_chain`) started off the request path (starter sweep + manual endpoint), with two human-gated pauses resumed by the existing `workflowResumeScheduler`. An appeal can reference a prior-auth OR a billing claim (dual-nullable-FK + CHECK). Disabled by default, control-plane only.

**Tech Stack:** Node.js (ESM), Express, Postgres (raw SQL via Prisma `$queryRawUnsafe`), Jest (`--experimental-vm-modules`), the in-repo `workflowGraphRunner`/`workflowCheckpointStore`/`workflowResumeScheduler`.

**Spec:** `docs/superpowers/specs/2026-06-15-prior-auth-appeal-chain-design.md`

**Conventions for every task:**
- Run DB-free unit tests with: `npm run test:suite -- <pattern>` (run from `apps/backend`; no DB setup hook).
- Mirror these templates: graph = `dischargeComposeService.js`; runner tests = `workflowGraphRunner.test.js`; scheduler tests = `workflowResumeScheduler.test.js`; routes = `routes/admin/clinicalAi/dischargeComposeRoutes.js` + `dischargeComposeRoutes.test.js`.
- Raw SQL: bare params inside `jsonb_build_object`/`jsonb_build_array` MUST carry `::type` casts (run `npm run lint:raw-params`).
- Commit after each task. `git add` only the task's specific files (two unrelated untracked files exist in the tree — never `git add -A`).

---

## File Structure

**Create:**
- `apps/backend/src/migrations/313_appeal_from_prior_auth.sql` — schema link (prior_auth_id, relax claim_id, CHECK, partial-unique).
- `apps/backend/src/services/ai/priorAuthAppealChainService.js` — the graph, nodes, `composePriorAuthAppeal`, gate predicates, scheduler registration, `__testing__`.
- `apps/backend/src/routes/admin/clinicalAi/priorAuthAppealRoutes.js` — start/resume/fail/get endpoints.
- Tests: `apps/backend/src/tests/unit/priorAuthAppealChainService.test.js`, `priorAuthAppealChainGates.test.js`, `priorAuthAppealRoutes.test.js`, and `apps/backend/src/tests/integration/priorAuthAppealChain.integration.test.js`.

**Modify:**
- `apps/backend/src/services/ai/appealLetterGeneratorService.js` — `loadClaim` → `loadAppealSubject`; `generateAppealLetter` accepts `priorAuthId`.
- `apps/backend/src/services/ai/priorAuthorizationService.js` — `recordPayerDecision` emits `prior_auth_denied`; add `module.enabled` gate to `generatePriorAuthorization`.
- `apps/backend/src/utils/scheduler.js` — register the starter sweep cron.
- `apps/backend/src/routes/admin/clinicalAi/clinicalAiRoutes.js` (or the relevant index) — mount the new routes.

---

## Task 1: Migration — link appeals to prior-auths

**Files:**
- Create: `apps/backend/src/migrations/313_appeal_from_prior_auth.sql`

- [ ] **Step 1: Read the template + target.** Read an existing recent migration (e.g. `apps/backend/src/migrations/311_knowledge_curation.sql`) for the house style (idempotent guards, comments) and `040_appeal_letter_generator.sql` for the current `clinical_ai_appeal_letters` definition (esp. the `claim_id INT NOT NULL REFERENCES insurance_claims(id)` line and any RLS at the bottom).

- [ ] **Step 2: Write the migration.**

```sql
-- 313_appeal_from_prior_auth.sql
-- Allow an appeal to originate from a denied prior-auth (clinical_ai_prior_auth_requests)
-- in addition to a denied billing claim (insurance_claims). Exactly one source per appeal.

BEGIN;

ALTER TABLE clinical_ai_appeal_letters
  ADD COLUMN IF NOT EXISTS prior_auth_id INTEGER
    REFERENCES clinical_ai_prior_auth_requests(id) ON DELETE CASCADE;

-- Relax the legacy NOT NULL so PA-sourced appeals (no claim) can persist.
ALTER TABLE clinical_ai_appeal_letters
  ALTER COLUMN claim_id DROP NOT NULL;

-- Exactly one source must be set (mirrors the insurance_claim_caps dual-FK+CHECK pattern).
ALTER TABLE clinical_ai_appeal_letters
  DROP CONSTRAINT IF EXISTS chk_appeal_single_source;
ALTER TABLE clinical_ai_appeal_letters
  ADD CONSTRAINT chk_appeal_single_source CHECK (
    (claim_id IS NOT NULL AND prior_auth_id IS NULL)
    OR (claim_id IS NULL AND prior_auth_id IS NOT NULL)
  );

-- One appeal per prior-auth (idempotency anchor for the chain).
CREATE UNIQUE INDEX IF NOT EXISTS uq_appeal_prior_auth
  ON clinical_ai_appeal_letters (prior_auth_id)
  WHERE prior_auth_id IS NOT NULL;

COMMIT;
```

- [ ] **Step 3: Apply against the test DB and verify the constraint.**

Run (from `apps/backend`): `npm run test:db:setup` then apply the migration the same way the repo applies migrations in tests (check `scripts/ensure-test-db.mjs` for the runner; it applies `src/migrations/*.sql` in order). Then a psql/`$queryRawUnsafe` smoke: inserting an appeal row with BOTH `claim_id` and `prior_auth_id` set must raise `chk_appeal_single_source`; with NEITHER set must also fail; with only `prior_auth_id` must succeed. (This is exercised by the integration test in Task 8 — if the test DB is not available now, defer execution to Task 8 and just verify the SQL parses.)

Expected: constraint rejects 0-source and 2-source rows; accepts 1-source rows.

- [ ] **Step 4: Regenerate schema artifacts.** Per `docs`/the schema-drift procedure, regenerate `000_baseline.sql` + `prisma/schema.prisma` if the repo requires it for raw migrations (see the schema-drift runbook). If the repo's `db:generate` only reads `schema.prisma`, add `prior_auth_id Int?` + nullable `claim_id` to the `clinical_ai_appeal_letters` model.

- [ ] **Step 5: Commit.**

```bash
git add apps/backend/src/migrations/313_appeal_from_prior_auth.sql
# + regenerated schema files if changed
git commit -m "feat(appeal): migration linking appeals to denied prior-auths (313)"
```

---

## Task 2: Bridge — `loadAppealSubject` (hydrate from PA or claim)

**Files:**
- Modify: `apps/backend/src/services/ai/appealLetterGeneratorService.js`
- Test: `apps/backend/src/tests/unit/appealLetterGeneratorService.test.js` (extend existing)

- [ ] **Step 1: Read the current contract.** Read `appealLetterGeneratorService.js` `loadClaim` (~`:414`) and capture the EXACT object shape it returns (the keys `buildAppealLetterSections` consumes: insurance_provider, policy_number, claim_number, rejection_reason, denial_code, patient name fields, etc.). `loadAppealSubject` must return the identical shape so `buildAppealLetterSections` (`:326`) is unchanged.

- [ ] **Step 2: Write the failing test** (`appealLetterGeneratorService.test.js`). Use the exported pure mapper (export a new pure `mapPriorAuthToAppealSubject(priorAuthRow)` from the service so it is unit-testable without a DB):

```javascript
import { __testing__ } from '../../services/ai/appealLetterGeneratorService.js';
const { mapPriorAuthToAppealSubject } = __testing__;

test('maps a denied prior-auth row into the claim-shaped appeal subject', () => {
  const pa = {
    id: 42, tenant_id: 't1', patient_uid: 'p1', admission_id: 7,
    payer_name: 'Acme Health', policy_number: 'POL-9', procedure_code: '0SR90JZ',
    procedure_description: 'Hip replacement', payer_reference_id: 'PA-REF-1',
    payer_decision_reason: 'Prior authorization not on file',
    medical_necessity: 'Severe OA, failed conservative care',
    clinical_evidence: { diagnoses: ['M16.11'], procedures: ['0SR90JZ'] },
    citations: [{ source: 'note', ref: 'n1' }],
  };
  const s = mapPriorAuthToAppealSubject(pa);
  expect(s.source_type).toBe('prior_auth');
  expect(s.prior_auth_id).toBe(42);
  expect(s.claim_id).toBeNull();
  expect(s.insurance_provider).toBe('Acme Health');
  expect(s.policy_number).toBe('POL-9');
  expect(s.rejection_reason).toBe('Prior authorization not on file');
  expect(s.claim_number).toBe('PA-REF-1');           // falls back to `PA-42` when no ref
  expect(s.patient_uid).toBe('p1');
});
```

- [ ] **Step 3: Run it to confirm it fails.** Run: `npm run test:suite -- appealLetterGeneratorService.test` — Expected: FAIL (`mapPriorAuthToAppealSubject` undefined).

- [ ] **Step 4: Implement.** Add `mapPriorAuthToAppealSubject(pa)` returning the loadClaim-shaped object (with `source_type:'prior_auth'`, `prior_auth_id: pa.id`, `claim_id: null`, `claim_number: pa.payer_reference_id || \`PA-${pa.id}\``, `rejection_reason: pa.payer_decision_reason`, evidence/citations passed through). Refactor `loadClaim` → `loadAppealSubject({ tenantId, claimId, priorAuthId })`: when `priorAuthId` set, `SELECT ... FROM clinical_ai_prior_auth_requests WHERE id=$1 AND tenant_id=$2` (guard `status='denied'`), then `mapPriorAuthToAppealSubject`; else the existing claim path (tagged `source_type:'claim'`). Add `mapPriorAuthToAppealSubject` to `__testing__`. Update `generateAppealLetter({ ..., claimId, priorAuthId })` to require exactly one and pass through; persist `prior_auth_id` (and null `claim_id`) into the `clinical_ai_appeal_letters` INSERT when PA-sourced.

- [ ] **Step 5: Run tests to confirm pass.** Run: `npm run test:suite -- appealLetterGeneratorService.test` — Expected: PASS (existing claim tests still green + new PA test).

- [ ] **Step 6: Commit.**

```bash
git add apps/backend/src/services/ai/appealLetterGeneratorService.js apps/backend/src/tests/unit/appealLetterGeneratorService.test.js
git commit -m "feat(appeal): loadAppealSubject hydrates from prior-auth or claim"
```

---

## Task 3: The workflow graph service (nodes + compose entry)

**Files:**
- Create: `apps/backend/src/services/ai/priorAuthAppealChainService.js`
- Test: `apps/backend/src/tests/unit/priorAuthAppealChainService.test.js`

- [ ] **Step 1: Read the template.** Read `dischargeComposeService.js` fully — especially `COMPOSE_GRAPH_NODES` (`:100-288`), the pause node `await_governance_approval` (`:246`), `getComposeGraph()` (`:333`), `composeDischargePackage()` (`:368`), and the `__testing__` export (`:455`). Read `workflowGraphRunner.js` exports `WorkflowGraph`, `runWorkflow`, `pauseRun`, `haltRun`, and `workflowCheckpointStore.js` `getDefaultCheckpointStore`.

- [ ] **Step 2: Write the failing test** — graph traversal + pause, DB-free via the `__testing__` partial graph and a memory store (mirror `dischargeComposeService.test.js:72`).

```javascript
import { __testing__ } from '../../services/ai/priorAuthAppealChainService.js';
import { WorkflowGraph, runWorkflow } from '../../services/ai/workflowGraphRunner.js';
import { createMemoryCheckpointStore } from '../../services/ai/workflowCheckpointStore.js';

const { NODES, WORKFLOW_KEY } = __testing__;

test('runs draft then pauses awaiting human disposition', async () => {
  // Build a graph from the real nodes but stub the AI/persistence nodes via ctx.
  const graph = new WorkflowGraph({
    key: WORKFLOW_KEY,
    nodes: {
      load_denied_prior_auth: async () => ({ priorAuth: { id: 42, status: 'denied' }, module: { enabled: true } }),
      classify_denial: NODES.classify_denial,
      draft_appeal: async () => ({ appeal: { id: 7 }, appealId: 7 }),
      await_human_disposition: NODES.await_human_disposition,
    },
    start: 'load_denied_prior_auth',
  });
  const store = createMemoryCheckpointStore();
  const out = await runWorkflow({ graph, initialState: { priorAuthId: 42, denialReason: 'no prior auth on file' }, store, tenantId: 't1' });
  expect(out.status).toBe('paused');
  expect(out.pauseReason).toBe('await_appeal_human_disposition');
  expect(out.state.pendingDisposition.appeal_id).toBe(7);
});
```

- [ ] **Step 3: Run to confirm fail.** `npm run test:suite -- priorAuthAppealChainService.test` — Expected: FAIL (module not found).

- [ ] **Step 4: Implement the service.** Create `priorAuthAppealChainService.js` with `WORKFLOW_KEY='prior_auth_appeal_chain'` and `NODES`:
  - `load_denied_prior_auth(state, ctx)` — load PA (`SELECT ... clinical_ai_prior_auth_requests WHERE id AND tenant_id`); `throw AppError.badRequest` if not `denied`; `getClinicalAiModule('appeal_letter_generator', { tenantId })`, `throw AppError.forbidden` if `!enabled`; return `{ priorAuth, module, denialReason: priorAuth.payer_decision_reason }`.
  - `classify_denial(state)` — `return { classification: classifyDenialReason({ denialReason: state.denialReason }) }` (import from appeal service).
  - `draft_appeal(state, ctx)` — call `generateAppealLetter({ req: ctx.req, priorAuthId: state.priorAuth.id })` (reuse Task 2 path; it does LLM + safeJsonParse(fallback) + defenses + persists appeal/generation/review). Return `{ appeal, appealId: appeal.appeal_id }`.
  - `await_human_disposition(state)` — `return pauseRun('await_appeal_human_disposition', { pendingDisposition: { appeal_id: state.appealId } })`.
  - `await_payer_response(state)` — `return pauseRun('await_appeal_payer_response', { pendingPayerResponse: { appeal_id: state.appealId } })`.
  - `finalize_outcome(state, ctx)` — read final appeal status; `await publishEvent({ eventType: 'clinical_ai.prior_auth_appeal_resolved', aggregateType: 'prior_auth', aggregateId: String(state.priorAuth.id), payload: { appeal_id: state.appealId, outcome } })`; `return { result: { prior_auth_id: state.priorAuth.id, appeal_id: state.appealId, outcome } }`.
  Declare nodes in order (linear, no `edges`). Add `getPriorAuthAppealGraph()` (process singleton). Add `composePriorAuthAppeal(priorAuthId, { startedBy, req })` calling `runWorkflow({ graph: getPriorAuthAppealGraph(), initialState: { priorAuthId }, ctx: { req }, store: getDefaultCheckpointStore(), tenantId, startedBy, workflowMetadata: { prior_auth_id: priorAuthId } })`, mapping `failed`→`AppError.internal`, returning `{ status, run_id, pause_reason }` / `result`. Export `__testing__ = { NODES, WORKFLOW_KEY }`.

- [ ] **Step 5: Run to confirm pass.** `npm run test:suite -- priorAuthAppealChainService.test` — Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/backend/src/services/ai/priorAuthAppealChainService.js apps/backend/src/tests/unit/priorAuthAppealChainService.test.js
git commit -m "feat(appeal): prior_auth_appeal_chain workflow graph + compose entry"
```

---

## Task 4: Resume gates + scheduler registration

**Files:**
- Modify: `apps/backend/src/services/ai/priorAuthAppealChainService.js`
- Test: `apps/backend/src/tests/unit/priorAuthAppealChainGates.test.js`

- [ ] **Step 1: Read** `workflowResumeScheduler.js` `registerWorkflowGraph`/`registerPauseReasonHandler` (`:206`) and `isGovernanceApproved` (`:63`) as the gate template.

- [ ] **Step 2: Write the failing test** for the gate predicates (mock `prisma.$queryRawUnsafe`):

```javascript
import { jest } from '@jest/globals';
// mock prisma BEFORE importing the service (see workflowResumeScheduler.test.js:26 for the unstable_mockModule pattern)
test('gateSubmitted resumes only when appeal_status=submitted', async () => {
  const { __testing__ } = await import('../../services/ai/priorAuthAppealChainService.js');
  const run = { tenant_id: 't1', state: { pendingDisposition: { appeal_id: 7 } } };
  // appeal_status='submitted' → true ; 'draft' → false (drive via the mocked query result)
  expect(await __testing__.gateSubmitted(run, { /* mocked appeal lookup → submitted */ })).toBe(true);
});
```

- [ ] **Step 3: Run to confirm fail.** `npm run test:suite -- priorAuthAppealChainGates.test` — Expected: FAIL.

- [ ] **Step 4: Implement resume-aware pause nodes + gates + registration.**

  **CRITICAL (resume semantics):** the runner re-runs the paused node on resume (`nextNodeAfter(last-completed)` = the pause node, since pause does not advance `current_node`). An unconditional `pauseRun` therefore loops forever. Make both pause nodes resume-aware via shared predicates `isAppealSubmitted`/`isAppealResolved` (query `clinical_ai_appeal_letters.appeal_status`; return `false` on error/no-row): `await_human_disposition` → `if (await isAppealSubmitted({ appealId: state.appealId, tenantId: state.tenantId })) return {}; return pauseRun(...)`; `await_payer_response` → same with `isAppealResolved` (status ∈ approved/denied/withdrawn). The gates reuse the SAME predicates. The first-run unit test still pauses (no row → false). Then add:
  - `gateSubmitted(run)` — read `run.state?.pendingDisposition?.appeal_id` (fallback `run.metadata`); `SELECT appeal_status FROM clinical_ai_appeal_letters WHERE id=$1 AND tenant_id=$2`; return `row?.appeal_status === 'submitted'`.
  - `gateResolved(run)` — same lookup on `pendingPayerResponse.appeal_id`; return `['approved','denied','withdrawn'].includes(row?.appeal_status)`.
  At module load: `registerWorkflowGraph(WORKFLOW_KEY, getPriorAuthAppealGraph); registerPauseReasonHandler('await_appeal_human_disposition', gateSubmitted); registerPauseReasonHandler('await_appeal_payer_response', gateResolved);`. Add `gateSubmitted`/`gateResolved` to `__testing__`. (Gates must never throw to the scheduler — wrap lookups; on error return false.)

- [ ] **Step 5: Run to confirm pass.** `npm run test:suite -- priorAuthAppealChainGates.test` — Expected: PASS.

- [ ] **Step 6: Verify scheduler routing.** Add a test mirroring `workflowResumeScheduler.test.js` asserting a paused `prior_auth_appeal_chain` run with reason `await_appeal_human_disposition` is routed to our handler (not `skipped_unknown_workflow`/`skipped_unknown_reason`). Run: `npm run test:suite -- workflowResumeScheduler.test priorAuthAppealChainGates.test` — Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add apps/backend/src/services/ai/priorAuthAppealChainService.js apps/backend/src/tests/unit/priorAuthAppealChainGates.test.js
git commit -m "feat(appeal): resume gates + scheduler registration for the chain"
```

---

## Task 5: Trigger — denial event + PA enabled-gate consistency fix

**Files:**
- Modify: `apps/backend/src/services/ai/priorAuthorizationService.js`
- Test: `apps/backend/src/tests/unit/priorAuthorizationService.test.js` (create)

- [ ] **Step 1: Read** `priorAuthorizationService.js` `recordPayerDecision` (`:283-304`) and `generatePriorAuthorization` (`:86`, note it fetches the module but does NOT gate on `.enabled`).

- [ ] **Step 2: Write failing tests.** (a) `recordPayerDecision({decision:'denied'})` calls `publishEvent` with `eventType:'clinical_ai.prior_auth_denied'` (mock the outbox); (b) `generatePriorAuthorization` throws `forbidden` when the module is disabled (mock `getClinicalAiModule` → `{enabled:false}`).

- [ ] **Step 3: Run to confirm fail.** `npm run test:suite -- priorAuthorizationService.test` — Expected: FAIL.

- [ ] **Step 4: Implement.** In `recordPayerDecision`, after the UPDATE commits and `normalized==='denied'`, best-effort `await publishEvent({ eventType:'clinical_ai.prior_auth_denied', aggregateType:'prior_auth', aggregateId:String(priorAuthId), patientUid: row.patient_uid, payload:{ tenant_id, payer_decision_reason: reason } })` wrapped in try/catch (never block the decision). In `generatePriorAuthorization`, after `getClinicalAiModule(MODULE_KEY,...)`, add `if (!module.enabled) throw AppError.forbidden('prior_authorization_generator module is disabled')` (match the appeal service's gate at `appealLetterGeneratorService.js:525`).

- [ ] **Step 5: Run to confirm pass.** `npm run test:suite -- priorAuthorizationService.test` — Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/backend/src/services/ai/priorAuthorizationService.js apps/backend/src/tests/unit/priorAuthorizationService.test.js
git commit -m "feat(prior-auth): emit prior_auth_denied event + enforce module-enabled gate"
```

---

## Task 6: Starter sweep (auto-start runs for denied PAs)

**Files:**
- Modify: `apps/backend/src/services/ai/priorAuthAppealChainService.js` (add `startPendingPriorAuthAppeals`)
- Modify: `apps/backend/src/utils/scheduler.js` (register cron)
- Test: `apps/backend/src/tests/unit/priorAuthAppealChainService.test.js` (extend)

- [ ] **Step 1: Read** `utils/scheduler.js` around `:306` (the `withJobLock` + `cron.schedule` pattern used for `clinical-ai-workflow-resume`).

- [ ] **Step 2: Write the failing test.** `startPendingPriorAuthAppeals` selects denied PAs with the appeal module enabled and no existing run/appeal, and calls `composePriorAuthAppeal` once per PA; a PA that already has an appeal (unique `prior_auth_id`) is skipped. Mock the PA query + `composePriorAuthAppeal`.

- [ ] **Step 3: Run to confirm fail.** `npm run test:suite -- priorAuthAppealChainService.test` — Expected: FAIL.

- [ ] **Step 4: Implement.** `startPendingPriorAuthAppeals({ maxStarts = 25 } = {})`: `SELECT pa.id, pa.tenant_id FROM clinical_ai_prior_auth_requests pa WHERE pa.status='denied' AND NOT EXISTS (SELECT 1 FROM clinical_ai_appeal_letters a WHERE a.prior_auth_id = pa.id) AND NOT EXISTS (SELECT 1 FROM clinical_ai_workflow_runs r WHERE r.workflow_key='prior_auth_appeal_chain' AND r.metadata @> jsonb_build_object('prior_auth_id', pa.id)) ORDER BY pa.payer_decided_at ASC LIMIT $1::int` (note the `::int` cast on the jsonb param per lint:raw-params), then for each, check module enabled for that tenant and `await composePriorAuthAppeal(pa.id, { startedBy: null })` inside try/catch (log + continue). Return a summary `{ started, skipped, failed }`. In `scheduler.js`, add `cron.schedule('*/60 * * * * *', withJobLock('clinical-ai-prior-auth-appeal-start', () => startPendingPriorAuthAppeals({ maxStarts: 25 })))`.

- [ ] **Step 5: Run to confirm pass.** `npm run test:suite -- priorAuthAppealChainService.test` — Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/backend/src/services/ai/priorAuthAppealChainService.js apps/backend/src/utils/scheduler.js apps/backend/src/tests/unit/priorAuthAppealChainService.test.js
git commit -m "feat(appeal): starter sweep auto-launches the chain for denied prior-auths"
```

---

## Task 7: Routes (manual start / resume / fail / get)

**Files:**
- Create: `apps/backend/src/routes/admin/clinicalAi/priorAuthAppealRoutes.js`
- Modify: the clinical-AI route index that mounts sub-routers (mirror how `dischargeComposeRoutes` is mounted).
- Test: `apps/backend/src/tests/unit/priorAuthAppealRoutes.test.js`

- [ ] **Step 1: Read** `routes/admin/clinicalAi/dischargeComposeRoutes.js` (start 201/202 at `:45`, resume `:159`, fail `:207`, get `:118`) and how it's wrapped with `logClinicalAiAudit` + mounted.

- [ ] **Step 2: Write the failing route test** (supertest mirror of `dischargeComposeRoutes.test.js`): `POST /prior-auth/:id/appeal` → 202 with `{ run_id, pause_reason }` when the run pauses (mock `composePriorAuthAppeal`); role gate rejects non-control roles.

- [ ] **Step 3: Run to confirm fail.** `npm run test:suite -- priorAuthAppealRoutes.test` — Expected: FAIL.

- [ ] **Step 4: Implement routes.** `POST /prior-auth/:id/appeal` → `composePriorAuthAppeal(id, { startedBy: req.user.uid, req })`, 201 if `result`, 202 if `paused`. `POST /prior-auth-appeal/:runId/resume` → `resumeWorkflow({ runId, store: getDefaultCheckpointStore(), graph: getPriorAuthAppealGraph() })` with tenant + `workflow_key==='prior_auth_appeal_chain'` guards. `POST /prior-auth-appeal/:runId/fail` → `store.markFailed` only if `status==='paused'`. `GET /prior-auth-appeal/:runId` → run + `store.listChildren`. Wrap each in `logClinicalAiAudit`. Mount under the control plane next to discharge-compose.

- [ ] **Step 5: Run to confirm pass.** `npm run test:suite -- priorAuthAppealRoutes.test` — Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/backend/src/routes/admin/clinicalAi/priorAuthAppealRoutes.js apps/backend/src/routes/admin/clinicalAi/clinicalAiRoutes.js apps/backend/src/tests/unit/priorAuthAppealRoutes.test.js
git commit -m "feat(appeal): control-plane routes for the prior-auth appeal chain"
```

---

## Task 8: Integration test (real PG) — full flow + constraints

**Files:**
- Create: `apps/backend/src/tests/integration/priorAuthAppealChain.integration.test.js`

- [ ] **Step 1:** Ensure the test DB is up (`npm run test:db:setup`; if it needs Docker PG see the WSL-postgres notes). Migration 313 must be applied.

- [ ] **Step 2: Write the integration test** (uses real prisma, seeds a tenant + a denied PA):
  - Constraint: inserting an appeal with both `claim_id` and `prior_auth_id` → rejected (`chk_appeal_single_source`); neither → rejected; only `prior_auth_id` → ok.
  - Flow: enable the `appeal_letter_generator` module for the tenant → `composePriorAuthAppeal(priorAuthId)` → run is `paused` at `await_appeal_human_disposition`; an appeal row exists with `prior_auth_id` set, `claim_id` NULL, in the review queue; `used_ai=false` (template provider).
  - Idempotency: a second `composePriorAuthAppeal` / starter sweep does NOT create a second appeal (unique index).
  - Resume: set the appeal `appeal_status='submitted'` → `gateSubmitted(run)` true → `resumeWorkflow` advances to `await_appeal_payer_response`.

- [ ] **Step 3: Run.** `npm test -- priorAuthAppealChain.integration` — Expected: PASS (runs the `pretest` DB setup).

- [ ] **Step 4: Commit.**

```bash
git add apps/backend/src/tests/integration/priorAuthAppealChain.integration.test.js
git commit -m "test(appeal): real-PG integration for the prior-auth appeal chain"
```

---

## Task 9: Gates + local-Ollama smoke

- [ ] **Step 1: Full lint.** Run (from `apps/backend`): `npm run lint` (includes `lint:raw-params`, `check:phi-tenant-id`, `check:clinical-ai-external-regions`, `secrets:scan`). Fix any findings. Expected: clean.
- [ ] **Step 2: Chunked test suite.** Run: `npm run test:ci`. Expected: green (or document any pre-existing unrelated failures vs main).
- [ ] **Step 3: Security.** Run local gitleaks + local `semgrep --error --severity ERROR` per the repo's local-CI procedure. Expected: clean.
- [ ] **Step 4: Local-Ollama smoke (manual).** Temporarily set `apps/backend/.env` `CLINICAL_AI_PROVIDER=ollama`, `CLINICAL_AI_BASE_URL=http://localhost:11434`, `CLINICAL_AI_MODEL=llama3.1:8b` (pull it first: `ollama pull llama3.1:8b nomic-embed-text`); enable `appeal_letter_generator` for a test tenant; `POST /prior-auth/:id/appeal` against a denied PA; confirm the persisted appeal has `used_ai=true` and a model-generated necessity narrative. **Revert `.env` to `template` before any commit.**
- [ ] **Step 5: Final commit (only if files changed by lint:fix).**

```bash
git add -p   # stage only intended changes; never the two unrelated untracked files
git commit -m "chore(appeal): lint + gate fixes for the prior-auth appeal chain"
```

---

## Done criteria
- All unit + route + integration tests green; `npm run test:ci` green.
- `npm run lint` clean (incl. raw-params/PHI/regions/secrets).
- Committed config still `CLINICAL_AI_PROVIDER=template`; both modules still `enabled:false` by default.
- Local-Ollama smoke produced a real `used_ai=true` appeal from a denied PA.
- Then: `superpowers:finishing-a-development-branch` (merge `feat/prior-auth-appeal-chain` → main per the repo's local-CI-gated workflow).
