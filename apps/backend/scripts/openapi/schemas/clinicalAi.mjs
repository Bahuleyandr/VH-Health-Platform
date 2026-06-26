// OpenAPI Phase 5 — Clinical-AI overlay. Typed request/response schemas for the
// clinical-AI control + clinical-use surface.
//
// DUAL-MOUNT. Every CONTROL op is keyed under BOTH the canonical
// `/api/v1/clinical-ai/control` prefix AND the legacy `/api/v1/admin/clinical-ai`
// prefix (clinicalAiRoutes.js mounts the ~27 sub-routers flat at '/', and the
// aggregator is mounted at both prefixes with byte-identical suffix sets — clean
// dual-mount, both literal path keys survive in the spec). Clinical-USE ops live
// only at `/api/v1/clinical-ai/clinical`. We therefore author each op ONCE as a
// `['METHOD /suffix', overlay]` pair and fan it across its prefix set via the
// `aliasOps()` helper (mirrors emr.mjs).
//
// T0 SCAFFOLD: shared LOOSE schemas + the dual-mount helper. `operations` is
// intentionally EMPTY at this pass — later passes append ops to CONTROL_OPS /
// CLINICAL_OPS, REUSE the ClinicalAi* schemas declared here, and add strict
// per-domain schemas only for the strict shortlist.
//
// ★ UNIQUE NAMES: emr.mjs already EXPORTS schema `AiDraftEnvelope` and owns the
// consts AI_REVIEW_STATUS / AI_SAFETY_SEVERITY / RISK_BAND / CLINICAL_AI_PROVIDER
// (mergeSchemaModules THROWS on duplicate SCHEMA names). All schemas in THIS
// module are prefixed `ClinicalAi*`. Top-level consts are module-local (no
// conflict across modules), so we declare our OWN null-free enum consts here.
import { envelope, listEnvelope } from './_helpers.mjs';

// ---------------------------------------------------------------------------
// Null-free const enums (module-local). Spectral 6.16 CRASHES on a null enum
// value, so every array here is null-free; nullable enum fields pair
// {type:'string', nullable:true, enum:[...]}.
// ---------------------------------------------------------------------------
// AI review_status — the clinical-AI generation/review lifecycle (mirrors the
// emr AI_REVIEW_STATUS set; declared locally to avoid the cross-module dup).
const CLINICAL_AI_REVIEW_STATUS = [
  'pending', 'accepted', 'rejected', 'needs_revision', 'edited', 'schema_unavailable',
];
// AI safety_flags severity band.
const CLINICAL_AI_SAFETY_SEVERITY = ['low', 'medium', 'high', 'critical'];
// PATCH decide ops reviewer_decision (loose 4-way; the strict shortlist may pin
// per-domain variants later).
const CLINICAL_AI_REVIEWER_DECISION = ['accepted', 'rejected', 'needs_revision', 'edited'];

// A reusable opaque LLM/template draft (parsed object, no required keys).
const aiDraft = { type: 'object', additionalProperties: true };
// AI safety flag entry.
const clinicalAiSafetyFlag = {
  type: 'object',
  additionalProperties: true,
  properties: {
    severity: { type: 'string', enum: CLINICAL_AI_SAFETY_SEVERITY },
    code: { type: 'string' },
    message: { type: 'string' },
  },
};

