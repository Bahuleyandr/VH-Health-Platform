// Two-step Code Blue / rapid-response trigger guard tests.
//
// Pins the NL-14 P2 safety property: the durable resuscitation event is
// created only after BOTH the details dialog and the separate confirmation
// dialog are explicitly confirmed — never from a single tap — with the
// payload the backend contract expects, navigation to the durable record on
// success, and a surfaced error (no navigation) on failure.
//
// It also pins the opposite failure, which is the more dangerous one: the
// escalation must never be dropped *silently*. A barrier tap or a back gesture
// on the confirmation step used to complete its future with `null`, which the
// caller could not distinguish from an explicit Cancel — so an accidental
// dismissal abandoned a Code Blue with no feedback at all. The tests below
// cover both accidental exits, the residual torn-down-route path, and the
// deliberate escapes (Cancel, and back on the harmless draft step) that must
// keep working.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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

/// Drives the draft step through to the open confirmation dialog.
Future<void> _reachConfirmStep(WidgetTester tester) async {
  await _openDraftAndSelectPatient(tester);
  await tester.tap(find.text('Confirm'));
  await tester.pumpAndSettle();
  expect(find.text('Confirm activation'), findsOneWidget);
}

/// The Android system back gesture / button, as the engine delivers it.
Future<void> _systemBack(WidgetTester tester) async {
  await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
    'flutter/navigation',
    const JSONMethodCodec().encodeMethodCall(const MethodCall('popRoute')),
    (_) {},
  );
  await tester.pumpAndSettle();
}

/// A tap on the modal barrier, well outside any dialog surface.
Future<void> _tapBarrier(WidgetTester tester) async {
  await tester.tapAt(const Offset(8, 8));
  await tester.pumpAndSettle();
}

