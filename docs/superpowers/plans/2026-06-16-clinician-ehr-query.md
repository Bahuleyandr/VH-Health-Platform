# Clinician EHR Query (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A clinician asks a free-text question about a patient and gets a live, chart-grounded answer that differentiates the CURRENT ADMISSION from PRIOR HISTORY, with citations and PHI-leak defenses, audited but not queued for review.

**Architecture:** Reuse the already-assembled record — `collectAdmissionClinicalContext(admissionId)` (rich current-admission packet) + `getPatientTimeline(patientUid, {dateFrom,dateTo,limit})` (windowed prior history). Serialize both into a labeled context, feed to `generateClinicalText`, run `runOutputDefenses`, persist an audit row to `clinical_ai_generations`, return the answer live. No embeddings, no migration, single-turn, `enabled:false`.

**Tech Stack:** Node.js (ESM), Jest (`--experimental-vm-modules`), the in-repo `clinicalTimelineService`, `localLlmClient.generateClinicalText`, `hallucinationDefenses.runOutputDefenses`.

**Spec:** `docs/superpowers/specs/2026-06-16-clinician-ehr-query-design.md`

**Conventions:** DB-free unit tests `npm run test:suite -- <pattern>` (from `apps/backend`). Branch `feat/clinician-ehr-query` (checked out). Never `git add -A` (two unrelated untracked files). Raw SQL: spread params, `::type` casts for jsonb (`npm run lint:raw-params`). Commit per task.

---

## File Structure
- **Create:** `apps/backend/src/services/ai/clinicianEhrQueryService.js` (helpers + `answerEhrQuery`), `apps/backend/src/routes/admin/clinicalAi/ehrQueryRoutes.js` (the route), + 3 tests.
- **Modify:** `apps/backend/src/services/ai/clinicalAiModuleService.js` (register `clinician_ehr_query`), the clinical-AI route index (mount).

---

## Task 1: Context serialization + current-admission resolution

**Files:** Create `apps/backend/src/services/ai/clinicianEhrQueryService.js`; Test `apps/backend/src/tests/unit/clinicianEhrQueryService.test.js`.

- [ ] **Step 1: Read shapes.** Read `clinicalTimelineService.js` `collectAdmissionClinicalContext` (~:831, the returned packet shape: `{ patient, admission, allergies, timeline, ... , citations }`) and `getPatientTimeline` (~:778, returns an array of events each like `{ timestamp, type, summary, payload, citation? }` — confirm the exact event keys). Also find how an ACTIVE admission is identified for a patient: read the `admissions` table columns (grep `apps/backend/src/migrations/000_baseline.sql` for `CREATE TABLE admissions`) — likely a `status` (e.g. `'admitted'`) or a null `discharge_date`/`actual_discharge_date`. Use whatever the schema actually has.

- [ ] **Step 2: Write the failing unit test** for the two pure-ish helpers:

