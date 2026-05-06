class StaffAppointment {
  final Map<String, dynamic> raw;
  final int? id;
  final int? patientId;
  final int? doctorId;
  final String patientName;
  final String patientPhone;
  final String doctorName;
  final String department;
  final String reason;
  final String status;
  final String appointmentDate;
  final String appointmentTime;
  final String tokenNumber;
  final double minutesSinceBooking;
  final bool slaBreached;

  const StaffAppointment._({
    required this.raw,
    required this.id,
    required this.patientId,
    required this.doctorId,
    required this.patientName,
    required this.patientPhone,
    required this.doctorName,
    required this.department,
    required this.reason,
    required this.status,
    required this.appointmentDate,
    required this.appointmentTime,
    required this.tokenNumber,
    required this.minutesSinceBooking,
    required this.slaBreached,
  });

  factory StaffAppointment.fromJson(Map<String, dynamic> json) {
    final patient = _mapFrom(json['patient']);
    final doctor = _mapFrom(json['doctor']);
    final profile = _firstMapFrom(doctor?['doctors']);
    final date = _firstText([
      json['appointment_date'],
      json['appointmentDate'],
      json['dateTime'],
      json['date_time'],
      json['date'],
    ]);
    final patientName = _firstText([
      json['patient_name'],
      json['patientName'],
      patient?['name'],
      json['name'],
      json['patient_phone'],
      json['phone'],
    ]);
    final doctorName = _firstText([
      json['doctor_name'],
      json['doctor_display_name'],
      json['doctorName'],
      doctor?['name'],
    ]);

    return StaffAppointment._(
      raw: Map<String, dynamic>.from(json),
      id: _intFrom(json['id'] ?? json['_id']),
      patientId: _intFrom(json['patient_id'] ?? json['patientId']),
      doctorId: _intFrom(json['doctor_id'] ?? json['doctorId']),
      patientName: patientName.isEmpty ? 'Unknown Patient' : patientName,
      patientPhone: _firstText([
        json['patient_phone'],
        patient?['phone'],
        json['phone'],
      ]),
      doctorName: doctorName,
      department: _firstText([
        json['department'],
        json['doctor_department'],
        doctor?['department'],
        profile?['department'],
      ]),
      reason: _firstText([
        json['reason'],
        json['type'],
        json['appointmentType'],
      ]),
      status: _firstText([json['status']]).isEmpty
          ? 'SCHEDULED'
          : _firstText([json['status']]).toUpperCase(),
      appointmentDate: date.contains('T') ? date.split('T').first : date,
      appointmentTime: _firstText([json['appointment_time'], json['time']]),
      tokenNumber: _firstText([json['token_number'], json['tokenNumber']]),
      minutesSinceBooking: _doubleFrom(json['minutes_since_booking']),
      slaBreached: _boolFrom(json['sla_breached']),
    );
  }

  static List<StaffAppointment> listFrom(dynamic value) {
    if (value is Map) {
      final map = Map<String, dynamic>.from(value);
      return listFrom(
        map['appointments'] ?? map['pending'] ?? map['queue'] ?? map['data'],
      );
    }
    if (value is List) {
      return value
          .whereType<Map>()
          .map(
            (item) =>
                StaffAppointment.fromJson(Map<String, dynamic>.from(item)),
          )
          .toList();
    }
    return const [];
  }

  bool get isScheduled => status.toUpperCase() == 'SCHEDULED';

  String get reasonLabel => reason.isEmpty ? '-' : reason;

  String get scheduledLabel => [
    if (appointmentDate.isNotEmpty) appointmentDate,
    if (appointmentTime.isNotEmpty) appointmentTime,
  ].join(' ');

  String waitingLabel() {
    if (minutesSinceBooking < 60) {
      return '${minutesSinceBooking.toInt()} min ago';
    }
    return '${(minutesSinceBooking / 60).toStringAsFixed(1)}h ago';
  }

  bool matchesPatientSearch(String query) {
    final q = query.trim().toLowerCase();
    if (q.isEmpty) return true;
    return patientName.toLowerCase().contains(q) ||
        patientPhone.toLowerCase().contains(q);
  }
}

Map<String, dynamic>? _mapFrom(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return null;
}

Map<String, dynamic>? _firstMapFrom(dynamic value) {
  if (value is List && value.isNotEmpty) return _mapFrom(value.first);
  return _mapFrom(value);
}

String _firstText(Iterable<dynamic> values) {
  for (final value in values) {
    final text = value?.toString().trim() ?? '';
    if (text.isNotEmpty) return text;
  }
  return '';
}

int? _intFrom(dynamic value) {
  if (value is int) return value;
  return int.tryParse(value?.toString() ?? '');
}

double _doubleFrom(dynamic value) {
  if (value is num) return value.toDouble();
  return double.tryParse(value?.toString() ?? '') ?? 0;
}

bool _boolFrom(dynamic value) {
  if (value is bool) return value;
  return value?.toString().toLowerCase() == 'true';
}
