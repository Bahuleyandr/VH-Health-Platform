// Porter transport worklist pins:
//   * the my-tasks tab renders task number, zone line, and status from the
//     /patient-flow/transport/tasks/my payload;
//   * the accept action POSTs to /patient-flow/transport/tasks/:id/accept;
//   * the verify action mirrors backend PATIENT_TRANSPORT_VERIFY_ROUTE_ROLES
//     (routeRolePolicy.js): hidden for a porter role outside the list,
//     shown for an ip_flow role inside it on a completed-unverified task.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/features/transport/screens/transport_tasks_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
  });

  tearDown(VHHttpClient.resetClientForTesting);

  Map<String, dynamic> taskRow({
    int id = 42,
    String status = 'assigned',
    String priority = 'high',
    Object? verifiedBy,
  }) {
    return {
      'id': id,
      'task_number': 'PT-2026-000042',
      'source_type': 'manual',
      'patient_uid': null,
      'pickup_zone_id': 1,
      'pickup_label': 'Ward 3B',
      'destination_zone_id': 2,
      'destination_label': 'Radiology',
      'priority': priority,
      'status': status,
      'verified_by': verifiedBy,
      'requested_at': DateTime.now()
          .subtract(const Duration(minutes: 5))
          .toIso8601String(),
      'sla_due_at': DateTime.now()
          .add(const Duration(minutes: 15))
          .toIso8601String(),
    };
  }

  http.Response ok(Object data) => http.Response(
    jsonEncode({'success': true, 'data': data}),
    200,
    headers: {'content-type': 'application/json'},
  );

  /// Wires the task list endpoints. `/tasks/my` must be matched before the
  /// bare `/tasks` board path.
  void mockTaskEndpoints({
    required List<Map<String, dynamic>> myTasks,
    List<Map<String, dynamic>> boardTasks = const [],
    void Function(http.Request request)? onOther,
  }) {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        if (request.method == 'GET' &&
            request.url.path.endsWith('/patient-flow/transport/tasks/my')) {
          return ok({'tasks': myTasks});
        }
        if (request.method == 'GET' &&
            request.url.path.endsWith('/patient-flow/transport/tasks')) {
          return ok({'tasks': boardTasks});
        }
        if (onOther != null) {
          onOther(request);
          return ok({'task': taskRow(status: 'accepted')});
        }
        fail('unexpected request: ${request.method} ${request.url}');
      }),
    );
  }

  Future<void> pumpScreen(WidgetTester tester) async {
    await tester.pumpWidget(const MaterialApp(home: TransportTasksScreen()));
    // initState → getRole (secure storage) → load (two list calls).
    await tester.pump();
    await tester.pump();
    await tester.pump();
  }

  group('verify role contract', () {
    test('pins the roster to backend PATIENT_TRANSPORT_VERIFY_ROUTE_ROLES', () {
      // routeRolePolicy.js: ip_flow + diagnostics + emergency capability
      // groups (rolePolicyGraph.js) + RECEPTION_INCHARGE, ADMISSION_OFFICER,
      // MEDICAL_SUPERINTENDENT.
      expect(transportVerifyRoleCodes, {
        'SUPER_ADMIN',
        'ADMIN',
        'DOCTOR',
        'DUTY_DOCTOR',
        'CONSULTANT',
        'SENIOR_DOCTOR',
        'JUNIOR_DOCTOR',
        'RESIDENT',
        'NURSING_STAFF',
        'NURSING_INCHARGE',
        'IP_STAFF_NURSE',
        'IP_INCHARGE',
        'ICU_NURSE',
        'ICU_INCHARGE',
        'ICU_STAFF',
        'ADMISSION_OFFICER',
        'IPD_COUNSELLOR',
        'LAB_STAFF',
        'RADIOLOGIST',
        'RADIOLOGY_STAFF',
        'PATHOLOGIST',
        'LAB_INCHARGE',
        'BLOOD_BANK_STAFF',
        'BLOOD_BANK_TECHNICIAN',
        'ER_STAFF',
        'RECEPTION_INCHARGE',
        'MEDICAL_SUPERINTENDENT',
      });
    });

    test('porter execution roles stay outside the verify roster', () {
      // The transport mount admits these roles, but verify deliberately
      // does not — they execute jobs, the receiving side verifies them.
      for (final role in const [
        'DRIVER',
        'AMBULANCE_DRIVER',
        'DELIVERY_STAFF',
        'EMERGENCY_RESPONDER',
        'AMBULANCE_COORDINATOR',
      ]) {
        expect(canVerifyTransportHandoff(role), isFalse, reason: role);
      }
      expect(canVerifyTransportHandoff('ip_staff_nurse'), isTrue);
    });
  });

  group('TransportTasksScreen', () {
    testWidgets('renders my tasks from /transport/tasks/my', (tester) async {
      FlutterSecureStorage.setMockInitialValues({'staff_role': 'DRIVER'});
      mockTaskEndpoints(myTasks: [taskRow()]);

      await pumpScreen(tester);

      expect(find.text('PT-2026-000042'), findsOneWidget);
      expect(find.text('Ward 3B → Radiology'), findsOneWidget);
      expect(find.text('ASSIGNED'), findsOneWidget);
      expect(find.text('HIGH'), findsOneWidget);
      expect(find.text('Accept'), findsOneWidget);
      expect(find.text('Complete'), findsOneWidget);
    });

    testWidgets('accept action POSTs to the accept transition path', (
      tester,
    ) async {
      FlutterSecureStorage.setMockInitialValues({'staff_role': 'DRIVER'});
      String? postedPath;
      String? postedMethod;
      mockTaskEndpoints(
        myTasks: [taskRow()],
        onOther: (request) {
          postedMethod = request.method;
          postedPath = request.url.path;
        },
      );

      await pumpScreen(tester);

      await tester.tap(find.text('Accept'));
      await tester.pump();
      await tester.pump();

      expect(postedMethod, 'POST');
      expect(postedPath, endsWith('/patient-flow/transport/tasks/42/accept'));
    });

    testWidgets('verify button hidden for a role outside the verify list', (
      tester,
    ) async {
      // DRIVER is in PATIENT_TRANSPORT_ROUTE_ROLES but not in
      // PATIENT_TRANSPORT_VERIFY_ROUTE_ROLES.
      FlutterSecureStorage.setMockInitialValues({'staff_role': 'DRIVER'});
      mockTaskEndpoints(
        myTasks: [taskRow(status: 'completed', verifiedBy: null)],
      );

      await pumpScreen(tester);

      expect(find.text('PT-2026-000042'), findsOneWidget);
      expect(find.text('Verify handoff'), findsNothing);
    });

    testWidgets('verify button shown for a verify-roster role', (tester) async {
      FlutterSecureStorage.setMockInitialValues({
        'staff_role': 'IP_STAFF_NURSE',
      });
      mockTaskEndpoints(
        myTasks: [taskRow(status: 'completed', verifiedBy: null)],
      );

      await pumpScreen(tester);

      expect(find.text('Verify handoff'), findsOneWidget);
    });

    testWidgets('an already-verified task offers no verify action', (
      tester,
    ) async {
      FlutterSecureStorage.setMockInitialValues({
        'staff_role': 'IP_STAFF_NURSE',
      });
      mockTaskEndpoints(
        myTasks: [
          taskRow(
            status: 'completed',
            verifiedBy: '0b6a1f6e-9a1b-4c2d-8e3f-a45b6c7d8e9f',
          ),
        ],
      );

      await pumpScreen(tester);

      expect(find.text('Verify handoff'), findsNothing);
      expect(find.text('VERIFIED'), findsOneWidget);
    });
  });

  group('screen helpers', () {
    test('zone line falls back label → location text → zone id', () {
      expect(
        transportZoneLine({
          'pickup_label': 'Ward 3B',
          'destination_label': 'Radiology',
        }),
        'Ward 3B → Radiology',
      );
      expect(
        transportZoneLine({
          'pickup_location_text': 'Bed 12',
          'destination_zone_id': 7,
        }),
        'Bed 12 → Zone #7',
      );
    });
  });
}
