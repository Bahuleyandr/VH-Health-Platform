# Clinical Coding Assistant (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the existing (disabled) `clinical_coding_assist` module trustworthy by validating every suggested ICD-10 code against the terminology master — flagging unvalidated codes rather than dropping them — on both the on-demand `/admission-ai-draft` path and the discharge-compose child.

**Architecture:** The trigger, generation, persistence, and coder review queue ALREADY exist (`POST /admission-ai-draft` → `generateAdmissionAiDraft(admissionId, 'clinical_coding_assist', …)`; `clinical_coding_assist` is in `ADMISSION_MODULES`). The only net-new logic is a terminology-validation step injected into the coding draft's post-generation node, plus a `system` field in the module's `outputSchema`. ICD-10 only; no CPT; no write-back; stays `enabled:false`.

**Tech Stack:** Node.js (ESM), Jest (`--experimental-vm-modules`), `terminologyService.validateCode('ICD10', code)`, the in-repo admission-AI-draft graph in `clinicalAiWorkflowService.js`.

**Spec:** `docs/superpowers/specs/2026-06-16-clinical-coding-assistant-design.md`

**Conventions:** DB-free unit tests: `npm run test:suite -- <pattern>` (run from `apps/backend`). Branch `feat/clinical-coding-assistant` (already checked out). Never `git add -A` (two unrelated untracked files exist). Commit after each task.

---

## File Structure
- **Create:** `apps/backend/src/services/ai/codingValidationService.js` (the validation step) + its unit test + a real-PG integration test.
- **Modify:** `apps/backend/src/services/ai/clinicalAiWorkflowService.js` (invoke the validation in the coding path) and `apps/backend/src/services/ai/clinicalAiModuleService.js` (outputSchema `system` field).

---

## Task 1: Coding validation service

**Files:** Create `apps/backend/src/services/ai/codingValidationService.js`; Test `apps/backend/src/tests/unit/codingValidationService.test.js`.

- [ ] **Step 1: Read the contract.** Read `apps/backend/src/services/terminology/terminologyService.js` `validateCode` (~line 293) and capture its EXACT return shape (does it return `{ valid, code, display, description }`, a concept row, `null`, or throw on unknown?). Adapt the `isValid`/`display` extraction in Step 3 to match. Also read `clinicalAiWorkflowService.js:424` `codingAssist()` to see the shape of each `suggested_codes` item (it builds `{ code, description, confidence }`).

- [ ] **Step 2: Write the failing test** (`codingValidationService.test.js`), mocking the terminology service with `jest.unstable_mockModule` (mirror `priorAuthAppealChainGates.test.js`):

```javascript
import { jest } from '@jest/globals';
jest.unstable_mockModule('../../services/terminology/terminologyService.js', () => ({
  validateCode: jest.fn(),
}));
const terminology = await import('../../services/terminology/terminologyService.js');
const { annotateCodingDraft } = await import('../../services/ai/codingValidationService.js');

beforeEach(() => terminology.validateCode.mockReset());

test('valid ICD-10 code → validated:true with canonical display, no flag', async () => {
  terminology.validateCode.mockResolvedValue({ code: 'E11.9', display: 'Type 2 diabetes mellitus without complications', valid: true });
  const out = await annotateCodingDraft({ suggested_codes: [{ code: 'E11.9', description: 'diabetes', confidence: 'medium' }] }, { tenantId: 't1' });
  expect(out.suggested_codes[0]).toMatchObject({ system: 'ICD10', code: 'E11.9', validated: true, display: 'Type 2 diabetes mellitus without complications', confidence: 'medium' });
  expect(out.safety_flags).toEqual([]);
});

test('unvalidated (hallucinated) code → kept, validated:false, confidence low, UNVALIDATED_CODE flag', async () => {
  terminology.validateCode.mockResolvedValue(null);
  const out = await annotateCodingDraft({ suggested_codes: [{ code: 'ZZ9.9', description: 'bogus' }] }, { tenantId: 't1' });
  expect(out.suggested_codes[0]).toMatchObject({ code: 'ZZ9.9', validated: false, confidence: 'low' });
  expect(out.safety_flags[0]).toMatchObject({ type: 'UNVALIDATED_CODE', severity: 'medium' });
});

test('terminology lookup throws → fail-closed (validated:false), never throws out', async () => {
  terminology.validateCode.mockRejectedValue(new Error('db down'));
  const out = await annotateCodingDraft({ suggested_codes: [{ code: 'I10' }] }, { tenantId: 't1' });
  expect(out.suggested_codes[0].validated).toBe(false);
  expect(out.safety_flags[0].type).toBe('UNVALIDATED_CODE');
});

test('empty / missing suggested_codes → empty result, no flags, no throw', async () => {
  const out = await annotateCodingDraft({}, { tenantId: 't1' });
  expect(out).toEqual({ suggested_codes: [], safety_flags: [] });
});
```

