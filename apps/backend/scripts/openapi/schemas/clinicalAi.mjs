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

// ---- diagnostics-medication strict enums (T4) ---------------------------
// Blood-bank inventory rows have hard service-level allowlists (NOT LLM/config
// soft bands): bloodBankForecastService.js exports BLOOD_GROUPS / COMPONENTS and
// validateBloodGroup()/validateComponent() reject anything outside them with a
// 400 before the INSERT. Mirrored here verbatim (null-free for Spectral).
const CLINICAL_AI_BLOOD_GROUP = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];
const CLINICAL_AI_BLOOD_COMPONENT = [
  'packed_red_cells', 'whole_blood', 'platelets', 'ffp', 'cryoprecipitate',
];

// ---- facility-risk strict enums (T5) ------------------------------------
// Two deterministic registry rows (NO LLM `draft`) carry hard allowlists:
//   • clinical_ai_biomed_devices.device_type / .status — real DB CHECK
//     constraints (migration 053_biomedical_device_maintenance.sql) AND
//     re-validated in upsertBiomedDevice() (device_type → 400; status →
//     normalized to 'in_service' when out of set).
//   • clinical_ai_patient_genotypes.gene / .phenotype — NO DB CHECK, but
//     upsertPatientGenotype() hard-rejects anything outside SUPPORTED_GENES /
//     SUPPORTED_PHENOTYPES with a 400 BEFORE the INSERT (same allowlist
//     contract as bloodBank's validateBloodGroup/validateComponent).
// Mirrored here verbatim (null-free for Spectral). Every band the 8
// EVAL/LIST/DECIDE triads surface (severity / priority_band / risk_band /
// required_cleaning_level) is config/LLM-derived inside loose `draft` and
// stays plain — only these registry columns are pinned.
const CLINICAL_AI_BIOMED_DEVICE_TYPE = [
  'ventilator', 'defibrillator', 'infusion_pump', 'ecg_monitor', 'ultrasound',
  'x_ray', 'mri', 'ct_scanner', 'dialysis', 'anesthesia_machine', 'other',
];
const CLINICAL_AI_BIOMED_DEVICE_STATUS = [
  'in_service', 'out_of_service', 'retired', 'pending_inspection', 'unknown',
];
const CLINICAL_AI_PGX_GENE = [
  'CYP2D6', 'CYP2C19', 'CYP2C9', 'VKORC1', 'SLCO1B1', 'HLA_B_5701',
  'HLA_B_1502', 'TPMT', 'DPYD', 'UGT1A1', 'G6PD',
];
const CLINICAL_AI_PGX_PHENOTYPE = [
  'poor_metabolizer', 'intermediate_metabolizer', 'normal_metabolizer',
  'rapid_metabolizer', 'ultra_rapid_metabolizer', 'positive', 'negative',
  'deficient', 'unknown',
];

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

  // =========================================================================
  // STRICT — diagnostics-medication (T4). Blood-bank inventory snapshot rows
  // are pure deterministic inventory records (no LLM `draft`): fixed columns
  // with real DB-CHECK-grade enums (blood_group / component) enforced by
  // bloodBankForecastService.validateBloodGroup/validateComponent before the
  // INSERT. jsonb `metadata` → object (never string). The 21 other ops in this
  // sub-domain stay loose (POST evaluate/generate → ClinicalAiDraftResponse;
  // PATCH decide → ClinicalAiReviewDecisionResponse; GET lists → the per-domain
  // count-list ClinicalAiCountListResponse), because every band they surface
  // (risk_band/safety_band/triage_level/boarding_band/critical_band) is
  // config/LLM-derived and lacks a DB CHECK, so it lives inside loose `draft`.
  // =========================================================================

  // ---- ClinicalAiBloodBankInventoryRow -----------------------------------
  // One row of `clinical_ai_blood_bank_inventory_snapshots`, as returned by
  // upsertBloodBankInventory() RETURNING and listBloodBankInventory(). units_*
  // are coerced to JS numbers (toNumber) before serialization → integers.
  ClinicalAiBloodBankInventoryRow: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id', 'blood_group', 'component', 'units_available', 'units_committed',
      'minimum_stock_level',
    ],
    properties: {
      id: { type: 'integer' },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      blood_group: { type: 'string', enum: CLINICAL_AI_BLOOD_GROUP },
      component: { type: 'string', enum: CLINICAL_AI_BLOOD_COMPONENT },
      units_available: { type: 'integer' },
      units_committed: { type: 'integer' },
      minimum_stock_level: { type: 'integer' },
      expires_earliest: { type: 'string', format: 'date', nullable: true },
      metadata: { type: 'object', additionalProperties: true },
      updated_by: { type: 'string', format: 'uuid', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // POST /blood-bank/inventory → { success, message, data: <row | null> } (201).
  // upsert returns null when the snapshot table is absent (missing-schema
  // graceful degrade), so `data` is nullable.
  ClinicalAiBloodBankInventoryResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/ClinicalAiBloodBankInventoryRow' }],
      },
    },
  },

  // GET /blood-bank/inventory → { success, message, data: { inventory:[row], count } }.
  ClinicalAiBloodBankInventoryListResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['inventory', 'count'],
        properties: {
          inventory: {
            type: 'array',
            items: { $ref: '#/components/schemas/ClinicalAiBloodBankInventoryRow' },
          },
          count: { type: 'integer', example: 0 },
        },
      },
    },
  },

  // =========================================================================
  // STRICT — facility-risk (T5). TWO deterministic registry rows (NO LLM
  // `draft`): the biomedical-device registry and the PGx patient-genotype
  // registry. Both are pure CRUD rows whose categorical columns are pinned to
  // DB-CHECK-grade enums (biomed) or hard service allowlists rejected with 400
  // before INSERT (pgx gene/phenotype). The 24 EVAL/LIST/DECIDE triad ops in
  // this sub-domain stay loose (POST evaluate/record → ClinicalAiDraftResponse;
  // PATCH decide → ClinicalAiReviewDecisionResponse; GET lists → the per-domain
  // count-list ClinicalAiCountListResponse): every band they surface
  // (severity / priority_band / risk_band / required_cleaning_level) is
  // config/LLM-derived inside loose `draft`, so it stays plain.
  // =========================================================================

  // ---- ClinicalAiBiomedDeviceRow -----------------------------------------
  // One row of `clinical_ai_biomed_devices`, as returned by upsertBiomedDevice()
  // RETURNING and listBiomedDevices(). device_type + status carry real DB CHECK
  // constraints (migration 053); numeric usage_hours / fault_events_last_90d /
  // mean_time_between_failures_hours are coerced to JS numbers (normalizeDeviceRow)
  // before serialization. jsonb `metadata` → object (never string).
  ClinicalAiBiomedDeviceRow: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'device_code', 'device_type', 'status'],
    properties: {
      id: { type: 'integer' },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      device_code: { type: 'string' },
      device_type: { type: 'string', enum: CLINICAL_AI_BIOMED_DEVICE_TYPE },
      manufacturer: { type: 'string', nullable: true },
      model: { type: 'string', nullable: true },
      serial_number: { type: 'string', nullable: true },
      location: { type: 'string', nullable: true },
      installed_at: { type: 'string', format: 'date', nullable: true },
      warranty_expires_on: { type: 'string', format: 'date', nullable: true },
      last_preventive_maintenance_at: { type: 'string', format: 'date-time', nullable: true },
      next_scheduled_maintenance_at: { type: 'string', format: 'date-time', nullable: true },
      usage_hours: { type: 'number' },
      fault_events_last_90d: { type: 'integer' },
      mean_time_between_failures_hours: { type: 'number', nullable: true },
      status: { type: 'string', enum: CLINICAL_AI_BIOMED_DEVICE_STATUS },
      metadata: { type: 'object', additionalProperties: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // POST /biomed-devices → { success, message, data: <row | null> } (201).
  // upsert returns null when the device table is absent (missing-schema graceful
  // degrade), so `data` is nullable.
  ClinicalAiBiomedDeviceResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/ClinicalAiBiomedDeviceRow' }],
      },
    },
  },

  // GET /biomed-devices → { success, message, data: { devices:[row], count } }.
  ClinicalAiBiomedDeviceListResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['devices', 'count'],
        properties: {
          devices: {
            type: 'array',
            items: { $ref: '#/components/schemas/ClinicalAiBiomedDeviceRow' },
          },
          count: { type: 'integer', example: 0 },
        },
      },
    },
  },

  // ---- ClinicalAiPgxGenotypeRow ------------------------------------------
  // One row of `clinical_ai_patient_genotypes`, as returned by
  // upsertPatientGenotype() RETURNING and listPatientGenotypes(). gene +
  // phenotype have NO DB CHECK but are hard-validated against SUPPORTED_GENES /
  // SUPPORTED_PHENOTYPES with a 400 before the INSERT, so they are genuinely
  // enumerable. jsonb `metadata` → object (never string).
  ClinicalAiPgxGenotypeRow: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'patient_uid', 'gene', 'phenotype'],
    properties: {
      id: { type: 'integer' },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      patient_uid: { type: 'string', format: 'uuid' },
      gene: { type: 'string', enum: CLINICAL_AI_PGX_GENE },
      phenotype: { type: 'string', enum: CLINICAL_AI_PGX_PHENOTYPE },
      genotype_detail: { type: 'string', nullable: true },
      source: { type: 'string', nullable: true },
      source_report_id: { type: 'string', nullable: true },
      tested_at: { type: 'string', format: 'date', nullable: true },
      verified: { type: 'boolean' },
      metadata: { type: 'object', additionalProperties: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // POST /pgx/genotypes → { success, message, data: <row | null> } (201).
  // upsert returns null when the genotype table is absent (missing-schema
  // graceful degrade), so `data` is nullable.
  ClinicalAiPgxGenotypeResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/ClinicalAiPgxGenotypeRow' }],
      },
    },
  },

  // GET /pgx/genotypes → { success, message, data: { genotypes:[row], count } }.
  ClinicalAiPgxGenotypeListResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['genotypes', 'count'],
        properties: {
          genotypes: {
            type: 'array',
            items: { $ref: '#/components/schemas/ClinicalAiPgxGenotypeRow' },
          },
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

  // -------------------------------------------------------------------------
  // diagnostics-medication (diagnosticsMedicationRoutes.js) — 23 ops. Lab
  // autoverification, pediatric dosing, staff burnout, ED triage/boarding, ICU
  // ventilator bundle, blood-bank forecast + inventory, obstetric risk.
  //
  // Typing (per scout r2 + strictOps plan): each domain is the standard
  // generate/evaluate (POST → loose draft envelope, ClinicalAiDraftResponse,
  // 201) + list (GET `{ <rows[]>, count }` → ClinicalAiCountListResponse) +
  // decide (PATCH `{ decision, note? }` → updated review row,
  // ClinicalAiReviewDecisionResponse) triad. Every band these surface
  // (critical_band / safety_band / risk_band / triage_level / boarding_band /
  // predicted_disposition) is config/LLM-derived inside loose `draft` — no DB
  // CHECK — so they stay loose. The ONE STRICT pair is blood-bank inventory
  // (POST upsert + GET list): pure deterministic inventory rows with the real
  // service allowlists (blood_group / component), no LLM draft → the
  // ClinicalAiBloodBankInventory* schemas authored above. Control-only.
  // -------------------------------------------------------------------------

  // ---- Lab autoverification / delta check ----
  ['POST /lab-autoverifications/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /lab-autoverifications', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /lab-autoverifications/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Pediatric dosing safety ----
  ['POST /pediatric-dose-checks/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /pediatric-dose-checks', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /pediatric-dose-checks/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Staff burnout / workload risk ----
  ['POST /staff-burnout/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /staff-burnout/reviews', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /staff-burnout/reviews/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- ED triage + boarding predictor ----
  ['POST /ed-triage/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /ed-triage/predictions', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /ed-triage/predictions/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- ICU ventilator / sedation bundle reviewer ----
  ['POST /icu-ventilator-bundle/audits', { response: 'ClinicalAiDraftResponse' }],
  ['GET /icu-ventilator-bundle/audits', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /icu-ventilator-bundle/audits/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Blood bank — STRICT inventory (upsert + list) + loose forecast triad ----
  ['POST /blood-bank/inventory', { response: 'ClinicalAiBloodBankInventoryResponse' }],
  ['GET /blood-bank/inventory', { response: 'ClinicalAiBloodBankInventoryListResponse' }],
  ['POST /blood-bank/forecast', { response: 'ClinicalAiDraftResponse' }],
  ['GET /blood-bank/forecasts', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /blood-bank/forecasts/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Pregnancy / obstetric risk assistant ----
  ['POST /obstetric-risk/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /obstetric-risk/assessments', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /obstetric-risk/assessments/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // -------------------------------------------------------------------------
  // facility-risk (facilityRiskRoutes.js) — 28 ops. Eight independent
  // EVAL/LIST/DECIDE triads (housekeeping bed-turnover, biomed-device
  // maintenance, cybersecurity anomaly, pharmacogenomics advisory, radiology
  // report-QA, radiology worklist, OT-block scheduling, inventory intelligence)
  // PLUS two deterministic registry CRUD pairs (biomed-device registry, PGx
  // patient-genotype registry).
  //
  // Typing (per scout r3 + ground-truth route file): each triad is the standard
  // generate/record/evaluate (POST → loose draft envelope, ClinicalAiDraftResponse,
  // 201) + list (GET `{ <rows[]>, count }` → ClinicalAiCountListResponse) +
  // decide (PATCH `{ decision, note? }` → updated review row,
  // ClinicalAiReviewDecisionResponse). Every band these surface (severity /
  // priority_band / risk_band / required_cleaning_level / advisory_category) is
  // config/LLM-derived inside loose `draft`, so they stay loose — even where a
  // prediction-table column (e.g. biomed-maintenance risk_band) carries a DB
  // CHECK, the LIST/DECIDE governance rows fold into the shared loose family
  // (matches the T4 prediction-triad precedent). The STRICT ops are the two
  // registry pairs: pure deterministic rows with real allowlists (biomed
  // device_type/status = DB CHECK; pgx gene/phenotype = service-validated → 400)
  // → the ClinicalAiBiomedDevice* / ClinicalAiPgxGenotype* schemas above.
  // Control-only (no /clinical-ai/clinical mount for any of these).
  // -------------------------------------------------------------------------

  // ---- Housekeeping / bed turnover optimizer ----
  ['POST /bed-turnover/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /bed-turnover/predictions', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /bed-turnover/predictions/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Biomed device maintenance — STRICT registry (upsert + list) + loose predict triad ----
  ['POST /biomed-devices', { response: 'ClinicalAiBiomedDeviceResponse' }],
  ['GET /biomed-devices', { response: 'ClinicalAiBiomedDeviceListResponse' }],
  ['POST /biomed-devices/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /biomed-devices/predictions', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /biomed-devices/predictions/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Cybersecurity anomaly detector ----
  ['POST /security-anomalies/record', { response: 'ClinicalAiDraftResponse' }],
  ['GET /security-anomalies', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /security-anomalies/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Pharmacogenomics — STRICT genotype registry (upsert + list) + loose advisory triad ----
  ['POST /pgx/genotypes', { response: 'ClinicalAiPgxGenotypeResponse' }],
  ['GET /pgx/genotypes', { response: 'ClinicalAiPgxGenotypeListResponse' }],
  ['POST /pgx/advisories/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /pgx/advisories', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /pgx/advisories/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Radiology Report QA / discrepancy assistant ----
  ['POST /radiology/report-qa/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /radiology/report-qa', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /radiology/report-qa/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Radiology worklist prioritizer ----
  ['POST /radiology/worklist/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /radiology/worklist', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /radiology/worklist/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- OT block scheduling optimizer ----
  ['POST /ot/blocks/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /ot/blocks', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /ot/blocks/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Inventory intelligence (non-pharmacy) ----
  ['POST /inventory/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /inventory/alerts', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /inventory/alerts/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // -------------------------------------------------------------------------
  // care-operations (careOperationsRoutes.js) — 24 ops. Six independent
  // care/ops sub-modules: staff roster optimizer + roster leave-forecast,
  // virtual ward (enrollments + escalations), imaging AI (DICOM register +
  // inference ingest + review), nursing-ambient documentation, and the
  // consent-aware family-update generator.
  //
  // Typing (per scout r3 + ground-truth route file + service return shapes):
  // every op folds into the shared loose family — NONE are in the strictOps
  // shortlist (which lives in scoreboard/ROI/KB/operational-alerts/governance,
  // not here):
  //   • POST generate/evaluate/record/import/sent → loose draft / governance /
  //     decision envelope → ClinicalAiDraftResponse (the roster suggestion,
  //     leave-forecast governance blob, imaging inference EVAL, nursing-ambient
  //     STT session, family-update draft all wrap a typed outer envelope around
  //     an LLM/rule/solver-generated inner blob with variable keys). The
  //     deterministic registry-ish POSTs (imaging study register, virtual-ward
  //     enroll, pacs-import) ALSO fold here: their rows carry NO DB-CHECK-grade
  //     categorical column in the strict shortlist — pathway/modality/severity
  //     are free-ish or config-derived, not service-allowlisted like blood-bank
  //     group/component or biomed device_type — so per the plan they stay in
  //     the shared loose envelope rather than getting a bespoke strict schema.
  //   • PATCH/POST decide + publish/discard/acknowledge/resolve/sent → single
  //     updated governance/decision row → ClinicalAiReviewDecisionResponse
  //     (loose row: id + reviewer_decision/status + reviewer metadata, with
  //     additionalProperties:true for the per-module extra columns).
  //   • GET lists → `{ <plural>: [...rows], count }` (runs / enrollments /
  //     escalations / findings / sessions / updates) → ClinicalAiCountListResponse.
  //   • GET /roster/leave-forecast → a SINGLE governance forecast object (not a
  //     list) → ClinicalAiDraftResponse. GET /roster/leave-forecast/{id}/audit →
  //     a BARE array of audit rows as `data` (service returns rows.map(...)) →
  //     ClinicalAiReviewDecisionListResponse (the listEnvelope shape: data is an
  //     array, not a `{ <named>, count }` object).
  // Control-only (no /clinical-ai/clinical mount for any of these). No strict
  // schema authored — all six sub-modules reuse the shared loose families.
  // -------------------------------------------------------------------------

  // ---- Staff roster optimizer ----
  ['POST /roster', { response: 'ClinicalAiDraftResponse' }],
  ['GET /roster', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /roster/{id}/publish', { response: 'ClinicalAiReviewDecisionResponse' }],
  ['PATCH /roster/{id}/discard', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Roster leave forecast ----
  // POST/GET return the governance forecast blob (single object, loose draft
  // family); /{id}/review returns the reviewed governance row; /{id}/audit
  // returns a bare audit-row array.
  ['POST /roster/leave-forecast', { response: 'ClinicalAiDraftResponse' }],
  ['GET /roster/leave-forecast', { response: 'ClinicalAiDraftResponse' }],
  ['PATCH /roster/leave-forecast/{id}/review', { response: 'ClinicalAiReviewDecisionResponse' }],
  ['GET /roster/leave-forecast/{id}/audit', { response: 'ClinicalAiReviewDecisionListResponse' }],

  // ---- Virtual ward — enrollments + escalations ----
  ['POST /virtual-ward/enrollments', { response: 'ClinicalAiDraftResponse' }],
  ['GET /virtual-ward/enrollments', { response: 'ClinicalAiCountListResponse' }],
  ['GET /virtual-ward/escalations', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /virtual-ward/escalations/{id}/acknowledge', { response: 'ClinicalAiReviewDecisionResponse' }],
  ['PATCH /virtual-ward/escalations/{id}/resolve', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Imaging AI — register + inference ingest + review ----
  // /pacs/status returns a small adapter-status object (folds into the loose
  // draft envelope — no strict shortlist entry); /studies + /studies/import-pacs
  // + /inference are generate/record ops → ClinicalAiDraftResponse.
  ['GET /imaging/pacs/status', { response: 'ClinicalAiDraftResponse' }],
  ['POST /imaging/studies', { response: 'ClinicalAiDraftResponse' }],
  ['POST /imaging/studies/import-pacs', { response: 'ClinicalAiDraftResponse' }],
  ['POST /imaging/inference', { response: 'ClinicalAiDraftResponse' }],
  ['GET /imaging/findings', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /imaging/findings/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Nursing ambient documentation ----
  ['POST /nursing-ambient/sessions', { response: 'ClinicalAiDraftResponse' }],
  ['GET /nursing-ambient/sessions', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /nursing-ambient/sessions/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Consent-aware family update generator ----
  ['POST /family-updates', { response: 'ClinicalAiDraftResponse' }],
  ['GET /family-updates', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /family-updates/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],
  ['POST /family-updates/{id}/sent', { response: 'ClinicalAiReviewDecisionResponse' }],
];
const CLINICAL_OPS = [];

export const operations = {
  ...aliasOps(CONTROL_OPS, CONTROL_PREFIXES),
  ...aliasOps(CLINICAL_OPS, CLINICAL_PREFIXES),
};
