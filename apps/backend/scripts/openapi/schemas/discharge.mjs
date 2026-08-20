// OpenAPI Phase 5 — Discharge-summaries overlay. Typed request/response schemas
// for the /api/v1/discharge-summaries/* surface. Authored from EXACT service
// returns; the live contract test is the proof. Mirrors the appointments slice
// shape (top-level null-free const enums + a `schemas` map + an `operations`
// map). See the design spec.
import { envelope, listEnvelope } from './_helpers.mjs';

// Real discharge enums — LOWERCASE snake_case (NOT the appointments UPPERCASE
// convention).
//   status:          discharge_summaries.status lifecycle
//                    (draft → ready_for_signoff → signed → delivered)
//   delivery_method: discharge_summaries.delivery_method
// NULL-FREE on purpose: Spectral 6.16 CRASHES on a null enum value, so even
// where the field is nullable we keep the committed enum array null-free and
// pair it with `nullable: true` (the test-only ajv helper injects null).
const DISCHARGE_STATUS = ['draft', 'ready_for_signoff', 'signed', 'delivered'];
const DELIVERY_METHOD = ['printed', 'email', 'whatsapp', 'abdm', 'sms'];

export const schemas = {
  // ---- Runtime section row -----------------------------------------------
  // A persisted discharge_summary_sections row (NOT a template definition).
  // Strict: the section row projection is a fixed column set.
  DischargeSection: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'section_key', 'section_title', 'display_order', 'body_translations'],
    properties: {
      id: { type: 'integer' },
      section_key: { type: 'string' },
      section_title: { type: 'string' },
      display_order: { type: 'integer' },
      body: { type: 'string', nullable: true },
      body_translations: { type: 'object', additionalProperties: { type: 'string' } },
      edited_by: { type: 'string', nullable: true },
      edited_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // ---- Template section definition ---------------------------------------
  // The TEMPLATE-side section shape (discharge_summary_templates.sections jsonb
  // entry) — DISTINCT from the runtime DischargeSection above. LOOSE (template
  // jsonb may carry extra authoring metadata); default_body is OPTIONAL.
  DischargeTemplateSection: {
    type: 'object',
    additionalProperties: true,
    required: ['section_key', 'section_title', 'display_order'],
    properties: {
      section_key: { type: 'string' },
      section_title: { type: 'string' },
      display_order: { type: 'integer' },
      default_body: { type: 'string' },
    },
  },

  // ---- Template definition -----------------------------------------------
  // GET /templates row. Strict: fixed column set + a sections array of the
  // template-side section definitions.
  DischargeTemplate: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'code', 'display_name', 'sections', 'active'],
    properties: {
      id: { type: 'integer' },
      code: { type: 'string' },
      display_name: { type: 'string' },
      specialty: { type: 'string', nullable: true },
      sections: { type: 'array', items: { $ref: '#/components/schemas/DischargeTemplateSection' } },
      active: { type: 'boolean' },
    },
  },

  // ---- Pending-list projection -------------------------------------------
  // GET /pending row — a REDUCED 9-key projection (NOT the full DischargeSummary
  // detail). Strict.
  DischargePendingItem: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'patient_uid', 'status', 'created_at', 'updated_at'],
    properties: {
      id: { type: 'integer' },
      patient_uid: { type: 'string' },
      patient_name_snapshot: { type: 'string', nullable: true },
      primary_diagnosis: { type: 'string', nullable: true },
      admitted_at: { type: 'string', format: 'date-time', nullable: true },
      discharged_at: { type: 'string', format: 'date-time', nullable: true },
      status: { type: 'string', enum: DISCHARGE_STATUS },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },

  // ---- Patient-list projection -------------------------------------------
  // GET /patient/{patientUid} row — a DIFFERENT reduced 8-key projection from
  // the pending list. Strict.
  DischargePatientListItem: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'status', 'created_at'],
    properties: {
      id: { type: 'integer' },
      admission_id: { type: 'integer', nullable: true },
      primary_diagnosis: { type: 'string', nullable: true },
      status: { type: 'string', enum: DISCHARGE_STATUS },
      signed_at: { type: 'string', format: 'date-time', nullable: true },
      delivered_at: { type: 'string', format: 'date-time', nullable: true },
      delivery_method: { type: 'string', nullable: true, enum: DELIVERY_METHOD },
      created_at: { type: 'string', format: 'date-time' },
    },
  },

  // ---- Canonical detail --------------------------------------------------
  // The full discharge_summaries detail row + attached sections. LOOSE
  // (additionalProperties:true): the handler returns a raw `SELECT *` row, so
  // future migrations may add columns; we keep a real CORE required set
  // [id, patient_uid, status, tenant_id, sections] + type the known props.
  DischargeSummary: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'patient_uid', 'status', 'tenant_id', 'sections'],
    properties: {
      id: { type: 'integer' },
      admission_id: { type: 'integer', nullable: true },
      patient_uid: { type: 'string' },
      patient_name_snapshot: { type: 'string', nullable: true },
      age_years_snapshot: { type: 'integer', nullable: true },
      sex_snapshot: { type: 'string', nullable: true },
      hospital_number: { type: 'string', nullable: true },
      admitted_at: { type: 'string', format: 'date-time', nullable: true },
      discharged_at: { type: 'string', format: 'date-time', nullable: true },
      ward_at_discharge: { type: 'string', nullable: true },
      primary_diagnosis: { type: 'string', nullable: true },
      secondary_diagnoses: { type: 'array', items: { type: 'string' }, nullable: true },
      icd10_codes: { type: 'array', items: { type: 'string' }, nullable: true },
      procedures_performed: { type: 'array', items: { type: 'string' }, nullable: true },
      status: { type: 'string', enum: DISCHARGE_STATUS },
      signed_by: { type: 'string', nullable: true },
      signed_by_name: { type: 'string', nullable: true },
      signed_by_reg: { type: 'string', nullable: true },
      signed_at: { type: 'string', format: 'date-time', nullable: true },
      delivered_at: { type: 'string', format: 'date-time', nullable: true },
      delivery_method: { type: 'string', nullable: true, enum: DELIVERY_METHOD },
      created_by: { type: 'string', nullable: true },
      tenant_id: { type: 'string' },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      summary_language: { type: 'string' },
      sections: { type: 'array', items: { $ref: '#/components/schemas/DischargeSection' } },
    },
  },

  // ---- Response wrappers --------------------------------------------------
  // Every route returns success(res, data) → { success, message, data, requestId }.
  DischargeSummaryResponse: envelope('DischargeSummary'),
  DischargeTemplateListResponse: listEnvelope('DischargeTemplate'),
  DischargePendingListResponse: listEnvelope('DischargePendingItem'),
  DischargePatientListResponse: listEnvelope('DischargePatientListItem'),

  // ---- Request bodies -----------------------------------------------------
  // All LOOSE (additionalProperties:true) — the controllers accept raw intake
  // with optional extras, matching the appointments raw-input convention.
  // POST / — create draft. Only patient_uid is required.
  CreateDischargeDraftRequest: {
    type: 'object',
    additionalProperties: true,
    description: 'POST /api/v1/discharge-summaries. Creates a draft; '
      + 'admission_id/template_code/specialty optional.',
    required: ['patient_uid'],
    properties: {
      patient_uid: { type: 'string' },
      admission_id: { type: 'integer' },
      primary_diagnosis: { type: 'string' },
      template_code: { type: 'string' },
      specialty: { type: 'string' },
    },
  },
  // PATCH /{id}/sections/{key} — update a section body.
  UpdateSectionRequest: {
    type: 'object',
    additionalProperties: true,
    description: 'PATCH /api/v1/discharge-summaries/{id}/sections/{key}.',
    required: ['body'],
    properties: {
      body: { type: 'string' },
    },
  },
  // PATCH /{id}/codes — replace the draft's ICD-10 code list (WP2 coding
  // enforcement; codes also mirrored into clinical_code_bindings in-tx).
  UpdateDraftCodesRequest: {
    type: 'object',
    additionalProperties: true,
    description: 'PATCH /api/v1/discharge-summaries/{id}/codes. Replaces the '
      + 'draft ICD-10 code list; draft/ready-for-signoff only.',
    required: ['icd10_codes'],
    properties: {
      icd10_codes: { type: 'array', items: { type: 'string' } },
    },
  },
  // POST /{id}/sign — no required field (route falls back to req.user.name).
  SignDischargeRequest: {
    type: 'object',
    additionalProperties: true,
    description: 'POST /api/v1/discharge-summaries/{id}/sign. Both fields '
      + 'optional; signed_by_name falls back to req.user.name.',
    properties: {
      signed_by_name: { type: 'string' },
      signed_by_reg: { type: 'string' },
    },
  },
  // POST /{id}/deliver — delivery_method required.
  DeliverDischargeRequest: {
    type: 'object',
    additionalProperties: true,
    description: 'POST /api/v1/discharge-summaries/{id}/deliver.',
    required: ['delivery_method'],
    properties: {
      delivery_method: { type: 'string', enum: DELIVERY_METHOD },
    },
  },
  // PATCH /{id}/sections/{key}/translation — language required, body optional.
  SetSectionTranslationRequest: {
    type: 'object',
    additionalProperties: true,
    description: 'PATCH /api/v1/discharge-summaries/{id}/sections/{key}/translation.',
    required: ['language'],
    properties: {
      language: { type: 'string' },
      body: { type: 'string' },
    },
  },
};

