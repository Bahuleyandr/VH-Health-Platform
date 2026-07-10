import 'api_client.dart';

/// NL-14 P2 — durable code-blue / resuscitation documentation API.
///
/// The durable `resuscitation_events` rows are the source of truth; the
/// `staff:code-blue` WS channel stays notification-only. Screens hydrate
/// history through [listRecentEvents] (persisted ward/bed/reason context),
/// never from the live-only banner.
class ResusApiService {
  ResusApiService._();

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

  /// Persisted code-blue/resus history (dashboard hydration on load and
  /// reconnect). Returns newest-first event maps.
  static Future<List<Map<String, dynamic>>> listRecentEvents({
    int hours = 24,
    int limit = 50,
    String? status,
  }) async {
    final resp = await ApiClient.get(
      '/resuscitation/events/recent',
      queryParameters: {
        'hours': '$hours',
        'limit': '$limit',
        if (status != null) 'status': status,
      },
    );
    final data = _handle(resp);
    final rows = data['data'];
    return rows is List
        ? rows.whereType<Map<String, dynamic>>().toList()
        : const <Map<String, dynamic>>[];
  }

  /// Full event detail: header + append-only timeline + team roles +
  /// medication/device links + QA review.
  static Future<Map<String, dynamic>> getEvent(int eventId) async {
    final resp = await ApiClient.get('/resuscitation/events/$eventId');
    return _handle(resp);
  }

  /// Explicit code-blue / rapid-response trigger. Creates the DURABLE event
  /// (the backend then emits the realtime notification best-effort).
  static Future<Map<String, dynamic>> createEvent({
    required String patientUid,
    String eventKind = 'code_blue',
    String? reason,
    String? ward,
    String? bedNumber,
    int? admissionId,
    bool isDrill = false,
  }) async {
    final resp = await ApiClient.post(
      '/resuscitation/events',
      body: {
        'patient_uid': patientUid,
        'event_kind': eventKind,
        if (reason != null && reason.isNotEmpty) 'reason': reason,
        if (ward != null && ward.isNotEmpty) 'ward': ward,
        if (bedNumber != null && bedNumber.isNotEmpty) 'bed_number': bedNumber,
        if (admissionId != null) 'admission_id': admissionId,
        'is_drill': isDrill,
      },
    );
    return _handle(resp);
  }

  /// Append one immutable timeline entry (compressions, rhythm check, shock,
  /// airway, medication (MAR-linked when possible), labs, fluids, blood
  /// products, procedures, ROSC, transfer, death declaration, notes).
  static Future<Map<String, dynamic>> appendTimelineEntry({
    required int eventId,
    required String entryType,
    DateTime? occurredAt,
    String? rhythm,
    double? energyJoules,
    String? medicationName,
    String? dose,
    String? route,
    int? marAdministrationId,
    Map<String, dynamic>? details,
  }) async {
    final resp = await ApiClient.post(
      '/resuscitation/events/$eventId/timeline',
      body: {
        'entry_type': entryType,
        if (occurredAt != null) 'occurred_at': occurredAt.toUtc().toIso8601String(),
        if (rhythm != null && rhythm.isNotEmpty) 'rhythm': rhythm,
        if (energyJoules != null) 'energy_joules': energyJoules,
        if (medicationName != null && medicationName.isNotEmpty)
          'medication_name': medicationName,
        if (dose != null && dose.isNotEmpty) 'dose': dose,
        if (route != null && route.isNotEmpty) 'route': route,
        if (marAdministrationId != null)
          'mar_administration_id': marAdministrationId,
        if (details != null) 'details': details,
      },
    );
    return _handle(resp);
  }

  /// Record / sign a team role (team_leader and recorder gate finalization).
  static Future<Map<String, dynamic>> upsertTeamRole({
    required int eventId,
    required String staffUid,
    required String role,
    String? staffName,
    bool sign = false,
  }) async {
    final resp = await ApiClient.post(
      '/resuscitation/events/$eventId/roles',
      body: {
        'staff_uid': staffUid,
        'role': role,
        if (staffName != null && staffName.isNotEmpty) 'staff_name': staffName,
        'sign': sign,
      },
    );
    return _handle(resp);
  }

  /// End the event with a documented outcome.
  static Future<Map<String, dynamic>> endEvent({
    required int eventId,
    required String outcome,
    String? outcomeNote,
  }) async {
    final resp = await ApiClient.post(
      '/resuscitation/events/$eventId/end',
      body: {
        'outcome': outcome,
        if (outcomeNote != null && outcomeNote.isNotEmpty)
          'outcome_note': outcomeNote,
      },
    );
    return _handle(resp);
  }

  /// Finalize — blocked server-side unless a team leader AND recorder are on
  /// record.
  static Future<Map<String, dynamic>> finalizeEvent(int eventId) async {
    final resp = await ApiClient.post(
      '/resuscitation/events/$eventId/finalize',
      body: const {},
    );
    return _handle(resp);
  }
}
