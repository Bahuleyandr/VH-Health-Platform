import 'api_client.dart';

/// Porter / patient-transport API calls (backend
/// `apps/backend/src/routes/patientFlow/kioskCheckinRoutes.js`, mounted at
/// `/api/v1/patient-flow`, service `porterTransportService.js`).
///
/// Task lifecycle (backend `transitionTransportTask` allowedFrom lists):
///   open → assigned → accepted → picked_up → completed, or cancelled.
///   accept  : from open, assigned      (assigned recipient only)
///   pickup  : from assigned, accepted  (assigned recipient only)
///   complete: from assigned, accepted, picked_up (assigned recipient only)
///   verify  : status must already be 'completed' and verified_by null; the
///             status does not change — verify stamps verified_by. Narrower
///             role list + independent-verifier rule enforced server-side.
///   cancel  : from any active status; requester or a coordination/
///             escalation role only (B-L5(b) — porters must hand back).
class TransportApiService {
  TransportApiService._();

  /// Statuses the backend treats as in-flight (`ACTIVE_STATUSES` in
  /// porterTransportService.js).
  static const List<String> activeTaskStatuses = [
    'open',
    'assigned',
    'accepted',
    'picked_up',
  ];

  // ─── Helpers (same envelope idiom as MedicalApiService) ───────────────────

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

  static List<Map<String, dynamic>> _rows(Object? value) {
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((row) => row.cast<String, dynamic>())
        .toList();
  }

  static Map<String, dynamic> _taskFrom(Map<String, dynamic> data) {
    final task = data['task'];
    if (task is Map<String, dynamic>) return task;
    if (task is Map) return task.cast<String, dynamic>();
    return data;
  }

  // ─── Zones + settings ─────────────────────────────────────────────────────

  /// GET /patient-flow/transport/zones — rows carry `zone_key`,
  /// `name` (aliased from zone_name), `zone_type`, `building`, `floor`,
  /// `is_active`, `sort_order`.
  static Future<List<Map<String, dynamic>>> getZones({
    bool activeOnly = true,
  }) async {
    final data = await _get(
      '/patient-flow/transport/zones',
      query: {if (activeOnly) 'active_only': 'true'},
    );
    return _rows(data['zones'] ?? data['data']);
  }

  /// GET /patient-flow/transport/settings — `{enabled, roster_department,
  /// recipient_role_codes, escalation_role_codes, source_sla_minutes,
  /// source_priority, ...}`. Task creation is refused (TRANSPORT_DISABLED)
  /// while `enabled` is false.
  static Future<Map<String, dynamic>> getSettings() async {
    final data = await _get('/patient-flow/transport/settings');
    final settings = data['settings'];
    if (settings is Map<String, dynamic>) return settings;
    if (settings is Map) return settings.cast<String, dynamic>();
    return data;
  }

  // ─── Tasks ────────────────────────────────────────────────────────────────

  /// POST /patient-flow/transport/tasks — create a transport request.
  /// Everything is optional server-side except an enabled tenant; the backend
  /// defaults source_type to `manual`, derives priority/SLA from tenant
  /// settings, and resolves porter recipients from the zone ids. A non-UUID
  /// [patientUid] is silently dropped server-side (`maybeUuid`). Returns
  /// `{task, recipients}` (201).
  static Future<Map<String, dynamic>> createTask({
    required int pickupZoneId,
    required int destinationZoneId,
    String? pickupLabel,
    String? destinationLabel,
    String priority = 'medium',
    String sourceType = 'manual',
    String? patientUid,
    int? admissionId,
    int? appointmentId,
    String? notes,
    int? slaMinutes,
  }) async {
    return _post('/patient-flow/transport/tasks', {
      'source_type': sourceType,
      'pickup_zone_id': pickupZoneId,
      'destination_zone_id': destinationZoneId,
      'pickup_label': ?pickupLabel,
      'destination_label': ?destinationLabel,
      'priority': priority,
      'patient_uid': ?patientUid,
      'admission_id': ?admissionId,
      'appointment_id': ?appointmentId,
      // Free-text notes land as the task-created update message.
      'message': ?notes,
      'sla_minutes': ?slaMinutes,
    });
  }

  /// GET /patient-flow/transport/tasks — tenant board. Supported filters
  /// (controller `getTransportTasks`): `status` (single value), `patient_uid`,
  /// `source_type`, `limit` (default 100, cap 500). Rows are ordered
  /// in-flight first (picked_up, accepted, assigned, open, then terminal),
  /// SLA-due ascending.
  static Future<List<Map<String, dynamic>>> listTasks({
    String? status,
    String? patientUid,
    String? sourceType,
    int limit = 100,
  }) async {
    final data = await _get(
      '/patient-flow/transport/tasks',
      query: {
        if (status != null && status.trim().isNotEmpty) 'status': status.trim(),
        if (patientUid != null && patientUid.trim().isNotEmpty)
          'patient_uid': patientUid.trim(),
        if (sourceType != null && sourceType.trim().isNotEmpty)
          'source_type': sourceType.trim(),
        'limit': limit.toString(),
      },
    );
    return _rows(data['tasks'] ?? data['data']);
  }

