import 'package:flutter/foundation.dart';

import '../services/staff_teleconsult_repository.dart';
import '../services/staff_teleconsult_room_client.dart';

@immutable
class StaffTeleconsultAppointmentContext {
  const StaffTeleconsultAppointmentContext({
    required this.appointmentId,
    this.teleconsultationId,
    this.patientUid = '',
    this.patientName = '',
    this.patientId,
    this.doctorId,
    this.doctorName = '',
    this.department = '',
    this.reason = '',
    this.appointmentDate = '',
    this.appointmentTime = '',
    this.status = '',
  });

  factory StaffTeleconsultAppointmentContext.fromQuery(
    int appointmentId,
    Map<String, String> query,
  ) {
    return StaffTeleconsultAppointmentContext(
      appointmentId: appointmentId,
      teleconsultationId: _intFrom(query['teleconsultation_id']),
      patientUid: query['patient_uid'] ?? '',
      patientName: query['name'] ?? '',
      patientId: _intFrom(query['patient_id']),
      doctorId: _intFrom(query['doctor_id']),
      doctorName: query['doctor_name'] ?? '',
      department: query['department'] ?? '',
      reason: query['reason'] ?? '',
      appointmentDate: query['appointment_date'] ?? '',
      appointmentTime: query['appointment_time'] ?? '',
      status: query['status'] ?? '',
    );
  }

  final int appointmentId;
  final int? teleconsultationId;
  final String patientUid;
  final String patientName;
  final int? patientId;
  final int? doctorId;
  final String doctorName;
  final String department;
  final String reason;
  final String appointmentDate;
  final String appointmentTime;
  final String status;

  StaffTeleconsultAppointmentContext copyWith({
    int? teleconsultationId,
    String? patientUid,
    String? patientName,
    int? patientId,
    int? doctorId,
    String? doctorName,
    String? department,
    String? reason,
    String? appointmentDate,
    String? appointmentTime,
    String? status,
  }) {
    return StaffTeleconsultAppointmentContext(
      appointmentId: appointmentId,
      teleconsultationId: teleconsultationId ?? this.teleconsultationId,
      patientUid: patientUid ?? this.patientUid,
      patientName: patientName ?? this.patientName,
      patientId: patientId ?? this.patientId,
      doctorId: doctorId ?? this.doctorId,
      doctorName: doctorName ?? this.doctorName,
      department: department ?? this.department,
      reason: reason ?? this.reason,
      appointmentDate: appointmentDate ?? this.appointmentDate,
      appointmentTime: appointmentTime ?? this.appointmentTime,
      status: status ?? this.status,
    );
  }

  String consultRoute() {
    final query = <String, String>{};
    void add(String key, Object? value) {
      final text = value?.toString().trim() ?? '';
      if (text.isNotEmpty) query[key] = text;
    }

    add('teleconsultation_id', teleconsultationId);
    add('patient_uid', patientUid);
    add('name', patientName);
    add('patient_id', patientId);
    add('doctor_id', doctorId);
    add('doctor_name', doctorName);
    add('department', department);
    add('reason', reason);
    add('appointment_date', appointmentDate);
    add('appointment_time', appointmentTime);
    add('status', status);
    return Uri(
      path: '/teleconsult/appointments/$appointmentId/consult',
      queryParameters: query.isEmpty ? null : query,
    ).toString();
  }

  String opNoteRoute() {
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
    add('doctor_id', doctorId);
    add('doctor_name', doctorName);
    add('department', department);
    add('reason', reason);
    add('appointment_date', appointmentDate);
    add('appointment_time', appointmentTime);
    add('status', status);
    add('context', 'op');
    add('note_type', 'op_consultation');

    return Uri(
      path: '/emr/notes/${Uri.encodeComponent(uid)}',
      queryParameters: query,
    ).toString();
  }

  Map<String, dynamic> prescriptionContext() {
    return {
      'id': appointmentId,
      if (patientId != null) 'patient_id': patientId,
      if (patientUid.trim().isNotEmpty) 'patient_uid': patientUid.trim(),
      if (patientName.trim().isNotEmpty) 'patient_name': patientName.trim(),
      if (doctorId != null) 'doctor_id': doctorId,
      if (doctorName.trim().isNotEmpty) 'doctor_name': doctorName.trim(),
      if (department.trim().isNotEmpty) 'department': department.trim(),
      if (appointmentDate.trim().isNotEmpty)
        'appointment_date': appointmentDate.trim(),
      if (appointmentTime.trim().isNotEmpty)
        'appointment_time': appointmentTime.trim(),
    };
  }
}

class StaffTeleconsultRouteArgs {
  const StaffTeleconsultRouteArgs({
    required this.appointment,
    this.repository,
    this.roomClient,
  });

  final StaffTeleconsultAppointmentContext appointment;
  final StaffTeleconsultRepository? repository;
  final StaffTeleconsultRoomClient? roomClient;
}

int? _intFrom(Object? value) {
  if (value == null) return null;
  if (value is int) return value;
  return int.tryParse(value.toString().trim());
}
