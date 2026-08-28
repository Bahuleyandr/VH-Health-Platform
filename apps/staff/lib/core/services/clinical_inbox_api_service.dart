import 'package:vhhealth_core/services/idempotency_key.dart';

import 'api_client.dart';

class ClinicalInboxResult {
  final List<ClinicalInboxTask> tasks;
  final int count;

  const ClinicalInboxResult({required this.tasks, required this.count});
}

abstract class ClinicalInboxApi {
  const ClinicalInboxApi();

  Future<ClinicalInboxResult> listInboxTasks({int limit = 100});

  Future<ClinicalInboxTask> acknowledgeTask(String id, {int? breakGlassId});

  Future<ClinicalInboxTask> claimTask(String id);

  Future<void> claimMarMedicationException({
    required String caseId,
    required String idempotencyKey,
  });

  Future<DiagnosticActionReceipt> recordDiagnosticAction(
    DiagnosticActionCommand command,
  );

  Future<PostDischargeCrossSignReceipt> crossSignPendingResult(
    PostDischargeCrossSignCommand command,
  );

  Future<DiagnosticActionReceipt> reopenDiagnosticResult({
    required String generationId,
    required String reason,
  });
}

class ClinicalInboxApiService extends ClinicalInboxApi {
  const ClinicalInboxApiService();

  static const ClinicalInboxApiService instance = ClinicalInboxApiService();

  @override
  Future<ClinicalInboxResult> listInboxTasks({int limit = 100}) async {
    final resp = await ApiClient.get(
      '/clinical-inbox/tasks/inbox',
      queryParameters: {'limit': '$limit'},
    );
    if (!resp.isSuccess) {
      throw Exception(resp.failureMessage('Could not load clinical inbox'));
    }
    final data = resp.dataAsMap();
    final taskRows = data['tasks'] is List ? data['tasks'] as List : const [];
    final tasks = taskRows
        .whereType<Map>()
        .map((row) => ClinicalInboxTask.fromJson(row.cast<String, dynamic>()))
        .toList(growable: false);
    return ClinicalInboxResult(
      tasks: tasks,
      count: _intValue(data['count']) ?? tasks.length,
    );
  }

  @override
  Future<ClinicalInboxTask> acknowledgeTask(
    String id, {
    int? breakGlassId,
  }) async {
    final resp = await ApiClient.post(
      '/clinical-inbox/tasks/$id/acknowledge',
      body: {'break_glass_id': ?breakGlassId},
    );
    if (!resp.isSuccess) {
      throw Exception(resp.failureMessage('Could not acknowledge task'));
    }
    final data = resp.dataAsMap();
    return ClinicalInboxTask.fromJson(data);
  }

  @override
  Future<ClinicalInboxTask> claimTask(String id) async {
    final resp = await ApiClient.post(
      '/clinical-inbox/tasks/$id/claim',
      body: const {},
    );
    if (!resp.isSuccess) {
      throw Exception(resp.failureMessage('Could not claim task'));
    }
    return ClinicalInboxTask.fromJson(resp.dataAsMap());
  }

  @override
  Future<void> claimMarMedicationException({
    required String caseId,
    required String idempotencyKey,
  }) async {
    if (!_isCanonicalPositiveBigInt(caseId)) {
      throw ArgumentError.value(
        caseId,
        'caseId',
        'must be a positive signed-64 decimal',
      );
    }
    final resp = await ApiClient.post(
      '/clinical/mar/exceptions/$caseId/claim',
      body: const {},
      idempotencyKey: idempotencyKey,
    );
    if (!resp.isSuccess) {
      throw Exception(
        resp.failureMessage('Could not claim medication exception'),
      );
    }
  }

  @override
  Future<DiagnosticActionReceipt> recordDiagnosticAction(
    DiagnosticActionCommand command,
  ) async {
    final resp = await ApiClient.post(
      '/clinical-inbox/diagnostic-results/${command.generationId}/actions',
      body: command.toJson(),
    );
    if (!resp.isSuccess) {
      throw Exception(
        resp.failureMessage('Could not record diagnostic action'),
      );
    }
    return DiagnosticActionReceipt.fromJson(resp.dataAsMap());
  }

