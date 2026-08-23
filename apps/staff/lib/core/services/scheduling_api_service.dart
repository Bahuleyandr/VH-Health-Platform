// lib/core/services/scheduling_api_service.dart
//
// Typed wrapper over the roadmap-D2 scheduling optimization API
// (apps/backend/src/routes/scheduling/schedulingRoutes.js, mounted at
// /api/v1/scheduling): provider availability templates (+ per-date
// exceptions and leave auto-blocking), the generated slot grid,
// short-lived slot holds, the waitlist (add / auto-fill / resolve),
// overbook policies + decisions, and bookable rooms/equipment.
//
// Every method mirrors the backend body/query contract in snake_case and
// unwraps the `{ success, data }` envelope. There is deliberately no
// waitlist list endpoint and no resource list endpoint on the backend —
// this wrapper does not invent them.

import 'package:vhhealth_core/services/idempotency_key.dart';

import 'api_client.dart';

class SchedulingApiService {
  SchedulingApiService._();

  // ─── Helpers ──────────────────────────────────────────────────────────────

  static Future<Map<String, dynamic>> _get(
    String path, {
    Map<String, String>? query,
  }) async {
    final resp = await ApiClient.get(path, queryParameters: query);
    return _handle(resp);
  }

  static Future<Map<String, dynamic>> _post(
    String path,
    Map<String, dynamic> body,
  ) async {
    final resp = await ApiClient.post(path, body: body);
    return _handle(resp);
  }

  static Future<Map<String, dynamic>> _patch(
    String path,
    Map<String, dynamic> body,
  ) async {
    final resp = await ApiClient.patch(path, body: body);
    return _handle(resp);
  }

  static Map<String, dynamic> _handle(ApiResponse resp) {
    if (resp.isSuccess && resp.raw is Map) {
      final raw = resp.raw as Map<String, dynamic>;
      if (raw['success'] == true) {
        final data = raw['data'];
        if (data is Map<String, dynamic>) return data;
        if (data is List) return {'data': data};
        return raw;
      }
    }
    throw Exception(resp.failureMessage());
  }

  // ─── Templates + leaves ───────────────────────────────────────────────────

  /// POST /scheduling/templates — create (or version-replace) a weekly
  /// availability template. Returns `{ template }`.
  static Future<Map<String, dynamic>> saveTemplate({
    required int doctorId,
    required int weekday,
    required String startTime,
    required String endTime,
    int slotMinutes = 15,
    String? location,
    String? effectiveFrom,
    String? effectiveTo,
    int? replacesTemplateId,
    String? appointmentType,
    String? serviceCode,
    String? visitType,
    int? roomResourceId,
    String? counterLocation,
    Map<String, dynamic>? metadata,
  }) {
    return _post('/scheduling/templates', {
      'doctor_id': doctorId,
      'weekday': weekday,
      'start_time': startTime,
      'end_time': endTime,
      'slot_minutes': slotMinutes,
      'location': ?location,
      'effective_from': ?effectiveFrom,
      'effective_to': ?effectiveTo,
      'replaces_template_id': ?replacesTemplateId,
      'appointment_type': ?appointmentType,
      'service_code': ?serviceCode,
      'visit_type': ?visitType,
      'room_resource_id': ?roomResourceId,
      'counter_location': ?counterLocation,
      'metadata': ?metadata,
    });
  }

  /// GET /scheduling/templates/:doctorId — returns `{ templates, count }`.
  static Future<Map<String, dynamic>> getTemplates(
    int doctorId, {
    bool includeInactive = false,
  }) {
    return _get(
      '/scheduling/templates/$doctorId',
      query: {if (includeInactive) 'include_inactive': 'true'},
    );
  }

  /// POST /scheduling/templates/:id/exceptions — record a per-date
  /// exception (closed | blocked | modified | extra). Returns `{ exception }`.
  static Future<Map<String, dynamic>> addTemplateException({
    required int templateId,
    required int doctorId,
    required String exceptionDate,
    String exceptionType = 'blocked',
    bool allDay = false,
    String? startTime,
    String? endTime,
    int? slotMinutes,
    String? location,
    String? reason,
    Map<String, dynamic>? metadata,
  }) {
    return _post('/scheduling/templates/$templateId/exceptions', {
      'doctor_id': doctorId,
      'exception_date': exceptionDate,
      'exception_type': exceptionType,
      'all_day': allDay,
      'start_time': ?startTime,
      'end_time': ?endTime,
      'slot_minutes': ?slotMinutes,
      'location': ?location,
      'reason': ?reason,
      'metadata': ?metadata,
    });
  }

  /// GET /scheduling/templates/:doctorId/exceptions — returns
  /// `{ exceptions, count }`.
  static Future<Map<String, dynamic>> getTemplateExceptions(
    int doctorId, {
    String? date,
  }) {
    return _get(
      '/scheduling/templates/$doctorId/exceptions',
      query: {if (date != null) 'date': date},
    );
  }

