import '../config/campus_config.dart';
import 'api_client.dart';

/// Schedule-related API calls: shifts, roster, appointments, walk-ins.
class ScheduleApiService {
  ScheduleApiService._();

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

  static Future<Map<String, dynamic>> _put(
    String path,
    Map<String, dynamic> body,
  ) async {
    final resp = await ApiClient.put(path, body: body);
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
      final raw = Map<String, dynamic>.from(resp.raw as Map);
      if (raw['success'] == true) {
        final data = raw['data'];
        if (data is Map) return Map<String, dynamic>.from(data);
        if (data is List) return {'data': data};
        return raw;
      }
    }
    throw Exception(resp.message ?? 'Request failed (${resp.statusCode})');
  }

  static List<Map<String, dynamic>> _listFrom(
    Map<String, dynamic> data,
    List<String> keys,
  ) {
    dynamic value;
    for (final key in keys) {
      value = data[key];
      if (value != null) break;
    }
    value ??= data['data'];
    if (value is Map) {
      return _listFrom(Map<String, dynamic>.from(value), keys);
    }
    if (value is List) {
      return value
          .whereType<Map>()
          .map((item) => Map<String, dynamic>.from(item))
          .toList();
    }
    return const [];
  }

  // ─── Shift Management ───────────────────────────────────────────────────

  /// GET /api/v1/staff/hr/shift/my-shift — get current staff shift
  static Future<Map<String, dynamic>> getMyShift() async {
    return _get('/staff/hr/shift/my-shift');
  }

  // ─── Appointments ───────────────────────────────────────────────────────

  /// GET /appointments — list appointments optionally filtered
  static Future<Map<String, dynamic>> getAppointments({
    String? department,
    String? staffId,
    String? doctorId,
    String? date,
    String? status,
    bool advisedForAdmission = false,
    int page = 1,
    int limit = 20,
  }) async {
    return _get(
      '/appointments/list',
      query: {
        'department': ?department,
        'staffId': ?staffId,
        'doctor_id': ?doctorId,
        'date': ?date,
        'status': ?status,
        if (advisedForAdmission) 'advised_for_admission': 'true',
        'page': page.toString(),
        'limit': limit.toString(),
      },
    );
  }

  /// GET /appointments/list?advised_for_admission=true - OPD to IPD handoff.
  static Future<List<Map<String, dynamic>>> getAdmissionAdviceQueue({
    int page = 1,
    int limit = 20,
  }) async {
    final data = await getAppointments(
      advisedForAdmission: true,
      page: page,
      limit: limit,
    );
    return _listFrom(data, const ['appointments', 'items']);
  }

  /// POST /appointments/book — create a scheduled appointment.
  static Future<Map<String, dynamic>> createAppointment({
    int? patientId,
    String? patientPhone,
    String? patientName,
    int? doctorId,
    String? doctorUid,
    String? department,
    required String appointmentDate,
    required String appointmentTime,
    required String reason,
    String? notes,
    String? visitType,
  }) async {
    if (patientId == null &&
        (patientPhone == null || patientPhone.trim().isEmpty)) {
      throw Exception('Patient phone or patient ID is required');
    }
    final cleanDepartment = department?.trim();
    if (doctorId == null &&
        (cleanDepartment == null || cleanDepartment.isEmpty)) {
      throw Exception('Select a doctor or department');
    }
    return _post('/appointments/book', {
      'patient_id': ?patientId,
      if (patientPhone != null && patientPhone.trim().isNotEmpty)
        'patient_phone': patientPhone.trim(),
      if (patientName != null && patientName.trim().isNotEmpty)
        'patient_name': patientName.trim(),
      'doctor_id': ?doctorId,
      if (doctorUid != null && doctorUid.trim().isNotEmpty)
        'doctor_uid': doctorUid.trim(),
      if (cleanDepartment != null && cleanDepartment.isNotEmpty)
        'department': cleanDepartment,
      'appointment_date': appointmentDate,
      'appointment_time': appointmentTime,
      'reason': reason,
      'notes': ?notes,
      if (visitType != null && visitType.trim().isNotEmpty)
        'visit_type': visitType.trim().toUpperCase(),
    });
  }

  /// GET /appointments/doctors/options — appointment-safe doctor picker.
  static Future<List<Map<String, dynamic>>> getAppointmentDoctors({
    String? search,
  }) async {
    final doctors = <Map<String, dynamic>>[];
    var page = 1;
    var hasNext = true;

    while (hasNext && page <= 20) {
      final data = await _get(
        '/appointments/doctors/options',
        query: {'page': page.toString(), 'limit': '100', 'search': ?search},
      );
      doctors.addAll(_listFrom(data, const ['doctors']));
      final pagination = data['pagination'] as Map<String, dynamic>?;
      hasNext = pagination?['hasNext'] == true;
      page += 1;
    }

    doctors.sort(
      (a, b) =>
          (a['name']?.toString() ?? '').compareTo(b['name']?.toString() ?? ''),
    );
    return doctors;
  }

  /// PUT /appointments/:id/status — confirm or reschedule
  static Future<Map<String, dynamic>> updateAppointmentStatus(
    String appointmentId,
    String status, {
    String? notes,
  }) async {
    return _put('/appointments/$appointmentId/status', {
      'status': status,
      'notes': ?notes,
    });
  }

  // ─── Appointment Workflow ─────────────────────────────────────────────────

  /// GET /appointments/queue/today — today's appointment queue
  static Future<List<dynamic>> getTodayAppointmentQueue({
    String? doctorId,
    String? department,
  }) async {
    final r = await _get(
      '/appointments/queue/today',
      query: {'doctor_id': ?doctorId, 'department': ?department},
    );
    return _listFrom(r, const ['queue', 'appointments']);
  }

  /// GET /appointments/queue/today/mine - current doctor's own OP queue.
  static Future<List<dynamic>> getMyTodayAppointmentQueue() async {
    final r = await _get('/appointments/queue/today/mine');
    return _listFrom(r, const ['queue', 'appointments']);
  }

  /// GET /appointments/pending — pending appointments needing confirmation
  static Future<List<dynamic>> getPendingAppointments({
    String? fromDate,
    String? toDate,
    String? doctorId,
  }) async {
    final r = await _get(
      '/appointments/pending',
      query: {
        'from_date': ?fromDate,
        'to_date': ?toDate,
        'doctor_id': ?doctorId,
      },
    );
    return _listFrom(r, const ['pending', 'appointments']);
  }

  /// POST /appointments/:id/confirm
  static Future<Map<String, dynamic>> confirmAppointment(
    int id,
    Map<String, dynamic> data,
  ) async {
    return _post('/appointments/$id/confirm', data);
  }

  /// POST /patient-flow/checkins/supervised - record arrival without changing
  /// the appointment's clinician workflow status.
  static Future<Map<String, dynamic>> supervisedKioskCheckIn({
    required int appointmentId,
    String? department,
    Map<String, dynamic>? profileDelta,
  }) async {
    return _post('/patient-flow/checkins/supervised', {
      'appointmentId': appointmentId,
      if (department != null && department.trim().isNotEmpty)
        'department': department.trim(),
      if (profileDelta != null && profileDelta.isNotEmpty)
        'profileDelta': profileDelta,
      'acknowledgements': const ['front_office_arrival_confirmed'],
    });
  }

  /// POST /appointments/:id/no-show
  static Future<Map<String, dynamic>> markNoShow(int id) async {
    return _post('/appointments/$id/no-show', {});
  }

  /// POST /appointments/:id/reschedule
  static Future<Map<String, dynamic>> rescheduleAppointmentStaff(
    int id, {
    required String appointmentDate,
    required String appointmentTime,
    String? notes,
  }) async {
    return _post('/appointments/$id/reschedule', {
      'appointment_date': appointmentDate,
      'appointment_time': appointmentTime,
      if (notes != null && notes.trim().isNotEmpty)
        'confirmation_notes': notes.trim(),
    });
  }

  /// PATCH /appointments/:id/reschedule — update the same appointment row.
  static Future<Map<String, dynamic>> rescheduleAppointmentInPlace(
    int id, {
    required String appointmentDate,
    required String appointmentTime,
    int? doctorId,
    String? notes,
  }) async {
    return _patch('/appointments/$id/reschedule', {
      'appointment_date': appointmentDate,
      'appointment_time': appointmentTime,
      'doctor_id': ?doctorId,
      if (notes != null && notes.trim().isNotEmpty) 'notes': notes.trim(),
    });
  }

  /// POST /appointments/:id/complete
  static Future<Map<String, dynamic>> completeAppointmentStaff(
    int id, {
    String? notes,
  }) async {
    return _post('/appointments/$id/complete', {'notes': ?notes});
  }

  /// POST /appointments/:id/cancel
  static Future<Map<String, dynamic>> cancelAppointmentStaff(
    int id, {
    String? reason,
  }) async {
    return _post('/appointments/$id/cancel', {'cancellation_reason': ?reason});
  }

  /// POST /appointments/documents/upload — multipart upload
  static Future<Map<String, dynamic>> uploadAppointmentDocument(
    int appointmentId,
    String filePath,
    String documentType, {
    String? notes,
    String? fileName,
  }) async {
    final fields = <String, String>{
      'appointment_id': appointmentId.toString(),
      'document_type': documentType,
      'notes': ?notes,
    };
    final files = [
      await ApiClient.multipartFileFromPath(
        'file',
        filePath,
        filename: fileName,
      ),
    ];
    final resp = await ApiClient.multipart(
      '/appointments/documents/upload',
      fields: fields,
      files: files,
    );
    return _handle(resp);
  }

  // ─── Walk-in Registration ──────────────────────────────────────────────

  static Future<Map<String, dynamic>> registerWalkInPayload(
    Map<String, dynamic> body,
  ) async {
    return _post('/appointments/walk-in', body);
  }

  static Future<Map<String, dynamic>> registerWalkIn({
    int? patientId,
    String? patientPhone,
    String? patientName,
    int? doctorId,
    String? department,
    String? reason,
    String? appointmentTime,
  }) async {
    if (patientId == null &&
        (patientPhone == null || patientPhone.trim().isEmpty)) {
      throw Exception('Patient phone or patient ID is required');
    }
    final body = <String, dynamic>{
      'patient_id': ?patientId,
      if (patientPhone != null && patientPhone.trim().isNotEmpty)
        'patient_phone': patientPhone.trim(),
      if (patientName != null && patientName.isNotEmpty)
        'patient_name': patientName,
      'doctor_id': ?doctorId,
      if (department != null && department.isNotEmpty) 'department': department,
      'reason': reason ?? 'Walk-in consultation',
      'appointment_time': appointmentTime ?? 'Walk-in',
    };
    return registerWalkInPayload(body);
  }

  // ─── Campus Config ──────────────────────────────────────────────────────

  /// Fetch campus geofence location from the backend and update [CampusConfig].
  /// Silently falls back to hardcoded defaults on any failure.
  static Future<void> fetchCampusConfig() async {
    await CampusConfig.fetchFromBackend();
  }
}