  @override
  Future<PostDischargeCrossSignReceipt> crossSignPendingResult(
    PostDischargeCrossSignCommand command,
  ) async {
    final resp = await ApiClient.post(
      '/emr/${command.admissionId}/pending-result-handoffs/'
      '${command.handoffId}/cross-sign',
      idempotencyKey: command.idempotencyKey,
      body: command.toJson(),
    );
    if (!resp.isSuccess) {
      throw PostDischargeCrossSignException(
        message: resp.failureMessage(
          'Could not cross-sign the post-discharge result',
        ),
        statusCode: resp.statusCode,
        code: resp.code,
      );
    }
    final resolution = _mapValue(resp.dataAsMap()['resolution']);
    return PostDischargeCrossSignReceipt.fromJson(resolution);
  }

  @override
  Future<DiagnosticActionReceipt> reopenDiagnosticResult({
    required String generationId,
    required String reason,
  }) async {
    final resp = await ApiClient.post(
      '/clinical-inbox/diagnostic-results/$generationId/reopen',
      body: {'reason': reason.trim()},
    );
    if (!resp.isSuccess) {
      throw Exception(
        resp.failureMessage('Could not reopen diagnostic result'),
      );
    }
    return DiagnosticActionReceipt.fromJson(resp.dataAsMap());
  }
}

class DiagnosticActionCommand {
  final String generationId;
  final String taskId;
  final String disposition;
  final String clinicalNote;
  final String generationSnapshotSha256;
  final String? reason;
  final String? downstreamResourceType;
  final String? downstreamResourceId;

  const DiagnosticActionCommand({
    required this.generationId,
    required this.taskId,
    required this.disposition,
    required this.clinicalNote,
    required this.generationSnapshotSha256,
    this.reason,
    this.downstreamResourceType,
    this.downstreamResourceId,
  });

  Map<String, dynamic> toJson() => {
    'task_id': int.parse(taskId),
    'disposition': disposition,
    'clinical_note': clinicalNote.trim(),
    'generation_snapshot_sha256': generationSnapshotSha256,
    'attested': true,
    if (reason?.trim().isNotEmpty == true) 'reason': reason!.trim(),
    if (disposition != 'no_action')
      'downstream_evidence': {
        'resource_type': downstreamResourceType?.trim().toLowerCase(),
        'resource_id': downstreamResourceId?.trim(),
      },
  };
}

class PostDischargeCrossSignCommand {
  final int admissionId;
  final String handoffId;
  final String generationId;
  final String diagnosticActionId;
  final String generationSnapshotSha256;
  final String actionTaskId;
  final String idempotencyKey;

  PostDischargeCrossSignCommand({
    required this.admissionId,
    required this.handoffId,
    required this.generationId,
    required this.diagnosticActionId,
    required this.generationSnapshotSha256,
    required this.actionTaskId,
    String? idempotencyKey,
  }) : idempotencyKey = idempotencyKey ?? IdempotencyKey.generate();

  Map<String, dynamic> toJson() => {
    'generation_id': generationId,
    'diagnostic_action_id': diagnosticActionId,
    'generation_snapshot_sha256': generationSnapshotSha256,
    'attested': true,
  };
}

class PostDischargeCrossSignReceipt {
  final String id;
  final int admissionId;
  final String handoffId;
  final String generationId;
  final String diagnosticActionId;
  final String pathwayInstanceId;
  final String ownerActionId;
  final String actionTaskId;
  final String trackingTaskId;
  final String signatureId;
  final String resolutionActionId;
  final String handoffState;
  final String currentHandoffState;
  final String generationSnapshotSha256;
  final String requestSha256;
  final String canonicalTimelineEventId;
  final String canonicalAuditEventId;
  final bool replayed;

  const PostDischargeCrossSignReceipt({
    required this.id,
    required this.admissionId,
    required this.handoffId,
    required this.generationId,
    required this.diagnosticActionId,
    required this.pathwayInstanceId,
    required this.ownerActionId,
    required this.actionTaskId,
    required this.trackingTaskId,
    required this.signatureId,
    required this.resolutionActionId,
    required this.handoffState,
    required this.currentHandoffState,
    required this.generationSnapshotSha256,
    required this.requestSha256,
    required this.canonicalTimelineEventId,
    required this.canonicalAuditEventId,
    required this.replayed,
  });

