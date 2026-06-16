# Clinical Coding Assistant (v1) — Design

- **Date:** 2026-06-16
- **Status:** Approved (design); implementation pending
- **Branch:** `feat/clinical-coding-assistant` (off `main`)
- **Module:** `clinical_coding_assist` (already registered, `enabled:false`)
- **Surface:** Clinical-AI control plane; coder review roles `BILLING_STAFF` / `MEDICAL_RECORDS` / `ADMIN`. Not patient-facing.

## 1. Context

A `clinical_coding_assist` module already exists (`clinicalAiModuleService.js:1067`, `enabled:false`): it is wired as a child of `discharge_summary_compose` (`dischargeComposeService.js` maps it to `coding_draft`), has a rules fallback (`clinicalAiWorkflowService.js:424` `codingAssist()` — maps signed-note `diagnoses.icd10_code` → suggestions) and an LLM path (`generate_ai_text`, `:818`), a signed-documentation gate (`NO_SIGNED_DOCUMENTATION` safety flag, `:862`), and persists drafts to `clinical_ai_generations` + the coder review queue `clinical_ai_reviews`. A real ICD-10 terminology master exists and is queryable: `terminologyService.validateCode('ICD10', code)` (`services/terminology/terminologyService.js:293`, federated from the `icd10_codes` table via migration 275).

**Three gaps** make it neither trustworthy nor usable today:
1. It only fires *inside* discharge-compose — no on-demand trigger for a coder to run it on a chosen admission.
2. LLM-suggested codes are **not validated** against the terminology master (the model can hallucinate ICD-10 codes).
3. (Out of v1 scope) no coder-approval write-back into billing/discharge.

## 2. Goals / non-goals

**Goals (v1):**
- A coder can run the assistant **on demand** for an admission and get **terminology-validated ICD-10 diagnosis-code suggestions** in the review queue.
- Every suggested ICD-10 code is checked against the master; unvalidated codes are **kept but flagged**, never silently dropped.
- Validation applies to **both** the new standalone path and the existing discharge-compose child.
- Stays **disabled by default** (`enabled:false`); committed LLM provider stays `template`.

**Non-goals (v1):**
- CPT / procedure coding (no CPT master exists; deferred until one is sourced).
- Coder-approval **write-back** into `discharge_summaries.icd10_codes[]` / `insurance_preauth` (deliberate follow-up).
- OPD/encounter trigger (inpatient/admission only for v1).
- Any patient-facing surface.

## 3. Locked decisions
1. **v1 = validated suggestions + review, no write-back.**
2. **ICD-10 and ICD-11, fully validated** (system-aware — both validate via `terminologyService.validateCode(system, code)`). The offline rules fallback emits ICD-10 (the chart carries only ICD-10); ICD-11 suggestions come from the LLM path (prompt-driven, when the model is wired) and are validated against the seeded ICD-11 master. **CPT deferred** (no CPT master — unsupported systems are kept but left `validated:false`).
3. **Reuse** the `clinical_coding_assist` module + admission-AI-draft generation; **add** an on-demand trigger and a terminology-validation step.
4. **Inpatient/admission** unit only.

## 4. Architecture & flow

```
TRIGGER (on demand) — REUSES the existing generic route (no new route needed):
  POST /admission-ai-draft  { admissionId, moduleKey:'clinical_coding_assist' }
        (clinicalUseRoutes.js:140 → generateAdmissionAiDraft; clinical-AI-use roles)
  (Also auto-runs as the discharge-compose child. The validation step below applies to BOTH paths.)
        │
        ▼
RUN clinical_coding_assist for the admission (REUSES the admission-AI-draft generation):
  1. load signed chart context (signed notes + diagnoses) — existing chart packet
  2. gate: if no signed documentation → NO_SIGNED_DOCUMENTATION flag (existing)
  3. generate suggestions — generateClinicalText (tenant-aware) OR codingAssist() rules fallback
  4. ★ validate_codes (NEW): for each suggested ICD-10 code → terminologyService.validateCode('ICD10', code)
       → annotate { system:'ICD10', code, display:<canonical|original>, validated:bool, confidence }
       → any invalid → raise UNVALIDATED_CODE safety flag (kept, demoted to confidence:'low')
  5. runOutputDefenses (existing hallucination defenses)
  6. persist clinical_ai_generations (draft) + clinical_ai_reviews (decision='pending', reviewRoles)
        │
        ▼
  Coder reviews/edits/approves in the queue via the EXISTING review endpoints. (No write-back in v1.)
```

The **validation step is the core new logic** and lives in the shared coding path (keyed to `clinical_coding_assist`) so the discharge-compose child inherits it too. The standalone endpoint reuses the same generation+validation, just triggered directly for one admission instead of as a compose child.

## 5. Components (files)

