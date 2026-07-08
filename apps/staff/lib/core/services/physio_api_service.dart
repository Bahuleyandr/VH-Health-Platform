import 'api_client.dart';

class PhysioApiService {
  PhysioApiService._();

  static Future<Map<String, dynamic>> _get(
    String path, {
    Map<String, String>? queryParameters,
  }) async {
    final resp = await ApiClient.get(path, queryParameters: queryParameters);
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
        return (raw['data'] as Map<String, dynamic>?) ?? raw;
      }
    }
    throw Exception(resp.message ?? 'Request failed (${resp.statusCode})');
  }

  static Future<Map<String, dynamic>> getWorklist({int limit = 50}) {
    return _get('/physio/worklist', queryParameters: {'limit': '$limit'});
  }

  static Future<Map<String, dynamic>> getPatientSummary(String patientUid) {
    return _get('/physio/patients/$patientUid/summary');
  }

  static Future<Map<String, dynamic>> recordAssessment(
    Map<String, dynamic> data,
  ) {
    return _post('/physio/assessments', data);
  }

  static Future<Map<String, dynamic>> startTherapyPlan(
    Map<String, dynamic> data,
  ) {
    return _post('/physio/therapy-plans', data);
  }

  static Future<Map<String, dynamic>> recordSession(Map<String, dynamic> data) {
    return _post('/physio/sessions', data);
  }
}
