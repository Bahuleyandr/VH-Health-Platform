import { envelope } from './_helpers.mjs';

const PATIENT_VISIBLE_NOTE_TYPES = [
  'op_consultation',
  'consultation',
  'consultation_note',
  'follow_up',
  'follow-up',
  'progress',
  'soap',
];

const clinicalNoteDemarcation =
  'Patient portal clinical-note reads return only signed outpatient notes with a first-class clinical_notes.appointment_id link. Inpatient, ward, case-sheet, procedure, discharge-source, and legacy JSON/time-window-linked notes are intentionally excluded.';

const PATIENT_NEXT_STEP_STATUSES = [
  'planned',
  'open',
  'scheduled',
  'pending',
  'in_progress',
  'ready',
  'completed',
  'cancelled',
  'on_hold',
  'overdue',
];

const PATIENT_NEXT_STEP_ROUTE_TOKENS = [
  'home',
  'health',
  'appointments',
  'investigations',
  'lab_results',
  'diagnostic_results',
  'referrals',
  'discharge_summaries',
  'messages',
];

const PATIENT_CLINICIAN_ROLES = [
  'Doctor',
  'Nurse',
  'Pharmacist',
  'Physiotherapist',
  'Dietitian',
];

const PATIENT_PENDING_RESULT_STATUSES = ['pending', 'ready', 'completed'];
const PATIENT_VISIBLE_DISCHARGE_STATUSES = ['signed', 'delivered'];
const DISCHARGE_DELIVERY_METHODS = ['printed', 'email', 'whatsapp', 'abdm', 'sms'];

const nullableString = { type: 'string', nullable: true };
const nullableDateTime = { type: 'string', format: 'date-time', nullable: true };
const nullableInteger = { type: 'integer', nullable: true };
const strictEnvelope = (schemaName) => {
  const base = envelope(schemaName);
  return {
    ...base,
    additionalProperties: false,
    properties: {
      ...base.properties,
      requestId: { type: 'string', minLength: 1, maxLength: 200 },
    },
  };
};

