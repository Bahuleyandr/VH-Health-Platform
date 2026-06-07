import 'models/staff_appointment.dart';

const List<String> appointmentCalendarStatusFilters = [
  'all',
  'scheduled',
  'confirmed',
  'completed',
  'rescheduled',
  'no_show',
  'cancelled',
];

String appointmentStatusFilterLabel(String status) =>
    status.replaceAll('_', ' ').toUpperCase();

DateTime _dateOnly(DateTime value) =>
    DateTime(value.year, value.month, value.day);

DateTime appointmentWeekStart(DateTime value) {
  final day = _dateOnly(value);
  return day.subtract(Duration(days: day.weekday - DateTime.monday));
}

int? appointmentMinuteOfDayFromText(String value) {
  final raw = value.trim();
  if (raw.isEmpty) return null;
  if (raw.toLowerCase() == 'walk-in') return null;

  final timeMatch = RegExp(
    r'^(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])?$',
  ).firstMatch(raw);
  if (timeMatch == null) return null;

  var hour = int.tryParse(timeMatch.group(1) ?? '');
  final minute = int.tryParse(timeMatch.group(2) ?? '0');
  final suffix = timeMatch.group(3)?.toUpperCase();
  if (hour == null || minute == null || minute > 59) return null;
  if (suffix != null) {
    if (hour < 1 || hour > 12) return null;
    if (suffix == 'PM' && hour != 12) hour += 12;
    if (suffix == 'AM' && hour == 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  return hour * 60 + minute;
}

bool appointmentMatchesCalendarFilters(
  StaffAppointment appointment, {
  String patientQuery = '',
  String doctorDepartmentQuery = '',
}) {
  return appointment.matchesPatientIdentity(patientQuery) &&
      appointment.matchesDoctorOrDepartment(doctorDepartmentQuery);
}

List<String> appointmentDoctorDepartmentFilterOptions(
  Iterable<StaffAppointment> appointments,
  String query, {
  int limit = 30,
}) {
  final q = query.trim().toLowerCase();
  final byKey = <String, String>{};

  void addOption(String? value) {
    final text = value?.trim() ?? '';
    if (text.isEmpty) return;
    final key = text.toLowerCase();
    byKey.putIfAbsent(key, () => text);
  }

  for (final appointment in appointments) {
    addOption(appointment.doctorName);
    addOption(appointment.department);
    addOption(appointment.raw['doctor_display_name']?.toString());
    addOption(appointment.raw['doctor_name_detail']?.toString());
    addOption(appointment.raw['appointment_department']?.toString());
    addOption(appointment.raw['consultant_department']?.toString());
    addOption(appointment.raw['doctor_department']?.toString());
  }

  final options = byKey.values
      .where((option) => q.isEmpty || option.toLowerCase().contains(q))
      .toList(growable: false);
  final sorted = options.toList()
    ..sort((a, b) => a.toLowerCase().compareTo(b.toLowerCase()));
  return sorted.take(limit).toList(growable: false);
}

Map<String, List<StaffAppointment>> appointmentSlotGroups(
  Iterable<StaffAppointment> appointments,
) {
  final groups = <String, List<StaffAppointment>>{};
  for (final appointment in appointments) {
    final slot = appointment.appointmentTime.trim().isEmpty
        ? 'Unscheduled'
        : appointment.appointmentTime.trim();
    groups.putIfAbsent(slot, () => <StaffAppointment>[]).add(appointment);
  }
  final entries = groups.entries.toList()
    ..sort((a, b) {
      if (a.key == 'Unscheduled') return 1;
      if (b.key == 'Unscheduled') return -1;
      return a.key.compareTo(b.key);
    });
  return Map.fromEntries(entries);
}