  factory PostDischargeCrossSignReceipt.fromJson(Map<String, dynamic> json) {
    return PostDischargeCrossSignReceipt(
      id: _text(json['id']),
      admissionId: _intValue(json['admission_id']) ?? 0,
      handoffId: _text(json['handoff_id']),
      generationId: _text(json['generation_id']),
      diagnosticActionId: _text(json['diagnostic_action_id']),
      pathwayInstanceId: _text(json['pathway_instance_id']),
      ownerActionId: _text(json['owner_action_id']),
      actionTaskId: _text(json['action_task_id']),
      trackingTaskId: _text(json['tracking_task_id']),
      signatureId: _text(json['signature_id']),
      resolutionActionId: _text(json['resolution_action_id']),
      handoffState: _text(json['handoff_state']),
      currentHandoffState: _text(json['current_handoff_state']),
      generationSnapshotSha256: _text(json['generation_snapshot_sha256'])
          .toLowerCase(),
      requestSha256: _text(json['request_sha256']).toLowerCase(),
      canonicalTimelineEventId: _text(json['canonical_timeline_event_id']),
      canonicalAuditEventId: _text(json['canonical_audit_event_id']),
      replayed: json['replayed'] == true,
    );
  }
}

class PostDischargeCrossSignException implements Exception {
  final String message;
  final int statusCode;
  final String? code;

  const PostDischargeCrossSignException({
    required this.message,
    required this.statusCode,
    required this.code,
  });

  bool get requiresRefresh => statusCode == 409;

  @override
  String toString() => message;
}

class DiagnosticActionReceipt {
  final String id;
  final String generationId;
  final String? taskId;
  final String actionKind;
  final String? disposition;
  final String? signatureId;
  final bool replayed;

  const DiagnosticActionReceipt({
    required this.id,
    required this.generationId,
    required this.taskId,
    required this.actionKind,
    required this.disposition,
    required this.signatureId,
    required this.replayed,
  });

  factory DiagnosticActionReceipt.fromJson(Map<String, dynamic> json) {
    return DiagnosticActionReceipt(
      id: _text(json['id']),
      generationId: _text(json['generation_id']),
      taskId: _nullableText(json['task_id']),
      actionKind: _text(json['action_kind']),
      disposition: _nullableText(json['disposition']),
      signatureId: _nullableText(json['signature_id']),
      replayed: json['replayed'] == true,
    );
  }
}

class ClinicalInboxEscalation {
  final String tier;
  final String action;
  final DateTime? at;

  const ClinicalInboxEscalation({
    required this.tier,
    required this.action,
    required this.at,
  });

  factory ClinicalInboxEscalation.fromJson(Map<String, dynamic> json) {
    return ClinicalInboxEscalation(
      tier: _text(json['tier']).isEmpty ? '-' : _text(json['tier']),
      action: _text(json['action']).isEmpty ? '-' : _text(json['action']),
      at: _parseDate(json['at']),
    );
  }
}

class ClinicalInboxTask {
  final String id;
  final String taskKind;
  final String title;
  final String description;
  final String patientUid;
  final String priority;
  final String status;
  final String relatedResourceType;
  final String relatedResourceId;
  final String assignedToUid;
  final String assignedToRole;
  final String workflowSlaInstanceId;
  final String slaCompletionSemantics;
  final String pathwayInstanceId;
  final String pathwayKey;
  final String pathwayOwnerUid;
  final String pathwayAccountableRole;
  final String pathwayStageKey;
  final String diagnosticGenerationId;
  final String diagnosticClassification;
  final String diagnosticGenerationSnapshotSha256;
  final int? diagnosticSourceVersion;
  final String diagnosticPredecessorGenerationId;
  final bool diagnosticIsCorrection;
  final int? pendingResultAdmissionId;
  final String pendingResultHandoffId;
  final String pendingResultOwnerActionId;
  final String pendingResultHandoffState;
  final String pendingResultResolutionActionId;
  final String diagnosticAuthoritativeActionId;
  final String diagnosticAuthoritativeActionKind;
  final String diagnosticAuthoritativeDisposition;
  final DateTime? diagnosticAuthoritativeActionOccurredAt;
  final bool canCrossSignPendingResult;
  final String externalRecoveryCriticalReviewObligationId;
  final String externalRecoveryCriticalReviewAcknowledgementId;
  final String externalRecoveryInterfaceFamily;
  final bool externalRecoveryAwarenessAcknowledgementRequired;
  final DateTime? externalRecoverySourceOccurredAt;
  final DateTime? externalRecoveryAwarenessRecordedAt;
  final DateTime? externalRecoveryAwarenessAcknowledgedAt;
  final DateTime? dueAt;
  final DateTime? slaBreachedAt;
  final DateTime? createdAt;
  final Map<String, dynamic> metadata;