- [ ] **Step 3: Run to confirm fail.** `npm run test:suite -- codingValidationService.test` → FAIL (module not found).

- [ ] **Step 4: Implement** `codingValidationService.js`:

```javascript
import * as terminologyService from '../terminology/terminologyService.js';

// Treat a terminology result as valid when it resolves to a real concept.
// ADAPT this predicate to validateCode's actual return (read it in Step 1):
function isValidResult(result) {
  if (!result) return false;
  if (result.valid === false) return false;
  return Boolean(result.code || result.display || result.description || result.valid === true);
}

/**
 * Validate + annotate the ICD-10 codes in a clinical_coding_assist draft.
 * Never throws: a terminology failure marks that code unvalidated (fail-closed).
 * Returns { suggested_codes: annotated[], safety_flags: [...] } — nothing dropped.
 */
export async function annotateCodingDraft(draft, { tenantId = null } = {}) {
  const input = Array.isArray(draft?.suggested_codes) ? draft.suggested_codes : [];
  const annotated = [];
  let unvalidated = 0;
  for (const item of input) {
    const code = String(item?.code || '').trim();
    let validated = false;
    let display = item?.display || item?.description || null;
    if (code && code.toUpperCase() !== 'UNSPECIFIED') {
      try {
        const result = await terminologyService.validateCode('ICD10', code);
        validated = isValidResult(result);
        if (validated) display = result.display || result.description || display;
      } catch {
        validated = false;
      }
    }
    if (!validated) unvalidated += 1;
    annotated.push({
      system: 'ICD10',
      code: code || null,
      display,
      validated,
      confidence: validated ? (item?.confidence || 'medium') : 'low',
    });
  }
  const safety_flags = unvalidated > 0
    ? [{ type: 'UNVALIDATED_CODE', severity: 'medium', detail: `${unvalidated} suggested ICD-10 code(s) not found in the terminology master` }]
    : [];
  return { suggested_codes: annotated, safety_flags };
}

export default { annotateCodingDraft };
```

- [ ] **Step 5: Run to confirm pass.** `npm run test:suite -- codingValidationService.test` → PASS. `npm run lint:raw-params` → clean.

- [ ] **Step 6: Commit.** `git add apps/backend/src/services/ai/codingValidationService.js apps/backend/src/tests/unit/codingValidationService.test.js && git commit -m "feat(coding): terminology-validation step for ICD-10 coding suggestions"`

---

## Task 2: Wire validation into the coding draft path + outputSchema

**Files:** Modify `apps/backend/src/services/ai/clinicalAiWorkflowService.js`; Modify `apps/backend/src/services/ai/clinicalAiModuleService.js`.

- [ ] **Step 1: Read the wiring point.** In `clinicalAiWorkflowService.js`, read the `build_safety_flags` node (~line 862, the `NO_SIGNED_DOCUMENTATION` logic) and how the generated `draft` + `state.tenantId` are available there, and how safety flags are accumulated. Identify exactly where the draft for `clinical_coding_assist` exists post-generation.

- [ ] **Step 2: Implement the wiring.** Import `annotateCodingDraft` from `./codingValidationService.js`. In the `build_safety_flags` node, after the draft is available and BEFORE persistence, add (keyed to the coding module):

