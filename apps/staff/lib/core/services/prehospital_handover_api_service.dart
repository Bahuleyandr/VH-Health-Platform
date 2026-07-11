import 'api_client.dart';

class PrehospitalHandoverApiService {
  PrehospitalHandoverApiService._();

  static const _basePath = '/ed/prehospital';

  static Future<List<Map<String, dynamic>>> listReadyForAcceptance({
    int limit = 20,
  }) async {
    final data = await _get(
      '$_basePath/handovers',
      query: {'status': 'ready_for_acceptance', 'limit': limit.toString()},
    );
    final handovers = data['handovers'] ?? data['data'];
    if (handovers is List) {
      return handovers
          .whereType<Map>()
          .map((row) => Map<String, dynamic>.from(row))
          .toList();
    }
    return const [];
  }

  static Future<Map<String, dynamic>> acceptHandover({
    required int handoverId,
    String acceptanceRole = 'receiving_nurse',
    String signatureMethod = 'typed',
    String? clinicalAttestation,
  }) {
    final body = <String, dynamic>{
      'acceptance_role': acceptanceRole,
      'signature_method': signatureMethod,
      if (clinicalAttestation != null && clinicalAttestation.trim().isNotEmpty)
        'clinical_attestation': clinicalAttestation.trim(),
    };
    return _post('$_basePath/handovers/$handoverId/acceptances', body);
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
        if (data is List) return {'data': data};
        return raw;
      }
    }
    throw Exception(
      resp.message ?? 'Pre-hospital request failed (${resp.statusCode})',
    );
  }
}
