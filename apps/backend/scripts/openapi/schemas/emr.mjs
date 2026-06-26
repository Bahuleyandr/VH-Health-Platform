// OpenAPI Phase 5 — EMR overlay. Typed request/response schemas for the
// /api/v1/emr/* (and its byte-identical /api/v1/admissions/* alias) surface.
// Authored from EXACT service returns; the live contract test is the proof.
// Mirrors the discharge slice shape (top-level null-free const enums + a
// `schemas` map + an `operations` map).
//
// FIRST PASS (this file) covers the **admission-detail** sub-domain. Later EMR
// sub-domains (admission-mgmt, mar, notes-diagnosis, observations, orders)
// append to THIS module — REUSE the enum consts + shared schemas declared here
// (Admission*, Ai*, Discharge*), do NOT redeclare them (no-dupe-keys / the
// generator's duplicate-schema-name guard).
//
// Alias note: admissionRoutes.js is mounted twice — at /api/v1/emr AND
// /api/v1/admissions (admissionAliasRouter) — so EVERY route renders under BOTH
// path prefixes with byte-identical `data`. The buildSpec collapser does NOT
// merge them (the literal segment differs: `emr` vs `admissions`), so both path
// keys survive in the spec. We therefore key the overlay under BOTH prefixes via
// the `aliasOps()` helper at the bottom so neither alias falls back to the
// generic Success envelope.
import { envelope } from './_helpers.mjs';

// ---------------------------------------------------------------------------
// Null-free const enums — EXACT casing from admissionService.js / the DB.
// Spectral 6.16 CRASHES on a null enum value, so every array here is null-free;
// nullable enum fields pair {type:'string',nullable:true,enum:[...]}.
// ---------------------------------------------------------------------------
// admissions.status — app-validated lifecycle (DB is varchar(50), no CHECK).
const ADMISSION_STATUS = ['admitted', 'transferred', 'discharged', 'cancelled', 'lama', 'expired'];
// admissions.admission_type
const ADMISSION_TYPE = ['elective', 'emergency', 'transfer_in', 'day_care'];
// admissions.priority
const ADMISSION_PRIORITY = ['routine', 'urgent', 'emergent'];
// admissions.code_status (DB default 'full_code')
const CODE_STATUS = ['full_code', 'dnr', 'dni', 'comfort_care'];
// admissions.discharge_type
const DISCHARGE_TYPE = ['home', 'transfer', 'lama', 'expired', 'aor'];
// admissions.room_category — the ONE DB-level CHECK (admissions_room_category_check)
const ROOM_CATEGORY = ['general', 'semi_private', 'private', 'deluxe', 'icu', 'day_care'];
// longitudinal-risk band (thresholds <30/30-59/60-84/>=85)
const RISK_BAND = ['low', 'medium', 'high', 'critical'];
// discharge-readiness blocker `type` (closed set)
const READINESS_BLOCKER_TYPE = [
  'INVALID_STATE_TRANSITION', 'NOT_MARKED_FOR_DISCHARGE', 'SUMMARY_NOT_SIGNED',
  'DRUGS_NOT_DISPENSED', 'DISCHARGE_CONSULTS_PENDING', 'NO_INVOICE', 'UNPAID_INVOICE',
  'PENDING_RESULTS', 'PENDING_RADIOLOGY', 'FOLLOWUP_NOT_BOOKED',
];
// AI safety_flags severity
const AI_SAFETY_SEVERITY = ['low', 'medium', 'high', 'critical'];
// AI review_status / session_status / update_status (+ sentinel schema_unavailable)
const AI_REVIEW_STATUS = [
  'pending', 'accepted', 'rejected', 'needs_revision', 'edited', 'schema_unavailable',
];
// discharge_consults.consult_type
const CONSULT_TYPE = ['dietary', 'family_counselling', 'pharmacy', 'physiotherapy', 'billing'];
// discharge-hub summary.ai_status
const HUB_AI_STATUS = ['schema_unavailable', 'ai_draft', 'fallback', 'rules_draft'];
// getLatestDischargeSummary source
const DISCHARGE_SUMMARY_SOURCE = ['clinical_note', 'admission'];

// A reusable opaque-jsonb schema (parsed object, never string).
const looseObject = { type: 'object', additionalProperties: true };
// A reusable opaque LLM/template draft (no required keys).
const aiDraft = { type: 'object', additionalProperties: true };
// AI safety flag entry.
const aiSafetyFlag = {
  type: 'object',
  additionalProperties: true,
  properties: {
    severity: { type: 'string', enum: AI_SAFETY_SEVERITY },
    code: { type: 'string' },
    message: { type: 'string' },
  },
};
// AI metadata block (usage left opaque).
const aiMetadata = {
  type: 'object',
  additionalProperties: true,
  properties: {
    provider: { type: 'string' },
    model: { type: 'string', nullable: true },
    tier: { type: 'string' },
    model_tier: { type: 'string' },
    used_ai: { type: 'boolean' },
    fallback_reason: { type: 'string', nullable: true },
    generation_mode: { type: 'string' },
    readiness_reason: { type: 'string', nullable: true },
    provider_status: { type: 'string' },
    usage: { type: 'object', additionalProperties: true },
    safety_review: { type: 'object', additionalProperties: true, nullable: true },
  },
};