```javascript
if (moduleKey === 'clinical_coding_assist' && draft && Array.isArray(draft.suggested_codes)) {
  const { suggested_codes, safety_flags: codeFlags } = await annotateCodingDraft(draft, { tenantId: state.tenantId });
  draft.suggested_codes = suggested_codes;          // replace with validated/annotated codes
  safetyFlags.push(...codeFlags);                   // merge UNVALIDATED_CODE flag(s) into the node's flags
}
```
(Adapt `moduleKey`, `draft`, `safetyFlags`, `state.tenantId` to the node's actual local variable names.)

- [ ] **Step 3: outputSchema `system` field.** In `clinicalAiModuleService.js`, find the `clinical_coding_assist` module (~line 1067) and extend `settings.outputSchema` so each entry of `suggested_codes` documents a `system` field, e.g.:

```javascript
outputSchema: {
  type: 'object',
  required: ['suggested_codes', 'evidence', 'coder_notes'],
  properties: {
    suggested_codes: { type: 'array', items: { type: 'object', required: ['system', 'code', 'validated'] } },
  },
},
```
Keep `enabled: false` and all other settings unchanged.

- [ ] **Step 4: Unit test the wiring (if cleanly isolatable).** If `clinicalAiWorkflowService.js` exposes the node or a helper via a `__testing__` export, add `apps/backend/src/tests/unit/clinicalAiWorkflowCodingValidation.test.js` asserting that for `moduleKey === 'clinical_coding_assist'` the draft's `suggested_codes` come back annotated (mock `codingValidationService.annotateCodingDraft`) and that other modules are untouched. If the node is NOT cleanly isolatable without heavy mocking, SKIP the unit test here and rely on the real-PG integration test (Task 3) — note this choice in the commit. Run any existing `clinicalAiWorkflow` tests to confirm no regression: `npm run test:suite -- clinicalAiWorkflow`.

- [ ] **Step 5: Verify.** `npm run test:suite -- "codingValidation|clinicalAiWorkflow|clinicalAiModule"` → green. `npm run lint:raw-params` → clean.

- [ ] **Step 6: Commit.** `git add apps/backend/src/services/ai/clinicalAiWorkflowService.js apps/backend/src/services/ai/clinicalAiModuleService.js <any new test> && git commit -m "feat(coding): validate ICD-10 codes in the draft path + outputSchema system field"`

---

## Task 3: Real-PG integration test (via /admission-ai-draft)

**Files:** Create `apps/backend/src/tests/clinicalCodingAssist.deep.test.js`.

- [ ] **Step 1: Read the harness.** Read `apps/backend/src/tests/priorAuthAppealChain.deep.test.js` for the connection + tenant-module-enable + cleanup pattern (enable a module in `clinical_ai_modules`/`clinical_ai_tenant_modules`, **DELETE** the override on cleanup — do not leave it at `false`). Read `generateAdmissionAiDraft` (`clinicalAiWorkflowService.js:1014`) for its exact return shape + how it reads the chart packet (so you seed the right tables: an `ip_admissions` row, ≥1 signed `clinical_notes` row, ≥1 `diagnoses` row with a real `icd10_code` e.g. `E11.9`).

- [ ] **Step 2: Write the integration test** (real prisma, template provider so `used_ai=false`):
  - Enable `clinical_coding_assist` for the tenant; seed admission + signed note + a `diagnoses` row with `icd10_code='E11.9'`.
  - Call `generateAdmissionAiDraft(admissionId, 'clinical_coding_assist', testUserUid, null)`.
  - Assert: a `clinical_ai_generations` row persisted; its `draft.suggested_codes` are ANNOTATED — each has `system:'ICD10'` and a boolean `validated`; the seeded real code `E11.9` is `validated:true`; a `clinical_ai_reviews` row exists with `decision='pending'`.
  - **Bogus-code path:** insert (or stub the generation to include) a `diagnoses`/draft code like `ZZ9.9` → assert that code comes back `validated:false` and the generation's `safety_flags` contains `UNVALIDATED_CODE` (code kept, not dropped).
  - **Disabled gate:** with the module disabled, `generateAdmissionAiDraft(...,'clinical_coding_assist',...)` throws `forbidden`/403 (via `requireEnabledModule`).
  - Clean up all seeded rows + DELETE the tenant-module override.

- [ ] **Step 3: Run.** `npm test -- clinicalCodingAssist.deep` → PASS. `npm run lint:raw-params` → clean.

- [ ] **Step 4: Commit.** `git add apps/backend/src/tests/clinicalCodingAssist.deep.test.js && git commit -m "test(coding): real-PG integration for validated ICD-10 coding suggestions"`

---

## Task 4: Gates + local-Ollama smoke

- [ ] **Step 1: Full lint.** `npm run lint` (incl. raw-params/PHI/regions/secrets) → clean.
- [ ] **Step 2: Full suite.** `npm run test:ci` → all chunks pass (the QA cluster at `127.0.0.1:55432` must be up; if a deep-test suite errors with a connection/`ECONNREFUSED`, the cluster flapped — re-run `node apps/backend/scripts/qa-cluster-up.mjs` and retry, it's a known host quirk, not a code failure).
- [ ] **Step 3: Local-Ollama smoke (manual).** Temporarily set `apps/backend/.env` `CLINICAL_AI_PROVIDER=ollama`, `CLINICAL_AI_MODEL=gemma2:9b` (already pulled), enable `clinical_coding_assist` for a tenant, seed an admission with signed notes + diagnoses, `POST /admission-ai-draft { admissionId, moduleKey:'clinical_coding_assist' }`; confirm the persisted generation has `used_ai=true` and `suggested_codes` are annotated with `validated`. **Revert `.env` to `template` before committing.**
- [ ] **Step 4: Final commit** (only if lint:fix changed files): stage intended files only.

---

## Done criteria
- Unit + integration tests green; `npm run test:ci` green; `npm run lint` clean.
- `clinical_coding_assist` still `enabled:false`; committed provider still `template`.
- A real ICD-10 code validates; a bogus code is flagged `UNVALIDATED_CODE` (kept, not dropped); both the `/admission-ai-draft` path and the discharge-compose child are validated.
- Then: `superpowers:finishing-a-development-branch` → merge `feat/clinical-coding-assistant` → main per the local-CI-gated workflow.