```javascript
import { jest } from '@jest/globals';
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn() },
  prismaReadOnly: { $queryRawUnsafe: jest.fn() },
}));
const prismaMod = await import('../../lib/prisma.js');
const { __testing__ } = await import('../../services/ai/clinicianEhrQueryService.js');
const { serializeEhrContext, resolveCurrentAdmission } = __testing__;

test('serializeEhrContext labels both sections and flattens citations', () => {
  const out = serializeEhrContext({
    currentAdmission: { admission: { id: 7 }, timeline: [{ timestamp: '2026-06-10T00:00:00Z', type: 'lab', summary: 'Creatinine 2.1', citation: { id: 'c1' } }] },
    history: [{ timestamp: '2024-03-01T00:00:00Z', type: 'lab', summary: 'Creatinine 0.9', citation: { id: 'c2' } }],
    scope: 'both',
  });
  expect(out.text).toContain('[CURRENT ADMISSION]');
  expect(out.text).toContain('Creatinine 2.1');
  expect(out.text).toContain('[PRIOR HISTORY]');
  expect(out.text).toContain('Creatinine 0.9');
  expect(out.citations.map((c) => c.id)).toEqual(['c1', 'c2']);
});

test('serializeEhrContext with scope=current_admission omits history', () => {
  const out = serializeEhrContext({ currentAdmission: { admission: { id: 7 }, timeline: [{ timestamp: 't', type: 'note', summary: 'x' }] }, history: [{ timestamp: 't2', type: 'note', summary: 'y' }], scope: 'current_admission' });
  expect(out.text).toContain('[CURRENT ADMISSION]');
  expect(out.text).not.toContain('[PRIOR HISTORY]');
  expect(out.text).not.toContain('y');
});

test('resolveCurrentAdmission returns the active admission id or null', async () => {
  prismaMod.prismaReadOnly.$queryRawUnsafe.mockResolvedValueOnce([{ id: 42 }]);
  await expect(resolveCurrentAdmission('p1', 't1')).resolves.toBe(42);
  prismaMod.prismaReadOnly.$queryRawUnsafe.mockResolvedValueOnce([]);
  await expect(resolveCurrentAdmission('p1', 't1')).resolves.toBeNull();
});
```

- [ ] **Step 3: Run to confirm fail.** `npm run test:suite -- clinicianEhrQueryService.test` → FAIL.

- [ ] **Step 4: Implement the helpers** in `clinicianEhrQueryService.js`:
  - `serializeEhrContext({ currentAdmission, history, scope })`: build `text` with a `[CURRENT ADMISSION]` block (when `scope !== 'history'` and `currentAdmission`) rendering each `currentAdmission.timeline` event as a line `- [<timestamp>] <type>: <summary>`, then a `[PRIOR HISTORY]` block (when `scope !== 'current_admission'`) rendering each `history` event the same way. Collect `citations` from both sections' events (`event.citation` where present), in order (current first). Return `{ text, citations }`.
  - `resolveCurrentAdmission(patientUid, tenantId)`: `prismaReadOnly.$queryRawUnsafe('SELECT id FROM admissions WHERE patient_uid = $1::uuid AND tenant_id = $2::uuid AND <active-condition from Step 1> ORDER BY admitted_at DESC LIMIT 1', patientUid, tenantId)` → return `rows[0]?.id ?? null`. (Use the real active-condition + the real admitted-at/created column from Step 1.)
  - Export `__testing__ = { serializeEhrContext, resolveCurrentAdmission }`.

- [ ] **Step 5: Run to confirm pass.** `npm run test:suite -- clinicianEhrQueryService.test` → PASS. `npm run lint:raw-params` → clean.

- [ ] **Step 6: Commit.** `git add apps/backend/src/services/ai/clinicianEhrQueryService.js apps/backend/src/tests/unit/clinicianEhrQueryService.test.js && git commit -m "feat(ehr-query): context serialization + current-admission resolution"`

---

## Task 2: answerEhrQuery orchestration

**Files:** Modify `apps/backend/src/services/ai/clinicianEhrQueryService.js`; extend the test.

- [ ] **Step 1: Read substrate.** Read `generateClinicalText` signature (`localLlmClient.js:756` — `{ systemPrompt, userPrompt, taskType, tenantRegion, tenantId }` → `{ text, usedAi, provider, model, usage }`), `runOutputDefenses` (`hallucinationDefenses.js:384`), and `saveGeneration`'s INSERT (`clinicalAiWorkflowService.js:528`) for the `clinical_ai_generations` columns to mirror in an audit INSERT. Also read how a module-enabled gate is done (`getClinicalAiModule(moduleKey, { tenantId })` then `if (!module.enabled) throw AppError.forbidden`).

- [ ] **Step 2: Write the failing test** (extend `clinicianEhrQueryService.test.js`), mocking `clinicalTimelineService`, `localLlmClient`, `hallucinationDefenses`, `clinicalAiModuleService`, and `prisma`:

