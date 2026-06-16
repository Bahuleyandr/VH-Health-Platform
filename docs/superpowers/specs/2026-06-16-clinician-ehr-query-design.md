# Clinician EHR Query (v1) — Design

- **Date:** 2026-06-16
- **Status:** Approved (design); implementation pending
- **Branch:** `feat/clinician-ehr-query` (off `main`)
- **Module:** `clinician_ehr_query` (NEW registry entry, `enabled:false`)
- **Surface:** Clinical plane; `CLINICAL_ROLES` + `phiAccessLogger`. Not patient-facing.

## 1. Context

Clinicians want to ask free-text questions over a patient's record ("is this AKI new or chronic?", "what antibiotics last admission?"). Findings from the existing-code audit:
- The RAG chatbot `patientChatbotService.js` is **patient-self-service only** (hard `jwt.uid == patient_uid` ownership check; only SUPER_ADMIN bypasses) — it cannot serve a clinician querying any patient.
- The pgvector corpus `clinical_ai_corpus` contains **only signed discharge summaries** (`ragService.js` `backfillSignedDischargeSummaries`) — the live record (notes/labs/vitals/meds) is **not indexed**, so embedding-RAG over a record returns ~nothing for active patients. Building that index is a multi-week pipeline.
- But the record **is already assembled** by `clinicalTimelineService.js`: `collectAdmissionClinicalContext(admissionId)` (`:831`) builds a rich per-admission packet (notes, diagnoses, NEWS2, vitals, MARs, prescriptions, investigations, orders, handovers, referrals, allergies, attending + citations), and `getPatientTimeline(patientUid, { dateFrom, dateTo, limit, sort })` (`:778`) builds the longitudinal timeline.

So v1 = **chart-packet grounding** (feed the assembled record + the question to the LLM), no embeddings.

## 2. Goals / non-goals

