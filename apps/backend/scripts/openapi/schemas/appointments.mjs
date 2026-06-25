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
      visit_type: { type: 'string', nullable: true, enum: [...VISIT_TYPE, null] },
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
      visit_type: { type: 'string', nullable: true, enum: [...VISIT_TYPE, null] },
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
      queue_kind: { type: 'string', nullable: true, enum: [...QUEUE_KIND, null] },
      queue_label: { type: 'string', nullable: true },
      status: { type: 'string', nullable: true, enum: [...QUEUE_STATUS, null] },
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
      visit_type: { type: 'string', nullable: true, enum: [...VISIT_TYPE, null] },
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
};
