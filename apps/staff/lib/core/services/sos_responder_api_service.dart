import 'api_client.dart';

/// HIGH-1 — SOS responder loop API.
///
/// Wraps the four backend `/sos/responder/*` endpoints (RBAC group
/// `emergencyResponderRoutes`: EMERGENCY_RESPONDER, SECURITY, DRIVER, ADMIN,
/// CMO, MEDICAL_SUPERINTENDENT). These endpoints existed with zero clients —
/// the durable `sos_alerts` rows are the source of truth; the EMERGENCY push
/// is notification-only and screens hydrate through [listActiveAlerts].
/// Conventions follow [ResusApiService].
class SosResponderApiService {
  SosResponderApiService._();

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

  /// Active + responding alerts for the responder's tenant scope, ordered
  /// severity-first then oldest-first (backend ordering).
  static Future<List<Map<String, dynamic>>> listActiveAlerts({
    int limit = 50,
    int offset = 0,
  }) async {
    final resp = await ApiClient.get(
      '/sos/responder/dashboard',
      queryParameters: {'limit': '$limit', 'offset': '$offset'},
    );
    final data = _handle(resp);
    final rows = data['alerts'];
    return rows is List
        ? rows.whereType<Map<String, dynamic>>().toList()
        : const <Map<String, dynamic>>[];
  }

  /// The caller's own response statistics
  /// (`{total_responded, avg_response_seconds, resolved_count}`).
  static Future<Map<String, dynamic>> getMyAnalytics() async {
    final resp = await ApiClient.get('/sos/responder/analytics');
    return _handle(resp);
  }

  /// ACTIVE -> RESPONDING. [responseMessage] is required by the backend
  /// validator and is persisted on the alert (migration 677).
  static Future<Map<String, dynamic>> respond({
    required int alertId,
    required String responseMessage,
  }) async {
    final resp = await ApiClient.post(
      '/sos/responder/respond/$alertId',
      body: {'responseMessage': responseMessage},
    );
    return _handle(resp);
  }

  /// ACTIVE|RESPONDING -> RESOLVED. [resolutionNotes] optional, <=500 chars.
  static Future<Map<String, dynamic>> resolve({
    required int alertId,
    String? resolutionNotes,
  }) async {
    final resp = await ApiClient.post(
      '/sos/responder/resolve/$alertId',
      body: {
        if (resolutionNotes != null && resolutionNotes.trim().isNotEmpty)
          'resolutionNotes': resolutionNotes.trim(),
      },
    );
    return _handle(resp);
  }
}
