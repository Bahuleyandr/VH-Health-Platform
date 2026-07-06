// OpenAPI Phase 5 — Appointments overlay. Typed request/response schemas for the
// /api/v1/appointments/* surface. Authored from EXACT service returns (the live
// contract test is the proof). Grows across T2–T5. See the design spec.
import { envelope, listEnvelope } from './_helpers.mjs';

// Real appointment status / visit_type enums.
//   status:     src/config/appointmentConfig.js (APPOINTMENT_CONFIG.STATUSES)
//   visit_type: src/services/appointment/appointmentService.js allowedVisitTypes
const APPOINTMENT_STATUS = [
  'SCHEDULED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'RESCHEDULED', 'CANCELLED', 'NO_SHOW',
];
const VISIT_TYPE = ['NEW', 'FOLLOW_UP', 'EMERGENCY', 'TELE', 'LAB_ONLY', 'PAEDIATRIC_OPD'];
// Appointment-queue enums (T3). Sources:
//   queue_kind:   the kinds appointmentQueueKindForAppointment() can emit on the
//                 appointment path — a SUBSET of the appointment_queues CHECK
//                 (the CHECK also allows lab/imaging/other, unreachable here).
//   queue status: the full appointment_queues status CHECK
//                 (draft/open/paused/closed/archived).
const QUEUE_KIND = ['doctor', 'department', 'emergency', 'walk_in', 'op'];
const QUEUE_STATUS = ['draft', 'open', 'paused', 'closed', 'archived'];

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
      visit_type: { type: 'string', nullable: true, enum: [...VISIT_TYPE] },
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

  // ---- In-place reschedule result (PATCH /{id}/reschedule) ----------------
  // appointmentCrudController.rescheduleAppointment wraps:
  // data: { appointment: <same row, SCHEDULED>, previous: <old slot summary>,
  //         updated_by }.
  InPlaceRescheduleResult: {
    type: 'object',
    additionalProperties: true,
    required: ['appointment'],
    properties: {
      appointment: { $ref: '#/components/schemas/Appointment' },
      previous: {
        type: 'object',
        additionalProperties: true,
        nullable: true,
        properties: {
          appointment_date: { type: 'string', format: 'date-time', nullable: true },
          appointment_time: { type: 'string', nullable: true },
          doctor_id: { type: 'integer', nullable: true },
          status: { type: 'string', nullable: true },
        },
      },
      updated_by: { type: 'string', nullable: true },
    },
  },
  InPlaceRescheduleResponse: envelope('InPlaceRescheduleResult'),

  // ======================================================================
  // T3 — LIST / QUEUE / AVAILABILITY / WAIT-TIME / WORKFLOW payloads.
  // Every shape below is authored from the EXACT controller/service return,
  // NOT from the plan's prose. The list endpoints do NOT return a bare
  // `data:array` — appointmentListController wraps each in
  // `data:{appointments,...}` (or a count/pagination/filters sibling set).
  // ======================================================================

  // ---- List-row item -----------------------------------------------------
  // The list/today/doctor/patient SELECTs (APPT_BASE_SELECT + per-view picks)
  // deliberately OMIT the appointment's own `uid` column (only the lifecycle
  // RETURNING paths carry it) — flattenListRow exposes the PATIENT's uid as
  // `patient_uid`, not the row uid. So the bare-row `Appointment` schema
  // (required uid) does NOT fit list items. AppointmentListItem is a
  // STANDALONE mirror of Appointment with the required core relaxed to
  // [id, status] (both universally present in every list projection) — it is
  // NOT an allOf(Appointment), because ajv would still apply Appointment's
  // required:[uid] through the allOf. LOOSE (additionalProperties:true), same
  // reason as Appointment: flattenListRow adds many alias columns + the
  // attached appointment_queue. Verified against the live list/patient
  // returns (the assertResponse `must have required property 'uid'` failures).
  AppointmentListItem: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'status'],
    properties: {
      id: { type: 'integer' },
      uid: { type: 'string', format: 'uuid', nullable: true },
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
      visit_type: { type: 'string', nullable: true, enum: [...VISIT_TYPE] },
      token_number: { type: 'string', nullable: true },
      visit_no: { type: 'string', nullable: true },
      parent_appointment_id: { type: 'integer', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
      queue_id: { type: 'integer', nullable: true },
      appointment_queue: { type: 'object', additionalProperties: true, nullable: true },
    },
  },

  // ---- GET /list & GET / (root alias) ------------------------------------
  // appointmentListController.listAppointments → success(res, {...result,
  // requestedBy}). appointmentQueryService.getAppointments returns
  // { appointments[], pagination, filters }. So data = { appointments,
  // pagination, filters, requestedBy }. The appointment rows are the LOOSE
  // AppointmentListItem (flattenListRow adds many aliases — patient_*/
  // doctor_*/specialty/department/allergies + the post-attach
  // appointment_queue; NO row `uid`).
  // LOOSE on `data`: pagination/filters are typed loosely below.
  AppointmentListResult: {
    type: 'object',
    additionalProperties: true,
    required: ['appointments'],
    properties: {
      appointments: { type: 'array', items: { $ref: '#/components/schemas/AppointmentListItem' } },
      // buildPagination(total,page,limit) shape — typed loosely (the helper's
      // exact key set varies across the codebase's list endpoints).
      pagination: { type: 'object', additionalProperties: true },
      filters: { type: 'object', additionalProperties: true, nullable: true },
      requestedBy: { type: 'string', nullable: true },
    },
  },
  AppointmentListResponse: envelope('AppointmentListResult'),

  // ---- GET /today/list ---------------------------------------------------
  // getTodayAppointments → success(res, {...result, count, requestedBy}).
  // service returns { appointments[], date }; controller adds count +
  // requestedBy. data = { appointments, date, count, requestedBy }.
  TodayAppointmentsResult: {
    type: 'object',
    additionalProperties: true,
    required: ['appointments'],
    properties: {
      appointments: { type: 'array', items: { $ref: '#/components/schemas/AppointmentListItem' } },
      date: { type: 'string', nullable: true },
      count: { type: 'integer' },
      requestedBy: { type: 'string', nullable: true },
    },
  },
  TodayAppointmentsResponse: envelope('TodayAppointmentsResult'),

  // ---- GET /doctor/{doctor_id} -------------------------------------------
  // getDoctorAppointments → data = { appointments[], count, doctor_id,
  // requested_doctor_id, filters, requestedBy }. requested_doctor_id is the
  // raw URL param (string), doctor_id the canonicalised int.
  DoctorAppointmentsResult: {
    type: 'object',
    additionalProperties: true,
    required: ['appointments'],
    properties: {
      appointments: { type: 'array', items: { $ref: '#/components/schemas/AppointmentListItem' } },
      count: { type: 'integer' },
      doctor_id: { type: 'integer', nullable: true },
      requested_doctor_id: { type: 'string', nullable: true },
      filters: { type: 'object', additionalProperties: true, nullable: true },
      requestedBy: { type: 'string', nullable: true },
    },
  },
  DoctorAppointmentsResponse: envelope('DoctorAppointmentsResult'),

  // ---- GET /patient/{patient_id} -----------------------------------------
  // getPatientAppointments → data = { appointments[], count, patient_id,
  // filter, requestedBy }. patient_id is the raw URL param (string); filter
  // is { status } or null.
  PatientAppointmentsResult: {
    type: 'object',
    additionalProperties: true,
    required: ['appointments'],
    properties: {
      appointments: { type: 'array', items: { $ref: '#/components/schemas/AppointmentListItem' } },
      count: { type: 'integer' },
      patient_id: { type: 'string', nullable: true },
      filter: { type: 'object', additionalProperties: true, nullable: true },
      requestedBy: { type: 'string', nullable: true },
    },
  },
  PatientAppointmentsResponse: envelope('PatientAppointmentsResult'),

  // ---- GET /completed/recent ---------------------------------------------
  // getRecentCompletedAppointments → success(res, rows.map(...)) — data IS a
  // bare ARRAY of a small projection. Strict: the controller maps to exactly
  // these four keys.
  RecentCompletedAppointment: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'patient_name', 'appointment_date', 'appointment_time'],
    properties: {
      id: { type: 'integer' },
      patient_name: { type: 'string' },
      appointment_date: { type: 'string', nullable: true },
      appointment_time: { type: 'string', nullable: true },
    },
  },
  RecentCompletedResponse: listEnvelope('RecentCompletedAppointment'),

  // ---- GET /pending ------------------------------------------------------
  // getPendingAppointments → success(res, result) — data IS a bare ARRAY of
  // the raw SQL rows. LOOSE: BigInt ids + the EXTRACT-derived
  // minutes_since_booking is a Prisma Decimal/number; keep the known typed
  // fields + the SLA flags, allow the rest.
  PendingAppointment: {
    type: 'object',
    additionalProperties: true,
    required: ['id'],
    properties: {
      id: { type: 'integer' },
      patient_id: { type: 'integer', nullable: true },
      doctor_id: { type: 'integer', nullable: true },
      appointment_date: { type: 'string', format: 'date-time', nullable: true },
      appointment_time: { type: 'string', nullable: true },
      status: { type: 'string', enum: APPOINTMENT_STATUS },
      reason: { type: 'string', nullable: true },
      token_number: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
      patient_name: { type: 'string', nullable: true },
      patient_phone: { type: 'string', nullable: true },
      doctor_name: { type: 'string', nullable: true },
      sla_target_at: { type: 'string', format: 'date-time', nullable: true },
      sla_breached: { type: 'boolean' },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  PendingAppointmentsResponse: listEnvelope('PendingAppointment'),

  // ---- GET /queue/today & /queue/today/mine ------------------------------
  // getTodayQueue → success(res, enriched) — data IS a bare ARRAY of the
  // raw-SQL queue rows, each spread (...row) with an attached
  // `appointment_queue` (or null) + a conditional `gestational_age` for ANC
  // rows. LOOSE: this row is the WIDEST in the surface — ~30 SELECT aliases
  // (patient/doctor display joins, ANC lmp/edd, ED triage derived columns).
  // We type the load-bearing fields the deep test + clients assert
  // (visit_type, triage_priority, acuity_rank, is_emergent,
  // emergency_visit_id, appointment_queue) and stay open for the rest.
  TodayQueueItem: {
    type: 'object',
    additionalProperties: true,
    required: ['id'],
    properties: {
      id: { type: 'integer' },
      patient_id: { type: 'integer', nullable: true },
      doctor_id: { type: 'integer', nullable: true },
      appointment_date: { type: 'string', format: 'date-time', nullable: true },
      appointment_time: { type: 'string', nullable: true },
      status: { type: 'string', enum: APPOINTMENT_STATUS },
      reason: { type: 'string', nullable: true },
      notes: { type: 'string', nullable: true },
      token_number: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
      visit_type: { type: 'string', nullable: true, enum: [...VISIT_TYPE] },
      triage_acuity: { type: 'integer', nullable: true },
      queue_id: { type: 'integer', nullable: true },
      patient_name: { type: 'string', nullable: true },
      patient_phone: { type: 'string', nullable: true },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      doctor_display_name: { type: 'string', nullable: true },
      specialization: { type: 'string', nullable: true },
      // ED-triage derived columns (LEFT JOIN ed_today). Null for routine OPD.
      emergency_visit_id: { type: 'integer', nullable: true },
      triage_priority: { type: 'string', nullable: true },
      acuity_rank: { type: 'integer', nullable: true },
      is_emergent: { type: 'boolean' },
      appointment_queue: {
        $ref: '#/components/schemas/QueueSummary',
      },
      // computeGestationalAge result, only spread for ANC rows.
      gestational_age: {
        type: 'object', nullable: true, additionalProperties: true,
      },
    },
  },
  // The compact per-row queue summary getTodayQueue builds inline (NOT the
  // full AppointmentQueue row). Nullable: rows with no queue_id get null.
  // LOOSE bounded: getTodayQueue's enriched mapper emits exactly these keys,
  // but appointment_queue elsewhere (list/detail attach) is the fuller row,
  // so allow extra to keep one ref reusable.
  QueueSummary: {
    type: 'object',
    nullable: true,
    additionalProperties: true,
    properties: {
      id: { type: 'integer', nullable: true },
      queue_id: { type: 'integer', nullable: true },
      queue_kind: { type: 'string', nullable: true, enum: [...QUEUE_KIND] },
      queue_label: { type: 'string', nullable: true },
      status: { type: 'string', nullable: true, enum: [...QUEUE_STATUS] },
      queue_date: { type: 'string', nullable: true },
      department_name: { type: 'string', nullable: true },
      doctor_id: { type: 'integer', nullable: true },
    },
  },
  TodayQueueResponse: listEnvelope('TodayQueueItem'),

  // ---- GET /slots --------------------------------------------------------
  // getAvailableSlots has TWO success shapes:
  //   (a) doctor available → { doctor_id, doctor_user_id, doctor_name, date,
  //       day, total_slots, available_slots, slots[] }
  //   (b) doctor off that day → { available:false, reason, day, slots:[] }
  // Slot = { time, available }. Model both with a oneOf-free LOOSE object
  // (both branches share `day` + `slots`; the rest are optional). The Slot
  // item itself is strict.
  Slot: {
    type: 'object',
    additionalProperties: false,
    required: ['time', 'available'],
    properties: {
      time: { type: 'string' },
      available: { type: 'boolean' },
    },
  },
  // LOOSE: two return branches share `day`+`slots`; the available-branch
  // adds doctor_id/doctor_user_id/doctor_name/date/total_slots/
  // available_slots, the unavailable-branch adds available:false+reason.
  // A single object with everything optional + additionalProperties:false
  // is the simplest faithful union (no required keys both branches omit).
  SlotsResult: {
    type: 'object',
    additionalProperties: false,
    required: ['slots'],
    properties: {
      slots: { type: 'array', items: { $ref: '#/components/schemas/Slot' } },
      day: { type: 'string', nullable: true },
      // Available-branch fields.
      doctor_id: { type: 'integer' },
      doctor_user_id: { type: 'integer' },
      doctor_name: { type: 'string', nullable: true },
      date: { type: 'string' },
      total_slots: { type: 'integer' },
      available_slots: { type: 'integer' },
      // Unavailable-branch fields.
      available: { type: 'boolean' },
      reason: { type: 'string' },
    },
  },
  SlotsResponse: envelope('SlotsResult'),

  // ---- GET /doctors/options ----------------------------------------------
  // getDoctorOptions → data = { doctors[], pagination }. Each doctor row is
  // the raw-SQL projection. Strict on the doctor item — the SELECT column
  // list is fixed.
  DoctorOption: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'name'],
    properties: {
      id: { type: 'integer' },
      uid: { type: 'string', format: 'uuid', nullable: true },
      user_id: { type: 'integer', nullable: true },
      doctor_row_id: { type: 'integer', nullable: true },
      name: { type: 'string' },
      department: { type: 'string', nullable: true },
      specialization: { type: 'string', nullable: true },
      is_available: { type: 'boolean', nullable: true },
    },
  },
  DoctorOptionsResult: {
    type: 'object',
    additionalProperties: true,
    required: ['doctors'],
    properties: {
      doctors: { type: 'array', items: { $ref: '#/components/schemas/DoctorOption' } },
      pagination: { type: 'object', additionalProperties: true },
    },
  },
  DoctorOptionsResponse: envelope('DoctorOptionsResult'),

  // ---- POST /walk-in -----------------------------------------------------
  // registerWalkIn → success(res, result) — data is the INSERTed appointment
  // row spread with a LARGE set of derived extras (er_visit_*, lab_orders,
  // returning_patient, same_day_duplicate*, allergies, is_unidentified,
  // optional gestational_age). LOOSE: the widest write-path return in this
  // surface; type the core appointment row + the load-bearing extras, allow
  // the rest.
  WalkInResult: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'status'],
    properties: {
      id: { type: 'integer' },
      patient_id: { type: 'integer', nullable: true },
      doctor_id: { type: 'integer', nullable: true },
      appointment_date: { type: 'string', format: 'date-time', nullable: true },
      appointment_time: { type: 'string', nullable: true },
      phone: { type: 'string', nullable: true },
      reason: { type: 'string', nullable: true },
      notes: { type: 'string', nullable: true },
      status: { type: 'string', enum: APPOINTMENT_STATUS },
      confirmed_at: { type: 'string', format: 'date-time', nullable: true },
      token_number: { type: 'string', nullable: true },
      visit_no: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
      visit_type: { type: 'string', nullable: true, enum: [...VISIT_TYPE] },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      queue_id: { type: 'integer', nullable: true },
      appointment_queue: { type: 'object', additionalProperties: true, nullable: true },
      // Derived registration extras.
      er_visit_id: { type: 'integer', nullable: true },
      er_visit_number: { type: 'string', nullable: true },
      er_is_mlc: { type: 'boolean', nullable: true },
      lab_order_ids: { type: 'array', items: { type: 'integer' } },
      lab_orders: { type: 'array', items: { type: 'object', additionalProperties: true } },
      returning_patient: { type: 'boolean' },
      prior_visit_count: { type: 'integer' },
      last_visit_at: { type: 'string', format: 'date-time', nullable: true },
      is_unidentified: { type: 'boolean' },
      has_allergies: { type: 'boolean' },
      allergy_flag: { type: 'boolean' },
      allergies: { type: 'array', items: { type: 'object', additionalProperties: true } },
      same_day_duplicate_count: { type: 'integer' },
      same_day_duplicates: { type: 'array', items: { type: 'object', additionalProperties: true } },
      gestational_age: { type: 'object', nullable: true, additionalProperties: true },
    },
  },
  WalkInResponse: envelope('WalkInResult'),

  // ---- GET /doctor/{doctorId}/wait-time ----------------------------------
  // getWaitTimeForDoctor → estimateWaitTime() → data = { patientsAhead,
  // currentlyConsulting, estimatedWaitMinutes, avgConsultationMinutes }.
  // Strict: the service returns exactly these four integer fields.
  DoctorWaitTime: {
    type: 'object',
    additionalProperties: false,
    required: [
      'patientsAhead', 'currentlyConsulting',
      'estimatedWaitMinutes', 'avgConsultationMinutes',
    ],
    properties: {
      patientsAhead: { type: 'integer' },
      currentlyConsulting: { type: 'integer' },
      estimatedWaitMinutes: { type: 'integer' },
      avgConsultationMinutes: { type: 'integer' },
    },
  },
  DoctorWaitTimeResponse: envelope('DoctorWaitTime'),

  // ---- GET /{id}/wait-time -----------------------------------------------
  // getWaitTimeForAppointment → getAppointmentWaitTime() → data adds
  // appointmentId/status/tokenNumber/queuePosition to the doctor estimate.
  // Strict: the service composes exactly these eight fields.
  AppointmentWaitTime: {
    type: 'object',
    additionalProperties: false,
    required: [
      'appointmentId', 'status', 'queuePosition', 'patientsAhead',
      'currentlyConsulting', 'estimatedWaitMinutes', 'avgConsultationMinutes',
    ],
    properties: {
      appointmentId: { type: 'integer' },
      status: { type: 'string', enum: APPOINTMENT_STATUS },
      tokenNumber: { type: 'string', nullable: true },
      queuePosition: { type: 'integer' },
      patientsAhead: { type: 'integer' },
      currentlyConsulting: { type: 'integer' },
      estimatedWaitMinutes: { type: 'integer' },
      avgConsultationMinutes: { type: 'integer' },
    },
  },
  AppointmentWaitTimeResponse: envelope('AppointmentWaitTime'),

  // ---- POST /{id}/advise-admission ---------------------------------------
  // adviseForAdmission → success(res, rows[0]) — data is the UPDATE RETURNING
  // row. Strict: the RETURNING column list is fixed.
  AdviseAdmissionResult: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'status'],
    properties: {
      id: { type: 'integer' },
      uid: { type: 'string', format: 'uuid', nullable: true },
      patient_id: { type: 'integer', nullable: true },
      doctor_id: { type: 'integer', nullable: true },
      advised_for_admission_at: { type: 'string', format: 'date-time', nullable: true },
      advised_for_admission_by: { type: 'string', format: 'uuid', nullable: true },
      advised_for_admission_note: { type: 'string', nullable: true },
      status: { type: 'string', enum: APPOINTMENT_STATUS },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
    },
  },
  AdviseAdmissionResponse: envelope('AdviseAdmissionResult'),

  // ---- GET /{id}/history -------------------------------------------------
  // getAppointmentHistory → success(res, result) — data IS a bare ARRAY of
  // appointment_status_history rows joined to the actor's name. Strict item:
  // the SELECT column list is fixed.
  AppointmentHistoryEntry: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'appointment_id', 'to_status'],
    properties: {
      id: { type: 'integer' },
      appointment_id: { type: 'integer' },
      from_status: { type: 'string', nullable: true },
      to_status: { type: 'string' },
      changed_by: { type: 'integer', nullable: true },
      changed_by_role: { type: 'string', nullable: true },
      reason: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      changed_by_name: { type: 'string', nullable: true },
    },
  },
  AppointmentHistoryResponse: listEnvelope('AppointmentHistoryEntry'),

  // ---- GET /phone/{phone} & GET /uid/{uid} (legacy) ----------------------
  // getAppointmentsByPhone / getAppointmentsByUID → success(res, result) —
  // data IS a bare ARRAY of `SELECT a.*` rows (every appointments column +
  // doctor_name/department/specialty joins). Reuse the LOOSE Appointment
  // item: `a.*` always carries id/uid/status and the row is wide/variable.
  LegacyAppointmentListResponse: listEnvelope('Appointment'),

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
  InPlaceRescheduleAppointmentRequest: {
    type: 'object',
    additionalProperties: true,
    required: ['appointment_date', 'appointment_time'],
    description: 'PATCH /api/v1/appointments/{id}/reschedule.',
    properties: {
      appointment_date: { type: 'string' },
      appointment_time: { type: 'string' },
      doctor_id: { type: 'integer' },
      doctor_uid: { type: 'string', format: 'uuid' },
      confirmation_notes: { type: 'string' },
      notes: { type: 'string' },
    },
  },

  // ---- T3 request bodies -------------------------------------------------
  // POST /walk-in — registerWalkIn reads a VERY wide payload (demographics,
  // guardian, payer, ANC, MLC, lab panel, chronic meds, doctor/department
  // routing) with many accepted aliases. additionalProperties:true + minimal
  // required; type the load-bearing known fields only.
  WalkInRequest: {
    type: 'object',
    additionalProperties: true,
    description: 'POST /api/v1/appointments/walk-in. Wide front-desk intake; '
      + 'most fields optional with aliases. patient_phone OR patient_id is '
      + 'required (relaxed for unidentified-ER mode).',
    properties: {
      patient_id: { type: 'integer' },
      patient_phone: { type: 'string' },
      patient_name: { type: 'string' },
      patient_birthday: { type: 'string' },
      date_of_birth: { type: 'string' },
      patient_gender: { type: 'string' },
      gender: { type: 'string' },
      patient_address: { type: 'string' },
      doctor_id: { type: 'integer' },
      department: { type: 'string' },
      department_id: { type: 'integer' },
      reason: { type: 'string' },
      notes: { type: 'string' },
      appointment_time: { type: 'string' },
      time: { type: 'string' },
      visit_type: { type: 'string', enum: VISIT_TYPE },
      parent_appointment_id: { type: 'integer' },
      guardian_name: { type: 'string' },
      guardian_phone: { type: 'string' },
      guardian_relationship: { type: 'string' },
      chief_complaint: { type: 'string' },
      lab_tests: { type: 'array', items: {} },
    },
  },
  // POST /{id}/advise-admission — only an optional free-text note.
  AdviseAdmissionRequest: {
    type: 'object',
    additionalProperties: true,
    description: 'POST /api/v1/appointments/{id}/advise-admission.',
    properties: {
      note: { type: 'string' },
    },
  },

  // ======================================================================
  // T4 — ADMIN ANALYTICS / OPERATIONS payloads.
  // Source: src/routes/appointment/appointmentAdminRoutes.js (inline
  // raw-SQL handlers under /admin) + src/controllers/appointment/
  // appointmentAdminController.js (sla-dashboard, audit-trail) +
  // appointmentDocumentController.getAllDocumentsAdmin (documents).
  //
  // SERIALIZATION RULE that drives most LOOSE decisions here: the analytics
  // SQL is `$queryRawUnsafe`, and
  //   * a bare `COUNT(*)` (NOT cast `::int`) returns a Postgres BigInt →
  //     Prisma yields a JS BigInt → the global `BigInt.prototype.toJSON`
  //     (src/bin/www.js + jest.setup.cjs) serializes it to a STRING;
  //   * `ROUND(x::numeric, n)` returns a Prisma Decimal → serialized to a
  //     STRING too;
  //   * `EXTRACT(...)` / `ROUND(...)::int` casts return JS numbers.
  // So inside the analytics aggregate objects the same logical field can be
  // a string (uncast COUNT / ROUND) or a number (::int cast) depending on the
  // exact SELECT. Rather than pin every one, the wide aggregate objects below
  // are LOOSE (additionalProperties:true) — we assert the ENVELOPE + array
  // structure faithfully and let the scalar cells stay open. Where a handler
  // DOES `::int`-cast a whole result set (the SLA dashboard), we type those
  // counts as integer.
  // ======================================================================

  // ---- GET /admin/analytics ----------------------------------------------
  // data = { timeframe, overall:{...}, trends[], departmentBreakdown[],
  // peakHours[], generatedAt, requestedBy }. `overall` is overallStats[0]
  // (single row of uncast COUNTs + ROUND rates → all STRINGS); trends /
  // departmentBreakdown / peakHours are arrays of uncast-COUNT rows. All
  // aggregate rows LOOSE (string-vs-number per cell, see header rule).
  AppointmentAnalyticsResult: {
    type: 'object',
    additionalProperties: true,
    required: ['timeframe', 'overall', 'trends', 'departmentBreakdown', 'peakHours'],
    properties: {
      timeframe: { type: 'string', enum: ['7d', '30d', '90d', '1y'] },
      // Single overallStats row. LOOSE: uncast COUNT(*) → BigInt→string,
      // ROUND(...,2) rates (completion_rate/no_show_rate) → Decimal→string.
      overall: { type: 'object', additionalProperties: true },
      // Per-date trend rows (uncast COUNTs → strings). LOOSE row.
      trends: { type: 'array', items: { type: 'object', additionalProperties: true } },
      // Per-department rows — avg_wait_time_minutes is ROUND(AVG(...)) Decimal.
      departmentBreakdown: { type: 'array', items: { type: 'object', additionalProperties: true } },
      // Per-hour rows — { hour, appointments, avg_duration }. avg_duration is
      // NULL::integer (appointments has no consultation-duration column; the
      // /export handler models the same absent metric as NULL too).
      peakHours: { type: 'array', items: { type: 'object', additionalProperties: true } },
      generatedAt: { type: 'string', format: 'date-time', nullable: true },
      requestedBy: { type: 'string', nullable: true },
    },
  },
  AppointmentAnalyticsResponse: envelope('AppointmentAnalyticsResult'),

  // ---- GET /admin/search -------------------------------------------------
  // data = { appointments[], pagination:{page,limit,total,totalPages},
  // filters:{...}, requestedBy }. Each appointment row is `a.* + p.name/phone/
  // email + d.name + dept.name + effective_status` — wide raw row, reuse the
  // LOOSE AppointmentListItem (a.* always carries id/status; the row adds
  // patient_*/doctor_*/department_name/effective_status aliases). pagination
  // keys are JS-computed integers; filters echoes the query (string|bool).
  AppointmentSearchResult: {
    type: 'object',
    additionalProperties: true,
    required: ['appointments', 'pagination'],
    properties: {
      appointments: { type: 'array', items: { $ref: '#/components/schemas/AppointmentListItem' } },
      pagination: {
        type: 'object',
        additionalProperties: true,
        properties: {
          page: { type: 'integer' },
          limit: { type: 'integer' },
          total: { type: 'integer' },
          totalPages: { type: 'integer' },
        },
      },
      filters: { type: 'object', additionalProperties: true, nullable: true },
      requestedBy: { type: 'string', nullable: true },
    },
  },
  AppointmentSearchResponse: envelope('AppointmentSearchResult'),

  // ---- GET /admin/conflicts ----------------------------------------------
  // data = { conflicts[], totalConflicts, date, doctor_id, requestedBy }.
  // Each conflict row = { appointment1_id, appointment1_time, patient1_name,
  // appointment2_id, appointment2_time, patient2_name, doctor_name,
  // department } — fixed SELECT, strict item. (ids are real integer PKs, not
  // COUNTs, so they stay integer.)
  AppointmentConflict: {
    type: 'object',
    additionalProperties: false,
    required: ['appointment1_id', 'appointment2_id'],
    properties: {
      appointment1_id: { type: 'integer' },
      appointment1_time: { type: 'string', format: 'date-time', nullable: true },
      patient1_name: { type: 'string', nullable: true },
      appointment2_id: { type: 'integer' },
      appointment2_time: { type: 'string', format: 'date-time', nullable: true },
      patient2_name: { type: 'string', nullable: true },
      doctor_name: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
    },
  },
  AppointmentConflictsResult: {
    type: 'object',
    additionalProperties: true,
    required: ['conflicts', 'totalConflicts'],
    properties: {
      conflicts: { type: 'array', items: { $ref: '#/components/schemas/AppointmentConflict' } },
      // conflicts.length — a JS number.
      totalConflicts: { type: 'integer' },
      date: { type: 'string', nullable: true },
      doctor_id: { type: 'string', nullable: true },
      requestedBy: { type: 'string', nullable: true },
    },
  },
  AppointmentConflictsResponse: envelope('AppointmentConflictsResult'),

  // ---- GET /admin/no-shows -----------------------------------------------
  // data = { noShowPatients[], timeframe, threshold, totalPatientsWithNoShows,
  // requestedBy }. Each patient row = { id, name, phone, email, no_show_count,
  // total_appointments, no_show_percentage, last_appointment }. The COUNTs are
  // UNCAST (→ BigInt→string) and no_show_percentage is ROUND(...,2) Decimal
  // (→ string); id is a real PK integer. LOOSE on the count/percentage cells.
  NoShowPatient: {
    type: 'object',
    additionalProperties: true,
    required: ['id'],
    properties: {
      id: { type: 'integer' },
      name: { type: 'string', nullable: true },
      phone: { type: 'string', nullable: true },
      email: { type: 'string', nullable: true },
      last_appointment: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  NoShowReportResult: {
    type: 'object',
    additionalProperties: true,
    required: ['noShowPatients', 'totalPatientsWithNoShows'],
    properties: {
      noShowPatients: { type: 'array', items: { $ref: '#/components/schemas/NoShowPatient' } },
      timeframe: { type: 'string', enum: ['7d', '30d', '90d'] },
      // `threshold` echoes the raw query value (string) defaulting to number 2.
      threshold: {},
      totalPatientsWithNoShows: { type: 'integer' },
      requestedBy: { type: 'string', nullable: true },
    },
  },
  NoShowReportResponse: envelope('NoShowReportResult'),

  // ---- GET /admin/export (JSON branch) -----------------------------------
  // `?format=csv` short-circuits to text/csv (NOT modelled — non-JSON 200).
  // The default JSON branch: data = { appointments[], count, exportDate,
  // filters:{date_from,date_to,department_id}, requestedBy }. Each export row
  // is the fixed projection (id, appointment_date, appointment_time, status,
  // reason, patient_name, patient_phone, doctor_name, department,
  // consultation_duration_minutes(NULL::integer), notes) — strict item.
  AppointmentExportRow: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'integer' },
      appointment_date: { type: 'string', format: 'date-time', nullable: true },
      appointment_time: { type: 'string', nullable: true },
      status: { type: 'string', nullable: true },
      reason: { type: 'string', nullable: true },
      patient_name: { type: 'string', nullable: true },
      patient_phone: { type: 'string', nullable: true },
      doctor_name: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
      consultation_duration_minutes: { type: 'integer', nullable: true },
      notes: { type: 'string', nullable: true },
    },
  },
  AppointmentExportResult: {
    type: 'object',
    additionalProperties: true,
    required: ['appointments', 'count'],
    properties: {
      appointments: { type: 'array', items: { $ref: '#/components/schemas/AppointmentExportRow' } },
      count: { type: 'integer' },
      exportDate: { type: 'string', format: 'date-time', nullable: true },
      filters: { type: 'object', additionalProperties: true, nullable: true },
      requestedBy: { type: 'string', nullable: true },
    },
  },
  AppointmentExportResponse: envelope('AppointmentExportResult'),

  // ---- GET /admin/capacity -----------------------------------------------
  // data = { date, summary:{...}, doctorCapacity[], department_id, requestedBy }.
  // summary = single row (uncast COUNT/SUM → strings, ROUND overall_utilization
  // → Decimal string). doctorCapacity rows carry booked_appointments(uncast
  // COUNT→string), available_slots(int arithmetic), utilization_percentage
  // (ROUND→string), and `appointments` = array_agg(json_build_object(...)) of
  // { time, patient, status } (or [null] when no rows). All aggregate objects
  // LOOSE.
  CapacityAnalysisResult: {
    type: 'object',
    additionalProperties: true,
    required: ['summary', 'doctorCapacity'],
    properties: {
      date: { type: 'string', nullable: true },
      summary: { type: 'object', additionalProperties: true },
      doctorCapacity: { type: 'array', items: { type: 'object', additionalProperties: true } },
      department_id: { type: 'string', nullable: true },
      requestedBy: { type: 'string', nullable: true },
    },
  },
  CapacityAnalysisResponse: envelope('CapacityAnalysisResult'),

  // ---- GET /admin/sla-dashboard ------------------------------------------
  // appointmentAdminController.getAppointmentSLADashboard. Every COUNT here is
  // `::int`-cast → JS integer (unlike the analytics handler). data = { summary,
  // sla, by_status[], by_department[], pending_confirmation[], date_range }.
  // summary/sla are single typed-ish rows; avg_response_minutes is ROUND(...,1)
  // Decimal → string (keep sla LOOSE). by_status/by_department rows are
  // {key..., count:int}. pending_confirmation rows carry a.uid + mins_waiting
  // (::int) + sla_breached(bool).
  SlaDashboardResult: {
    type: 'object',
    additionalProperties: true,
    required: ['summary', 'sla', 'by_status', 'by_department', 'pending_confirmation'],
    properties: {
      // volumeRes[0]: all COUNT(*)::int → integers.
      summary: {
        type: 'object',
        additionalProperties: true,
        properties: {
          total: { type: 'integer' },
          confirmed: { type: 'integer' },
          completed: { type: 'integer' },
          cancelled: { type: 'integer' },
          no_show: { type: 'integer' },
          pending_confirmation: { type: 'integer' },
        },
      },
      // slaRes[0]: COUNT(*)::int integers + avg_response_minutes ROUND(...,1)
      // Decimal → string (LOOSE so the string cell can't break the contract).
      sla: { type: 'object', additionalProperties: true },
      by_status: { type: 'array', items: { type: 'object', additionalProperties: true } },
      by_department: { type: 'array', items: { type: 'object', additionalProperties: true } },
      pending_confirmation: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
      date_range: {
        type: 'object',
        additionalProperties: true,
        properties: {
          from: { type: 'string', nullable: true },
          to: { type: 'string', nullable: true },
        },
      },
    },
  },
  SlaDashboardResponse: envelope('SlaDashboardResult'),

  // ---- GET /admin/audit-trail --------------------------------------------
  // getStatusAuditTrail → success(res, result) — `data` IS a bare ARRAY of
  // `ash.* + a.uid as appointment_uid + p.name as patient_name + u.name as
  // changed_by_name` rows. LOOSE item: ash.* is the full
  // appointment_status_history row (id/appointment_id/from_status/to_status/
  // changed_by/changed_by_role/reason/created_at/tenant_id) + the three joined
  // aliases; keep the load-bearing keys typed, allow the rest. NOTE on `id`:
  // the column is declared BIGINT, but the LIVE return serializes it as a JS
  // NUMBER (verified: `1122`) — values are within Number range and Prisma's
  // adapter yields a plain number here (no BigInt.toJSON string). Typed integer.
  AppointmentAuditTrailEntry: {
    type: 'object',
    additionalProperties: true,
    required: ['appointment_id', 'to_status'],
    properties: {
      id: { type: 'integer', nullable: true },
      appointment_id: { type: 'integer' },
      from_status: { type: 'string', nullable: true },
      to_status: { type: 'string' },
      changed_by: { type: 'integer', nullable: true },
      changed_by_role: { type: 'string', nullable: true },
      reason: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      appointment_uid: { type: 'string', format: 'uuid', nullable: true },
      patient_name: { type: 'string', nullable: true },
      changed_by_name: { type: 'string', nullable: true },
    },
  },
  AppointmentAuditTrailResponse: listEnvelope('AppointmentAuditTrailEntry'),

  // ---- GET /admin/documents ----------------------------------------------
  // getAllDocumentsAdmin → success(res, docs) — `data` IS a bare ARRAY of
  // appointment_document rows (fixed SELECT column list) + uploaded_by_name /
  // patient_name / doctor_name / appointment_date / appointment_time joins,
  // with file_url re-signed post-query. LOOSE item: type the load-bearing keys,
  // allow the rest. NOTE: `id` and `file_size` are declared BIGINT but the LIVE
  // return yields plain JS numbers (verified: id=1, file_size small/null), not
  // BigInt strings — so both are typed integer (file_size nullable).
  AppointmentDocumentRow: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'appointment_id'],
    properties: {
      id: { type: 'integer' },
      appointment_id: { type: 'integer' },
      patient_id: { type: 'integer', nullable: true },
      doctor_id: { type: 'integer', nullable: true },
      uploaded_by: { type: 'integer', nullable: true },
      upload_role: { type: 'string', nullable: true },
      document_type: { type: 'string', nullable: true },
      file_key: { type: 'string', nullable: true },
      file_url: { type: 'string', nullable: true },
      file_name: { type: 'string', nullable: true },
      file_size: { type: 'integer', nullable: true },
      file_mime: { type: 'string', nullable: true },
      notes: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      uploaded_by_name: { type: 'string', nullable: true },
      patient_name: { type: 'string', nullable: true },
      doctor_name: { type: 'string', nullable: true },
      appointment_date: { type: 'string', format: 'date-time', nullable: true },
      appointment_time: { type: 'string', nullable: true },
    },
  },
  AppointmentDocumentsResponse: listEnvelope('AppointmentDocumentRow'),

  // ---- POST /admin/bulk-update-status ------------------------------------
  // data = { updatedCount, updatedAppointments[], status, reason, updatedBy }.
  // updatedAppointments = RETURNING id, patient_id, doctor_id,
  // appointment_date, status (fixed) — strict item.
  BulkUpdatedAppointment: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'status'],
    properties: {
      id: { type: 'integer' },
      patient_id: { type: 'integer', nullable: true },
      doctor_id: { type: 'integer', nullable: true },
      appointment_date: { type: 'string', format: 'date-time', nullable: true },
      status: { type: 'string', nullable: true },
    },
  },
  BulkUpdateStatusResult: {
    type: 'object',
    additionalProperties: true,
    required: ['updatedCount', 'updatedAppointments'],
    properties: {
      updatedCount: { type: 'integer' },
      updatedAppointments: { type: 'array', items: { $ref: '#/components/schemas/BulkUpdatedAppointment' } },
      status: { type: 'string', nullable: true },
      reason: { type: 'string', nullable: true },
      updatedBy: { type: 'string', nullable: true },
    },
  },
  BulkUpdateStatusResponse: envelope('BulkUpdateStatusResult'),

  // ---- POST /admin/override-book -----------------------------------------
  // data = { appointment:<RETURNING row>, override:true, bookedBy }. RETURNING
  // is a fixed column list incl admin_override/override_reason/created_by.
  OverrideBookedAppointment: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'status'],
    properties: {
      id: { type: 'integer' },
      patient_id: { type: 'integer', nullable: true },
      doctor_id: { type: 'integer', nullable: true },
      appointment_date: { type: 'string', format: 'date-time', nullable: true },
      reason: { type: 'string', nullable: true },
      status: { type: 'string', nullable: true },
      notes: { type: 'string', nullable: true },
      admin_override: { type: 'boolean', nullable: true },
      override_reason: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      created_by: { type: 'string', format: 'uuid', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  OverrideBookResult: {
    type: 'object',
    additionalProperties: true,
    required: ['appointment', 'override'],
    properties: {
      appointment: { $ref: '#/components/schemas/OverrideBookedAppointment' },
      override: { type: 'boolean' },
      bookedBy: { type: 'string', nullable: true },
    },
  },
  OverrideBookResponse: envelope('OverrideBookResult'),

  // ---- POST /admin/resolve-conflict --------------------------------------
  // data = { resolution, updatedAppointment:<RETURNING row>, resolvedBy }.
  // The UPDATE RETURNs id, uid, phone, patient_name, doctor_name,
  // appointment_date, status, notes, created_at, updated_at. LOOSE item — keep
  // id/uid/status typed, allow the rest.
  ResolveConflictAppointment: {
    type: 'object',
    additionalProperties: true,
    required: ['id'],
    properties: {
      id: { type: 'integer' },
      uid: { type: 'string', format: 'uuid', nullable: true },
      phone: { type: 'string', nullable: true },
      patient_name: { type: 'string', nullable: true },
      doctor_name: { type: 'string', nullable: true },
      appointment_date: { type: 'string', format: 'date-time', nullable: true },
      status: { type: 'string', nullable: true },
      notes: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  ResolveConflictResult: {
    type: 'object',
    additionalProperties: true,
    required: ['resolution', 'updatedAppointment'],
    properties: {
      resolution: { type: 'string' },
      updatedAppointment: { $ref: '#/components/schemas/ResolveConflictAppointment' },
      resolvedBy: { type: 'string', nullable: true },
    },
  },
  ResolveConflictResponse: envelope('ResolveConflictResult'),

  // ---- POST /admin/send-reminders ----------------------------------------
  // data = { remindersSent, appointments[{id,patient,doctor,time}], sentBy }.
  // The controller re-maps each reminder row to exactly { id, patient, doctor,
  // time } — strict item.
  ReminderAppointment: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'integer' },
      patient: { type: 'string', nullable: true },
      doctor: { type: 'string', nullable: true },
      time: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  SendRemindersResult: {
    type: 'object',
    additionalProperties: true,
    required: ['remindersSent', 'appointments'],
    properties: {
      remindersSent: { type: 'integer' },
      appointments: { type: 'array', items: { $ref: '#/components/schemas/ReminderAppointment' } },
      sentBy: { type: 'string', nullable: true },
    },
  },
  SendRemindersResponse: envelope('SendRemindersResult'),

  // ---- DELETE /admin/bulk-delete (body) ----------------------------------
  // data = { deletedCount, deletedIds[], reason, deletedBy, archived }.
  // deletedIds = archiveResult.map(r => r.original_id) (integers).
  BulkDeleteResult: {
    type: 'object',
    additionalProperties: true,
    required: ['deletedCount', 'deletedIds', 'archived'],
    properties: {
      deletedCount: { type: 'integer' },
      deletedIds: { type: 'array', items: { type: 'integer' } },
      reason: { type: 'string', nullable: true },
      deletedBy: { type: 'string', nullable: true },
      archived: { type: 'boolean' },
    },
  },
  BulkDeleteResponse: envelope('BulkDeleteResult'),

  // ---- T4 request bodies -------------------------------------------------
  BulkUpdateStatusRequest: {
    type: 'object',
    additionalProperties: true,
    required: ['appointment_ids', 'status'],
    description: 'POST /api/v1/appointments/admin/bulk-update-status. status '
      + 'must be one of completed|cancelled|no_show.',
    properties: {
      appointment_ids: { type: 'array', items: { type: 'integer' } },
      status: { type: 'string', enum: ['completed', 'cancelled', 'no_show'] },
      reason: { type: 'string' },
    },
  },
  OverrideBookRequest: {
    type: 'object',
    additionalProperties: true,
    required: ['patient_id', 'doctor_id', 'appointment_date'],
    description: 'POST /api/v1/appointments/admin/override-book.',
    properties: {
      patient_id: { type: 'integer' },
      doctor_id: { type: 'integer' },
      appointment_date: { type: 'string' },
      reason: { type: 'string' },
      override_reason: { type: 'string' },
      ignore_conflicts: { type: 'boolean' },
    },
  },
  ResolveConflictRequest: {
    type: 'object',
    additionalProperties: true,
    required: ['conflict_appointments', 'resolution_action'],
    description: 'POST /api/v1/appointments/admin/resolve-conflict. '
      + 'conflict_appointments must be exactly 2 ids.',
    properties: {
      conflict_appointments: { type: 'array', items: { type: 'integer' } },
      resolution_action: {
        type: 'string',
        enum: ['cancel_first', 'cancel_second', 'reschedule_first', 'reschedule_second'],
      },
      new_time: { type: 'string' },
    },
  },
  SendRemindersRequest: {
    type: 'object',
    additionalProperties: true,
    description: 'POST /api/v1/appointments/admin/send-reminders.',
    properties: {
      hours_before: { type: 'integer' },
      include_departments: { type: 'array', items: { type: 'integer' } },
      exclude_cancelled: { type: 'boolean' },
    },
  },
  BulkDeleteRequest: {
    type: 'object',
    additionalProperties: true,
    required: ['appointment_ids', 'reason'],
    description: 'DELETE /api/v1/appointments/admin/bulk-delete (body). '
      + 'reason is mandatory (audit trail).',
    properties: {
      appointment_ids: { type: 'array', items: { type: 'integer' } },
      reason: { type: 'string' },
    },
  },

  // ======================================================================
  // T5 — DOCUMENT / PATIENT-RECORDS sub-domain (BOUNDED, RESPONSE-ONLY).
  // Source: src/controllers/appointment/appointmentDocumentController.js
  // (handlers) mounted from appointmentWorkflowRoutes.js.
  //
  // These endpoints are really a DOCUMENT-MANAGEMENT / PHI-upload sub-domain
  // (R2-backed multipart upload + AI/OCR extraction jsonb) that happens to be
  // routed under /appointments/* for historical reasons. We type them at the
  // ENVELOPE level (response-only) this round, LOOSE wherever the payload is
  // genuinely freeform:
  //   * MULTIPART REQUEST bodies (upload/process) are NOT JSON requestBodies —
  //     wire `response` only, never `request`.
  //   * AI EXTRACTION results are arbitrary jsonb (extracted_fields /
  //     normalized_sections / source_citations / safety_flags / metadata are
  //     model output) → LOOSE so the envelope is still validated but `data`
  //     stays open.
  //   * The doc/record ROW shape varies across handlers (patient_records vs
  //     appointment_documents vs synthesised e_prescriptions rows) → LOOSE row.
  // A future dedicated "documents/records" slice can tighten these.
  // ======================================================================

  // ---- Shared doc/record row ---------------------------------------------
  // The row that appears in getPatientAllRecords' grouped lists AND in
  // getAppointmentDocuments' combined array. LOOSE, and `id` is INTENTIONALLY
  // untyped (oneOf integer|string): getAppointmentDocuments synthesises
  // e_prescription entries with a STRING id `rx-<n>` (so the PDF CTA can't
  // collide with the BigInt appointment_documents.id), alongside real integer
  // ids from appointment_documents/patient_records. The row also varies by
  // source — appointment_documents carries upload_role/appointment_date/
  // doctor_department; patient_records carries title/source_hospital/
  // record_date + an attached ai_extraction; e_prescription synth rows carry
  // source/prescription_id + null file_size. We keep a real minimal core (only
  // `id` is universal — appointment_id is absent on patient_records `my_uploads`
  // rows in /patient/records/all, present on the appointment-docs/synth side;
  // file_name/created_at near-universal) and stay open. file_size is
  // integer|null (BigInt column, but the live return is a small JS number or
  // null for synth rows).
  PatientRecordDocItem: {
    type: 'object',
    additionalProperties: true,
    required: ['id'],
    properties: {
      // integer (appointment_documents/patient_records) OR `rx-<n>` (synth).
      id: {},
      appointment_id: { type: 'integer', nullable: true },
      patient_id: { type: 'integer', nullable: true },
      doctor_id: { type: 'integer', nullable: true },
      uploaded_by: { type: 'integer', nullable: true },
      uploaded_by_name: { type: 'string', nullable: true },
      upload_role: { type: 'string', nullable: true },
      document_type: { type: 'string', nullable: true },
      title: { type: 'string', nullable: true },
      file_key: { type: 'string', nullable: true },
      file_url: { type: 'string', nullable: true },
      file_name: { type: 'string', nullable: true },
      file_size: { type: 'integer', nullable: true },
      file_mime: { type: 'string', nullable: true },
      source_hospital: { type: 'string', nullable: true },
      record_date: { type: 'string', nullable: true },
      notes: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      // getPatientAllRecords tags each row with its origin; synth rows add
      // `source: 'e_prescription'` + prescription_id.
      source: { type: 'string', nullable: true },
      prescription_id: { type: 'integer', nullable: true },
      // Display joins (getPatientAllRecords appointment side).
      appointment_date: { type: 'string', format: 'date-time', nullable: true },
      appointment_time: { type: 'string', nullable: true },
      doctor_name: { type: 'string', nullable: true },
      doctor_department: { type: 'string', nullable: true },
      // Attached AI/OCR extraction draft (patient-uploaded records only).
      ai_extraction: { $ref: '#/components/schemas/AiExtractionSummary' },
    },
  },

  // ---- AI/OCR extraction draft -------------------------------------------
  // buildPatientRecordExtractionSummary() output OR extractionUnavailable()
  // fallback. LOOSE: extracted_fields / normalized_sections / source_citations
  // / safety_flags / metadata are arbitrary model jsonb; the unavailable
  // branch returns a different small object ({ intake_id:null,
  // extraction_status:'unavailable', reason, ... }). Nullable: the helper
  // returns null when there's no linked intake. Keep the stable scalar keys
  // typed, allow the rest.
  AiExtractionSummary: {
    type: 'object',
    nullable: true,
    additionalProperties: true,
    properties: {
      intake_id: { nullable: true },
      extraction_status: { type: 'string', nullable: true },
      document_type: { type: 'string', nullable: true },
      reviewer_decision: { type: 'string', nullable: true },
      reviewed_at: { type: 'string', format: 'date-time', nullable: true },
      reviewer_note: { type: 'string', nullable: true },
      reason: { type: 'string', nullable: true },
      decision_support_only: { type: 'boolean' },
      // Freeform model output.
      extracted_fields: { type: 'object', additionalProperties: true, nullable: true },
      normalized_sections: { type: 'object', additionalProperties: true, nullable: true },
      source_citations: { type: 'array', items: {} },
      safety_flags: { type: 'array', items: {} },
      metadata: { type: 'object', additionalProperties: true, nullable: true },
      raw_text: { type: 'string' },
    },
  },

  // ---- GET /patient/records/all ------------------------------------------
  // getPatientAllRecords → success(res, grouped) where grouped =
  // { hospital_records[], my_uploads[], total, patient_id }. The two arrays
  // hold the LOOSE PatientRecordDocItem (hospital_records = appointment_documents
  // rows, my_uploads = patient_records rows w/ optional ai_extraction).
  PatientAllRecordsResult: {
    type: 'object',
    additionalProperties: true,
    required: ['hospital_records', 'my_uploads', 'total'],
    properties: {
      hospital_records: { type: 'array', items: { $ref: '#/components/schemas/PatientRecordDocItem' } },
      my_uploads: { type: 'array', items: { $ref: '#/components/schemas/PatientRecordDocItem' } },
      total: { type: 'integer' },
      patient_id: { type: 'integer', nullable: true },
    },
  },
  PatientAllRecordsResponse: envelope('PatientAllRecordsResult'),

  // ---- POST /patient/records/upload (multipart — response only) ----------
  // uploadPatientRecord → success(res, { ...patient_records RETURNING row,
  // ai_extraction }). The RETURNING row is a fixed column list, but the
  // attached ai_extraction is freeform jsonb → LOOSE result. The request is
  // multipart/form-data (file + metadata) — NOT a JSON requestBody, so we wire
  // response only.
  PatientRecordUploadResult: {
    type: 'object',
    additionalProperties: true,
    required: ['id'],
    properties: {
      id: { type: 'integer' },
      patient_id: { type: 'integer', nullable: true },
      document_type: { type: 'string', nullable: true },
      title: { type: 'string', nullable: true },
      file_key: { type: 'string', nullable: true },
      file_url: { type: 'string', nullable: true },
      file_name: { type: 'string', nullable: true },
      file_size: { type: 'integer', nullable: true },
      file_mime: { type: 'string', nullable: true },
      source_hospital: { type: 'string', nullable: true },
      record_date: { type: 'string', nullable: true },
      notes: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      ai_extraction: { $ref: '#/components/schemas/AiExtractionSummary' },
    },
  },
  PatientRecordUploadResponse: envelope('PatientRecordUploadResult'),

  // ---- DELETE /patient/records/{id} --------------------------------------
  // deletePatientRecord → success(res, { deleted: true }). Strict.
  PatientRecordDeleteResult: {
    type: 'object',
    additionalProperties: false,
    required: ['deleted'],
    properties: {
      deleted: { type: 'boolean' },
    },
  },
  PatientRecordDeleteResponse: envelope('PatientRecordDeleteResult'),

  // ---- GET /patient/records/{id}/extraction ------------------------------
  // getPatientRecordExtraction → success(res, { record, ai_extraction }).
  // `record` is the LOOSE PatientRecordDocItem (with ai_extraction attached);
  // ai_extraction is the freeform AiExtractionSummary.
  PatientRecordExtractionResult: {
    type: 'object',
    additionalProperties: true,
    required: ['record'],
    properties: {
      record: { $ref: '#/components/schemas/PatientRecordDocItem' },
      ai_extraction: { $ref: '#/components/schemas/AiExtractionSummary' },
    },
  },
  PatientRecordExtractionResponse: envelope('PatientRecordExtractionResult'),

  // ---- POST /patient/records/{id}/extraction/process (response only) -----
  // processPatientRecordExtraction → success(res, { record, ai_extraction,
  // processed }). Same shape as the GET plus a `processed` boolean. No JSON
  // request body of note (the record id is in the path).
  PatientRecordExtractionProcessResult: {
    type: 'object',
    additionalProperties: true,
    required: ['record'],
    properties: {
      record: { $ref: '#/components/schemas/PatientRecordDocItem' },
      ai_extraction: { $ref: '#/components/schemas/AiExtractionSummary' },
      processed: { type: 'boolean' },
    },
  },
  PatientRecordExtractionProcessResponse: envelope('PatientRecordExtractionProcessResult'),

  // ---- PATCH /patient/records/{id}/extraction-review ---------------------
  // reviewPatientRecordExtraction → success(res, { review, ai_extraction }).
  // `review` is the decideClinicalDocumentIntake RETURNING row (fixed columns,
  // but reviewer_decision drives the workflow); ai_extraction is the freeform
  // summary with the new decision merged in. LOOSE review row.
  PatientRecordReviewRow: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'reviewer_decision'],
    properties: {
      id: { type: 'integer' },
      patient_uid: { type: 'string', format: 'uuid', nullable: true },
      admission_id: { type: 'integer', nullable: true },
      source_type: { type: 'string', nullable: true },
      document_type: { type: 'string', nullable: true },
      extraction_status: { type: 'string', nullable: true },
      generation_id: { type: 'integer', nullable: true },
      reviewer_decision: { type: 'string', enum: ['accepted', 'rejected', 'needs_revision'] },
      reviewed_by: { type: 'string', format: 'uuid', nullable: true },
      reviewed_at: { type: 'string', format: 'date-time', nullable: true },
      reviewer_note: { type: 'string', nullable: true },
    },
  },
  PatientRecordReviewResult: {
    type: 'object',
    additionalProperties: true,
    required: ['review'],
    properties: {
      review: { $ref: '#/components/schemas/PatientRecordReviewRow' },
      ai_extraction: { $ref: '#/components/schemas/AiExtractionSummary' },
    },
  },
  PatientRecordReviewResponse: envelope('PatientRecordReviewResult'),
  // PATCH body — only { decision, note }. The decision enum is the load-bearing
  // field (validated server-side in decideClinicalDocumentIntake).
  PatientRecordReviewRequest: {
    type: 'object',
    additionalProperties: true,
    required: ['decision'],
    description: 'PATCH /api/v1/appointments/patient/records/{id}/extraction-review. '
      + 'decision must be accepted|rejected|needs_revision (case-insensitive).',
    properties: {
      decision: { type: 'string', enum: ['accepted', 'rejected', 'needs_revision'] },
      note: { type: 'string' },
    },
  },

  // ---- POST /documents/upload (multipart — response only) ----------------
  // uploadAppointmentDocument → success(res, result[0]) — the bare
  // appointment_documents RETURNING row (fixed column list). The request is
  // multipart/form-data — response only. Strict-ish: the RETURNING columns are
  // fixed, but file_size is a BigInt column (small JS number here) → integer,
  // nullable. Open for forward-compat.
  AppointmentDocumentUploadResult: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'appointment_id'],
    properties: {
      id: { type: 'integer' },
      appointment_id: { type: 'integer' },
      patient_id: { type: 'integer', nullable: true },
      doctor_id: { type: 'integer', nullable: true },
      uploaded_by: { type: 'integer', nullable: true },
      upload_role: { type: 'string', nullable: true },
      document_type: { type: 'string', nullable: true },
      file_key: { type: 'string', nullable: true },
      file_url: { type: 'string', nullable: true },
      file_name: { type: 'string', nullable: true },
      file_size: { type: 'integer', nullable: true },
      file_mime: { type: 'string', nullable: true },
      notes: { type: 'string', nullable: true },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  AppointmentDocumentUploadResponse: envelope('AppointmentDocumentUploadResult'),

  // ---- GET /{appointment_id}/documents -----------------------------------
  // getAppointmentDocuments → success(res, combined) — `data` IS a bare ARRAY
  // of the LOOSE PatientRecordDocItem: appointment_documents rows (signed
  // file_url) PLUS synthesised e_prescription entries (string `rx-<n>` id,
  // source:'e_prescription', null file_size). Reuse PatientRecordDocItem (id
  // untyped to allow both the integer and the rx-string).
  AppointmentDocumentsListResponse: listEnvelope('PatientRecordDocItem'),
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
  // PATCH /{id}/reschedule → same row remains active/SCHEDULED.
  'PATCH /api/v1/appointments/{id}/reschedule': {
    request: 'InPlaceRescheduleAppointmentRequest',
    response: 'InPlaceRescheduleResponse',
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

  // ---- T3: LIST -----------------------------------------------------------
  // /list and the root `/` alias both run listController.listAppointments.
  'GET /api/v1/appointments/list': {
    response: 'AppointmentListResponse',
  },
  'GET /api/v1/appointments': {
    response: 'AppointmentListResponse',
  },
  'GET /api/v1/appointments/today/list': {
    response: 'TodayAppointmentsResponse',
  },
  'GET /api/v1/appointments/doctor/{doctor_id}': {
    response: 'DoctorAppointmentsResponse',
  },
  'GET /api/v1/appointments/patient/{patient_id}': {
    response: 'PatientAppointmentsResponse',
  },
  'GET /api/v1/appointments/completed/recent': {
    response: 'RecentCompletedResponse',
  },
  'GET /api/v1/appointments/pending': {
    response: 'PendingAppointmentsResponse',
  },

  // ---- T3: QUEUE / AVAILABILITY -------------------------------------------
  // /queue/today and /queue/today/mine both run getTodayQueue (the `mine`
  // alias just derives doctor_id from the JWT) → identical bare-array shape.
  'GET /api/v1/appointments/queue/today': {
    response: 'TodayQueueResponse',
  },
  'GET /api/v1/appointments/queue/today/mine': {
    response: 'TodayQueueResponse',
  },
  'GET /api/v1/appointments/slots': {
    response: 'SlotsResponse',
  },
  'GET /api/v1/appointments/doctors/options': {
    response: 'DoctorOptionsResponse',
  },
  'POST /api/v1/appointments/walk-in': {
    request: 'WalkInRequest',
    response: 'WalkInResponse',
  },

  // ---- T3: WAIT-TIME / WORKFLOW -------------------------------------------
  'GET /api/v1/appointments/doctor/{doctorId}/wait-time': {
    response: 'DoctorWaitTimeResponse',
  },
  'GET /api/v1/appointments/{id}/wait-time': {
    response: 'AppointmentWaitTimeResponse',
  },
  'POST /api/v1/appointments/{id}/advise-admission': {
    request: 'AdviseAdmissionRequest',
    response: 'AdviseAdmissionResponse',
  },
  'GET /api/v1/appointments/{id}/history': {
    response: 'AppointmentHistoryResponse',
  },

  // ---- T3: legacy phone/uid lookups --------------------------------------
  'GET /api/v1/appointments/phone/{phone}': {
    response: 'LegacyAppointmentListResponse',
  },
  'GET /api/v1/appointments/uid/{uid}': {
    response: 'LegacyAppointmentListResponse',
  },

  // ======================================================================
  // T4: ADMIN ANALYTICS / OPERATIONS
  // ======================================================================
  'GET /api/v1/appointments/admin/analytics': {
    response: 'AppointmentAnalyticsResponse',
  },
  'GET /api/v1/appointments/admin/search': {
    response: 'AppointmentSearchResponse',
  },
  'GET /api/v1/appointments/admin/conflicts': {
    response: 'AppointmentConflictsResponse',
  },
  'GET /api/v1/appointments/admin/no-shows': {
    response: 'NoShowReportResponse',
  },
  // /admin/export: ONLY the default JSON branch is typed. `?format=csv`
  // returns text/csv (handled before success()) — not a JSON 200, so the
  // CSV path is intentionally NOT contract-asserted.
  'GET /api/v1/appointments/admin/export': {
    response: 'AppointmentExportResponse',
  },
  'GET /api/v1/appointments/admin/capacity': {
    response: 'CapacityAnalysisResponse',
  },
  // sla-dashboard / audit-trail / documents are mounted from
  // appointmentWorkflowRoutes.js (literal /admin/* paths), handled by
  // appointmentAdminController + appointmentDocumentController.
  'GET /api/v1/appointments/admin/sla-dashboard': {
    response: 'SlaDashboardResponse',
  },
  'GET /api/v1/appointments/admin/audit-trail': {
    response: 'AppointmentAuditTrailResponse',
  },
  'GET /api/v1/appointments/admin/documents': {
    response: 'AppointmentDocumentsResponse',
  },
  'POST /api/v1/appointments/admin/bulk-update-status': {
    request: 'BulkUpdateStatusRequest',
    response: 'BulkUpdateStatusResponse',
  },
  'POST /api/v1/appointments/admin/override-book': {
    request: 'OverrideBookRequest',
    response: 'OverrideBookResponse',
  },
  'POST /api/v1/appointments/admin/resolve-conflict': {
    request: 'ResolveConflictRequest',
    response: 'ResolveConflictResponse',
  },
  'POST /api/v1/appointments/admin/send-reminders': {
    request: 'SendRemindersRequest',
    response: 'SendRemindersResponse',
  },
  'DELETE /api/v1/appointments/admin/bulk-delete': {
    request: 'BulkDeleteRequest',
    response: 'BulkDeleteResponse',
  },

  // ======================================================================
  // T5: DOCUMENT / PATIENT-RECORDS sub-domain (BOUNDED, response-only).
  // Multipart upload endpoints wire `response` ONLY (the request body is
  // multipart/form-data, not JSON). AI-extraction `data` stays LOOSE; only the
  // success/data/message envelope is contract-asserted. NOTE: the plan listed a
  // bare `GET /patient/records/{id}` — there is NO such route in
  // appointmentWorkflowRoutes.js (only DELETE on that path + the /extraction
  // sub-paths), so it is intentionally absent here.
  // ======================================================================
  'GET /api/v1/appointments/patient/records/all': {
    response: 'PatientAllRecordsResponse',
  },
  // Multipart upload — response only.
  'POST /api/v1/appointments/patient/records/upload': {
    response: 'PatientRecordUploadResponse',
  },
  'DELETE /api/v1/appointments/patient/records/{id}': {
    response: 'PatientRecordDeleteResponse',
  },
  'GET /api/v1/appointments/patient/records/{id}/extraction': {
    response: 'PatientRecordExtractionResponse',
  },
  // Path-param only (record id in URL) — response only.
  'POST /api/v1/appointments/patient/records/{id}/extraction/process': {
    response: 'PatientRecordExtractionProcessResponse',
  },
  'PATCH /api/v1/appointments/patient/records/{id}/extraction-review': {
    request: 'PatientRecordReviewRequest',
    response: 'PatientRecordReviewResponse',
  },
  // Multipart upload — response only.
  'POST /api/v1/appointments/documents/upload': {
    response: 'AppointmentDocumentUploadResponse',
  },
  'GET /api/v1/appointments/{appointment_id}/documents': {
    response: 'AppointmentDocumentsListResponse',
  },
};