  const ClinicalInboxTask({
    required this.id,
    this.taskKind = '',
    required this.title,
    required this.description,
    required this.patientUid,
    required this.priority,
    required this.status,
    required this.relatedResourceType,
    required this.relatedResourceId,
    this.assignedToUid = '',
    required this.assignedToRole,
    this.workflowSlaInstanceId = '',
    this.slaCompletionSemantics = 'none',
    this.pathwayInstanceId = '',
    this.pathwayKey = '',
    this.pathwayOwnerUid = '',
    this.pathwayAccountableRole = '',
    this.pathwayStageKey = '',
    this.diagnosticGenerationId = '',
    this.diagnosticClassification = '',
    this.diagnosticGenerationSnapshotSha256 = '',
    this.diagnosticSourceVersion,
    this.diagnosticPredecessorGenerationId = '',
    this.diagnosticIsCorrection = false,
    this.pendingResultAdmissionId,
    this.pendingResultHandoffId = '',
    this.pendingResultOwnerActionId = '',
    this.pendingResultHandoffState = '',
    this.pendingResultResolutionActionId = '',
    this.diagnosticAuthoritativeActionId = '',
    this.diagnosticAuthoritativeActionKind = '',
    this.diagnosticAuthoritativeDisposition = '',
    this.diagnosticAuthoritativeActionOccurredAt,
    this.canCrossSignPendingResult = false,
    this.externalRecoveryCriticalReviewObligationId = '',
    this.externalRecoveryCriticalReviewAcknowledgementId = '',
    this.externalRecoveryInterfaceFamily = '',
    this.externalRecoveryAwarenessAcknowledgementRequired = false,
    this.externalRecoverySourceOccurredAt,
    this.externalRecoveryAwarenessRecordedAt,
    this.externalRecoveryAwarenessAcknowledgedAt,
    required this.dueAt,
    required this.slaBreachedAt,
    required this.createdAt,
    required this.metadata,
  });

  factory ClinicalInboxTask.fromJson(Map<String, dynamic> json) {
    final metadata = _mapValue(json['metadata']);
    return ClinicalInboxTask(
      id: _text(json['id']),
      taskKind: _text(json['task_kind']).toLowerCase(),
      title: _text(json['title']).isEmpty
          ? 'Critical result review'
          : _text(json['title']),
      description: _text(json['description']),
      patientUid: _text(json['patient_uid']),
      priority: _text(json['priority']).toLowerCase(),
      status: _text(json['status']).toLowerCase(),
      relatedResourceType: _text(json['related_resource_type']),
      relatedResourceId: _text(json['related_resource_id']),
      assignedToUid: _text(json['assigned_to_uid']),
      assignedToRole: _text(json['assigned_to_role']),
      workflowSlaInstanceId: _text(json['workflow_sla_instance_id']),
      slaCompletionSemantics: _text(json['sla_completion_semantics'])
          .toLowerCase(),
      pathwayInstanceId: _text(json['pathway_instance_id']),
      pathwayKey: _text(json['pathway_key']),
      pathwayOwnerUid: _text(json['pathway_owner_uid']),
      pathwayAccountableRole: _text(json['pathway_accountable_role']),
      pathwayStageKey: _text(json['pathway_stage_key']),
      diagnosticGenerationId: _text(json['diagnostic_generation_id']),
      diagnosticClassification: _text(json['diagnostic_classification'])
          .toLowerCase(),
      diagnosticGenerationSnapshotSha256: _text(
        json['diagnostic_generation_snapshot_sha256'],
      ).toLowerCase(),
      diagnosticSourceVersion: _intValue(json['diagnostic_source_version']),
      diagnosticPredecessorGenerationId: _text(
        json['diagnostic_predecessor_generation_id'],
      ),
      diagnosticIsCorrection: json['diagnostic_is_correction'] == true,
      pendingResultAdmissionId: _intValue(json['pending_result_admission_id']),
      pendingResultHandoffId: _text(json['pending_result_handoff_id']),
      pendingResultOwnerActionId: _text(json['pending_result_owner_action_id']),
      pendingResultHandoffState: _text(json['pending_result_handoff_state'])
          .toLowerCase(),
      pendingResultResolutionActionId: _text(
        json['pending_result_resolution_action_id'],
      ),
      diagnosticAuthoritativeActionId: _text(
        json['diagnostic_authoritative_action_id'],
      ),
      diagnosticAuthoritativeActionKind: _text(
        json['diagnostic_authoritative_action_kind'],
      ).toLowerCase(),
      diagnosticAuthoritativeDisposition: _text(
        json['diagnostic_authoritative_disposition'],
      ).toLowerCase(),
      diagnosticAuthoritativeActionOccurredAt: _parseDate(
        json['diagnostic_authoritative_action_occurred_at'],
      ),
      canCrossSignPendingResult: json['can_cross_sign'] == true,
      externalRecoveryCriticalReviewObligationId: _text(
        json['external_recovery_critical_review_obligation_id'],
      ),
      externalRecoveryCriticalReviewAcknowledgementId: _text(
        json['external_recovery_critical_review_acknowledgement_id'],
      ),
      externalRecoveryInterfaceFamily: _text(
        json['external_recovery_interface_family'],
      ).toUpperCase(),
      externalRecoveryAwarenessAcknowledgementRequired:
          json['external_recovery_awareness_acknowledgement_required'] == true,
      externalRecoverySourceOccurredAt: _parseDate(
        json['external_recovery_source_occurred_at'],
      ),
      externalRecoveryAwarenessRecordedAt: _parseDate(
        json['external_recovery_awareness_recorded_at'],
      ),
      externalRecoveryAwarenessAcknowledgedAt: _parseDate(
        json['external_recovery_awareness_acknowledged_at'],
      ),
      dueAt: _parseDate(json['due_at']),
      slaBreachedAt: _parseDate(json['sla_breached_at']),
      createdAt: _parseDate(json['created_at']),
      metadata: metadata,
    );
  }