export const schemas = {
  // =========================================================================
  // Shared admission objects
  // =========================================================================

  // ---- AdmissionRow ------------------------------------------------------
  // The ADMISSION_RETURNING_SELECT mutation-return (assign-bed / code-status /
  // attending-doctor / next-review / mark-drugs-dispensed / discharge /
  // transfer). LOOSE: `discharge` spreads an extra `los_days` onto it, so we
  // keep additionalProperties:true with a small required core. BigInt
  // package_estimated_cost_minor → ['integer','string','null'] (serialized via
  // the toJSON BigInt patch — number-vs-string depends on the serializer).
  AdmissionRow: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'patient_uid'],
    properties: {
      id: { type: 'integer' },
      tenant_id: { type: 'string', format: 'uuid' },
      encounter_id: { type: 'string', format: 'uuid', nullable: true },
      patient_uid: { type: 'string', format: 'uuid' },
      status: { type: 'string', nullable: true, enum: ADMISSION_STATUS },
      admission_type: { type: 'string', nullable: true, enum: ADMISSION_TYPE },
      admitting_doctor: { type: 'string', format: 'uuid', nullable: true },
      ward: { type: 'string', nullable: true },
      bed_id: { type: 'integer', nullable: true },
      bed_number: { type: 'string', nullable: true },
      attending_doctor: { type: 'string', format: 'uuid', nullable: true },
      admitted_at: { type: 'string', format: 'date-time', nullable: true },
      discharged_at: { type: 'string', format: 'date-time', nullable: true },
      code_status: { type: 'string', nullable: true, enum: CODE_STATUS },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      from_er_visit_id: { type: 'integer', nullable: true },
      er_arrival_at: { type: 'string', format: 'date-time', nullable: true },
      room_category: { type: 'string', nullable: true, enum: ROOM_CATEGORY },
      emergency_consent_bypass_at: { type: 'string', format: 'date-time', nullable: true },
      emergency_consent_bypass_by: { type: 'string', format: 'uuid', nullable: true },
      emergency_consent_bypass_reason: { type: 'string', nullable: true },
      policy_id: { type: 'integer', nullable: true },
      package_id: { type: 'integer', nullable: true },
      package_code: { type: 'string', nullable: true },
      // BigInt → JSON via the toJSON patch: number OR string, plus DB-nullable.
      // OAS 3.0 forbids an array `type`, so model the number|string union as
      // `oneOf` + `nullable` (the ajv helper folds nullable into an anyOf-null).
      package_estimated_cost_minor: {
        nullable: true,
        oneOf: [{ type: 'integer' }, { type: 'string' }],
      },
      govt_scheme: { type: 'string', nullable: true },
      govt_scheme_status: { type: 'string', nullable: true },
      next_review_at: { type: 'string', format: 'date-time', nullable: true },
      prior_admission_id: { type: 'integer', nullable: true },
      // discharge() adds this onto the row.
      los_days: { type: 'integer', nullable: true },
    },
  },

  // ---- AdmissionDetail ---------------------------------------------------
  // getAdmissionDetail: { ...full raw SELECT row, ...enriched }. LOOSE — the raw
  // row carries MORE columns than ADMISSION_RETURNING_SELECT (insurance_info,
  // emergency_contact, discharge_summary jsonb, chief_complaint, etc.). Embedded
  // in case-sheet + discharge-hub. PHI fields are nulled / patient_name set to
  // "Occupied" for minimized roles → patient_name string (non-null), rest
  // nullable.
  AdmissionDetail: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'patient_uid'],
    properties: {
      id: { type: 'integer' },
      tenant_id: { type: 'string', format: 'uuid' },
      encounter_id: { type: 'string', format: 'uuid', nullable: true },
      patient_uid: { type: 'string', format: 'uuid' },
      status: { type: 'string', nullable: true, enum: ADMISSION_STATUS },
      admission_type: { type: 'string', nullable: true, enum: ADMISSION_TYPE },
      priority: { type: 'string', nullable: true, enum: ADMISSION_PRIORITY },
      code_status: { type: 'string', nullable: true, enum: CODE_STATUS },
      room_category: { type: 'string', nullable: true, enum: ROOM_CATEGORY },
      discharge_type: { type: 'string', nullable: true, enum: DISCHARGE_TYPE },
      ward: { type: 'string', nullable: true },
      bed_id: { type: 'integer', nullable: true },
      bed_number: { type: 'string', nullable: true },
      admitting_doctor: { type: 'string', format: 'uuid', nullable: true },
      attending_doctor: { type: 'string', format: 'uuid', nullable: true },
      admitted_at: { type: 'string', format: 'date-time', nullable: true },
      discharged_at: { type: 'string', format: 'date-time', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      // jsonb columns → parsed objects/arrays, never string.
      insurance_info: { type: 'object', additionalProperties: true, nullable: true },
      emergency_contact: { type: 'object', additionalProperties: true, nullable: true },
      discharge_summary: { type: 'object', additionalProperties: true, nullable: true },
      allergies: { type: 'array', items: { type: 'string' }, nullable: true },
      chief_complaint: { type: 'string', nullable: true },
      admitting_diagnosis: { type: 'string', nullable: true },
      // Enriched keys (lines 3354-3380). patient_name is "Occupied" for minimized
      // roles → non-null string; remaining PHI nullable.
      patient_name: { type: 'string' },
      patient_phone: { type: 'string', nullable: true },
      patient_hospital_number: { type: 'string', nullable: true },
      hospital_number: { type: 'string', nullable: true },
      patient_gender: { type: 'string', nullable: true },
      patient_email: { type: 'string', nullable: true },
      patient_birthday: { type: 'string', nullable: true },
      bed_ward_name: { type: 'string', nullable: true },
      admitting_doctor_name: { type: 'string', nullable: true },
      attending_doctor_name: { type: 'string', nullable: true },
      los_days: { type: 'integer', nullable: true },
      prior_admission: { type: 'object', additionalProperties: true, nullable: true },
    },
  },

  // ---- DischargeConsultRow ----------------------------------------------
  // Raw discharge_consults Prisma row (consults/{consultType}/complete). STRICT.
  DischargeConsultRow: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'admission_id', 'patient_uid', 'consult_type'],
    properties: {
      id: { type: 'integer' },
      admission_id: { type: 'integer' },
      patient_uid: { type: 'string', format: 'uuid' },
      consult_type: { type: 'string', enum: CONSULT_TYPE },
      requested_at: { type: 'string', format: 'date-time' },
      requested_by: { type: 'string', format: 'uuid', nullable: true },
      completed_at: { type: 'string', format: 'date-time', nullable: true },
      completed_by: { type: 'string', format: 'uuid', nullable: true },
      notes: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      tenant_id: { type: 'string', format: 'uuid' },
    },
  },

  // ---- DischargeReadiness -----------------------------------------------
  // The rules readiness object (inside discharge-hub + discharge-readiness rules
  // portion). LOOSE on blocker extras; checklist is a fixed 11-bool map.
  DischargeReadiness: {
    type: 'object',
    additionalProperties: true,
    required: ['admission_id', 'patient_uid', 'ready'],
    properties: {
      admission_id: { type: 'integer' },
      patient_uid: { type: 'string', format: 'uuid' },
      encounter_id: { type: 'string', format: 'uuid', nullable: true },
      discharge_type: { type: 'string', nullable: true, enum: DISCHARGE_TYPE },
      admission_status: { type: 'string' },
      gated: { type: 'boolean' },
      transition_allowed: { type: 'boolean' },
      ready: { type: 'boolean' },
      checklist: {
        type: 'object',
        additionalProperties: true,
        properties: {
          status_transition_allowed: { type: 'boolean' },
          gated_discharge_type: { type: 'boolean' },
          marked_for_discharge: { type: 'boolean' },
          discharge_summary_signed: { type: 'boolean' },
          discharge_work_items_completed: { type: 'boolean' },
          discharge_drugs_dispensed: { type: 'boolean' },
          finalized_invoice_exists: { type: 'boolean' },
          invoice_balance_clear: { type: 'boolean' },
          investigations_resolved: { type: 'boolean' },
          radiology_resolved: { type: 'boolean' },
          follow_up_booked: { type: 'boolean' },
        },
      },
      blockers: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          required: ['type'],
          properties: {
            type: { type: 'string', enum: READINESS_BLOCKER_TYPE },
            message: { type: 'string' },
          },
        },
      },
      blocker_count: { type: 'integer' },
      rules_authoritative: { type: 'boolean' },
    },
  },

  // ---- EmrDischargeSummary -----------------------------------------------
  // getLatestDischargeSummary detail (content jsonb → object). LOOSE.
  // NAMED EmrDischargeSummary (not DischargeSummary) — the discharge.mjs slice
  // already owns a distinct `DischargeSummary` schema (the
  // /discharge-summaries/* surface); the generator errors on duplicate names.
  EmrDischargeSummary: {
    type: 'object',
    additionalProperties: true,
    required: ['source', 'title', 'content'],
    properties: {
      source: { type: 'string', enum: DISCHARGE_SUMMARY_SOURCE },
      note_id: { type: 'integer', nullable: true },
      title: { type: 'string' },
      version: { type: 'integer', nullable: true },
      content: { type: 'object', additionalProperties: true },
      is_signed: { type: 'boolean' },
      signed_by: { type: 'string', format: 'uuid', nullable: true },
      signed_by_name: { type: 'string', nullable: true },
      signed_by_role: { type: 'string', nullable: true },
      signed_at: { type: 'string', format: 'date-time', nullable: true },
      author_uid: { type: 'string', format: 'uuid', nullable: true },
      author_role: { type: 'string', nullable: true },
      ai_generation_id: { type: 'integer', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
      ai_metadata: { type: 'object', additionalProperties: true, nullable: true },
      safety_flags: { type: 'array', items: aiSafetyFlag },
      source_citations: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
  },

  // ---- CaseSheet ---------------------------------------------------------
  // case-sheet content card (content jsonb → object). LOOSE.
  CaseSheet: {
    type: 'object',
    additionalProperties: true,
    required: ['note_id', 'content', 'version'],
    properties: {
      note_id: { type: 'integer' },
      title: { type: 'string', nullable: true },
      content: { type: 'object', additionalProperties: true },
      version: { type: 'integer' },
      author_uid: { type: 'string', format: 'uuid', nullable: true },
      author_role: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },

  // ---- AiDraftEnvelope ---------------------------------------------------
  // standardDraftResponse canonical envelope shared by 7 AI ops + ward-round-
  // brief. LOOSE; `draft` opaque (no required keys), ai_metadata.usage opaque.
  AiDraftEnvelope: {
    type: 'object',
    additionalProperties: true,
    required: ['draft', 'module_key'],
    properties: {
      draft: aiDraft,
      module_key: { type: 'string' },
      prompt_version: { type: 'string' },
      source_citations: { type: 'array', items: { type: 'object', additionalProperties: true } },
      safety_flags: { type: 'array', items: aiSafetyFlag },
      ai_metadata: aiMetadata,
      review_status: { type: 'string', enum: AI_REVIEW_STATUS },
      review_id: { type: 'integer', nullable: true },
      generation_id: { type: 'integer', nullable: true },
      draft_generation_id: { type: 'integer', nullable: true },
      requires_signoff: { type: 'boolean' },
    },
  },

  // ---- LongitudinalRiskRow (GET) -----------------------------------------
  // getLatestRisk — flat DB row of clinical_longitudinal_risk. numeric scores
  // are JS numbers here per the scout (service maps to number). jsonb sub-objects
  // → object/array. LOOSE.
  LongitudinalRiskRow: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'patient_uid', 'overall_score', 'band'],
    properties: {
      id: { type: 'integer' },
      tenant_id: { type: 'string', format: 'uuid' },
      patient_uid: { type: 'string', format: 'uuid' },
      admission_id: { type: 'integer' },
      overall_score: { type: 'number' },
      band: { type: 'string', enum: RISK_BAND },
      adherence_score: { type: 'number', nullable: true },
      adherence_source: { type: 'string', nullable: true },
      readmission_score: { type: 'number', nullable: true },
      comorbidity_score: { type: 'number', nullable: true },
      abdm_enrichment: { type: 'object', additionalProperties: true, nullable: true },
      contributors: { type: 'object', additionalProperties: true, nullable: true },
      recommendations: { type: 'array', items: { type: 'object', additionalProperties: true } },
      created_at: { type: 'string', format: 'date-time' },
    },
  },

  // ---- LongitudinalRiskScore (POST) --------------------------------------
  // scoreLongitudinalRisk — DISTINCT from GET: nested adherence:{score,band,
  // source} + snapshot_id + generated_at + module_key. LOOSE on jsonb sub-objects.
  LongitudinalRiskScore: {
    type: 'object',
    additionalProperties: true,
    required: ['patient_uid', 'admission_id', 'overall_score', 'band'],
    properties: {
      snapshot_id: { type: 'integer', nullable: true },
      tenant_id: { type: 'string', format: 'uuid' },
      patient_uid: { type: 'string', format: 'uuid' },
      admission_id: { type: 'integer' },
      overall_score: { type: 'number' },
      band: { type: 'string', enum: RISK_BAND },
      adherence: {
        type: 'object',
        additionalProperties: true,
        properties: {
          score: { type: 'number' },
          band: { type: 'string', nullable: true },
          source: { type: 'string' },
        },
      },
      readmission_score: { type: 'number', nullable: true },
      comorbidity_score: { type: 'number', nullable: true },
      abdm_enrichment: { type: 'object', additionalProperties: true, nullable: true },
      contributors: { type: 'object', additionalProperties: true, nullable: true },
      recommendations: { type: 'array', items: { type: 'object', additionalProperties: true } },
      module_key: { type: 'string' },
      generated_at: { type: 'string', format: 'date-time' },
      decision_support_only: { type: 'boolean' },
    },
  },

  // =========================================================================
  // Per-endpoint `data` payloads
  // =========================================================================

  // { admission: AdmissionRow } — assign-bed / attending-doctor / code-status /
  // next-review / transfer / discharge / mark-drugs-dispensed.
  AdmissionMutationData: {
    type: 'object',
    additionalProperties: true,
    required: ['admission'],
    properties: { admission: { $ref: '#/components/schemas/AdmissionRow' } },
  },

  // GET /admission/{id} → { admission: AdmissionDetail }.
  AdmissionDetailData: {
    type: 'object',
    additionalProperties: true,
    required: ['admission'],
    properties: { admission: { $ref: '#/components/schemas/AdmissionDetail' } },
  },

  // GET /{id}/case-sheet → { admission: AdmissionDetail, case_sheet: CaseSheet|null }.
  CaseSheetData: {
    type: 'object',
    additionalProperties: true,
    required: ['admission'],
    properties: {
      admission: { $ref: '#/components/schemas/AdmissionDetail' },
      case_sheet: { nullable: true, allOf: [{ $ref: '#/components/schemas/CaseSheet' }] },
    },
  },

  // PUT /{id}/case-sheet → save result (admission_routed_fields + case_sheet are
  // normalized jsonb objects; vitals stored as STRINGS here). LOOSE.
  CaseSheetSaveData: {
    type: 'object',
    additionalProperties: true,
    required: ['note_id', 'version', 'action'],
    properties: {
      note_id: { type: 'integer' },
      version: { type: 'integer' },
      action: { type: 'string', enum: ['created', 'updated'] },
      admission_routed_fields: { type: 'object', additionalProperties: true },
      case_sheet: { type: 'object', additionalProperties: true },
    },
  },

  // POST /{id}/mark-for-discharge → 5-key cascade (201). LOOSE.
  MarkForDischargeData: {
    type: 'object',
    additionalProperties: true,
    required: ['admission'],
    properties: {
      admission: { $ref: '#/components/schemas/AdmissionRow' },
      summary: { nullable: true, allOf: [{ $ref: '#/components/schemas/EmrDischargeSummary' }] },
      consults: { type: 'array', items: { $ref: '#/components/schemas/DischargeConsultRow' } },
      finalClaim: { type: 'object', additionalProperties: true, nullable: true },
      attending_doctors: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
  },

  // POST /{id}/consults/{consultType}/complete → { consult: DischargeConsultRow }.
  ConsultCompleteData: {
    type: 'object',
    additionalProperties: false,
    required: ['consult'],
    properties: { consult: { $ref: '#/components/schemas/DischargeConsultRow' } },
  },

  // GET /{id}/discharge-summary → { discharge_summary: DischargeSummary|null }.
  DischargeSummaryData: {
    type: 'object',
    additionalProperties: true,
    required: ['discharge_summary'],
    properties: {
      discharge_summary: { nullable: true, allOf: [{ $ref: '#/components/schemas/EmrDischargeSummary' }] },
    },
  },

  // PUT /{id}/discharge-summary → { noteId, action } (camelCase!). STRICT.
  DischargeSummarySaveData: {
    type: 'object',
    additionalProperties: false,
    required: ['noteId', 'action'],
    properties: {
      noteId: { type: 'integer' },
      action: { type: 'string', enum: ['created', 'updated'] },
    },
  },

  // POST /{id}/discharge-summary/sign → sign result (camelCase!). STRICT.
  DischargeSummarySignData: {
    type: 'object',
    additionalProperties: false,
    required: ['noteId', 'signed'],
    properties: {
      noteId: { type: 'integer' },
      signed: { type: 'boolean' },
      signedBy: { type: 'string', format: 'uuid' },
      signedByName: { type: 'string', nullable: true },
      signedByRole: { type: 'string', nullable: true },
      signedAt: { type: 'string', format: 'date-time' },
    },
  },

  // POST /{id}/discharge-summary/generate → { discharge_summary, is_draft:true }.
  // AI-influenced structured summary — LOOSE inner with a small required core.
  DischargeSummaryGenerateData: {
    type: 'object',
    additionalProperties: true,
    required: ['discharge_summary', 'is_draft'],
    properties: {
      discharge_summary: {
        type: 'object',
        additionalProperties: true,
        required: ['generated_at'],
        properties: {
          is_draft: { type: 'boolean' },
          is_signed: { type: 'boolean' },
          generated_at: { type: 'string', format: 'date-time' },
          ai_metadata: { type: 'object', additionalProperties: true },
          safety_flags: { type: 'array', items: aiSafetyFlag },
          source_citations: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      is_draft: { type: 'boolean' },
    },
  },

  // GET /{id}/discharge-hub → composite. LOOSE (embeds AdmissionDetail +
  // DischargeReadiness + summary card).
  DischargeHubData: {
    type: 'object',
    additionalProperties: true,
    required: ['admission'],
    properties: {
      admission: { $ref: '#/components/schemas/AdmissionDetail' },
      discharge_initiated: { type: 'boolean' },
      work_items: { type: 'array', items: { type: 'object', additionalProperties: true } },
      work_item_counts: {
        type: 'object',
        additionalProperties: true,
        properties: {
          total: { type: 'integer' },
          completed: { type: 'integer' },
          pending: { type: 'integer' },
        },
      },
      summary: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ai_status: { type: 'string', enum: HUB_AI_STATUS },
          ai_label: { type: 'string', nullable: true },
          source_citation_count: { type: 'integer' },
          safety_flag_count: { type: 'integer' },
        },
      },
      readiness: { $ref: '#/components/schemas/DischargeReadiness' },
      actor: {
        type: 'object',
        additionalProperties: true,
        properties: {
          uid: { type: 'string', nullable: true },
          role: { type: 'string', nullable: true },
          can_edit_summary: { type: 'boolean' },
          can_sign_summary: { type: 'boolean' },
          can_mark_drugs_dispensed: { type: 'boolean' },
          can_complete_any_work_item: { type: 'boolean' },
        },
      },
    },
  },

  // GET /discharge-hub (list) → array of DischargeHubData-shaped composites +
  // count. The handler wraps { admissions:[...], count }. LOOSE.
  DischargeHubListData: {
    type: 'object',
    additionalProperties: true,
    required: ['admissions'],
    properties: {
      admissions: { type: 'array', items: { type: 'object', additionalProperties: true } },
      count: { type: 'integer' },
    },
  },

  // GET /{id}/discharge-readiness → AiDraftEnvelope + rules_authoritative +
  // rules_readiness (AI `draft` portion opaque). LOOSE.
  DischargeReadinessData: {
    type: 'object',
    additionalProperties: true,
    required: ['draft'],
    properties: {
      draft: aiDraft,
      module_key: { type: 'string' },
      prompt_version: { type: 'string' },
      review_status: { type: 'string' },
      requires_signoff: { type: 'boolean' },
      source_citations: { type: 'array', items: { type: 'object', additionalProperties: true } },
      safety_flags: { type: 'array', items: aiSafetyFlag },
      ai_metadata: aiMetadata,
      rules_authoritative: { type: 'boolean' },
      rules_readiness: { $ref: '#/components/schemas/DischargeReadiness' },
    },
  },

  // GET /{id}/longitudinal-risk → flat row.
  LongitudinalRiskRowData: { $ref: '#/components/schemas/LongitudinalRiskRow' },
  // POST /{id}/longitudinal-risk → nested score.
  LongitudinalRiskScoreData: { $ref: '#/components/schemas/LongitudinalRiskScore' },

  // POST /{id}/ai/teach-back → teach-back session draft (201). LOOSE; draft opaque.
  TeachBackSessionDraftData: {
    type: 'object',
    additionalProperties: true,
    required: ['draft'],
    properties: {
      session_id: { type: 'integer', nullable: true },
      generation_id: { type: 'integer', nullable: true },
      clinical_review_id: { type: 'integer', nullable: true },
      draft: aiDraft,
      session: { type: 'object', additionalProperties: true, nullable: true },
      source_citations: { type: 'array', items: { type: 'object', additionalProperties: true } },
      safety_flags: { type: 'array', items: aiSafetyFlag },
      module_key: { type: 'string' },
      prompt_version: { type: 'string' },
      session_status: { type: 'string' },
      review_status: { type: 'string', enum: AI_REVIEW_STATUS },
      requires_signoff: { type: 'boolean' },
      ai_metadata: { type: 'object', additionalProperties: true },
      rules_authoritative: { type: 'boolean' },
      decision_support_only: { type: 'boolean' },
      language: { type: 'string' },
    },
  },

  // POST /teach-back/{sessionId}/answers → raw jsonb session row + evaluated_answers.
  // LOOSE; draft/session opaque.
  TeachBackAnswersData: {
    type: 'object',
    additionalProperties: true,
    required: ['session'],
    properties: {
      session: { type: 'object', additionalProperties: true },
      evaluated_answers: { type: 'array', items: { type: 'object', additionalProperties: true } },
      status: { type: 'string' },
    },
  },

  // POST /{id}/ai/family-update → family update (201). LOOSE; draft opaque.
  FamilyUpdateSessionData: {
    type: 'object',
    additionalProperties: true,
    required: ['draft'],
    properties: {
      update_id: { type: 'integer', nullable: true },
      generation_id: { type: 'integer', nullable: true },
      clinical_review_id: { type: 'integer', nullable: true },
      draft: aiDraft,
      update: { type: 'object', additionalProperties: true, nullable: true },
      consent_scope: { type: 'object', additionalProperties: true, nullable: true },
      source_citations: { type: 'array', items: { type: 'object', additionalProperties: true } },
      safety_flags: { type: 'array', items: aiSafetyFlag },
      module_key: { type: 'string' },
      prompt_version: { type: 'string' },
      update_status: { type: 'string' },
      review_status: { type: 'string', enum: AI_REVIEW_STATUS },
      requires_signoff: { type: 'boolean' },
      ai_metadata: { type: 'object', additionalProperties: true },
      rules_authoritative: { type: 'boolean' },
      decision_support_only: { type: 'boolean' },
      language: { type: 'string' },
      caregiver_relationship: { type: 'string' },
    },
  },

  // POST /{id}/ai/nursing-ambient → nursing ambient session (201). LOOSE; draft opaque.
  NursingAmbientSessionData: {
    type: 'object',
    additionalProperties: true,
    required: ['draft'],
    properties: {
      session_id: { type: 'integer', nullable: true },
      generation_id: { type: 'integer', nullable: true },
      clinical_review_id: { type: 'integer', nullable: true },
      draft: aiDraft,
      session: { type: 'object', additionalProperties: true, nullable: true },
      source_citations: { type: 'array', items: { type: 'object', additionalProperties: true } },
      safety_flags: { type: 'array', items: aiSafetyFlag },
      module_key: { type: 'string' },
      prompt_version: { type: 'string' },
      session_status: { type: 'string' },
      review_status: { type: 'string', enum: AI_REVIEW_STATUS },
      requires_signoff: { type: 'boolean' },
      ai_metadata: { type: 'object', additionalProperties: true },
      rules_authoritative: { type: 'boolean' },
      decision_support_only: { type: 'boolean' },
      shift: { type: 'string' },
    },
  },

  // =========================================================================
  // Response envelopes (success(res,data) → { success, message, data })
  // =========================================================================
  EmrAdmissionMutationResponse: envelope('AdmissionMutationData'),
  EmrAdmissionDetailResponse: envelope('AdmissionDetailData'),
  EmrCaseSheetResponse: envelope('CaseSheetData'),
  EmrCaseSheetSaveResponse: envelope('CaseSheetSaveData'),
  EmrMarkForDischargeResponse: envelope('MarkForDischargeData'),
  EmrConsultCompleteResponse: envelope('ConsultCompleteData'),
  EmrDischargeSummaryResponse: envelope('DischargeSummaryData'),
  EmrDischargeSummarySaveResponse: envelope('DischargeSummarySaveData'),
  EmrDischargeSummarySignResponse: envelope('DischargeSummarySignData'),
  EmrDischargeSummaryGenerateResponse: envelope('DischargeSummaryGenerateData'),
  EmrDischargeHubResponse: envelope('DischargeHubData'),
  EmrDischargeHubListResponse: envelope('DischargeHubListData'),
  EmrDischargeReadinessResponse: envelope('DischargeReadinessData'),
  EmrLongitudinalRiskRowResponse: envelope('LongitudinalRiskRowData'),
  EmrLongitudinalRiskScoreResponse: envelope('LongitudinalRiskScoreData'),
  EmrAiDraftResponse: envelope('AiDraftEnvelope'),
  EmrTeachBackSessionDraftResponse: envelope('TeachBackSessionDraftData'),
  EmrTeachBackAnswersResponse: envelope('TeachBackAnswersData'),
  EmrFamilyUpdateResponse: envelope('FamilyUpdateSessionData'),
  EmrNursingAmbientResponse: envelope('NursingAmbientSessionData'),

  // =========================================================================
  // Request bodies — all LOOSE (controllers accept raw intake + extras).
  // =========================================================================
  EmrAssignBedRequest: {
    type: 'object', additionalProperties: true, required: ['bed_id'],
    properties: { bed_id: { type: 'integer' } },
  },
  EmrAttendingDoctorRequest: {
    type: 'object', additionalProperties: true, required: ['attending_doctor'],
    properties: { attending_doctor: { type: 'string', format: 'uuid' } },
  },
  EmrCodeStatusRequest: {
    type: 'object', additionalProperties: true, required: ['code_status'],
    properties: { code_status: { type: 'string', enum: CODE_STATUS } },
  },
  EmrNextReviewRequest: {
    type: 'object', additionalProperties: true,
    properties: { next_review_at: { type: 'string', format: 'date-time', nullable: true } },
  },
  EmrTransferRequest: {
    type: 'object', additionalProperties: true, required: ['bed_id'],
    properties: {
      bed_id: { type: 'integer' },
      ward: { type: 'string' },
    },
  },
  EmrDischargeRequest: {
    type: 'object', additionalProperties: true, required: ['discharge_type'],
    properties: { discharge_type: { type: 'string', enum: DISCHARGE_TYPE } },
  },
  EmrMarkForDischargeRequest: looseObject,
  EmrCaseSheetSaveRequest: looseObject,
  EmrDischargeSummarySaveRequest: looseObject,
  EmrConsultCompleteRequest: {
    type: 'object', additionalProperties: true,
    properties: { notes: { type: 'string' } },
  },
  EmrAiDraftRequest: looseObject,
  EmrWardRoundBriefRequest: {
    type: 'object', additionalProperties: true,
    properties: { ward: { type: 'string' }, limit: { type: 'integer' } },
  },
  EmrLongitudinalRiskRequest: looseObject,
  EmrTeachBackAnswersRequest: {
    type: 'object', additionalProperties: true, required: ['answers'],
    properties: { answers: { type: 'array', items: { type: 'object', additionalProperties: true } } },
  },
  EmrTeachBackGenerateRequest: {
    type: 'object', additionalProperties: true,
    properties: {
      patient_uid: { type: 'string', format: 'uuid' },
      language: { type: 'string' },
      source_generation_id: { type: 'integer' },
    },
  },
  EmrFamilyUpdateRequest: {
    type: 'object', additionalProperties: true, required: ['patient_uid'],
    properties: {
      patient_uid: { type: 'string', format: 'uuid' },
      caregiver_relationship: { type: 'string' },
      language: { type: 'string' },
    },
  },
  EmrNursingAmbientRequest: {
    type: 'object', additionalProperties: true, required: ['patient_uid'],
    properties: {
      patient_uid: { type: 'string', format: 'uuid' },
      shift: { type: 'string' },
      transcript_segments: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
  },
};

// ---------------------------------------------------------------------------
// Operations — keyed under BOTH the /api/v1/emr and /api/v1/admissions prefixes
// (the route is mounted twice; both path keys survive the spec collapse). Each
// entry below is a [suffix, overlay] pair; aliasOps() fans it out to both.
// ---------------------------------------------------------------------------
const OPS = [
  // GET /admission/{id}
  ['GET /admission/{id}', { response: 'EmrAdmissionDetailResponse' }],
  // GET /discharge-hub (list)
  ['GET /discharge-hub', { response: 'EmrDischargeHubListResponse' }],
  // POST /ward-round-brief (AI; envelope typed, draft loose)
  ['POST /ward-round-brief', { request: 'EmrWardRoundBriefRequest', response: 'EmrAiDraftResponse' }],
  // POST /teach-back/{sessionId}/answers (AI; session loose)
  ['POST /teach-back/{sessionId}/answers', { request: 'EmrTeachBackAnswersRequest', response: 'EmrTeachBackAnswersResponse' }],
  // Mutations → { admission: AdmissionRow }
  ['POST /{id}/assign-bed', { request: 'EmrAssignBedRequest', response: 'EmrAdmissionMutationResponse' }],
  ['PUT /{id}/attending-doctor', { request: 'EmrAttendingDoctorRequest', response: 'EmrAdmissionMutationResponse' }],
  ['PUT /{id}/code-status', { request: 'EmrCodeStatusRequest', response: 'EmrAdmissionMutationResponse' }],
  ['PUT /{id}/next-review', { request: 'EmrNextReviewRequest', response: 'EmrAdmissionMutationResponse' }],
  ['POST /{id}/transfer', { request: 'EmrTransferRequest', response: 'EmrAdmissionMutationResponse' }],
  ['POST /{id}/discharge', { request: 'EmrDischargeRequest', response: 'EmrAdmissionMutationResponse' }],
  ['POST /{id}/mark-drugs-dispensed', { response: 'EmrAdmissionMutationResponse' }],
  // Cascade + case-sheet + consults
  ['POST /{id}/mark-for-discharge', { request: 'EmrMarkForDischargeRequest', response: 'EmrMarkForDischargeResponse' }],
  ['GET /{id}/case-sheet', { response: 'EmrCaseSheetResponse' }],
  ['PUT /{id}/case-sheet', { request: 'EmrCaseSheetSaveRequest', response: 'EmrCaseSheetSaveResponse' }],
  ['POST /{id}/consults/{consultType}/complete', { request: 'EmrConsultCompleteRequest', response: 'EmrConsultCompleteResponse' }],
  // Discharge summary
  ['GET /{id}/discharge-summary', { response: 'EmrDischargeSummaryResponse' }],
  ['PUT /{id}/discharge-summary', { request: 'EmrDischargeSummarySaveRequest', response: 'EmrDischargeSummarySaveResponse' }],
  ['POST /{id}/discharge-summary/generate', { response: 'EmrDischargeSummaryGenerateResponse' }],
  ['POST /{id}/discharge-summary/sign', { response: 'EmrDischargeSummarySignResponse' }],
  // Discharge hub (single) + readiness
  ['GET /{id}/discharge-hub', { response: 'EmrDischargeHubResponse' }],
  ['GET /{id}/discharge-readiness', { response: 'EmrDischargeReadinessResponse' }],
  // Longitudinal risk (GET flat vs POST nested — distinct)
  ['GET /{id}/longitudinal-risk', { response: 'EmrLongitudinalRiskRowResponse' }],
  ['POST /{id}/longitudinal-risk', { request: 'EmrLongitudinalRiskRequest', response: 'EmrLongitudinalRiskScoreResponse' }],
  // 7 AiDraftEnvelope ops (draft loose)
  ['POST /{id}/medication-reconciliation', { request: 'EmrAiDraftRequest', response: 'EmrAiDraftResponse' }],
  ['POST /{id}/referral-letter', { request: 'EmrAiDraftRequest', response: 'EmrAiDraftResponse' }],
  ['POST /{id}/aftercare-instructions', { request: 'EmrAiDraftRequest', response: 'EmrAiDraftResponse' }],
  ['POST /{id}/abnormal-result-triage', { request: 'EmrAiDraftRequest', response: 'EmrAiDraftResponse' }],
  ['POST /{id}/clinical-coding-assist', { request: 'EmrAiDraftRequest', response: 'EmrAiDraftResponse' }],
  ['POST /{id}/quality-case-review', { request: 'EmrAiDraftRequest', response: 'EmrAiDraftResponse' }],
  ['POST /{id}/ai/patient-record-summary', { request: 'EmrAiDraftRequest', response: 'EmrAiDraftResponse' }],
  // AI sessions (201; draft/session loose)
  ['POST /{id}/ai/family-update', { request: 'EmrFamilyUpdateRequest', response: 'EmrFamilyUpdateResponse' }],
  ['POST /{id}/ai/nursing-ambient', { request: 'EmrNursingAmbientRequest', response: 'EmrNursingAmbientResponse' }],
  ['POST /{id}/ai/teach-back', { request: 'EmrTeachBackGenerateRequest', response: 'EmrTeachBackSessionDraftResponse' }],
];

const PREFIXES = ['/api/v1/emr', '/api/v1/admissions'];

/** Fan each [«METHOD /suffix», overlay] out to both mount prefixes. */
function aliasOps(pairs) {
  const out = {};
  for (const [methodSuffix, ov] of pairs) {
    const spaceIdx = methodSuffix.indexOf(' ');
    const method = methodSuffix.slice(0, spaceIdx);
    const suffix = methodSuffix.slice(spaceIdx + 1);
    for (const pre of PREFIXES) out[`${method} ${pre}${suffix}`] = ov;
  }
  return out;
}

export const operations = aliasOps(OPS);
