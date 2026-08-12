import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/features/appointments/models/staff_appointment.dart';
import 'package:vhhealth_staff/features/appointments/screens/appointments_screen.dart';

void main() {
  Future<void> pumpAppointments(
    WidgetTester tester, {
    required AppointmentsLoader loadAppointments,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1200, 1000);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);

    final router = GoRouter(
      routes: [
        GoRoute(
          path: '/',
          builder: (_, _) => AppointmentsScreen(
            initialDate: DateTime(2026, 8, 11),
            loadAppointments: loadAppointments,
            loadRole: () async => 'RECEPTIONIST',
            autoRefresh: false,
          ),
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(
      ChangeNotifierProvider(
        create: (_) => ThemeProvider(),
        child: MaterialApp.router(
          routerConfig: router,
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: const TextScaler.linear(0.9)),
            child: child!,
          ),
        ),
      ),
    );
    await tester.pump();
  }

  testWidgets(
    'a stale appointment refresh cannot overwrite a newer calendar result',
    (tester) async {
      final firstSelectedDay = Completer<Map<String, dynamic>>();
      var calls = 0;
      Future<Map<String, dynamic>> loader({
        String? doctorId,
        required String date,
        String? status,
        required int page,
        required int limit,
      }) async {
        calls += 1;
        if (calls <= 7) {
          return date == '2026-08-11'
              ? firstSelectedDay.future
              : {'appointments': <dynamic>[]};
        }
        return {
          'appointments': date == '2026-08-11'
              ? [
                  {
                    'id': 2,
                    'patient_name': 'New Calendar Patient',
                    'appointment_date': date,
                    'appointment_time': '09:30',
                  },
                ]
              : <dynamic>[],
        };
      }

      await pumpAppointments(tester, loadAppointments: loader);
      final refresh = tester.widget<RefreshIndicator>(
        find.byType(RefreshIndicator),
      );
      await refresh.onRefresh();
      await tester.pump();
      expect(find.text('New Calendar Patient'), findsWidgets);

      firstSelectedDay.complete({
        'appointments': [
          {
            'id': 1,
            'patient_name': 'Old Calendar Patient',
            'appointment_date': '2026-08-11',
            'appointment_time': '08:00',
          },
        ],
      });
      await tester.pump();
      await tester.pump();

      expect(find.text('New Calendar Patient'), findsWidgets);
      expect(find.text('Old Calendar Patient'), findsNothing);
    },
  );

  testWidgets('a transient refresh failure retains last-known appointments', (
    tester,
  ) async {
    var generation = 0;
    Future<Map<String, dynamic>> loader({
      String? doctorId,
      required String date,
      String? status,
      required int page,
      required int limit,
    }) async {
      final callGeneration = generation;
      if (callGeneration > 0) throw Exception('temporary outage');
      return {
        'appointments': date == '2026-08-11'
            ? [
                {
                  'id': 3,
                  'patient_name': 'Last Known Calendar Patient',
                  'appointment_date': date,
                  'appointment_time': '10:00',
                },
              ]
            : <dynamic>[],
      };
    }

    await pumpAppointments(tester, loadAppointments: loader);
    await tester.pump();
    expect(find.text('Last Known Calendar Patient'), findsWidgets);

    generation += 1;
    final refresh = tester.widget<RefreshIndicator>(
      find.byType(RefreshIndicator),
    );
    await refresh.onRefresh();
    await tester.pump();

    expect(find.text('Last Known Calendar Patient'), findsWidgets);
    expect(
      find.byKey(const Key('appointments-stale-data-banner')),
      findsOneWidget,
    );
    final book = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, 'Book OP'),
    );
    expect(book.onPressed, isNull);

    generation = 0;
    await refresh.onRefresh();
    await tester.pump();

    expect(
      find.byKey(const Key('appointments-stale-data-banner')),
      findsNothing,
    );
    final refreshedBook = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, 'Book OP'),
    );
    expect(refreshedBook.onPressed, isNotNull);
  });

  group('appointment calendar helpers', () {
    test('patient lookup results are bound to the edited phone generation', () {
      expect(
        appointmentPatientLookupResultIsCurrent(
          capturedGeneration: 4,
          currentGeneration: 4,
          capturedPhone: '+91 98765 43210',
          currentPhone: '9876543210',
        ),
        isTrue,
      );
      expect(
        appointmentPatientLookupResultIsCurrent(
          capturedGeneration: 4,
          currentGeneration: 5,
          capturedPhone: '9876543210',
          currentPhone: '9123456780',
        ),
        isFalse,
      );
    });

    test('booking fails closed until the current phone lookup completes', () {
      expect(
        appointmentPatientLookupCanSubmit(
          currentPhone: '9876543210',
          verifiedPhone: null,
          lookupBusy: true,
          lookupFailed: false,
        ),
        isFalse,
      );
      expect(
        appointmentPatientLookupCanSubmit(
          currentPhone: '9876543210',
          verifiedPhone: null,
          lookupBusy: false,
          lookupFailed: true,
        ),
        isFalse,
      );
      expect(
        appointmentPatientLookupCanSubmit(
          currentPhone: '9123456780',
          verifiedPhone: '9876543210',
          lookupBusy: false,
          lookupFailed: false,
        ),
        isFalse,
      );
      expect(
        appointmentPatientLookupCanSubmit(
          currentPhone: '+91 98765 43210',
          verifiedPhone: '9876543210',
          lookupBusy: false,
          lookupFailed: false,
        ),
        isTrue,
      );
    });

    test(
      'status filters include rescheduled visits for same-day traceability',
      () {
        expect(appointmentCalendarStatusFilters, [
          'all',
          'scheduled',
          'confirmed',
          'completed',
          'rescheduled',
          'no_show',
          'cancelled',
        ]);
        expect(appointmentStatusFilterLabel('rescheduled'), 'RESCHEDULED');
        expect(appointmentStatusFilterLabel('no_show'), 'NO SHOW');
      },
    );

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

    test('reschedule affordance is active only for non-terminal statuses', () {
      expect(appointmentCanReschedule('SCHEDULED'), isTrue);
      expect(appointmentCanReschedule('confirmed'), isTrue);
      expect(appointmentCanReschedule('pending'), isTrue);
      expect(appointmentCanReschedule('COMPLETED'), isFalse);
      expect(appointmentCanReschedule('CANCELLED'), isFalse);
      expect(appointmentCanReschedule('NO_SHOW'), isFalse);
      expect(appointmentCanReschedule('RESCHEDULED'), isFalse);
    });

    testWidgets('staff reschedule dialog captures date, time, and note', (
      tester,
    ) async {
      StaffAppointmentRescheduleRequest? result;

      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                result = await showDialog<StaffAppointmentRescheduleRequest>(
                  context: context,
                  builder: (_) => StaffAppointmentRescheduleDialog(
                    patientName: 'Ravi Kumar',
                    initialDate: DateTime(2026, 7, 10),
                    initialTime: const TimeOfDay(hour: 9, minute: 30),
                    firstDate: DateTime(2026, 7, 1),
                  ),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      );

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('Reschedule appointment'), findsOneWidget);
      expect(find.text('Ravi Kumar'), findsOneWidget);
      expect(find.text('10 Jul 2026'), findsOneWidget);
      expect(find.text('9:30 AM'), findsOneWidget);

      await tester.enterText(
        find.byType(TextField),
        'Patient asked for a later slot',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Reschedule'));
      await tester.pumpAndSettle();

      expect(result, isNotNull);
      expect(result!.appointmentDate, DateTime(2026, 7, 10));
      expect(result!.appointmentTime, const TimeOfDay(hour: 9, minute: 30));
      expect(result!.notes, 'Patient asked for a later slot');
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

      final groups = appointmentSlotGroups(
        appointments,
        unscheduledLabel: 'Unscheduled',
      );

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

    test('doctor/department typeahead options filter as the user types', () {
      final appointments = [
        StaffAppointment.fromJson({
          'patient_name': 'Cardiology Patient',
          'doctor_name': 'Dr Kiran Shah',
          'department': 'Cardiology',
        }),
        StaffAppointment.fromJson({
          'patient_name': 'Ortho Patient',
          'doctor_name': 'Dr Meera Nair',
          'department': 'Orthopaedics',
        }),
        StaffAppointment.fromJson({
          'patient_name': 'Alias Patient',
          'doctor_name_detail': 'Dr Alias Consultant',
          'appointment_department': 'ENT',
        }),
      ];

      expect(
        appointmentDoctorDepartmentFilterOptions(appointments, ''),
        containsAll([
          'Cardiology',
          'Dr Kiran Shah',
          'Dr Meera Nair',
          'Dr Alias Consultant',
          'ENT',
        ]),
      );
      expect(appointmentDoctorDepartmentFilterOptions(appointments, 'card'), [
        'Cardiology',
      ]);
      expect(appointmentDoctorDepartmentFilterOptions(appointments, 'meera'), [
        'Dr Meera Nair',
      ]);
      expect(appointmentDoctorDepartmentFilterOptions(appointments, 'ent'), [
        'ENT',
      ]);
    });
  });
}
