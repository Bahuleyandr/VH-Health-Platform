import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/appointments/models/staff_appointment.dart';
import 'package:vhhealth_staff/features/opd/op_doctor_workspace_route.dart';

void main() {
  group('opDoctorWorkspaceRoute', () {
    test('builds a patient-specific OP doctor workspace route', () {
      final route = opDoctorWorkspaceRoute(
        patientUid: 'patient-uid-1',
        patientName: 'OP Doctor Flow Test',
        appointmentId: 371,
        patientId: 42,
        doctorId: 1004,
        doctorName: 'Dr Test',
        department: 'General Medicine',
        reason: 'follow up',
        appointmentDate: '2026-06-05',
        appointmentTime: '17:45',
        status: 'CONFIRMED',
      );

      final uri = Uri.parse(route);
      expect(uri.path, '/op/doctor-workspace/patient-uid-1');
      expect(uri.queryParameters['name'], 'OP Doctor Flow Test');
      expect(uri.queryParameters['appointment_id'], '371');
      expect(uri.queryParameters['patient_id'], '42');
      expect(uri.queryParameters['doctor_id'], '1004');
      expect(uri.queryParameters['department'], 'General Medicine');
      expect(uri.queryParameters['context'], 'op');
    });

    test('preserves nested appointment identity for prescription prefill', () {
      final appointment = StaffAppointment.fromJson({
        'id': 371,
        'patient_name': 'Nested Patient',
        'patient': {'id': 42, 'uid': 'nested-patient-uid'},
        'doctor': {
          'user_id': 1004,
          'name': 'Dr Nested',
          'department': 'Cardiology',
        },
        'appointment_date': '2026-06-05',
        'appointment_time': '17:45',
        'status': 'confirmed',
      });

      expect(appointment.patientId, 42);
      expect(appointment.doctorId, 1004);

      final uri = Uri.parse(opDoctorWorkspaceRouteFromAppointment(appointment));
      expect(uri.path, '/op/doctor-workspace/nested-patient-uid');
      expect(uri.queryParameters['patient_id'], '42');
      expect(uri.queryParameters['doctor_id'], '1004');
      expect(uri.queryParameters['doctor_name'], 'Dr Nested');
      expect(uri.queryParameters['department'], 'Cardiology');
    });

    test('maps dashboard appointment rows into the same workspace route', () {
      final route = opDoctorWorkspaceRouteFromMap({
        'appointment_id': '55',
        'patient': {'id': '12', 'patient_uid': 'dash-uid'},
        'doctor_id': '1004',
        'doctor_display_name': 'Dr Dashboard',
        'appointment_department': 'ENT',
        'reason': 'review',
      }, fallbackPatientName: 'Dashboard Patient');

      final uri = Uri.parse(route);
      expect(uri.path, '/op/doctor-workspace/dash-uid');
      expect(uri.queryParameters['name'], 'Dashboard Patient');
      expect(uri.queryParameters['appointment_id'], '55');
      expect(uri.queryParameters['patient_id'], '12');
      expect(uri.queryParameters['doctor_id'], '1004');
      expect(uri.queryParameters['department'], 'ENT');
    });
  });
}
