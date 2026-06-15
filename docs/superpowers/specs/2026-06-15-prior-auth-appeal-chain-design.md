# Prior-Auth → Appeal Automation Chain — Design

- **Date:** 2026-06-15
- **Status:** Approved (design); implementation pending
- **Branch:** `feat/prior-auth-appeal-chain` (off `main`)
- **Module(s):** `prior_authorization_generator`, `appeal_letter_generator` (both default OFF)
- **Surface:** Clinical-AI control plane (admin/IT roles + IP allowlist). **Not patient-facing.**

## 1. Context & problem

The backend already has two unconnected AI services:

- `priorAuthorizationService.js` — drafts a prior-auth (PA) packet (LLM), submits via a payer adapter, and `recordPayerDecision(decision)` records the payer outcome. `decision='denied'` sets `clinical_ai_prior_auth_requests.status='denied'` (the **denial signal**) but fires nothing downstream (`recordPayerDecision` early-returns at `priorAuthorizationService.js:304`).
- `appealLetterGeneratorService.js` — drafts a payer appeal, but **only from a denied `insurance_claims` row** (`claim_id NOT NULL` FK + `loadClaim`). It has no concept of a prior-auth.

They were built as separate batches and never wired together. A denied PA is a different table (`clinical_ai_prior_auth_requests`) with no `insurance_claims.id`, so today you **cannot** generate an appeal from a denied prior-auth. The evidence (`clinical_evidence`, `citations`, `medical_necessity`, `payer_decision_reason`) and the denial trigger already exist; the bridge and the persistence link do not.

## 2. Goals / non-goals

**Goals (v1):**
- When a PA is denied, **auto-draft** an appeal from the PA's own stored evidence and land it in the existing `clinical_ai_reviews` queue.
- A human reviews/edits/approves and **submits** via the existing `/appeal-letters` endpoints. **No auto-submit.**
- Model the lifecycle as one resumable workflow run (denial → draft → ⏸ review/submit → ⏸ payer response → finalize) on the existing `workflowGraphRunner`.
- Stays **disabled by default**; committed LLM provider stays `template`.

**Non-goals (v1):**
- Multi-level escalation (first → second → external review) — clean future extension at `finalize_outcome`.
- A payer adapter for appeal submission (appeals keep the existing manual submit).
- Any patient-facing surface.
- Replacing the PA generate/submit endpoints (they stay; the chain starts at denial).

## 3. Locked decisions

1. **Automation:** auto-draft on denial → review queue → human approves & submits (no auto-submit).
2. **Coupling:** prior-auth stays its own track. An appeal references a PA **or** a claim (not both).
3. **Orchestration:** full workflow-graph (`workflowGraphRunner`) — reuses the platform's battle-tested resumable/checkpointed pattern (the one discharge-compose runs on); the human-review gate maps onto the runner's pause/resume.

## 4. Architecture & lifecycle

One resumable run, `workflow_key = 'prior_auth_appeal_chain'`, started **off the request path**, with two human-gated pauses. The workflow **never** submits or contacts the payer — it pauses and waits for the human's existing-endpoint actions.

```
TRIGGER (no LLM in request path):
  recordPayerDecision(denied) → commit denial + publish `prior_auth_denied` event   (fast, fire-and-forget)
        ├─ starter sweep (cron) finds denied PAs: appeal module enabled + no run/appeal yet ─┐
        └─ OR manual POST /prior-auth/:id/appeal  (admin/IT, immediate — also local-Ollama test hook)┤
                                                                                                ▼
RUN: prior_auth_appeal_chain                                          (clinical_ai_workflow_runs)
  1. load_denied_prior_auth   guard status='denied' + appeal module enabled; load PA evidence/citations
  2. classify_denial          classifyDenialReason(payer_decision_reason)                      [rules]
  3. draft_appeal             generateClinicalText + safeJsonParse(text, fallbackDraft) + defenses
                              → persist clinical_ai_appeal_letters (prior_auth_id set, claim_id NULL),
                                clinical_ai_generations, clinical_ai_reviews (queue entry)
 ⏸4. await_human_disposition  pauseRun('await_appeal_human_disposition', {appeal_id});
                              gate = appeal_status='submitted'  (human approves+submits via existing endpoints)
 ⏸5. await_payer_response     pauseRun('await_appeal_payer_response', {appeal_id});
                              gate = appeal_status ∈ (approved|denied|withdrawn)  (human records via existing endpoint)
  6. finalize_outcome         emit `prior_auth_appeal_resolved`; if denied → flag next-level-eligible (no auto-loop v1)
     build_response           terminal
```

