import 'api_client.dart';

class OphthalmologyApiService {
  OphthalmologyApiService._();

  static Future<Map<String, dynamic>> _get(String path) async {
    final resp = await ApiClient.get(path);
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

  static Future<Map<String, dynamic>> getPatientHistory(String patientUid) {
    return _get('/ophthalmology/patients/$patientUid/history');
  }

  static Future<Map<String, dynamic>> recordExam(Map<String, dynamic> data) {
    return _post('/ophthalmology/exams', data);
  }

  static Future<Map<String, dynamic>> recordBiometry(
    int examId,
    Map<String, dynamic> data,
  ) {
    return _post('/ophthalmology/exams/$examId/biometry', data);
  }
}