  bool get isActionableStatus =>
      status == 'open' || status == 'in_progress' || status == 'overdue';

  bool get hasCounterSaleVoidRefundContract =>
      _text(metadata['task_contract']) == 'counter_sale_void_refund_v1';

  bool get needsAcknowledgement =>
      !hasCounterSaleVoidRefundContract &&
      (slaCompletionSemantics == 'acknowledgement' ||
          isRecoveredCriticalAwareness) &&
      (status == 'open' || status == 'overdue');

  bool get isRecoveredCriticalAwareness =>
      externalRecoveryCriticalReviewObligationId.isNotEmpty &&
      externalRecoveryAwarenessAcknowledgementRequired &&
      slaCompletionSemantics == 'none' &&
      dueAt == null &&
      priority == 'critical';

  bool get needsDoctorAction =>
      !hasCounterSaleVoidRefundContract &&
      slaCompletionSemantics == 'domain_evidence' &&
      isActionableStatus &&
      diagnosticGenerationId.isNotEmpty &&
      diagnosticGenerationSnapshotSha256.isNotEmpty;

  bool get isPostDischargePendingResultReview =>
      relatedResourceType == 'discharge_pending_result_action' &&
      pendingResultAdmissionId != null &&
      pendingResultHandoffId.isNotEmpty &&
      diagnosticGenerationId.isNotEmpty &&
      diagnosticGenerationSnapshotSha256.isNotEmpty &&
      diagnosticAuthoritativeActionId.isNotEmpty;

  bool get needsPostDischargeCrossSign =>
      isPostDischargePendingResultReview &&
      canCrossSignPendingResult &&
      isActionableStatus &&
      pendingResultHandoffState == 'result_available' &&
      pendingResultResolutionActionId.isEmpty &&
      diagnosticAuthoritativeActionKind == 'doctor_disposition';

  String get domainEvidenceDeepLink => _text(metadata['deep_link']);

  bool get isClinicalAlertDeliveryRecovery {
    final caseKind = _text(metadata['case_kind']);
    return slaCompletionSemantics == 'domain_evidence' &&
        isActionableStatus &&
        _text(metadata['task_contract']) ==
            'clinical_alert_delivery_recovery_v1' &&
        relatedResourceType == 'clinical_alert_delivery_recovery_cases' &&
        _positiveIntegerPattern.hasMatch(relatedResourceId) &&
        _positiveIntegerPattern.hasMatch(_text(metadata['obligation_id'])) &&
        (caseKind == 'manual_hold' || caseKind == 'recipient_coverage');
  }

