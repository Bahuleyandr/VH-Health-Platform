import 'api_client.dart';

const stemiRequiredSlaRuleCodes = <String>{
  'stemi_door_to_ecg',
  'stemi_door_to_lab',
  'stemi_door_to_balloon',
};

class StemiPathwayApiException implements Exception {
  const StemiPathwayApiException();
}

class StemiSlaClock {
  const StemiSlaClock({
    required this.ruleCode,
    required this.status,
    required this.startedAt,
    required this.dueAt,
    required this.completedAt,
    required this.breachedAt,
    required this.targetsPending,
    required this.clockStartPending,
  });

  final String ruleCode;
  final String status;
  final DateTime? startedAt;
  final DateTime? dueAt;
  final DateTime? completedAt;
  final DateTime? breachedAt;
  final bool targetsPending;
  final bool clockStartPending;

  factory StemiSlaClock.fromJson(Map<String, dynamic> json) {
    final metadata = _asMap(json['metadata']) ?? const <String, dynamic>{};
    return StemiSlaClock(
      ruleCode: _text(json['rule_code']),
      status: _text(json['status']),
      startedAt: _date(json['started_at']),
      dueAt: _date(json['due_at']),
      completedAt: _date(json['completed_at']),
      breachedAt: _date(json['breached_at']),
      targetsPending:
          json['targets_pending'] == true ||
          metadata['targets_pending'] == true,
      clockStartPending:
          json['clock_start_pending'] == true ||
          metadata['clock_start_pending'] == true,
    );
  }

  Duration elapsedAt(DateTime now) {
    final start = startedAt;
    if (start == null) return Duration.zero;
    final end = completedAt ?? now;
    return end.isBefore(start) ? Duration.zero : end.difference(start);
  }
}

class StemiTeamAcknowledgement {
  const StemiTeamAcknowledgement({
    required this.id,
    required this.activationId,
    required this.staffUid,
    required this.staffName,
    required this.roleCode,
    required this.notificationStatus,
    required this.notifiedAt,
    required this.acknowledgedAt,
  });

  final String id;
  final int? activationId;
  final String staffUid;
  final String staffName;
  final String roleCode;
  final String notificationStatus;
  final DateTime? notifiedAt;
  final DateTime? acknowledgedAt;

  bool get isAcknowledged =>
      acknowledgedAt != null || notificationStatus == 'acknowledged';

  factory StemiTeamAcknowledgement.fromJson(Map<String, dynamic> json) {
    return StemiTeamAcknowledgement(
      id: _text(json['id']),
      activationId: _asInt(json['activation_id']),
      staffUid: _text(json['staff_uid']),
      staffName: _text(json['staff_name']),
      roleCode: _text(json['role_code']),
      notificationStatus: _text(
        json['notification_status'],
        fallback: 'pending',
      ),
      notifiedAt: _date(json['notified_at']),
      acknowledgedAt: _date(json['acknowledged_at']),
    );
  }
}

class StemiActivationSummary {
  const StemiActivationSummary({
    required this.id,
    required this.patientUid,
    required this.patientName,
    required this.emergencyVisitId,
    required this.cathLabCaseId,
    required this.activationSource,
    required this.status,
    required this.activatedAt,
    required this.targetsPending,
    required this.slaInstances,
    required this.teamAcknowledgements,
  });

  final int id;
  final String patientUid;
  final String patientName;
  final int? emergencyVisitId;
  final int? cathLabCaseId;
  final String activationSource;
  final String status;
  final DateTime? activatedAt;
  final bool targetsPending;
  final List<StemiSlaClock> slaInstances;
  final List<StemiTeamAcknowledgement> teamAcknowledgements;

  factory StemiActivationSummary.fromJson(Map<String, dynamic> json) {
    final metadata = _asMap(json['metadata']) ?? const <String, dynamic>{};
    final rawSlaInstances = json['sla_instances'];
    final rawAcknowledgements = json['team_acknowledgements'];
    if (rawSlaInstances is! List ||
        rawSlaInstances.any((row) => row is! Map) ||
        rawAcknowledgements is! List ||
        rawAcknowledgements.any((row) => row is! Map)) {
      throw const StemiPathwayApiException();
    }
    final activation = StemiActivationSummary(
      id: _asInt(json['id']) ?? 0,
      patientUid: _text(json['patient_uid']),
      patientName: _text(json['patient_name']),
      emergencyVisitId: _asInt(
        json['emergency_visit_id'] ?? json['ed_visit_id'],
      ),
      cathLabCaseId: _asInt(json['cath_case_id'] ?? json['cath_lab_case_id']),
      activationSource: _text(json['activation_source']),
      status: _text(json['status']),
      activatedAt: _date(json['activated_at']),
      targetsPending:
          json['targets_pending'] == true ||
          metadata['targets_pending'] == true,
      slaInstances: _asList(
        json['sla_instances'],
      ).map(StemiSlaClock.fromJson).toList(growable: false),
      teamAcknowledgements: _asList(
        json['team_acknowledgements'],
      ).map(StemiTeamAcknowledgement.fromJson).toList(growable: false),
    );
    validateStemiActivationSummaries([activation]);
    return activation;
  }

