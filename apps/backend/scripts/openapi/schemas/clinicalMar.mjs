// OpenAPI Phase 5 — Canonical clinical MAR overlay. Typed request/response
// schemas for the 9 canonical /api/v1/clinical/mar/* ops (the surface the
// /api/v1/emr/mar/* + /api/v1/nursing/mar/* runtime aliases proxy to). This is
// the LAST untyped surface of the OpenAPI contract-pipeline epic.
//
// Authored from the EXACT service returns:
//   - src/services/clinical/marService.js (schedule / administer / miss / hold /
//     getPatientMAR / getOverdue / getDue) — all project the
//     medication_administrations row (explicit column lists, varying subsets).
//   - src/services/clinical/marFiveRightsService.js (evaluate5Rights /
//     administerWithScan).
// The live contract test (clinical-mar-contract.deep.test.js) is the proof.
//
// Typing rules (from the prior slices): `status` is FREE-FORM (no DB CHECK on
// medication_administrations) → plain string, NOT an enum. jsonb (rights_passed)
// → object. The row projections are LOOSE (additionalProperties:true, small
// required core) because each op returns a different column subset and a number
// of columns are nullable depending on the lifecycle state.
import { envelope, listEnvelope } from './_helpers.mjs';

export const schemas = {
  // ---- The medication_administrations row -------------------------------
  // Superset of the columns the write ops (schedule/administer/miss/hold/
  // administer-with-scan) and the patient/overdue list ops project. LOOSE: a
  // given op returns a subset, and lifecycle columns (administered_*, *_reason,
  // scan timestamps) are null until the matching transition fires. Only id +
  // status are guaranteed on every projection.
  MarRecord: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'status'],
    properties: {
      id: { type: 'integer' },
      patient_uid: { type: 'string', format: 'uuid' },
      prescription_id: { type: 'integer', nullable: true },
      medication_name: { type: 'string', nullable: true },
      dose: { type: 'string', nullable: true },
      dosage: { type: 'string', nullable: true },
      route: { type: 'string', nullable: true },
      scheduled_time: { type: 'string', format: 'date-time', nullable: true },
      administered_at: { type: 'string', format: 'date-time', nullable: true },
      administered_by: { type: 'string', format: 'uuid', nullable: true },
      held_at: { type: 'string', format: 'date-time', nullable: true },
      held_by: { type: 'string', format: 'uuid', nullable: true },
      missed_at: { type: 'string', format: 'date-time', nullable: true },
      missed_by: { type: 'string', format: 'uuid', nullable: true },
      // Free-form (no medication_administrations status CHECK): scheduled →
      // administered | missed | held. Plain string on purpose.
      status: { type: 'string' },
      notes: { type: 'string', nullable: true },
      witness_uid: { type: 'string', format: 'uuid', nullable: true },
      override_reason: { type: 'string', nullable: true },
      hold_reason: { type: 'string', nullable: true },
      refusal_reason: { type: 'string', nullable: true },
      rights_passed: { type: 'object', additionalProperties: true, nullable: true },
      all_rights_passed: { type: 'boolean', nullable: true },
      scanned_patient_uid: { type: 'string', format: 'uuid', nullable: true },
      scanned_barcode: { type: 'string', nullable: true },
      patient_scanned_at: { type: 'string', format: 'date-time', nullable: true },
      medication_scanned_at: { type: 'string', format: 'date-time', nullable: true },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  // ---- The nurse "due meds" list row ------------------------------------
  // getDueMedications joins patient name + bed/ward onto the MAR row so the
  // client renders the list in one fetch. LOOSE (same row family + LEFT JOIN
  // columns that are null when the patient is unassigned to a bed).
  MarDueItem: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'status'],
    properties: {
      id: { type: 'integer' },
      patient_uid: { type: 'string', format: 'uuid' },
      medication_name: { type: 'string', nullable: true },
      dose: { type: 'string', nullable: true },
      dosage: { type: 'string', nullable: true },
      route: { type: 'string', nullable: true },
      scheduled_time: { type: 'string', format: 'date-time', nullable: true },
      status: { type: 'string' },
      notes: { type: 'string', nullable: true },
      patient_name: { type: 'string', nullable: true },
      bed_number: { type: 'string', nullable: true },
      ward_id: { type: 'integer', nullable: true },
      ward_name: { type: 'string', nullable: true },
    },
  },

  // ---- 5-rights dry-run check (POST /mar/verify) ------------------------
  // The five rights, each a pass/fail boolean. Strict (fixed key set).
  MarFiveRights: {
    type: 'object',
    additionalProperties: false,
    required: ['patient', 'drug', 'dose', 'route', 'time'],
    properties: {
      patient: { type: 'boolean' },
      drug: { type: 'boolean' },
      dose: { type: 'boolean' },
      route: { type: 'boolean' },
      time: { type: 'boolean' },
    },
  },
  // evaluate5Rights return — { ma, rights, allPassed, context }. ma + context are
  // LOOSE (reduced projection / computed context bag).
  MarVerifyResult: {
    type: 'object',
    additionalProperties: false,
    required: ['ma', 'rights', 'allPassed', 'context'],
    properties: {
      ma: {
        type: 'object',
        additionalProperties: true,
        required: ['id'],
        properties: {
          id: { type: 'integer' },
          patient_uid: { type: 'string', format: 'uuid' },
          medication_name: { type: 'string', nullable: true },
          dose: { type: 'string', nullable: true },
          route: { type: 'string', nullable: true },
          scheduled_time: { type: 'string', format: 'date-time', nullable: true },
          status: { type: 'string' },
          tenant_id: { type: 'string', format: 'uuid', nullable: true },
        },
      },
      rights: { $ref: '#/components/schemas/MarFiveRights' },
      allPassed: { type: 'boolean' },
      context: { type: 'object', additionalProperties: true },
    },
  },

  // ---- Response envelopes ------------------------------------------------
  MarRecordResponse: envelope('MarRecord'),
  MarRecordListResponse: listEnvelope('MarRecord'),
  MarDueListResponse: listEnvelope('MarDueItem'),
  MarVerifyResponse: envelope('MarVerifyResult'),

  // ---- Request bodies ----------------------------------------------------
  MarScheduleRequest: {
    type: 'object',
    additionalProperties: true,
    required: ['patient_uid'],
    properties: {
      patient_uid: { type: 'string', format: 'uuid' },
      prescription_id: { type: 'integer', nullable: true },
      // The public route is now a readiness probe only. Medication rows are
      // scheduled from POST /emr/orders so CPOE, ward custody, billing, and
      // clinical-order identity cannot be bypassed.
      medications: {
        type: 'array',
        maxItems: 0,
        items: { type: 'object', additionalProperties: true },
      },
    },
  },
  MarAdministerRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      notes: { type: 'string' },
      witness_uid: { type: 'string', format: 'uuid' },
      // ≥5 chars required while MAR_REQUIRE_BARCODE_SCAN is on (scan-first policy).
      override_reason: { type: 'string' },
    },
  },
  MarVerifyRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['ma_id', 'scanned_patient_uid', 'scanned_barcode'],
    properties: {
      ma_id: { type: 'integer' },
      scanned_patient_uid: { type: 'string', format: 'uuid' },
      scanned_barcode: { type: 'string' },
    },
  },
  MarAdministerWithScanRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['scanned_patient_uid', 'scanned_barcode'],
    properties: {
      scanned_patient_uid: { type: 'string', format: 'uuid' },
      scanned_barcode: { type: 'string' },
      override_reason: { type: 'string' },
    },
  },
  MarMissRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: { reason: { type: 'string' } },
  },
  MarHoldRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: { reason: { type: 'string' } },
  },
};

