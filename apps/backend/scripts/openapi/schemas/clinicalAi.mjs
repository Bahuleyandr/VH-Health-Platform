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
];
const CLINICAL_OPS = [];

export const operations = {
  ...aliasOps(CONTROL_OPS, CONTROL_PREFIXES),
  ...aliasOps(CLINICAL_OPS, CLINICAL_PREFIXES),
};