  /// POST /scheduling/leaves — record a leave window; the backend
  /// auto-blocks the affected slot days. Returns `{ leave }`.
  static Future<Map<String, dynamic>> recordLeave({
    required int doctorId,
    required String startsOn,
    required String endsOn,
    String? reason,
  }) {
    return _post('/scheduling/leaves', {
      'doctor_id': doctorId,
      'starts_on': startsOn,
      'ends_on': endsOn,
      'reason': ?reason,
    });
  }

  // ─── Slot grid + holds ────────────────────────────────────────────────────

  /// GET /scheduling/slots — generated slot grid for doctor + date.
  /// Returns the grid object itself: `{ doctor_id, date, on_leave,
  /// schedule_closed?, capacity, booked_count, free_count, held_count,
  /// overbook_allowance, overbook_basis, overbook_policy, slots: [...] }`.
  static Future<Map<String, dynamic>> getSlotGrid({
    required int doctorId,
    required String date,
    String? visitType,
    String? appointmentType,
  }) {
    return _get(
      '/scheduling/slots',
      query: {
        'doctor_id': '$doctorId',
        'date': date,
        if (visitType != null) 'visit_type': visitType,
        if (appointmentType != null) 'appointment_type': appointmentType,
      },
    );
  }

  /// POST /scheduling/slot-holds — place a short-lived hold on a slot.
  /// `idempotency_key` is required by the backend; one is minted here when
  /// the caller does not pass its own. Returns `{ hold }` where the hold
  /// carries `expires_at`, `status`, and `idempotent`.
  static Future<Map<String, dynamic>> createSlotHold({
    required int doctorId,
    required String date,
    required String slotStart,
    String? slotEnd,
    String? patientUid,
    String sourceChannel = 'staff',
    String? idempotencyKey,
    int? holdMinutes,
    Map<String, dynamic>? metadata,
  }) {
    return _post('/scheduling/slot-holds', {
      'doctor_id': doctorId,
      'date': date,
      'slot_start': slotStart,
      'slot_end': ?slotEnd,
      'patient_uid': ?patientUid,
      'source_channel': sourceChannel,
      'idempotency_key': idempotencyKey ?? IdempotencyKey.generate(),
      'hold_minutes': ?holdMinutes,
      'metadata': ?metadata,
    });
  }

  /// POST /scheduling/slot-holds/:id/confirm — returns `{ hold }`.
  static Future<Map<String, dynamic>> confirmSlotHold(
    int holdId, {
    int? appointmentId,
  }) {
    return _post('/scheduling/slot-holds/$holdId/confirm', {
      'appointment_id': ?appointmentId,
    });
  }

  /// POST /scheduling/slot-holds/:id/release — returns `{ hold }`.
  static Future<Map<String, dynamic>> releaseSlotHold(int holdId) {
    return _post('/scheduling/slot-holds/$holdId/release', const {});
  }

  // ─── Waitlist ─────────────────────────────────────────────────────────────

  /// POST /scheduling/waitlist — returns `{ entry }`.
  static Future<Map<String, dynamic>> addToWaitlist({
    required String patientUid,
    required int doctorId,
    String? preferredDate,
    String preferredWindow = 'any',
    int priority = 5,
    String? notes,
    String sourceChannel = 'staff',
    String? overrideReason,
    Map<String, dynamic>? metadata,
  }) {
    return _post('/scheduling/waitlist', {
      'patient_uid': patientUid,
      'doctor_id': doctorId,
      'preferred_date': ?preferredDate,
      'preferred_window': preferredWindow,
      'priority': priority,
      'notes': ?notes,
      'source_channel': sourceChannel,
      'override_reason': ?overrideReason,
      'metadata': ?metadata,
    });
  }

  /// POST /scheduling/waitlist/fill — offer free slots to waiting entries
  /// for one doctor + date. Returns `{ offers, free_slots_remaining }` or
  /// `{ offers: [], reason }` when nothing can be offered.
  static Future<Map<String, dynamic>> fillWaitlist({
    required int doctorId,
    required String date,
  }) {
    return _post('/scheduling/waitlist/fill', {
      'doctor_id': doctorId,
      'date': date,
    });
  }

  /// PATCH /scheduling/waitlist/:id — resolve an open entry
  /// (status: booked | expired | cancelled). Returns `{ entry }`.
  static Future<Map<String, dynamic>> resolveWaitlistEntry(
    int entryId, {
    required String status,
    String? overrideReason,
  }) {
    return _patch('/scheduling/waitlist/$entryId', {
      'status': status,
      'override_reason': ?overrideReason,
    });
  }

  // ─── Overbook policies + decisions ────────────────────────────────────────

  /// GET /scheduling/overbook-policies — returns `{ policies, count }`.
  static Future<Map<String, dynamic>> getOverbookPolicies({int? doctorId}) {
    return _get(
      '/scheduling/overbook-policies',
      query: {if (doctorId != null) 'doctor_id': '$doctorId'},
    );
  }

