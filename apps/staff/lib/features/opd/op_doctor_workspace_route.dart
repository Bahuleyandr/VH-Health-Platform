import '../appointments/models/staff_appointment.dart';

String opDoctorWorkspaceRoute({
  required String patientUid,
  String? patientName,
  int? appointmentId,
  int? patientId,
  String? patientPhone,
  int? doctorId,
  String? doctorName,
  String? department,
  String? reason,
  String? appointmentDate,
  String? appointmentTime,
  String? status,
}) {
  final uid = patientUid.trim();
  if (uid.isEmpty) return '/appointments';
  final query = <String, String>{};
  void add(String key, Object? value) {
    final text = value?.toString().trim() ?? '';
    if (text.isNotEmpty) query[key] = text;
  }

  add('name', patientName);
  add('appointment_id', appointmentId);
  add('patient_id', patientId);
  add('phone', patientPhone);
  add('doctor_id', doctorId);
  add('doctor_name', doctorName);
  add('department', department);
  add('reason', reason);
  add('date', appointmentDate);
  add('time', appointmentTime);
  add('status', status);
  add('context', 'op');

  return Uri(
    path: '/op/doctor-workspace/${Uri.encodeComponent(uid)}',
    queryParameters: query,
  ).toString();
}

String opDoctorWorkspaceRouteFromAppointment(StaffAppointment appointment) {
  return opDoctorWorkspaceRoute(
    patientUid: appointment.patientUid,
    patientName: appointment.patientName,
    appointmentId: appointment.id,
    patientId: appointment.patientId,
    patientPhone: appointment.patientPhone,
    doctorId: appointment.doctorId,
    doctorName: appointment.doctorName,
    department: appointment.department,
    reason: appointment.reason,
    appointmentDate: appointment.appointmentDate,
    appointmentTime: appointment.appointmentTime,
    status: appointment.status,
  );
}

String opDoctorWorkspaceRouteFromMap(
  Map<String, dynamic> appointment, {
  String? fallbackPatientName,
}) {
  final patient = _mapFrom(appointment['patient']);
  final doctor = _mapFrom(appointment['doctor']);
  return opDoctorWorkspaceRoute(
    patientUid: _firstText([
      appointment['patient_uid'],
      appointment['patientUid'],
      patient?['uid'],
      patient?['patient_uid'],
    ]),
    patientName:
        fallbackPatientName ??
        _firstText([
          appointment['patient_name'],
          appointment['patientName'],
          patient?['name'],
          appointment['name'],
          appointment['patient_phone'],
          appointment['phone'],
        ]),
    appointmentId: _intFrom(
      appointment['id'] ??
          appointment['appointment_id'] ??
          appointment['appointmentId'],
    ),
    patientId: _intFrom(
      appointment['patient_id'] ?? appointment['patientId'] ?? patient?['id'],
    ),
    patientPhone: _firstText([
      appointment['patient_phone'],
      appointment['patientPhone'],
      patient?['phone'],
      appointment['phone'],
    ]),
    doctorId: _intFrom(
      appointment['doctor_id'] ??
          appointment['doctorId'] ??
          doctor?['user_id'] ??
          doctor?['userId'] ??
          doctor?['id'],
    ),
    doctorName: _firstText([
      appointment['doctor_name'],
      appointment['doctor_display_name'],
      appointment['doctorName'],
      doctor?['name'],
    ]),
    department: _firstText([
      appointment['department'],
      appointment['appointment_department'],
      appointment['consultant_department'],
      appointment['doctor_department'],
      doctor?['department'],
    ]),
    reason: _firstText([
      appointment['reason'],
      appointment['type'],
      appointment['appointmentType'],
      appointment['visit_type'],
    ]),
    appointmentDate: _firstText([
      appointment['appointment_date'],
      appointment['appointmentDate'],
      appointment['date'],
    ]),
    appointmentTime: _firstText([
      appointment['appointment_time'],
      appointment['time'],
      appointment['scheduledTime'],
      appointment['scheduled_time'],
    ]),
    status: _firstText([appointment['status']]),
  );
}

Map<String, dynamic>? _mapFrom(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return null;
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
  return int.tryParse(value?.toString().trim() ?? '');
}
