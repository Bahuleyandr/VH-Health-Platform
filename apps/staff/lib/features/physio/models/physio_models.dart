class PhysioWorklistItem {
  final int? followUpPlanId;
  final int? carePlanId;
  final int? latestAssessmentId;
  final int? latestSessionId;
  final String patientUid;
  final String patientName;
  final String originKind;
  final String sourceKind;
  final String status;
  final String? reason;
  final String? carePlanName;
  final DateTime? dueAt;
  final double? latestOutcomeScore;

  const PhysioWorklistItem({
    required this.followUpPlanId,
    required this.carePlanId,
    required this.latestAssessmentId,
    required this.latestSessionId,
    required this.patientUid,
    required this.patientName,
    required this.originKind,
    required this.sourceKind,
    required this.status,
    required this.reason,
    required this.carePlanName,
    required this.dueAt,
    required this.latestOutcomeScore,
  });

  factory PhysioWorklistItem.fromJson(Map<String, dynamic> json) {
    return PhysioWorklistItem(
      followUpPlanId: _intOrNull(json['follow_up_plan_id']),
      carePlanId: _intOrNull(json['care_plan_id']),
      latestAssessmentId: _intOrNull(json['latest_assessment_id']),
      latestSessionId: _intOrNull(json['latest_session_id']),
      patientUid: json['patient_uid']?.toString() ?? '',
      patientName: json['patient_name']?.toString() ?? '',
      originKind: json['origin_kind']?.toString() ?? 'manual',
      sourceKind: json['source_kind']?.toString() ?? 'follow_up',
      status: json['follow_up_status']?.toString() ?? '',
      reason: json['reason']?.toString(),
      carePlanName: json['care_plan_name']?.toString(),
      dueAt: _dateOrNull(json['due_at']),
      latestOutcomeScore: _doubleOrNull(json['latest_outcome_score']),
    );
  }

  bool get hasPlan => carePlanId != null;
  bool get hasAssessment => latestAssessmentId != null;
}

int? _intOrNull(Object? value) {
  if (value == null) return null;
  if (value is int) return value;
  return int.tryParse(value.toString());
}

double? _doubleOrNull(Object? value) {
  if (value == null) return null;
  if (value is num) return value.toDouble();
  return double.tryParse(value.toString());
}

DateTime? _dateOrNull(Object? value) {
  if (value == null) return null;
  return DateTime.tryParse(value.toString());
}