  /// POST /scheduling/overbook-policies — create or (with [policyId])
  /// update a policy. Returns `{ policy }`.
  static Future<Map<String, dynamic>> saveOverbookPolicy({
    int? policyId,
    String policyScope = 'tenant',
    int? doctorId,
    int? departmentId,
    String? departmentName,
    String? visitType,
    String? appointmentType,
    num maxOverbookFraction = 0,
    int maxOverbookSlots = 0,
    String authorityRole = 'RECEPTION_INCHARGE',
    bool overrideRequiresReason = true,
    bool enabled = false,
    String? effectiveFrom,
    String? effectiveTo,
    Map<String, dynamic>? metadata,
  }) {
    return _post('/scheduling/overbook-policies', {
      'id': ?policyId,
      'policy_scope': policyScope,
      'doctor_id': ?doctorId,
      'department_id': ?departmentId,
      'department_name': ?departmentName,
      'visit_type': ?visitType,
      'appointment_type': ?appointmentType,
      'max_overbook_fraction': maxOverbookFraction,
      'max_overbook_slots': maxOverbookSlots,
      'authority_role': authorityRole,
      'override_requires_reason': overrideRequiresReason,
      'enabled': enabled,
      'effective_from': ?effectiveFrom,
      'effective_to': ?effectiveTo,
      'metadata': ?metadata,
    });
  }

  /// POST /scheduling/overbook/evaluate — audited overbook decision.
  /// Returns `{ decision, reason, allowed, overbook_allowance, policy,
  /// audit_event }`.
  static Future<Map<String, dynamic>> evaluateOverbook({
    required int doctorId,
    required String date,
    String? slotStart,
    int? appointmentId,
    int requestedSlots = 1,
    String? visitType,
    String? appointmentType,
    String? overrideReason,
  }) {
    return _post('/scheduling/overbook/evaluate', {
      'doctor_id': doctorId,
      'date': date,
      'slot_start': ?slotStart,
      'appointment_id': ?appointmentId,
      'requested_slots': requestedSlots,
      'visit_type': ?visitType,
      'appointment_type': ?appointmentType,
      'override_reason': ?overrideReason,
    });
  }

  // ─── Bookable resources ───────────────────────────────────────────────────

  /// POST /scheduling/resources — upsert a bookable room or equipment
  /// (unique per tenant + kind + name). Returns `{ resource }`. There is
  /// no list endpoint; keep the returned id.
  static Future<Map<String, dynamic>> createResource({
    required String kind,
    required String name,
    String? location,
    String? serviceCode,
    int? departmentId,
    int capacity = 1,
    Map<String, dynamic>? metadata,
  }) {
    return _post('/scheduling/resources', {
      'kind': kind,
      'name': name,
      'location': ?location,
      'service_code': ?serviceCode,
      'department_id': ?departmentId,
      'capacity': capacity,
      'metadata': ?metadata,
    });
  }

  /// POST /scheduling/resources/:id/compatibility — returns
  /// `{ compatibility }` (the created rule).
  static Future<Map<String, dynamic>> addResourceCompatibility({
    required int resourceId,
    int? templateId,
    int? doctorId,
    String? appointmentType,
    String? serviceCode,
    String? visitType,
    String requirement = 'compatible',
    Map<String, dynamic>? metadata,
  }) {
    return _post('/scheduling/resources/$resourceId/compatibility', {
      'template_id': ?templateId,
      'doctor_id': ?doctorId,
      'appointment_type': ?appointmentType,
      'service_code': ?serviceCode,
      'visit_type': ?visitType,
      'requirement': requirement,
      'metadata': ?metadata,
    });
  }

  /// GET /scheduling/resources/:id/compatibility — returns
  /// `{ compatibility: [...], count }`.
  static Future<Map<String, dynamic>> getResourceCompatibility(int resourceId) {
    return _get('/scheduling/resources/$resourceId/compatibility');
  }

  /// POST /scheduling/resources/:id/book — returns `{ booking }`.
  static Future<Map<String, dynamic>> bookResource({
    required int resourceId,
    required String startsAt,
    required String endsAt,
    String bookedForType = 'other',
    String? bookedForId,
    String? patientUid,
    String? notes,
    int? doctorId,
    String? appointmentType,
    String? serviceCode,
    String? visitType,
  }) {
    return _post('/scheduling/resources/$resourceId/book', {
      'starts_at': startsAt,
      'ends_at': endsAt,
      'booked_for_type': bookedForType,
      'booked_for_id': ?bookedForId,
      'patient_uid': ?patientUid,
      'notes': ?notes,
      'doctor_id': ?doctorId,
      'appointment_type': ?appointmentType,
      'service_code': ?serviceCode,
      'visit_type': ?visitType,
    });
  }

  /// GET /scheduling/resources/:id/schedule — day view of bookings.
  /// Returns `{ bookings, count }`.
  static Future<Map<String, dynamic>> getResourceSchedule({
    required int resourceId,
    required String date,
  }) {
    return _get(
      '/scheduling/resources/$resourceId/schedule',
      query: {'date': date},
    );
  }
}
