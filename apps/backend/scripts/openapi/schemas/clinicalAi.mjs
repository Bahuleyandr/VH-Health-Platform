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

// ---- operational-alerts strict enums (T7) -------------------------------
// `clinical_ai_operational_alerts` carries three real DB CHECK constraints
// (migration 315_operational_alerts.sql) — verbatim, null-free for Spectral:
//   • severity          CHECK IN ('low','moderate','high','critical','unknown')
//   • system_status     CHECK IN ('active','resolved','superseded')
//   • reviewer_decision CHECK IN ('pending','accepted','deferred','rejected','edited')
// The LIST row can surface any reviewer_decision (default 'pending'); the POST
// /decision endpoint only ACCEPTS the four FINAL_DECISIONS
// ('accepted','deferred','rejected','edited') — anything else → 400 before the
// UPDATE — but the persisted column (and thus the returned row) uses the full
// 5-value CHECK set, so the decision-row schema pins the same 5 values. Note
// `alert_category` has NO CHECK (default 'unknown') → stays a plain string.
const CLINICAL_AI_OPALERT_SEVERITY = ['low', 'moderate', 'high', 'critical', 'unknown'];
const CLINICAL_AI_OPALERT_SYSTEM_STATUS = ['active', 'resolved', 'superseded'];
const CLINICAL_AI_OPALERT_REVIEWER_DECISION = [
  'pending', 'accepted', 'deferred', 'rejected', 'edited',
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

  ClinicalAiCommandCenterCensusLosSummary: {
    type: 'object',
    additionalProperties: false,
    required: [
      'ward',
      'forecast_window_hours',
      'admitted_count',
      'likely_discharges_24h',
      'likely_discharges_48h',
    ],
    properties: {
      ward: { type: 'string' },
      forecast_window_hours: { type: 'integer' },
      admitted_count: { type: 'integer' },
      likely_discharges_24h: { type: 'integer' },
      likely_discharges_48h: { type: 'integer' },
    },
  },

  ClinicalAiCommandCenterCensusLosPatient: {
    type: 'object',
    additionalProperties: false,
    required: [
      'admission_id',
      'patient_uid',
      'ward',
      'bed_number',
      'likely_discharge_24h',
      'likely_discharge_48h',
      'remaining_hours_estimate',
    ],
    properties: {
      admission_id: { type: 'integer', nullable: true },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      ward: { type: 'string', nullable: true },
      bed_number: { type: 'string', nullable: true },
      likely_discharge_24h: { type: 'boolean' },
      likely_discharge_48h: { type: 'boolean' },
      remaining_hours_estimate: { type: 'number', nullable: true },
    },
  },

  ClinicalAiCommandCenterCensusLosBridge: {
    type: 'object',
    additionalProperties: false,
    required: [
      'settings_key',
      'source_modules',
      'governance_owner_role',
      'freshness_threshold_minutes',
      'hide_stale_forecasts',
      'stale_forecasts_hidden_locked',
      'decision_support_only',
      'review_required',
      'visible',
      'hidden',
      'hidden_reason',
      'latest_forecast_id',
      'generated_at',
      'stored_at',
      'age_minutes',
      'confidence_band',
      'summary',
      'patients',
      'recommended_actions',
    ],
    properties: {
      settings_key: { type: 'string', example: 'nl8_census_los' },
      source_modules: { type: 'array', items: { type: 'string' } },
      governance_owner_role: { type: 'string', example: 'BED_MANAGER' },
      freshness_threshold_minutes: { type: 'integer', example: 120 },
      hide_stale_forecasts: { type: 'boolean', example: true },
      stale_forecasts_hidden_locked: { type: 'boolean', example: true },
      decision_support_only: { type: 'boolean', example: true },
      review_required: { type: 'boolean', example: true },
      visible: { type: 'boolean' },
      hidden: { type: 'boolean' },
      hidden_reason: {
        type: 'string',
        nullable: true,
        enum: ['stale_forecast', 'missing_forecast'],
      },
      latest_forecast_id: { type: 'integer', nullable: true },
      generated_at: { type: 'string', format: 'date-time', nullable: true },
      stored_at: { type: 'string', format: 'date-time', nullable: true },
      age_minutes: { type: 'integer', nullable: true },
      confidence_band: { type: 'string' },
      summary: {
        nullable: true,
        oneOf: [
          { $ref: '#/components/schemas/ClinicalAiCommandCenterCensusLosSummary' },
        ],
      },
      patients: {
        type: 'array',
        items: { $ref: '#/components/schemas/ClinicalAiCommandCenterCensusLosPatient' },
      },
      recommended_actions: { type: 'array', items: { type: 'string' } },
    },
  },

  ClinicalAiCommandCenterSnapshotListData: {
    type: 'object',
    additionalProperties: true,
    required: ['snapshots', 'count', 'census_los'],
    properties: {
      snapshots: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
      count: { type: 'integer', example: 0 },
      census_los: { $ref: '#/components/schemas/ClinicalAiCommandCenterCensusLosBridge' },
    },
  },

  ClinicalAiCommandCenterSnapshotListResponse: envelope('ClinicalAiCommandCenterSnapshotListData'),

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

  // =========================================================================
  // STRICT — operational-alerts (T7). `clinical_ai_operational_alerts` is a
  // deterministic forecast-alert stream (rules-authoritative severity, NO LLM
  // `draft`): the LIST returns the full fixed 30-column row, the POST /decision
  // returns the reviewed 5-column projection, and the run-sweep returns a fixed
  // count summary. The three categorical columns (severity / system_status /
  // reviewer_decision) carry real DB CHECK constraints (migration 315) and are
  // pinned to null-free enums. jsonb columns serialize to objects/arrays (never
  // strings): metrics/metadata → object; signals/recommended_actions/
  // source_citations/safety_flags → array. The free-text categorical
  // `alert_category` has no CHECK (default 'unknown') so it stays a plain string.
  // =========================================================================

  // ---- ClinicalAiOperationalAlertRow -------------------------------------
  // One row of `clinical_ai_operational_alerts`, as returned by the explicit
  // 30-column SELECT in listOperationalAlerts(). id is SERIAL → integer.
  ClinicalAiOperationalAlertRow: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id', 'module_key', 'domain', 'scope_key', 'alert_category', 'severity',
      'system_status', 'reviewer_decision',
    ],
    properties: {
      id: { type: 'integer' },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      module_key: { type: 'string' },
      domain: { type: 'string' },
      owner_role: { type: 'string', nullable: true },
      scope_key: { type: 'string' },
      scope_label: { type: 'string', nullable: true },
      horizon: { type: 'string', nullable: true },
      predicted_for: { type: 'string', format: 'date-time', nullable: true },
      alert_category: { type: 'string' },
      severity: { type: 'string', enum: CLINICAL_AI_OPALERT_SEVERITY },
      metrics: { type: 'object', additionalProperties: true },
      signals: { type: 'array', items: { type: 'object', additionalProperties: true } },
      summary: { type: 'string', nullable: true },
      recommended_actions: { type: 'array', items: { type: 'object', additionalProperties: true } },
      source_citations: { type: 'array', items: { type: 'object', additionalProperties: true } },
      safety_flags: { type: 'array', items: clinicalAiSafetyFlag },
      system_status: { type: 'string', enum: CLINICAL_AI_OPALERT_SYSTEM_STATUS },
      reviewer_decision: { type: 'string', enum: CLINICAL_AI_OPALERT_REVIEWER_DECISION },
      reviewed_by: { type: 'string', format: 'uuid', nullable: true },
      reviewed_at: { type: 'string', format: 'date-time', nullable: true },
      reviewer_note: { type: 'string', nullable: true },
      first_seen_at: { type: 'string', format: 'date-time', nullable: true },
      last_evaluated_at: { type: 'string', format: 'date-time', nullable: true },
      resolved_at: { type: 'string', format: 'date-time', nullable: true },
      resolved_reason: { type: 'string', nullable: true },
      notified_at: { type: 'string', format: 'date-time', nullable: true },
      metadata: { type: 'object', additionalProperties: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // GET /operational-alerts → { success, message, data: { alerts:[row], count } }.
  ClinicalAiOperationalAlertListResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['alerts', 'count'],
        properties: {
          alerts: {
            type: 'array',
            items: { $ref: '#/components/schemas/ClinicalAiOperationalAlertRow' },
          },
          count: { type: 'integer', example: 0 },
        },
      },
    },
  },

  // ---- ClinicalAiOperationalAlertDecisionRow -----------------------------
  // POST /operational-alerts/{id}/decision RETURNING projection — the five
  // reviewed columns. reviewer_decision uses the full DB CHECK set (the POST
  // only writes one of the four FINAL_DECISIONS, but the column/CHECK is 5-way).
  ClinicalAiOperationalAlertDecisionRow: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'reviewer_decision'],
    properties: {
      id: { type: 'integer' },
      reviewer_decision: { type: 'string', enum: CLINICAL_AI_OPALERT_REVIEWER_DECISION },
      reviewed_by: { type: 'string', format: 'uuid', nullable: true },
      reviewed_at: { type: 'string', format: 'date-time', nullable: true },
      reviewer_note: { type: 'string', nullable: true },
    },
  },

  // POST /operational-alerts/{id}/decision → { success, message, data: row }.
  ClinicalAiOperationalAlertDecisionResponse: envelope('ClinicalAiOperationalAlertDecisionRow'),

  // POST /operational-alerts/run-sweep → { success, message, data: summary }.
  // runSweep returns a fixed count summary: { evaluated, raised, resolved,
  // errors:[{ module_key, error }] }. Deterministic — no draft.
  ClinicalAiOperationalAlertSweepResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['evaluated', 'raised', 'resolved', 'errors'],
        properties: {
          evaluated: { type: 'integer', example: 0 },
          raised: { type: 'integer', example: 0 },
          resolved: { type: 'integer', example: 0 },
          errors: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['module_key'],
              properties: {
                module_key: { type: 'string' },
                error: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
    },
  },

  // POST /coding-batch/run-sweep → { success, message, data: summary }.
  // runCodingSuggestionBatch returns a fixed PHI-free summary: counts, the
  // per-admission skip reasons, and why the run stopped early (if it did).
  ClinicalAiCodingBatchSweepResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['module_key', 'source', 'candidates', 'suggested', 'review_items', 'skipped'],
        properties: {
          module_key: { type: 'string', example: 'clinical_coding_assist' },
          source: { type: 'string', enum: ['scheduled', 'admin'] },
          tenant_id: { type: 'string', format: 'uuid' },
          candidates: { type: 'integer', example: 0 },
          suggested: { type: 'integer', example: 0 },
          review_items: { type: 'integer', example: 0 },
          skipped: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['admission_id', 'reason'],
              properties: {
                admission_id: { type: 'integer' },
                reason: { type: 'string' },
              },
            },
          },
          stopped_reason: { type: 'string', nullable: true },
        },
      },
    },
  },

  // =========================================================================
  // STRICT — discharge-compose workflow runs (T7). The three discharge-compose
  // endpoints that surface REAL `clinical_ai_workflow_runs` table rows get a
  // strict row schema: GET (list) → { runs:[row], count }, GET /{runId} →
  // { run, children:[row], child_count }, POST /{runId}/fail → the trivial
  // { status:'failed', runId, reason }. The POST (compose) and POST /resume
  // endpoints return polymorphic orchestration-result BLOBS (the compose graph
  // result / resumeWorkflow outcome with variable keys), NOT table rows, so they
  // fold into the loose ClinicalAiDraftResponse family. `status` and
  // `pause_reason` are plain VARCHARs with NO DB CHECK (migration 109 documents
  // the value sets only in a comment) — so they stay plain strings, NOT enums.
  // jsonb columns (state/result/metadata → object; checkpoints → array)
  // serialize to objects/arrays. The schema is the UNION of the three column
  // projections (list / getRun-full / listChildren) with additionalProperties
  // false; each projection is a subset, so only the always-present core is
  // required and the rest are optional.
  // =========================================================================

  // ---- ClinicalAiWorkflowRunRow ------------------------------------------
  ClinicalAiWorkflowRunRow: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'workflow_key', 'status'],
    properties: {
      id: { type: 'integer' },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      workflow_key: { type: 'string' },
      module_key: { type: 'string', nullable: true },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      admission_id: { type: 'integer', nullable: true },
      status: { type: 'string' },
      current_node: { type: 'string', nullable: true },
      pause_reason: { type: 'string', nullable: true },
      state: { type: 'object', additionalProperties: true },
      result: { type: 'object', additionalProperties: true, nullable: true },
      error_node: { type: 'string', nullable: true },
      error_message: { type: 'string', nullable: true },
      checkpoints: { type: 'array', items: { type: 'object', additionalProperties: true } },
      metadata: { type: 'object', additionalProperties: true },
      started_by: { type: 'string', format: 'uuid', nullable: true },
      parent_run_id: { type: 'integer', nullable: true },
      parent_node: { type: 'string', nullable: true },
      started_at: { type: 'string', format: 'date-time', nullable: true },
      paused_at: { type: 'string', format: 'date-time', nullable: true },
      completed_at: { type: 'string', format: 'date-time', nullable: true },
      failed_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // GET /discharge-compose → { success, message, data: { runs:[row], count } }.
  ClinicalAiWorkflowRunListResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['runs', 'count'],
        properties: {
          runs: {
            type: 'array',
            items: { $ref: '#/components/schemas/ClinicalAiWorkflowRunRow' },
          },
          count: { type: 'integer', example: 0 },
        },
      },
    },
  },

  // GET /discharge-compose/{runId} → { success, message,
  //   data: { run, children:[row], child_count } }.
  ClinicalAiWorkflowRunDetailResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['run', 'children', 'child_count'],
        properties: {
          run: { $ref: '#/components/schemas/ClinicalAiWorkflowRunRow' },
          children: {
            type: 'array',
            items: { $ref: '#/components/schemas/ClinicalAiWorkflowRunRow' },
          },
          child_count: { type: 'integer', example: 0 },
        },
      },
    },
  },

  // POST /discharge-compose/{runId}/fail → { success, message,
  //   data: { status:'failed', runId, reason } }.
  ClinicalAiWorkflowRunFailResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'runId', 'reason'],
        properties: {
          status: { type: 'string', example: 'failed' },
          runId: { type: 'integer' },
          reason: { type: 'string' },
        },
      },
    },
  },

  // =========================================================================
  // STRICT — governance (T8). Three of the 46 governance ops surface REAL
  // fixed-column table rows from explicit projection SELECTs (verified against
  // the route handlers + service queries): GET /audit, GET /generations, and
  // GET /safety-flags. Each gets a strict Row + a strict count-list response.
  //
  // The OTHER 43 governance ops return computed/merged config objects (modules /
  // tenant-modules / guardrails / status / governance-report / packs / signoffs)
  // or shared `{ <named>, count }` list blobs whose enumerable values are
  // config/heuristic/jsonb-derived with NO DB CHECK — so they fold into the
  // shared loose families (ClinicalAiCountListResponse for the `{<named>,count}`
  // lists; the new ClinicalAiGovernanceObjectResponse for the single-object /
  // report / pack returns). Pinned-enum discipline: `clinical_ai_generations`
  // and `audit_logs` have NO DB CHECK on status/task_type/action — plain
  // strings. `generation_mode`/`provider_status`/`fallback_reason`/
  // `readiness_reason` are `COALESCE(metadata->>'…', CASE …)` projections: the
  // CASE branch is closed but the jsonb override can be any string, so they stay
  // plain (nullable) strings, NOT enums. `safety-flags.severity` is a
  // jsonb-extracted (`flag->>'severity'`) value — could be any string — so it
  // too stays a plain nullable string. jsonb columns serialize to objects/arrays
  // (never strings): metadata → object; safety_flags → array.
  // =========================================================================

  // ---- ClinicalAiGovernanceObjectResponse --------------------------------
  // The shared LOOSE single-object governance response. `data` is a typed-
  // envelope-wrapped opaque object (additionalProperties:true, no required
  // keys) covering every non-list governance return: runtime status, single
  // module/tenant-module/guardrail/prompt/review/approval/break-glass/
  // experiment/canary/pilot-signoff rows (incl. the 202 approval_required
  // two-shape), the governance-report + readiness/pilot evidence packs, the
  // self-healing status/run + corpus health/reindex/test-query blobs, and the
  // usage / safety-review summaries. Bands here (risk, severity, decision,
  // pilot_stage, generation_mode) are config/heuristic/jsonb-derived with no DB
  // CHECK, so the object stays loose rather than per-field-pinned.
  ClinicalAiGovernanceObjectResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: { type: 'object', additionalProperties: true },
    },
  },

  // ---- ClinicalAiAuditLogRow ---------------------------------------------
  // One row of `audit_logs` as projected by getClinicalAiAuditRows() — the
  // explicit 10-column SELECT (id, uid, role, action, resource, resource_id,
  // metadata, ip_address, user_agent, created_at). `action`/`resource` have NO
  // DB CHECK (free VARCHAR) → plain strings. jsonb `metadata` → object.
  ClinicalAiAuditLogRow: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'action', 'resource'],
    properties: {
      id: { type: 'integer' },
      uid: { type: 'string', format: 'uuid', nullable: true },
      role: { type: 'string', nullable: true },
      action: { type: 'string' },
      resource: { type: 'string' },
      resource_id: { type: 'string', nullable: true },
      metadata: { type: 'object', additionalProperties: true, nullable: true },
      ip_address: { type: 'string', nullable: true },
      user_agent: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // GET /audit → { success, message, data: { logs:[row], count } }.
  ClinicalAiAuditLogListResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['logs', 'count'],
        properties: {
          logs: {
            type: 'array',
            items: { $ref: '#/components/schemas/ClinicalAiAuditLogRow' },
          },
          count: { type: 'integer', example: 0 },
        },
      },
    },
  },

  // ---- ClinicalAiGenerationRow -------------------------------------------
  // One row of the GET /generations explicit projection over
  // `clinical_ai_generations` LEFT JOIN users (verified against the route
  // SELECT). `status`/`task_type` have NO DB CHECK → plain strings.
  // `generation_mode`/`fallback_reason`/`readiness_reason`/`provider_status`
  // are `COALESCE(metadata->>'…', CASE …)` projections (jsonb override can be
  // any string) → plain nullable strings, NOT enums. jsonb `safety_flags` →
  // array; `metadata` → object. token/cost/latency ints are coerced numbers.
  ClinicalAiGenerationRow: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'task_type', 'status'],
    properties: {
      id: { type: 'integer' },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      patient_name: { type: 'string', nullable: true },
      admission_id: { type: 'integer', nullable: true },
      task_type: { type: 'string' },
      module_key: { type: 'string', nullable: true },
      provider: { type: 'string', nullable: true },
      model: { type: 'string', nullable: true },
      prompt_version: { type: 'string', nullable: true },
      source_hash: { type: 'string', nullable: true },
      status: { type: 'string' },
      used_ai: { type: 'boolean', nullable: true },
      safety_flags: { type: 'array', items: clinicalAiSafetyFlag },
      generated_by: { type: 'string', format: 'uuid', nullable: true },
      reviewed_by: { type: 'string', format: 'uuid', nullable: true },
      signed_note_id: { type: 'integer', nullable: true },
      prompt_tokens: { type: 'integer', nullable: true },
      completion_tokens: { type: 'integer', nullable: true },
      total_tokens: { type: 'integer', nullable: true },
      estimated_cost_minor: { type: 'integer', nullable: true },
      latency_ms: { type: 'integer', nullable: true },
      provider_request_id: { type: 'string', nullable: true },
      finish_reason: { type: 'string', nullable: true },
      generation_mode: { type: 'string', nullable: true },
      fallback_reason: { type: 'string', nullable: true },
      readiness_reason: { type: 'string', nullable: true },
      provider_status: { type: 'string', nullable: true },
      metadata: { type: 'object', additionalProperties: true, nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // GET /generations → { success, message, data: { generations:[row], count } }.
  ClinicalAiGenerationListResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['generations', 'count'],
        properties: {
          generations: {
            type: 'array',
            items: { $ref: '#/components/schemas/ClinicalAiGenerationRow' },
          },
          count: { type: 'integer', example: 0 },
        },
      },
    },
  },

  // ---- ClinicalAiSafetyFlagRow -------------------------------------------
  // One row of the GET /safety-flags lateral-join projection (verified against
  // the route SELECT): the parent generation columns + the three
  // jsonb-extracted flag fields (severity/code/message). `severity` is
  // `flag->>'severity'` (any string, nullable) → plain nullable string, NOT an
  // enum (the route's ORDER BY CASE only RANKS the known bands; it does not
  // constrain the value). `status` has no DB CHECK → plain string.
  ClinicalAiSafetyFlagRow: {
    type: 'object',
    additionalProperties: false,
    required: ['generation_id'],
    properties: {
      generation_id: { type: 'integer' },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      patient_name: { type: 'string', nullable: true },
      admission_id: { type: 'integer', nullable: true },
      task_type: { type: 'string', nullable: true },
      module_key: { type: 'string', nullable: true },
      status: { type: 'string', nullable: true },
      severity: { type: 'string', nullable: true },
      code: { type: 'string', nullable: true },
      message: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // GET /safety-flags → { success, message, data: { flags:[row], count } }.
  ClinicalAiSafetyFlagListResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['flags', 'count'],
        properties: {
          flags: {
            type: 'array',
            items: { $ref: '#/components/schemas/ClinicalAiSafetyFlagRow' },
          },
          count: { type: 'integer', example: 0 },
        },
      },
    },
  },

  // =========================================================================
  // STRICT — knowledge-base (T9). The RAG knowledge layer is pure deterministic
  // CRUD over real fixed-column tables (knowledge_bases / knowledge_documents /
  // knowledge_access_policies — migrations 113 + 311) — NO LLM `draft`. Every
  // categorical column is pinned to its REAL DB CHECK constraint (verified in
  // 113_knowledge_base_foundation.sql + 311_knowledge_curation.sql, AND
  // re-validated in the services' normalize*() guards which 400 before INSERT):
  //   • kb_type                  CHECK 8-value set (knowledge_bases)
  //   • status                   CHECK ('active','archived')
  //   • source_type              CHECK ('upload','url','inline_text','imported')
  //   • processing_status        CHECK 7-value set (knowledge_documents)
  //   • prompt_injection_verdict CHECK NULL OR ('pass','flag','block') → nullable
  //   • curation_status          CHECK ('pending','approved','rejected')
  //   • permission               CHECK ('read','write','manage')
  // `role` is a plain VARCHAR(60) with NO CHECK (the service uppercases free
  // input) → plain string. jsonb columns (metadata / prompt_injection_metadata)
  // serialize to objects (never strings). file_size_bytes is BIGINT but the
  // service inserts a JS number / Buffer.byteLength → integer. The two
  // service-blob ops (POST /retrieve, GET /retrieval-logs) carry NO fixed-column
  // table row (retrieve = `{ results[], source, query_hash }` where `source` is
  // a soft non-CHECK string; retrieval-logs = `{ logs, count }`) so they fold
  // into the shared loose families. Control-only.
  // =========================================================================

  // ---- Knowledge-base enums (null-free for Spectral; verified DB CHECKs) ----
  // Declared inline here (not at module top) to keep the T9 strict block
  // self-contained; the consts above are scoped to their own sub-domains.

  // ---- ClinicalAiKnowledgeBaseRow ----------------------------------------
  // One row of `knowledge_bases`. create/update/archive/unarchive return the
  // base column projection; get/list additionally surface the computed
  // `document_count` (and get also `chunk_count`) sub-selects — so those two
  // are optional, not required.
  ClinicalAiKnowledgeBaseRow: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'name', 'kb_type', 'status'],
    properties: {
      id: { type: 'integer' },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      name: { type: 'string' },
      description: { type: 'string', nullable: true },
      kb_type: {
        type: 'string',
        enum: [
          'general', 'sop', 'antibiotic_policy', 'patient_education',
          'clinical_guideline', 'formulary', 'safety_alert', 'training',
        ],
      },
      status: { type: 'string', enum: ['active', 'archived'] },
      created_by: { type: 'string', format: 'uuid', nullable: true },
      metadata: { type: 'object', additionalProperties: true },
      document_count: { type: 'integer' },
      chunk_count: { type: 'integer' },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // POST /knowledge-bases (201) + GET|PATCH /knowledge-bases/{id} +
  // PATCH .../archive + .../unarchive → { success, message, data: row }.
  ClinicalAiKnowledgeBaseResponse: envelope('ClinicalAiKnowledgeBaseRow'),

  // GET /knowledge-bases → { success, message,
  //   data: { knowledge_bases:[row], count } }.
  ClinicalAiKnowledgeBaseListResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['knowledge_bases', 'count'],
        properties: {
          knowledge_bases: {
            type: 'array',
            items: { $ref: '#/components/schemas/ClinicalAiKnowledgeBaseRow' },
          },
          count: { type: 'integer', example: 0 },
        },
      },
    },
  },

  // ---- ClinicalAiKnowledgeAccessPolicyRow --------------------------------
  // One row of `knowledge_access_policies`. listAccessPolicies + grantAccess
  // RETURNING surface the full column projection; `role` has NO DB CHECK
  // (uppercased free input) → plain string.
  ClinicalAiKnowledgeAccessPolicyRow: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'knowledge_base_id', 'role', 'permission'],
    properties: {
      id: { type: 'integer' },
      knowledge_base_id: { type: 'integer' },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      role: { type: 'string' },
      permission: { type: 'string', enum: ['read', 'write', 'manage'] },
      granted_by: { type: 'string', format: 'uuid', nullable: true },
      granted_at: { type: 'string', format: 'date-time', nullable: true },
      metadata: { type: 'object', additionalProperties: true },
    },
  },

  // POST /knowledge-bases/{id}/access-policies (201) →
  //   { success, message, data: row }.
  ClinicalAiKnowledgeAccessPolicyResponse: envelope('ClinicalAiKnowledgeAccessPolicyRow'),

  // GET /knowledge-bases/{id}/access-policies → { success, message,
  //   data: { policies:[row], count } }.
  ClinicalAiKnowledgeAccessPolicyListResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['policies', 'count'],
        properties: {
          policies: {
            type: 'array',
            items: { $ref: '#/components/schemas/ClinicalAiKnowledgeAccessPolicyRow' },
          },
          count: { type: 'integer', example: 0 },
        },
      },
    },
  },

  // ---- ClinicalAiKnowledgeAccessRevokeRow --------------------------------
  // DELETE .../access-policies/{role}/{permission} RETURNING projection — the
  // four-column subset (no tenant_id / granted_* / metadata).
  ClinicalAiKnowledgeAccessRevokeRow: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'knowledge_base_id', 'role', 'permission'],
    properties: {
      id: { type: 'integer' },
      knowledge_base_id: { type: 'integer' },
      role: { type: 'string' },
      permission: { type: 'string', enum: ['read', 'write', 'manage'] },
    },
  },

  // DELETE .../access-policies/{role}/{permission} →
  //   { success, message, data: row }.
  ClinicalAiKnowledgeAccessRevokeResponse: envelope('ClinicalAiKnowledgeAccessRevokeRow'),

  // ---- ClinicalAiKnowledgeDocumentRow ------------------------------------
  // One row of `knowledge_documents`. The full projection is returned by
  // getKnowledgeDocument + listKnowledgeDocuments (list omits raw_text). The
  // four categorical columns carry real DB CHECKs (113 + 311);
  // prompt_injection_verdict is nullable per its CHECK. file_size_bytes is
  // BIGINT → integer. `raw_text` is only present on the single-doc projection
  // (optional). The decide (curation) projection is a strict subset of these
  // columns, so it reuses this same schema (additionalProperties:false; only
  // the always-present core is required).
  ClinicalAiKnowledgeDocumentRow: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'knowledge_base_id', 'title'],
    properties: {
      id: { type: 'integer' },
      knowledge_base_id: { type: 'integer' },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      title: { type: 'string' },
      source_type: {
        type: 'string',
        enum: ['upload', 'url', 'inline_text', 'imported'],
      },
      source_uri: { type: 'string', nullable: true },
      mime_type: { type: 'string', nullable: true },
      file_hash: { type: 'string', nullable: true },
      file_size_bytes: { type: 'integer', nullable: true },
      raw_text: { type: 'string', nullable: true },
      processing_status: {
        type: 'string',
        enum: [
          'pending', 'extracting', 'chunking', 'embedding',
          'indexed', 'failed', 'blocked',
        ],
      },
      processing_error: { type: 'string', nullable: true },
      chunk_count: { type: 'integer' },
      prompt_injection_verdict: {
        type: 'string',
        nullable: true,
        enum: ['pass', 'flag', 'block'],
      },
      prompt_injection_metadata: { type: 'object', additionalProperties: true },
      uploaded_by: { type: 'string', format: 'uuid', nullable: true },
      metadata: { type: 'object', additionalProperties: true },
      curation_status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
      reviewed_by: { type: 'string', format: 'uuid', nullable: true },
      reviewed_at: { type: 'string', format: 'date-time', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // GET /knowledge-bases/{id}/documents/{documentId} +
  // PATCH .../{documentId}/curation → { success, message, data: row }.
  ClinicalAiKnowledgeDocumentResponse: envelope('ClinicalAiKnowledgeDocumentRow'),

  // GET /knowledge-bases/{id}/documents → { success, message,
  //   data: { documents:[row], count } }.
  ClinicalAiKnowledgeDocumentListResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['documents', 'count'],
        properties: {
          documents: {
            type: 'array',
            items: { $ref: '#/components/schemas/ClinicalAiKnowledgeDocumentRow' },
          },
          count: { type: 'integer', example: 0 },
        },
      },
    },
  },

  // ---- ClinicalAiKnowledgeDocumentDeleteRow ------------------------------
  // DELETE .../documents/{documentId} RETURNING projection — { id,
  //   knowledge_base_id, title }.
  ClinicalAiKnowledgeDocumentDeleteRow: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'knowledge_base_id', 'title'],
    properties: {
      id: { type: 'integer' },
      knowledge_base_id: { type: 'integer' },
      title: { type: 'string' },
    },
  },

  // DELETE .../documents/{documentId} → { success, message, data: row }.
  ClinicalAiKnowledgeDocumentDeleteResponse: envelope('ClinicalAiKnowledgeDocumentDeleteRow'),

  // ---- ClinicalAiKnowledgeIngestResultResponse ---------------------------
  // POST .../documents (upload) + .../documents/inline + .../documents/
  // {documentId}/reindex (all 201) return the ingest-pipeline result envelope:
  //   { document: row, processed:boolean, chunk_count?, embedded_count?,
  //     reason?, injection_safety_flag? }
  // `document` is the strict KB-document row; the pipeline counters/flags vary
  // by outcome (blocked / no_text / indexed / embed_unavailable), so the outer
  // object stays additionalProperties:true with `document` typed.
  ClinicalAiKnowledgeIngestResultResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: true,
        required: ['document'],
        properties: {
          document: { $ref: '#/components/schemas/ClinicalAiKnowledgeDocumentRow' },
          processed: { type: 'boolean' },
          chunk_count: { type: 'integer' },
          embedded_count: { type: 'integer' },
          reason: { type: 'string', nullable: true },
        },
      },
    },
  },

  // =========================================================================
  // STRICT — revenue-cycle ROI dashboard (T11). The ROI dashboard returns
  // fixed-key deterministic numeric objects (computeAiRoiMetrics) + the
  // persisted snapshot rows (clinical_ai_roi_snapshots, migration 041). NO LLM
  // `draft` anywhere here. Distinct from the outcome-scoreboard nullability
  // rule: aiRoiDashboardService.calculateAcceptanceRate() returns 0 (NOT null)
  // on a zero denominator, so ROI rate fields are plain non-null numbers — only
  // the outcome-scoreboard pct/minutes go nullable. money columns are *_minor
  // integers (NUMERIC cost cols coerced to JS numbers by normalizeSnapshotRow /
  // calculateCostPerUsefulDraft → kept as `number`). jsonb by_module/highlights
  // → array; metadata → object. The three projections (compute / insert-
  // RETURNING / list-full / latest) carry DIFFERENT column subsets, so the
  // snapshot row schema is the UNION with additionalProperties:false and only
  // the always-present core required.
  // =========================================================================

  // ---- ClinicalAiRoiByModuleRow ------------------------------------------
  // One entry of computeAiRoiMetrics().by_module (aggregateRoiMetrics push).
  // Fixed keys, all numeric/string scalars. acceptance_rate_pct is a non-null
  // number (0 when no generations). Reused as the items of the persisted
  // snapshot's jsonb by_module array too.
  ClinicalAiRoiByModuleRow: {
    type: 'object',
    additionalProperties: true,
    required: ['module_key'],
    properties: {
      module_key: { type: 'string' },
      generation_count: { type: 'integer' },
      ai_generation_count: { type: 'integer' },
      fallback_count: { type: 'integer' },
      accepted_count: { type: 'integer' },
      rejected_count: { type: 'integer' },
      pending_count: { type: 'integer' },
      edited_count: { type: 'integer' },
      total_tokens: { type: 'integer' },
      total_cost_minor: { type: 'integer' },
      acceptance_rate_pct: { type: 'number' },
      time_saved_minutes: { type: 'integer' },
      documentation_minutes_saved: { type: 'integer' },
      cost_per_useful_draft_minor: { type: 'number' },
    },
  },

  // ---- ClinicalAiRoiHighlightRow -----------------------------------------
  // One entry of computeAiRoiMetrics().highlights (top-5 accepted modules).
  ClinicalAiRoiHighlightRow: {
    type: 'object',
    additionalProperties: true,
    required: ['module_key'],
    properties: {
      module_key: { type: 'string' },
      accepted_count: { type: 'integer' },
      time_saved_minutes: { type: 'integer' },
      acceptance_rate_pct: { type: 'number' },
      cost_per_useful_draft_minor: { type: 'number' },
    },
  },

  // ---- ClinicalAiRoiMetrics ----------------------------------------------
  // The computeAiRoiMetrics() return object (GET /roi). Fixed-key overall
  // metrics + by_module[] + highlights[]. All rate/minute fields are plain
  // non-null numbers (the ROI service's calculateAcceptanceRate/TimeSaved/
  // CostPerUsefulDraft return 0, not null, on empty denominators).
  ClinicalAiRoiMetrics: {
    type: 'object',
    additionalProperties: false,
    required: ['tenant_id', 'module_key', 'period_days', 'generation_count', 'by_module', 'highlights'],
    properties: {
      tenant_id: { type: 'string', format: 'uuid' },
      module_key: { type: 'string', example: 'ALL' },
      period_start: { type: 'string', format: 'date-time' },
      period_end: { type: 'string', format: 'date-time' },
      period_days: { type: 'integer' },
      generation_count: { type: 'integer' },
      ai_generation_count: { type: 'integer' },
      fallback_count: { type: 'integer' },
      accepted_count: { type: 'integer' },
      rejected_count: { type: 'integer' },
      pending_count: { type: 'integer' },
      edited_count: { type: 'integer' },
      total_tokens: { type: 'integer' },
      total_cost_minor: { type: 'integer' },
      acceptance_rate_pct: { type: 'number' },
      time_saved_minutes: { type: 'integer' },
      documentation_hours_saved: { type: 'number' },
      denial_value_prevented_minor: { type: 'integer' },
      prior_auth_approved_count: { type: 'integer' },
      appeal_approved_count: { type: 'integer' },
      cost_per_useful_draft_minor: { type: 'number' },
      by_module: {
        type: 'array',
        items: { $ref: '#/components/schemas/ClinicalAiRoiByModuleRow' },
      },
      highlights: {
        type: 'array',
        items: { $ref: '#/components/schemas/ClinicalAiRoiHighlightRow' },
      },
      computed_at: { type: 'string', format: 'date-time' },
      decision_support_only: { type: 'boolean', example: true },
      read_only: { type: 'boolean', example: true },
    },
  },

  // GET /roi → { success, message, data: ClinicalAiRoiMetrics }.
  ClinicalAiRoiMetricsResponse: envelope('ClinicalAiRoiMetrics'),

  // ---- ClinicalAiRoiSnapshotRow ------------------------------------------
  // One row of `clinical_ai_roi_snapshots`, as returned by the three different
  // projections (insert RETURNING = 17 cols incl. computed_by but NO ai/
  // fallback/rejected/pending/edited/tokens/cost; list = 28 cols full; latest =
  // 18 cols). normalizeSnapshotRow coerces every numeric (incl. the NUMERIC/
  // BIGINT cols) to a JS number. The schema is the UNION of all three with
  // additionalProperties:false; only the always-present core is required, the
  // rest optional. money/cost cols are *_minor integers; acceptance_rate_pct /
  // documentation_hours_saved / cost_per_useful_draft_minor are NUMERIC → number.
  // jsonb by_module/highlights → array; metadata → object.
  ClinicalAiRoiSnapshotRow: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'tenant_id', 'period_days', 'module_key', 'generation_count'],
    properties: {
      id: { type: 'integer' },
      tenant_id: { type: 'string', format: 'uuid' },
      period_start: { type: 'string', format: 'date-time', nullable: true },
      period_end: { type: 'string', format: 'date-time', nullable: true },
      period_days: { type: 'integer' },
      module_key: { type: 'string', example: 'ALL' },
      generation_count: { type: 'integer' },
      ai_generation_count: { type: 'integer' },
      fallback_count: { type: 'integer' },
      accepted_count: { type: 'integer' },
      rejected_count: { type: 'integer' },
      pending_count: { type: 'integer' },
      edited_count: { type: 'integer' },
      total_tokens: { type: 'integer' },
      total_cost_minor: { type: 'integer' },
      acceptance_rate_pct: { type: 'number' },
      time_saved_minutes: { type: 'integer' },
      documentation_hours_saved: { type: 'number' },
      denial_value_prevented_minor: { type: 'integer' },
      prior_auth_approved_count: { type: 'integer' },
      appeal_approved_count: { type: 'integer' },
      cost_per_useful_draft_minor: { type: 'number' },
      by_module: {
        type: 'array',
        items: { $ref: '#/components/schemas/ClinicalAiRoiByModuleRow' },
      },
      highlights: {
        type: 'array',
        items: { $ref: '#/components/schemas/ClinicalAiRoiHighlightRow' },
      },
      metadata: { type: 'object', additionalProperties: true },
      computed_at: { type: 'string', format: 'date-time', nullable: true },
      computed_by: { type: 'string', format: 'uuid', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // POST /roi/snapshots (201) → { success, message, data: { snapshot:row|null,
  //   metrics:ClinicalAiRoiMetrics } }. saveAiRoiSnapshot returns null when the
  //   snapshot table is absent (missing-schema graceful degrade) → snapshot nullable.
  ClinicalAiRoiSnapshotResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['snapshot', 'metrics'],
        properties: {
          snapshot: {
            nullable: true,
            allOf: [{ $ref: '#/components/schemas/ClinicalAiRoiSnapshotRow' }],
          },
          metrics: { $ref: '#/components/schemas/ClinicalAiRoiMetrics' },
        },
      },
    },
  },

  // GET /roi/snapshots → { success, message, data: { snapshots:[row], count } }.
  ClinicalAiRoiSnapshotListResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['snapshots', 'count'],
        properties: {
          snapshots: {
            type: 'array',
            items: { $ref: '#/components/schemas/ClinicalAiRoiSnapshotRow' },
          },
          count: { type: 'integer', example: 0 },
        },
      },
    },
  },

  // GET /roi/snapshots/latest → { success, message, data: { snapshot:row|null } }.
  // getLatestAiRoiSnapshot returns null when no snapshot exists / table absent.
  ClinicalAiRoiSnapshotLatestResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['snapshot'],
        properties: {
          snapshot: {
            nullable: true,
            allOf: [{ $ref: '#/components/schemas/ClinicalAiRoiSnapshotRow' }],
          },
        },
      },
    },
  },

  // =========================================================================
  // STRICT — outcome-scoreboard (T11). GET /outcome-scoreboard
  // (computeAiOutcomeScoreboard) is the single best strict target in the whole
  // clinical-AI surface: a fully deterministic, fixed-key nested metrics object
  // aggregated ONLY from existing generation/review/safety tables — NO LLM
  // content, no `draft`. ★ NULLABILITY RULE (overrides the usual null-free
  // guidance): aiOutcomeScoreboardService.pct()/median() return `null` (NOT 0)
  // on an empty denominator — "no evidence yet" must never read as 0%. So
  // EVERY *_pct / *_minutes / *_distance_pct field below is a `nullable` number
  // (emitted as anyOf number/null) or Spectral fails the empty-tenant case.
  // Counts are plain integers. The nested shape mirrors emptyModuleRow() /
  // aggregateOutcomeScoreboard() / computeAiOutcomeScoreboard() exactly.
  // `definitions` is a fixed const-string map (SCOREBOARD_DEFINITIONS). Control-only.
  // =========================================================================

  // ---- ClinicalAiScoreboardModuleReviews ---------------------------------
  ClinicalAiScoreboardModuleReviews: {
    type: 'object',
    additionalProperties: false,
    required: ['total', 'decided', 'pending', 'accepted', 'edited', 'rejected', 'needs_revision'],
    properties: {
      total: { type: 'integer' },
      decided: { type: 'integer' },
      pending: { type: 'integer' },
      accepted: { type: 'integer' },
      edited: { type: 'integer' },
      rejected: { type: 'integer' },
      needs_revision: { type: 'integer' },
      acceptance_rate_pct: { type: 'number', nullable: true },
      edit_rate_pct: { type: 'number', nullable: true },
      rejection_rate_pct: { type: 'number', nullable: true },
      needs_revision_rate_pct: { type: 'number', nullable: true },
      used_rate_pct: { type: 'number', nullable: true },
      avg_review_latency_minutes: { type: 'number', nullable: true },
    },
  },

  // ---- ClinicalAiScoreboardModuleSafety ----------------------------------
  ClinicalAiScoreboardModuleSafety: {
    type: 'object',
    additionalProperties: false,
    required: [
      'flagged_total', 'flagged_decided', 'flagged_confirmed', 'flagged_overridden',
      'missed_reject_count',
    ],
    properties: {
      flagged_total: { type: 'integer' },
      flagged_decided: { type: 'integer' },
      flagged_confirmed: { type: 'integer' },
      flagged_overridden: { type: 'integer' },
      flag_precision_pct: { type: 'number', nullable: true },
      flag_override_rate_pct: { type: 'number', nullable: true },
      missed_reject_count: { type: 'integer' },
    },
  },

  // ---- ClinicalAiScoreboardTimeToSignRow ---------------------------------
  // One per-note_type time-to-sign comparison entry (module-level array).
  ClinicalAiScoreboardTimeToSignRow: {
    type: 'object',
    additionalProperties: false,
    required: ['note_type', 'ai_signed_count', 'baseline_signed_count'],
    properties: {
      note_type: { type: 'string' },
      ai_signed_count: { type: 'integer' },
      ai_median_minutes: { type: 'number', nullable: true },
      ai_avg_minutes: { type: 'number', nullable: true },
      baseline_signed_count: { type: 'integer' },
      baseline_median_minutes: { type: 'number', nullable: true },
      baseline_avg_minutes: { type: 'number', nullable: true },
      median_delta_minutes: { type: 'number', nullable: true },
    },
  },

  // ---- ClinicalAiScoreboardModuleRow -------------------------------------
  // One per-module scoreboard row (emptyModuleRow shape, populated).
  ClinicalAiScoreboardModuleRow: {
    type: 'object',
    additionalProperties: false,
    required: ['module_key', 'enabled', 'generations', 'reviews', 'edits', 'safety', 'time_to_sign'],
    properties: {
      module_key: { type: 'string' },
      display_name: { type: 'string', nullable: true },
      enabled: { type: 'boolean' },
      generations: {
        type: 'object',
        additionalProperties: false,
        required: ['total', 'ai_generated', 'fallback'],
        properties: {
          total: { type: 'integer' },
          ai_generated: { type: 'integer' },
          fallback: { type: 'integer' },
        },
      },
      reviews: { $ref: '#/components/schemas/ClinicalAiScoreboardModuleReviews' },
      edits: {
        type: 'object',
        additionalProperties: false,
        required: ['sample_count'],
        properties: {
          sample_count: { type: 'integer' },
          mean_edit_distance_pct: { type: 'number', nullable: true },
          median_edit_distance_pct: { type: 'number', nullable: true },
        },
      },
      safety: { $ref: '#/components/schemas/ClinicalAiScoreboardModuleSafety' },
      time_to_sign: {
        type: 'array',
        items: { $ref: '#/components/schemas/ClinicalAiScoreboardTimeToSignRow' },
      },
    },
  },

  // ---- ClinicalAiScoreboardTotals ----------------------------------------
  // The cross-module totals block. Mirrors the `totals` assembled in
  // aggregateOutcomeScoreboard(): generations/reviews/edits/safety roll-ups +
  // a pooled time_to_sign averages object (NOT the per-module array) +
  // modules_with_activity.
  ClinicalAiScoreboardTotals: {
    type: 'object',
    additionalProperties: false,
    required: ['modules_with_activity', 'generations', 'reviews', 'edits', 'safety', 'time_to_sign'],
    properties: {
      modules_with_activity: { type: 'integer' },
      generations: {
        type: 'object',
        additionalProperties: false,
        required: ['total', 'ai_generated', 'fallback'],
        properties: {
          total: { type: 'integer' },
          ai_generated: { type: 'integer' },
          fallback: { type: 'integer' },
        },
      },
      reviews: { $ref: '#/components/schemas/ClinicalAiScoreboardModuleReviews' },
      edits: {
        type: 'object',
        additionalProperties: false,
        required: ['sample_count'],
        properties: {
          sample_count: { type: 'integer' },
          mean_edit_distance_pct: { type: 'number', nullable: true },
          median_edit_distance_pct: { type: 'number', nullable: true },
        },
      },
      safety: {
        type: 'object',
        additionalProperties: false,
        required: [
          'flagged_total', 'flagged_decided', 'flagged_confirmed', 'flagged_overridden',
          'missed_reject_count',
        ],
        properties: {
          flagged_total: { type: 'integer' },
          flagged_decided: { type: 'integer' },
          flagged_confirmed: { type: 'integer' },
          flagged_overridden: { type: 'integer' },
          flag_precision_pct: { type: 'number', nullable: true },
          flag_override_rate_pct: { type: 'number', nullable: true },
          missed_reject_count: { type: 'integer' },
        },
      },
      time_to_sign: {
        type: 'object',
        additionalProperties: false,
        required: ['ai_signed_count', 'baseline_signed_count'],
        properties: {
          ai_signed_count: { type: 'integer' },
          baseline_signed_count: { type: 'integer' },
          ai_avg_minutes: { type: 'number', nullable: true },
          baseline_avg_minutes: { type: 'number', nullable: true },
        },
      },
    },
  },

  // ---- ClinicalAiScoreboardMedicationSafetyTypeRow -----------------------
  // One per-review_type medication-safety entry (medication_safety.by_type[]).
  ClinicalAiScoreboardMedicationSafetyTypeRow: {
    type: 'object',
    additionalProperties: false,
    required: ['review_type', 'finding_count', 'critical_count', 'blocker_count', 'overridden_count'],
    properties: {
      review_type: { type: 'string' },
      finding_count: { type: 'integer' },
      critical_count: { type: 'integer' },
      blocker_count: { type: 'integer' },
      overridden_count: { type: 'integer' },
      override_rate_pct: { type: 'number', nullable: true },
    },
  },

  // ---- ClinicalAiOutcomeScoreboard ---------------------------------------
  // The full computeAiOutcomeScoreboard() return object.
  ClinicalAiOutcomeScoreboard: {
    type: 'object',
    additionalProperties: false,
    required: [
      'tenant_id', 'period_days', 'module_key', 'modules', 'totals',
      'medication_safety', 'definitions',
    ],
    properties: {
      tenant_id: { type: 'string', format: 'uuid' },
      period_start: { type: 'string', format: 'date-time' },
      period_end: { type: 'string', format: 'date-time' },
      period_days: { type: 'integer' },
      module_key: { type: 'string', example: 'ALL' },
      modules: {
        type: 'array',
        items: { $ref: '#/components/schemas/ClinicalAiScoreboardModuleRow' },
      },
      totals: { $ref: '#/components/schemas/ClinicalAiScoreboardTotals' },
      medication_safety: {
        type: 'object',
        additionalProperties: false,
        required: ['finding_count', 'critical_count', 'blocker_count', 'overridden_count', 'by_type'],
        properties: {
          finding_count: { type: 'integer' },
          critical_count: { type: 'integer' },
          blocker_count: { type: 'integer' },
          overridden_count: { type: 'integer' },
          override_rate_pct: { type: 'number', nullable: true },
          by_type: {
            type: 'array',
            items: { $ref: '#/components/schemas/ClinicalAiScoreboardMedicationSafetyTypeRow' },
          },
        },
      },
      // SCOREBOARD_DEFINITIONS — a fixed map of metric-name → description string.
      definitions: { type: 'object', additionalProperties: { type: 'string' } },
      computed_at: { type: 'string', format: 'date-time' },
      decision_support_only: { type: 'boolean', example: true },
      read_only: { type: 'boolean', example: true },
    },
  },

  // GET /outcome-scoreboard → { success, message, data: ClinicalAiOutcomeScoreboard }.
  ClinicalAiOutcomeScoreboardResponse: envelope('ClinicalAiOutcomeScoreboard'),

  // =========================================================================
  // STRICT — platform-workbench (T12). The AI platform workbench / MLOps
  // governance sub-router (platformWorkbenchRoutes.js, 33 ops across 8 service
  // families: synthetic cases, training/sim, model registry+eval, procurement,
  // explainability, agent lifecycle, command center, dataset labeling). MOST
  // ops fold into the shared loose families — every band the EVAL/governance
  // rows surface (severity / recommendation / trust_band / opportunity_category
  // / command_status / risk_band) is config/heuristic/LLM-derived inside loose
  // `draft`, matching the T4 diagnostics-prediction-triad + T6 care-ops precedent
  // (the LIST/DECIDE governance rows fold loose even where a forecast column
  // carries a DB CHECK).
  //
  // The TWO STRICT pairs are the deterministic registry CRUD surfaces — pure
  // fixed-column rows with NO LLM `draft`, whose `stage` + `approval_status`
  // columns carry REAL DB CHECK constraints (migrations 062 + 065) AND are
  // re-validated against the service STAGES / APPROVAL_STATES allowlists with a
  // 400 BEFORE the upsert (same allowlist-before-INSERT contract as the T5
  // biomed-device registry / blood-bank group/component). normalizeRegistryRow
  // is a pass-through spread, so jsonb columns (lineage / scopes /
  // permitted_actions / metadata) come back as objects/arrays (never strings)
  // and id (SERIAL) is an integer. Both upsert paths return null on a
  // missing-schema graceful degrade → upsert `data` is nullable; the stage-
  // change path has no null branch (404 throw) → its `data` is the row.
  //
  // ★ NOTE the agent-registry approval_status set DIFFERS from the model one:
  //   model: pending|approved|revoked|rejected|pending_retirement
  //   agent: pending|approved|revoked|rejected|pending_renewal
  // so the two registries get their OWN approval_status enums. The recommendation
  // / severity bands on the eval-run + health-report tables ALSO carry DB CHECKs,
  // but those rows wrap rule/LLM-generated EVAL content (generation_id FK +
  // signals/recommended_actions jsonb), so their LIST/DECIDE ops stay loose per
  // the prediction-triad precedent. Control-only.
  // =========================================================================

  // ---- ClinicalAiModelRegistryRow ----------------------------------------
  // One row of `clinical_ai_model_registry` (migration 062), as returned by
  // upsertModelRegistry() / changeModelStage() RETURNING and listModelRegistry().
  // `stage` + `approval_status` carry real DB CHECK constraints (re-validated by
  // the service STAGES / APPROVAL_STATES sets → 400). jsonb lineage / metadata →
  // object.
  ClinicalAiModelRegistryRow: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'model_key', 'version', 'stage', 'approval_status'],
    properties: {
      id: { type: 'integer' },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      model_key: { type: 'string' },
      version: { type: 'string' },
      provider: { type: 'string', nullable: true },
      purpose: { type: 'string', nullable: true },
      owner: { type: 'string', nullable: true },
      stage: {
        type: 'string',
        enum: ['sandbox', 'staging', 'production', 'deprecated', 'quarantined', 'unknown'],
      },
      parent_version: { type: 'string', nullable: true },
      lineage: { type: 'object', additionalProperties: true },
      approval_status: {
        type: 'string',
        enum: ['pending', 'approved', 'revoked', 'rejected', 'pending_retirement'],
      },
      approval_note: { type: 'string', nullable: true },
      approved_by: { type: 'string', format: 'uuid', nullable: true },
      approved_at: { type: 'string', format: 'date-time', nullable: true },
      retired_at: { type: 'string', format: 'date-time', nullable: true },
      metadata: { type: 'object', additionalProperties: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // POST /model-registry (201) → { success, message, data: <row | null> }.
  // upsert returns null when the registry table is absent (missing-schema
  // graceful degrade), so `data` is nullable.
  ClinicalAiModelRegistryResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/ClinicalAiModelRegistryRow' }],
      },
    },
  },

  // PATCH /model-registry/{id}/stage → { success, message, data: row }.
  // changeModelStage has no missing-schema null branch (404 throw), so the row
  // is always present.
  ClinicalAiModelRegistryStageResponse: envelope('ClinicalAiModelRegistryRow'),

  // GET /model-registry → { success, message, data: { models:[row], count } }.
  ClinicalAiModelRegistryListResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['models', 'count'],
        properties: {
          models: {
            type: 'array',
            items: { $ref: '#/components/schemas/ClinicalAiModelRegistryRow' },
          },
          count: { type: 'integer', example: 0 },
        },
      },
    },
  },

  // ---- ClinicalAiAgentRegistryRow ----------------------------------------
  // One row of `clinical_ai_agent_registry` (migration 065), as returned by
  // upsertAgentRegistry() / changeAgentStage() RETURNING and listAgentRegistry().
  // `stage` + `approval_status` carry real DB CHECK constraints (re-validated by
  // the service STAGES / APPROVAL_STATES sets → 400). NOTE the approval_status
  // set ends in `pending_renewal` (NOT the model registry's `pending_retirement`).
  // jsonb scopes / permitted_actions → array; metadata → object.
  ClinicalAiAgentRegistryRow: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'agent_key', 'stage', 'approval_status'],
    properties: {
      id: { type: 'integer' },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      agent_key: { type: 'string' },
      display_name: { type: 'string', nullable: true },
      owner: { type: 'string', nullable: true },
      purpose: { type: 'string', nullable: true },
      scopes: { type: 'array', items: { type: 'string' } },
      permitted_actions: { type: 'array', items: { type: 'string' } },
      stage: {
        type: 'string',
        enum: ['sandbox', 'staging', 'production', 'deprecated', 'quarantined', 'unknown'],
      },
      expiry_date: { type: 'string', format: 'date', nullable: true },
      last_seen_at: { type: 'string', format: 'date-time', nullable: true },
      approval_status: {
        type: 'string',
        enum: ['pending', 'approved', 'revoked', 'rejected', 'pending_renewal'],
      },
      approval_note: { type: 'string', nullable: true },
      approved_by: { type: 'string', format: 'uuid', nullable: true },
      approved_at: { type: 'string', format: 'date-time', nullable: true },
      retired_at: { type: 'string', format: 'date-time', nullable: true },
      metadata: { type: 'object', additionalProperties: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // POST /agent-registry (201) → { success, message, data: <row | null> }.
  // upsert returns null when the registry table is absent (missing-schema
  // graceful degrade), so `data` is nullable.
  ClinicalAiAgentRegistryResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/ClinicalAiAgentRegistryRow' }],
      },
    },
  },

  // PATCH /agent-registry/{id}/stage → { success, message, data: row }.
  // changeAgentStage has no missing-schema null branch (404 throw), so the row
  // is always present.
  ClinicalAiAgentRegistryStageResponse: envelope('ClinicalAiAgentRegistryRow'),

  // GET /agent-registry → { success, message, data: { agents:[row], count } }.
  ClinicalAiAgentRegistryListResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['agents', 'count'],
        properties: {
          agents: {
            type: 'array',
            items: { $ref: '#/components/schemas/ClinicalAiAgentRegistryRow' },
          },
          count: { type: 'integer', example: 0 },
        },
      },
    },
  },

  // =========================================================================
  // STRICT — overview longitudinal-risk (T14, overviewRoutes.js). GET
  // /longitudinal-risk returns `{ snapshots:[row], count }` over the
  // deterministic `clinical_longitudinal_risk` table (migration 018) — pure
  // immutable risk-snapshot rows, NO LLM `draft`. The route's explicit
  // 13-column projection (id, admission_id, patient_uid, u.name AS
  // patient_name, overall_score, band, adherence_score, adherence_source,
  // readmission_score, comorbidity_score, abdm_enrichment, recommendations,
  // created_at) is mirrored verbatim. `band` carries a REAL DB CHECK
  // constraint (`CHECK (band IN ('low','medium','high','critical'))`) so it is
  // pinned to a null-free enum. The four score columns are `NUMERIC(5,2)` read
  // via `$queryRawUnsafe` (rawQuery) with NO JS coercion — Prisma returns them
  // as `Prisma.Decimal`, whose `toJSON` emits a JS number — so each is
  // `{ type:'number', nullable:true }` (spec is OpenAPI 3.0, which forbids
  // array `type`; single type + nullable is the 3.0-correct nullable shape,
  // mirroring the outcome-scoreboard pct/minutes fields). jsonb
  // `abdm_enrichment` → object; jsonb `recommendations` → array (never
  // strings). `patient_name` comes from the LEFT JOIN (nullable). The
  // projection omits tenant_id / contributors / metadata / retention_until, so
  // those are absent (additionalProperties:false). Dual-mounted across both
  // CONTROL_PREFIXES via aliasOps.
  // =========================================================================

  // ---- ClinicalAiLongitudinalRiskRow -------------------------------------
  ClinicalAiLongitudinalRiskRow: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'patient_uid', 'overall_score', 'band'],
    properties: {
      id: { type: 'integer' },
      admission_id: { type: 'integer', nullable: true },
      patient_uid: { type: 'string', format: 'uuid' },
      patient_name: { type: 'string', nullable: true },
      // `clinical_longitudinal_risk.overall_score` is NUMERIC(5,2) NOT NULL
      // (migration 018) and the route projects the column directly, so it is
      // never null — keep the spec tight (it is also in `required` above).
      overall_score: { type: 'number' },
      band: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      adherence_score: { type: 'number', nullable: true },
      adherence_source: { type: 'string', nullable: true },
      readmission_score: { type: 'number', nullable: true },
      comorbidity_score: { type: 'number', nullable: true },
      abdm_enrichment: { type: 'object', additionalProperties: true },
      recommendations: { type: 'array', items: { type: 'object', additionalProperties: true } },
      created_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // GET /longitudinal-risk → { success, message,
  //   data: { snapshots:[row], count } }.
  ClinicalAiLongitudinalRiskListResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['snapshots', 'count'],
        properties: {
          snapshots: {
            type: 'array',
            items: { $ref: '#/components/schemas/ClinicalAiLongitudinalRiskRow' },
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

  // -------------------------------------------------------------------------
  // surgical (surgicalAiRoutes.js) — 8 ops. Eight single-POST surgical-AI
  // module generators (Tier B PR2). Each drafts a clinical doc / risk summary /
  // checklist + enqueues a clinical-AI review row, returning
  // success(res, result, …, 201) with the standard draft envelope (the scout's
  // "SurgicalAiDraftEnvelope" — module_key/generation_id/ot_schedule_id/
  // review_status/provider/used_ai/safety_flags[] + draft:additionalProperties).
  // Folds into the shared loose family — every structured bit (HEART/risk band,
  // consent terms, implant reconciliation) is LLM-prompt-internal inside loose
  // `draft`, with no DB CHECK. Listing + decisions reuse the existing /reviews
  // surface (already overlaid in the core-clinical pass), so there are NO
  // list/decide ops here. All → ClinicalAiDraftResponse. Control-only.
  // -------------------------------------------------------------------------
  ['POST /preop-checklist-reviews', { response: 'ClinicalAiDraftResponse' }],
  ['POST /surgical-consent-drafts', { response: 'ClinicalAiDraftResponse' }],
  ['POST /ot-note-drafts', { response: 'ClinicalAiDraftResponse' }],
  ['POST /post-op-instruction-drafts', { response: 'ClinicalAiDraftResponse' }],
  ['POST /surgical-risk-summaries', { response: 'ClinicalAiDraftResponse' }],
  ['POST /anesthesia-prechecks', { response: 'ClinicalAiDraftResponse' }],
  ['POST /implant-consumable-tracking', { response: 'ClinicalAiDraftResponse' }],
  ['POST /post-op-complication-alerts', { response: 'ClinicalAiDraftResponse' }],

  // -------------------------------------------------------------------------
  // teleconsult (teleconsultAiRoutes.js) — 2 ops. Two single-POST teleconsult
  // generators (Phase B1): each drafts a pre-visit summary / consult note +
  // enqueues a review row + back-links the generation onto the parent
  // teleconsultations row, returning the standard draft envelope (201). Loose
  // family — all → ClinicalAiDraftResponse. Control-only.
  // -------------------------------------------------------------------------
  ['POST /teleconsult-pre-visit-summaries', { response: 'ClinicalAiDraftResponse' }],
  ['POST /teleconsult-note-drafts', { response: 'ClinicalAiDraftResponse' }],

  // -------------------------------------------------------------------------
  // operational-alerts (operationalAlertRoutes.js) — 3 ops. STRICT. The unified
  // forecast-alert stream (rules-authoritative, advisory-only, NO LLM `draft`):
  //   • GET  /operational-alerts            → { alerts:[30-col row], count }
  //   • POST /operational-alerts/{id}/decision → { id, reviewer_decision,
  //                                               reviewed_by, reviewed_at,
  //                                               reviewer_note }
  //   • POST /operational-alerts/run-sweep  → { evaluated, raised, resolved,
  //                                             errors:[{module_key,error}] }
  // The row's three categorical columns (severity / system_status /
  // reviewer_decision) have real DB CHECK constraints (migration 315) → pinned
  // enums. The strict schemas live above. Control-only.
  // -------------------------------------------------------------------------
  ['GET /operational-alerts', { response: 'ClinicalAiOperationalAlertListResponse' }],
  ['POST /operational-alerts/{id}/decision', { response: 'ClinicalAiOperationalAlertDecisionResponse' }],
  ['POST /operational-alerts/run-sweep', { response: 'ClinicalAiOperationalAlertSweepResponse' }],

  // -------------------------------------------------------------------------
  // discharge-compose (dischargeComposeRoutes.js) — 5 ops. The
  // discharge_summary_compose meta-workflow over `clinical_ai_workflow_runs`.
  // Mixed typing (per ground-truth route file + workflowGraphRunner outcome
  // shapes):
  //   • POST /discharge-compose            → compose graph result blob (the
  //     completed compose result OR a paused stub; variable keys) → loose
  //     ClinicalAiDraftResponse. 201 completed / 202 paused.
  //   • POST /discharge-compose/{runId}/resume → resumeWorkflow outcome blob
  //     ({ status, runId, state?, result?, pauseReason?, error? }; variable
  //     keys) → loose ClinicalAiDraftResponse. 200 / 202.
  //   • GET  /discharge-compose            → STRICT { runs:[workflow-run row],
  //     count } (explicit 14-col SELECT) → ClinicalAiWorkflowRunListResponse.
  //   • GET  /discharge-compose/{runId}    → STRICT { run, children:[row],
  //     child_count } → ClinicalAiWorkflowRunDetailResponse.
  //   • POST /discharge-compose/{runId}/fail → STRICT trivial
  //     { status:'failed', runId, reason } → ClinicalAiWorkflowRunFailResponse.
  // `status`/`pause_reason` are plain VARCHARs (no DB CHECK) → plain strings.
  // Control-only.
  // -------------------------------------------------------------------------
  ['POST /discharge-compose', { response: 'ClinicalAiDraftResponse' }],
  ['GET /discharge-compose', { response: 'ClinicalAiWorkflowRunListResponse' }],
  ['GET /discharge-compose/{runId}', { response: 'ClinicalAiWorkflowRunDetailResponse' }],
  ['POST /discharge-compose/{runId}/resume', { response: 'ClinicalAiDraftResponse' }],
  ['POST /discharge-compose/{runId}/fail', { response: 'ClinicalAiWorkflowRunFailResponse' }],

  // -------------------------------------------------------------------------
  // documents (documentRoutes.js) — 4 ops. Document-intelligence / OCR intake
  // over `clinical_document_intake`. Standard generate/list/decide family — NO
  // strict ops (the intake result is a loose draft envelope; the list is the
  // shared count-list; the decide is the shared review-decision row):
  //   • POST /documents/intake             → loose draft envelope (201) →
  //     ClinicalAiDraftResponse.
  //   • POST /documents/intake/upload      → same (multipart file upload, 201)
  //     → ClinicalAiDraftResponse.
  //   • GET  /documents/intake             → { documents:[row], count } →
  //     ClinicalAiCountListResponse (key 'documents' — not pinned by the loose
  //     count-list).
  //   • PATCH /documents/intake/{id}       → updated review-decision row
  //     ({ id, reviewer_decision[accepted|rejected|needs_revision],
  //     reviewed_by, reviewed_at, reviewer_note, + extra cols }) →
  //     ClinicalAiReviewDecisionResponse (loose row, additionalProperties:true).
  // Control-only.
  // -------------------------------------------------------------------------
  ['POST /documents/intake', { response: 'ClinicalAiDraftResponse' }],
  ['POST /documents/intake/upload', { response: 'ClinicalAiDraftResponse' }],
  ['GET /documents/intake', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /documents/intake/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // -------------------------------------------------------------------------
  // governance (governanceRoutes.js) — 46 ops. The largest control sub-router:
  // runtime status, module / tenant-module enablement, prompts, reviews,
  // approvals, break-glass, usage, safety, audit, generations, RAG corpus,
  // A/B experiments, drift canary, regulatory-readiness + pilot-evidence packs.
  //
  // Typing (per scout r4 + ground-truth route handlers + verified service
  // return shapes):
  //   • THREE STRICT ops surface REAL fixed-column table rows from explicit
  //     projection SELECTs → bespoke strict schemas:
  //       GET /audit        → { logs:[ClinicalAiAuditLogRow], count }
  //       GET /generations  → { generations:[ClinicalAiGenerationRow], count }
  //       GET /safety-flags → { flags:[ClinicalAiSafetyFlagRow], count }
  //     Pinned-enum discipline applied: `clinical_ai_generations` + `audit_logs`
  //     have NO DB CHECK on status/task_type/action → plain strings;
  //     generation_mode/provider_status/fallback_reason/readiness_reason are
  //     COALESCE(metadata->>'…', CASE …) projections (jsonb override = any
  //     string) → plain nullable strings; safety-flags severity is
  //     flag->>'severity' (any string) → plain nullable string. (No null-free
  //     enum needed — nothing is pinned. jsonb metadata→object, safety_flags→array.)
  //   • The eleven `{ <named>, count }` GET lists fold into the shared loose
  //     count-list → ClinicalAiCountListResponse. Verified service shapes:
  //     listClinicalAiModules/TenantModules → { modules, count };
  //     listPrompts → { prompts, count }; listReviews → { reviews, count };
  //     listApprovals → { approvals, count }; getActiveBreakGlass →
  //     { sessions, count }; listSelfHealingRuns → { runs, count };
  //     listExperiments → { experiments, count }; listCanaryRuns → { runs,
  //     count }; listCanaryCases → { cases, count }; listPilotSignoffs →
  //     { signoffs, count }. (modules/tenant-modules are computed/merged config
  //     objects, NOT fixed-column rows, so they stay loose per the plan.)
  //   • Every other op returns a single computed/merged object, a composite
  //     governance-report/pack blob, or a usage/summary aggregate → the shared
  //     loose single-object envelope ClinicalAiGovernanceObjectResponse. This
  //     covers the two-shape 202(`approval_required`)/200 PATCH ops on
  //     modules/tenant-modules/prompts (envelope typed, `data` loose). NONE of
  //     these are draft-envelope-shaped (no module_key+draft contract), so they
  //     do NOT reuse ClinicalAiDraftResponse.
  // Control-only (no /clinical-ai/clinical mount). Dual-mounted across both
  // CONTROL_PREFIXES via aliasOps.
  // -------------------------------------------------------------------------

  // ---- Runtime status ----
  ['GET /status', { response: 'ClinicalAiGovernanceObjectResponse' }],

  // ---- Module + tenant-module enablement (loose computed/merged objects) ----
  ['GET /modules', { response: 'ClinicalAiCountListResponse' }],
  ['GET /tenant-modules', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /tenant-modules/{moduleKey}', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['DELETE /tenant-modules/{moduleKey}', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['PATCH /modules/{moduleKey}', { response: 'ClinicalAiGovernanceObjectResponse' }],

  // ---- Prompt registry ----
  ['GET /prompts', { response: 'ClinicalAiCountListResponse' }],
  ['POST /prompts', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['PATCH /prompts/{id}/activate', { response: 'ClinicalAiGovernanceObjectResponse' }],

  // ---- Review queue ----
  ['GET /reviews', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /reviews/{id}', { response: 'ClinicalAiGovernanceObjectResponse' }],

  // ---- Approvals ----
  ['GET /approvals', { response: 'ClinicalAiCountListResponse' }],
  ['POST /approvals', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['PATCH /approvals/{id}', { response: 'ClinicalAiGovernanceObjectResponse' }],

  // ---- Break-glass sessions ----
  ['POST /break-glass', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['PATCH /break-glass/{id}/end', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['GET /break-glass', { response: 'ClinicalAiCountListResponse' }],

  // ---- Usage / safety / governance summaries + report ----
  ['GET /usage', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['GET /safety-reviews/summary', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['GET /governance-report', { response: 'ClinicalAiGovernanceObjectResponse' }],

  // ---- Guardrails + budget ----
  ['GET /guardrails', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['PATCH /guardrails', { response: 'ClinicalAiGovernanceObjectResponse' }],

  // ---- STRICT — audit log + generations ledger + safety-flags stream ----
  ['GET /audit', { response: 'ClinicalAiAuditLogListResponse' }],
  ['GET /generations', { response: 'ClinicalAiGenerationListResponse' }],
  ['GET /safety-flags', { response: 'ClinicalAiSafetyFlagListResponse' }],

  // ---- Self-healing ----
  ['GET /self-healing/status', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['GET /self-healing/runs', { response: 'ClinicalAiCountListResponse' }],
  ['POST /self-healing/runs', { response: 'ClinicalAiGovernanceObjectResponse' }],

  // ---- RAG corpus ----
  ['GET /corpus', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['POST /corpus/reindex', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['POST /corpus/test-query', { response: 'ClinicalAiGovernanceObjectResponse' }],

  // ---- Prompt A/B experiments ----
  ['GET /experiments', { response: 'ClinicalAiCountListResponse' }],
  ['POST /experiments', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['GET /experiments/{id}/stats', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['PATCH /experiments/{id}/conclude', { response: 'ClinicalAiGovernanceObjectResponse' }],

  // ---- Model-drift canary ----
  ['GET /canary/runs', { response: 'ClinicalAiCountListResponse' }],
  ['POST /canary/runs', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['GET /canary/cases', { response: 'ClinicalAiCountListResponse' }],
  ['POST /canary/cases', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['PATCH /canary/cases/{id}/deactivate', { response: 'ClinicalAiGovernanceObjectResponse' }],

  // ---- Regulatory-readiness + pilot-evidence packs + signoffs ----
  ['POST /readiness-pack', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['POST /pilot-evidence-pack', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['GET /pilot-signoffs/gate', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['GET /pilot-signoffs', { response: 'ClinicalAiCountListResponse' }],
  ['POST /pilot-signoffs', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['PATCH /pilot-signoffs/{id}', { response: 'ClinicalAiGovernanceObjectResponse' }],

  // -------------------------------------------------------------------------
  // knowledge-base (knowledgeBaseRoutes.js) — 18 ops. The RAG knowledge layer:
  // KB CRUD + role-based access policies + document upload/curation pipeline +
  // permission-filtered retrieval. MOSTLY-STRICT (per scout r4 + plan strictOps
  // + ground-truth route/service + DB CHECKs in migrations 113 + 311): every
  // CRUD op surfaces a REAL fixed-column table row with DB-CHECK-grade enums
  // (kb_type/status/source_type/processing_status/prompt_injection_verdict/
  // curation_status/permission) → bespoke strict schemas authored above. `role`
  // is plain VARCHAR (no CHECK) → plain string. jsonb metadata → object.
  //
  // The ingest ops (upload / inline / reindex) return the pipeline-result
  // envelope `{ document: <strict row>, processed, chunk_count?, embedded_count?,
  // reason? }` → ClinicalAiKnowledgeIngestResultResponse. The curation decide
  // (PATCH .../curation) returns the strict document row → the document response.
  // The two service-blob ops fold into the shared loose families: POST /retrieve
  // returns `{ results[], source, query_hash }` (source = soft non-CHECK string)
  // → ClinicalAiGovernanceObjectResponse; GET /retrieval-logs returns
  // `{ logs, count }` → ClinicalAiCountListResponse. Control-only (no
  // /clinical-ai/clinical mount). Dual-mounted across both CONTROL_PREFIXES.
  // -------------------------------------------------------------------------

  // ---- KB CRUD (strict row) ----
  ['GET /knowledge-bases', { response: 'ClinicalAiKnowledgeBaseListResponse' }],
  ['POST /knowledge-bases', { response: 'ClinicalAiKnowledgeBaseResponse' }],
  ['GET /knowledge-bases/{id}', { response: 'ClinicalAiKnowledgeBaseResponse' }],
  ['PATCH /knowledge-bases/{id}', { response: 'ClinicalAiKnowledgeBaseResponse' }],
  ['PATCH /knowledge-bases/{id}/archive', { response: 'ClinicalAiKnowledgeBaseResponse' }],
  ['PATCH /knowledge-bases/{id}/unarchive', { response: 'ClinicalAiKnowledgeBaseResponse' }],

  // ---- Access policies (strict row; revoke = subset projection) ----
  ['GET /knowledge-bases/{id}/access-policies', { response: 'ClinicalAiKnowledgeAccessPolicyListResponse' }],
  ['POST /knowledge-bases/{id}/access-policies', { response: 'ClinicalAiKnowledgeAccessPolicyResponse' }],
  ['DELETE /knowledge-bases/{id}/access-policies/{role}/{permission}', { response: 'ClinicalAiKnowledgeAccessRevokeResponse' }],

  // ---- Documents (strict row; ingest = pipeline-result envelope) ----
  ['GET /knowledge-bases/{id}/documents', { response: 'ClinicalAiKnowledgeDocumentListResponse' }],
  ['POST /knowledge-bases/{id}/documents/inline', { response: 'ClinicalAiKnowledgeIngestResultResponse' }],
  ['POST /knowledge-bases/{id}/documents', { response: 'ClinicalAiKnowledgeIngestResultResponse' }],
  ['GET /knowledge-bases/{id}/documents/{documentId}', { response: 'ClinicalAiKnowledgeDocumentResponse' }],
  ['DELETE /knowledge-bases/{id}/documents/{documentId}', { response: 'ClinicalAiKnowledgeDocumentDeleteResponse' }],
  ['POST /knowledge-bases/{id}/documents/{documentId}/reindex', { response: 'ClinicalAiKnowledgeIngestResultResponse' }],
  ['PATCH /knowledge-bases/{id}/documents/{documentId}/curation', { response: 'ClinicalAiKnowledgeDocumentResponse' }],

  // ---- Retrieval (loose service blobs) ----
  ['POST /knowledge-bases/retrieve', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['GET /knowledge-bases/retrieval-logs', { response: 'ClinicalAiCountListResponse' }],

  // -------------------------------------------------------------------------
  // knowledge-governance (knowledgeGovernanceRoutes.js) — 21 ops. Seven
  // independent governance sub-modules, all the SAME evaluate→list→decide CRUD
  // triad (policy-diff/regulation watcher, multimodal patient timeline, pathway
  // bundle compliance, clinical knowledge graph, acuity staffing forecast,
  // federated-learning coordinator, voice-patient-assistant/IVR).
  //
  // Typing (per scout r4 + ground-truth route file + verified service return
  // shapes): ALL 21 ops are loose — NONE are in the strictOps shortlist (which
  // lives in scoreboard/ROI/KB/operational-alerts/governance, not here). Every
  // band these surface (severity / recommendation / overall_severity /
  // overall_health / impact_area / compliance_pct / federation status +
  // approval_status / voice channel + aggregation_method) is config/heuristic/
  // LLM-derived inside loose `draft`, with NO hard DB CHECK in these routes, so
  // it stays plain — per the plan's "leave soft/config-derived bands as plain
  // strings" rule. Specifically:
  //   • POST evaluate/generate/record → loose draft/result envelope (201) →
  //     ClinicalAiDraftResponse (the policy-diff, timeline-snapshot, pathway
  //     audit, graph-health report, staffing forecast, federation-round, voice
  //     session all wrap a typed outer envelope around a rule/LLM-generated
  //     inner blob with variable keys).
  //   • The deterministic registry-ish upsert POSTs (knowledge-graph nodes +
  //     edges, federation sites) ALSO fold here: each returns a single
  //     normalized registry row (or null on missing-schema graceful degrade),
  //     but carries NO DB-CHECK-grade categorical column in the strict
  //     shortlist — node_type/edge_type/site status are service-normalized free
  //     strings, NOT service-allowlisted like blood-bank group/component — so
  //     per the plan + the T6 care-ops registry precedent they stay in the
  //     shared loose envelope rather than getting a bespoke strict schema.
  //   • GET lists → `{ <plural>: [...rows], count }` (verified service shapes:
  //     listNodes→{nodes,count}; listEdges→{edges,count}; listFederationSites→
  //     {sites,count}; listFederationRounds→{rounds,count}; plus policy-diffs/
  //     snapshots/pathway-bundles/health-reports/forecasts/voice-sessions) →
  //     ClinicalAiCountListResponse.
  //   • PATCH decide + PATCH .../status → single updated governance/registry row
  //     ({ id, reviewer_decision/status + reviewer metadata }) →
  //     ClinicalAiReviewDecisionResponse (loose row, additionalProperties:true).
  // Control-only (no /clinical-ai/clinical mount for any of these). Dual-mounted
  // across both CONTROL_PREFIXES via aliasOps.
  // -------------------------------------------------------------------------

  // ---- Policy Diff / Regulation Watcher ----
  ['POST /policy-diffs/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /policy-diffs', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /policy-diffs/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Multimodal Patient Timeline ----
  ['POST /patient-timeline/generate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /patient-timeline/snapshots', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /patient-timeline/snapshots/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Generalized Pathway Bundle Compliance ----
  ['POST /pathway-bundles/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /pathway-bundles', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /pathway-bundles/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Clinical Knowledge Graph — registry upserts + lists + health triad ----
  // nodes/edges POSTs return a single normalized registry row (loose draft
  // family); GET nodes/edges return `{ nodes|edges, count }`; health/evaluate is
  // the standard rule-generated report; health/reports list + decide are the
  // governance pair.
  ['POST /knowledge-graph/nodes', { response: 'ClinicalAiDraftResponse' }],
  ['GET /knowledge-graph/nodes', { response: 'ClinicalAiCountListResponse' }],
  ['POST /knowledge-graph/edges', { response: 'ClinicalAiDraftResponse' }],
  ['GET /knowledge-graph/edges', { response: 'ClinicalAiCountListResponse' }],
  ['POST /knowledge-graph/health/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /knowledge-graph/health/reports', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /knowledge-graph/health/reports/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Acuity-Based Staffing Forecast ----
  ['POST /acuity-staffing/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /acuity-staffing/forecasts', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /acuity-staffing/forecasts/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Federated Learning Coordinator — sites + rounds ----
  // /sites POST = registry upsert (single row, loose draft family);
  // /sites/{id}/status PATCH = updated site row (review-decision family);
  // /rounds POST = rules-authoritative readiness recommendation (draft family);
  // /rounds/{id} PATCH = decide.
  ['POST /federation/sites', { response: 'ClinicalAiDraftResponse' }],
  ['GET /federation/sites', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /federation/sites/{id}/status', { response: 'ClinicalAiReviewDecisionResponse' }],
  ['POST /federation/rounds', { response: 'ClinicalAiDraftResponse' }],
  ['GET /federation/rounds', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /federation/rounds/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Voice Patient Assistant / IVR ----
  ['POST /voice-ivr/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /voice-ivr/sessions', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /voice-ivr/sessions/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // -------------------------------------------------------------------------
  // revenue-cycle (revenueCycleRoutes.js) — 18 ops. Four revenue sub-modules:
  // prior-authorization packet generator, denial appeal-letter generator, the
  // AI ROI dashboard, and payer-contract variance / underpayment AI. Mixed
  // typing (per scout r5 + ground-truth route file + verified service RETURNING
  // projections):
  //   • POST generate/evaluate (prior-auth, appeal-letter, payer-variance) →
  //     loose draft/result envelope (201) → ClinicalAiDraftResponse.
  //   • GET lists (prior-auths / appeals / payer-contracts / payer-variance
  //     reviews) → `{ <plural>:[row], count }` → ClinicalAiCountListResponse
  //     (the per-domain rows carry money-minor + variance bands inside the loose
  //     count-list row — not in the strict shortlist, which is ROI-only here).
  //   • PATCH/POST decide-shaped updates that RETURN a row carrying BOTH `id`
  //     AND `reviewer_decision` → ClinicalAiReviewDecisionResponse (submit PA,
  //     decide/submit appeal, decide payer-variance). The updates that RETURN a
  //     row WITHOUT a `reviewer_decision` column (recordPayerDecision →
  //     { id, status, payer_decided_at, … }; recordAppealPayerResponse →
  //     { id, claim_id, appeal_status, … }; upsertPayerContract → contract row)
  //     CANNOT satisfy the ReviewDecisionRow `required:[id,reviewer_decision]`,
  //     so they fold into the typed-envelope/loose-object
  //     ClinicalAiGovernanceObjectResponse instead.
  //   • THE STRICT BLOCK — the AI ROI dashboard (NO LLM draft, fixed-key
  //     deterministic numeric metrics + persisted snapshot rows):
  //       GET  /roi                  → ClinicalAiRoiMetricsResponse
  //       POST /roi/snapshots (201)  → ClinicalAiRoiSnapshotResponse
  //                                     ({ snapshot:row|null, metrics })
  //       GET  /roi/snapshots        → ClinicalAiRoiSnapshotListResponse
  //       GET  /roi/snapshots/latest → ClinicalAiRoiSnapshotLatestResponse
  //     (ROI rate fields are plain non-null numbers — the ROI service returns 0,
  //     not null, on empty denominators; only the outcome-scoreboard goes nullable.)
  // Control-only. Dual-mounted across both CONTROL_PREFIXES via aliasOps.
  // -------------------------------------------------------------------------

  // ---- Prior authorization ----
  ['POST /prior-auth', { response: 'ClinicalAiDraftResponse' }],
  ['GET /prior-auth', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /prior-auth/{id}/submit', { response: 'ClinicalAiReviewDecisionResponse' }],
  ['PATCH /prior-auth/{id}/payer-decision', { response: 'ClinicalAiGovernanceObjectResponse' }],

  // ---- Appeal letter generator ----
  ['POST /appeal-letters', { response: 'ClinicalAiDraftResponse' }],
  ['GET /appeal-letters', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /appeal-letters/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],
  ['POST /appeal-letters/{id}/submit', { response: 'ClinicalAiReviewDecisionResponse' }],
  ['POST /appeal-letters/{id}/payer-response', { response: 'ClinicalAiGovernanceObjectResponse' }],

  // ---- STRICT — AI ROI dashboard (metrics object + snapshot rows) ----
  ['GET /roi', { response: 'ClinicalAiRoiMetricsResponse' }],
  ['POST /roi/snapshots', { response: 'ClinicalAiRoiSnapshotResponse' }],
  ['GET /roi/snapshots', { response: 'ClinicalAiRoiSnapshotListResponse' }],
  ['GET /roi/snapshots/latest', { response: 'ClinicalAiRoiSnapshotLatestResponse' }],

  // ---- Payer-contract variance / underpayment ----
  ['POST /payer-contracts', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['GET /payer-contracts', { response: 'ClinicalAiCountListResponse' }],
  ['POST /payer-variance/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /payer-variance/reviews', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /payer-variance/reviews/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Coding-suggestion batch (revenueCycleRoutes.js) — 1 op. STRICT. ----
  // Admin trigger for the nightly coding-suggestion sweep. Returns the
  // service's fixed PHI-free run summary. Description authored here (not
  // baselined) so the spectral operation-description baseline never grows.
  ['POST /coding-batch/run-sweep', {
    description: 'Runs the clinical-coding suggestion batch for the current tenant: de-identifies signed documentation, generates ICD coding suggestions through the governed clinical-AI module, and enqueues each suggestion as a pending review item for the coding team. Nothing is auto-applied to claims or the record; the clinical_coding_assist module gate applies and a disabled module returns a no-op summary.',
    response: 'ClinicalAiCodingBatchSweepResponse',
  }],

  // -------------------------------------------------------------------------
  // prior-auth-appeal chain (priorAuthAppealRoutes.js) — 4 ops. The
  // prior_auth_appeal_chain resumable meta-workflow over
  // `clinical_ai_workflow_runs` (same store/runner family as discharge-compose).
  // Mixed typing (per scout r5 + ground-truth route file):
  //   • POST /prior-auth/{id}/appeal           → composePriorAuthAppeal outcome
  //     blob (paused stub { status:'paused', run_id, pause_reason } OR rare sync
  //     completion; variable keys) → loose ClinicalAiDraftResponse. 202 paused /
  //     201 completed.
  //   • POST /prior-auth-appeal/{runId}/resume → resumeWorkflow outcome blob
  //     ({ status, runId, state?, result?, pauseReason?, error? }) → loose
  //     ClinicalAiDraftResponse. 200 / 202.
  //   • GET  /prior-auth-appeal/{runId}        → STRICT { run, children:[row],
  //     child_count } over workflow-run rows → REUSES the discharge-compose
  //     ClinicalAiWorkflowRunDetailResponse (identical clinical_ai_workflow_runs
  //     shape; `status`/`pause_reason` plain VARCHARs, no DB CHECK).
  //   • POST /prior-auth-appeal/{runId}/fail   → STRICT trivial
  //     { status:'failed', runId, reason } → REUSES ClinicalAiWorkflowRunFailResponse.
  // Note the bare `/prior-auth/{id}/appeal` start op is keyed under the
  // prior-auth prefix but routes through this chain service (module-gated on
  // appeal_letter_generator → 403, not a 200 variant). Control-only.
  // -------------------------------------------------------------------------
  ['POST /prior-auth/{id}/appeal', { response: 'ClinicalAiDraftResponse' }],
  ['GET /prior-auth-appeal/{runId}', { response: 'ClinicalAiWorkflowRunDetailResponse' }],
  ['POST /prior-auth-appeal/{runId}/resume', { response: 'ClinicalAiDraftResponse' }],
  ['POST /prior-auth-appeal/{runId}/fail', { response: 'ClinicalAiWorkflowRunFailResponse' }],

  // -------------------------------------------------------------------------
  // outcome-scoreboard (outcomeScoreboardRoutes.js) — 1 op. STRICT — the single
  // best strict target in the clinical-AI surface: GET /outcome-scoreboard
  // (computeAiOutcomeScoreboard) returns a fully deterministic, fixed-key nested
  // metrics object (modules / totals / medication_safety / time_to_sign)
  // aggregated only from existing generation/review/safety tables — NO LLM
  // content. EVERY *_pct / *_minutes / *_distance field is nullable (the service
  // emits null, not 0, on an empty denominator). The strict schema lives above.
  // Read-only, control-only.
  // -------------------------------------------------------------------------
  ['GET /outcome-scoreboard', { response: 'ClinicalAiOutcomeScoreboardResponse' }],

  // -------------------------------------------------------------------------
  // platform-workbench (platformWorkbenchRoutes.js) — 33 ops. AI platform
  // workbench / MLOps governance: synthetic clinical-case generator, training &
  // simulation coach, model registry + eval-run workbench, procurement
  // negotiation assistant, AI explainability dashboard, AI agent lifecycle
  // manager, hospital command center, dataset labeling studio.
  //
  // Typing (per scout r5 + ground-truth route file + verified service RETURNING
  // projections + DB CHECKs in migrations 062/065):
  //   • POST generate/evaluate/record (synthetic-case, training-module, eval-run,
  //     procurement, explainability, agent-health, command-center, labeling
  //     annotation) → loose draft/result envelope (201) → ClinicalAiDraftResponse.
  //     Each wraps a typed outer envelope around a rule/LLM-generated inner blob;
  //     every band they surface (severity / recommendation / trust_band /
  //     opportunity_category / command_status / risk_band) is config/heuristic/
  //     LLM-derived inside loose `draft` — even where the persisted eval-run /
  //     health-report table column carries a DB CHECK, the LIST/DECIDE governance
  //     rows fold loose per the T4 prediction-triad precedent.
  //   • POST /labeling/tasks → createLabelingTask returns a single normalized
  //     task row, but task_type/difficulty are NOT in the strict shortlist
  //     (free-ish / config-derived, no surfaced allowlist) → loose
  //     ClinicalAiDraftResponse (registry-ish row in the loose family, matching
  //     the T6 care-ops / T10 knowledge-governance registry precedent).
  //   • GET lists → `{ <plural>:[row], count }` (verified keys: cases / modules /
  //     runs / opportunities / reports / agents+reports / snapshots / tasks /
  //     annotations) → ClinicalAiCountListResponse.
  //   • PATCH decide ops that RETURN a row with BOTH `id` AND `reviewer_decision`
  //     (synthetic-case, training-module, eval-run, procurement, explainability,
  //     agent-health, command-snapshot) → ClinicalAiReviewDecisionResponse (loose
  //     row, additionalProperties:true).
  //   • PATCH /labeling/annotations/{id} → decideAnnotation returns
  //     `{ annotation:{id,reviewer_decision,…}, task, … }` — the row is NESTED
  //     under `annotation`, so `data` has NO top-level reviewer_decision and
  //     CANNOT satisfy ReviewDecisionRow's required:[id,reviewer_decision] →
  //     ClinicalAiGovernanceObjectResponse (per the revenue-cycle precedent).
  //   • GET /labeling/tasks/{id} → getTaskWithAnnotations returns the composite
  //     `{ task, annotations:[…], aggregate }` (single object, nested rows, NOT a
  //     `{ plural, count }` list) → ClinicalAiGovernanceObjectResponse.
  //   • THE TWO STRICT registry CRUD pairs — pure deterministic fixed-column rows
  //     (NO LLM draft) whose stage + approval_status carry real DB CHECKs
  //     (062/065) + service allowlists (STAGES/APPROVAL_STATES → 400 before
  //     upsert):
  //       POST  /model-registry           (201) → ClinicalAiModelRegistryResponse
  //                                                (data nullable: missing-schema
  //                                                 graceful degrade)
  //       GET   /model-registry                 → ClinicalAiModelRegistryListResponse
  //       PATCH /model-registry/{id}/stage      → ClinicalAiModelRegistryStageResponse
  //                                                (non-null row; 404 throw, no null)
  //       POST  /agent-registry           (201) → ClinicalAiAgentRegistryResponse
  //       GET   /agent-registry                 → ClinicalAiAgentRegistryListResponse
  //       PATCH /agent-registry/{id}/stage      → ClinicalAiAgentRegistryStageResponse
  //     (The eval-run + health-report tables also carry recommendation/severity
  //     CHECKs, but those rows wrap rule/LLM EVAL content → their LIST/DECIDE stay
  //     loose.) Control-only. Dual-mounted across both CONTROL_PREFIXES via aliasOps.
  // -------------------------------------------------------------------------

  // ---- Synthetic clinical-case generator ----
  ['POST /synthetic-cases/generate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /synthetic-cases', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /synthetic-cases/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Training & simulation coach ----
  ['POST /training/modules/generate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /training/modules', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /training/modules/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Model registry — STRICT registry CRUD + loose eval-run triad ----
  ['POST /model-registry', { response: 'ClinicalAiModelRegistryResponse' }],
  ['GET /model-registry', { response: 'ClinicalAiModelRegistryListResponse' }],
  ['PATCH /model-registry/{id}/stage', { response: 'ClinicalAiModelRegistryStageResponse' }],
  ['POST /model-registry/eval-runs', { response: 'ClinicalAiDraftResponse' }],
  ['GET /model-registry/eval-runs', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /model-registry/eval-runs/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Procurement negotiation assistant ----
  ['POST /procurement/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /procurement/opportunities', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /procurement/opportunities/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- AI explainability dashboard ----
  ['POST /explainability/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /explainability/reports', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /explainability/reports/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- AI agent lifecycle manager — STRICT registry CRUD + loose health-report triad ----
  ['POST /agent-registry', { response: 'ClinicalAiAgentRegistryResponse' }],
  ['GET /agent-registry', { response: 'ClinicalAiAgentRegistryListResponse' }],
  ['PATCH /agent-registry/{id}/stage', { response: 'ClinicalAiAgentRegistryStageResponse' }],
  ['POST /agent-registry/health-reports', { response: 'ClinicalAiDraftResponse' }],
  ['GET /agent-registry/health-reports', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /agent-registry/health-reports/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Hospital command center ----
  ['POST /command-center/evaluate', { response: 'ClinicalAiDraftResponse' }],
  ['GET /command-center/snapshots', { response: 'ClinicalAiCommandCenterSnapshotListResponse' }],
  ['PATCH /command-center/snapshots/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Dataset labeling studio ----
  // /tasks/{id} = composite { task, annotations[], aggregate } → governance object;
  // /annotations/{id} decide returns the row NESTED under `annotation` (no top-level
  // reviewer_decision) → governance object.
  ['POST /labeling/tasks', { response: 'ClinicalAiDraftResponse' }],
  ['GET /labeling/tasks', { response: 'ClinicalAiCountListResponse' }],
  ['GET /labeling/tasks/{id}', { response: 'ClinicalAiGovernanceObjectResponse' }],
  ['POST /labeling/annotations', { response: 'ClinicalAiDraftResponse' }],
  ['GET /labeling/annotations', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /labeling/annotations/{id}', { response: 'ClinicalAiGovernanceObjectResponse' }],

  // -------------------------------------------------------------------------
  // trial-safety-quality-explainers (T13). Three control sub-routers, all
  // dual-mounted flat at '/' on the aggregator (clinicalAiRoutes.js lines
  // 46/57/60), so each suffix exists at BOTH control prefixes via aliasOps:
  //   • trialSafetyOperationsRoutes.js — 18 ops: clinical-trials catalog/sync/
  //     match, RCA drafts, deterioration early-warning, polypharmacy review,
  //     operational AI (no-show / OT case-time / charge-capture).
  //   • qualityCaseRoutes.js — 2 ops: M&M/RCA standing queue (list + packet).
  //   • patientExplainersRoutes.js — 5 ops: Tier-A lay-language explainers.
  //
  // Typing (per scout r4 + r5 + ground-truth route files + verified service
  // RETURNING projections):
  //   • POST generate/score/sync/match/upsert/record/explain → loose draft /
  //     result envelope (201) → ClinicalAiDraftResponse. This covers the trial
  //     catalog upsert + registry sync, the trial-match scoring blob, every RCA
  //     draft, the deterioration / no-show / OT / charge-capture score blobs,
  //     the quality-case packet generator, and all 5 patient explainers. Every
  //     band these surface (deterioration `band` critical|concerning|watch|
  //     stable, no-show `band` high|medium|low, trial catalog `status`) is a
  //     heuristic THRESHOLD output, NOT a persisted DB CHECK column in these
  //     routes, so per the plan's "leave soft/config-derived bands plain" rule
  //     it stays inside loose `draft` — no strict schema.
  //   • GET lists → `{ <plural>:[…], count }` (verified service shapes:
  //     listTrialSyncRuns→{runs,count}; listTrialMatches→{matches,count};
  //     listRcaDrafts→{drafts,count}; listDeteriorationSnapshots→
  //     {snapshots,count}; listPolypharmacyReviews→{reviews,count};
  //     listChargeCaptureAudits→{audits,count}) → ClinicalAiCountListResponse.
  //   • PATCH decide ops split on the RETURNING column set:
  //       – decideRcaDraft / decidePolypharmacyReview / decideChargeCaptureAudit
  //         all RETURN a row carrying BOTH `id` AND `reviewer_decision` →
  //         ClinicalAiReviewDecisionResponse (loose row, additionalProperties:true).
  //       – decideTrialMatch RETURNS `coordinator_decision` (the
  //         offered|enrolled|declined|ineligible code allowlist) but NO
  //         `reviewer_decision` column, so it CANNOT satisfy ReviewDecisionRow's
  //         required:[id,reviewer_decision] → ClinicalAiGovernanceObjectResponse
  //         (per the revenue-cycle recordPayerDecision / workbench labeling
  //         decideAnnotation precedent — typed envelope, loose `data`).
  //   • THE ONE STRICT op — GET /quality/cases → listOperationalAlerts({domain:
  //     'quality'}) returns the IDENTICAL 30-column `clinical_ai_operational_
  //     alerts` row shape already typed strictly in T7, with the SAME `{ alerts,
  //     count }` envelope, so it REUSES ClinicalAiOperationalAlertListResponse
  //     verbatim (no new schema — severity / system_status / reviewer_decision
  //     DB-CHECK enums already pinned there). The /generate-packet POST returns
  //     `{ alert_id, scope_key, rca_draft_id, draft }` with an LLM-generated RCA
  //     `draft` blob → loose ClinicalAiDraftResponse.
  // Control-only (no /clinical-ai/clinical mount for any of these). Dual-mounted
  // across both CONTROL_PREFIXES via aliasOps. No new schema authored — all 25
  // ops reuse the shared loose families + the T7 operational-alert strict list.
  // -------------------------------------------------------------------------

  // ---- Clinical trials catalog + match (trialSafetyOperationsRoutes.js) ----
  ['POST /trials/catalog', { response: 'ClinicalAiDraftResponse' }],
  ['POST /trials/sync', { response: 'ClinicalAiDraftResponse' }],
  ['GET /trials/sync', { response: 'ClinicalAiCountListResponse' }],
  ['POST /trials/match/{patientUid}', { response: 'ClinicalAiDraftResponse' }],
  ['GET /trials/matches', { response: 'ClinicalAiCountListResponse' }],
  // decideTrialMatch RETURNS coordinator_decision (no reviewer_decision) → loose object.
  ['PATCH /trials/matches/{id}', { response: 'ClinicalAiGovernanceObjectResponse' }],

  // ---- RCA / M&M draft generator ----
  ['POST /rca/{id}', { response: 'ClinicalAiDraftResponse' }],
  ['GET /rca', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /rca/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Clinical safety AI — deterioration early-warning + polypharmacy ----
  ['GET /safety/deterioration', { response: 'ClinicalAiCountListResponse' }],
  ['POST /safety/deterioration/{patientUid}', { response: 'ClinicalAiDraftResponse' }],
  ['GET /safety/polypharmacy', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /safety/polypharmacy/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Operational AI — no-show / OT case-time / charge-capture ----
  ['POST /operational/no-show/{appointmentId}', { response: 'ClinicalAiDraftResponse' }],
  ['POST /operational/ot/{scheduleId}', { response: 'ClinicalAiDraftResponse' }],
  ['POST /operational/charge-capture/{id}', { response: 'ClinicalAiDraftResponse' }],
  ['GET /operational/charge-capture', { response: 'ClinicalAiCountListResponse' }],
  ['PATCH /operational/charge-capture/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],

  // ---- Quality / M&M / RCA standing queue (qualityCaseRoutes.js) ----
  // GET /quality/cases reuses the T7 operational-alert strict list (domain='quality').
  ['GET /quality/cases', { response: 'ClinicalAiOperationalAlertListResponse' }],
  ['POST /quality/cases/{alertId}/generate-packet', { response: 'ClinicalAiDraftResponse' }],

  // ---- Tier-A patient explainers (patientExplainersRoutes.js) — 5 loose drafts ----
  ['POST /lab-patient-explanations', { response: 'ClinicalAiDraftResponse' }],
  ['POST /radiology-patient-explanations', { response: 'ClinicalAiDraftResponse' }],
  ['POST /patient-report-explanations', { response: 'ClinicalAiDraftResponse' }],
  ['POST /prescription-patient-explanations', { response: 'ClinicalAiDraftResponse' }],
  ['POST /invoice-patient-explanations', { response: 'ClinicalAiDraftResponse' }],

  // -------------------------------------------------------------------------
  // overview (overviewRoutes.js) — 3 GET ops, all control-plane, dual-mounted
  // across both CONTROL_PREFIXES via aliasOps.
  //   • GET /translations    — listTranslations() → loose `{ translations, count }`
  //     blob (rows are config/jsonb translation entries, no DB-CHECK columns) →
  //     the shared count-list ClinicalAiCountListResponse.
  //   • GET /longitudinal-risk — STRICT: `{ snapshots:[row], count }` over the
  //     deterministic clinical_longitudinal_risk table, `band` DB-CHECK-pinned →
  //     ClinicalAiLongitudinalRiskListResponse.
  //   • GET /dead-letter     — `{ generations:[row], count }`: the failed-status
  //     subset projection of clinical_ai_generations. The columns are a strict
  //     SUBSET of the already-declared ClinicalAiGenerationRow (additionalProperties
  //     false, only id/task_type/status required) so the shared
  //     ClinicalAiGenerationListResponse types it exactly.
  // -------------------------------------------------------------------------
  ['GET /translations', { response: 'ClinicalAiCountListResponse' }],
  ['GET /longitudinal-risk', { response: 'ClinicalAiLongitudinalRiskListResponse' }],
  ['GET /dead-letter', { response: 'ClinicalAiGenerationListResponse' }],
];

// -------------------------------------------------------------------------
// Clinical-use ops (clinicalUseRoutes.js) — mounted ONLY at
// /api/v1/clinical-ai/clinical/* (staff Flutter surface). Keyed under the
// single CLINICAL_PREFIXES entry via aliasOps(CLINICAL_OPS, CLINICAL_PREFIXES).
//
// 20 ops, 19 paths (/discharge-compose has GET+POST). The 7 /op/* POSTs, the 5
// explainer POSTs, POST /admission-ai-draft, POST /ehr-query, POST
// /discharge-compose, and POST /discharge-compose/{runId}/resume ALL return the
// shared loose ClinicalAiDraftEnvelope / orchestration-result blob (the file's
// own doc comment: "no business-logic divergence between control + clinical
// paths" — same dischargeComposeService functions) → ClinicalAiDraftResponse.
//
// STRICT reuse (no new schema authored — the control-plane discharge-compose
// strict rows from T7 apply byte-identically here):
//   • GET  /discharge-compose         → ClinicalAiWorkflowRunListResponse
//     (raw clinical_ai_workflow_runs subset projection; status/pause_reason
//     plain VARCHAR with no DB CHECK, already plain strings on the row).
//   • GET  /discharge-compose/{runId} → ClinicalAiWorkflowRunDetailResponse
//     ({ run, children:[row], child_count } from the checkpoint store).
//   • PATCH /reviews/{id}             → ClinicalAiReviewDecisionResponse
//     (updateReview() returns the loose review/decision row).
//   • GET  /reviews                   → ClinicalAiReviewDecisionListResponse
//     (listReviews() filtered to the caller role → the shared loose-row list).
//   • GET  /op/services               → ClinicalAiGovernanceObjectResponse
//     (listOpdAiModules() returns a computed `{ modules:[...] }` enable-status
//     object whose bands are config-derived, not DB-CHECK — stays loose-object).
// -------------------------------------------------------------------------
const CLINICAL_OPS = [
  // ---- AI-draft / orchestration POSTs — shared loose envelope ----
  ['POST /admission-ai-draft', { response: 'ClinicalAiDraftResponse' }],
  ['POST /ehr-query', { response: 'ClinicalAiDraftResponse' }],
  ['POST /discharge-compose', { response: 'ClinicalAiDraftResponse' }],
  ['POST /discharge-compose/{runId}/resume', { response: 'ClinicalAiDraftResponse' }],
  // ---- OP doctor-facing AI assist — shared loose envelope ----
  ['POST /op/visit-prep', { response: 'ClinicalAiDraftResponse' }],
  ['POST /op/prescription-safety', { response: 'ClinicalAiDraftResponse' }],
  ['POST /op/investigation-review', { response: 'ClinicalAiDraftResponse' }],
  ['POST /op/differential-red-flags', { response: 'ClinicalAiDraftResponse' }],
  ['POST /op/follow-up-plan', { response: 'ClinicalAiDraftResponse' }],
  ['POST /op/referral-draft', { response: 'ClinicalAiDraftResponse' }],
  // ---- Patient-facing explainer POSTs (clinical plane) — shared loose envelope ----
  ['POST /lab-patient-explanations', { response: 'ClinicalAiDraftResponse' }],
  ['POST /radiology-patient-explanations', { response: 'ClinicalAiDraftResponse' }],
  ['POST /patient-report-explanations', { response: 'ClinicalAiDraftResponse' }],
  ['POST /prescription-patient-explanations', { response: 'ClinicalAiDraftResponse' }],
  ['POST /invoice-patient-explanations', { response: 'ClinicalAiDraftResponse' }],
  // ---- STRICT reuse (discharge-compose workflow-run rows + reviews + op services) ----
  ['GET /discharge-compose', { response: 'ClinicalAiWorkflowRunListResponse' }],
  ['GET /discharge-compose/{runId}', { response: 'ClinicalAiWorkflowRunDetailResponse' }],
  ['GET /reviews', { response: 'ClinicalAiReviewDecisionListResponse' }],
  ['PATCH /reviews/{id}', { response: 'ClinicalAiReviewDecisionResponse' }],
  ['GET /op/services', { response: 'ClinicalAiGovernanceObjectResponse' }],
];

export const operations = {
  ...aliasOps(CONTROL_OPS, CONTROL_PREFIXES),
  ...aliasOps(CLINICAL_OPS, CLINICAL_PREFIXES),
};
