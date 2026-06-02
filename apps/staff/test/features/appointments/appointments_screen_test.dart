import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/appointments/models/staff_appointment.dart';
import 'package:vhhealth_staff/features/appointments/screens/appointments_screen.dart';

void main() {
  group('appointment calendar helpers', () {
    test('uses Monday as the start of the displayed week', () {
      expect(appointmentWeekStart(DateTime(2026, 6, 2)), DateTime(2026, 6, 1));
      expect(appointmentWeekStart(DateTime(2026, 6, 7)), DateTime(2026, 6, 1));
      expect(appointmentWeekStart(DateTime(2026, 6, 8)), DateTime(2026, 6, 8));
    });

    test('parses 24-hour and AM/PM appointment times', () {
      expect(appointmentMinuteOfDayFromText('09:30'), 570);
      expect(appointmentMinuteOfDayFromText('5 PM'), 1020);
      expect(appointmentMinuteOfDayFromText('5:30 pm'), 1050);
      expect(appointmentMinuteOfDayFromText('12:15 AM'), 15);
      expect(appointmentMinuteOfDayFromText('Walk-in'), isNull);
      expect(appointmentMinuteOfDayFromText('not a time'), isNull);
    });
  });

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

    test(
      'calendar filters can isolate queued patients by doctor or department',
      () {
        final cardiology = StaffAppointment.fromJson({
          'patient_name': 'Saraswati Raman',
          'patient_phone': '9876543210',
          'doctor_name': 'Dr Kiran Shah',
          'department': 'Cardiology',
          'reason': 'Follow up',
        });
        final orthopaedics = StaffAppointment.fromJson({
          'patient_name': 'Priya Iyer',
          'patient_phone': '9123456780',
          'doctor_name': 'Dr Meera Nair',
          'department': 'Orthopaedics',
          'reason': 'Knee pain',
        });

        expect(
          appointmentMatchesCalendarFilters(
            cardiology,
            doctorDepartmentQuery: 'kiran',
          ),
          isTrue,
        );
        expect(
          appointmentMatchesCalendarFilters(
            orthopaedics,
            doctorDepartmentQuery: 'kiran',
          ),
          isFalse,
        );
        expect(
          appointmentMatchesCalendarFilters(
            cardiology,
            doctorDepartmentQuery: 'cardio',
          ),
          isTrue,
        );
        expect(
          appointmentMatchesCalendarFilters(
            orthopaedics,
            doctorDepartmentQuery: 'cardio',
          ),
          isFalse,
        );
        expect(
          appointmentMatchesCalendarFilters(
            cardiology,
            patientQuery: 'saraswati',
            doctorDepartmentQuery: 'cardio',
          ),
          isTrue,
        );
        expect(
          appointmentMatchesCalendarFilters(
            cardiology,
            patientQuery: 'priya',
            doctorDepartmentQuery: 'cardio',
          ),
          isFalse,
        );
      },
    );

    test(
      'doctor and department aliases from appointment API rows are searchable',
      () {
        final appointment = StaffAppointment.fromJson({
          'patient_name': 'Alias Patient',
          'doctor_name_detail': 'Dr Alias Consultant',
          'appointment_department': 'ENT',
          'consultant_department': 'General Medicine',
          'doctor_department': 'Internal Medicine',
        });

        expect(
          appointment.matchesDoctorOrDepartment('alias consultant'),
          isTrue,
        );
        expect(appointment.matchesDoctorOrDepartment('ent'), isTrue);
        expect(appointment.matchesDoctorOrDepartment('general med'), isTrue);
        expect(appointment.matchesDoctorOrDepartment('internal'), isTrue);
        expect(appointment.matchesDoctorOrDepartment('cardiology'), isFalse);
      },
    );
  });
}
