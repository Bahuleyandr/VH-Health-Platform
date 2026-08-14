// Two-step Code Blue / rapid-response trigger guard tests.
//
// Pins the NL-14 P2 safety property: the durable resuscitation event is
// created only after BOTH the details dialog and the separate confirmation
// dialog are explicitly confirmed — never from a single tap — with the
// payload the backend contract expects, navigation to the durable record on
// success, and a surfaced error (no navigation) on failure.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth_staff/features/safety/widgets/resus_trigger_button.dart';

class _CreateCall {
  const _CreateCall({
    required this.patientUid,
    required this.eventKind,
    required this.reason,
    required this.ward,
    required this.bedNumber,
    required this.admissionId,
    required this.isDrill,
  });

  final String patientUid;
  final String eventKind;
  final String? reason;
  final String? ward;
  final String? bedNumber;
  final int? admissionId;
  final bool isDrill;
}

class _Harness {
  _Harness({this.createError, Map<String, dynamic>? createdRow})
    : createdRow = createdRow ?? {'id': 41};

  final Object? createError;
  final Map<String, dynamic> createdRow;
  final searchQueries = <String>[];
  final createCalls = <_CreateCall>[];

  Future<List<Map<String, dynamic>>> search(String query) async {
    searchQueries.add(query);
    return [
      {
        'uid': 'patient-uid-9',
        'name': 'Ramesh Kumar',
        'hospital_number': 'VH-000009',
        'phone': '9876543210',
      },
    ];
  }

  Future<Map<String, dynamic>> create({
    required String patientUid,
    String eventKind = 'code_blue',
    String? reason,
    String? ward,
    String? bedNumber,
    int? admissionId,
    bool isDrill = false,
  }) async {
    createCalls.add(
      _CreateCall(
        patientUid: patientUid,
        eventKind: eventKind,
        reason: reason,
        ward: ward,
        bedNumber: bedNumber,
        admissionId: admissionId,
        isDrill: isDrill,
      ),
    );
    final error = createError;
    if (error != null) throw error;
    return createdRow;
  }
}

Future<GoRouter> _pump(WidgetTester tester, _Harness harness) async {
  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (_, _) => Scaffold(
          body: const SizedBox.shrink(),
          floatingActionButton: ResusTriggerButton(
            searchPatients: harness.search,
            createEvent: harness.create,
          ),
        ),
      ),
      GoRoute(
        path: '/safety/resus/:eventId',
        builder: (_, state) => Scaffold(
          body: Text('resus-doc-${state.pathParameters['eventId']}'),
        ),
      ),
    ],
  );
  addTearDown(router.dispose);

  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  return router;
}

Future<void> _openDraftAndSelectPatient(WidgetTester tester) async {
  await tester.tap(find.text('Code blue'));
  await tester.pumpAndSettle();

  await tester.enterText(find.byType(TextField).first, 'ram');
  await tester.tap(find.byIcon(Icons.search));
  await tester.pumpAndSettle();
  await tester.tap(find.text('Ramesh Kumar'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('first tap only opens the details dialog — no API call', (
    tester,
  ) async {
    final harness = _Harness();
    await _pump(tester, harness);

    await tester.tap(find.text('Code blue'));
    await tester.pumpAndSettle();

    expect(find.text('Trigger code blue / rapid response'), findsOneWidget);
    expect(find.text('Confirm activation'), findsNothing);
    expect(harness.createCalls, isEmpty);

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    expect(find.text('Trigger code blue / rapid response'), findsNothing);
    expect(harness.createCalls, isEmpty);
  });

  testWidgets('details confirm only opens the second dialog; cancelling it '
      'creates nothing', (tester) async {
    final harness = _Harness();
    await _pump(tester, harness);
    await _openDraftAndSelectPatient(tester);

    await tester.tap(find.text('Confirm'));
    await tester.pumpAndSettle();

    // Second, separate confirmation step — still nothing created.
    expect(find.text('Confirm activation'), findsOneWidget);
    expect(find.text('Trigger now'), findsOneWidget);
    expect(harness.createCalls, isEmpty);

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    expect(find.text('Confirm activation'), findsNothing);
    expect(harness.createCalls, isEmpty);
  });

  testWidgets('confirmed trigger calls the API with the drafted payload and '
      'opens the durable record', (tester) async {
    final harness = _Harness(createdRow: {'id': 41});
    await _pump(tester, harness);
    await _openDraftAndSelectPatient(tester);

    // Optional context fields.
    final fields = find.byType(TextField);
    await tester.enterText(fields.at(1), '  unresponsive, no pulse ');
    await tester.enterText(fields.at(2), 'ICU-A');
    await tester.enterText(fields.at(3), 'B12');

    await tester.tap(find.text('Confirm'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Trigger now'));
    await tester.pumpAndSettle();

    expect(harness.searchQueries, ['ram']);
    expect(harness.createCalls, hasLength(1));
    final call = harness.createCalls.single;
    expect(call.patientUid, 'patient-uid-9');
    expect(call.eventKind, 'code_blue');
    expect(call.reason, 'unresponsive, no pulse');
    expect(call.ward, 'ICU-A');
    expect(call.bedNumber, 'B12');
    expect(call.admissionId, isNull);
    expect(call.isDrill, isFalse);

    // Default onCreated navigates to the durable resus documentation route.
    expect(find.text('resus-doc-41'), findsOneWidget);
    expect(find.text('Resuscitation event created'), findsOneWidget);
  });

  testWidgets('rapid response kind is sent when selected', (tester) async {
    final harness = _Harness();
    await _pump(tester, harness);
    await _openDraftAndSelectPatient(tester);

    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Rapid response').last);
    await tester.pumpAndSettle();

    await tester.tap(find.text('Confirm'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Trigger now'));
    await tester.pumpAndSettle();

    expect(harness.createCalls.single.eventKind, 'rapid_response');
  });

  testWidgets('API failure surfaces the error and does not navigate', (
    tester,
  ) async {
    final harness = _Harness(
      createError: Exception('Resuscitation events are disabled'),
    );
    await _pump(tester, harness);
    await _openDraftAndSelectPatient(tester);

    await tester.tap(find.text('Confirm'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Trigger now'));
    await tester.pumpAndSettle();

    expect(harness.createCalls, hasLength(1));
    expect(find.text('Resuscitation events are disabled'), findsOneWidget);
    expect(find.textContaining('resus-doc-'), findsNothing);
    // The trigger stays usable for a retry.
    expect(
      tester
          .widget<FloatingActionButton>(find.byType(FloatingActionButton))
          .onPressed,
      isNotNull,
    );
  });
}
