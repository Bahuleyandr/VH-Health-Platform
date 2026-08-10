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

  testWidgets(
    'the inactive state raised by an in-flight prompt neither clears a '
    'sibling grant nor discards the pending grant (no false-lock loop)',
    (tester) async {
      // The OS biometric prompt itself pushes the app to `inactive`. Before
      // the prompt-in-flight guard, that transition made every granted gate
      // clear the shared unlock state and bump the unlock generation, which
      // discarded the very grant the prompt was about to return — wedging
      // the gate in a prompt -> inactive -> cleared -> re-prompt loop.
      final pendingCheck = Completer<bool>();
      Widget stack({required bool withDetail}) {
        return _wrap(
          Column(
            children: [
              SizedBox(
                height: 200,
                child: BiometricGate(
                  key: const ValueKey('hub'),
                  authCheck: (_) async => true,
                  graceScopeKey: 'patient-a',
                  builder: (_) => const Text('hub-phi'),
                ),
              ),
              if (withDetail)
                SizedBox(
                  height: 200,
                  child: BiometricGate(
                    key: const ValueKey('detail'),
                    authCheck: (_) => pendingCheck.future,
                    // A different scope so the hub's grace window cannot
                    // satisfy this gate — it must run its own prompt.
                    graceScopeKey: 'patient-a-detail',
                    builder: (_) => const Text('detail-phi'),
                  ),
                ),
            ],
          ),
        );
      }

      await tester.pumpWidget(stack(withDetail: false));
      await tester.pumpAndSettle();
      expect(find.text('hub-phi'), findsOneWidget);

      // Mount the second gate; its check (the "OS prompt") stays pending.
      await tester.pumpWidget(stack(withDetail: true));
      await tester.pump();
      expect(find.text('detail-phi'), findsNothing);

      // The prompt overlay takes focus -> the app reports `inactive`.
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();

      // The already-granted sibling must NOT re-lock off the prompt's own
      // lifecycle noise.
      expect(find.text('hub-phi'), findsOneWidget);

      // And when the user passes the prompt, the grant must stick instead of
      // being discarded by a generation bump.
      pendingCheck.complete(true);
      await tester.pumpAndSettle();
      expect(find.text('detail-phi'), findsOneWidget);
      expect(find.text('hub-phi'), findsOneWidget);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
    },
  );

  testWidgets(
    'backgrounding a lone in-flight prompt invalidates its result and waits '
    'to re-prompt in the foreground',
    (tester) async {
      final prompts = <Completer<bool>>[];
      Future<bool> pendingCheck(String _) {
        final prompt = Completer<bool>();
        prompts.add(prompt);
        return prompt.future;
      }

      await tester.pumpWidget(
        _wrap(
          BiometricGate(
            authCheck: pendingCheck,
            graceScopeKey: 'patient-a',
            builder: (_) => const Text('phi-content'),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      expect(prompts, hasLength(1));
      expect(find.text('phi-content'), findsNothing);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();

      // Do not start a second local_auth operation while the persisted first
      // operation is still unwinding after resume.
      expect(prompts, hasLength(1));

      prompts.single.complete(true);
      await tester.pump();
      await tester.pump();

      // The pre-background success is stale: it must not expose PHI. A fresh
      // foreground prompt is now required.
      expect(find.text('phi-content'), findsNothing);
      expect(prompts, hasLength(2));

      prompts.last.complete(true);
      await tester.pumpAndSettle();
      expect(find.text('phi-content'), findsOneWidget);
    },
  );

  testWidgets('true backgrounding during an in-flight prompt still re-locks', (
    tester,
  ) async {
    final pendingCheck = Completer<bool>();
    await tester.pumpWidget(
      _wrap(
        Column(
          children: [
            SizedBox(
              height: 200,
              child: BiometricGate(
                key: const ValueKey('hub'),
                authCheck: (_) async => true,
                graceScopeKey: 'patient-a',
                builder: (_) => const Text('hub-phi'),
              ),
            ),
            SizedBox(
              height: 200,
              child: BiometricGate(
                key: const ValueKey('detail'),
                authCheck: (_) => pendingCheck.future,
                graceScopeKey: 'patient-a-detail',
                builder: (_) => const Text('detail-phi'),
              ),
            ),
          ],
        ),
      ),
    );
    // Bounded pumps — the detail gate's pending check keeps its indeterminate
    // spinner animating, so pumpAndSettle would time out.
    await tester.pump();
    await tester.pump();
    expect(find.text('hub-phi'), findsOneWidget);

    // `paused` (not `inactive`) means the app genuinely left the foreground,
    // prompt or no prompt — the grant must clear.
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();

    expect(find.text('hub-phi'), findsNothing);

    // Restore the lifecycle for the following tests. The pending check is
    // deliberately never completed (its counter is reset by setUp); bounded
    // pumps because its spinner never settles.
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    await tester.pump();
    expect(find.text('hub-phi'), findsOneWidget);
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
