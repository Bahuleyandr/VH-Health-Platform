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
  final DateTime? dueAt;
  final DateTime? slaBreachedAt;
  final DateTime? createdAt;
  final Map<String, dynamic> metadata;

  const ClinicalInboxTask({
    required this.id,
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
    required this.dueAt,
    required this.slaBreachedAt,
    required this.createdAt,
    required this.metadata,
  });

  factory ClinicalInboxTask.fromJson(Map<String, dynamic> json) {
    final metadata = _mapValue(json['metadata']);
    return ClinicalInboxTask(
      id: _text(json['id']),
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

  bool get needsClinicalAction => needsAcknowledgement || needsDoctorAction;

  bool get isRoleOwned => assignedToUid.isEmpty && assignedToRole.isNotEmpty;

  bool get hasNamedPathwayOwner => pathwayOwnerUid.isNotEmpty;

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