const _notSentCopy =
    'NOT triggered — the confirmation closed before you activated it. '
    'The resuscitation team has NOT been alerted.';

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

  group('the confirmation step cannot be dismissed into silence', () {
    testWidgets('a barrier tap does not close it — the escalation survives '
        'and can still be completed', (tester) async {
      final harness = _Harness();
      await _pump(tester, harness);
      await _reachConfirmStep(tester);

      await _tapBarrier(tester);

      // The decision is still on screen: nothing was dropped, and nothing
      // fired either.
      expect(find.text('Confirm activation'), findsOneWidget);
      expect(find.text('Trigger now'), findsOneWidget);
      expect(harness.createCalls, isEmpty);

      // The clinician can still complete the escalation they started.
      await tester.tap(find.text('Trigger now'));
      await tester.pumpAndSettle();

      expect(harness.createCalls, hasLength(1));
      expect(harness.createCalls.single.patientUid, 'patient-uid-9');
      expect(find.text('resus-doc-41'), findsOneWidget);
    });

    testWidgets('an Android back gesture does not close it — the escalation '
        'survives and can still be completed', (tester) async {
      final harness = _Harness();
      await _pump(tester, harness);
      await _reachConfirmStep(tester);

      await _systemBack(tester);

      expect(find.text('Confirm activation'), findsOneWidget);
      expect(harness.createCalls, isEmpty);
      // Back did not fall through to the draft step or the underlying screen
      // either — the confirmation is genuinely still the active surface.
      expect(find.text('Trigger code blue / rapid response'), findsNothing);

      await tester.tap(find.text('Trigger now'));
      await tester.pumpAndSettle();

      expect(harness.createCalls, hasLength(1));
      expect(find.text('resus-doc-41'), findsOneWidget);
    });

    testWidgets('repeated accidental dismissals never fire the alarm and never '
        'lose it', (tester) async {
      final harness = _Harness();
      await _pump(tester, harness);
      await _reachConfirmStep(tester);

      for (var i = 0; i < 3; i += 1) {
        await _tapBarrier(tester);
        await _systemBack(tester);
      }

      expect(find.text('Confirm activation'), findsOneWidget);
      expect(harness.createCalls, isEmpty);
    });

    testWidgets('explicit Cancel still works and stays quiet — this is "no '
        'silent cancel", not "no cancel"', (tester) async {
      final harness = _Harness();
      await _pump(tester, harness);
      await _reachConfirmStep(tester);

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      expect(find.text('Confirm activation'), findsNothing);
      expect(harness.createCalls, isEmpty);
      // A deliberate cancel is the clinician's own choice, so it must not
      // nag them with a warning.
      expect(find.byType(SnackBar), findsNothing);
      expect(find.text(_notSentCopy), findsNothing);
      // And the trigger is immediately reusable.
      expect(
        tester
            .widget<FloatingActionButton>(find.byType(FloatingActionButton))
            .onPressed,
        isNotNull,
      );
    });

    testWidgets('a route torn down underneath the flow is surfaced, not '
        'swallowed, and can be resumed', (tester) async {
      final harness = _Harness();
      await _pump(tester, harness);
      await _reachConfirmStep(tester);

      // The residual path the barrier/back locks cannot cover: something else
      // pops the dialog route (session-timeout redirect, programmatic pop).
      // `Navigator.pop` bypasses PopScope, so the future still completes with
      // `null` — which must never read as an explicit Cancel.
      tester.state<NavigatorState>(find.byType(Navigator).first).pop();
      await tester.pumpAndSettle();

      expect(harness.createCalls, isEmpty);
      expect(find.text('resus-doc-41'), findsNothing);
      // The clinician is told, in as many words, that nothing went out.
      expect(find.text(_notSentCopy), findsOneWidget);

      // ...and can resume without re-entering the patient or the context.
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();

      expect(find.text('Confirm activation'), findsOneWidget);
      await tester.tap(find.text('Trigger now'));
      await tester.pumpAndSettle();

      expect(harness.createCalls, hasLength(1));
      expect(harness.createCalls.single.patientUid, 'patient-uid-9');
      // The resumed escalation kept the original draft — no re-typing.
      expect(harness.createCalls.single.eventKind, 'code_blue');
      expect(harness.searchQueries, [
        'ram',
      ], reason: 'no second patient search');
      expect(find.text('resus-doc-41'), findsOneWidget);
    });

    testWidgets('both actions stay reachable and labelled for screen readers '
        'once the dismiss gestures are inert', (tester) async {
      final semantics = tester.ensureSemantics();
      final harness = _Harness();
      await _pump(tester, harness);
      await _reachConfirmStep(tester);

      // Locking the barrier and the back gesture removes the assistive-tech
      // dismiss affordance, so the in-dialog escape must carry a real button
      // label — otherwise this fix would trade one hazard for another.
      for (final label in const ['Cancel', 'Trigger now']) {
        expect(
          find.bySemanticsLabel(label),
          findsOneWidget,
          reason: '$label must be exposed to screen readers',
        );
        expect(
          tester.getSemantics(find.bySemanticsLabel(label)),
          isSemantics(
            label: label,
            isButton: true,
            isEnabled: true,
            hasEnabledState: true,
            isFocusable: true,
            hasTapAction: true,
          ),
          reason: '$label must stay an enabled, tappable, labelled button',
        );
      }

      semantics.dispose();
    });
  });

  group('the draft step is guarded differently, on purpose', () {
    testWidgets('a barrier tap does not wipe half-entered emergency context', (
      tester,
    ) async {
      final harness = _Harness();
      await _pump(tester, harness);
      await _openDraftAndSelectPatient(tester);

      final fields = find.byType(TextField);
      await tester.enterText(fields.at(1), 'unresponsive, no pulse');
      await tester.enterText(fields.at(2), 'ICU-A');
      await tester.pumpAndSettle();

      await _tapBarrier(tester);

      // Still open, still holding what was typed.
      expect(find.text('Trigger code blue / rapid response'), findsOneWidget);
      expect(find.text('unresponsive, no pulse'), findsOneWidget);
      expect(find.text('ICU-A'), findsOneWidget);
      expect(harness.createCalls, isEmpty);
    });

    testWidgets('back remains a real escape here — nothing was escalated, so '
        'the unchanged screen is its own feedback', (tester) async {
      final harness = _Harness();
      await _pump(tester, harness);
      await _openDraftAndSelectPatient(tester);

      await _systemBack(tester);

      expect(find.text('Trigger code blue / rapid response'), findsNothing);
      expect(find.text('Confirm activation'), findsNothing);
      expect(harness.createCalls, isEmpty);
      // No warning here: dismissing the details form cannot lose an
      // escalation, because none has been raised yet.
      expect(find.text(_notSentCopy), findsNothing);
      // The trigger is still sitting there, unchanged and usable.
      expect(
        tester
            .widget<FloatingActionButton>(find.byType(FloatingActionButton))
            .onPressed,
        isNotNull,
      );
    });
  });
}
