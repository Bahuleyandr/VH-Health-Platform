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
import { envelope, listEnvelope } from './_helpers.mjs';

const idempotencyKeyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    pattern: '^[A-Za-z0-9_\\-:.]+$',
  },
  description: 'Required durable command identity; reuse is valid only for the exact same tenant, actor, role, order, and body.',
};
const authenticatedSecurity = [{ ApiKeyAuth: [], BearerAuth: [] }];
const medicationWardSupplyDetails = {
  type: 'object',
  additionalProperties: true,
  required: ['catalog_id', 'dose', 'route', 'quantity_requested', 'unit'],
  description:
    'Every MAR-bound medication order requires catalog_id, dose, route, quantity_requested, and unit together. They are the order-owned medication and ward-supply authority used to create the MAR and exact pharmacy indent; free-form substitutions or inferred quantities are rejected.',
  properties: {
    catalog_id: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
    dose: { type: 'string', minLength: 1 },
    route: { type: 'string', minLength: 1 },
    quantity_requested: {
      type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 99_999_999.99, multipleOf: 0.01,
    },
    unit: {
      type: 'string',
      enum: [
        'tablet', 'capsule', 'ampoule', 'vial', 'bag', 'prefilled syringe',
        'cartridge', 'mL', 'dose', 'patch', 'actuation', 'spray', 'application',
        'bottle', 'tube', 'sachet', 'suppository', 'drop', 'kit', 'each',
      ],
    },
  },
};
const emrErrorResponse = description => ({
  description,
  content: {
    'application/json': { schema: { $ref: '#/components/schemas/EmrErrorResponse' } },
  },
});

// ---------------------------------------------------------------------------
// Null-free const enums — EXACT casing from admissionService.js / the DB.
// Spectral 6.16 CRASHES on a null enum value, so every array here is null-free;
// nullable enum fields pair {type:'string',nullable:true,enum:[...]}.
// ---------------------------------------------------------------------------
// admissions.status — app-validated lifecycle (DB is varchar(50), no CHECK).
const ADMISSION_STATUS = ['admitted', 'transferred', 'discharged', 'cancelled', 'lama', 'expired'];
// admissions.admission_type — FREE-FORM varchar (NO DB CHECK, NO app-layer
// validation in admitPatient): live data carries 'inpatient'/'planned' (legacy
// seed) plus app-written 'emergency', so any enum rejects real rows. Typed as a
// plain nullable string on every admission schema (was a too-narrow guess).
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
  'STRUCTURED_SUMMARY_NOT_SIGNED',
  'PATIENT_GUARDIAN_INSTRUCTIONS_REQUIRED',
  'ESCALATION_CONTACT_REQUIRED',
  'EQUIPMENT_HOME_CARE_PLAN_REQUIRED',
  'DISCHARGE_DESTINATION_REQUIRED',
  'TRANSPORT_PLAN_REQUIRED',
  'EXTERNAL_TRANSFER_BRANCH_DEFERRED',
  'INPATIENT_OWNER_ASSIGNMENT_DIVERGED',
  'FORMAL_DISCHARGE_MEDICATION_RECONCILIATION_REQUIRED',
  'ADMISSION_FOLLOW_UP_OR_EXCEPTION_REQUIRED',
  'PENDING_RESULT_PROJECTION_NOT_READY',
  'PENDING_RESULT_HANDOFF_INCOMPLETE',
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

// ---------------------------------------------------------------------------
// admission-mgmt sub-domain enums (null-free; EXACT casing from
// admissionService.js / patientCommandBoardService.js / the AI services).
// ---------------------------------------------------------------------------
// bed.status (bed-options / command-board location.bed_status) — lowercase.
// Aligned EXACTLY to the DB CHECK `beds_status_check` (was a too-narrow guess of
// only available/occupied/cleaning).
const BED_STATUS = ['available', 'occupied', 'reserved', 'maintenance', 'cleaning', 'dirty'];
// ward-options heterogeneous source discriminator.
const WARD_SOURCE = ['wards', 'fallback'];
// admission lookup result branch.
const LOOKUP_STATE = [
  'multiple_matches', 'new_patient', 'returning_ip_patient', 'known_patient_no_prior_ip',
];
// translation result status.
const TRANSLATION_STATUS = ['completed', 'needs_review'];
// clinical-ai/config provider + supportedProviders.
const CLINICAL_AI_PROVIDER = ['template', 'ollama', 'openai-compatible', 'openai', 'anthropic'];
// command-board governance.ai_state (fallback-only today; kept null-free + loose
// elsewhere so a future state can't break the contract — the field is typed
// {type:'string'} on the row, not enum-bound).

// ---------------------------------------------------------------------------
// notes-diagnosis sub-domain enums (null-free; EXACT casing from
// clinicalNotesService.js VALID_NOTE_TYPES / diagnosisService.js /
// clinicalCodeBindingService.js). All app-layer-validated VARCHAR (no DB CHECK).
// ---------------------------------------------------------------------------
// clinical_notes.note_type — VALID_NOTE_TYPES (clinicalNotesService lines 28-39).
// Used ONLY on REQUEST bodies: createNote() rejects off-list values (400), so the
// accepted-input contract is closed. The RESPONSE schemas type note_type as a
// plain string, because the column has NO DB CHECK and alternate write paths
// (admissionService case-sheet → 'case_sheet') persist values outside this list
// that the note LISTs return verbatim.
const NOTE_TYPE = [
  'soap', 'progress', 'procedure', 'discharge', 'nursing_assessment',
  'consultation_note', 'op_consultation', 'admission_note', 'er_note', 'transfer_note',
];
// diagnoses.diagnosis_type (default 'secondary').
const DIAGNOSIS_TYPE = ['primary', 'secondary', 'admitting', 'discharge'];
// diagnoses.status (default 'active').
const DIAGNOSIS_STATUS = ['active', 'resolved', 'chronic', 'recurrent'];
// diagnoses.severity (nullable).
const DIAGNOSIS_SEVERITY = ['mild', 'moderate', 'severe'];
// clinical coding source (clinicalCodeBindingService.normalizeClinicalCodings).
const CODING_SOURCE = ['manual', 'who_icd_api', 'fhir_import', 'legacy', 'system'];

// ---------------------------------------------------------------------------
// orders sub-domain enums (null-free; EXACT casing from orderEntryService.js).
// All app-layer-validated VARCHAR (NO Postgres CHECK on order_type/status).
// NOTE: `route` is NOT enum-bound — ROUTE_SYNONYMS canonicalises known values
// but unrecognised values pass through trimmed, so `route` is a free
// string|null on the row (typed {type:'string',nullable:true}, no enum).
// ---------------------------------------------------------------------------
// clinical_orders.order_type — VALID_ORDER_TYPES (orderEntryService line 46).
// Aliases (lab/imaging/med/consult) are coerced to one of these 9 BEFORE
// persist, so the returned value is always one of the canonical 9.
const ORDER_TYPE = [
  'medication', 'investigation', 'nursing', 'diet', 'activity',
  'consultation', 'ecg', 'radiology', 'procedure',
];
// clinical_orders.priority — VALID_PRIORITIES (default 'routine').
const ORDER_PRIORITY = ['stat', 'urgent', 'routine', 'prn'];
// clinical_orders.status — reachable state-machine set (default 'ordered';
// create always writes 'ordered').
const ORDER_STATUS = [
  'ordered', 'verified', 'in_progress', 'completed', 'cancelled', 'discontinued',
];
// clinical_order_set_items.kind — VARCHAR(20) seeded values (OrderSet items).
const ORDER_SET_ITEM_KIND = [
  'med', 'lab', 'radiology', 'diet', 'nursing', 'vitals', 'consult',
  'note', 'monitor', 'other',
];

// ---------------------------------------------------------------------------
// observations sub-domain enums (null-free; EXACT casing from
// vitalsChartService.js / news2Service.js / cdsEngine.js / temperatureRoute.js).
// All app-layer-validated VARCHAR (dipstick/route via util allowlists, no DB
// CHECK). CRITICAL cross-cluster fact: vitals_chart Decimal columns and
// intake_output.amount_ml serialize as STRINGS (Prisma.Decimal.toJSON → string;
// only BigInt is patched in www.js), so every numeric vital + amount_ml is typed
// {type:'string',nullable:true}, NOT number. INT columns (gcs_score,
// triage_acuity, encounter_id, id) stay integer.
// ---------------------------------------------------------------------------
// vitals_chart.source — provenance label (vitalsChartService line 447; default 'staff').
const VITAL_SOURCE = ['staff', 'device', 'fhir', 'patient_app'];
// vitals_chart.consciousness — ACVPU (VALID_CONSCIOUSNESS, vitalsChartService line 23).
const CONSCIOUSNESS = ['A', 'C', 'V', 'P', 'U'];
// vitals_chart.temperature_route — temperatureRoute.js VALID_TEMPERATURE_ROUTES.
const TEMPERATURE_ROUTE = ['oral', 'axillary', 'rectal', 'tympanic'];
// vitals_chart.urine_albumin/urine_sugar/urine_ketones — dipstick (VALID_DIPSTICK_VALUES).
const URINE_DIPSTICK = ['negative', 'trace', '1+', '2+', '3+', '4+'];
// news2_scores.clinical_risk (==risk_level) — news2Service.calculateNEWS2 (snake_case!).
const NEWS2_CLINICAL_RISK = ['low', 'low_to_medium', 'medium', 'high'];
// intake_output.io_type — VALID_IO_TYPES (vitalsChartService line 21).
const IO_TYPE = ['intake', 'output'];
// intake_output.category — VALID_IO_CATEGORIES (vitalsChartService line 22).
const IO_CATEGORY = ['oral', 'iv', 'blood', 'urine', 'drain', 'vomit', 'stool', 'other'];
// CDS in-memory alert severity (checkOrder / protocol reminders).
const CDS_SEVERITY = ['critical', 'warning', 'info'];
// CDS in-memory alert type (checkOrder + getProtocolReminders).
const CDS_ALERT_TYPE = [
  'drug_interaction', 'allergy', 'duplicate_order', 'critical_lab',
  'protocol_reminder', 'system_error',
];
// clinical_protocols.priority — listProtocols/createProtocol (default 'medium').
const CDS_PROTOCOL_PRIORITY = ['high', 'medium', 'low'];