```javascript
test('answerEhrQuery assembles both sections, calls the LLM, runs defenses, audits, returns a live answer', async () => {
  // mocks: getClinicalAiModule -> { enabled:true }, resolveCurrentAdmission via prisma -> [{id:7}],
  // collectAdmissionClinicalContext -> { admission:{id:7}, timeline:[{timestamp:'t',type:'lab',summary:'Cr 2.1',citation:{id:'c1'}}], citations:[{id:'c1'}] },
  // getPatientTimeline -> [{timestamp:'t0',type:'lab',summary:'Cr 0.9',citation:{id:'c2'}}],
  // generateClinicalText -> { text:'This admission: Cr 2.1 [c1]. Prior: Cr 0.9 [c2].', usedAi:true, provider:'ollama', model:'x', usage:{} },
  // runOutputDefenses -> [] (no flags), prisma insert -> [{ id: 99 }]
  const { answerEhrQuery } = await import('../../services/ai/clinicianEhrQueryService.js');
  const res = await answerEhrQuery({ patientUid: 'p1', question: 'is the creatinine rise new?', scope: 'both', req: { tenantId: 't1', user: { uid: 'doc1' } } });
  expect(res.answer).toContain('This admission');
  expect(res.scope).toBe('both');
  expect(res.citations.map((c) => c.id)).toEqual(['c1', 'c2']);
  expect(res.used_ai).toBe(true);
  // audit row written:
  expect(prismaMod.default.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO clinical_ai_generations'), ...expect.anything());
});

test('answerEhrQuery suppresses the answer on a critical PHI leak', async () => {
  // runOutputDefenses -> [{ type:'PHI_LEAK', severity:'critical' }]
  const { answerEhrQuery } = await import('../../services/ai/clinicianEhrQueryService.js');
  const res = await answerEhrQuery({ patientUid: 'p1', question: 'x', scope: 'both', req: { tenantId: 't1', user: { uid: 'doc1' } } });
  expect(res.answer).toBe(null); // suppressed
  expect(res.safety_flags.some((f) => f.severity === 'critical')).toBe(true);
});

test('answerEhrQuery 403s when the module is disabled', async () => {
  // getClinicalAiModule -> { enabled:false }
  const { answerEhrQuery } = await import('../../services/ai/clinicianEhrQueryService.js');
  await expect(answerEhrQuery({ patientUid: 'p1', question: 'x', req: { tenantId: 't1', user: { uid: 'doc1' } } })).rejects.toMatchObject({ statusCode: 403 });
});
```
(Set up the `jest.unstable_mockModule` mocks for `../emr/clinicalTimelineService.js`, `./localLlmClient.js`, `./hallucinationDefenses.js`, `./clinicalAiModuleService.js` at the top of the file before importing the service.)