  bool get isMarMedicationException {
    final caseId = _text(metadata['exception_case_id']);
    final administrationId = _text(metadata['medication_administration_id']);
    final exceptionKind = _text(metadata['exception_kind']);
    return taskKind == 'review' &&
        slaCompletionSemantics == 'domain_evidence' &&
        isActionableStatus &&
        _text(metadata['task_contract']) == 'mar_medication_exception_v1' &&
        _text(metadata['sla_key']) == 'mar_medication_exception_review' &&
        relatedResourceType == 'mar_medication_exception_cases' &&
        _isCanonicalPositiveBigInt(relatedResourceId) &&
        relatedResourceId == caseId &&
        _positiveIntegerPattern.hasMatch(administrationId) &&
        (exceptionKind == 'held' || exceptionKind == 'missed');
  }

  bool get isCathInventoryShortfall {
    final usageId = _text(metadata['cath_consumable_usage_id']);
    final caseId = _text(metadata['cath_case_id']);
    final inventoryItemId = _text(metadata['inventory_item_id']);
    final movementKind = _text(metadata['movement_kind']);
    final expectedRoute =
        '/pharmacy/cath-inventory-reconciliation?case_id=$caseId'
        '&consumable_usage_id=$usageId';
    return taskKind == 'review' &&
        slaCompletionSemantics == 'domain_evidence' &&
        isActionableStatus &&
        _text(metadata['task_contract']) == 'cath_inventory_shortfall_v1' &&
        relatedResourceType == 'cath_case_consumable_usage' &&
        _positiveIntegerPattern.hasMatch(relatedResourceId) &&
        relatedResourceId == usageId &&
        _positiveIntegerPattern.hasMatch(caseId) &&
        _positiveIntegerPattern.hasMatch(inventoryItemId) &&
        (movementKind == 'issue' || movementKind == 'dispose') &&
        domainEvidenceDeepLink == expectedRoute;
  }

  bool get isCounterSaleVoidRefund {
    final taskStage = _text(metadata['task_stage']);
    final requestId = _text(metadata['counter_sale_void_request_id']);
    final saleId = _text(metadata['counter_sale_id']);
    final refundId = _text(metadata['refund_id']);
    final invoiceId = _text(metadata['invoice_id']);
    final expectedAssignedRole = switch (taskStage) {
      'approval' => 'ADMIN',
      'payout' => 'BILLING_INCHARGE',
      'reconciliation' => 'PHARMACY_INCHARGE',
      'rejected_review' => 'ADMIN',
      _ => '',
    };
    final expectedOwnerRoles = switch (taskStage) {
      'approval' => const {'ADMIN', 'SUPER_ADMIN'},
      'payout' => const {
        'FINANCE_INCHARGE',
        'BILLING_INCHARGE',
        'BILLING_STAFF',
        'CASHIER',
      },
      'reconciliation' => const {'ADMIN', 'PHARMACY_INCHARGE'},
      'rejected_review' => const {'ADMIN', 'SUPER_ADMIN', 'PHARMACY_INCHARGE'},
      _ => const <String>{},
    };
    final expectedFinanceRoute =
        '/billing/refunds?refund_id=$refundId&void_request_id=$requestId';
    final expectedPharmacyRoute = '/pharmacy?tab=counter-sales&sale_id=$saleId';

    return taskKind == 'review' &&
        const {'open', 'in_progress', 'blocked', 'overdue'}.contains(status) &&
        slaCompletionSemantics == 'domain_evidence' &&
        hasCounterSaleVoidRefundContract &&
        _text(metadata['evidence_kind']) == 'counter_sale_void_completed' &&
        _text(metadata['sla_key']) == 'counter_sale_void_refund' &&
        _uuidPattern.hasMatch(workflowSlaInstanceId) &&
        _text(metadata['sla_instance_id']) == workflowSlaInstanceId &&
        relatedResourceType == 'pharmacy_counter_sale_void_requests' &&
        _isCanonicalPositiveBigInt(id) &&
        _isCanonicalPositiveBigInt(relatedResourceId) &&
        requestId == relatedResourceId &&
        _isCanonicalPositiveBigInt(saleId) &&
        _isCanonicalPositiveBigInt(refundId) &&
        _isCanonicalPositiveBigInt(invoiceId) &&
        assignedToUid.isEmpty &&
        assignedToRole == expectedAssignedRole &&
        expectedOwnerRoles.isNotEmpty &&
        _hasExactRoleCodes(metadata['owner_role_codes'], expectedOwnerRoles) &&
        _text(metadata['finance_deep_link']) == expectedFinanceRoute &&
        _text(metadata['pharmacy_deep_link']) == expectedPharmacyRoute;
  }

