import 'api_client.dart';

/// Ambulance live GPS tracking (config-gated per tenant on the backend).
/// Reads return `{enabled: false, ...}` when the tenant has not switched the
/// feature on; ingest 403s with AMBULANCE_GPS_TRACKING_DISABLED.
class AmbulanceTrackingApiService {
  AmbulanceTrackingApiService._();

  static const _basePath = '/ambulance';

  /// GET /ambulance/tracking/active — every actively-transporting request
  /// with its latest fix and handover ETA.
  static Future<Map<String, dynamic>> listActive({int limit = 50}) {
    return _get(
      '$_basePath/tracking/active',
      query: {'limit': limit.toString()},
    );
  }

  /// GET /ambulance/requests/:id/tracking — latest + trail + ETA for one
  /// request.
  static Future<Map<String, dynamic>> getTracking(
    int ambulanceRequestId, {
    int trailLimit = 20,
  }) {
    return _get(
      '$_basePath/requests/$ambulanceRequestId/tracking',
      query: {'trail_limit': trailLimit.toString()},
    );
  }

  /// POST /ambulance/requests/:id/positions — crew-side fix ingest. The
  /// backend stamps the reporter from the JWT.
  static Future<Map<String, dynamic>> postPosition({
    required int ambulanceRequestId,
    required double latitude,
    required double longitude,
    double? speedKmh,
    double? headingDeg,
    double? accuracyM,
    DateTime? recordedAt,
  }) {
    final body = <String, dynamic>{
      'latitude': latitude,
      'longitude': longitude,
      if (speedKmh != null && speedKmh >= 0) 'speed_kmh': speedKmh,
      if (headingDeg != null && headingDeg >= 0) 'heading_deg': headingDeg,
      if (accuracyM != null && accuracyM >= 0) 'accuracy_m': accuracyM,
      if (recordedAt != null)
        'recorded_at': recordedAt.toUtc().toIso8601String(),
    };
    return _post('$_basePath/requests/$ambulanceRequestId/positions', body);
  }

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
      final raw = Map<String, dynamic>.from(resp.raw as Map);
      if (raw['success'] == true) {
        final data = raw['data'];
        if (data is Map) return Map<String, dynamic>.from(data);
        return raw;
      }
    }
    throw AmbulanceTrackingException(
      resp.message ?? 'Ambulance tracking request failed',
      statusCode: resp.statusCode,
      code: resp.raw is Map ? (resp.raw as Map)['code']?.toString() : null,
    );
  }
}

class AmbulanceTrackingException implements Exception {
  final String message;
  final int? statusCode;
  final String? code;

  const AmbulanceTrackingException(this.message, {this.statusCode, this.code});

  bool get featureDisabled => code == 'AMBULANCE_GPS_TRACKING_DISABLED';

  @override
  String toString() => message;
}