**New:**
- `apps/backend/src/services/ai/codingValidationService.js` — `annotateCodingDraft(draft, { tenantId })`: validates each suggested ICD-10 code via `terminologyService.validateCode('ICD10', code)` and returns `{ suggested_codes: annotated[], safety_flags: [...] }`. Each code → `{ system:'ICD10', code, display, validated, confidence }`; ≥1 invalid → one `UNVALIDATED_CODE` flag (severity `medium`). **Never throws** — a terminology lookup failure → `validated:false` for that code (fail-closed), not an error.
- Tests: `codingValidationService.test.js` (unit), `clinicalCodingAssist.deep.test.js` (integration).

**No new orchestration service or route:** the on-demand trigger already exists — `POST /admission-ai-draft` (`clinicalUseRoutes.js:140`) → `generateAdmissionAiDraft(admissionId, moduleKey, …)`, and `clinical_coding_assist` is already in `ADMISSION_MODULES` (`clinicalAiWorkflowService.js:43`). The discharge-compose child also runs it. Both inherit the validation below.

**Changed:**
- `clinicalAiModuleService.js` — extend `clinical_coding_assist` `settings.outputSchema` so each code carries a `system` field (explicit ICD10; future-proofs ICD-11/CPT). Keep `enabled:false`.
- `clinicalAiWorkflowService.js` — invoke `annotateCodingDraft` for the `clinical_coding_assist` module in the post-generation step (the `build_safety_flags` node, keyed on `moduleKey === 'clinical_coding_assist'`), replacing `draft.suggested_codes` with the annotated array and merging the returned `safety_flags`. This validates BOTH the `/admission-ai-draft` path and the discharge-compose child.

## 6. Validation specifics
- `validateCode('ICD10', code)` is positional (`terminologyService.js:293`). Treat a thrown/unknown result as **not validated** (fail-closed to "flag it", never crash the draft).
- Annotation per code: `{ system:'ICD10', code, display, validated, confidence }`. `display` = the master's canonical description when validated, else the model's text. `confidence` demoted to `'low'` when `validated:false`.
- A draft with ≥1 unvalidated code gets an `UNVALIDATED_CODE` entry in `safety_flags` (severity `medium`) so the coder sees it prominently.
- Rules-fallback codes (already-coded `diagnoses.icd10_code`) still pass through validation (cheap, consistent).

## 7. Gating, enablement & security
- `clinical_coding_assist` stays `enabled:false`; the run path gates on `module.enabled` for the tenant (3-layer override). Control-plane only. Tenant-scoped (RLS) throughout; the generation reuses the tenant-aware `generateClinicalText`.
- Committed `CLINICAL_AI_PROVIDER=template`; local Ollama only for dev testing.

## 8. Error handling
- Terminology lookup failure → code marked `validated:false` (fail-closed), draft still produced. Never throws out of validation.
- No signed documentation → existing `NO_SIGNED_DOCUMENTATION` flag; the draft is still queued (coder sees the gap).
- LLM miss → existing `codingAssist()` rules fallback (`used_ai=false`); validation still runs.
- Node/endpoint errors map to `AppError` as elsewhere.

## 9. Test plan (TDD)
- **Unit:** `validateAndAnnotateCodes` — valid code → `validated:true` + canonical display; invalid → `validated:false`, `confidence:'low'`, `UNVALIDATED_CODE` flag; terminology-throw → fail-closed (mock `terminologyService`). The coding path applies validation for `clinical_coding_assist` only.
- **Route:** `POST /admissions/:id/coding-assist` → 201/202; role gate rejects non-coder roles (mirror `dischargeComposeRoutes.test.js`).
- **Integration (real PG):** seed admission + signed note + ≥1 `diagnoses` row → run coding-assist → `clinical_ai_generations` draft persisted with annotated `suggested_codes` (each `validated` set) + a `clinical_ai_reviews` row (`pending`); inject a bogus code → it's flagged `UNVALIDATED_CODE`, not dropped. Module disabled → 403.
- **Gates:** `npm run test:ci`, `npm run lint` (raw-params/PHI/regions/secrets), local gitleaks/semgrep. Local-Ollama smoke via the endpoint → `used_ai=true` + codes validated.

## 10. Code-grounded anchors
- Module: `clinicalAiModuleService.js:1067` (`clinical_coding_assist`); compose child mapping `dischargeComposeService.js` (`coding_draft`).
- Coding flow: `clinicalAiWorkflowService.js:424` (`codingAssist()` rules), `:818` (`generate_ai_text`), `:862` (`NO_SIGNED_DOCUMENTATION`), `:541`/`:630` (persist generation + review placeholder).
- Terminology: `terminologyService.js:293` (`validateCode`), federation seed migration `275_terminology_service.sql`; `icd10_codes` master (`000_baseline.sql:9827`).
- Substrate: `generateClinicalText` (tenant-aware), `runOutputDefenses` (`hallucinationDefenses.js`), `clinical_ai_generations` / `clinical_ai_reviews`.

## 11. Future
- CPT/procedure coding once a CPT master is sourced (register `CPT` in `terminology_code_systems` + import).
- Coder-approval **write-back** into `discharge_summaries.icd10_codes[]` / `insurance_preauth` (with authz).
- OPD/encounter trigger (`diagnoses.encounter_id` anchor).
- Wire the model provider (Ollama) + enable the module — per the AI program, done last.
