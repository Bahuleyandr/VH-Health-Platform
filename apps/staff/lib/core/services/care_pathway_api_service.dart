import '../models/care_pathway_work_models.dart';

import 'package:vhhealth_core/services/idempotency_key.dart';

import 'api_client.dart';

class CarePathwayApiException implements Exception {
  const CarePathwayApiException({
    required this.message,
    required this.statusCode,
    this.code,
  });

  final String message;
  final int statusCode;
  final String? code;

  bool get isMissingPathwayWorkSurface =>
      statusCode == 405 ||
      statusCode == 501 ||
      (statusCode == 404 &&
          code != 'APPOINTMENT_NOT_FOUND' &&
          code != 'PATIENT_NOT_FOUND');

  @override
  String toString() {
    final cleanCode = code?.trim();
    return cleanCode == null || cleanCode.isEmpty
        ? message
        : '$message ($cleanCode)';
  }
}

class CarePathwayApiService {
  CarePathwayApiService._();

  static Future<AppointmentPathwayWork> getAppointmentPathwayWork(
    int appointmentId,
  ) async {
    final response = await ApiClient.get(
      '/appointments/$appointmentId/pathway-work',
    );
    return AppointmentPathwayWork.fromJson(_dataMap(response));
  }

  static Future<InpatientPendingResultsWork> getAdmissionPendingResults(
    int admissionId,
  ) async {
    final response = await ApiClient.get('/emr/$admissionId/pending-results');
    return InpatientPendingResultsWork.fromJson(_dataMap(response));
  }

  static Future<Map<String, dynamic>> createPendingResultHandoff({
    required int admissionId,
    required String sourceType,
    required String sourceId,
    required String resourceReferenceId,
    String? patientSafeLabel,
  }) async {
    final key = IdempotencyKey.generate();
    final response = await ApiClient.post(
      '/emr/$admissionId/pending-result-handoffs',
      idempotencyKey: key,
      body: {
        'source_type': sourceType,
        'source_id': sourceId,
        'resource_reference_id': resourceReferenceId,
        if (patientSafeLabel?.trim().isNotEmpty == true)
          'patient_safe_label': patientSafeLabel!.trim(),
        'idempotency_key': key,
      },
    );
    return _dataMap(response);
  }

  static Future<Map<String, dynamic>> bindPendingResultToSignedSummary({
    required int admissionId,
    required String handoffId,
    required int dischargeSummaryId,
  }) async {
    final response = await ApiClient.put(
      '/emr/$admissionId/pending-result-handoffs/$handoffId/summary-inclusion',
      body: {'discharge_summary_id': dischargeSummaryId},
    );
    return _dataMap(response);
  }

  static Future<Map<String, dynamic>> recordFollowUpException({
    required int admissionId,
    required String reason,
  }) async {
    final key = IdempotencyKey.generate();
    final response = await ApiClient.post(
      '/emr/$admissionId/follow-up-exception',
      idempotencyKey: key,
      body: {'reason': reason.trim(), 'idempotency_key': key},
    );
    return _dataMap(response);
  }

  static Future<OpVisitClosureEvidence> recordAppointmentClosureEvidence({
    required int appointmentId,
    required OpClosureEvidenceCommand command,
  }) async {
    final key = IdempotencyKey.generate();
    final response = await ApiClient.post(
      '/appointments/$appointmentId/closure-evidence',
      idempotencyKey: key,
      body: command.toJson(idempotencyKey: key),
    );
    final data = _dataMap(response);
    return OpVisitClosureEvidence.fromJson(
      Map<String, dynamic>.from(data['closure_evidence'] as Map),
    );
  }

  static Future<OpInpatientTransferReceipt> requestInpatientTransfer({
    required int appointmentId,
    required String intendedRecipientUid,
    required String reason,
  }) async {
    final key = IdempotencyKey.generate();
    final response = await ApiClient.post(
      '/appointments/$appointmentId/inpatient-transfer-requests',
      idempotencyKey: key,
      body: {
        'intended_recipient_uid': intendedRecipientUid.trim(),
        'reason': reason.trim(),
      },
    );
    return OpInpatientTransferReceipt.fromJson(_dataMap(response));
  }

  static Future<OpInpatientTransferReceipt> acceptInpatientTransfer({
    required int appointmentId,
    required String handoffId,
  }) async {
    final key = IdempotencyKey.generate();
    final response = await ApiClient.post(
      '/appointments/$appointmentId/inpatient-transfer-requests/$handoffId/accept',
      idempotencyKey: key,
      body: const {},
    );
    return OpInpatientTransferReceipt.fromJson(_dataMap(response));
  }

  static Map<String, dynamic> _dataMap(ApiResponse response) {
    if (!response.isSuccess) {
      throw CarePathwayApiException(
        message: response.failureMessage(
          'Request failed (${response.statusCode})',
        ),
        statusCode: response.statusCode,
        code: response.code,
      );
    }
    if (response.data is Map) {
      return Map<String, dynamic>.from(response.data as Map);
    }
    if (response.raw is Map) {
      final raw = Map<String, dynamic>.from(response.raw as Map);
      if (raw['success'] == true && raw['data'] is Map) {
        return Map<String, dynamic>.from(raw['data'] as Map);
      }
    }
    throw CarePathwayApiException(
      message: response.message ?? 'Unexpected response',
      statusCode: response.statusCode,
      code: response.code,
    );
  }
}