// NOTE: the mar sub-domain enums (MAR_STATUS / MAR_ROUTE / MAR_DRUG_MATCH_MODE /
// DRUG_CHART_* / PHARMACY_STATUS / NEWS2_TREND / HANDOVER_* / STT_PROVIDER /
// TRANSCRIPT_STATUS / AI_DRAFT_REVIEW_STATUS / DETERIORATION_BAND /
// POLYPHARMACY_FINDING_SOURCE) were removed alongside the orphaned /emr/mar
// overlay (the alias mount is now skipped by the generator). NEWS2_CLINICAL_RISK
// stays — it is reused by the observations /vitals News2Summary schema.

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
  EmrErrorResponse: {
    type: 'object',
    additionalProperties: true,
    required: ['success', 'message'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      message: { type: 'string' },
      code: { type: 'string' },
      requestId: { type: 'string' },
      details: { type: 'object', additionalProperties: true },
    },
  },
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
      admission_type: { type: 'string', nullable: true },
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
      admission_type: { type: 'string', nullable: true },
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
      mar_schedule_status: {
        type: 'string',
        nullable: true,
        enum: ['scheduled', 'action_required', 'not_applicable'],
      },
      mar_scheduled_dose_count: { type: 'integer', nullable: true, minimum: 0 },
      mar_recovery_endpoint: { type: 'string', nullable: true },
    },
  },

  // ---- MarSchedulingRecovery --------------------------------------------
  // POST /orders/{id}/retry-mar-scheduling replays only the persisted active
  // CPOE definition. It never accepts dose overrides. Existing dose slots are
  // returned idempotently; missing slots are created with order/supply lineage.
  MarSchedulingRecovery: {
    type: 'object',
    additionalProperties: false,
    required: [
      'order_id', 'order_number', 'patient_uid', 'status',
      'scheduled_dose_count', 'scheduled_dose_ids',
      'recovery_timeline_event_id', 'recovery_audit_event_id',
    ],
    properties: {
      order_id: { type: 'integer' },
      order_number: { type: 'string' },
      patient_uid: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['scheduled'] },
      scheduled_dose_count: { type: 'integer', minimum: 1 },
      scheduled_dose_ids: { type: 'array', items: { type: 'integer' }, minItems: 1 },
      recovery_timeline_event_id: {
        nullable: true,
        oneOf: [{ type: 'integer' }, { type: 'string' }],
      },
      recovery_audit_event_id: {
        nullable: true,
        oneOf: [{ type: 'integer' }, { type: 'string' }],
      },
    },
  },

  // ---- DischargeReadiness -----------------------------------------------
  // The rules readiness object (inside discharge-hub + discharge-readiness rules
  // portion). LOOSE on blocker extras; checklist exposes the typed legacy and
  // active-pathway readiness gates.
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
          structured_summary_signed: { type: 'boolean' },
          patient_guardian_instructions_recorded: { type: 'boolean' },
          escalation_contact_recorded: { type: 'boolean' },
          equipment_home_care_plan_recorded: { type: 'boolean' },
          discharge_destination_recorded: { type: 'boolean' },
          transport_plan_recorded: { type: 'boolean' },
          external_transfer_governance_ready: { type: 'boolean' },
          inpatient_owner_assignment_converged: { type: 'boolean' },
          formal_medication_reconciliation_completed: { type: 'boolean' },
          admission_follow_up_or_exception: { type: 'boolean' },
          pending_result_projection_ready: { type: 'boolean' },
          pending_result_handoffs_complete: { type: 'boolean' },
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
  // admission-mgmt sub-domain — shared item schemas
  // (LIST != detail: these are distinct reduced projections from AdmissionRow /
  // AdmissionDetail; do NOT collapse them onto those.)
  // =========================================================================

  // ---- AdmissionListItem -------------------------------------------------
  // GET /admissions reduced projection (fixed `select`): HAS department/priority/
  // expected_los_days; NO doctor names / los_days / prior_admission. LOOSE —
  // minimize variant nulls PHI (patient_name='Occupied') + late-migration cols.
  AdmissionListItem: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'status'],
    properties: {
      id: { type: 'integer' },
      tenant_id: { type: 'string', format: 'uuid' },
      encounter_id: { type: 'string', format: 'uuid', nullable: true },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      admitting_doctor: { type: 'string', format: 'uuid', nullable: true },
      attending_doctor: { type: 'string', format: 'uuid', nullable: true },
      department: { type: 'string', nullable: true },
      ward: { type: 'string', nullable: true },
      bed_id: { type: 'integer', nullable: true },
      bed_number: { type: 'string', nullable: true },
      chief_complaint: { type: 'string', nullable: true },
      admitting_diagnosis: { type: 'string', nullable: true },
      admission_type: { type: 'string', nullable: true },
      status: { type: 'string', enum: ADMISSION_STATUS },
      priority: { type: 'string', nullable: true, enum: ADMISSION_PRIORITY },
      code_status: { type: 'string', nullable: true, enum: CODE_STATUS },
      allergies: { type: 'array', items: { type: 'string' }, nullable: true },
      admitted_at: { type: 'string', format: 'date-time', nullable: true },
      expected_los_days: { type: 'integer', nullable: true },
      next_review_at: { type: 'string', format: 'date-time', nullable: true },
      // enrichment (string|null; 'Occupied' for minimized roles)
      patient_name: { type: 'string', nullable: true },
      patient_phone: { type: 'string', nullable: true },
      patient_hospital_number: { type: 'string', nullable: true },
      hospital_number: { type: 'string', nullable: true },
      bed_ward_name: { type: 'string', nullable: true },
    },
  },

  // ---- AdmissionHistoryItem ----------------------------------------------
  // GET /admissions/patient/{uid} own projection: adds computed ip_number
  // (IP-YYYY-NNNNN) + los_days + discharge fields; NO patient enrichment. LOOSE.
  AdmissionHistoryItem: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'status'],
    properties: {
      id: { type: 'integer' },
      encounter_id: { type: 'string', format: 'uuid', nullable: true },
      admitting_doctor: { type: 'string', format: 'uuid', nullable: true },
      attending_doctor: { type: 'string', format: 'uuid', nullable: true },
      department: { type: 'string', nullable: true },
      ward: { type: 'string', nullable: true },
      bed_id: { type: 'integer', nullable: true },
      bed_number: { type: 'string', nullable: true },
      chief_complaint: { type: 'string', nullable: true },
      admitting_diagnosis: { type: 'string', nullable: true },
      admission_type: { type: 'string', nullable: true },
      status: { type: 'string', enum: ADMISSION_STATUS },
      priority: { type: 'string', nullable: true, enum: ADMISSION_PRIORITY },
      code_status: { type: 'string', nullable: true, enum: CODE_STATUS },
      admitted_at: { type: 'string', format: 'date-time', nullable: true },
      discharged_at: { type: 'string', format: 'date-time', nullable: true },
      discharge_type: { type: 'string', nullable: true, enum: DISCHARGE_TYPE },
      expected_los_days: { type: 'integer', nullable: true },
      ip_number: { type: 'string', nullable: true },
      los_days: { type: 'number', nullable: true },
    },
  },

  // ---- AdmissionStats ----------------------------------------------------
  // GET /admissions/stats aggregate (no PHI). STRICT. avg_los_days number|null.
  AdmissionStats: {
    type: 'object',
    additionalProperties: false,
    required: ['total_admissions', 'total_discharged'],
    properties: {
      total_admissions: { type: 'integer' },
      total_discharged: { type: 'integer' },
      avg_los_days: { type: 'number', nullable: true },
      currently_admitted: { type: 'integer' },
      currently_transferred: { type: 'integer' },
      occupancy_rate: { type: 'number' },
      total_beds: { type: 'integer' },
      occupied_beds: { type: 'integer' },
      discharge_type_breakdown: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['discharge_type', 'count'],
          properties: {
            discharge_type: { type: 'string', nullable: true, enum: DISCHARGE_TYPE },
            count: { type: 'integer' },
          },
        },
      },
      admission_type_breakdown: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['admission_type', 'count'],
          properties: {
            admission_type: { type: 'string', nullable: true },
            count: { type: 'integer' },
          },
        },
      },
    },
  },

  // ---- AdmitAdmissionRow -------------------------------------------------
  // POST /admit row: ADMISSION_RETURNING_SELECT core + post-commit best-effort
  // enrichment (ip_number/bed_number/patient_*). LOOSE — enrichment may be absent
  // on best-effort-failure paths. Distinct from AdmissionRow (no los_days here,
  // adds ip_number + patient_*).
  AdmitAdmissionRow: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'status', 'patient_uid'],
    properties: {
      id: { type: 'integer' },
      tenant_id: { type: 'string', format: 'uuid' },
      encounter_id: { type: 'string', format: 'uuid', nullable: true },
      patient_uid: { type: 'string', format: 'uuid' },
      status: { type: 'string', nullable: true, enum: ADMISSION_STATUS },
      admission_type: { type: 'string', nullable: true },
      admitting_doctor: { type: 'string', format: 'uuid', nullable: true },
      attending_doctor: { type: 'string', format: 'uuid', nullable: true },
      ward: { type: 'string', nullable: true },
      bed_id: { type: 'integer', nullable: true },
      bed_number: { type: 'string', nullable: true },
      admitted_at: { type: 'string', format: 'date-time', nullable: true },
      discharged_at: { type: 'string', format: 'date-time', nullable: true },
      code_status: { type: 'string', nullable: true, enum: CODE_STATUS },
      room_category: { type: 'string', nullable: true, enum: ROOM_CATEGORY },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      // post-commit best-effort enrichment
      ip_number: { type: 'string', nullable: true },
      patient_name: { type: 'string', nullable: true },
      patient_phone: { type: 'string', nullable: true },
      patient_hospital_number: { type: 'string', nullable: true },
      hospital_number: { type: 'string', nullable: true },
    },
  },

  // ---- BedOption ---------------------------------------------------------
  // GET /bed-options items. STRICT — fixed query projection.
  BedOption: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'bed_number'],
    properties: {
      id: { type: 'integer' },
      bed_number: { type: 'string' },
      ward_id: { type: 'integer', nullable: true },
      ward_name: { type: 'string', nullable: true },
      floor: { type: 'integer', nullable: true },
      bed_type: { type: 'string', nullable: true },
      status: { type: 'string', nullable: true, enum: BED_STATUS },
      notes: { type: 'string', nullable: true },
    },
  },

  // ---- WardOption --------------------------------------------------------
  // GET /ward-options heterogeneous items: source 'wards' rows carry bed counts;
  // 'fallback' rows have only {id:null,name,label,source}. LOOSE.
  WardOption: {
    type: 'object',
    additionalProperties: true,
    required: ['name', 'label', 'source'],
    properties: {
      id: { type: 'integer', nullable: true },
      name: { type: 'string' },
      label: { type: 'string' },
      source: { type: 'string', enum: WARD_SOURCE },
      floor: { type: 'integer', nullable: true },
      total_beds: { type: 'integer' },
      bed_count: { type: 'integer' },
      available_count: { type: 'integer' },
      occupied_count: { type: 'integer' },
    },
  },

  // ---- AdviseAdmissionResult (REUSED) ------------------------------------
  // POST /admissions/advise returns the SAME bare appointment RETURNING row that
  // appointmentWorkflowController.adviseForAdmission produces — already modelled
  // by the appointments overlay as `AdviseAdmissionResult` (status = UPPERCASE
  // APPOINTMENT_STATUS, NOT admission status). We $ref it below rather than
  // redeclare (the generator rejects duplicate global schema names).

  // ---- AdmissionLookup ---------------------------------------------------
  // GET /lookup result. ONE schema, 4 lookup_state branches: patient|null +
  // optional matches[] + prior_admissions[]. LOOSE.
  AdmissionLookup: {
    type: 'object',
    additionalProperties: true,
    required: ['lookup_state'],
    properties: {
      lookup_state: { type: 'string', enum: LOOKUP_STATE },
      patient: { type: 'object', additionalProperties: true, nullable: true },
      matches: { type: 'array', items: { type: 'object', additionalProperties: true } },
      prior_admissions: { type: 'array', items: { type: 'object', additionalProperties: true } },
      count: { type: 'integer' },
      last_ip_number: { type: 'string', nullable: true },
      last_admission: { type: 'object', additionalProperties: true, nullable: true },
      next_ip_number_hint: { type: 'string', nullable: true },
    },
  },

  // ---- CommandBoardMeta --------------------------------------------------
  // GET /command-board board envelope. LOOSE — semi-structured, role-variant.
  CommandBoardMeta: {
    type: 'object',
    additionalProperties: true,
    required: ['kind'],
    properties: {
      kind: { type: 'string' },
      generated_at: { type: 'string', format: 'date-time' },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      scope: { type: 'object', additionalProperties: true },
      actor: { type: 'object', additionalProperties: true },
      governance: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ai_state: { type: 'string' },
          label: { type: 'string', nullable: true },
          source_count: { type: 'integer' },
          human_review_required_for_actions: { type: 'boolean' },
        },
      },
      counts: { type: 'object', additionalProperties: true },
    },
  },

  // ---- CommandBoardRow ---------------------------------------------------
  // GET /command-board deeply nested composite row. LOOSE throughout — jsonb-
  // derived sub-objects + heavy housekeeping-role minimize variant. Required core
  // is just admission_id.
  CommandBoardRow: {
    type: 'object',
    additionalProperties: true,
    required: ['admission_id'],
    properties: {
      admission_id: { type: 'integer' },
      encounter_id: { type: 'string', format: 'uuid', nullable: true },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      patient: { type: 'object', additionalProperties: true, nullable: true },
      location: { type: 'object', additionalProperties: true },
      admission: {
        type: 'object',
        additionalProperties: true,
        properties: {
          status: { type: 'string', nullable: true, enum: ADMISSION_STATUS },
          type: { type: 'string', nullable: true },
          code_status: { type: 'string', nullable: true, enum: CODE_STATUS },
          room_category: { type: 'string', nullable: true, enum: ROOM_CATEGORY },
          next_review_at: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      assigned_staff: { type: 'object', additionalProperties: true },
      priority: { type: 'object', additionalProperties: true },
      timers: { type: 'object', additionalProperties: true },
      diagnosis: { type: 'object', additionalProperties: true },
      allergies: { type: 'object', additionalProperties: true },
      isolation: { type: 'object', additionalProperties: true },
      alerts: { type: 'object', additionalProperties: true },
      tasks: { type: 'object', additionalProperties: true },
      notes: { type: 'object', additionalProperties: true },
      discharge: { type: 'object', additionalProperties: true },
      actions: { type: 'array', items: { type: 'object', additionalProperties: true } },
      // Present only when the row has an ACTIVE icu_admissions episode and
      // the caller is not a minimized-payload role: getIcuChartView shape,
      // with the NICU/PICU specialty view nested under `nicu` for
      // NICU/PICU-unit episodes (NL14-P1/P3 board panels).
      icu_chart: { type: 'object', additionalProperties: true, nullable: true },
    },
  },

  // ---- ClinicalAiConfig --------------------------------------------------
  // GET /clinical-ai/config — provider readiness (NOT generated content).
  // serializeClinicalAiConfig (src/services/ai/localLlmClient.js:663) returns
  // EXACTLY these 11 camelCase keys → STRICT. enabled=readiness.ready,
  // readiness=readiness.reason (free string|null). model/moduleKey nullable.
  ClinicalAiConfig: {
    type: 'object',
    additionalProperties: false,
    required: ['provider', 'enabled', 'supportedProviders'],
    properties: {
      moduleKey: { type: 'string', nullable: true },
      tier: { type: 'string' },
      provider: { type: 'string', enum: CLINICAL_AI_PROVIDER },
      model: { type: 'string', nullable: true },
      enabled: { type: 'boolean' },
      baseUrlConfigured: { type: 'boolean' },
      apiKeyConfigured: { type: 'boolean' },
      externalProvider: { type: 'boolean' },
      externalAllowed: { type: 'boolean' },
      readiness: { type: 'string', nullable: true },
      supportedProviders: { type: 'array', items: { type: 'string', enum: CLINICAL_AI_PROVIDER } },
    },
  },

  // ---- TranslationResult -------------------------------------------------
  // POST /generations/{generationId}/translate. translated_draft jsonb → object;
  // coverage_pct/used_ai only on non-dedup path. LOOSE.
  TranslationResult: {
    type: 'object',
    additionalProperties: true,
    required: ['translation_id', 'target_language', 'translated_draft', 'status'],
    properties: {
      translation_id: { type: 'integer' },
      source_generation_id: { type: 'integer', nullable: true },
      target_language: { type: 'string' },
      translated_draft: { type: 'object', additionalProperties: true },
      fidelity_flags: { type: 'array', items: { type: 'object', additionalProperties: true } },
      coverage_pct: { type: 'number' },
      status: { type: 'string', enum: TRANSLATION_STATUS },
      provider: { type: 'string' },
      model: { type: 'string', nullable: true },
      used_ai: { type: 'boolean' },
      deduplicated: { type: 'boolean' },
    },
  },

  // ---- TranslationListItem -----------------------------------------------
  // GET /translations reduced (NO translated_draft; adds module_key/patient_uid/
  // source_language). LOOSE — fidelity_flags jsonb. LIST != detail.
  TranslationListItem: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'target_language', 'status'],
    properties: {
      id: { type: 'integer' },
      source_generation_id: { type: 'integer', nullable: true },
      source_language: { type: 'string', nullable: true },
      target_language: { type: 'string' },
      provider: { type: 'string', nullable: true },
      model: { type: 'string', nullable: true },
      status: { type: 'string', enum: TRANSLATION_STATUS },
      fidelity_flags: { type: 'array', items: { type: 'object', additionalProperties: true } },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      module_key: { type: 'string', nullable: true },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
    },
  },

  // ---- DowntimeSnapshot --------------------------------------------------
  // POST /downtime-snapshot/{patientUid} (201). payload jsonb (patient+timeline)
  // OPAQUE → object, never string. LOOSE.
  DowntimeSnapshot: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'patient_uid', 'payload'],
    properties: {
      id: { type: 'integer' },
      patient_uid: { type: 'string', format: 'uuid' },
      scope: { type: 'string' },
      payload: { type: 'object', additionalProperties: true },
      expires_at: { type: 'string', format: 'date-time', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
    },
  },

  // =========================================================================
  // admission-mgmt — per-endpoint `data` payloads
  // =========================================================================

  // POST /admit → { admission: AdmitAdmissionRow } (201).
  AdmitData: {
    type: 'object',
    additionalProperties: true,
    required: ['admission'],
    properties: { admission: { $ref: '#/components/schemas/AdmitAdmissionRow' } },
  },

  // GET /admissions/patient/{uid} → { admissions: AdmissionHistoryItem[], count }.
  AdmissionHistoryData: {
    type: 'object',
    additionalProperties: true,
    required: ['admissions'],
    properties: {
      admissions: { type: 'array', items: { $ref: '#/components/schemas/AdmissionHistoryItem' } },
      count: { type: 'integer' },
    },
  },

  // GET /bed-options → { beds: BedOption[], count }.
  BedOptionsData: {
    type: 'object',
    additionalProperties: false,
    required: ['beds', 'count'],
    properties: {
      beds: { type: 'array', items: { $ref: '#/components/schemas/BedOption' } },
      count: { type: 'integer' },
    },
  },

  // GET /ward-options → { wards: WardOption[], count }.
  WardOptionsData: {
    type: 'object',
    additionalProperties: true,
    required: ['wards', 'count'],
    properties: {
      wards: { type: 'array', items: { $ref: '#/components/schemas/WardOption' } },
      count: { type: 'integer' },
    },
  },

  // GET /command-board → { board: CommandBoardMeta, rows: CommandBoardRow[] }.
  CommandBoardData: {
    type: 'object',
    additionalProperties: true,
    required: ['board', 'rows'],
    properties: {
      board: { $ref: '#/components/schemas/CommandBoardMeta' },
      rows: { type: 'array', items: { $ref: '#/components/schemas/CommandBoardRow' } },
    },
  },

  // GET /translations → { translations: TranslationListItem[], count }.
  TranslationsListData: {
    type: 'object',
    additionalProperties: true,
    required: ['translations'],
    properties: {
      translations: { type: 'array', items: { $ref: '#/components/schemas/TranslationListItem' } },
      count: { type: 'integer' },
    },
  },

  // Bare-data refs (data IS the object/array directly — no wrapper key).
  AdmissionStatsData: { $ref: '#/components/schemas/AdmissionStats' },
  AdviseAdmissionData: { $ref: '#/components/schemas/AdviseAdmissionResult' },
  AdmissionLookupData: { $ref: '#/components/schemas/AdmissionLookup' },
  ClinicalAiConfigData: { $ref: '#/components/schemas/ClinicalAiConfig' },
  TranslationResultData: { $ref: '#/components/schemas/TranslationResult' },
  DowntimeSnapshotData: { $ref: '#/components/schemas/DowntimeSnapshot' },

  // =========================================================================
  // admission-mgmt — response envelopes
  // =========================================================================
  EmrAdmissionListResponse: listEnvelope('AdmissionListItem'),
  EmrAdmitResponse: envelope('AdmitData'),
  EmrAdmissionHistoryResponse: envelope('AdmissionHistoryData'),
  EmrAdmissionStatsResponse: envelope('AdmissionStatsData'),
  EmrAdviseAdmissionResponse: envelope('AdviseAdmissionData'),
  EmrBedOptionsResponse: envelope('BedOptionsData'),
  EmrWardOptionsResponse: envelope('WardOptionsData'),
  EmrCommandBoardResponse: envelope('CommandBoardData'),
  EmrAdmissionLookupResponse: envelope('AdmissionLookupData'),
  EmrClinicalAiConfigResponse: envelope('ClinicalAiConfigData'),
  EmrTranslationResultResponse: envelope('TranslationResultData'),
  EmrTranslationsListResponse: envelope('TranslationsListData'),
  EmrDowntimeSnapshotResponse: envelope('DowntimeSnapshotData'),

  // =========================================================================
  // admission-mgmt — request bodies (LOOSE; controllers accept raw intake)
  // =========================================================================
  EmrAdviseAdmissionRequest: {
    type: 'object', additionalProperties: true,
    properties: {
      appointment_id: { type: 'integer' },
      patient_uid: { type: 'string', format: 'uuid' },
      note: { type: 'string' },
    },
  },
  EmrAdmitRequest: looseObject,
  EmrTranslateRequest: {
    type: 'object', additionalProperties: true, required: ['target_language'],
    properties: { target_language: { type: 'string' } },
  },
  EmrDowntimeSnapshotRequest: {
    type: 'object', additionalProperties: true,
    properties: {
      scope: { type: 'string' },
      hours_to_live: { type: 'integer' },
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
    type: 'object', additionalProperties: true, required: ['doctor_uid'],
    properties: {
      doctor_uid: { type: 'string', format: 'uuid' },
      accepted_handoff_id: {
        type: 'string',
        format: 'uuid',
        nullable: true,
      },
    },
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

  // =========================================================================
  // notes-diagnosis sub-domain — shared schemas
  // (clinicalNotesRoutes.js + diagnosisRoutes.js — EMR-only mount, NOT aliased
  // to /api/v1/admissions. Every response wraps via success(res,data,…). jsonb
  // columns → parsed objects, never string.)
  // =========================================================================

  // ---- ClinicalNote ------------------------------------------------------
  // NOTE_SELECT row + author_name (always appended by attachAuthorNames). Used by
  // POST /notes, addendum, sign, PUT/PATCH, encounter LIST, patient LIST. `content`
  // is a typed-by-note_type jsonb object that varies per type → LOOSE object (do
  // NOT enumerate). LIST == detail minus version_history.
  ClinicalNote: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'patient_uid', 'note_type', 'content', 'version'],
    properties: {
      id: { type: 'integer' },
      encounter_id: { type: 'string', format: 'uuid', nullable: true },
      appointment_id: { type: 'integer', nullable: true },
      patient_uid: { type: 'string', format: 'uuid' },
      author_uid: { type: 'string', format: 'uuid', nullable: true },
      author_role: { type: 'string', nullable: true },
      note_type: { type: 'string' },
      title: { type: 'string', nullable: true },
      content: { type: 'object', additionalProperties: true },
      version: { type: 'integer' },
      parent_note_id: { type: 'integer', nullable: true },
      is_addendum: { type: 'boolean' },
      is_signed: { type: 'boolean' },
      signed_at: { type: 'string', format: 'date-time', nullable: true },
      signed_by: { type: 'string', format: 'uuid', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      author_name: { type: 'string', nullable: true },
    },
  },

  // ---- ClinicalNoteVersion -----------------------------------------------
  // version_history[] element — reduced VERSION_HISTORY_SELECT projection (no
  // encounter/title/appointment) + author_name. content jsonb → object. LOOSE.
  ClinicalNoteVersion: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'content', 'version'],
    properties: {
      id: { type: 'integer' },
      author_uid: { type: 'string', format: 'uuid', nullable: true },
      author_role: { type: 'string', nullable: true },
      content: { type: 'object', additionalProperties: true },
      version: { type: 'integer' },
      is_addendum: { type: 'boolean' },
      is_signed: { type: 'boolean' },
      signed_at: { type: 'string', format: 'date-time', nullable: true },
      signed_by: { type: 'string', format: 'uuid', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      author_name: { type: 'string', nullable: true },
    },
  },

  // ---- ClinicalNoteDetail ------------------------------------------------
  // GET /notes/{id} = ClinicalNote + version_history: ClinicalNoteVersion[]. LOOSE.
  ClinicalNoteDetail: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'patient_uid', 'note_type', 'content', 'version'],
    properties: {
      id: { type: 'integer' },
      encounter_id: { type: 'string', format: 'uuid', nullable: true },
      appointment_id: { type: 'integer', nullable: true },
      patient_uid: { type: 'string', format: 'uuid' },
      author_uid: { type: 'string', format: 'uuid', nullable: true },
      author_role: { type: 'string', nullable: true },
      note_type: { type: 'string' },
      title: { type: 'string', nullable: true },
      content: { type: 'object', additionalProperties: true },
      version: { type: 'integer' },
      parent_note_id: { type: 'integer', nullable: true },
      is_addendum: { type: 'boolean' },
      is_signed: { type: 'boolean' },
      signed_at: { type: 'string', format: 'date-time', nullable: true },
      signed_by: { type: 'string', format: 'uuid', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      author_name: { type: 'string', nullable: true },
      version_history: {
        type: 'array',
        items: { $ref: '#/components/schemas/ClinicalNoteVersion' },
      },
    },
  },

  // ---- NoteDraft ---------------------------------------------------------
  // GET /notes/draft — own draft OR null (nullable data; message switches). content
  // jsonb → object. STRICT shell, content loose.
  NoteDraft: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'content', 'updated_at', 'expires_at'],
    properties: {
      id: { type: 'integer' },
      content: { type: 'object', additionalProperties: true },
      updated_at: { type: 'string', format: 'date-time' },
      expires_at: { type: 'string', format: 'date-time' },
    },
  },

  // ---- NoteDraftUpsertResult ---------------------------------------------
  // PUT /notes/draft (upsert) → { id, updated_at } (RETURNING). STRICT.
  NoteDraftUpsertResult: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'updated_at'],
    properties: {
      id: { type: 'integer' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },

  // ---- NoteDraftDeleteResult ---------------------------------------------
  // DELETE /notes/draft → { removed: int } (rows deleted). STRICT.
  NoteDraftDeleteResult: {
    type: 'object',
    additionalProperties: false,
    required: ['removed'],
    properties: {
      removed: { type: 'integer' },
    },
  },

  // ---- ClinicalCoding ----------------------------------------------------
  // diagnosis codings[] element (clinicalCodeBindingService.normalizeClinicalCodings).
  // metadata jsonb → object. LOOSE (carries normalized coding columns).
  ClinicalCoding: {
    type: 'object',
    additionalProperties: true,
    required: ['system_key', 'code'],
    properties: {
      system_key: { type: 'string' },
      system: { type: 'string' },
      code: { type: 'string' },
      display: { type: 'string', nullable: true },
      release_id: { type: 'string', nullable: true },
      language: { type: 'string', nullable: true },
      linearization_uri: { type: 'string', nullable: true },
      foundation_uri: { type: 'string', nullable: true },
      coding_role: { type: 'string' },
      source: { type: 'string', enum: CODING_SOURCE },
      metadata: { type: 'object', additionalProperties: true },
    },
  },

  // ---- DiagnosisWithCodings ----------------------------------------------
  // DIAGNOSIS_SELECT row + codings: ClinicalCoding[]. Used by ALL diagnosis
  // create/status/LIST ops (SAME projection — detail == list). onset_date/
  // resolved_date are DB `date` columns, but the service writes them via
  // `new Date(...)` and Prisma serializes a Date as a FULL ISO-8601 date-time
  // string (`2026-06-26T00:00:00.000Z`), so they validate as `date-time`, NOT
  // bare `date`. LOOSE — carries DB columns.
  DiagnosisWithCodings: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'patient_uid', 'description', 'diagnosis_type', 'status'],
    properties: {
      id: { type: 'integer' },
      patient_uid: { type: 'string', format: 'uuid' },
      encounter_id: { type: 'string', format: 'uuid', nullable: true },
      icd10_code: { type: 'string', nullable: true },
      icd10_description: { type: 'string', nullable: true },
      description: { type: 'string' },
      diagnosis_type: { type: 'string', enum: DIAGNOSIS_TYPE },
      status: { type: 'string', enum: DIAGNOSIS_STATUS },
      onset_date: { type: 'string', format: 'date-time', nullable: true },
      resolved_date: { type: 'string', format: 'date-time', nullable: true },
      severity: { type: 'string', nullable: true, enum: DIAGNOSIS_SEVERITY },
      diagnosed_by: { type: 'string', format: 'uuid', nullable: true },
      notes: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      tenant_id: { type: 'string', format: 'uuid' },
      codings: { type: 'array', items: { $ref: '#/components/schemas/ClinicalCoding' } },
    },
  },

  // ---- Icd10Row ----------------------------------------------------------
  // GET /icd10/search items (icd10_codes select: id,code,description,category,
  // is_active). No PHI. STRICT.
  Icd10Row: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'code', 'description'],
    properties: {
      id: { type: 'integer' },
      code: { type: 'string' },
      description: { type: 'string' },
      category: { type: 'string', nullable: true },
      is_active: { type: 'boolean' },
    },
  },

  // =========================================================================
  // notes-diagnosis — per-endpoint `data` payloads / bare refs
  // =========================================================================

  // POST/PUT/PATCH/sign/addendum /notes → ClinicalNote directly (data IS the note).
  ClinicalNoteData: { $ref: '#/components/schemas/ClinicalNote' },
  // GET /notes/{id} → ClinicalNoteDetail (+ version_history).
  ClinicalNoteDetailData: { $ref: '#/components/schemas/ClinicalNoteDetail' },
  // GET /notes/draft → NoteDraft OR null (nullable data).
  NoteDraftData: { nullable: true, allOf: [{ $ref: '#/components/schemas/NoteDraft' }] },
  // PUT /notes/draft → NoteDraftUpsertResult.
  NoteDraftUpsertData: { $ref: '#/components/schemas/NoteDraftUpsertResult' },
  // DELETE /notes/draft → NoteDraftDeleteResult.
  NoteDraftDeleteData: { $ref: '#/components/schemas/NoteDraftDeleteResult' },
  // POST/PUT diagnosis (single) → DiagnosisWithCodings directly.
  DiagnosisWithCodingsData: { $ref: '#/components/schemas/DiagnosisWithCodings' },

  // =========================================================================
  // notes-diagnosis — response envelopes
  // =========================================================================
  // Single-note ops (data = ClinicalNote).
  EmrClinicalNoteResponse: envelope('ClinicalNoteData'),
  // Note detail (data = ClinicalNoteDetail).
  EmrClinicalNoteDetailResponse: envelope('ClinicalNoteDetailData'),
  // Note LIST (encounter + patient) — data is a bare ClinicalNote[] (pagination
  // lives in meta / meta.pagination — typed loosely by listEnvelope's meta).
  EmrClinicalNoteListResponse: listEnvelope('ClinicalNote'),
  // Drafts.
  EmrNoteDraftResponse: envelope('NoteDraftData'),
  EmrNoteDraftUpsertResponse: envelope('NoteDraftUpsertData'),
  EmrNoteDraftDeleteResponse: envelope('NoteDraftDeleteData'),
  // Diagnosis single ops (data = DiagnosisWithCodings).
  EmrDiagnosisResponse: envelope('DiagnosisWithCodingsData'),
  // Diagnosis LIST (encounter / problem-list / history) — bare DiagnosisWithCodings[].
  EmrDiagnosisListResponse: listEnvelope('DiagnosisWithCodings'),
  // ICD-10 search — bare Icd10Row[].
  EmrIcd10SearchResponse: listEnvelope('Icd10Row'),

  // =========================================================================
  // notes-diagnosis — request bodies (LOOSE; controllers normalize raw intake).
  // =========================================================================
  // CreateNoteRequest — note_type|type + content|note|body|text (normalizeNotePayload).
  EmrCreateNoteRequest: {
    type: 'object', additionalProperties: true,
    properties: {
      note_type: { type: 'string', enum: NOTE_TYPE },
      type: { type: 'string', enum: NOTE_TYPE },
      patient_uid: { type: 'string', format: 'uuid' },
      encounter_id: { type: 'string', format: 'uuid' },
      title: { type: 'string' },
      content: { type: 'object', additionalProperties: true },
    },
  },
  EmrUpdateNoteRequest: looseObject,
  EmrAddendumRequest: looseObject,
  // CreateDiagnosisRequest — description required; diagnosis_type/icd10_code optional.
  EmrCreateDiagnosisRequest: {
    type: 'object', additionalProperties: true, required: ['description'],
    properties: {
      description: { type: 'string' },
      patient_uid: { type: 'string', format: 'uuid' },
      encounter_id: { type: 'string', format: 'uuid' },
      diagnosis_type: { type: 'string', enum: DIAGNOSIS_TYPE },
      status: { type: 'string', enum: DIAGNOSIS_STATUS },
      severity: { type: 'string', enum: DIAGNOSIS_SEVERITY },
      icd10_code: { type: 'string' },
    },
  },
  // DiagnosisStatusRequest — status enum.
  EmrDiagnosisStatusRequest: {
    type: 'object', additionalProperties: true, required: ['status'],
    properties: { status: { type: 'string', enum: DIAGNOSIS_STATUS } },
  },
  // NoteDraftUpsertRequest — loose content payload.
  EmrNoteDraftUpsertRequest: looseObject,

  // =========================================================================
  // orders sub-domain — shared schemas
  // (orderRoutes.js → orderEntryService.js — EMR-only mount, NOT aliased to
  // /api/v1/admissions. Every response wraps via success(res,data,…). jsonb
  // columns → parsed objects, never string.)
  // =========================================================================

  // ---- ClinicalOrder -----------------------------------------------------
  // ORDER_RETURNING_SELECT row (orderEntryService lines 95-118). Used by
  // verify/complete/cancel/discontinue (detail) + patient/encounter LIST +
  // nested inside ClinicalOrderCreateResult. `details` is heavily kind-specific
  // jsonb → LOOSE object (do NOT enumerate). `route` is a FREE string|null
  // (synonyms pass through), NOT a closed enum. LIST == detail (same projection).
  ClinicalOrder: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'order_number', 'patient_uid', 'order_type', 'status'],
    properties: {
      id: { type: 'integer' },
      order_number: { type: 'string' },
      encounter_id: { type: 'string', format: 'uuid', nullable: true },
      patient_uid: { type: 'string', format: 'uuid' },
      order_type: { type: 'string', enum: ORDER_TYPE },
      priority: { type: 'string', enum: ORDER_PRIORITY },
      details: { type: 'object', additionalProperties: true },
      route: { type: 'string', nullable: true },
      status: { type: 'string', enum: ORDER_STATUS },
      ordered_by: { type: 'string', format: 'uuid', nullable: true },
      verified_by: { type: 'string', format: 'uuid', nullable: true },
      verified_at: { type: 'string', format: 'date-time', nullable: true },
      completed_by: { type: 'string', format: 'uuid', nullable: true },
      completed_at: { type: 'string', format: 'date-time', nullable: true },
      cancelled_by: { type: 'string', format: 'uuid', nullable: true },
      cancel_reason: { type: 'string', nullable: true },
      start_date: { type: 'string', format: 'date-time', nullable: true },
      end_date: { type: 'string', format: 'date-time', nullable: true },
      notes: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      tenant_id: { type: 'string', format: 'uuid' },
    },
  },

  // ---- ClinicalOrderCreateResult -----------------------------------------
  // POST /orders single (201) + /bulk array element + apply-set SUCCESS element.
  // { order: ClinicalOrder, cds_warnings: (string|object)[] }. cds_warnings is
  // MIXED — bare strings AND shaped objects ({type,medication,message} dup /
  // interaction warnings) → array items oneOf [string, loose object]. LOOSE.
  ClinicalOrderCreateResult: {
    type: 'object',
    additionalProperties: true,
    required: ['order', 'cds_warnings'],
    properties: {
      order: { $ref: '#/components/schemas/ClinicalOrder' },
      cds_warnings: {
        type: 'array',
        items: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] },
      },
    },
  },

  // ---- ApplyOrderSetResult -----------------------------------------------
  // POST /orders/apply-set is atomic: every element is a successful
  // ClinicalOrderCreateResult, or the entire request fails without rows.
  ApplyOrderSetResult: {
    $ref: '#/components/schemas/ClinicalOrderCreateResult'
  },

  // ---- OrderSetItem ------------------------------------------------------
  // OrderSet.orders[] element (shapeOrderSetForResponse). details + payload are
  // jsonb → LOOSE objects. `kind` enum (clinical_order_set_items.kind). LOOSE.
  OrderSetItem: {
    type: 'object',
    additionalProperties: true,
    properties: {
      order_type: { type: 'string', nullable: true, enum: ORDER_TYPE },
      priority: { type: 'string', nullable: true, enum: ORDER_PRIORITY },
      details: { type: 'object', additionalProperties: true },
      notes: { type: 'string', nullable: true },
      kind: { type: 'string', nullable: true, enum: ORDER_SET_ITEM_KIND },
      display_order: { type: 'integer', nullable: true },
      default_selected: { type: 'boolean' },
      payload: { type: 'object', additionalProperties: true },
    },
  },

  // ---- OrderSet ----------------------------------------------------------
  // GET/POST /order-sets — legacy compat shape (shapeOrderSetForResponse lines
  // 1473-1490), NOT the raw clinical_order_sets row. orders[] = OrderSetItem[].
  // LOOSE (orders[].details/payload jsonb).
  OrderSet: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'name', 'orders'],
    properties: {
      id: { type: 'integer' },
      name: { type: 'string' },
      description: { type: 'string', nullable: true },
      category: { type: 'string', nullable: true },
      orders: { type: 'array', items: { $ref: '#/components/schemas/OrderSetItem' } },
      created_by: { type: 'string', format: 'uuid', nullable: true },
      is_active: { type: 'boolean' },
      created_at: { type: 'string', format: 'date-time' },
    },
  },

  // =========================================================================
  // orders — per-endpoint `data` payloads / bare refs
  // =========================================================================

  // POST /orders → ClinicalOrderCreateResult directly (data IS {order,cds_warnings}).
  ClinicalOrderCreateData: { $ref: '#/components/schemas/ClinicalOrderCreateResult' },
  // PUT verify/complete/cancel/discontinue → ClinicalOrder directly.
  ClinicalOrderData: { $ref: '#/components/schemas/ClinicalOrder' },
  MarSchedulingRecoveryData: { $ref: '#/components/schemas/MarSchedulingRecovery' },
  // POST /orders/bulk → bare ClinicalOrderCreateResult[] (EmrClinicalOrderBulkResponse
  // uses listEnvelope directly). POST /orders/apply-set is the same atomic list shape.
  // POST /order-sets → OrderSet directly.
  OrderSetData: { $ref: '#/components/schemas/OrderSet' },

  // =========================================================================
  // orders — response envelopes
  // =========================================================================
  // POST /orders (single create — data = {order,cds_warnings}).
  EmrClinicalOrderCreateResponse: envelope('ClinicalOrderCreateData'),
  // POST /orders/bulk (data = ClinicalOrderCreateResult[]).
  EmrClinicalOrderBulkResponse: listEnvelope('ClinicalOrderCreateResult'),
  // POST /orders/apply-set (data = ClinicalOrderCreateResult[]).
  EmrApplyOrderSetResponse: listEnvelope('ApplyOrderSetResult'),
  // PUT verify/complete/cancel/discontinue (data = ClinicalOrder).
  EmrClinicalOrderResponse: envelope('ClinicalOrderData'),
  EmrMarSchedulingRecoveryResponse: envelope('MarSchedulingRecoveryData'),
  // GET /orders/patient/{uid} + /orders/encounter/{encounterId} — bare
  // ClinicalOrder[]. Both lists spread bounded pagination FLAT into meta
  // (page/limit/total/totalPages/hasNext/hasPrev).
  EmrClinicalOrderListResponse: listEnvelope('ClinicalOrder'),
  // GET /order-sets — bare OrderSet[].
  EmrOrderSetListResponse: listEnvelope('OrderSet'),
  // POST /order-sets — single OrderSet.
  EmrOrderSetResponse: envelope('OrderSetData'),

  // =========================================================================
  // orders — request bodies (LOOSE; routes accept flat-or-nested intake +
  // resolveOrderDetails coercion, so keep additionalProperties:true).
  // =========================================================================
  // Every medication accepted here is MAR-bound and requires an admission-backed
  // encounter. Outpatient prescriptions use their separate workflow. Medication
  // authority stays nested; documented non-medication flat fields mirror only
  // the mounted route's resolveOrderDetails coercions.
  EmrCreateOrderRequest: {
    type: 'object', additionalProperties: true,
    required: ['patient_uid', 'order_type'],
    properties: {
      patient_uid: { type: 'string', format: 'uuid' },
      order_type: { type: 'string', enum: ORDER_TYPE },
      encounter_id: { type: 'string', format: 'uuid', nullable: true },
      er_visit_id: { type: 'integer', minimum: 1, nullable: true },
      priority: { type: 'string', enum: ORDER_PRIORITY },
      details: { type: 'object', additionalProperties: true },
      route: { type: 'string' },
      start_date: { type: 'string', format: 'date-time' },
      end_date: { type: 'string', format: 'date-time' },
      notes: { type: 'string' },
      investigation: { type: 'string' },
      test_name: { type: 'string' },
      test_code: { type: 'string' },
      reason: { type: 'string' },
      clinical_indication: { type: 'string' },
      fasting_required: { type: 'boolean' },
      specialty: { type: 'string' },
      description: { type: 'string' },
      frequency: { type: 'string' },
      instructions: { type: 'string' }
    },
    oneOf: [
      {
        title: 'Encounter medication order with authoritative ward supply',
        required: ['encounter_id', 'details'],
        properties: {
          order_type: { type: 'string', enum: ['medication'] },
          encounter_id: { type: 'string', format: 'uuid' },
          details: medicationWardSupplyDetails,
        },
      },
      {
        title: 'Flat or nested investigation or radiology order',
        properties: {
          order_type: { type: 'string', enum: ['investigation', 'radiology'] },
          details: { type: 'object', minProperties: 1, additionalProperties: true }
        },
        anyOf: [
          { required: ['details'] },
          { required: ['investigation'] },
          { required: ['test_name'] }
        ]
      },
      {
        title: 'Flat or nested consultation order',
        properties: {
          order_type: { type: 'string', enum: ['consultation'] },
          details: { type: 'object', minProperties: 1, additionalProperties: true }
        },
        anyOf: [{ required: ['details'] }, { required: ['specialty'] }, { required: ['reason'] }]
      },
      {
        title: 'Flat or nested nursing order',
        properties: {
          order_type: { type: 'string', enum: ['nursing'] },
          details: { type: 'object', minProperties: 1, additionalProperties: true }
        },
        anyOf: [
          { required: ['details'] },
          { required: ['description'] },
          { required: ['frequency'] },
          { required: ['instructions'] }
        ]
      },
      {
        title: 'Nested non-medication clinical order',
        required: ['details'],
        properties: {
          order_type: {
            type: 'string',
            enum: ['diet', 'activity', 'ecg', 'procedure']
          },
          details: { type: 'object', minProperties: 1, additionalProperties: true }
        }
      }
    ]
  },
  // When a bulk request carries a batch encounter_id, every medication item
  // inherits inpatient semantics even if the item omits its own encounter_id.
  EmrEncounterBoundOrderRequest: {
    type: 'object',
    additionalProperties: true,
    required: ['patient_uid', 'order_type'],
    properties: {
      patient_uid: { type: 'string', format: 'uuid' },
      order_type: { type: 'string', enum: ORDER_TYPE },
      encounter_id: { type: 'string', format: 'uuid', nullable: true },
      er_visit_id: { type: 'integer', minimum: 1, nullable: true },
      priority: { type: 'string', enum: ORDER_PRIORITY },
      details: { type: 'object', additionalProperties: true },
      route: { type: 'string' },
      start_date: { type: 'string', format: 'date-time' },
      end_date: { type: 'string', format: 'date-time' },
      notes: { type: 'string' },
      investigation: { type: 'string' },
      test_name: { type: 'string' },
      test_code: { type: 'string' },
      reason: { type: 'string' },
      clinical_indication: { type: 'string' },
      fasting_required: { type: 'boolean' },
      specialty: { type: 'string' },
      description: { type: 'string' },
      frequency: { type: 'string' },
      instructions: { type: 'string' }
    },
    oneOf: [
      {
        title: 'Encounter-bound medication order',
        required: ['details'],
        properties: {
          order_type: { type: 'string', enum: ['medication'] },
          details: medicationWardSupplyDetails
        }
      },
      {
        title: 'Encounter-bound flat or nested investigation or radiology order',
        properties: {
          order_type: { type: 'string', enum: ['investigation', 'radiology'] },
          details: { type: 'object', minProperties: 1, additionalProperties: true }
        },
        anyOf: [
          { required: ['details'] },
          { required: ['investigation'] },
          { required: ['test_name'] }
        ]
      },
      {
        title: 'Encounter-bound flat or nested consultation order',
        properties: {
          order_type: { type: 'string', enum: ['consultation'] },
          details: { type: 'object', minProperties: 1, additionalProperties: true }
        },
        anyOf: [{ required: ['details'] }, { required: ['specialty'] }, { required: ['reason'] }]
      },
      {
        title: 'Encounter-bound flat or nested nursing order',
        properties: {
          order_type: { type: 'string', enum: ['nursing'] },
          details: { type: 'object', minProperties: 1, additionalProperties: true }
        },
        anyOf: [
          { required: ['details'] },
          { required: ['description'] },
          { required: ['frequency'] },
          { required: ['instructions'] }
        ]
      },
      {
        title: 'Encounter-bound nested non-medication order',
        required: ['details'],
        properties: {
          order_type: {
            type: 'string',
            enum: ['diet', 'activity', 'ecg', 'procedure']
          },
          details: { type: 'object', minProperties: 1, additionalProperties: true }
        }
      }
    ]
  },
  // BulkOrderRequest — { orders: [...] } (each item same flat-or-nested shape).
  EmrBulkOrderRequest: {
    type: 'object', additionalProperties: true, required: ['orders'],
    description: 'Each item uses EmrCreateOrderRequest. A batch-level encounter_id is inherited by items that omit it, including the inpatient-medication ward-supply requirement on details.',
    properties: {
      encounter_id: { type: 'string', format: 'uuid', nullable: true },
      // No base-level `items`: the two oneOf branches are the sole authority on
      // item shape. Base properties apply IN ADDITION to the selected branch, so
      // a base `items: EmrCreateOrderRequest` would also demand a per-item
      // `encounter_id` on medication orders (EmrCreateOrderRequest's medication
      // variant requires it) — contradicting the batch-level branch, whose whole
      // purpose is items that INHERIT the batch encounter_id and omit their own
      // (orderRoutes.js:458-462). That published contract refused a request the
      // server accepts.
      // Bounds only, and deliberately no `type: 'array'`/`items` here: both
      // oneOf branches below declare the array type, the same bounds, and the
      // item schema, so the effective contract is unchanged — while a Spectral
      // `array-items` error (never baselined) is avoided without re-introducing
      // a base item schema.
      orders: {
        minItems: 1,
        maxItems: 50,
      },
    },
    oneOf: [
      {
        title: 'Batch-level inpatient encounter',
        required: ['encounter_id'],
        properties: {
          encounter_id: { type: 'string', format: 'uuid' },
          orders: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            items: { $ref: '#/components/schemas/EmrEncounterBoundOrderRequest' },
          },
        },
      },
      {
        title: 'Per-item encounter context',
        not: {
          required: ['encounter_id'],
          properties: { encounter_id: { type: 'string' } },
        },
        properties: {
          orders: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            items: { $ref: '#/components/schemas/EmrCreateOrderRequest' },
          },
        },
      },
    ],
  },
  // ApplyOrderSetRequest — patient_uid + order_set_id required.
  EmrApplyOrderSetRequest: {
    type: 'object', additionalProperties: true,
    required: ['patient_uid', 'order_set_id'],
    properties: {
      patient_uid: { type: 'string', format: 'uuid' },
      order_set_id: { type: 'integer' },
      encounter_id: { type: 'string', format: 'uuid' },
    },
  },
  // OrderReasonRequest — cancel/discontinue require `reason`.
  EmrOrderReasonRequest: {
    type: 'object', additionalProperties: true, required: ['reason'],
    properties: { reason: { type: 'string' } },
  },
  // CreateOrderSetRequest — name + category + orders required (loose items).
  EmrCreateOrderSetRequest: {
    type: 'object', additionalProperties: true,
    required: ['name', 'category', 'orders'],
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      category: { type: 'string' },
      orders: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
  },

  // =========================================================================
  // observations sub-domain — shared schemas
  // (vitalsRoutes.js + cdsRoutes.js + clinicalTimelineRoutes.js →
  // vitalsChartService / cdsEngine / news2Service / canonicalClinicalPlatform.
  // EMR-only mount, NOT aliased to /api/v1/admissions. Every response wraps via
  // success(res,data,…). CRITICAL: Decimal vitals + amount_ml serialize as
  // STRINGS — typed {type:'string',nullable:true}, NOT number. jsonb columns →
  // parsed objects, never string.)
  // =========================================================================

  // ---- GrowthSnapshot ----------------------------------------------------
  // computeGrowthSnapshot output attached onto VitalRow on read/POST (NOT a
  // column). `metrics` is a sparse per-metric map (weight_kg/height_cm → {z_score,
  // percentile, classification, source, ...}). LOOSE (metrics map is open).
  GrowthSnapshot: {
    type: 'object',
    additionalProperties: true,
    required: ['sex', 'age_in_days', 'reference_dataset', 'metrics'],
    properties: {
      sex: { type: 'string' },
      age_in_days: { type: 'integer' },
      reference_dataset: { type: 'string' },
      metrics: { type: 'object', additionalProperties: { type: 'object', additionalProperties: true } },
    },
  },

  // ---- VitalRow ----------------------------------------------------------
  // VITAL_SELECT projection (vitalsChartService lines 201-247) + attached
  // `growth` (GrowthSnapshot|null) on read/POST. Decimal vitals → STRING|null;
  // gcs_score/triage_acuity → INT|null. LOOSE (growth is best-effort enrichment;
  // additionalProperties:true keeps late-migration vital columns valid).
  VitalRow: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'patient_uid'],
    properties: {
      id: { type: 'integer' },
      patient_uid: { type: 'string', format: 'uuid' },
      encounter_id: { type: 'integer', nullable: true },
      encounter_uid: { type: 'string', format: 'uuid', nullable: true },
      source: { type: 'string', nullable: true, enum: VITAL_SOURCE },
      source_device: { type: 'string', nullable: true },
      device_verified: { type: 'boolean', nullable: true },
      // Decimal columns → STRING on the wire (Prisma.Decimal.toJSON → string).
      heart_rate: { type: 'string', nullable: true },
      systolic_bp: { type: 'string', nullable: true },
      diastolic_bp: { type: 'string', nullable: true },
      temperature: { type: 'string', nullable: true },
      temperature_route: { type: 'string', nullable: true, enum: TEMPERATURE_ROUTE },
      spo2: { type: 'string', nullable: true },
      respiratory_rate: { type: 'string', nullable: true },
      blood_glucose: { type: 'string', nullable: true },
      pain_score: { type: 'string', nullable: true },
      weight_kg: { type: 'string', nullable: true },
      height_cm: { type: 'string', nullable: true },
      o2_flow_rate: { type: 'string', nullable: true },
      fhr: { type: 'string', nullable: true },
      fundal_height_cm: { type: 'string', nullable: true },
      // INT columns → real numbers.
      gcs_score: { type: 'integer', nullable: true },
      triage_acuity: { type: 'integer', nullable: true },
      supplemental_o2: { type: 'boolean', nullable: true },
      consciousness: { type: 'string', nullable: true, enum: CONSCIOUSNESS },
      urine_albumin: { type: 'string', nullable: true, enum: URINE_DIPSTICK },
      urine_sugar: { type: 'string', nullable: true, enum: URINE_DIPSTICK },
      urine_ketones: { type: 'string', nullable: true, enum: URINE_DIPSTICK },
      notes: { type: 'string', nullable: true },
      recorded_by: { type: 'string', format: 'uuid', nullable: true },
      recorded_at: { type: 'string', format: 'date-time', nullable: true },
      // Attached on read/POST (not a column). null for non-paediatric rows.
      growth: { nullable: true, allOf: [{ $ref: '#/components/schemas/GrowthSnapshot' }] },
    },
  },

  // ---- News2Summary ------------------------------------------------------
  // POST /vitals `news2` sub-object (news2Service persistNews2 RETURNING).
  // clinical_risk == risk_level (snake_case enum). STRICT.
  // Migration 652 re-score support: vitals_chart_id links the score to its
  // source vitals row, partial_score/missing_params mark genuine partial
  // scores (all nullable — pre-652 rows and standalone scores).
  News2Summary: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'patient_uid', 'total_score', 'clinical_risk'],
    properties: {
      id: { type: 'integer' },
      patient_uid: { type: 'string', format: 'uuid' },
      total_score: { type: 'integer' },
      clinical_risk: { type: 'string', enum: NEWS2_CLINICAL_RISK },
      risk_level: { type: 'string', enum: NEWS2_CLINICAL_RISK },
      vitals_chart_id: { type: 'integer', nullable: true },
      partial_score: { type: 'boolean', nullable: true },
      missing_params: { type: 'array', items: { type: 'string' }, nullable: true },
      recorded_by: { type: 'string', format: 'uuid', nullable: true },
      recorded_at: { type: 'string', format: 'date-time', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // ---- VitalsTriage ------------------------------------------------------
  // POST /vitals `triage` sub-object (propagateTriageAcuity, lines 193-197).
  // STRICT. triage_priority free string|null.
  VitalsTriage: {
    type: 'object',
    additionalProperties: false,
    required: ['triage_acuity'],
    properties: {
      triage_acuity: { type: 'integer' },
      triage_priority: { type: 'string', nullable: true },
      emergency_visit_id: { type: 'integer', nullable: true },
      appointment_id: { type: 'integer', nullable: true },
    },
  },

  // ---- VitalsRecordResult ------------------------------------------------
  // POST /vitals data = { vitals, news2, alerts, growth, triage } (201). LOOSE
  // (news2/alerts/growth/triage are best-effort enrichment). `vitals` is a typed
  // VitalRow; alerts are loose clinical-anomaly objects.
  VitalsRecordResult: {
    type: 'object',
    additionalProperties: true,
    required: ['vitals'],
    properties: {
      vitals: { $ref: '#/components/schemas/VitalRow' },
      news2: { nullable: true, allOf: [{ $ref: '#/components/schemas/News2Summary' }] },
      alerts: { type: 'array', items: { type: 'object', additionalProperties: true } },
      growth: { nullable: true, allOf: [{ $ref: '#/components/schemas/GrowthSnapshot' }] },
      triage: { nullable: true, allOf: [{ $ref: '#/components/schemas/VitalsTriage' }] },
    },
  },

  // ---- VitalsTrendPoint --------------------------------------------------
  // GET /vitals/{patientUid}/trend item { timestamp, value } (getVitalsTrend).
  // value is the selected Decimal vital → STRING|null. STRICT.
  VitalsTrendPoint: {
    type: 'object',
    additionalProperties: false,
    required: ['timestamp', 'value'],
    properties: {
      timestamp: { type: 'string', format: 'date-time', nullable: true },
      value: { type: 'string', nullable: true },
    },
  },

  // ---- IORow -------------------------------------------------------------
  // POST /io IO_SELECT projection (vitalsChartService lines 249-260).
  // amount_ml is Decimal → STRING. STRICT (fixed projection).
  IORow: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'patient_uid', 'io_type', 'category', 'amount_ml'],
    properties: {
      id: { type: 'integer' },
      patient_uid: { type: 'string', format: 'uuid' },
      encounter_id: { type: 'integer', nullable: true },
      encounter_uid: { type: 'string', format: 'uuid', nullable: true },
      io_type: { type: 'string', enum: IO_TYPE },
      category: { type: 'string', enum: IO_CATEGORY },
      amount_ml: { type: 'string', nullable: true },
      description: { type: 'string', nullable: true },
      recorded_by: { type: 'string', format: 'uuid', nullable: true },
      recorded_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // ---- IOEntry -----------------------------------------------------------
  // Reduced projection in IOBalance.entries + GET /io/{patientUid}/chart (no
  // encounter fields). amount_ml Decimal → STRING. STRICT. LIST != detail (this
  // is the reduced row; IORow is the POST detail).
  IOEntry: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'io_type', 'category', 'amount_ml'],
    properties: {
      id: { type: 'integer' },
      io_type: { type: 'string', enum: IO_TYPE },
      category: { type: 'string', enum: IO_CATEGORY },
      amount_ml: { type: 'string', nullable: true },
      description: { type: 'string', nullable: true },
      recorded_by: { type: 'string', format: 'uuid', nullable: true },
      recorded_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // ---- IOBalance ---------------------------------------------------------
  // GET /io/{patientUid}/balance (getIOBalance). totals are coerced via
  // Number(...) → real NUMBERS (unlike amount_ml on the entries). STRICT.
  IOBalance: {
    type: 'object',
    additionalProperties: false,
    required: ['date', 'total_intake', 'total_output', 'balance', 'entries'],
    properties: {
      date: { type: 'string' },
      total_intake: { type: 'number' },
      total_output: { type: 'number' },
      balance: { type: 'number' },
      entries: { type: 'array', items: { $ref: '#/components/schemas/IOEntry' } },
    },
  },

  // ---- CdsCheckAlert -----------------------------------------------------
  // In-memory alert from checkOrder + getProtocolReminders. `sourceData` is
  // heavily variable per type (drug_interaction/allergy/duplicate/critical_lab/
  // protocol_reminder shapes differ) → object additionalProperties:true. LOOSE.
  CdsCheckAlert: {
    type: 'object',
    additionalProperties: true,
    required: ['type', 'severity', 'title'],
    properties: {
      type: { type: 'string', enum: CDS_ALERT_TYPE },
      severity: { type: 'string', enum: CDS_SEVERITY },
      title: { type: 'string' },
      description: { type: 'string', nullable: true },
      canOverride: { type: 'boolean' },
      sourceData: { type: 'object', additionalProperties: true },
    },
  },

  // ---- CdsCheckResult ----------------------------------------------------
  // POST /cds/check-order data = { safe, alerts: CdsCheckAlert[] }. In-memory
  // shape — DISTINCT from the persisted CdsAlertRow. LOOSE on alerts.
  CdsCheckResult: {
    type: 'object',
    additionalProperties: true,
    required: ['safe', 'alerts'],
    properties: {
      safe: { type: 'boolean' },
      alerts: { type: 'array', items: { $ref: '#/components/schemas/CdsCheckAlert' } },
    },
  },

  // ---- CdsAlertRow -------------------------------------------------------
  // Persisted cds_alerts row, public projection (getActiveAlerts LIST +
  // acknowledgeAlert detail — IDENTICAL shape). ack_by→acknowledged_by /
  // ack_at→acknowledged_at aliases; override_reason lifted from source_data.
  // source_data jsonb → object|null (NEVER string). alert_type is a free
  // VARCHAR(100) → open string (NOT enum-bound on the persisted column). LOOSE.
  CdsAlertRow: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'patient_uid', 'alert_type', 'severity', 'title'],
    properties: {
      id: { type: 'integer' },
      patient_uid: { type: 'string', format: 'uuid' },
      encounter_id: { type: 'integer', nullable: true },
      alert_type: { type: 'string' },
      severity: { type: 'string', enum: CDS_SEVERITY },
      title: { type: 'string' },
      description: { type: 'string', nullable: true },
      source_data: { type: 'object', additionalProperties: true, nullable: true },
      acknowledged: { type: 'boolean' },
      acknowledged_by: { type: 'string', format: 'uuid', nullable: true },
      acknowledged_at: { type: 'string', format: 'date-time', nullable: true },
      override_reason: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // ---- CdsProtocol -------------------------------------------------------
  // GET/POST /cds/protocols row (listProtocols/createProtocol — IDENTICAL
  // projection). trigger_conditions/recommendations jsonb → object (default {}).
  // priority enum (default 'medium'). LOOSE on jsonb.
  CdsProtocol: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'name', 'category'],
    properties: {
      id: { type: 'integer' },
      name: { type: 'string' },
      category: { type: 'string' },
      trigger_conditions: { type: 'object', additionalProperties: true },
      recommendations: { type: 'object', additionalProperties: true },
      priority: { type: 'string', enum: CDS_PROTOCOL_PRIORITY },
      is_active: { type: 'boolean' },
      created_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // ---- TimelineEvent -----------------------------------------------------
  // GET /timeline/{patientUid} item — 3-variant union (canonical |
  // patient_generated | legacy). `canonical:true|false` discriminator; `payload`
  // jsonb → object. counts/legacy_included/generated_at go in meta, NOT here.
  // LOOSE (the three variants differ; legacy not fully traced). Required core is
  // just the discriminator + occurred_at.
  TimelineEvent: {
    type: 'object',
    additionalProperties: true,
    required: ['canonical', 'occurred_at'],
    properties: {
      id: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
      canonical: { type: 'boolean' },
      patient_generated: { type: 'boolean' },
      event_type: { type: 'string', nullable: true },
      event_subtype: { type: 'string', nullable: true },
      event_status: { type: 'string', nullable: true },
      source_table: { type: 'string', nullable: true },
      source_id: { oneOf: [{ type: 'integer' }, { type: 'string' }], nullable: true },
      resource_type: { type: 'string', nullable: true },
      resource_id: { oneOf: [{ type: 'integer' }, { type: 'string' }], nullable: true },
      encounter_id: { type: 'string', format: 'uuid', nullable: true },
      occurred_at: { type: 'string', format: 'date-time', nullable: true },
      timestamp: { type: 'string', format: 'date-time', nullable: true },
      title: { type: 'string', nullable: true },
      clinical_summary: { type: 'string', nullable: true },
      actor_uid: { type: 'string', format: 'uuid', nullable: true },
      actor_role: { type: 'string', nullable: true },
      visible_to_patient: { type: 'boolean', nullable: true },
      payload: { type: 'object', additionalProperties: true },
      tags: { type: 'array', items: { type: 'string' } },
    },
  },

  // =========================================================================
  // observations — per-endpoint `data` payloads / bare refs
  // =========================================================================

  // POST /vitals → { vitals, news2, alerts, growth, triage } (201).
  VitalsRecordData: { $ref: '#/components/schemas/VitalsRecordResult' },
  // PUT/PATCH /vitals/{vitalsId} → corrected VitalRow (no growth attached).
  VitalRowData: { $ref: '#/components/schemas/VitalRow' },
  // GET /vitals/{patientUid}/latest → VitalRow OR null (nullable data).
  VitalLatestData: { nullable: true, allOf: [{ $ref: '#/components/schemas/VitalRow' }] },
  // POST /io → IORow (201).
  IORowData: { $ref: '#/components/schemas/IORow' },
  // GET /io/{patientUid}/balance → IOBalance.
  IOBalanceData: { $ref: '#/components/schemas/IOBalance' },
  // POST /cds/check-order → { safe, alerts }.
  CdsCheckResultData: { $ref: '#/components/schemas/CdsCheckResult' },
  // POST /cds/alerts/{id}/acknowledge → single CdsAlertRow.
  CdsAlertRowData: { $ref: '#/components/schemas/CdsAlertRow' },
  // POST /cds/protocols → single CdsProtocol (201).
  CdsProtocolData: { $ref: '#/components/schemas/CdsProtocol' },

  // =========================================================================
  // observations — response envelopes
  // =========================================================================
  // POST /vitals — { vitals, news2, alerts, growth, triage } (201).
  EmrVitalsRecordResponse: envelope('VitalsRecordData'),
  // PUT/PATCH /vitals/{vitalsId} — corrected VitalRow.
  EmrVitalRowResponse: envelope('VitalRowData'),
  // GET /vitals/{patientUid}/latest — VitalRow|null.
  EmrVitalLatestResponse: envelope('VitalLatestData'),
  // GET /vitals/{patientUid}/chart — bare VitalRow[] (pagination in meta).
  EmrVitalChartResponse: listEnvelope('VitalRow'),
  // GET /vitals/{patientUid}/trend — bare VitalsTrendPoint[].
  EmrVitalsTrendResponse: listEnvelope('VitalsTrendPoint'),
  // POST /io — IORow (201).
  EmrIORecordResponse: envelope('IORowData'),
  // GET /io/{patientUid}/balance — IOBalance.
  EmrIOBalanceResponse: envelope('IOBalanceData'),
  // GET /io/{patientUid}/chart — bare IOEntry[] (reduced).
  EmrIOChartResponse: listEnvelope('IOEntry'),
  // POST /cds/check-order — { safe, alerts }.
  EmrCdsCheckResponse: envelope('CdsCheckResultData'),
  // GET /cds/alerts/{patientUid} — bare CdsAlertRow[] (persisted, LIST).
  EmrCdsAlertListResponse: listEnvelope('CdsAlertRow'),
  // POST /cds/alerts/{id}/acknowledge — single CdsAlertRow.
  EmrCdsAlertResponse: envelope('CdsAlertRowData'),
  // GET /cds/protocols — bare CdsProtocol[].
  EmrCdsProtocolListResponse: listEnvelope('CdsProtocol'),
  // POST /cds/protocols — single CdsProtocol (201).
  EmrCdsProtocolResponse: envelope('CdsProtocolData'),
  // GET /cds/protocols/check/{patientUid} — bare CdsCheckAlert[] (protocol_reminder).
  EmrCdsProtocolCheckResponse: listEnvelope('CdsCheckAlert'),
  // GET /timeline/{patientUid} — bare TimelineEvent[] (counts in meta).
  EmrTimelineResponse: listEnvelope('TimelineEvent'),

  // =========================================================================
  // observations — request bodies (LOOSE; services accept raw numeric intake).
  // =========================================================================
  // POST /vitals — patient_uid + recorded_by required (recordVitals); all vitals
  // optional numeric fields (accepts number OR string per the Decimal columns).
  EmrVitalsRequest: {
    type: 'object', additionalProperties: true,
    required: ['patient_uid'],
    properties: {
      patient_uid: { type: 'string', format: 'uuid' },
      encounter_id: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
      source: { type: 'string', enum: VITAL_SOURCE },
      heart_rate: { oneOf: [{ type: 'number' }, { type: 'string' }] },
      systolic_bp: { oneOf: [{ type: 'number' }, { type: 'string' }] },
      diastolic_bp: { oneOf: [{ type: 'number' }, { type: 'string' }] },
      temperature: { oneOf: [{ type: 'number' }, { type: 'string' }] },
      temperature_route: { type: 'string', enum: TEMPERATURE_ROUTE },
      spo2: { oneOf: [{ type: 'number' }, { type: 'string' }] },
      spo2_scale: { type: 'integer', enum: [1, 2] },
      respiratory_rate: { oneOf: [{ type: 'number' }, { type: 'string' }] },
      consciousness: { type: 'string', enum: CONSCIOUSNESS },
      notes: { type: 'string' },
    },
  },
  // PUT/PATCH /vitals/{vitalsId} — correction (correctVitals); all loose.
  EmrVitalsCorrectionRequest: looseObject,
  // POST /io — io_type + category + amount_ml + patient_uid required (recordIO).
  EmrIORequest: {
    type: 'object', additionalProperties: true,
    required: ['patient_uid', 'io_type', 'category', 'amount_ml'],
    properties: {
      patient_uid: { type: 'string', format: 'uuid' },
      encounter_id: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
      io_type: { type: 'string', enum: IO_TYPE },
      category: { type: 'string', enum: IO_CATEGORY },
      amount_ml: { oneOf: [{ type: 'number' }, { type: 'string' }] },
      description: { type: 'string' },
    },
  },
  // POST /cds/check-order — type + patient_uid required (checkOrder).
  EmrCdsCheckOrderRequest: {
    type: 'object', additionalProperties: true,
    required: ['type', 'patient_uid'],
    properties: {
      type: { type: 'string' },
      patient_uid: { type: 'string', format: 'uuid' },
      encounter_id: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
      medication_name: { type: 'string' },
      test_name: { type: 'string' },
    },
  },
  // POST /cds/alerts/{id}/acknowledge — override_reason optional (acknowledgeAlert).
  EmrCdsAcknowledgeRequest: {
    type: 'object', additionalProperties: true,
    properties: { override_reason: { type: 'string' } },
  },
  // POST /cds/protocols — name+category+trigger_conditions+recommendations required.
  EmrCreateProtocolRequest: {
    type: 'object', additionalProperties: true,
    required: ['name', 'category', 'trigger_conditions', 'recommendations'],
    properties: {
      name: { type: 'string' },
      category: { type: 'string' },
      trigger_conditions: { type: 'object', additionalProperties: true },
      recommendations: { type: 'object', additionalProperties: true },
      priority: { type: 'string', enum: CDS_PROTOCOL_PRIORITY },
      is_active: { type: 'boolean' },
    },
  },
};

// ---------------------------------------------------------------------------
// Operations — keyed under BOTH the /api/v1/emr and /api/v1/admissions prefixes
// (the route is mounted twice; both path keys survive the spec collapse). Each
// entry below is a [suffix, overlay] pair; aliasOps() fans it out to both.
// ---------------------------------------------------------------------------
const ADMISSION_LIST_QUERY_PARAMS = [
  {
    name: 'page',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 1, default: 1 },
  },
  {
    name: 'limit',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
  },
  {
    name: 'ward',
    in: 'query',
    required: false,
    schema: { type: 'string' },
  },
  {
    name: 'status',
    in: 'query',
    required: false,
    schema: { type: 'string', enum: ADMISSION_STATUS },
  },
];

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

  // -------------------------------------------------------------------------
  // admission-mgmt sub-domain (list/lookup/stats/options/board/admit/advise/
  // translations/downtime). All wrap via success(res,data,…).
  // -------------------------------------------------------------------------
  // GET /admissions → bare AdmissionListItem[] (pagination+scope in meta).
  ['GET /admissions', { parameters: ADMISSION_LIST_QUERY_PARAMS, response: 'EmrAdmissionListResponse' }],
  // POST /admissions/advise → bare appointment row (UPPERCASE appt status). STRICT.
  ['POST /admissions/advise', { request: 'EmrAdviseAdmissionRequest', response: 'EmrAdviseAdmissionResponse' }],
  // GET /admissions/patient/{uid} → { admissions, count }.
  ['GET /admissions/patient/{uid}', { response: 'EmrAdmissionHistoryResponse' }],
  // GET /admissions/stats → aggregate. STRICT.
  ['GET /admissions/stats', { response: 'EmrAdmissionStatsResponse' }],
  // POST /admit → { admission: AdmitAdmissionRow } (201).
  ['POST /admit', { request: 'EmrAdmitRequest', response: 'EmrAdmitResponse' }],
  // GET /bed-options → { beds, count }. STRICT.
  ['GET /bed-options', { response: 'EmrBedOptionsResponse' }],
  // GET /ward-options → { wards, count } (heterogeneous). LOOSE.
  ['GET /ward-options', { response: 'EmrWardOptionsResponse' }],
  // GET /command-board → { board, rows }. LOOSE composite.
  ['GET /command-board', { response: 'EmrCommandBoardResponse' }],
  // GET /lookup → AdmissionLookup (4 lookup_state branches). LOOSE.
  ['GET /lookup', { response: 'EmrAdmissionLookupResponse' }],
  // GET /clinical-ai/config → provider readiness (NOT generated content). STRICT.
  ['GET /clinical-ai/config', { response: 'EmrClinicalAiConfigResponse' }],
  // GET /translations → { translations, count } (no translated_draft). LIST.
  ['GET /translations', { response: 'EmrTranslationsListResponse' }],
  // POST /generations/{generationId}/translate → TranslationResult (AI; draft loose).
  ['POST /generations/{generationId}/translate', { request: 'EmrTranslateRequest', response: 'EmrTranslationResultResponse' }],
  // NOTE: POST /downtime-snapshot/{patientUid} is EMR-ONLY (it lives in
  // clinicalNotesRoutes.js, NOT admissionRoutes.js, so the /api/v1/admissions
  // alias does NOT cover it). Keyed under /api/v1/emr only via EMR_ONLY_OPS below.
];

