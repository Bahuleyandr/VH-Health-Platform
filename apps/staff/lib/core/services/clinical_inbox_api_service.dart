import 'api_client.dart';

class ClinicalInboxResult {
  final List<ClinicalInboxTask> tasks;
  final int count;

  const ClinicalInboxResult({required this.tasks, required this.count});
}

abstract class ClinicalInboxApi {
  const ClinicalInboxApi();

  Future<ClinicalInboxResult> listInboxTasks({int limit = 100});

  Future<ClinicalInboxTask> acknowledgeTask(String id);
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
  Future<ClinicalInboxTask> acknowledgeTask(String id) async {
    final resp = await ApiClient.post(
      '/clinical-inbox/tasks/$id/acknowledge',
      body: const {},
    );
    if (!resp.isSuccess) {
      throw Exception(resp.failureMessage('Could not acknowledge task'));
    }
    final data = resp.dataAsMap();
    return ClinicalInboxTask.fromJson(data);
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
  final String assignedToRole;
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
    required this.assignedToRole,
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
      assignedToRole: _text(json['assigned_to_role']),
      dueAt: _parseDate(json['due_at']),
      slaBreachedAt: _parseDate(json['sla_breached_at']),
      createdAt: _parseDate(json['created_at']),
      metadata: metadata,
    );
  }

  bool get needsAcknowledgement => status == 'open' || status == 'overdue';

  bool isOverdue(DateTime now) {
    if (!needsAcknowledgement) return false;
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
      assignedToRole: assignedToRole,
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