  String? counterSaleVoidRouteForRole(String rawRole) {
    if (!isCounterSaleVoidRefund) return null;
    final role = rawRole.trim().toUpperCase();
    final stage = _text(metadata['task_stage']);
    final permittedRoles = switch (stage) {
      'approval' => const {'ADMIN', 'SUPER_ADMIN'},
      'payout' => const {
        'FINANCE_INCHARGE',
        'BILLING_INCHARGE',
        'BILLING_STAFF',
        'CASHIER',
      },
      'reconciliation' => const {'ADMIN', 'PHARMACY_INCHARGE'},
      'rejected_review' => const {'ADMIN', 'SUPER_ADMIN', 'PHARMACY_INCHARGE'},
      _ => const <String>{},
    };
    if (!permittedRoles.contains(role)) return null;
    if (stage == 'approval' || stage == 'payout') {
      return _text(metadata['finance_deep_link']);
    }
    return _text(metadata['pharmacy_deep_link']);
  }

  String get domainEvidenceRoute => isClinicalAlertDeliveryRecovery
      ? '/clinical-inbox/recovery?case_id=$relatedResourceId'
      : isMarMedicationException
      ? '/mar/due?exception_id=$relatedResourceId'
      : isCathInventoryShortfall
      ? domainEvidenceDeepLink
      : domainEvidenceDeepLink;

  bool get needsRoutedDomainEvidence =>
      isCounterSaleVoidRefund ||
      (slaCompletionSemantics == 'domain_evidence' &&
          isActionableStatus &&
          ((_text(metadata['task_contract']) ==
                      'ward_medication_obligation_v1' &&
                  domainEvidenceDeepLink.isNotEmpty) ||
              isClinicalAlertDeliveryRecovery ||
              isMarMedicationException ||
              isCathInventoryShortfall));

  bool get needsClinicalAction =>
      needsAcknowledgement ||
      needsDoctorAction ||
      needsPostDischargeCrossSign ||
      needsRoutedDomainEvidence;

  bool get isRoleOwned => assignedToUid.isEmpty && assignedToRole.isNotEmpty;

  bool get hasNamedPathwayOwner => pathwayOwnerUid.isNotEmpty;

  bool get isOpInpatientTransferReview =>
      taskKind == 'op_to_inpatient_transfer_review' &&
      relatedResourceType == 'care_handoff_instance' &&
      relatedResourceId.isNotEmpty;

  int? get sourceAppointmentId {
    final raw = metadata['source_appointment_id'];
    if (raw is int) return raw > 0 ? raw : null;
    final parsed = int.tryParse(raw?.toString() ?? '');
    return parsed != null && parsed > 0 ? parsed : null;
  }

  String get sourcePathwayInstanceId =>
      _text(metadata['care_pathway_instance_id']);

  bool isOverdue(DateTime now) {
    if (!needsClinicalAction) return false;
    if (status == 'overdue' || slaBreachedAt != null) return true;
    final due = dueAt;
    return due != null && !due.isAfter(now);
  }

  String get sourceLabel {
    final source = _text(metadata['source']);
    if (source.isNotEmpty) return source.replaceAll('_', ' ');
    if (relatedResourceType.isNotEmpty) {
      return relatedResourceId.isEmpty
          ? relatedResourceType.replaceAll('_', ' ')
          : '${relatedResourceType.replaceAll('_', ' ')} #$relatedResourceId';
    }
    return 'clinical alert';
  }

  String get patientLabel {
    final fromMetadata = _text(
      metadata['patient_name'] ??
          metadata['patient'] ??
          metadata['patient_display_name'],
    );
    if (fromMetadata.isNotEmpty) return fromMetadata;
    return patientUid;
  }

  List<ClinicalInboxEscalation> get escalations {
    final raw = metadata['escalations'];
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map(
          (item) =>
              ClinicalInboxEscalation.fromJson(item.cast<String, dynamic>()),
        )
        .toList(growable: false);
  }

