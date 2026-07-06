// Data models for the appointments feature — the parsed shapes the Book
// and My-Appointments tabs work with. Extracted from appointments_screen.dart.

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

  bool get isTeleconsult => visitType.trim().toUpperCase() == 'TELE';

  bool get hasTerminalStatus => [
    'cancelled',
    'no_show',
    'completed',
    'rescheduled',
  ].contains(status.toLowerCase());

  bool get isUpcoming {
    final dt = DateTime.tryParse('$date $time');
    return dt != null && dt.isAfter(DateTime.now()) && !hasTerminalStatus;
  }
}
