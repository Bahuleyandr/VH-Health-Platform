import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/appointments/models/staff_appointment.dart';
import 'package:vhhealth_staff/features/appointments/screens/appointments_screen.dart';

void main() {
  group('appointmentSlotGroups', () {
    test('groups appointments by timing slot and keeps unscheduled last', () {
      final appointments = StaffAppointment.listFrom([
        {
          'id': 1,
          'patient_name': 'Ravi Kumar',
          'doctor_name': 'Dr Asha Rao',
          'appointment_time': '10:30',
        },
        {
          'id': 2,
          'patient_name': 'Priya Iyer',
          'doctor_name': 'Dr Asha Rao',
          'appointment_time': '09:00',
        },
        {
          'id': 3,
          'patient_name': 'Anita Menon',
          'doctor_name': 'Dr Imran Shah',
          'appointment_time': '10:30',
        },
        {
          'id': 4,
          'patient_name': 'Walk-in Patient',
          'doctor_name': 'Dr Meera Das',
          'appointment_time': '',
        },
      ]);

      final groups = appointmentSlotGroups(appointments);

      expect(groups.keys.toList(), ['09:00', '10:30', 'Unscheduled']);
      expect(groups['09:00']!.map((a) => a.patientName), ['Priya Iyer']);
      expect(groups['10:30']!.map((a) => a.patientName), [
        'Ravi Kumar',
        'Anita Menon',
      ]);
      expect(groups['Unscheduled']!.single.patientName, 'Walk-in Patient');
    });
  });

  group('StaffAppointment search', () {
    test('matches patient, doctor, department, and reason text', () {
      final appointment = StaffAppointment.fromJson({
        'patient_name': 'Saraswati Raman',
        'patient_phone': '9876543210',
        'doctor_name': 'Dr Kiran Shah',
        'department': 'Cardiology',
        'reason': 'Follow up',
      });

      expect(appointment.matchesPatientSearch('saraswati'), isTrue);
      expect(appointment.matchesPatientSearch('9876'), isTrue);
      expect(appointment.matchesPatientSearch('kiran'), isTrue);
      expect(appointment.matchesPatientSearch('cardio'), isTrue);
      expect(appointment.matchesPatientSearch('follow'), isTrue);
      expect(appointment.matchesPatientSearch('orthopaedics'), isFalse);
    });
  });
}