export const operations = {
  // POST /mar/schedule → readiness-only empty array (201). Non-empty requests
  // fail closed and must use the governed /emr/orders workflow.
  'POST /api/v1/clinical/mar/schedule': {
    request: 'MarScheduleRequest',
    response: 'MarRecordListResponse',
  },
  // POST /mar/{id}/administer → the updated (administered) MAR row.
  'POST /api/v1/clinical/mar/{id}/administer': {
    request: 'MarAdministerRequest',
    response: 'MarRecordResponse',
  },
  // POST /mar/verify → 5-rights dry-run { ma, rights, allPassed, context }.
  'POST /api/v1/clinical/mar/verify': {
    request: 'MarVerifyRequest',
    response: 'MarVerifyResponse',
  },
  // POST /mar/{id}/administer-with-scan → the committed MAR row (rights_passed +
  // scan timestamps populated).
  'POST /api/v1/clinical/mar/{id}/administer-with-scan': {
    request: 'MarAdministerWithScanRequest',
    response: 'MarRecordResponse',
  },
  // POST /mar/{id}/miss → the updated (missed) MAR row.
  'POST /api/v1/clinical/mar/{id}/miss': {
    request: 'MarMissRequest',
    response: 'MarRecordResponse',
  },
  // POST /mar/{id}/hold → the updated (held) MAR row.
  'POST /api/v1/clinical/mar/{id}/hold': {
    request: 'MarHoldRequest',
    response: 'MarRecordResponse',
  },
  // GET /mar/patient/{patientUid} → the patient's MAR rows for a day.
  'GET /api/v1/clinical/mar/patient/{patientUid}': {
    response: 'MarRecordListResponse',
  },
  // GET /mar/overdue → scheduled rows past their scheduled_time.
  'GET /api/v1/clinical/mar/overdue': {
    response: 'MarRecordListResponse',
  },
  // GET /mar/due → the nurse due-meds list (MAR row + patient/bed/ward join).
  'GET /api/v1/clinical/mar/due': {
    parameters: [
      {
        name: 'ward_id',
        in: 'query',
        required: false,
        schema: { type: 'integer' },
      },
      {
        name: 'past_minutes',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 0, maximum: 1440, default: 120 },
      },
      {
        name: 'future_minutes',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 0, maximum: 1440, default: 60 },
      },
    ],
    response: 'MarDueListResponse',
  },
};
