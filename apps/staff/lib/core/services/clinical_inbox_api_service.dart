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

  Future<ClinicalInboxTask> claimTask(String id) {
    throw UnimplementedError('Task claiming is not implemented');
  }

  Future<DiagnosticActionReceipt> recordDiagnosticAction(
    DiagnosticActionCommand command,
  ) {
    throw UnimplementedError('Diagnostic actions are not implemented');
  }

  Future<PostDischargeCrossSignReceipt> crossSignPendingResult(
    PostDischargeCrossSignCommand command,
  ) {
    throw UnimplementedError(
      'Post-discharge pending-result cross-sign is not implemented',
    );
  }

  Future<DiagnosticActionReceipt> reopenDiagnosticResult({
    required String generationId,
    required String reason,
  }) {
    throw UnimplementedError('Diagnostic result reopen is not implemented');
  }
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
      generationSnapshotSha256: _text(
        json['generation_snapshot_sha256'],
      ).toLowerCase(),
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
      slaCompletionSemantics: _text(
        json['sla_completion_semantics'],
      ).toLowerCase(),
      pathwayInstanceId: _text(json['pathway_instance_id']),
      pathwayKey: _text(json['pathway_key']),
      pathwayOwnerUid: _text(json['pathway_owner_uid']),
      pathwayAccountableRole: _text(json['pathway_accountable_role']),
      pathwayStageKey: _text(json['pathway_stage_key']),
      diagnosticGenerationId: _text(json['diagnostic_generation_id']),
      diagnosticClassification: _text(
        json['diagnostic_classification'],
      ).toLowerCase(),
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
      pendingResultHandoffState: _text(
        json['pending_result_handoff_state'],
      ).toLowerCase(),
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
      dueAt: _parseDate(json['due_at']),
      slaBreachedAt: _parseDate(json['sla_breached_at']),
      createdAt: _parseDate(json['created_at']),
      metadata: metadata,
    );
  }

  bool get isActionableStatus =>
      status == 'open' || status == 'in_progress' || status == 'overdue';

  bool get needsAcknowledgement =>
      slaCompletionSemantics == 'acknowledgement' &&
      (status == 'open' || status == 'overdue');

  bool get needsDoctorAction =>
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

  bool get needsClinicalAction =>
      needsAcknowledgement || needsDoctorAction || needsPostDischargeCrossSign;

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