Both pauses are resumed by the **existing** 30s `workflowResumeScheduler` once we register the graph + two pause-reason handlers (`utils/scheduler.js:306` cron).

## 5. Data model

**One migration** `312_appeal_from_prior_auth.sql` on `clinical_ai_appeal_letters` (defined in `040_appeal_letter_generator.sql`):
- `ADD COLUMN prior_auth_id INTEGER REFERENCES clinical_ai_prior_auth_requests(id)` (nullable).
- `ALTER COLUMN claim_id DROP NOT NULL`.
- `CHECK` exactly one source: `(claim_id IS NOT NULL AND prior_auth_id IS NULL) OR (claim_id IS NULL AND prior_auth_id IS NOT NULL)` (mirrors the `insurance_claim_caps` dual-nullable-FK+CHECK pattern).
- Partial **unique** index: `CREATE UNIQUE INDEX ... ON clinical_ai_appeal_letters (prior_auth_id) WHERE prior_auth_id IS NOT NULL` → one appeal per PA (idempotency anchor).
- RLS: follow the table's existing tenant policy; regenerate `000_baseline.sql` + `schema.prisma` per the repo's schema-drift procedure.

**Reused, no schema change:** `clinical_ai_prior_auth_requests` (023), `clinical_ai_workflow_runs` (109+110), `clinical_ai_generations`, `clinical_ai_reviews`.

**Bridge:** refactor the appeal generator's `loadClaim` → `loadAppealSubject` that returns a normalized subject from **either** an `insurance_claims` row (existing path, unchanged behavior) **or** a denied `clinical_ai_prior_auth_requests` row, mapping `insurance_provider←payer_name`, `policy_number`, `claim_number←PA reference`, `rejection_reason←payer_decision_reason`, plus evidence/citations off the PA. `generateAppealLetter` gains an optional `priorAuthId` (mutually exclusive with `claimId`).

## 6. Components (files)

**New:**
- `apps/backend/src/services/ai/priorAuthAppealChainService.js` — `NODES`, singleton `getPriorAuthAppealGraph()`, `composePriorAuthAppeal(priorAuthId, {startedBy, req})` → `runWorkflow({ graph, store: getDefaultCheckpointStore(), tenantId, ... })`, gate predicates `gateSubmitted`/`gateResolved`, module-load `registerWorkflowGraph(...)` + two `registerPauseReasonHandler(...)`, and `__testing__` export (mirror `dischargeComposeService.js:455`).
- `apps/backend/src/schedulers/priorAuthAppealStarterScheduler.js` (or fold into existing scheduler) — sweep denied PAs (module enabled, no run/appeal) → `composePriorAuthAppeal`; `withJobLock`.
- `apps/backend/src/routes/admin/clinicalAi/priorAuthAppealRoutes.js` — `POST /prior-auth/:id/appeal` (start), `POST /prior-auth-appeal/:runId/resume`, `POST /prior-auth-appeal/:runId/fail`, `GET /prior-auth-appeal/:runId` (mirror `dischargeComposeRoutes.js`).
- `apps/backend/src/migrations/312_appeal_from_prior_auth.sql`.

**Changed:**
- `appealLetterGeneratorService.js` — `loadClaim`→`loadAppealSubject`; `generateAppealLetter` accepts `priorAuthId`.
- `priorAuthorizationService.js` — `recordPayerDecision`: on `denied`, post-commit best-effort `publishEvent('clinical_ai.prior_auth_denied', …)`. **Consistency fix:** add the missing `module.enabled` gate to `generatePriorAuthorization`.
- `utils/scheduler.js` — register the starter sweep cron.
- Route index (`clinicalAiRoutes.js`) — mount the new routes.

## 7. Trigger & resume wiring