- [ ] **Step 3: Run to confirm fail**, then **implement `answerEhrQuery({ patientUid, question, scope = 'both', admissionId = null, dateFrom = null, dateTo = null, req })`:**
  1. resolve `tenantId` from `req` (mirror other services — `req?.tenantId`); `getClinicalAiModule('clinician_ehr_query', { tenantId })` → `if (!module.enabled) throw AppError.forbidden('clinician_ehr_query module is disabled', 'EHR_QUERY_MODULE_DISABLED')`.
  2. `const admId = admissionId || (scope !== 'history' ? await resolveCurrentAdmission(patientUid, tenantId) : null);`
  3. `const currentAdmission = (scope !== 'history' && admId) ? await collectAdmissionClinicalContext(admId) : null;`
  4. `const window = { dateFrom: dateFrom || <now - 12 months ISO>, dateTo: dateTo || null };` `const history = (scope !== 'current_admission') ? await getPatientTimeline(patientUid, { dateFrom: window.dateFrom, dateTo: window.dateTo, limit: 300 }) : [];` (exclude events inside the current admission window — filter by the admission's admit/discharge timestamps if available, else accept overlap and let the labels disambiguate).
  5. `const { text, citations } = serializeEhrContext({ currentAdmission, history, scope });`
  6. `const aiResult = await generateClinicalText({ taskType: 'clinician_ehr_query', tenantId, tenantRegion: req?.tenant_region || null, systemPrompt: <the differentiation system prompt from the spec §4>, userPrompt: \`${text}\n\nQUESTION: ${question}\` });`
  7. `const safety_flags = runOutputDefenses({ draft: aiResult.text, context: text, citations });` (match the real `runOutputDefenses` signature). `const critical = safety_flags.some((f) => f.severity === 'critical');`
  8. audit INSERT into `clinical_ai_generations` (mirror saveGeneration columns; `task_type='clinician_ehr_query'`, `status='answered'` or `'draft'`, `used_ai=aiResult.usedAi`, `draft = { answer: critical ? null : aiResult.text }`, `citations`, `safety_flags`, `metadata = { question, scope, window, admission_id: admId }`). jsonb params need `::jsonb` casts.
  9. return `{ answer: critical ? null : aiResult.text, citations, scope, window: { ...window, current_admission_id: admId, event_count: (currentAdmission?.timeline?.length || 0) + history.length }, safety_flags, used_ai: aiResult.usedAi }`.

- [ ] **Step 4: Run to confirm pass**; `npm run lint:raw-params` clean.

- [ ] **Step 5: Commit.** `git add apps/backend/src/services/ai/clinicianEhrQueryService.js apps/backend/src/tests/unit/clinicianEhrQueryService.test.js && git commit -m "feat(ehr-query): answerEhrQuery (dual-scope, differentiated, grounded, audited)"`

---

## Task 3: Module registration + route

**Files:** Modify `apps/backend/src/services/ai/clinicalAiModuleService.js`; Create `apps/backend/src/routes/admin/clinicalAi/ehrQueryRoutes.js`; modify the clinical-AI route index; Test `apps/backend/src/tests/unit/ehrQueryRoutes.test.js`.

- [ ] **Step 1: Read patterns.** Read an existing module entry (`clinicalAiModuleService.js` `clinical_coding_assist` ~:1067) and an existing clinical-plane route + how it's mounted/gated (`requireRole(...CLINICAL_ROLES)` + `phiAccessLogger` + `logClinicalAiAudit`). Find which route file under `routes/admin/clinicalAi/` serves the clinical plane (the one `clinicalUseRoutes.js` mounts) to mirror gating + mount point.

- [ ] **Step 2: Register the module.** Add a `clinician_ehr_query` entry to `CLINICAL_AI_MODULES`:
```javascript
{
  module_key: 'clinician_ehr_query',
  display_name: 'Clinician EHR Query',
  description: 'Answers a clinician free-text question over a patient record (current admission + prior history), grounded + cited. Live answer, audit-logged, no review.',
  enabled: false,
  settings: {
    surface: 'clinical', risk: 'medium', requiresClinicianSignoff: false, requiresCitations: true,
    reviewRoles: [], approvalPolicy: 'none',
    outputSchema: { type: 'object', required: ['answer', 'citations'] },
    retentionDays: 365,
  },
},
```

- [ ] **Step 3: Write the failing route test** (`ehrQueryRoutes.test.js`, supertest, mock `clinicianEhrQueryService.answerEhrQuery`): `POST /clinical/ehr-query` with a `DOCTOR` JWT → 200 with `{ answer, citations, scope }`; a non-clinical role → 403; module-disabled (service throws forbidden) → 403.

- [ ] **Step 4: Implement the route.** `POST /clinical/ehr-query` → validate `{ patientUid, question }` required; `answerEhrQuery({ ...req.body, req })`; `success(res, result)`. Gate with `requireRole(...CLINICAL_ROLES)` + `phiAccessLogger('EHR_QUERY')` + `logClinicalAiAudit`. Mount under the clinical plane next to the admission-ai-draft route.

- [ ] **Step 5: Run to confirm pass** (`npm run test:suite -- ehrQueryRoutes.test`); `npm run lint:raw-params` clean.

- [ ] **Step 6: Commit.** `git add apps/backend/src/services/ai/clinicalAiModuleService.js apps/backend/src/routes/admin/clinicalAi/ehrQueryRoutes.js <route-index> apps/backend/src/tests/unit/ehrQueryRoutes.test.js && git commit -m "feat(ehr-query): register module + clinical-plane route"`

---

## Task 4: Real-PG integration test

**Files:** Create `apps/backend/src/tests/clinicianEhrQuery.deep.test.js`.

- [ ] **Step 1: Read the harness** `priorAuthAppealChain.deep.test.js` (connection, tenant-module-enable, **DELETE the override on cleanup**). Read `collectAdmissionClinicalContext`/`getPatientTimeline` to learn the minimal seed (a patient `users` row, an active `admissions` row, a `clinical_notes`/`diagnoses` row in this admission, plus an older `diagnoses`/note for history).
- [ ] **Step 2: Write the integration test:** enable `clinician_ehr_query` for the tenant; seed the patient + active admission + a current-admission lab/diagnosis + an older history event. Call `answerEhrQuery({ patientUid, question:'creatinine history?', scope:'both', req:{ tenantId, user:{uid} } })`. Assert: a `clinical_ai_generations` audit row exists (`task_type='clinician_ehr_query'`, `used_ai=false` under the template provider); the returned `scope='both'` and `window.current_admission_id` = the seeded admission; with `scope:'current_admission'`, the returned `event_count` reflects only the admission events. Module disabled → `answerEhrQuery` throws 403. Cleanup: DELETE seeded rows + the module override.
- [ ] **Step 3: Run** `npm test -- clinicianEhrQuery.deep` (bring QA cluster up with `node scripts/qa-cluster-up.mjs` if connection errors — known host flake). `npm run lint:raw-params` clean.
- [ ] **Step 4: Commit.** `git add apps/backend/src/tests/clinicianEhrQuery.deep.test.js && git commit -m "test(ehr-query): real-PG integration (dual-scope audit + structure)"`

---

## Task 5: Gates + local-Ollama smoke

- [ ] **Step 1: Full lint** `npm run lint` → clean. **Watch the import-graph gotcha:** if `clinicianEhrQueryService` or the route transitively imports something pulling `prismaReadOnly`/`terminologyService` into a module that suites mock `prisma.js` against, lazy-import to avoid breaking those suites (see the coding-assistant fix). Run `npm run test:suite -- "clinicalAiGovernanceHardening|clinicalAiWorkflow"` to confirm no suite-load regression.
- [ ] **Step 2: Full suite** `npm run test:ci` → all chunks pass (QA cluster up).
- [ ] **Step 3: Local-Ollama smoke (manual).** `.env` `CLINICAL_AI_PROVIDER=ollama`, `CLINICAL_AI_MODEL=gemma2:9b`; enable `clinician_ehr_query` for a tenant; seed a patient with a current admission + history; `POST /clinical/ehr-query { patientUid, question, scope:'both' }`; confirm a differentiated answer (mentions THIS ADMISSION vs PRIOR HISTORY) with `used_ai=true`. **Revert `.env` to `template` before committing.**
- [ ] **Step 4: Final commit** if lint:fix changed files (stage intended only).

---

## Done criteria
- Unit + route + integration green; `npm run test:ci` green; `npm run lint` clean; no suite-load regression.
- `clinician_ehr_query` `enabled:false`; provider `template`.
- Answer differentiates CURRENT ADMISSION vs PRIOR HISTORY, cites, PHI-leak-defended, audited (no review queue).
- Then: `superpowers:finishing-a-development-branch` → merge to `main`.
