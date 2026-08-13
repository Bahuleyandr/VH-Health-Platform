import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/patient_realtime_lifecycle.dart';

void main() {
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