- Register: `registerWorkflowGraph('prior_auth_appeal_chain', getPriorAuthAppealGraph)`; `registerPauseReasonHandler('await_appeal_human_disposition', gateSubmitted)`; `registerPauseReasonHandler('await_appeal_payer_response', gateResolved)` — at service module load. (Without this the run sits paused forever; `workflowResumeScheduler.js:206` exposes these helpers.)
- `gateSubmitted(run)` → look up appeal by `run.state.pendingDisposition.appeal_id`; resume iff `appeal_status='submitted'`.
- `gateResolved(run)` → resume iff `appeal_status ∈ (approved|denied|withdrawn)`.
- Human touchpoints = the **existing** `/appeal-letters` decide/submit/payer-response endpoints. No new review UI.

## 8. Gating, enablement & security

- `appeal_letter_generator` stays default OFF. `load_denied_prior_auth` guards `module.enabled`; the starter sweep only scans enabled tenants. Control-plane only (admin/IT + IP allowlist + `requireClinicalAiControl`). Tenant-scoped throughout (RLS).
- Committed `CLINICAL_AI_PROVIDER=template`; local Ollama only for dev testing, reverted before commit.

## 9. Error handling & idempotency

- Node throw → run `status='failed'` (`error_node`/`error_message`); inspect via `GET …/:runId`, recover via `…/fail`.
- LLM miss → `safeJsonParse(text, fallbackDraft)` degrades to the rules-based appeal draft (`used_ai=false`); never crashes the run.
- Resume-gate throw → swallowed as `false` by the scheduler → run stays paused, retried next tick.
- **Exactly-once draft:** partial-unique `prior_auth_id` on the appeal table + starter-sweep dedupe (skip PAs that already have a run/appeal).
- Migration is backward-compatible: existing claim-based appeals (`claim_id NOT NULL`) are unaffected; the CHECK only constrains new rows.

## 10. Test plan (TDD)

- **Unit (memory store; no DB/LLM):** `loadAppealSubject` (PA vs claim hydration); `classifyDenialReason`; graph traversal + pause/resume via the `__testing__` partial-graph pattern (stub `generateClinicalText` + persistence via `ctx`); gate handlers via `registerPauseReasonHandler('test_*')` (mirror `workflowGraphRunner.test.js`, `workflowResumeScheduler.test.js`, `dischargeComposeService.test.js`).
- **Routes:** start (201/202), resume, fail, get + role/IP gating (mirror `dischargeComposeRoutes.test.js`).
- **Integration (real PG):** migration applies; persist appeal with `prior_auth_id`/null `claim_id` passes the CHECK; duplicate start blocked by the unique index; full run drafts→pauses; resume after `appeal_status` flips. (Where jsonb/FK/CHECK gotchas bite — run `lint:raw-params`; bare params in `jsonb_build_object` need `::type` casts.)
- **Gates before "done" (local CI authoritative):** `npm run test:ci` (chunked), `npm run lint` (incl. `lint:raw-params`, phi-tenant-id, external-regions, secrets:scan), local gitleaks, local semgrep `--error --severity ERROR`. Plus a local-Ollama smoke via `POST /prior-auth/:id/appeal`.

## 11. Code-grounded anchors

- Runner: `workflowGraphRunner.js` (`WorkflowGraph` :62; `runWorkflow` :105; `resumeWorkflow` :140; `pauseRun`/`haltRun`).
- Store: `workflowCheckpointStore.js` (`getDefaultCheckpointStore` :424); table `clinical_ai_workflow_runs` (migrations 109 + **110** for `parent_run_id`/`parent_node`).
- Scheduler: `workflowResumeScheduler.js` (registry-driven; `registerWorkflowGraph`/`registerPauseReasonHandler` :206; gate pattern `isGovernanceApproved` :63); cron `utils/scheduler.js:306`.
- Template: `dischargeComposeService.js` (graph build :333; nodes :100–288; pause node :246; `__testing__` :455); routes `dischargeComposeRoutes.js`.
- Appeal: `appealLetterGeneratorService.js` (`classifyDenialReason` :169; `buildAppealLetterSections` :326; `generateAppealLetter` :512; `loadClaim` :414); table `040_appeal_letter_generator.sql`.
- PA: `priorAuthorizationService.js` (`recordPayerDecision` :283/:304; `generatePriorAuthorization` :86); table `023_prior_authorization.sql` (`status` denied; `payer_decision_reason`).

## 12. Future

- Multi-level escalation loop at `finalize_outcome` (first→second→external; the appeal table already has `appealType`).
- Optional payer adapter for electronic appeal submission (extend the prior-auth payer adapter).
- Wire the model provider (Ollama) + enable modules — per the AI feature program, done last.
