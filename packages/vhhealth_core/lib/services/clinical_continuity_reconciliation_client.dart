import '../api/vhhealth_api.dart';
import '../models/api_response.dart';
import 'clinical_continuity_facility_context.dart';
import 'http_client.dart';

class ClinicalContinuityReconciliationException implements Exception {
  const ClinicalContinuityReconciliationException(this.message, {this.code});

  final String message;
  final String? code;

  @override
  String toString() => message;
}

class ClinicalContinuityReconciliationClient {
  const ClinicalContinuityReconciliationClient({
    ClinicalContinuityFacilityContextClient facilityContextClient =
        const ClinicalContinuityFacilityContextClient(),
  }) : _facilityContextClient = facilityContextClient;

  final ClinicalContinuityFacilityContextClient _facilityContextClient;

  Future<ClinicalContinuityWorkbench> loadWorkbench() async {
    final context = await _requiredContext();
    final response = await VHHttpClient.get(
      '/downtime/reconciliation/workbench',
      continuityFacilityId: context.facilityId,
      continuityFacilityContext: context.headerValue,
    );
    return _parse(response, ClinicalContinuityWorkbenchResponse.fromJson).data;
  }

  Future<ClinicalContinuityCommandResult> registerPaperItem({
    required String incidentId,
    required String paperItemId,
    required ClinicalContinuityRegisterPaperItemRequest request,
    String? idempotencyKey,
  }) => _command(
    '/downtime/reconciliation/incidents/$incidentId/paper-items/$paperItemId',
    request.toJson(),
    idempotencyKey: idempotencyKey,
  );

  Future<ClinicalContinuityCommandResult> recordMedicationAdministration({
    required String incidentId,
    required String paperItemId,
    required ClinicalContinuityMarBackfillRequest request,
    String? idempotencyKey,
  }) => _command(
    '/downtime/reconciliation/incidents/$incidentId/paper-items/$paperItemId/mar-administration',
    request.toJson(),
    idempotencyKey: idempotencyKey,
  );

  Future<ClinicalContinuityCommandResult> recordSpecimenCollection({
    required String incidentId,
    required String paperItemId,
    required ClinicalContinuityLabBackfillRequest request,
    String? idempotencyKey,
  }) => _command(
    '/downtime/reconciliation/incidents/$incidentId/paper-items/$paperItemId/lab-specimen-collection',
    request.toJson(),
    idempotencyKey: idempotencyKey,
  );

  Future<ClinicalContinuityCommandResult> recordTransfusionVerification({
    required String incidentId,
    required String paperItemId,
    required ClinicalContinuityTransfusionBackfillRequest request,
    String? idempotencyKey,
  }) => _command(
    '/downtime/reconciliation/incidents/$incidentId/paper-items/$paperItemId/blood-transfusion-verification',
    request.toJson(),
    idempotencyKey: idempotencyKey,
  );

  Future<ClinicalContinuityCommandResult> decideItem({
    required String itemId,
    required ClinicalContinuityDecisionRequest request,
    String? idempotencyKey,
  }) => _command(
    '/downtime/reconciliation/reconciliation-items/$itemId/decision',
    request.toJson(),
    idempotencyKey: idempotencyKey,
  );

  Future<ClinicalContinuityHeldMessageCommandResult> bindHeldMessage({
    required String incidentId,
    required ClinicalContinuityHeldMessageBindRequest request,
  }) => _heldCommand(
    '/downtime/reconciliation/incidents/$incidentId/interface-held-messages',
    request.toJson(),
  );

  Future<ClinicalContinuityHeldMessageCommandResult> attestHeldMessageRelease({
    required String itemId,
    required ClinicalContinuityHeldMessageAttestationRequest request,
  }) => _heldCommand(
    '/downtime/reconciliation/reconciliation-items/$itemId/held-message-release/attestations',
    request.toJson(),
  );

  Future<ClinicalContinuityHeldMessageCommandResult> releaseHeldMessage({
    required String itemId,
    required ClinicalContinuityHeldMessageReleaseRequest request,
    required String idempotencyKey,
  }) {
    final key = idempotencyKey.trim();
    if (key.isEmpty || key.length > 200) {
      throw const ClinicalContinuityReconciliationException(
        'A bounded Idempotency-Key is required',
        code: 'CONTINUITY_IDEMPOTENCY_KEY_REQUIRED',
      );
    }
    return _heldCommand(
      '/downtime/reconciliation/reconciliation-items/$itemId/held-message-release',
      request.toJson(),
      idempotencyKey: key,
    );
  }

  Future<ClinicalContinuityCommandResult> _command(
    String path,
    Map<String, dynamic> body, {
    String? idempotencyKey,
  }) async {
    final context = await _requiredContext();
    final response = await VHHttpClient.post(
      path,
      body: body,
      idempotencyKey: idempotencyKey,
      continuityFacilityId: context.facilityId,
      continuityFacilityContext: context.headerValue,
    );
    return _parse(response, ClinicalContinuityCommandResponse.fromJson).data;
  }

  Future<ClinicalContinuityHeldMessageCommandResult> _heldCommand(
    String path,
    Map<String, dynamic> body, {
    String? idempotencyKey,
  }) async {
    final context = await _requiredContext();
    final response = await VHHttpClient.post(
      path,
      body: body,
      idempotencyKey: idempotencyKey,
      continuityFacilityId: context.facilityId,
      continuityFacilityContext: context.headerValue,
    );
    return _parse(
      response,
      ClinicalContinuityHeldMessageCommandResponse.fromJson,
    ).data;
  }

  Future<ClinicalContinuityFacilityContext> _requiredContext() async {
    final context = await _facilityContextClient.current();
    if (context == null) {
      throw const ClinicalContinuityReconciliationException(
        'A current server-issued facility context is required',
        code: 'CONTINUITY_FACILITY_CONTEXT_REQUIRED',
      );
    }
    return context;
  }

  T _parse<T>(ApiResponse response, T Function(Map<String, dynamic>) decode) {
    if (!response.isSuccess) {
      throw ClinicalContinuityReconciliationException(
        response.failureMessage('Clinical continuity request failed'),
        code: response.code,
      );
    }
    final raw = response.raw;
    if (raw is! Map) {
      throw const ClinicalContinuityReconciliationException(
        'Clinical continuity response was malformed',
        code: 'CONTINUITY_RESPONSE_INVALID',
      );
    }
    try {
      return decode(Map<String, dynamic>.from(raw));
    } catch (_) {
      throw const ClinicalContinuityReconciliationException(
        'Clinical continuity response did not match the generated contract',
        code: 'CONTINUITY_RESPONSE_INVALID',
      );
    }
  }
}
