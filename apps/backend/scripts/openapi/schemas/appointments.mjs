// OpenAPI Phase 5 — Appointments overlay. Typed request/response schemas for the
// /api/v1/appointments/* surface. Authored from EXACT service returns (the live
// contract test is the proof). Grows across T2–T5. See the design spec.
import { envelope } from './_helpers.mjs';

// Real appointment status / visit_type enums.
//   status:     src/config/appointmentConfig.js (APPOINTMENT_CONFIG.STATUSES)
//   visit_type: src/services/appointment/appointmentService.js allowedVisitTypes
const APPOINTMENT_STATUS = [
  'SCHEDULED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'RESCHEDULED', 'CANCELLED', 'NO_SHOW',
];
const VISIT_TYPE = ['NEW', 'FOLLOW_UP', 'EMERGENCY', 'TELE', 'LAB_ONLY', 'PAEDIATRIC_OPD'];

export const schemas = {
  // ---- Core appointment object -------------------------------------------
  // LOOSE: rich model, per-endpoint SELECT varies. The appointments table has
  // 30+ columns and every lifecycle handler RETURNs a DIFFERENT subset:
  //   * book RETURNING (createAppointment) carries reason/notes/department + the
  //     post-commit queue_id/appointment_queue spread;
  //   * updateAppointmentStatus re-SELECTs id/uid/phone/patient_id/doctor_id/
  //     names/date/time/status/notes/token_number/confirmed_at/department/...
  //   * confirm/no-show/complete/cancel RETURN narrower lists (no-show omits
  //     created_at entirely);
  //   * reschedule RETURNs id/uid/.../parent_appointment_id;
  //   * getAppointmentById flattens patient_*/doctor_* aliases + allergies.
  // additionalProperties:false would require this `properties` map to be a
  // superset of EVERY field EVERY endpoint returns, and any field omission
  // fails ajv — so we go LOOSE but keep a real required core (id/uid/status,
  // universally present in all bare-appointment returns) + the typed enums.
  // `created_at`/`appointment_date`/`appointment_time` are NOT required: the
  // no-show RETURNING list omits created_at, so requiring it would break that
  // path's live assertion (and reschedule omits appointment-level reason on the
  // original row). The value (enum validation + id/uid/status guarantee +
  // typed clients) is real regardless.
  Appointment: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'uid', 'status'],
    properties: {
      id: { type: 'integer' },
      uid: { type: 'string', format: 'uuid' },
      phone: { type: 'string', nullable: true },
      patient_id: { type: 'integer', nullable: true },
      patient_name: { type: 'string', nullable: true },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      patient_phone: { type: 'string', nullable: true },
      doctor_id: { type: 'integer', nullable: true },
      doctor_name: { type: 'string', nullable: true },
      appointment_date: { type: 'string', format: 'date-time', nullable: true },
      appointment_time: { type: 'string', nullable: true },
      status: { type: 'string', enum: APPOINTMENT_STATUS },
      reason: { type: 'string', nullable: true },
      notes: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
      visit_type: { type: 'string', nullable: true, enum: [...VISIT_TYPE, null] },
      token_number: { type: 'string', nullable: true },
      visit_no: { type: 'string', nullable: true },
      confirmed_at: { type: 'string', format: 'date-time', nullable: true },
      parent_appointment_id: { type: 'integer', nullable: true },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
      // Post-commit queue spread (createAppointment / confirm / reschedule).
      queue_id: { type: 'integer', nullable: true },
      appointment_queue: { type: 'object', additionalProperties: true, nullable: true },
    },
  },
  // Bare-appointment envelope: `data` IS the appointment object. Returned by
  // POST /{id}/confirm, /no-show, /complete, /cancel (workflow controller does
  // success(res, result, ...) with the bare row).
  AppointmentResponse: envelope('Appointment'),

  // ---- Detail view (GET /{id}) -------------------------------------------
  // appointmentQueryService.getAppointmentById flattens the core appointment
  // PLUS deeply-nested CONDITIONAL context: patient/doctor profile aliases,
  // follow_up_context (parent + prescriptions/diagnoses/notes arrays),
  // pregnancy_context, allergies[]. Those big conditional sub-objects are
  // LOOSE (additionalProperties:true, nullable) — they're large + conditional
  // and only present for ANC / follow-up / allergy-bearing patients. The core
  // stays the LOOSE Appointment shape (allOf merge keeps id/uid/status + enums).
  AppointmentDetail: {
    type: 'object',
    additionalProperties: true,
    allOf: [{ $ref: '#/components/schemas/Appointment' }],
    properties: {
      doctor_name_detail: { type: 'string', nullable: true },
      doctor_phone: { type: 'string', nullable: true },
      doctor_email: { type: 'string', nullable: true },
      patient_email: { type: 'string', nullable: true },
      specialty: { type: 'string', nullable: true },
      has_allergies: { type: 'boolean' },
      allergy_flag: { type: 'boolean' },
      allergies: { type: 'array', items: { type: 'object', additionalProperties: true } },
      follow_up_context: { type: 'object', additionalProperties: true, nullable: true },
      pregnancy_context: { type: 'object', additionalProperties: true, nullable: true },
      // computeGestationalAge (maternityService) returns null or a fixed
      // { weeks, days, total_days, label } object — never a scalar.
      gestational_age: {
        type: 'object',
        nullable: true,
        additionalProperties: true,
        properties: {
          weeks: { type: 'integer' },
          days: { type: 'integer' },
          total_days: { type: 'integer' },
          label: { type: 'string' },
        },
      },
    },
  },
  // GET /{id} wraps the detail in data.appointment (+ accessedBy). NOT a bare
  // envelope — appointmentListController.getAppointmentById does
  // success(res, { appointment, accessedBy }, ...).
  AppointmentDetailResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: true,
        required: ['appointment'],
        properties: {
          appointment: { $ref: '#/components/schemas/AppointmentDetail' },
          accessedBy: { type: 'string', nullable: true },
        },
      },
    },
  },

  // ---- Book result (POST /book) ------------------------------------------
  // appointmentCrudController.createAppointment returns a WRAPPER:
  //   data: { appointment: <hydrated detail>, patient_name, patient{...},
  //           doctor_name, booked_by }
  BookAppointmentResult: {
    type: 'object',
    additionalProperties: true,
    required: ['appointment', 'patient'],
    properties: {
      appointment: { $ref: '#/components/schemas/AppointmentDetail' },
      patient_name: { type: 'string', nullable: true },
      patient: {
        type: 'object',
        additionalProperties: true,
        properties: {
          id: { type: 'integer', nullable: true },
          uid: { type: 'string', format: 'uuid', nullable: true },
          name: { type: 'string', nullable: true },
          phone: { type: 'string', nullable: true },
          created: { type: 'boolean' },
        },
      },
      doctor_name: { type: 'string', nullable: true },
      booked_by: { type: 'string', nullable: true },
    },
  },
  BookAppointmentResponse: envelope('BookAppointmentResult'),

  // ---- Update result (PUT /{id}) -----------------------------------------
  // appointmentCrudController.updateAppointment wraps: data: { appointment,
  // updated_by, addendum }.
  UpdateAppointmentResult: {
    type: 'object',
    additionalProperties: true,
    required: ['appointment'],
    properties: {
      appointment: { $ref: '#/components/schemas/Appointment' },
      updated_by: { type: 'string', nullable: true },
      addendum: { type: 'boolean' },
    },
  },
  UpdateAppointmentResponse: envelope('UpdateAppointmentResult'),

  // ---- Status result (PUT /{id}/status) ----------------------------------
  // appointmentStatusController.updateAppointmentStatus wraps:
  // data: { appointment, updated_by }.
  StatusUpdateResult: {
    type: 'object',
    additionalProperties: true,
    required: ['appointment'],
    properties: {
      appointment: { $ref: '#/components/schemas/Appointment' },
      updated_by: { type: 'string', nullable: true },
    },
  },
  StatusUpdateResponse: envelope('StatusUpdateResult'),

  // ---- Reschedule result (POST /{id}/reschedule) -------------------------
  // appointmentWorkflowController.rescheduleAppointment wraps:
  // data: { original: <RESCHEDULED row>, appointment: <new SCHEDULED row> }.
  RescheduleResult: {
    type: 'object',
    additionalProperties: true,
    required: ['original', 'appointment'],
    properties: {
      original: { $ref: '#/components/schemas/Appointment' },
      appointment: { $ref: '#/components/schemas/Appointment' },
    },
  },
  RescheduleResponse: envelope('RescheduleResult'),

  // ---- Request bodies ----------------------------------------------------
  // additionalProperties:true — the controllers accept many optional intake
  // fields (phone/date/time aliases, confirm_duplicate, payer metadata, …).
  // Keep required minimal + type the known fields.
  BookAppointmentRequest: {
    type: 'object',
    additionalProperties: true,
    description: 'POST /api/v1/appointments/book. Accepts date/time/phone aliases; patient_id is derived from JWT for PATIENT callers or resolved from patient_phone.',
    properties: {
      patient_id: { type: 'integer' },
      patient_phone: { type: 'string' },
      patient_name: { type: 'string' },
      doctor_id: { type: 'integer' },
      doctor_uid: { type: 'string', format: 'uuid' },
      appointment_date: { type: 'string' },
      appointment_time: { type: 'string' },
      date: { type: 'string' },
      time: { type: 'string' },
      reason: { type: 'string' },
      notes: { type: 'string' },
      department: { type: 'string' },
      visit_type: { type: 'string', enum: VISIT_TYPE },
      confirm_duplicate: { type: 'boolean' },
    },
  },
  UpdateAppointmentStatusRequest: {
    type: 'object',
    additionalProperties: true,
    required: ['status'],
    description: 'PUT /api/v1/appointments/{id}/status.',
    properties: {
      status: { type: 'string', enum: APPOINTMENT_STATUS },
      notes: { type: 'string' },
    },
  },
  CancelAppointmentRequest: {
    type: 'object',
    additionalProperties: true,
    description: 'POST /api/v1/appointments/{id}/cancel.',
    properties: {
      cancellation_reason: { type: 'string' },
    },
  },
  RescheduleAppointmentRequest: {
    type: 'object',
    additionalProperties: true,
    required: ['appointment_date', 'appointment_time'],
    description: 'POST /api/v1/appointments/{id}/reschedule.',
    properties: {
      appointment_date: { type: 'string' },
      appointment_time: { type: 'string' },
      confirmation_notes: { type: 'string' },
      notes: { type: 'string' },
    },
  },
};

