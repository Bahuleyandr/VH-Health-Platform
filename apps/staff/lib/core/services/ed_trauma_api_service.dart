import 'api_client.dart';
import 'package:vhhealth_core/services/idempotency_key.dart';

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

  static Future<List<Map<String, dynamic>>> listDestinationHandoffs() async {
    final resp = await ApiClient.get('/ed/destination-handoffs');
    if (!resp.isSuccess) {
      throw Exception(resp.failureMessage('Destination handoffs failed'));
    }
    final data = resp.dataAsMap();
    final rows = data['handoffs'];
    if (rows is! List) return const [];
    return rows
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList(growable: false);
  }

  static Future<Map<String, dynamic>> requestDestinationHandoff({
    required int emergencyVisitId,
    required String destination,
    required String intendedRecipientRole,
    required String reason,
  }) async {
    final resp = await ApiClient.post(
      '/ed/visits/$emergencyVisitId/destination-handoffs',
      idempotencyKey: IdempotencyKey.generate(),
      body: {
        'destination': destination,
        'intended_recipient_role': intendedRecipientRole.trim().toUpperCase(),
        'reason': reason.trim(),
      },
    );
    if (!resp.isSuccess) {
      throw Exception(resp.failureMessage('Destination handoff failed'));
    }
    return resp.dataAsMap();
  }

  static Future<Map<String, dynamic>> decideDestinationHandoff({
    required int emergencyVisitId,
    required String handoffId,
    required String decision,
    String? reason,
  }) async {
    final resp = await ApiClient.post(
      '/ed/visits/$emergencyVisitId/destination-handoffs/$handoffId/decisions',
      idempotencyKey: IdempotencyKey.generate(),
      body: {
        'decision': decision,
        if (reason != null && reason.trim().isNotEmpty) 'reason': reason.trim(),
      },
    );
    if (!resp.isSuccess) {
      throw Exception(resp.failureMessage('Destination decision failed'));
    }
    return resp.dataAsMap();
  }

  static Future<Map<String, dynamic>> rerouteDestinationHandoff({
    required int emergencyVisitId,
    required String handoffId,
    required String destination,
    required String intendedRecipientRole,
    required String reason,
  }) async {
    final resp = await ApiClient.post(
      '/ed/visits/$emergencyVisitId/destination-handoffs/$handoffId/reroute',
      idempotencyKey: IdempotencyKey.generate(),
      body: {
        'destination': destination,
        'intended_recipient_role': intendedRecipientRole.trim().toUpperCase(),
        'reason': reason.trim(),
      },
    );
    if (!resp.isSuccess) {
      throw Exception(resp.failureMessage('Destination reroute failed'));
    }
    return resp.dataAsMap();
  }
}