**Goals (v1):**
- A clinician asks a free-text question about a patient and gets a **live, grounded answer** with citations.
- The answer **differentiates the current admission from prior history** (the clinically valuable bit).
- Answer is grounded to the provided packet (PHI-leak defenses ensure it can't reference data outside it).
- Audit-logged; **disabled by default**; committed provider stays `template`.

**Non-goals (v1):**
- Embedding-based retrieval over the full record (corpus not built — v2).
- Multi-turn conversation (single question → answer; stateless).
- Any write/mutation of the record (read-only Q&A).
- Patient-facing surface.
- A review-queue/sign-off step (the asking clinician is the human-in-the-loop).

## 3. Locked decisions
1. **Live answer** to the asking clinician (no review queue); audit-persist for traceability.
2. **Dual-scope, differentiated:** current admission + prior history, with the answer attributing findings to each.
3. **Chart-packet grounding**, not embeddings (corpus is discharge-summary-only).
4. **Single-turn** stateless Q&A.

## 4. Architecture & flow

```
POST /clinical/ehr-query { patientUid, question, scope?, admissionId?, dateFrom?, dateTo? }
   scope ∈ { 'current_admission' | 'history' | 'both' }  (default 'both')
   gate: requireRole(...CLINICAL_ROLES) + phiAccessLogger('EHR_QUERY')
   │
   ▼  answerEhrQuery({ patientUid, question, scope, admissionId, dateFrom, dateTo, req })
 1. module-enabled gate (clinician_ehr_query, tenant 3-layer); shadow care-team check via accessDecisionService
    (logs would-be-denials, does NOT block — matches the platform's current shadow posture)
 2. resolve CURRENT admission: passed admissionId, else the patient's active admission row; may be none (outpatient)
 3. assemble a TWO-PART packet (scope-driven):
      [CURRENT ADMISSION] collectAdmissionClinicalContext(admissionId)         (when scope includes current + an admission exists)
      [PRIOR HISTORY]     getPatientTimeline(patientUid, { dateFrom, dateTo, limit })  (events OUTSIDE the current admission window)
    build a flat citations list from both sections (event → citation).
 4. generateClinicalText({ taskType:'clinician_ehr_query', tenantId, tenantRegion,
      systemPrompt: "Answer ONLY from the provided record. Clearly attribute each finding to THIS ADMISSION vs
                     PRIOR HISTORY. Cite the supporting events. If the record does not contain the answer, say so.",
      userPrompt: <serialized [CURRENT ADMISSION] section> + <serialized [PRIOR HISTORY] section> + question })
 5. runOutputDefenses({ draft, context: packet, citations })  — PHI-leak (answer can't reference identifiers/data
      not in the packet) + numeric mismatch; a 'critical' leak suppresses the answer.
 6. persist clinical_ai_generations (audit row; metadata = { question, scope, window, admission_id }) — NO review row
 7. return { answer, citations, scope, window:{dateFrom,dateTo,current_admission_id,event_count}, safety_flags, used_ai }
```

**Differentiation mechanism:** the packet labels the two sections; the prompt forces the model to tag each finding `THIS ADMISSION` vs `PRIOR HISTORY` and cite. The history section EXCLUDES the current admission's date window to avoid duplication (events are attributed to one section).

**Token management:** the current-admission packet is bounded; the history section is **windowed** — default `dateFrom = now − 12 months`, `limit` cap (e.g. 300 events), widenable via params. `scope='current_admission'` or `'history'` drops to one section. (Embedding retrieval across *all* history = v2.)

## 5. Components (files)

**New:**
- `apps/backend/src/services/ai/clinicianEhrQueryService.js` — `answerEhrQuery(...)`: scope resolution, two-part packet assembly (reusing `collectAdmissionClinicalContext` + `getPatientTimeline`), prompt build, `generateClinicalText`, `runOutputDefenses`, audit INSERT into `clinical_ai_generations` (its own INSERT — `saveGeneration` is private to clinicalAiWorkflowService), return the live answer. Plus a `resolveCurrentAdmission(patientUid)` helper and a `serializeEhrContext(packet)` helper (pure, unit-testable).
- `apps/backend/src/routes/admin/clinicalAi/ehrQueryRoutes.js` (or under the clinical plane) — `POST /clinical/ehr-query`. Gate: `requireRole(...CLINICAL_ROLES)` + `phiAccessLogger('EHR_QUERY')` + `logClinicalAiAudit`.
- Tests: `clinicianEhrQueryService.test.js` (unit), `ehrQueryRoutes.test.js` (route), `clinicianEhrQuery.deep.test.js` (real-PG integration).

**Changed:**
- `clinicalAiModuleService.js` — add the `clinician_ehr_query` module: `enabled:false`, `surface:'clinical'`, `risk:'medium'`, `requiresCitations:true`, `requiresClinicianSignoff:false`, `reviewRoles:[]` (no review — live answer), `outputSchema` describing `{ answer, citations }`.
- Route index — mount the new route.

**No new migration** — reuses `clinical_ai_generations` + the existing clinical tables.

## 6. Gating & security
- `clinician_ehr_query` stays `enabled:false`; runs only when enabled for the tenant. Clinical plane, `CLINICAL_ROLES` only.
- Shadow-mode care-team check via the existing `accessDecisionService` (logs would-be-denials, does not block — consistent with the platform's current posture; flipping to enforce is a platform-wide decision, out of scope here).
- `phiAccessLogger('EHR_QUERY')` logs the access; tenant-scoped (RLS) reads. Committed `CLINICAL_AI_PROVIDER=template`.

## 7. Error handling & grounding
- PHI-leak `critical` → suppress the answer, return the safety flags (the answer must not surface identifiers/data absent from the packet).
- No active admission (outpatient) + `scope` includes current → gracefully fall to history-only, note it in the response.
- Empty packet (no record in window) → the model is instructed to say "the record does not contain…"; the response notes the empty window.
- LLM miss (`used_ai=false`, template) → return a deterministic "AI is not enabled / no model configured" style result (no fabricated answer); the audit row records `used_ai=false`.
- `generateClinicalText`/timeline errors → `AppError`.

## 8. Test plan (TDD)
- **Unit:** `serializeEhrContext` labels CURRENT ADMISSION vs PRIOR HISTORY sections + emits citations; `resolveCurrentAdmission` (active vs none); `answerEhrQuery` calls `generateClinicalText` with both sections + runs defenses + persists audit + returns the answer (mock timeline/LLM/defenses). PHI-leak critical → suppressed.
- **Route:** `POST /clinical/ehr-query` → 200 with `{ answer, citations, scope }`; `CLINICAL_ROLES` gate rejects non-clinical roles; module-disabled → 403.
- **Integration (real PG):** seed a patient with an active admission (notes/diagnoses/vitals in this admission) + older history events → query with `scope:'both'` → an audit `clinical_ai_generations` row is written; the serialized context contains both sections; `scope:'current_admission'` includes only the admission section. (Template provider → `used_ai=false`; assert the structure, not model output.)
- **Gates:** `npm run test:ci`, `npm run lint`, local gitleaks/semgrep. Local-Ollama smoke → a real differentiated answer (`used_ai=true`).

## 9. Code-grounded anchors
- Record assembly: `clinicalTimelineService.js:831` (`collectAdmissionClinicalContext`), `:778` (`getPatientTimeline`).
- Substrate: `generateClinicalText` (tenant-aware, `localLlmClient.js:756`), `runOutputDefenses` (`hallucinationDefenses.js:384`), `clinical_ai_generations` columns (`clinicalAiWorkflowService.js:528` `saveGeneration` — pattern to mirror).
- RBAC: `roleHelpers.js:90` (`CLINICAL_ROLES`), `phiAccessLogger`, `careTeamEnforcement.js` (shadow `accessDecisionService`).
- Module registry: `clinicalAiModuleService.js` (add `clinician_ehr_query`).

## 10. Future
- Embedding index of live clinical events (notes/labs/vitals on sign/lock) → retrieve the relevant slice across ALL history (true longitudinal RAG) — v2.
- Multi-turn conversation (reuse the `patient_chat_*`-style session pattern, clinician-scoped).
- Wire the model provider (Ollama) + enable — per the program, done last.