export const operations = {
  // book → typed wrapper request + response.
  'POST /api/v1/appointments/book': {
    request: 'BookAppointmentRequest',
    response: 'BookAppointmentResponse',
  },
  // GET /{id} → detail wrapper (data.appointment + conditional context).
  'GET /api/v1/appointments/{id}': {
    response: 'AppointmentDetailResponse',
  },
  // PUT /{id} → update wrapper (data.appointment + updated_by + addendum).
  'PUT /api/v1/appointments/{id}': {
    response: 'UpdateAppointmentResponse',
  },
  // PUT /{id}/status → status wrapper + typed status request.
  'PUT /api/v1/appointments/{id}/status': {
    request: 'UpdateAppointmentStatusRequest',
    response: 'StatusUpdateResponse',
  },
  // POST /{id}/cancel (workflow) → bare appointment envelope + cancel request.
  'POST /api/v1/appointments/{id}/cancel': {
    request: 'CancelAppointmentRequest',
    response: 'AppointmentResponse',
  },
  // POST /{id}/reschedule → { original, appointment } wrapper + request.
  'POST /api/v1/appointments/{id}/reschedule': {
    request: 'RescheduleAppointmentRequest',
    response: 'RescheduleResponse',
  },
  // POST /{id}/confirm | /no-show | /complete → bare appointment envelope.
  'POST /api/v1/appointments/{id}/confirm': {
    response: 'AppointmentResponse',
  },
  'POST /api/v1/appointments/{id}/no-show': {
    response: 'AppointmentResponse',
  },
  'POST /api/v1/appointments/{id}/complete': {
    response: 'AppointmentResponse',
  },
};