  StemiSlaClock? slaFor(String ruleCode) {
    for (final instance in slaInstances) {
      if (instance.ruleCode == ruleCode) return instance;
    }
    return null;
  }

  StemiTeamAcknowledgement? acknowledgementFor(String? staffUid) {
    final normalized = staffUid?.trim().toLowerCase() ?? '';
    if (normalized.isEmpty) return null;
    for (final acknowledgement in teamAcknowledgements) {
      if (acknowledgement.staffUid.toLowerCase() == normalized) {
        return acknowledgement;
      }
    }
    return null;
  }
}

void validateStemiActivationSummaries(
  List<StemiActivationSummary> activations,
) {
  for (final activation in activations) {
    if (activation.id <= 0 ||
        activation.patientUid.isEmpty ||
        activation.activationSource.isEmpty ||
        activation.status.isEmpty ||
        activation.activatedAt == null) {
      throw const StemiPathwayApiException();
    }

    final ruleCounts = <String, int>{};
    for (final clock in activation.slaInstances) {
      if (clock.ruleCode.isEmpty || clock.status.isEmpty) {
        throw const StemiPathwayApiException();
      }
      ruleCounts.update(
        clock.ruleCode,
        (count) => count + 1,
        ifAbsent: () => 1,
      );
    }
    if (activation.slaInstances.length != stemiRequiredSlaRuleCodes.length ||
        stemiRequiredSlaRuleCodes.any(
          (ruleCode) => ruleCounts[ruleCode] != 1,
        )) {
      throw const StemiPathwayApiException();
    }
  }
}

List<StemiActivationSummary> parseStemiActivationPayload(Object? value) {
  if (value is! Map || value['activations'] is! List) {
    throw const StemiPathwayApiException();
  }
  final rows = value['activations'] as List;
  if (rows.any((row) => row is! Map)) {
    throw const StemiPathwayApiException();
  }
  final activations = rows
      .cast<Map>()
      .map(
        (row) =>
            StemiActivationSummary.fromJson(Map<String, dynamic>.from(row)),
      )
      .toList(growable: false);
  validateStemiActivationSummaries(activations);
  return activations;
}

class StemiPathwayApiService {
  StemiPathwayApiService._();

  static Future<Map<String, dynamic>> createActivation(
    Map<String, dynamic> body,
  ) async {
    final response = await ApiClient.post(
      '/stemi-pathway/activations',
      body: body,
    );
    if (!response.isSuccess) {
      throw const StemiPathwayApiException();
    }
    return response.dataAsMap();
  }

  static Future<List<StemiActivationSummary>> listActiveActivations() async {
    final response = await ApiClient.get(
      '/stemi-pathway/activations',
      queryParameters: const {'active_only': 'true', 'limit': '50'},
    );
    if (!response.isSuccess) {
      throw const StemiPathwayApiException();
    }
    return parseStemiActivationPayload(response.data);
  }

  static Future<Map<String, dynamic>> acknowledgeActivation(int id) async {
    final response = await ApiClient.post(
      '/stemi-pathway/activations/$id/ack',
      body: const {},
    );
    if (!response.isSuccess) {
      throw const StemiPathwayApiException();
    }
    return response.dataAsMap();
  }
}

List<Map<String, dynamic>> _asList(Object? value) {
  if (value is! List) return const [];
  return value
      .whereType<Map>()
      .map((row) => Map<String, dynamic>.from(row))
      .toList(growable: false);
}

Map<String, dynamic>? _asMap(Object? value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return null;
}

int? _asInt(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(_text(value));
}

DateTime? _date(Object? value) {
  final raw = _text(value);
  if (raw.isEmpty) return null;
  return DateTime.tryParse(raw)?.toLocal();
}

String _text(Object? value, {String fallback = ''}) {
  final text = value?.toString().trim() ?? '';
  return text.isEmpty ? fallback : text;
}
