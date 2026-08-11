import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/features/doctor/screens/queue_screen.dart';

void main() {
  test('queue uses the canonical backend in-progress status', () {
    expect(queueInProgressFilterStatus, 'IN_PROGRESS');
    expect(queueInProgressUpdateStatus, 'IN_PROGRESS');
    expect(queueInProgressFilterStatus, isNot(contains('-')));
    expect(queueInProgressUpdateStatus, isNot(contains('-')));
  });

  test(
    'queue reads the canonical appointment identity and schedule fields',
    () {
      final appointment = <String, dynamic>{
        'patient_name': 'Canonical Patient',
        'patient_phone': '+919876543210',
        'appointment_date': '2026-08-11',
        'appointment_time': '09:30',
        'visit_type': 'FOLLOW_UP',
        'patientName': 'Wrong Legacy Patient',
        'patientPhone': '+910000000000',
        'dateTime': '2026-08-11T16:00:00',
      };

      expect(queuePatientName(appointment, 'Unknown'), 'Canonical Patient');
      expect(queuePatientPhone(appointment), '+919876543210');
      expect(
        queueAppointmentDateTime(appointment),
        DateTime(2026, 8, 11, 9, 30),
      );
      expect(queueAppointmentType(appointment), 'FOLLOW_UP');
    },
  );

  Future<void> pumpQueue(
    WidgetTester tester, {
    required QueueAppointmentsLoader loadAppointments,
  }) async {
    SharedPreferences.setMockInitialValues({});
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(900, 1200);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);

    final router = GoRouter(
      routes: [
        GoRoute(
          path: '/',
          builder: (_, _) => QueueScreen(
            loadAppointments: loadAppointments,
            autoRefresh: false,
          ),
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(
      ChangeNotifierProvider(
        create: (_) => ThemeProvider(),
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pump();
  }

  testWidgets('a stale refresh completion cannot overwrite newer queue data', (
    tester,
  ) async {
    final firstScheduled = Completer<Map<String, dynamic>>();
    var scheduledCalls = 0;
    Future<Map<String, dynamic>> loader({
      required String date,
      required String status,
      required int limit,
    }) async {
      if (status != 'scheduled') return {'appointments': <dynamic>[]};
      scheduledCalls++;
      if (scheduledCalls == 1) return firstScheduled.future;
      return {
        'appointments': [
          {
            'id': 2,
            'patient_name': 'New Queue Patient',
            'patient_phone': '+919876543210',
            'appointment_date': date,
            'appointment_time': '09:30',
          },
        ],
      };
    }

    await pumpQueue(tester, loadAppointments: loader);
    await tester.tap(find.byIcon(Icons.refresh));
    await tester.pump();
    await tester.pump();
    await tester.pump();

    expect(find.text('New Queue Patient'), findsOneWidget);

    firstScheduled.complete({
      'appointments': [
        {
          'id': 1,
          'patient_name': 'Old Queue Patient',
          'patient_phone': '+919111111111',
          'appointment_date': '2026-08-11',
          'appointment_time': '08:00',
        },
      ],
    });
    await tester.pump();
    await tester.pump();
    await tester.pump();
    await tester.pump();

    expect(find.text('New Queue Patient'), findsOneWidget);
    expect(find.text('Old Queue Patient'), findsNothing);
  });

  testWidgets('transient refresh failure retains last-known queue data', (
    tester,
  ) async {
    var failRefresh = false;
    Future<Map<String, dynamic>> loader({
      required String date,
      required String status,
      required int limit,
    }) async {
      if (status != 'scheduled') return {'appointments': <dynamic>[]};
      if (failRefresh) throw Exception('temporary outage');
      return {
        'appointments': [
          {
            'id': 3,
            'patient_name': 'Last Known Patient',
            'patient_phone': '+919876543210',
            'appointment_date': date,
            'appointment_time': '10:00',
          },
        ],
      };
    }

    await pumpQueue(tester, loadAppointments: loader);
    await tester.pump();
    await tester.pump();
    await tester.pump();
    expect(find.text('Last Known Patient'), findsOneWidget);

    failRefresh = true;
    await tester.tap(find.byIcon(Icons.refresh));
    await tester.pump();
    await tester.pump();

    expect(find.text('Last Known Patient'), findsOneWidget);
    expect(find.byKey(const Key('queue-stale-data-banner')), findsOneWidget);
    final callNext = tester.widget<ElevatedButton>(
      find.widgetWithText(ElevatedButton, 'Call Next Patient'),
    );
    expect(callNext.onPressed, isNull);

    failRefresh = false;
    await tester.tap(find.byIcon(Icons.refresh));
    await tester.pump();
    await tester.pump();

    expect(find.byKey(const Key('queue-stale-data-banner')), findsNothing);
    final refreshedCallNext = tester.widget<ElevatedButton>(
      find.widgetWithText(ElevatedButton, 'Call Next Patient'),
    );
    expect(refreshedCallNext.onPressed, isNotNull);
  });
}