// Ops that exist ONLY under /api/v1/emr (their handler is NOT in the twice-
// mounted admissionRoutes.js, so the /api/v1/admissions alias has no such path).
const EMR_ONLY_OPS = [
  ['POST /downtime-snapshot/{patientUid}', { request: 'EmrDowntimeSnapshotRequest', response: 'EmrDowntimeSnapshotResponse' }],

  // -------------------------------------------------------------------------
  // notes-diagnosis sub-domain (clinicalNotesRoutes.js + diagnosisRoutes.js —
  // EMR-only mount, NOT aliased to /api/v1/admissions). 18 ops.
  // NOTE: the static /notes/draft path is declared BEFORE /notes/{id} so the
  // spec's literal-vs-param ordering matches the router; both still emit.
  // -------------------------------------------------------------------------
  // Clinical notes — drafts (static path; data nullable on GET).
  ['GET /notes/draft', { response: 'EmrNoteDraftResponse' }],
  ['PUT /notes/draft', {
    summary: 'Store an online private note draft or evaluate a continuity replay',
    description: 'Ordinary authenticated online autosave stores the author\'s private draft. A request carrying a clinical-continuity action ID is evaluated against the facility policy: shadow records only PHI-free would-allow or would-deny evidence and never invokes the draft mutation; enforce preserves the exact approved-action behavior.',
    request: 'EmrNoteDraftUpsertRequest',
    response: 'EmrNoteDraftUpsertResponse'
  }],
  ['DELETE /notes/draft', { response: 'EmrNoteDraftDeleteResponse' }],
  // Clinical notes — create / detail / update / addendum / sign.
  ['POST /notes', { request: 'EmrCreateNoteRequest', response: 'EmrClinicalNoteResponse' }],
  ['GET /notes/{id}', { response: 'EmrClinicalNoteDetailResponse' }],
  ['PUT /notes/{id}', { request: 'EmrUpdateNoteRequest', response: 'EmrClinicalNoteResponse' }],
  ['PATCH /notes/{id}', { request: 'EmrUpdateNoteRequest', response: 'EmrClinicalNoteResponse' }],
  ['POST /notes/{id}/addendum', { request: 'EmrAddendumRequest', response: 'EmrClinicalNoteResponse' }],
  ['POST /notes/{id}/sign', { response: 'EmrClinicalNoteResponse' }],
  // Clinical notes — LIST (encounter / patient). Bare ClinicalNote[] (+ meta).
  ['GET /notes/encounter/{encounterId}', { response: 'EmrClinicalNoteListResponse' }],
  ['GET /notes/patient/{uid}', { response: 'EmrClinicalNoteListResponse' }],
  // Diagnosis — create / status (single DiagnosisWithCodings).
  ['POST /diagnosis', { request: 'EmrCreateDiagnosisRequest', response: 'EmrDiagnosisResponse' }],
  ['PUT /diagnosis/{id}/status', { request: 'EmrDiagnosisStatusRequest', response: 'EmrDiagnosisResponse' }],
  // Diagnosis — LIST (encounter / problem-list / history). Bare DiagnosisWithCodings[].
  ['GET /diagnosis/encounter/{encounterId}', { response: 'EmrDiagnosisListResponse' }],
  ['GET /diagnosis/patient/{uid}', { response: 'EmrDiagnosisListResponse' }],
  ['GET /diagnosis/patient/{uid}/history', { response: 'EmrDiagnosisListResponse' }],
  // ICD-10 search — bare Icd10Row[] (no PHI). STRICT items.
  ['GET /icd10/search', { response: 'EmrIcd10SearchResponse' }],

  // -------------------------------------------------------------------------
  // orders sub-domain (orderRoutes.js → orderEntryService.js — EMR-only mount,
  // NOT aliased to /api/v1/admissions). 12 ops. Every response wraps via
  // success(res,data,…). order/order-set rows carry jsonb (details/payload) →
  // loose objects; cds_warnings mixed string|object; apply-set mixed elements.
  // -------------------------------------------------------------------------
  // POST /orders — single create → { order, cds_warnings } (201).
  ['POST /orders', {
    request: 'EmrCreateOrderRequest',
    response: 'EmrClinicalOrderCreateResponse',
    responseStatus: 201,
    parameters: [idempotencyKeyParameter],
    security: authenticatedSecurity,
  }],
  // POST /orders/bulk — atomic batch → ClinicalOrderCreateResult[] (201).
  [
    'POST /orders/bulk',
    {
      request: 'EmrBulkOrderRequest',
      response: 'EmrClinicalOrderBulkResponse',
      responseStatus: 201,
      parameters: [idempotencyKeyParameter],
      security: authenticatedSecurity
    }
  ],
  // POST /orders/apply-set — atomic order-set application → ClinicalOrderCreateResult[] (201).
  [
    'POST /orders/apply-set',
    {
      request: 'EmrApplyOrderSetRequest',
      response: 'EmrApplyOrderSetResponse',
      responseStatus: 201,
      parameters: [idempotencyKeyParameter],
      security: authenticatedSecurity
    }
  ],
  [
    'POST /orders/{id}/retry-mar-scheduling',
    {
      summary: 'Repair a missing MAR schedule from the active CPOE order',
      description:
        'Doctor-authorized, replay-safe recovery only. The active, non-deleted same-tenant doctor role is rechecked before receipt replay and again in the serialized transaction. Replays the persisted medication order through the canonical MAR scheduler, creates no prescription changes, returns existing dose slots idempotently, and appends canonical recovery evidence. If the stored schedule is clinically invalid, the order must be discontinued and replaced through CPOE.',
      pathParameters: { id: { type: 'integer', minimum: 1 } },
      parameters: [idempotencyKeyParameter],
      security: authenticatedSecurity,
      response: 'EmrMarSchedulingRecoveryResponse'
    }
  ],
  // PUT lifecycle transitions → ClinicalOrder (single).
  [
    'PUT /orders/{id}/verify',
    {
      summary: 'Verify a persisted clinical order under current patient authority',
      description:
        'Staff clinical write; mobile Staff mode is forbidden. Nursing roles NURSING_STAFF, NURSING_INCHARGE, IP_STAFF_NURSE, IP_INCHARGE, ICU_NURSE, and ICU_INCHARGE may verify any canonical clinical order type. Pharmacy roles PHARMACY_STAFF, PHARMACY_INCHARGE, and PHARMACIST may verify medication orders only. Current device posture, active non-deleted same-tenant user, exact database role, capability, patient relationship, and persisted order type are rechecked before every replay and again in the serialized transaction. Idempotency-Key permanently binds the tenant, actor UID, actor role, order, and request body; an exact retry returns the immutable original verified response.',
      pathParameters: { id: { type: 'integer', minimum: 1 } },
      parameters: [idempotencyKeyParameter],
      security: authenticatedSecurity,
      response: 'EmrClinicalOrderResponse',
      additionalResponses: {
        400: emrErrorResponse(
          'The order identifier, order state, or required Idempotency-Key is invalid.'
        ),
        401: emrErrorResponse('API-key and bearer authentication are required.'),
        403: emrErrorResponse(
          'The current device, role, capability, patient relationship, or persisted order type does not authorize verification.'
        ),
        404: emrErrorResponse('The clinical order was not found in the authenticated tenant.'),
        409: emrErrorResponse(
          'The verification is already in flight, the order changed concurrently, or the permanent command receipt conflicts.'
        ),
        422: emrErrorResponse(
          'The Idempotency-Key was reused with a different actor role or request body.'
        ),
        503: emrErrorResponse(
          'Durable idempotency or persistence infrastructure was unavailable; the command failed closed and retry is safe.'
        )
      }
    }
  ],
  [
    'PUT /orders/{id}/complete',
    {
      description:
        'Terminally completes an authorized, verified medication order and projects every outstanding scheduled, held, or missed MAR obligation plus linked ward-indent reservation, custody, task, SLA, and reconciliation obligations atomically. Idempotency-Key is required; an exact retry replays the committed response.',
      pathParameters: { id: { type: 'integer', minimum: 1 } },
      parameters: [idempotencyKeyParameter],
      security: authenticatedSecurity,
      response: 'EmrClinicalOrderResponse'
    }
  ],
  [
    'PUT /orders/{id}/cancel',
    {
      description:
        'Terminally cancels an authorized clinical order with the supplied reason and projects every outstanding scheduled, held, or missed MAR obligation plus linked ward-indent reservation, custody, task, SLA, and reconciliation obligations atomically. Idempotency-Key is required; an exact retry replays the committed response.',
      pathParameters: { id: { type: 'integer', minimum: 1 } },
      parameters: [idempotencyKeyParameter],
      security: authenticatedSecurity,
      request: 'EmrOrderReasonRequest',
      response: 'EmrClinicalOrderResponse'
    }
  ],
  [
    'PUT /orders/{id}/discontinue',
    {
      description:
        'Terminally discontinues an authorized clinical order with the supplied reason and projects every outstanding scheduled, held, or missed MAR obligation plus linked ward-indent reservation, custody, task, SLA, and reconciliation obligations atomically. Idempotency-Key is required; an exact retry replays the committed response.',
      pathParameters: { id: { type: 'integer', minimum: 1 } },
      parameters: [idempotencyKeyParameter],
      security: authenticatedSecurity,
      request: 'EmrOrderReasonRequest',
      response: 'EmrClinicalOrderResponse'
    }
  ],
  // GET LIST (patient — flat-meta pagination / encounter — no meta). Bare ClinicalOrder[].
  ['GET /orders/patient/{uid}', { response: 'EmrClinicalOrderListResponse' }],
  ['GET /orders/encounter/{encounterId}', { response: 'EmrClinicalOrderListResponse' }],
  // Order sets — GET list (bare OrderSet[]) + POST create (single OrderSet, 201).
  ['GET /order-sets', { response: 'EmrOrderSetListResponse' }],
  ['POST /order-sets', { request: 'EmrCreateOrderSetRequest', response: 'EmrOrderSetResponse' }],

  // -------------------------------------------------------------------------
  // observations sub-domain (vitalsRoutes.js + cdsRoutes.js +
  // clinicalTimelineRoutes.js → vitalsChartService / cdsEngine /
  // canonicalClinicalPlatform). EMR-only mount, NOT aliased to /api/v1/admissions.
  // 18 ops (16 paths; vitals/{vitalsId} has PUT+PATCH, cds/protocols GET+POST).
  // Every response wraps via success(res,data,…). Decimal vitals + amount_ml are
  // STRINGS; jsonb (source_data/payload/trigger_conditions/recommendations) →
  // loose objects; NEWS2 clinical_risk snake_case; persisted alert_type open string.
  // NOTE: /icd10/search + /clinical-ai/config are already keyed (notes-diagnosis /
  // admission-mgmt passes) — NOT re-declared here.
  // -------------------------------------------------------------------------
  // Vitals — POST (record → {vitals,news2,alerts,growth,triage}, 201).
  ['POST /vitals', { request: 'EmrVitalsRequest', response: 'EmrVitalsRecordResponse' }],
  // Vitals correction — PUT + PATCH share correctVitals → corrected VitalRow.
  ['PUT /vitals/{vitalsId}', {
    parameters: [idempotencyKeyParameter],
    request: 'EmrVitalsCorrectionRequest',
    response: 'EmrVitalRowResponse',
  }],
  ['PATCH /vitals/{vitalsId}', {
    parameters: [idempotencyKeyParameter],
    request: 'EmrVitalsCorrectionRequest',
    response: 'EmrVitalRowResponse',
  }],
  // Vitals reads — chart (LIST, paginated) / latest (nullable) / trend (LIST).
  ['GET /vitals/{patientUid}/chart', { response: 'EmrVitalChartResponse' }],
  ['GET /vitals/{patientUid}/latest', { response: 'EmrVitalLatestResponse' }],
  ['GET /vitals/{patientUid}/trend', { response: 'EmrVitalsTrendResponse' }],
  // I/O — POST (record → IORow, 201) / balance / chart (reduced IOEntry[] LIST).
  ['POST /io', { request: 'EmrIORequest', response: 'EmrIORecordResponse' }],
  ['GET /io/{patientUid}/balance', { response: 'EmrIOBalanceResponse' }],
  ['GET /io/{patientUid}/chart', { response: 'EmrIOChartResponse' }],
  // CDS — active alerts (persisted CdsAlertRow[] LIST) + acknowledge (detail).
  ['GET /cds/alerts/{patientUid}', { response: 'EmrCdsAlertListResponse' }],
  ['POST /cds/alerts/{id}/acknowledge', { request: 'EmrCdsAcknowledgeRequest', response: 'EmrCdsAlertResponse' }],
  // CDS — check-order ({safe,alerts} in-memory CdsCheckAlert[]).
  ['POST /cds/check-order', { request: 'EmrCdsCheckOrderRequest', response: 'EmrCdsCheckResponse' }],
  // CDS — protocols list (CdsProtocol[]) + create (single, 201) + check (LIST).
  ['GET /cds/protocols', { response: 'EmrCdsProtocolListResponse' }],
  ['POST /cds/protocols', { request: 'EmrCreateProtocolRequest', response: 'EmrCdsProtocolResponse' }],
  ['GET /cds/protocols/check/{patientUid}', { response: 'EmrCdsProtocolCheckResponse' }],
  // Timeline — bare TimelineEvent[] (3-variant union; counts in meta).
  ['GET /timeline/{patientUid}', { response: 'EmrTimelineResponse' }],

  // NOTE: the mar sub-domain (clinicalRoutes.js reached via the
  // /api/v1/emr/mar/* req.url-rewrite alias of canonical /api/v1/clinical/mar/*)
  // is intentionally NOT overlaid here — the generator now skips the alias mount,
  // so those paths never appear in the spec. See app.js + generate-openapi.mjs.
];

const PREFIXES = ['/api/v1/emr', '/api/v1/admissions'];

/** Fan each [«METHOD /suffix», overlay] out to the given mount prefixes. */
function aliasOps(pairs, prefixes = PREFIXES) {
  const out = {};
  for (const [methodSuffix, ov] of pairs) {
    const spaceIdx = methodSuffix.indexOf(' ');
    const method = methodSuffix.slice(0, spaceIdx);
    const suffix = methodSuffix.slice(spaceIdx + 1);
    for (const pre of prefixes) out[`${method} ${pre}${suffix}`] = ov;
  }
  return out;
}

export const operations = {
  ...aliasOps(OPS),
  // EMR-only ops keyed under the /api/v1/emr prefix only.
  ...aliasOps(EMR_ONLY_OPS, ['/api/v1/emr']),
};
