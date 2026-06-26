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

// Authored-once op pairs. EMPTY at T0 — later passes append.
const CONTROL_OPS = [];
const CLINICAL_OPS = [];

export const operations = {
  ...aliasOps(CONTROL_OPS, CONTROL_PREFIXES),
  ...aliasOps(CLINICAL_OPS, CLINICAL_PREFIXES),
};