export const schemas = {
  // =========================================================================
  // Shared LOOSE schemas — reused across ~300 LLM-draft / governance ops.
  // =========================================================================

  // ---- ClinicalAiDraftEnvelope -------------------------------------------
  // The canonical typed envelope returned by every single-POST generate /
  // evaluate / record op across all tiers + assistants + evaluators. LOOSE:
  // `draft` is opaque (additionalProperties:true, no required keys); the typed
  // envelope keys carry the governance metadata. Config-derived bands
  // (risk_band/urgency/trust_band) live INSIDE `draft` as plain strings — they
  // are NOT pinned here (no DB CHECK backing).
  ClinicalAiDraftEnvelope: {
    type: 'object',
    additionalProperties: true,
    required: ['module_key', 'draft'],
    properties: {
      module_key: { type: 'string' },
      generation_id: { type: 'integer', nullable: true },
      review_id: { type: 'integer', nullable: true },
      review_status: { type: 'string', nullable: true, enum: CLINICAL_AI_REVIEW_STATUS },
      provider: { type: 'string', nullable: true },
      used_ai: { type: 'boolean', nullable: true },
      safety_flags: { type: 'array', items: clinicalAiSafetyFlag },
      source_citations: { type: 'array', items: { type: 'object', additionalProperties: true } },
      decision_support_only: { type: 'boolean', nullable: true },
      requires_signoff: { type: 'boolean', nullable: true },
      draft: aiDraft,
    },
  },

  // ---- ClinicalAiReviewDecisionRow ---------------------------------------
  // The PATCH decide / review-decision row reused by the ~50 decide ops. LOOSE
  // — different domains spread extra columns onto the reviewed row, so we keep
  // additionalProperties:true with a small required core.
  ClinicalAiReviewDecisionRow: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'reviewer_decision'],
    properties: {
      id: { type: 'integer' },
      reviewer_decision: { type: 'string', nullable: true, enum: CLINICAL_AI_REVIEWER_DECISION },
      reviewed_by: { type: 'string', format: 'uuid', nullable: true },
      reviewed_at: { type: 'string', format: 'date-time', nullable: true },
      reviewer_note: { type: 'string', nullable: true },
    },
  },

  // =========================================================================
  // Envelope responses (success(res,data,…) wrappers).
  // =========================================================================

  // { success, message, data: ClinicalAiDraftEnvelope } — every generate/eval op.
  ClinicalAiDraftResponse: envelope('ClinicalAiDraftEnvelope'),
  // { success, message, data: ClinicalAiReviewDecisionRow } — every decide op.
  ClinicalAiReviewDecisionResponse: envelope('ClinicalAiReviewDecisionRow'),
  // { success, message, data: ClinicalAiReviewDecisionRow[] , meta } — GET lists
  // of review/decision rows. Per-domain list responses may be added later with
  // their own Row item; this is the shared loose-row list wrapper.
  ClinicalAiReviewDecisionListResponse: listEnvelope('ClinicalAiReviewDecisionRow'),

  // ---- ClinicalAiCountListResponse ---------------------------------------
  // The canonical governance/queue LIST shape across the clinical-AI control
  // surface: every list service returns `{ <namedArray>: [...rows], count }` as
  // `data` (the array KEY differs per domain — `audits`/`tasks`/`drafts`/
  // `reviews`/`sessions` — so the key is NOT pinned). LOOSE: `data` requires
  // `count` and allows the per-domain named array via additionalProperties:true.
  // Rows are governance/queue records whose enumerable bands (risk_band/decision/
  // urgency) are config/LLM-derived and lack a DB CHECK in this sub-domain, so
  // they stay loose. Strict per-domain row lists (blood-bank inventory,
  // workflow-runs, operational-alerts) get their own schemas in later passes.
  ClinicalAiCountListResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: true,
        required: ['count'],
        properties: {
          count: { type: 'integer', example: 0 },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Dual-mount helper + prefix sets (mirrors emr.mjs aliasOps shape EXACTLY).
// ---------------------------------------------------------------------------
const CONTROL_PREFIXES = ['/api/v1/clinical-ai/control', '/api/v1/admin/clinical-ai'];
const CLINICAL_PREFIXES = ['/api/v1/clinical-ai/clinical'];

/** Fan each [«METHOD /suffix», overlay] out to the given mount prefixes. */
function aliasOps(pairs, prefixes) {
  const out = {};
  for (const [methodSuffix, ov] of pairs) {
    const spaceIdx = methodSuffix.indexOf(' ');
    const method = methodSuffix.slice(0, spaceIdx);
    const suffix = methodSuffix.slice(spaceIdx + 1);
    for (const pre of prefixes) out[`${method} ${pre}${suffix}`] = ov;
  }
  return out;
}

// Authored-once op pairs. Each control pair is keyed under BOTH control
// prefixes via aliasOps(CONTROL_OPS, CONTROL_PREFIXES). Later passes append.
const CONTROL_OPS = [
  // -------------------------------------------------------------------------
  // tierA-cH-assistants (Tier A + Tier C + Tier D). All 35 ops are single-POST
  // LLM-draft generators returning the shared ClinicalAiDraftEnvelope (201). No
  // strict ops in this sub-domain — `draft` content (risk_band/HEART/ESI/etc.)
  // is LLM-prompt-internal, not DB-CHECK-backed. All → ClinicalAiDraftResponse.
  // -------------------------------------------------------------------------

  // ---- Tier A "fastest wins" assistants (tierAAssistantsRoutes.js) — 10 ----
  ['POST /lab-trend-summaries', { response: 'ClinicalAiDraftResponse' }],
  ['POST /discharge-medication-explanations', { response: 'ClinicalAiDraftResponse' }],
  ['POST /patient-faq-answers', { response: 'ClinicalAiDraftResponse' }],
  ['POST /lab-pending-reminders', { response: 'ClinicalAiDraftResponse' }],
  ['POST /front-desk-responses', { response: 'ClinicalAiDraftResponse' }],
  ['POST /audit-log-summaries', { response: 'ClinicalAiDraftResponse' }],
  ['POST /call-summaries', { response: 'ClinicalAiDraftResponse' }],
  ['POST /handwritten-note-structures', { response: 'ClinicalAiDraftResponse' }],
  ['POST /voice-to-prescription-drafts', { response: 'ClinicalAiDraftResponse' }],
  ['POST /pending-report-trackers', { response: 'ClinicalAiDraftResponse' }],

  // ---- Tier C clinical-doc & drug-safety assistants (tierCAssistantsRoutes.js) — 16 ----
  ['POST /medical-certificate-drafts', { response: 'ClinicalAiDraftResponse' }],
  ['POST /clinic-letter-drafts', { response: 'ClinicalAiDraftResponse' }],
  ['POST /clinical-note-cleanups', { response: 'ClinicalAiDraftResponse' }],
  ['POST /missing-questions-suggestions', { response: 'ClinicalAiDraftResponse' }],
  ['POST /missing-examination-suggestions', { response: 'ClinicalAiDraftResponse' }],
  ['POST /missing-tests-suggestions', { response: 'ClinicalAiDraftResponse' }],
  ['POST /order-set-suggestions', { response: 'ClinicalAiDraftResponse' }],
  ['POST /renal-dose-checks', { response: 'ClinicalAiDraftResponse' }],
  ['POST /liver-dose-checks', { response: 'ClinicalAiDraftResponse' }],
  ['POST /pregnancy-lactation-warnings', { response: 'ClinicalAiDraftResponse' }],
  ['POST /adverse-drug-event-detections', { response: 'ClinicalAiDraftResponse' }],
  ['POST /fall-risk-predictions', { response: 'ClinicalAiDraftResponse' }],
  ['POST /pressure-ulcer-risk-predictions', { response: 'ClinicalAiDraftResponse' }],
  ['POST /aki-risk-alerts', { response: 'ClinicalAiDraftResponse' }],
  ['POST /intake-output-summaries', { response: 'ClinicalAiDraftResponse' }],
  ['POST /icu-round-summaries', { response: 'ClinicalAiDraftResponse' }],

  // ---- Tier D emergency / triage assistants (tierDEmergencyRoutes.js) — 9 ----
  ['POST /emergency-triage-forms', { response: 'ClinicalAiDraftResponse' }],
  ['POST /triage-priority-suggestions', { response: 'ClinicalAiDraftResponse' }],
  ['POST /ed-red-flag-detections', { response: 'ClinicalAiDraftResponse' }],
  ['POST /emergency-visit-summaries', { response: 'ClinicalAiDraftResponse' }],
  ['POST /ambulance-handover-summaries', { response: 'ClinicalAiDraftResponse' }],
  ['POST /stroke-fast-checks', { response: 'ClinicalAiDraftResponse' }],
  ['POST /chest-pain-protocols', { response: 'ClinicalAiDraftResponse' }],
  ['POST /trauma-checklists', { response: 'ClinicalAiDraftResponse' }],
  ['POST /mlc-documentation', { response: 'ClinicalAiDraftResponse' }],

  // -------------------------------------------------------------------------
  // tierE-H-assistants (Tier E + Tier F + Tier G + Tier H). All 31 ops are
  // single-POST LLM-draft generators that funnel through `runExplainerPipeline`
  // and return `success(res, result, message, 201)` with the shared draft
  // envelope. No strict ops in this sub-domain (verified against ground-truth
  // route files + scout report r1: zero list/status/config/enum-typed
  // endpoints; every structured bit — symptom red-flag severity, ESI/CTAS,
  // FHIR validation verdict, de-id map, TAT/sentiment scores — is LLM-prompt-
  // internal inside loose `draft`, with no DB CHECK backing). Control-only
  // (no clinical-use mount). All → ClinicalAiDraftResponse.
  // -------------------------------------------------------------------------

  // ---- Tier E patient-engagement / coaching assistants (tierEPatientEngagementRoutes.js) — 13 ----
  ['POST /symptom-red-flag-checks', { response: 'ClinicalAiDraftResponse' }],
  ['POST /chronic-disease-coaching', { response: 'ClinicalAiDraftResponse' }],
  ['POST /post-discharge-checkins', { response: 'ClinicalAiDraftResponse' }],
  ['POST /post-surgery-monitoring', { response: 'ClinicalAiDraftResponse' }],
  ['POST /home-vitals-insights', { response: 'ClinicalAiDraftResponse' }],
  ['POST /diet-advice-drafts', { response: 'ClinicalAiDraftResponse' }],
  ['POST /exercise-advice-drafts', { response: 'ClinicalAiDraftResponse' }],
  ['POST /mental-health-screenings', { response: 'ClinicalAiDraftResponse' }],
  ['POST /medication-reminders', { response: 'ClinicalAiDraftResponse' }],
  ['POST /follow-up-reminders', { response: 'ClinicalAiDraftResponse' }],
  ['POST /pre-visit-forms', { response: 'ClinicalAiDraftResponse' }],
  ['POST /preventive-health-recommendations', { response: 'ClinicalAiDraftResponse' }],
  ['POST /family-health-risk-summaries', { response: 'ClinicalAiDraftResponse' }],

  // ---- Tier F interoperability / record-reconciliation assistants (tierFInteropRoutes.js) — 5 ----
  ['POST /fhir-validations', { response: 'ClinicalAiDraftResponse' }],
  ['POST /abdm-care-contexts', { response: 'ClinicalAiDraftResponse' }],
  ['POST /health-record-reconciliations', { response: 'ClinicalAiDraftResponse' }],
  ['POST /document-patient-matching', { response: 'ClinicalAiDraftResponse' }],
  ['POST /medical-record-bundles', { response: 'ClinicalAiDraftResponse' }],

  // ---- Tier G public / population-health assistants (tierGPublicHealthRoutes.js) — 5 ----
  ['POST /chronic-disease-registries', { response: 'ClinicalAiDraftResponse' }],
  ['POST /screening-gap-detections', { response: 'ClinicalAiDraftResponse' }],
  ['POST /high-risk-cohorts', { response: 'ClinicalAiDraftResponse' }],
  ['POST /public-health-reports', { response: 'ClinicalAiDraftResponse' }],
  ['POST /phi-deidentifications', { response: 'ClinicalAiDraftResponse' }],

  // ---- Tier H operational-forecasting assistants (tierHOperationalRoutes.js) — 8 ----
  ['POST /lab-tat-delay-predictions', { response: 'ClinicalAiDraftResponse' }],
  ['POST /radiology-tat-delay-predictions', { response: 'ClinicalAiDraftResponse' }],
  ['POST /ambulance-demand-forecasts', { response: 'ClinicalAiDraftResponse' }],
  ['POST /smart-queue-optimizations', { response: 'ClinicalAiDraftResponse' }],
  ['POST /tariff-optimization-insights', { response: 'ClinicalAiDraftResponse' }],
  ['POST /package-compliance-checks', { response: 'ClinicalAiDraftResponse' }],
  ['POST /patient-feedback-summaries', { response: 'ClinicalAiDraftResponse' }],
  ['POST /sentiment-analyses', { response: 'ClinicalAiDraftResponse' }],

  // -------------------------------------------------------------------------
  // core-clinical (coreClinicalRoutes.js) — 24 ops. Core clinical sentinels &
  // worklists: chart-completion auditor, clinical-task extractor, abnormal-result
  // triage, infection-control sentinel, antimicrobial stewardship, patient
  // teach-back, sepsis-bundle sentinel, consent/PHI privacy sentinel.
  //
  // Typing (per scout r2 + strictOps plan): the POST generate/evaluate/record
  // ops return the loose `{ <id>, generation_id, draft{…}, safety_flags[] }`
  // envelope → ClinicalAiDraftResponse. The PATCH decide ops return the updated
  // governance row → ClinicalAiReviewDecisionResponse. The GET lists return
  // `{ <namedArray>:[…], count }` (key varies: audits/tasks/drafts/reviews/
  // sessions) → ClinicalAiCountListResponse. NONE of these suffixes are in the
  // strictOps shortlist (which lives in the diagnostics/governance/scoreboard/KB
  // sub-routers — blood-bank inventory, outcome-scoreboard, operational-alerts,
  // workflow-runs, etc.), so every band here (risk_band/urgency_band/decision)
  // stays inside loose `draft` / the loose count-list row — no strict schema.
  // Control-only (no /clinical-ai/clinical mount for any of these).
  // -------------------------------------------------------------------------

  // ---- Chart-completion auditor ----
  ['POST /chart-completion/audits', { response: 'ClinicalAiDraftResponse' }],
  ['GET /chart-completion/audits', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /chart-completion/audits/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Clinical-task extractor ----
  ['POST /tasks/extract', { response: 'ClinicalAiDraftResponse' }],
  ['GET /tasks', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /tasks/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Abnormal-result triage worklist (no PATCH decide on this surface) ----
  ['POST /abnormal-results/triage', { response: 'ClinicalAiDraftResponse' }],
  ['GET /abnormal-results/triage', { response: 'ClinicalAiCountListResponse' }],

  // ---- Infection-control sentinel ----
  ['POST /infection-control/audits', { response: 'ClinicalAiDraftResponse' }],
  ['GET /infection-control/audits', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /infection-control/audits/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Antimicrobial stewardship assistant ----
  ['POST /antimicrobial-stewardship/reviews', { response: 'ClinicalAiDraftResponse' }],
  ['GET /antimicrobial-stewardship/reviews', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /antimicrobial-stewardship/reviews/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Patient teach-back / comprehension AI ----
  // …/answers is a record op (submit answers → updated session result blob); it
  // is NOT a decide op (no reviewer_decision) and NOT in the strict shortlist, so
  // it folds into the loose draft-result envelope.
  ['POST /teach-back/sessions', { response: 'ClinicalAiDraftResponse' }],
  ['POST /teach-back/sessions/{id}/answers', { response: 'ClinicalAiDraftResponse' }],
  ['GET /teach-back/sessions', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /teach-back/sessions/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Sepsis-bundle sentinel ----
  ['POST /sepsis-bundle/audits', { response: 'ClinicalAiDraftResponse' }],
  ['GET /sepsis-bundle/audits', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /sepsis-bundle/audits/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Consent & PHI policy (privacy) sentinel ----
  // scans = a window sweep returning a loose `{ summary{…}, audits[]/findings[] }`
  // result blob → loose draft-result envelope.
  ['POST /privacy-sentinel/scans', { response: 'ClinicalAiDraftResponse' }],
  ['GET /privacy-sentinel/audits', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /privacy-sentinel/audits/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],
];
const CLINICAL_OPS = [];

export const operations = {
  ...aliasOps(CONTROL_OPS, CONTROL_PREFIXES),
  ...aliasOps(CLINICAL_OPS, CLINICAL_PREFIXES),
};
