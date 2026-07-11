import 'api_client.dart';

class EdTraumaApiService {
  EdTraumaApiService._();

  static Future<Map<String, dynamic>> getPolicy() async {
    final resp = await ApiClient.get('/ed/policy');
    if (!resp.isSuccess) throw Exception(resp.failureMessage('Policy failed'));
    return resp.dataAsMap();
  }

  static Future<Map<String, dynamic>> createTraumaActivation(
    Map<String, dynamic> body,
  ) async {
    final resp = await ApiClient.post('/ed/trauma-activations', body: body);
    if (!resp.isSuccess) {
      throw Exception(resp.failureMessage('Activation failed'));
    }
    return resp.dataAsMap();
  }

  static Future<Map<String, dynamic>> recordTraumaSurvey(
    Map<String, dynamic> body,
  ) async {
    final resp = await ApiClient.post('/ed/trauma-surveys', body: body);
    if (!resp.isSuccess) throw Exception(resp.failureMessage('Survey failed'));
    return resp.dataAsMap();
  }

  static Future<Map<String, dynamic>> reviewMlcCompleteness(
    int mlcRecordId,
    Map<String, dynamic> body,
  ) async {
    final resp = await ApiClient.put(
      '/ed/mlc-records/$mlcRecordId/completeness',
      body: body,
    );
    if (!resp.isSuccess) {
      throw Exception(resp.failureMessage('MLC completeness failed'));
    }
    return resp.dataAsMap();
  }

  static Future<Map<String, dynamic>> linkEncounterEvidence(
    Map<String, dynamic> body,
  ) async {
    final resp = await ApiClient.post('/ed/encounter-evidence', body: body);
    if (!resp.isSuccess) {
      throw Exception(resp.failureMessage('Evidence link failed'));
    }
    return resp.dataAsMap();
  }
}
