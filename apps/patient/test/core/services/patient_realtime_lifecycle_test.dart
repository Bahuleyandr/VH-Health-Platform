import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/crash_reporter.dart';
import 'package:vhhealth/core/services/patient_realtime_lifecycle.dart';

class _RecordingCrashReporter implements CrashReporter {
  final List<Map<String, Object?>> errors = [];

  @override
  Future<void> recordError(
    Object error,
    StackTrace? stack, {
    String? context,
    Map<String, Object?> extra = const {},
    bool fatal = false,
  }) async {
    errors.add({'error': error, 'context': context, ...extra});
  }

  @override
  Future<void> log(String message) async {}

  @override
  Future<void> setUserId(String? userId) async {}

  @override
  Future<void> setCustomKey(String key, Object value) async {}
}

void main() {
  tearDown(() {
    PatientRealtimeLifecycle.stopTimeout = const Duration(seconds: 4);
    CrashReporter.reset();
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

  test('a stop AND a final disconnect that BOTH hang still complete the teardown', () async {
    // THE case the first cut of this suite could not express. In production
    // both callbacks resolve to the SAME method: `_stop` reaches
    // `RealtimeClient.instance.disconnect()` via main.dart's `_stopRealtime`
    // → `RealtimeProvider.disconnect`, and `finalDisconnect` IS
    // `RealtimeClient.instance.disconnect`. On the motivating case — a dead
    // or black-holed socket — the first call is parked inside
    // `await _channel?.sink.close(...)` and has not reached `_channel = null`,
    // so a second call re-awaits that same pending close.
    //
    // Pairing a never-resolving `stop` with an instantly-returning
    // `finalDisconnect`, as the earlier tests did, is a combination that
    // CANNOT occur in production — which is why they passed while the escape
    // hatch still re-entered the wedge and left logout hanging forever.
    PatientRealtimeLifecycle.stopTimeout = const Duration(milliseconds: 50);
    final lifecycle = PatientRealtimeLifecycle();
    final wedgedSocket = Completer<void>();
    var finalDisconnects = 0;

    lifecycle.attach(
      owner: Object(),
      start: () async {},
      stop: ({required unsubscribe}) => wedgedSocket.future,
    );

    lifecycle.beginTeardown();
    final result = await lifecycle
        .completeTeardown(() {
          finalDisconnects += 1;
          // The same wedge, because it is the same call.
          return wedgedSocket.future;
        })
        .timeout(
          const Duration(seconds: 5),
          onTimeout: () => fail(
            'completeTeardown awaited the escape-hatch disconnect, which '
            'resolves to the same wedged call as the stop it is escaping',
          ),
        );

    expect(result, PatientRealtimeTeardownResult.timedOut);
    // The invariant that must NOT be weakened: the disconnect is still
    // attempted. It is started and left to run, not awaited.
    expect(finalDisconnects, 1);
    expect(lifecycle.isTearingDown, isFalse);
  });

  test(
    'a drain that reaches the front of the queue only after the bound expired '
    'does NOT stop a session it no longer owns',
    () async {
      // The drain was the one path that reached `_stop` with no generation
      // check at all (contrast queueStart). Queued behind slower work, it could
      // arrive at the front only after the bound expired and the fence was
      // released — and then call `_stop(unsubscribe: true)` against whatever
      // session was live by then, retiring a NEW login's patient state,
      // unsubscribing its channels and disconnecting its socket.
      PatientRealtimeLifecycle.stopTimeout = const Duration(milliseconds: 50);
      final lifecycle = PatientRealtimeLifecycle();
      final releaseBackgroundStop = Completer<void>();
      final calls = <String>[];
      var finalDisconnects = 0;

      lifecycle.attach(
        owner: Object(),
        start: () async => calls.add('start'),
        stop: ({required unsubscribe}) async {
          calls.add('stop:$unsubscribe');
          if (!unsubscribe) await releaseBackgroundStop.future;
        },
      );

      // A backgrounding stop is already draining when logout begins, so the
      // teardown's own stop sits BEHIND it in the queue.
      final backgroundStop = lifecycle.queueStop();
      await Future<void>.delayed(Duration.zero);
      expect(calls, ['stop:false']);

      lifecycle.beginTeardown();
      expect(
        await lifecycle.completeTeardown(() async {
          finalDisconnects += 1;
        }),
        PatientRealtimeTeardownResult.timedOut,
      );
      expect(finalDisconnects, 1);

      // The queue unwedges only now — after logout finished, and in production
      // after a new login could already own the realtime fabric.
      releaseBackgroundStop.complete();
      await backgroundStop;
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(
        calls,
        ['stop:false'],
        reason:
            'a retired teardown must never run stop(unsubscribe: true) against '
            'whatever session is live now',
      );
    },
  );

  test(
    'the abandoned teardown KEEPS the queue tail, so a relogin does not start '
    'realtime alongside a stop that is still in flight',
    () async {
      // INVERTED from an earlier revision, which asserted the tail was DROPPED
      // so the next login would not wait behind a dead socket. That reasoning
      // does not survive contact with the call sites: every `queueStart` in
      // main.dart and app_router.dart is wrapped in `unawaited`, so no login
      // path was ever blocked by the tail. Dropping it bought no
      // responsiveness — it only restored concurrency, letting a new session's
      // start run alongside a still-in-flight `_stop` whose late effects
      // (`_retirePatientState`, channel unsubscribes,
      // `RealtimeClient.disconnect`) silently tear that new session down.
      //
      // Serialization within the bound is still the stronger guarantee, and it
      // is what this test pins. The companion test below pins the other half:
      // the wait is bounded, so a straggler that never settles cannot make the
      // guarantee permanent.
      PatientRealtimeLifecycle.stopTimeout = const Duration(seconds: 4);
      final lifecycle = PatientRealtimeLifecycle();
      final wedgedStop = Completer<void>();
      var starts = 0;

      lifecycle.attach(
        owner: Object(),
        start: () async => starts += 1,
        stop: ({required unsubscribe}) => wedgedStop.future,
      );

      lifecycle.beginTeardown();
      // Bound only the teardown for this phase, so the queue-wait ceiling
      // (also stopTimeout) cannot expire during the window asserted below.
      PatientRealtimeLifecycle.stopTimeout = const Duration(milliseconds: 50);
      expect(
        await lifecycle.completeTeardown(() async {}),
        PatientRealtimeTeardownResult.timedOut,
      );
      PatientRealtimeLifecycle.stopTimeout = const Duration(seconds: 4);

      // The user signs back in while the old stop is still parked in the
      // socket.
      final relogin = lifecycle.queueStart();
      await Future<void>.delayed(const Duration(milliseconds: 60));
      expect(
        starts,
        0,
        reason:
            'the new session must not connect while a stop that can still '
            'disconnect it is outstanding',
      );

      wedgedStop.complete();
      await relogin.timeout(const Duration(seconds: 5));
      expect(starts, 1);
    },
  );

  test(
    'a relogin behind a teardown that NEVER settles still gets realtime once '
    'the queue-wait ceiling expires',
    () async {
      // THE regression test for the silently-dead-realtime defect. The tail
      // kept by the branch above resolves to the same black-holed socket the
      // teardown bound was escaping, so it may never settle. `queueStart()` is
      // the only way this app connects and every call site discards its future
      // (`main.dart`, `app_router.dart` both `unawaited`), so a permanently
      // parked tail meant the next patient on the device got no queue
      // positions, no appointment events, no notifications and no
      // `session:revoked` kick — for the life of the process, announced by a
      // single kDebugMode debugPrint.
      PatientRealtimeLifecycle.stopTimeout = const Duration(milliseconds: 50);
      final lifecycle = PatientRealtimeLifecycle();
      final neverSettles = Completer<void>();
      var starts = 0;

      lifecycle.attach(
        owner: Object(),
        start: () async => starts += 1,
        stop: ({required unsubscribe}) => neverSettles.future,
      );

      lifecycle.beginTeardown();
      expect(
        await lifecycle.completeTeardown(() => neverSettles.future),
        PatientRealtimeTeardownResult.timedOut,
      );

      final relogin = lifecycle.queueStart();
      await relogin.timeout(
        const Duration(seconds: 5),
        onTimeout: () => fail(
          'the relogin start never ran: the queue is still chained to a '
          'wedged teardown with no ceiling',
        ),
      );

      expect(starts, 1);
      expect(
        neverSettles.isCompleted,
        isFalse,
        reason:
            'the point is that the straggler is STILL parked — the chain moved '
            'on without it rather than waiting for it to come back',
      );
    },
  );

  test(
    'a wedged predecessor that the chain steps over is reported, not silent',
    () async {
      PatientRealtimeLifecycle.stopTimeout = const Duration(milliseconds: 50);
      final reporter = _RecordingCrashReporter();
      CrashReporter.install(reporter);
      addTearDown(CrashReporter.reset);

      final lifecycle = PatientRealtimeLifecycle();
      final wedged = Completer<void>();
      lifecycle.attach(
        owner: Object(),
        start: () async {},
        stop: ({required unsubscribe}) => wedged.future,
      );

      unawaited(lifecycle.queueStop());
      await Future<void>.delayed(Duration.zero);
      await lifecycle.queueStart().timeout(const Duration(seconds: 5));

      expect(
        reporter.errors.map((e) => e['context']),
        contains('PatientRealtimeLifecycle._enqueue'),
      );
      expect(reporter.errors.first['bound_ms'], 50);
    },
  );

  test(
    'a start dropped because a teardown owns the era is reported, not silent',
    () async {
      final reporter = _RecordingCrashReporter();
      CrashReporter.install(reporter);
      addTearDown(CrashReporter.reset);

      final lifecycle = PatientRealtimeLifecycle();
      var starts = 0;
      lifecycle.attach(
        owner: Object(),
        start: () async => starts += 1,
        stop: ({required unsubscribe}) async {},
      );

      lifecycle.beginTeardown();
      await lifecycle.queueStart();

      expect(starts, 0);
      expect(
        reporter.errors.map((e) => e['context']),
        contains('PatientRealtimeLifecycle.queueStart'),
      );
    },
  );

  test(
    'a start superseded by a LATER era is not reported as a fault',
    () async {
      // The generation fence doing its job is normal, and reporting every
      // logout-superseded start would drown the signal above in noise.
      final reporter = _RecordingCrashReporter();
      CrashReporter.install(reporter);
      addTearDown(CrashReporter.reset);

      final lifecycle = PatientRealtimeLifecycle();
      final releaseStop = Completer<void>();
      var starts = 0;
      lifecycle.attach(
        owner: Object(),
        start: () async => starts += 1,
        stop: ({required unsubscribe}) async {
          if (!unsubscribe) await releaseStop.future;
        },
      );

      final blockingStop = lifecycle.queueStop();
      await Future<void>.delayed(Duration.zero);
      final staleStart = lifecycle.queueStart();
      lifecycle.beginTeardown();
      releaseStop.complete();
      await blockingStop;
      await staleStart;

      expect(starts, 0);
      expect(reporter.errors, isEmpty);
    },
  );

  test('a stop queued before a teardown cannot run after it', () async {
    // Same fence, applied to queueStop: a pause/background stop that has not
    // drained by the time logout retires the era must not reach the shared
    // realtime singleton afterwards. The teardown's own
    // `stop(unsubscribe: true)` is strictly stronger, so nothing is lost.
    final lifecycle = PatientRealtimeLifecycle();
    final releaseStart = Completer<void>();
    final calls = <String>[];

    lifecycle.attach(
      owner: Object(),
      start: () async {
        calls.add('start');
        await releaseStart.future;
      },
      stop: ({required unsubscribe}) async => calls.add('stop:$unsubscribe'),
    );

    final blockingStart = lifecycle.queueStart();
    await Future<void>.delayed(Duration.zero);
    expect(calls, ['start']);

    final stalePauseStop = lifecycle.queueStop();
    lifecycle.beginTeardown();
    final teardown = lifecycle.completeTeardown(() async {
      calls.add('disconnect');
    });

    releaseStart.complete();
    await blockingStart;
    await stalePauseStop;
    expect(await teardown, PatientRealtimeTeardownResult.completed);

    expect(calls, ['start', 'stop:true', 'disconnect']);
  });

  test('a drain that throws is reported, not rethrown', () async {
    // The caller assigns its outcome flag from the RETURN value. A thrown
    // teardown that escaped would land in the caller's catch and be reported
    // as a clean logout — exactly the silent degradation the bound exists to
    // make visible.
    final lifecycle = PatientRealtimeLifecycle();
    lifecycle.attach(
      owner: Object(),
      start: () async {},
      stop: ({required unsubscribe}) async =>
          throw StateError('socket blew up'),
    );

    lifecycle.beginTeardown();
    expect(
      await lifecycle.completeTeardown(() async {}),
      PatientRealtimeTeardownResult.failed,
    );
    expect(lifecycle.isTearingDown, isFalse);
  });

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
