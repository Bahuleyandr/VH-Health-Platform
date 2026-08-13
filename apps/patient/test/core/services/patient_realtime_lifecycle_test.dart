import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/patient_realtime_lifecycle.dart';

void main() {
  tearDown(() {
    PatientRealtimeLifecycle.stopTimeout = const Duration(seconds: 4);
  });

  test('the teardown bound defaults to the documented 4 seconds', () {
    expect(
      PatientRealtimeLifecycle.stopTimeout,
      const Duration(seconds: 4),
      reason:
          'The bound is part of the logout contract — LogoutService sizes the '
          'blocking "Signing out…" dialog against it.',
    );
  });

  test('a stop that never resolves cannot hang the teardown, and the final '
      'disconnect is still attempted', () async {
    // THE regression test for this packet at the lifecycle layer: a genuinely
    // dead/black-holed socket used to leave completeTeardown — and with it
    // LogoutService.logout() — pending forever.
    PatientRealtimeLifecycle.stopTimeout = const Duration(milliseconds: 50);
    final lifecycle = PatientRealtimeLifecycle();
    final neverResolves = Completer<void>();
    var finalDisconnects = 0;

    lifecycle.attach(
      owner: Object(),
      start: () async {},
      stop: ({required unsubscribe}) => neverResolves.future,
    );

    lifecycle.beginTeardown();
    final result = await lifecycle
        .completeTeardown(() async {
          finalDisconnects += 1;
        })
        .timeout(const Duration(seconds: 5));

    expect(result, PatientRealtimeTeardownResult.timedOut);
    // Invariant preserved: the disconnect is still ATTEMPTED — it is merely
    // no longer awaited behind the wedged stop.
    expect(finalDisconnects, 1);
    // The fence is released, so a future login is admitted normally.
    expect(lifecycle.isTearingDown, isFalse);
  });

  test(
    'the wedged queue tail is abandoned so the next login is not stuck behind '
    'the same dead socket',
    () async {
      PatientRealtimeLifecycle.stopTimeout = const Duration(milliseconds: 50);
      final lifecycle = PatientRealtimeLifecycle();
      final neverResolves = Completer<void>();
      var starts = 0;

      lifecycle.attach(
        owner: Object(),
        start: () async {
          starts += 1;
        },
        stop: ({required unsubscribe}) => neverResolves.future,
      );

      lifecycle.beginTeardown();
      expect(
        await lifecycle.completeTeardown(() async {}),
        PatientRealtimeTeardownResult.timedOut,
      );

      // Without dropping the abandoned tail, this start would chain onto the
      // never-completing drain and a bounded logout would become an unbounded
      // login.
      await lifecycle.queueStart().timeout(const Duration(seconds: 5));
      expect(starts, 1);
    },
  );

  test(
    'an abandoned stop that later unwedges cannot disconnect a second time',
    () async {
      // A duplicate disconnect after the bound could tear down a realtime
      // session a NEW login has already established.
      PatientRealtimeLifecycle.stopTimeout = const Duration(milliseconds: 50);
      final lifecycle = PatientRealtimeLifecycle();
      final release = Completer<void>();
      var finalDisconnects = 0;

      lifecycle.attach(
        owner: Object(),
        start: () async {},
        stop: ({required unsubscribe}) => release.future,
      );

      lifecycle.beginTeardown();
      await lifecycle.completeTeardown(() async {
        finalDisconnects += 1;
      });
      expect(finalDisconnects, 1);

      release.complete();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(finalDisconnects, 1);
    },
  );

  test('a stop that resolves inside the bound reports completion', () async {
    final lifecycle = PatientRealtimeLifecycle();
    lifecycle.attach(
      owner: Object(),
      start: () async {},
      stop: ({required unsubscribe}) async {},
    );

    lifecycle.beginTeardown();
    expect(
      await lifecycle.completeTeardown(() async {}),
      PatientRealtimeTeardownResult.completed,
    );
  });

  test(
    'a queued online or resume start cannot cross a logout generation',
    () async {
      final lifecycle = PatientRealtimeLifecycle();
      final stopEntered = Completer<void>();
      final releaseStop = Completer<void>();
      var starts = 0;
      var finalDisconnects = 0;

      lifecycle.attach(
        owner: Object(),
        start: () async {
          starts += 1;
        },
        stop: ({required unsubscribe}) async {
          if (!stopEntered.isCompleted) {
            stopEntered.complete();
            await releaseStop.future;
          }
        },
      );

      final blockingStop = lifecycle.queueStop();
      await stopEntered.future;
      final queuedLifecycleStart = lifecycle.queueStart();

      // Logout enters its new generation synchronously, before the first socket
      // disconnect. The already-queued lifecycle callback must become stale.
      lifecycle.beginTeardown();
      final duringTeardownStart = lifecycle.queueStart();
      releaseStop.complete();
      await blockingStop;
      await queuedLifecycleStart;
      await duringTeardownStart;
      await lifecycle.completeTeardown(() async {
        finalDisconnects += 1;
      });

      expect(starts, 0);
      expect(finalDisconnects, 1);
      expect(lifecycle.isTearingDown, isFalse);
    },
  );

  test(
    'an in-flight start is followed by unsubscribe and final disconnect',
    () async {
      final lifecycle = PatientRealtimeLifecycle();
      final startEntered = Completer<void>();
      final releaseStart = Completer<void>();
      final calls = <String>[];

      lifecycle.attach(
        owner: Object(),
        start: () async {
          calls.add('start');
          startEntered.complete();
          await releaseStart.future;
        },
        stop: ({required unsubscribe}) async {
          calls.add('stop:$unsubscribe');
        },
      );

      final start = lifecycle.queueStart();
      await startEntered.future;
      lifecycle.beginTeardown();
      final finish = lifecycle.completeTeardown(() async {
        calls.add('disconnect');
      });
      releaseStart.complete();

      await start;
      await finish;
      expect(calls, ['start', 'stop:true', 'disconnect']);
    },
  );
}