export const schemas = {
  PortalWhatsNextStep: {
    type: 'object',
    additionalProperties: false,
    required: [
      'label',
      'explanation',
      'due_date',
      'status',
      'patient_action',
      'responsible_clinician_display_name',
      'responsible_clinician_role',
      'safe_contact',
      'route_token',
    ],
    properties: {
      label: { type: 'string', minLength: 1, maxLength: 180 },
      explanation: { type: 'string', nullable: true, maxLength: 1200 },
      due_date: { type: 'string', format: 'date', nullable: true },
      status: {
        type: 'string',
        nullable: true,
        enum: PATIENT_NEXT_STEP_STATUSES,
      },
      patient_action: { type: 'string', nullable: true, maxLength: 500 },
      responsible_clinician_display_name: {
        type: 'string',
        nullable: true,
        maxLength: 160,
      },
      responsible_clinician_role: {
        type: 'string',
        nullable: true,
        enum: PATIENT_CLINICIAN_ROLES,
      },
      safe_contact: { type: 'string', nullable: true, maxLength: 240 },
      route_token: {
        type: 'string',
        nullable: true,
        enum: PATIENT_NEXT_STEP_ROUTE_TOKENS,
      },
    },
  },

  PortalWhatsNextGoal: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'care_plan_id',
      'care_plan_name',
      'plan_kind',
      'goal_kind',
      'description',
      'measurement_label',
      'measurement_unit',
      'target_value',
      'current_value',
      'target_due_date',
      'priority',
      'status',
      'updated_at',
    ],
    properties: {
      id: { type: 'integer', minimum: 1 },
      care_plan_id: { type: 'integer', minimum: 1 },
      care_plan_name: { type: 'string' },
      plan_kind: { type: 'string' },
      goal_kind: { type: 'string' },
      description: { type: 'string' },
      measurement_label: nullableString,
      measurement_unit: nullableString,
      target_value: nullableString,
      current_value: nullableString,
      target_due_date: nullableDateTime,
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'high', 'critical'],
      },
      status: {
        type: 'string',
        enum: ['planned', 'in_progress', 'on_hold'],
      },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },

  PortalWhatsNextFollowUp: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'care_plan_id',
      'care_plan_name',
      'origin_kind',
      'due_at',
      'appointment_id',
      'appointment_status',
      'reason',
      'status',
      'updated_at',
    ],
    properties: {
      id: { type: 'integer', minimum: 1 },
      care_plan_id: nullableInteger,
      care_plan_name: nullableString,
      origin_kind: { type: 'string' },
      due_at: nullableDateTime,
      appointment_id: nullableInteger,
      appointment_status: { type: 'string' },
      reason: nullableString,
      status: {
        type: 'string',
        enum: ['open', 'scheduled', 'overdue'],
      },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },

  PortalWhatsNext: {
    type: 'object',
    additionalProperties: false,
    required: ['goals', 'follow_ups', 'next_steps', 'count'],
    properties: {
      goals: {
        type: 'array',
        items: { $ref: '#/components/schemas/PortalWhatsNextGoal' },
      },
      follow_ups: {
        type: 'array',
        items: { $ref: '#/components/schemas/PortalWhatsNextFollowUp' },
      },
      next_steps: {
        type: 'array',
        description:
          'Reserved for next steps backed by an exact live domain source. Immutable OP closure snapshots are not exposed.',
        maxItems: 0,
        items: { $ref: '#/components/schemas/PortalWhatsNextStep' },
      },
      count: { type: 'integer', minimum: 0 },
    },
  },
  PortalWhatsNextResponse: strictEnvelope('PortalWhatsNext'),

  PortalDischargeSummarySection: {
    type: 'object',
    additionalProperties: false,
    required: [
      'section_key',
      'section_title',
      'display_order',
      'body',
      'body_translations',
    ],
    properties: {
      section_key: { type: 'string' },
      section_title: { type: 'string' },
      display_order: { type: 'integer' },
      body: nullableString,
      body_translations: {
        type: 'object',
        additionalProperties: { type: 'string' },
      },
    },
  },

  PortalDischargePendingResult: {
    type: 'object',
    additionalProperties: false,
    required: [
      'label',
      'status',
      'responsible_clinician_display_name',
      'responsible_clinician_role',
    ],
    properties: {
      label: { type: 'string', minLength: 1, maxLength: 180 },
      status: {
        type: 'string',
        enum: PATIENT_PENDING_RESULT_STATUSES,
      },
      responsible_clinician_display_name: {
        type: 'string',
        nullable: true,
        maxLength: 160,
      },
      responsible_clinician_role: {
        type: 'string',
        nullable: true,
        enum: PATIENT_CLINICIAN_ROLES,
      },
    },
  },

  PortalDischargeSummary: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'admission_id',
      'patient_uid',
      'patient_name_snapshot',
      'age_years_snapshot',
      'sex_snapshot',
      'hospital_number',
      'admitted_at',
      'discharged_at',
      'ward_at_discharge',
      'primary_diagnosis',
      'secondary_diagnoses',
      'icd10_codes',
      'procedures_performed',
      'status',
      'signed_by_name',
      'signed_by_reg',
      'signed_at',
      'delivered_at',
      'delivery_method',
      'summary_language',
      'created_at',
      'updated_at',
      'sections',
      'pending_results',
    ],
    properties: {
      id: { type: 'integer', minimum: 1 },
      admission_id: nullableInteger,
      patient_uid: { type: 'string', format: 'uuid' },
      patient_name_snapshot: nullableString,
      age_years_snapshot: nullableInteger,
      sex_snapshot: nullableString,
      hospital_number: nullableString,
      admitted_at: nullableDateTime,
      discharged_at: nullableDateTime,
      ward_at_discharge: nullableString,
      primary_diagnosis: nullableString,
      secondary_diagnoses: {
        type: 'array',
        items: { type: 'string' },
        nullable: true,
      },
      icd10_codes: {
        type: 'array',
        items: { type: 'string' },
        nullable: true,
      },
      procedures_performed: {
        type: 'array',
        items: { type: 'string' },
        nullable: true,
      },
      status: {
        type: 'string',
        enum: PATIENT_VISIBLE_DISCHARGE_STATUSES,
      },
      signed_by_name: nullableString,
      signed_by_reg: nullableString,
      signed_at: nullableDateTime,
      delivered_at: nullableDateTime,
      delivery_method: {
        type: 'string',
        nullable: true,
        enum: DISCHARGE_DELIVERY_METHODS,
      },
      summary_language: nullableString,
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      sections: {
        type: 'array',
        items: { $ref: '#/components/schemas/PortalDischargeSummarySection' },
      },
      pending_results: {
        type: 'array',
        items: { $ref: '#/components/schemas/PortalDischargePendingResult' },
      },
    },
  },
  PortalDischargeSummaryResponse: strictEnvelope('PortalDischargeSummary'),
};