  ClinicalInboxTask copyWith({
    String? status,
    String? assignedToUid,
    String? assignedToRole,
    DateTime? dueAt,
    DateTime? slaBreachedAt,
    Map<String, dynamic>? metadata,
  }) {
    return ClinicalInboxTask(
      id: id,
      taskKind: taskKind,
      title: title,
      description: description,
      patientUid: patientUid,
      priority: priority,
      status: status ?? this.status,
      relatedResourceType: relatedResourceType,
      relatedResourceId: relatedResourceId,
      assignedToUid: assignedToUid ?? this.assignedToUid,
      assignedToRole: assignedToRole ?? this.assignedToRole,
      workflowSlaInstanceId: workflowSlaInstanceId,
      slaCompletionSemantics: slaCompletionSemantics,
      pathwayInstanceId: pathwayInstanceId,
      pathwayKey: pathwayKey,
      pathwayOwnerUid: pathwayOwnerUid,
      pathwayAccountableRole: pathwayAccountableRole,
      pathwayStageKey: pathwayStageKey,
      diagnosticGenerationId: diagnosticGenerationId,
      diagnosticClassification: diagnosticClassification,
      diagnosticGenerationSnapshotSha256: diagnosticGenerationSnapshotSha256,
      diagnosticSourceVersion: diagnosticSourceVersion,
      diagnosticPredecessorGenerationId: diagnosticPredecessorGenerationId,
      diagnosticIsCorrection: diagnosticIsCorrection,
      pendingResultAdmissionId: pendingResultAdmissionId,
      pendingResultHandoffId: pendingResultHandoffId,
      pendingResultOwnerActionId: pendingResultOwnerActionId,
      pendingResultHandoffState: pendingResultHandoffState,
      pendingResultResolutionActionId: pendingResultResolutionActionId,
      diagnosticAuthoritativeActionId: diagnosticAuthoritativeActionId,
      diagnosticAuthoritativeActionKind: diagnosticAuthoritativeActionKind,
      diagnosticAuthoritativeDisposition: diagnosticAuthoritativeDisposition,
      diagnosticAuthoritativeActionOccurredAt:
          diagnosticAuthoritativeActionOccurredAt,
      canCrossSignPendingResult: canCrossSignPendingResult,
      externalRecoveryCriticalReviewObligationId:
          externalRecoveryCriticalReviewObligationId,
      externalRecoveryCriticalReviewAcknowledgementId:
          externalRecoveryCriticalReviewAcknowledgementId,
      externalRecoveryInterfaceFamily: externalRecoveryInterfaceFamily,
      externalRecoveryAwarenessAcknowledgementRequired:
          externalRecoveryAwarenessAcknowledgementRequired,
      externalRecoverySourceOccurredAt: externalRecoverySourceOccurredAt,
      externalRecoveryAwarenessRecordedAt: externalRecoveryAwarenessRecordedAt,
      externalRecoveryAwarenessAcknowledgedAt:
          externalRecoveryAwarenessAcknowledgedAt,
      dueAt: dueAt ?? this.dueAt,
      slaBreachedAt: slaBreachedAt ?? this.slaBreachedAt,
      createdAt: createdAt,
      metadata: metadata ?? this.metadata,
    );
  }
}

Map<String, dynamic> _mapValue(Object? value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return value.cast<String, dynamic>();
  return const {};
}

String _text(Object? value) => value?.toString().trim() ?? '';

String? _nullableText(Object? value) {
  final text = _text(value);
  return text.isEmpty ? null : text;
}

DateTime? _parseDate(Object? value) {
  final text = _text(value);
  if (text.isEmpty) return null;
  return DateTime.tryParse(text)?.toLocal();
}

int? _intValue(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '');
}

final RegExp _positiveIntegerPattern = RegExp(r'^[1-9][0-9]*$');
final RegExp _uuidPattern = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  caseSensitive: false,
);
const String _maximumSignedBigInt = '9223372036854775807';

bool _isCanonicalPositiveBigInt(String value) =>
    _positiveIntegerPattern.hasMatch(value) &&
    value.length <= _maximumSignedBigInt.length &&
    (value.length < _maximumSignedBigInt.length ||
        value.compareTo(_maximumSignedBigInt) <= 0);

bool _hasExactRoleCodes(Object? value, Set<String> expected) {
  if (value is! List || value.length != expected.length) return false;
  if (value.any((role) => role is! String)) return false;
  final roles = value.cast<String>().toSet();
  return roles.length == expected.length && roles.containsAll(expected);
}