  /// Open board for the "All open" tab. The backend `status` filter takes a
  /// single value, so this fetches unfiltered (active statuses sort first,
  /// ahead of the LIMIT) and keeps in-flight tasks plus completed-but-
  /// unverified ones — the latter are still open handoff work and are the
  /// only surface where the verify action can appear.
  static Future<List<Map<String, dynamic>>> listOpenBoardTasks({
    int limit = 200,
  }) async {
    final tasks = await listTasks(limit: limit);
    return tasks.where((task) {
      final status = (task['status'] ?? '').toString().toLowerCase();
      if (activeTaskStatuses.contains(status)) return true;
      final verifiedBy = (task['verified_by'] ?? '').toString().trim();
      return status == 'completed' && verifiedBy.isEmpty;
    }).toList();
  }

  /// GET /patient-flow/transport/tasks/my — tasks where the authenticated
  /// staff member is a recipient (roster/zone/fallback fan-out or manual
  /// assignment). Same optional `status`/`limit` filters as the board.
  static Future<List<Map<String, dynamic>>> listMyTasks({
    String? status,
    int limit = 100,
  }) async {
    final data = await _get(
      '/patient-flow/transport/tasks/my',
      query: {
        if (status != null && status.trim().isNotEmpty) 'status': status.trim(),
        'limit': limit.toString(),
      },
    );
    return _rows(data['tasks'] ?? data['data']);
  }

  /// GET /patient-flow/transport/tasks/:taskId — `{task, recipients, updates}`.
  static Future<Map<String, dynamic>> getTaskDetail(int taskId) async {
    return _get('/patient-flow/transport/tasks/$taskId');
  }

  // ─── Transitions ──────────────────────────────────────────────────────────

  /// POST /patient-flow/transport/tasks/:taskId/assign — coordinator hands
  /// the task to a named staff member (`staff_id` int or `staff_uid` uuid;
  /// at least one required). Legal from any non-terminal status.
  static Future<Map<String, dynamic>> assignTask({
    required int taskId,
    int? staffId,
    String? staffUid,
    String? message,
  }) async {
    final data = await _post('/patient-flow/transport/tasks/$taskId/assign', {
      if (staffId != null) 'staff_id': staffId,
      'staff_uid': ?staffUid,
      'message': ?message,
    });
    return _taskFrom(data);
  }

  /// POST .../accept — porter takes the job (from open/assigned; caller must
  /// be a task recipient or the backend returns TRANSPORT_ASSIGNEE_REQUIRED).
  static Future<Map<String, dynamic>> acceptTask(
    int taskId, {
    String? locationText,
  }) async {
    final data = await _post('/patient-flow/transport/tasks/$taskId/accept', {
      'location_text': ?locationText,
    });
    return _taskFrom(data);
  }

  /// POST .../pickup — patient collected (from assigned/accepted).
  static Future<Map<String, dynamic>> pickupTask(
    int taskId, {
    String? locationText,
  }) async {
    final data = await _post('/patient-flow/transport/tasks/$taskId/pickup', {
      'location_text': ?locationText,
    });
    return _taskFrom(data);
  }

  /// POST .../complete — drop-off done (from assigned/accepted/picked_up);
  /// closes the SLA instance.
  static Future<Map<String, dynamic>> completeTask(
    int taskId, {
    String? locationText,
    String? message,
  }) async {
    final data = await _post('/patient-flow/transport/tasks/$taskId/complete', {
      'location_text': ?locationText,
      'message': ?message,
    });
    return _taskFrom(data);
  }

  /// POST .../verify — receiving-side handoff verification. Only legal on a
  /// completed, not-yet-verified task; the porter who completed it cannot
  /// verify (TRANSPORT_INDEPENDENT_VERIFIER_REQUIRED) and the route runs
  /// under the narrower PATIENT_TRANSPORT_VERIFY_ROUTE_ROLES list.
  static Future<Map<String, dynamic>> verifyTask(
    int taskId, {
    String? message,
  }) async {
    final data = await _post('/patient-flow/transport/tasks/$taskId/verify', {
      'message': ?message,
    });
    return _taskFrom(data);
  }

  /// POST .../cancel — requester or a coordination/escalation role only
  /// (TRANSPORT_CANCEL_ROLE_REQUIRED otherwise). Reason is persisted as
  /// `cancellation_reason` and the SLA instance is closed.
  static Future<Map<String, dynamic>> cancelTask(
    int taskId, {
    required String reason,
  }) async {
    final data = await _post('/patient-flow/transport/tasks/$taskId/cancel', {
      'reason': reason,
    });
    return _taskFrom(data);
  }
}
