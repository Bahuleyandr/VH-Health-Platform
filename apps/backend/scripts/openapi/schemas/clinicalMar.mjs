// OpenAPI Phase 5 — Canonical clinical MAR overlay. Typed request/response
// schemas for the canonical /api/v1/clinical/mar/* ops (the surface the
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

const medicationAdministrationId = () => ({
  type: 'integer',
  minimum: 1,
  maximum: 2_147_483_647,
  description: 'Positive PostgreSQL INTEGER medication-administration identifier.',
});

const signedBigIntId = (description) => ({
  type: 'string',
  pattern: '^[1-9][0-9]{0,18}$',
  maxLength: 19,
  'x-vhhealth-maximumDecimal': '9223372036854775807',
  description,
});

const marExceptionCaseId = () => ({
  type: 'string',
  pattern: '^[1-9][0-9]{0,18}$',
  maxLength: 19,
  'x-vhhealth-maximumDecimal': '9223372036854775807',
  description: 'Canonical positive signed-64 decimal identifier; never encode as a JSON number.',
});

const marExceptionEventId = () => ({
  type: 'string',
  pattern: '^[1-9][0-9]{0,18}$',
  maxLength: 19,
  'x-vhhealth-maximumDecimal': '9223372036854775807',
  description: 'Canonical positive signed-64 decimal event identifier; never encode as a JSON number.',
});
const authenticatedSecurity = [{ ApiKeyAuth: [], BearerAuth: [] }];

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
      id: medicationAdministrationId(),
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
      id: medicationAdministrationId(),
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
          id: medicationAdministrationId(),
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
  MarSupplyStateResponse: envelope('MarSupplyState'),
  MarSupplyReconciliationResponse: envelope('MarSupplyReconciliationResult'),
  MarMedicationExceptionListResponse: listEnvelope('MarMedicationExceptionItem'),
  MarMedicationExceptionClaimResponse: envelope(
    'MarMedicationExceptionClaimResult',
  ),
  MarMedicationExceptionHandoffResponse: envelope(
    'MarMedicationExceptionHandoffResult',
  ),
  MarMedicationExceptionDispositionResponse: envelope(
    'MarMedicationExceptionDispositionResult',
  ),

  // ---- Prescriber medication-exception queue ----------------------------
  MarMedicationExceptionItem: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'exception_case_id',
      'exception_kind',
      'exception_reason',
      'raised_at',
      'notification_coverage_status',
      'patient_uid',
      'status',
      'exception_task_id',
      'exception_task_status',
      'exception_due_at',
      'exception_sla_status',
    ],
    properties: {
      id: medicationAdministrationId(),
      exception_case_id: marExceptionCaseId(),
      exception_kind: { type: 'string', enum: ['held', 'missed'] },
      exception_reason: { type: 'string' },
      raised_at: { type: 'string', format: 'date-time' },
      notification_coverage_status: {
        type: 'string',
        enum: ['notified', 'coverage_gap'],
      },
      patient_uid: { type: 'string', format: 'uuid' },
      medication_name: { type: 'string', nullable: true },
      dose: { type: 'string', nullable: true },
      dosage: { type: 'string', nullable: true },
      route: { type: 'string', nullable: true },
      scheduled_time: { type: 'string', format: 'date-time', nullable: true },
      status: { type: 'string' },
      notes: { type: 'string', nullable: true },
      clinical_order_id: { type: 'integer', minimum: 1 },
      encounter_id: { type: 'string', format: 'uuid', nullable: true },
      clinical_order_status: { type: 'string' },
      patient_name: { type: 'string', nullable: true },
      bed_number: { type: 'string', nullable: true },
      ward_id: { type: 'integer', nullable: true },
      ward_name: { type: 'string', nullable: true },
      exception_task_id: { type: 'integer', minimum: 1 },
      exception_task_status: { type: 'string' },
      exception_due_at: { type: 'string', format: 'date-time' },
      exception_sla_status: { type: 'string' },
    },
  },
  MarMedicationExceptionDispositionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['disposition', 'reason'],
    properties: {
      disposition: {
        type: 'string',
        enum: ['reviewed_no_replacement', 'replacement_ordered', 'order_stopped'],
      },
      reason: { type: 'string', minLength: 5, maxLength: 500 },
      replacement_clinical_order_id: {
        type: 'integer',
        minimum: 1,
        nullable: true,
        description: 'Required only for replacement_ordered; it must reference a separately authorized active medication order.',
      },
    },
  },
  MarMedicationExceptionClaimResult: {
    type: 'object',
    additionalProperties: false,
    required: [
      'exception_case_id',
      'medication_administration_id',
      'task_id',
      'assigned_prescriber_uid',
      'status',
      'deep_link',
      'replayed',
    ],
    properties: {
      exception_case_id: marExceptionCaseId(),
      medication_administration_id: medicationAdministrationId(),
      task_id: { type: 'integer', minimum: 1 },
      assigned_prescriber_uid: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['open'] },
      deep_link: { type: 'string', pattern: '^/mar/due\\?exception_id=[1-9][0-9]{0,18}$' },
      replayed: { type: 'boolean' },
    },
  },
  MarMedicationExceptionHandoffRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['expected_prescriber_uid', 'target_prescriber_uid', 'reason'],
    properties: {
      expected_prescriber_uid: { type: 'string', format: 'uuid' },
      target_prescriber_uid: { type: 'string', format: 'uuid' },
      reason: { type: 'string', minLength: 5, maxLength: 500 },
    },
  },
  MarMedicationExceptionHandoffResult: {
    type: 'object',
    additionalProperties: false,
    required: [
      'exception_case_id',
      'task_id',
      'assignment_handoff_event_id',
      'from_prescriber_uid',
      'assigned_prescriber_uid',
      'handed_off_at',
      'deep_link',
      'replayed',
    ],
    properties: {
      exception_case_id: marExceptionCaseId(),
      task_id: { type: 'integer', minimum: 1 },
      assignment_handoff_event_id: marExceptionEventId(),
      from_prescriber_uid: { type: 'string', format: 'uuid' },
      assigned_prescriber_uid: { type: 'string', format: 'uuid' },
      handed_off_at: { type: 'string', format: 'date-time' },
      deep_link: { type: 'string', pattern: '^/mar/due\\?exception_id=[1-9][0-9]{0,18}$' },
      replayed: { type: 'boolean' },
    },
  },
  MarMedicationExceptionDispositionResult: {
    type: 'object',
    additionalProperties: false,
    required: [
      'exception_case_id',
      'medication_administration_id',
      'status',
      'disposition',
      'resolution_event_id',
      'replayed',
    ],
    properties: {
      exception_case_id: marExceptionCaseId(),
      medication_administration_id: medicationAdministrationId(),
      status: { type: 'string', enum: ['resolved'] },
      disposition: {
        type: 'string',
        enum: ['reviewed_no_replacement', 'replacement_ordered', 'order_stopped'],
      },
      resolution_event_id: marExceptionEventId(),
      replayed: { type: 'boolean' },
    },
  },

  // ---- Ward-custody supply evidence --------------------------------------
  MarSupplyState: {
    type: 'object',
    additionalProperties: false,
    required: [
      'status',
      'medication_administration_id',
      'clinical_order_id',
      'supply_quantity_per_dose',
      'allocations',
      'consumptions',
    ],
    properties: {
      status: {
        type: 'string',
        enum: [
          'order_link_required',
          'ward_item_required',
          'ward_item_ambiguous',
          'reconciliation_required',
          'substitution_acknowledgement_required',
          'quantity_required',
          'available',
          'batch_unavailable',
          'custody_unavailable',
        ],
      },
      medication_administration_id: medicationAdministrationId(),
      clinical_order_id: { type: 'integer', minimum: 1, nullable: true },
      supply_quantity_per_dose: { type: 'number', minimum: 0, nullable: true },
      available_quantity: { type: 'number', minimum: 0 },
      ward_indent: { type: 'object', additionalProperties: true },
      ward_indent_item: { type: 'object', additionalProperties: true },
      allocations: {
        type: 'array',
        items: { $ref: '#/components/schemas/MarSupplyAllocation' },
      },
      consumptions: {
        type: 'array',
        items: { $ref: '#/components/schemas/MarSupplyConsumption' },
      },
    },
  },
  MarSupplyAllocation: {
    type: 'object',
    additionalProperties: true,
    required: ['id'],
    properties: {
      id: signedBigIntId(
        'Canonical positive signed-64 ward inventory-allocation identifier; never encode as a JSON number.',
      ),
    },
  },
  MarSupplyConsumption: {
    type: 'object',
    additionalProperties: true,
    required: ['id'],
    properties: {
      id: signedBigIntId(
        'Canonical positive signed-64 MAR supply-consumption identifier; never encode as a JSON number.',
      ),
      inventory_allocation_id: {
        ...signedBigIntId(
          'Canonical positive signed-64 inventory-allocation identifier; never encode as a JSON number.',
        ),
        nullable: true,
      },
    },
  },
  MarSupplyReconciliationLink: {
    type: 'object',
    additionalProperties: true,
    required: ['unmatched_consumption_id', 'inventory_allocation_id'],
    properties: {
      unmatched_consumption_id: signedBigIntId(
        'Canonical positive signed-64 MAR supply-consumption identifier; never encode as a JSON number.',
      ),
      inventory_allocation_id: signedBigIntId(
        'Canonical positive signed-64 inventory-allocation identifier; never encode as a JSON number.',
      ),
    },
  },
  MarSupplyReconciliationAllocation: {
    type: 'object',
    additionalProperties: false,
    required: ['inventory_allocation_id', 'quantity'],
    properties: {
      inventory_allocation_id: signedBigIntId(
        'Canonical positive signed-64 inventory-allocation identifier; never encode as a JSON number.',
      ),
      quantity: { type: 'number', minimum: 0, exclusiveMinimum: true },
    },
  },
  MarSupplyReconciliationRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['allocations'],
    properties: {
      allocations: {
        type: 'array',
        minItems: 1,
        items: { $ref: '#/components/schemas/MarSupplyReconciliationAllocation' },
      },
    },
  },
  MarSupplyReconciliationResult: {
    type: 'object',
    additionalProperties: false,
    required: [
      'consumption',
      'links',
      'reconciled_quantity',
      'outstanding_quantity',
      'state',
    ],
    properties: {
      consumption: { $ref: '#/components/schemas/MarSupplyConsumption' },
      links: {
        type: 'array',
        minItems: 1,
        items: { $ref: '#/components/schemas/MarSupplyReconciliationLink' },
      },
      reconciled_quantity: { type: 'number', minimum: 0 },
      outstanding_quantity: { type: 'number', minimum: 0 },
      state: { $ref: '#/components/schemas/MarSupplyState' },
    },
  },

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
      supply_override_reason: { type: 'string', minLength: 1, maxLength: 500 },
      supply_quantity: { type: 'number', minimum: 0, exclusiveMinimum: true },
    },
  },
  MarVerifyRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['ma_id', 'scanned_patient_uid', 'scanned_barcode'],
    properties: {
      ma_id: medicationAdministrationId(),
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
      witness_uid: { type: 'string', format: 'uuid' },
      override_reason: { type: 'string' },
      supply_override_reason: { type: 'string', minLength: 1, maxLength: 500 },
      supply_quantity: { type: 'number', minimum: 0, exclusiveMinimum: true },
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

const marIdempotencyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description: 'Stable command key. Exact retries replay the original durable MAR transition.',
  schema: { type: 'string', minLength: 1, maxLength: 200 },
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
    parameters: [marIdempotencyParameter],
    pathParameters: { id: medicationAdministrationId() },
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
    parameters: [marIdempotencyParameter],
    pathParameters: { id: medicationAdministrationId() },
  },
  // POST /mar/{id}/miss → the updated (missed) MAR row.
  'POST /api/v1/clinical/mar/{id}/miss': {
    request: 'MarMissRequest',
    response: 'MarRecordResponse',
    parameters: [marIdempotencyParameter],
    pathParameters: { id: medicationAdministrationId() },
  },
  // POST /mar/{id}/hold → the updated (held) MAR row.
  'POST /api/v1/clinical/mar/{id}/hold': {
    request: 'MarHoldRequest',
    response: 'MarRecordResponse',
    parameters: [marIdempotencyParameter],
    pathParameters: { id: medicationAdministrationId() },
  },
  // POST /mar/{id}/release-hold → prescriber-authorized return to scheduled.
  'POST /api/v1/clinical/mar/{id}/release-hold': {
    description: 'Releases a held dose back to scheduled only after an active prescriber records a reason; the original hold attribution remains immutable. Idempotency-Key is required.',
    request: 'MarHoldRequest',
    response: 'MarRecordResponse',
    parameters: [marIdempotencyParameter],
    pathParameters: {
      id: medicationAdministrationId(),
    },
    security: authenticatedSecurity,
  },
  'GET /api/v1/clinical/mar/exceptions': {
    description: 'Returns only open held/missed dose obligations assigned to the authenticated active prescriber, including exact task and SLA state.',
    parameters: [
      {
        name: 'case_id',
        in: 'query',
        required: false,
        schema: marExceptionCaseId(),
      },
    ],
    response: 'MarMedicationExceptionListResponse',
    security: authenticatedSecurity,
  },
  'POST /api/v1/clinical/mar/exceptions/{caseId}/claim': {
    description: 'Atomically claims an unassigned DOCTOR role-queue medication exception for the authenticated active prescriber, aligning the case, task, and SLA owner. Exact retries replay by Idempotency-Key.',
    response: 'MarMedicationExceptionClaimResponse',
    pathParameters: { caseId: marExceptionCaseId() },
    parameters: [marIdempotencyParameter],
    security: authenticatedSecurity,
  },
  'POST /api/v1/clinical/mar/exceptions/{caseId}/handoff': {
    description: 'Allows only an active ADMIN or SUPER_ADMIN to atomically reassign one open named medication-exception case, task, and SLA from the expected prescriber to another active prescriber. The append-only command receipt and target notification are required; exact retries replay by Idempotency-Key.',
    request: 'MarMedicationExceptionHandoffRequest',
    response: 'MarMedicationExceptionHandoffResponse',
    pathParameters: { caseId: marExceptionCaseId() },
    parameters: [marIdempotencyParameter],
    security: authenticatedSecurity,
  },
  'POST /api/v1/clinical/mar/exceptions/{caseId}/disposition': {
    description: 'Records a bounded prescriber review without mutating treatment. Replacement and stopped-order dispositions require independently authorized canonical order evidence.',
    request: 'MarMedicationExceptionDispositionRequest',
    response: 'MarMedicationExceptionDispositionResponse',
    pathParameters: { caseId: marExceptionCaseId() },
    parameters: [marIdempotencyParameter],
    security: authenticatedSecurity,
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
  'GET /api/v1/clinical/mar/{id}/supply': {
    description: 'Returns the tenant-scoped ward-custody allocations, consumption evidence, reconciliation state, and remaining supply readiness for one MAR dose.',
    response: 'MarSupplyStateResponse',
    pathParameters: { id: medicationAdministrationId() },
  },
  'POST /api/v1/clinical/mar/{id}/supply-overrides/{consumptionId}/reconcile': {
    description: 'Binds an unmatched emergency MAR supply override to exact ward inventory allocations, closes its task when fully reconciled, and replays exact retries by Idempotency-Key.',
    request: 'MarSupplyReconciliationRequest',
    response: 'MarSupplyReconciliationResponse',
    pathParameters: {
      id: medicationAdministrationId(),
      consumptionId: signedBigIntId(
        'Canonical positive signed-64 MAR supply-consumption identifier; never encode as a JSON number.',
      ),
    },
    parameters: [marIdempotencyParameter],
  },
};