const whatsNextOperation = {
  summary: 'Get the patient-safe What’s Next projection',
  description:
    'Returns live patient-visible goals and follow-up plans. The reserved next_steps array remains empty until each step type has an exact live-domain source and satisfaction rule. Raw workflow tasks, immutable closure snapshots, blocker text, staff comments, ward notes, and ownership evidence are never returned.',
  responseDescription: 'The authenticated patient’s safe live goals and follow-up plans.',
  response: 'PortalWhatsNextResponse',
  parameters: [
    {
      name: 'limit',
      in: 'query',
      required: false,
      schema: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 20,
      },
    },
  ],
};

const dischargeSummaryOperation = {
  summary: 'Get one signed patient discharge summary',
  description:
    'Returns only a signed or delivered discharge summary owned by the authenticated patient. Structured pending results contain only the patient-safe label, safe status, and backend-resolved responsible clinician identity.',
  responseDescription: 'A signed or delivered patient-owned discharge summary.',
  response: 'PortalDischargeSummaryResponse',
  pathParameters: {
    id: { type: 'integer', minimum: 1, maximum: 2147483647 },
    admissionId: { type: 'integer', minimum: 1, maximum: 2147483647 },
  },
};

export const operations = {
  'GET /api/v1/portal/care-plans/whats-next': whatsNextOperation,
  'GET /api/v1/patient/care-plans/whats-next': whatsNextOperation,
  'GET /api/v1/portal/discharge-summaries/{id}': dischargeSummaryOperation,
  'GET /api/v1/patient/discharge-summaries/{id}': dischargeSummaryOperation,
  'GET /api/v1/portal/discharge-summaries/admission/{admissionId}':
    dischargeSummaryOperation,
  'GET /api/v1/patient/discharge-summaries/admission/{admissionId}':
    dischargeSummaryOperation,
  'GET /api/v1/portal/clinical-notes': {
    summary: 'List patient-visible OP consultation notes',
    description: `${clinicalNoteDemarcation} The optional note_type filter is intersected with the patient-visible vocabulary; unsupported values return an empty list.`,
    responseDescription: 'Signed outpatient appointment-bound notes visible to the authenticated patient.',
    parameters: [
      {
        name: 'note_type',
        in: 'query',
        required: false,
        description: 'Optional patient-visible note type filter. Unsupported values intentionally return an empty data array.',
        schema: {
          type: 'string',
          enum: PATIENT_VISIBLE_NOTE_TYPES,
        },
      },
      {
        name: 'limit',
        in: 'query',
        required: false,
        description: 'Maximum number of notes to return.',
        schema: {
          type: 'integer',
          minimum: 1,
          default: 100,
        },
      },
    ],
  },
  'GET /api/v1/portal/clinical-notes/appointment/{appointmentId}': {
    summary: 'List OP notes for one appointment',
    description: `${clinicalNoteDemarcation} Appointment-scoped reads require clinical_notes.appointment_id to equal the path appointmentId; embedded JSON appointment ids and date-window fallbacks are not used.`,
    responseDescription: 'Signed outpatient notes linked to the requested appointment.',
  },
  'GET /api/v1/portal/clinical-notes/{id}': {
    summary: 'Get one patient-visible OP consultation note',
    description: `${clinicalNoteDemarcation} In-hospital notes return 404 even when the numeric note id exists for the patient.`,
    responseDescription: 'A signed outpatient appointment-bound note visible to the authenticated patient.',
  },
};
