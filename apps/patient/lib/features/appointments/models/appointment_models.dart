// Data models for the appointments feature — the parsed shapes the Book
// and My-Appointments tabs work with. Extracted from appointments_screen.dart.

import 'package:vhhealth/core/models/status_enums.dart';

class DeptInfo {
  final int id;
  final String name;
  final List<DoctorInfo> doctors;
  const DeptInfo({required this.id, required this.name, required this.doctors});
}

class DoctorInfo {
  final int id;
  final String name;
  final String? specialization;
  const DoctorInfo({required this.id, required this.name, this.specialization});
}

class AppointmentInfo {
  final int id;
  final String doctorName;
  final String department;
  final String date;
  final String time;
  final String status;
  final String? reason;
  final int? tokenNumber;
  final String? confirmationNotes;
  final bool hasDocuments;
  final String visitType;

  const AppointmentInfo({
    required this.id,
    required this.doctorName,
    required this.department,
    required this.date,
    required this.time,
    required this.status,
    this.reason,
    this.tokenNumber,
    this.confirmationNotes,
    this.hasDocuments = false,
    this.visitType = '',
  });

  factory AppointmentInfo.fromJson(Map<String, dynamic> json) {
    final doctor = json['doctor'];
    final doctorMap = doctor is Map ? doctor : const <String, dynamic>{};
    return AppointmentInfo(
      id: _appointmentInt(json['id']) ?? 0,
      doctorName:
          json['doctor_name']?.toString() ??
          doctorMap['name']?.toString() ??
          'Doctor',
      department:
          json['department_name']?.toString() ??
          json['department']?.toString() ??
          '',
      date: json['appointment_date']?.toString().split('T').first ?? '',
      time: json['appointment_time']?.toString() ?? '',
      status: json['status']?.toString().toLowerCase() ?? 'scheduled',
      reason: json['reason']?.toString(),
      tokenNumber: _appointmentInt(json['token_number']),
      confirmationNotes: json['confirmation_notes']?.toString(),
      hasDocuments: json['has_documents'] == true,
      visitType:
          json['visit_type']?.toString() ?? json['visitType']?.toString() ?? '',
    );
  }

  bool get isTeleconsult => visitType.trim().toUpperCase() == 'TELE';

  /// Fail-closed: an unknown status string parses to null and reads as
  /// non-terminal, matching the previous raw-string behaviour.
  bool get hasTerminalStatus =>
      AppointmentStatus.fromString(status)?.isTerminal ?? false;

  bool get isUpcoming {
    final dt = DateTime.tryParse('$date $time');
    return dt != null && dt.isAfter(DateTime.now()) && !hasTerminalStatus;
  }
}

List<AppointmentInfo> parseAppointmentInfos(Object? responseData) {
  final Object? raw = switch (responseData) {
    List<dynamic> value => value,
    Map<dynamic, dynamic> value => value['appointments'],
    _ => null,
  };
  if (raw is! List) return const [];
  return raw
      .whereType<Map>()
      .map((item) => AppointmentInfo.fromJson(Map<String, dynamic>.from(item)))
      .where((appointment) => appointment.id > 0)
      .toList(growable: false);
}

int? _appointmentInt(Object? value) {
  if (value is int) return value;
  if (value is double) {
    if (!value.isFinite || value != value.truncateToDouble()) return null;
    return value.toInt();
  }
  return int.tryParse(value?.toString() ?? '');
}
