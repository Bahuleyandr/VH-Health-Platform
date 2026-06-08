import '../models/clinical_platform_models.dart';
import 'api_client.dart';

class ClinicalPlatformApiService {
  ClinicalPlatformApiService._();

  static Future<CanonicalPatientTimeline> getPatientTimeline(
    String patientUid, {
    int limit = 100,
    bool includeLegacy = false,
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

  static Future<List<ClinicalAuditEvent>> getEncounterAuditEvents(
    String encounterId, {
    int limit = 100,
  }) async {
    final resp = await ApiClient.get(
      '/encounters/$encounterId/audit',
      queryParameters: {'limit': limit.toString()},
    );
    final data = _dataMap(resp);
    return _listOfMaps(
      data['events'],
    ).map(ClinicalAuditEvent.fromJson).toList();
  }

  static Future<List<WorkflowSlaInstance>> getEncounterWorkflowSlas(
    String encounterId, {
    String? status,
    int limit = 100,
  }) async {
    final resp = await ApiClient.get(
      '/encounters/$encounterId/slas',
      queryParameters: {
        'limit': limit.toString(),
        if (status != null && status.trim().isNotEmpty) 'status': status.trim(),
      },
    );
    final data = _dataMap(resp);
    return _listOfMaps(data['slas']).map(WorkflowSlaInstance.fromJson).toList();
  }

  static Future<List<MedicationSafetyReview>> getEncounterMedicationSafety(
    String encounterId, {
    String? status,
    String? severity,
    int limit = 100,
  }) async {
    final resp = await ApiClient.get(
      '/encounters/$encounterId/medication-safety',
      queryParameters: {
        'limit': limit.toString(),
        if (status != null && status.trim().isNotEmpty) 'status': status.trim(),
        if (severity != null && severity.trim().isNotEmpty)
          'severity': severity.trim(),
      },
    );
    final data = _dataMap(resp);
    return _listOfMaps(
      data['reviews'],
    ).map(MedicationSafetyReview.fromJson).toList();
  }

  static Future<MedicationSafetyEvaluation> evaluateMedicationSafety({
    required int patientId,
    required List<Map<String, dynamic>> medications,
    String? patientUid,
    String? encounterId,
    String? overrideReason,
  }) async {
    final path = encounterId == null || encounterId.trim().isEmpty
        ? '/encounters/medication-safety/evaluate'
        : '/encounters/${encounterId.trim()}/medication-safety/evaluate';
    final resp = await ApiClient.post(
      path,
      body: {
        'patient_id': patientId,
        'medications': medications,
        if (patientUid != null && patientUid.trim().isNotEmpty)
          'patient_uid': patientUid.trim(),
        if (overrideReason != null && overrideReason.trim().isNotEmpty)
          'override_reason': overrideReason.trim(),
      },
    );
    return MedicationSafetyEvaluation.fromJson(_dataMap(resp));
  }

  static Future<List<ClinicalDocumentationTemplate>>
  getClinicalDocumentationTemplates({
    String? context,
    String? encounterType,
  }) async {
    final resp = await ApiClient.get(
      '/encounters/documentation/templates',
      queryParameters: {
        if (context != null && context.trim().isNotEmpty)
          'context': context.trim(),
        if (encounterType != null && encounterType.trim().isNotEmpty)
          'encounter_type': encounterType.trim(),
      },
    );
    final data = _dataMap(resp);
    return _listOfMaps(
      data['templates'],
    ).map(ClinicalDocumentationTemplate.fromJson).toList();
  }

  static Future<ClinicalDowntimePolicy> getClinicalDowntimePolicy({
    String? role,
  }) async {
    final resp = await ApiClient.get(
      '/encounters/downtime-policy',
      queryParameters: {
        if (role != null && role.trim().isNotEmpty) 'role': role.trim(),
      },
    );
    return ClinicalDowntimePolicy.fromJson(_dataMap(resp));
  }

  static Future<RolePolicySnapshot> getRolePolicySnapshot() async {
    final resp = await ApiClient.get('/rbac/policy');
    return RolePolicySnapshot.fromJson(_dataMap(resp));
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

  static List<Map<String, dynamic>> _listOfMaps(dynamic value) {
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList();
  }

  static Map<String, dynamic> _dataMap(ApiResponse resp) {
    if (!resp.isSuccess) {
      throw Exception(resp.message ?? 'Request failed (${resp.statusCode})');
    }
    if (resp.data is Map) {
      return Map<String, dynamic>.from(resp.data as Map);
    }
    if (resp.raw is! Map) {
      throw Exception(resp.message ?? 'Request failed (${resp.statusCode})');
    }
    final raw = Map<String, dynamic>.from(resp.raw as Map);
    if (raw['success'] != true || raw['data'] is! Map) {
      throw Exception(resp.message ?? 'Unexpected response');
    }
    return Map<String, dynamic>.from(raw['data'] as Map);
  }
}
