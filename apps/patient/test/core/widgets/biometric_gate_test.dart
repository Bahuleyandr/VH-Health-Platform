// FL-H1 regression tests: BiometricGateService.requireAuth was orphaned —
// the fail-closed gate existed but protected nothing. BiometricGate is the
// wiring; these tests pin its grant/deny/retry/grace-window behaviour.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/widgets/biometric_gate.dart';
import 'package:vhhealth/generated/app_localizations.dart';

Widget _wrap(Widget child) {
  return MaterialApp(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    home: child,
  );
}

void main() {
  setUp(BiometricGate.debugResetUnlockState);
  tearDown(() {
    BiometricGate.debugResetUnlockState();
    BiometricGate.unlockGraceWindow = const Duration(minutes: 2);
  });

  testWidgets('builds the protected child when the check grants', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        BiometricGate(
          authCheck: (_) async => true,
          builder: (_) => const Text('phi-content'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('phi-content'), findsOneWidget);
  });

  testWidgets('shows a spinner, not the child, while the check is pending', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        BiometricGate(
          // Never completes — a Completer holds no pending timer.
          authCheck: (_) => Completer<bool>().future,
          builder: (_) => const Text('phi-content'),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.text('phi-content'), findsNothing);
  });

  testWidgets('denies fail-closed: locked pane instead of the child', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        BiometricGate(
          authCheck: (_) async => false,
          builder: (_) => const Text('phi-content'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('phi-content'), findsNothing);
    expect(find.text('Unlock required'), findsOneWidget);
    expect(find.text('Unlock'), findsOneWidget);
    expect(find.byIcon(Icons.lock_outline), findsOneWidget);
  });

  testWidgets('a throwing check is treated as a denial (fail closed)', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        BiometricGate(
          authCheck: (_) async => throw StateError('sensor exploded'),
          builder: (_) => const Text('phi-content'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('phi-content'), findsNothing);
    expect(find.text('Unlock required'), findsOneWidget);
  });

  testWidgets('the Unlock button retries and grants on success', (
    tester,
  ) async {
    var attempts = 0;
    await tester.pumpWidget(
      _wrap(
        BiometricGate(
          authCheck: (_) async => ++attempts > 1,
          builder: (_) => const Text('phi-content'),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('phi-content'), findsNothing);

    await tester.tap(find.text('Unlock'));
    await tester.pumpAndSettle();

    expect(attempts, 2);
    expect(find.text('phi-content'), findsOneWidget);
  });

  testWidgets('passes the localized default reason to the check', (
    tester,
  ) async {
    String? receivedReason;
    await tester.pumpWidget(
      _wrap(
        BiometricGate(
          authCheck: (reason) async {
            receivedReason = reason;
            return true;
          },
          builder: (_) => const Text('phi-content'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(receivedReason, 'Unlock to view your medical records');
  });

  testWidgets('a recent unlock grants a sibling gate without re-prompting '
      '(hub -> detail push must not double-prompt)', (tester) async {
    var checks = 0;
    Future<bool> countingCheck(String _) async {
      checks++;
      return true;
    }

    await tester.pumpWidget(
      _wrap(
        BiometricGate(
          key: const ValueKey('hub'),
          authCheck: countingCheck,
          graceScopeKey: 'patient-a',
          builder: (_) => const Text('hub'),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('hub'), findsOneWidget);
    expect(checks, 1);

    // A different key forces a fresh State (a real push builds a new gate).
    await tester.pumpWidget(
      _wrap(
        BiometricGate(
          key: const ValueKey('detail'),
          authCheck: countingCheck,
          graceScopeKey: 'patient-a',
          builder: (_) => const Text('detail'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('detail'), findsOneWidget);
    expect(checks, 1, reason: 'grace window must suppress the second check');
  });

  testWidgets('an expired grace window re-prompts', (tester) async {
    BiometricGate.unlockGraceWindow = Duration.zero;
    var checks = 0;
    Future<bool> countingCheck(String _) async {
      checks++;
      return true;
    }

    await tester.pumpWidget(
      _wrap(
        BiometricGate(
          key: const ValueKey('hub'),
          authCheck: countingCheck,
          graceScopeKey: 'patient-a',
          builder: (_) => const Text('hub'),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(checks, 1);

    await tester.pumpWidget(
      _wrap(
        BiometricGate(
          key: const ValueKey('detail'),
          authCheck: countingCheck,
          graceScopeKey: 'patient-a',
          builder: (_) => const Text('detail'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(checks, 2);
    expect(find.text('detail'), findsOneWidget);
  });

  testWidgets('a recent unlock never grants a different patient account', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        BiometricGate(
          key: const ValueKey('patient-a'),
          authCheck: (_) async => true,
          graceScopeKey: 'patient-a',
          builder: (_) => const Text('patient-a-phi'),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('patient-a-phi'), findsOneWidget);

    var patientBChecked = false;
    await tester.pumpWidget(
      _wrap(
        BiometricGate(
          key: const ValueKey('patient-b'),
          authCheck: (_) async {
            patientBChecked = true;
            return false;
          },
          graceScopeKey: 'patient-b',
          builder: (_) => const Text('patient-b-phi'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(patientBChecked, isTrue);
    expect(find.text('patient-b-phi'), findsNothing);
    expect(find.text('Unlock required'), findsOneWidget);
  });

  testWidgets('a denial does not start a grace window', (tester) async {
    await tester.pumpWidget(
      _wrap(
        BiometricGate(
          key: const ValueKey('first'),
          authCheck: (_) async => false,
          builder: (_) => const Text('first'),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('first'), findsNothing);

    var secondChecked = false;
    await tester.pumpWidget(
      _wrap(
        BiometricGate(
          key: const ValueKey('second'),
          authCheck: (_) async {
            secondChecked = true;
            return false;
          },
          builder: (_) => const Text('second'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(secondChecked, isTrue);
    expect(find.text('second'), findsNothing);
  });

  testWidgets('backgrounding clears the grant and re-checks on resume', (
    tester,
  ) async {
    var checks = 0;
    await tester.pumpWidget(
      _wrap(
        BiometricGate(
          authCheck: (_) async {
            checks++;
            return true;
          },
          graceScopeKey: 'patient-a',
          builder: (_) => const Text('phi-content'),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(checks, 1);
    expect(find.text('phi-content'), findsOneWidget);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pump();
    expect(find.text('phi-content'), findsNothing);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();

    expect(checks, 2);
    expect(find.text('phi-content'), findsOneWidget);
  });
}