export const operations = {
  // GET /templates → list of template definitions.
  'GET /api/v1/discharge-summaries/templates': {
    response: 'DischargeTemplateListResponse',
  },
  // POST / (root alias) — renders as the bare path (verified against the live
  // generated spec: no trailing-slash variant, same as the appointments root
  // alias). Creates a draft → canonical detail envelope.
  'POST /api/v1/discharge-summaries': {
    request: 'CreateDischargeDraftRequest',
    response: 'DischargeSummaryResponse',
  },
  // GET /pending → reduced pending-list projection.
  'GET /api/v1/discharge-summaries/pending': {
    response: 'DischargePendingListResponse',
  },
  // GET /patient/{patientUid} (camelCase param) → reduced patient-list projection.
  'GET /api/v1/discharge-summaries/patient/{patientUid}': {
    response: 'DischargePatientListResponse',
  },
  // GET /{id} → canonical detail envelope.
  'GET /api/v1/discharge-summaries/{id}': {
    response: 'DischargeSummaryResponse',
  },
  // PATCH /{id}/sections/{key} ({key}, NOT {section_key}) → updated detail.
  'PATCH /api/v1/discharge-summaries/{id}/sections/{key}': {
    request: 'UpdateSectionRequest',
    response: 'DischargeSummaryResponse',
  },
  // POST /{id}/ready → detail with status=ready_for_signoff.
  'POST /api/v1/discharge-summaries/{id}/ready': {
    response: 'DischargeSummaryResponse',
  },
  // POST /{id}/sign → signed detail (no required request fields).
  'POST /api/v1/discharge-summaries/{id}/sign': {
    request: 'SignDischargeRequest',
    response: 'DischargeSummaryResponse',
  },
  // POST /{id}/deliver → delivered detail + delivery_method request.
  'POST /api/v1/discharge-summaries/{id}/deliver': {
    request: 'DeliverDischargeRequest',
    response: 'DischargeSummaryResponse',
  },
  // PATCH /{id}/sections/{key}/translation → detail with the translation merged.
  'PATCH /api/v1/discharge-summaries/{id}/sections/{key}/translation': {
    request: 'SetSectionTranslationRequest',
    response: 'DischargeSummaryResponse',
  },
  // PATCH /{id}/codes → detail with the replaced ICD-10 code list.
  'PATCH /api/v1/discharge-summaries/{id}/codes': {
    description:
      'Replaces the discharge draft\'s ICD-10 code list (draft/ready_for_signoff only). Codes run through per-surface coding enforcement (off/warn/block; warn attaches warnings, block rejects before any write) and are mirrored into clinical_code_bindings in the same transaction.',
    request: 'UpdateDraftCodesRequest',
    response: 'DischargeSummaryResponse',
  },
};
