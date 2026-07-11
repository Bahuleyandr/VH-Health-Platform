import 'api_client.dart';

class StrokePathwayApiService {
  StrokePathwayApiService._();

  static Map<String, dynamic> _handle(ApiResponse resp) {
    if (resp.isSuccess && resp.raw is Map) {
      final raw = resp.raw as Map<String, dynamic>;
      if (raw['success'] == true) {
        return (raw['data'] as Map<String, dynamic>?) ?? raw;
      }
    }
    throw Exception(resp.message ?? 'Request failed (${resp.statusCode})');
  }

  static Future<Map<String, dynamic>> listActivations({
    String? status,
    String? patientUid,
    int limit = 25,
  }) async {
    final query = <String, String>{'limit': limit.toString()};
    if (status != null && status.isNotEmpty) query['status'] = status;
    if (patientUid != null && patientUid.isNotEmpty) {
      query['patient_uid'] = patientUid;
    }
    final resp = await ApiClient.get(
      '/stroke-pathway/activations',
      queryParameters: query,
    );
    return _handle(resp);
  }

  static Future<Map<String, dynamic>> getActivation(int id) async {
    final resp = await ApiClient.get('/stroke-pathway/activations/$id');
    return _handle(resp);
  }

  static Future<Map<String, dynamic>> getSettings() async {
    final resp = await ApiClient.get('/stroke-pathway/settings');
    return _handle(resp);
  }
}
