class WhatsNextBundle {
  const WhatsNextBundle({required this.goals, required this.followUps});

  factory WhatsNextBundle.fromJson(Map<String, dynamic> json) {
    return WhatsNextBundle(
      goals: _asList(
        json['goals'],
      ).map(WhatsNextGoal.fromJson).toList(growable: false),
      followUps: _asList(
        json['follow_ups'],
      ).map(WhatsNextFollowUp.fromJson).toList(growable: false),
    );
  }

  final List<WhatsNextGoal> goals;
  final List<WhatsNextFollowUp> followUps;

  bool get isEmpty => goals.isEmpty && followUps.isEmpty;
}

class WhatsNextGoal {
  const WhatsNextGoal({
    required this.id,
    required this.carePlanId,
    required this.carePlanName,
    required this.description,
    required this.priority,
    required this.status,
    this.measurementLabel,
    this.targetValue,
    this.currentValue,
    this.targetDueDate,
  });

  factory WhatsNextGoal.fromJson(Map<String, dynamic> json) {
    return WhatsNextGoal(
      id: _asInt(json['id']),
      carePlanId: _asInt(json['care_plan_id']),
      carePlanName: _asString(json['care_plan_name']),
      description: _asString(json['description']),
      priority: _asString(json['priority']),
      status: _asString(json['status']),
      measurementLabel: _nullableString(json['measurement_label']),
      targetValue: _nullableString(json['target_value']),
      currentValue: _nullableString(json['current_value']),
      targetDueDate: _asDate(json['target_due_date']),
    );
  }

  final int id;
  final int carePlanId;
  final String carePlanName;
  final String description;
  final String priority;
  final String status;
  final String? measurementLabel;
  final String? targetValue;
  final String? currentValue;
  final DateTime? targetDueDate;
}

class WhatsNextFollowUp {
  const WhatsNextFollowUp({
    required this.id,
    required this.carePlanId,
    required this.carePlanName,
    required this.reason,
    required this.status,
    this.dueAt,
    this.appointmentStatus,
  });

  factory WhatsNextFollowUp.fromJson(Map<String, dynamic> json) {
    return WhatsNextFollowUp(
      id: _asInt(json['id']),
      carePlanId: _asInt(json['care_plan_id']),
      carePlanName: _asString(json['care_plan_name']),
      reason: _asString(json['reason']),
      status: _asString(json['status']),
      dueAt: _asDate(json['due_at']),
      appointmentStatus: _nullableString(json['appointment_status']),
    );
  }

  final int id;
  final int carePlanId;
  final String carePlanName;
  final String reason;
  final String status;
  final DateTime? dueAt;
  final String? appointmentStatus;
}

List<Map<String, dynamic>> _asList(dynamic value) {
  if (value is! List) return const [];
  return value
      .whereType<Map>()
      .map((row) {
        return Map<String, dynamic>.from(row);
      })
      .toList(growable: false);
}

int _asInt(dynamic value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '') ?? 0;
}

String _asString(dynamic value) => (value ?? '').toString().trim();

String? _nullableString(dynamic value) {
  final text = _asString(value);
  return text.isEmpty ? null : text;
}

DateTime? _asDate(dynamic value) {
  if (value == null) return null;
  return DateTime.tryParse(value.toString())?.toLocal();
}
