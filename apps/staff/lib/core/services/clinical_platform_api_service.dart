import '../models/clinical_platform_models.dart';
import 'api_client.dart';

class ClinicalPlatformApiService {
  ClinicalPlatformApiService._();

  static Future<CanonicalPatientTimeline> getPatientTimeline(
    String patientUid, {
    int limit = 100,
    bool includeLegacy = true,
  }) async {
    final resp = await ApiClient.get(
      '/patients/$patientUid/timeline',
      queryParameters: {
        'limit': limit.toString(),
        'include_legacy': includeLegacy ? 'true' : 'false',
      },
    );
    final data = _dataMap(resp);
    return CanonicalPatientTimeline.fromJson(data);
  }

  static Future<ClinicalEncounter> getEncounter(String encounterId) async {
    final resp = await ApiClient.get('/encounters/$encounterId');
    return ClinicalEncounter.fromJson(_dataMap(resp));
  }

  static Future<ClinicalEncounter> activateEncounter(String encounterId) {
    return _transition(encounterId, 'activate');
  }

  static Future<ClinicalEncounter> signEncounter(
    String encounterId, {
    String? reason,
  }) {
    return _transition(encounterId, 'sign', reason: reason);
  }

  static Future<ClinicalEncounter> amendEncounter(
    String encounterId, {
    String? reason,
  }) {
    return _transition(encounterId, 'amend', reason: reason);
  }

  static Future<ClinicalEncounter> lockEncounter(
    String encounterId, {
    String? reason,
  }) {
    return _transition(encounterId, 'lock', reason: reason);
  }

  static Future<ClinicalEncounter> _transition(
    String encounterId,
    String action, {
    String? reason,
  }) async {
    final resp = await ApiClient.post(
      '/encounters/$encounterId/$action',
      body: {
        if (reason != null && reason.trim().isNotEmpty) 'reason': reason.trim(),
      },
    );
    return ClinicalEncounter.fromJson(_dataMap(resp));
  }

  static Map<String, dynamic> _dataMap(ApiResponse resp) {
    if (!resp.isSuccess || resp.raw is! Map) {
      throw Exception(resp.message ?? 'Request failed (${resp.statusCode})');
    }
    final raw = Map<String, dynamic>.from(resp.raw as Map);
    if (raw['success'] != true || raw['data'] is! Map) {
      throw Exception(resp.message ?? 'Unexpected response');
    }
    return Map<String, dynamic>.from(raw['data'] as Map);
  }
}
