class PatientReferral {
  const PatientReferral({
    required this.id,
    required this.number,
    required this.department,
    required this.status,
    required this.closureStatus,
    required this.summary,
    required this.instructions,
    this.followUpPlan,
    this.appointmentId,
    this.signedAt,
    this.closedAt,
  });

  factory PatientReferral.fromJson(Map<String, dynamic> json) {
    return PatientReferral(
      id: _asInt(json['id']),
      number: _asText(json['referral_number']),
      department: _asText(json['referred_to_department']),
      status: _asText(json['status']),
      closureStatus: _asText(json['closure_status']),
      summary: _asText(json['patient_summary']),
      instructions: _asText(json['patient_instructions']),
      followUpPlan: _nullableText(json['follow_up_plan']),
      appointmentId: json['appointment_id'] == null
          ? null
          : _asInt(json['appointment_id']),
      signedAt: _asDate(json['signed_at']),
      closedAt: _asDate(json['closed_at']),
    );
  }

  final int id;
  final String number;
  final String department;
  final String status;
  final String closureStatus;
  final String summary;
  final String instructions;
  final String? followUpPlan;
  final int? appointmentId;
  final DateTime? signedAt;
  final DateTime? closedAt;
}

int _asInt(dynamic value) => value is int ? value : int.tryParse('$value') ?? 0;

String _asText(dynamic value) => value?.toString().trim() ?? '';

String? _nullableText(dynamic value) {
  final text = _asText(value);
  return text.isEmpty ? null : text;
}

DateTime? _asDate(dynamic value) => DateTime.tryParse(_asText(value));
