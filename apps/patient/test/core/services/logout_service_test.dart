import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/crash_reporter.dart';
import 'package:vhhealth/core/services/logout_service.dart';
import 'package:vhhealth/core/services/patient_realtime_lifecycle.dart';

void main() {
  tearDown(() {
    LogoutService.debugResetDependencies();
    LogoutService.networkStepTimeout = const Duration(seconds: 6);
    PatientRealtimeLifecycle.instance.debugReset();
    CrashReporter.reset();
  });

  test(
    'logout fences realtime first, clears caches and identity, then performs '
    'a final disconnect after Firebase sign-out',
    () async {
      final calls = <String>[];
      LogoutService.debugSetDependencies(_dependencies(calls));

      await LogoutService.logout();

      expect(calls, [
        // The generation fence itself is synchronous and is covered by the
        // dedicated PatientRealtimeLifecycle race tests.
        // Both server revocations run first, with Firebase before VH because
        // the VH logout invalidates the bearer token used by both calls; the
        // device unregister also authenticates with that token so it must
        // run before the VH revoke too.
        'firebase-server-revoke',
        'device-unregister',
        'vh-server-revoke',
        'realtime',
        'push-user',
        'fcm-token',
        'notifications',
        'health-sync',
        'api-cache',
        'secure-storage',
        'file-cache',
        'doc-staging',
        'cycle-tracker',
        'dependents',
        'user-provider',
        // Firebase sign-out is the final identity-state change: it fires the
        // router's auth-state refreshListenable only after JWT/UserProvider are
        // gone. The final transport disconnect then drains behind the fence.
        'firebase-signout',
        // Final disconnect runs after the secure-storage credential wipe and
        // after any in-flight lifecycle start has drained.
        'realtime',
      ]);
    },
  );

  test(
    'logout continues clearing local state when realtime teardown fails',
    () async {
      final calls = <String>[];
      LogoutService.debugSetDependencies(
        _dependencies(calls, throwOn: 'realtime'),
      );

      await LogoutService.logout();

      expect(
        calls,
        containsAll(<String>[
          'api-cache',
          'file-cache',
          'doc-staging',
          'cycle-tracker',
          'user-provider',
          'firebase-signout',
        ]),
      );
    },
  );

  test(
    'logout still signs out of Firebase when earlier teardown steps fail',
    () async {
      final calls = <String>[];
      LogoutService.debugSetDependencies(
        _dependencies(calls, throwOn: 'secure-storage'),
      );

      await LogoutService.logout();

      expect(calls, contains('firebase-signout'));
    },
  );

  test(
    'health sync cleanup failure cannot prevent the credential wipe',
    () async {
      final calls = <String>[];
      LogoutService.debugSetDependencies(
        _dependencies(calls, throwOn: 'health-sync'),
      );

      await expectLater(LogoutService.logout(), completes);

      expect(calls, containsAllInOrder(['health-sync', 'api-cache']));
    },
  );

  test(
    'logout still signs out of Firebase when user provider clearing fails',
    () async {
      final calls = <String>[];
      LogoutService.debugSetDependencies(
        _dependencies(calls, throwOn: 'user-provider'),
      );

      await expectLater(LogoutService.logout(), completes);

      expect(calls, contains('firebase-signout'));
      expect(
        calls.indexOf('firebase-signout'),
        greaterThan(calls.indexOf('user-provider')),
      );
    },
  );

  test('logout does not throw when Firebase sign-out itself fails', () async {
    final calls = <String>[];
    LogoutService.debugSetDependencies(
      _dependencies(calls, throwOn: 'firebase-signout'),
    );

    await expectLater(LogoutService.logout(), completes);
    expect(calls, contains('firebase-signout'));
  });

  test('FCM token deletion still runs when push user cleanup fails', () async {
    final calls = <String>[];
    LogoutService.debugSetDependencies(
      _dependencies(calls, throwOn: 'push-user'),
    );

    await LogoutService.logout();

    expect(calls, contains('fcm-token'));
    expect(calls, contains('secure-storage'));
  });

  test('overlapping logout triggers share one teardown', () async {
    final calls = <String>[];
    final gate = Completer<void>();
    LogoutService.debugSetDependencies(
      _dependencies(calls, firebaseRevokeGate: gate),
    );

    final first = LogoutService.logout();
    final second = LogoutService.logout();
    await Future<void>.delayed(Duration.zero);
    expect(
      calls.where((call) => call == 'firebase-server-revoke'),
      hasLength(1),
    );

    gate.complete();
    final outcomes = await Future.wait([first, second]);
    expect(outcomes.every((outcome) => outcome.serverSessionRevoked), isTrue);
    expect(calls.where((call) => call == 'firebase-signout'), hasLength(1));
  });

  test('logout reports a confirmed server-side revocation', () async {
    final calls = <String>[];
    LogoutService.debugSetDependencies(_dependencies(calls));

    final outcome = await LogoutService.logout();

    expect(outcome.serverSessionRevoked, isTrue);
  });

  test(
    'a refused VH revocation still clears local state, and is reported',
    () async {
      // The trade this pins: being offline (or refused) must never trap a user
      // in a signed-in session, but it must not be reported as a full logout
      // either — the VH JWT is still live on the server.
      final calls = <String>[];
      LogoutService.debugSetDependencies(
        _dependencies(calls, vhRevokeResult: false),
      );

      final outcome = await LogoutService.logout();

      expect(outcome.serverSessionRevoked, isFalse);
      expect(calls, containsAll(<String>['secure-storage', 'user-provider']));
      expect(calls.where((call) => call == 'realtime'), hasLength(2));
      expect(
        calls.lastIndexOf('realtime'),
        greaterThan(calls.indexOf('secure-storage')),
      );
    },
  );

  test(
    'a throwing Firebase revocation still attempts VH, clears local state, and is reported',
    () async {
      final calls = <String>[];
      LogoutService.debugSetDependencies(
        _dependencies(calls, throwOn: 'firebase-server-revoke'),
      );

      final outcome = await LogoutService.logout();

      expect(outcome.serverSessionRevoked, isFalse);
      expect(calls, contains('vh-server-revoke'));
      expect(calls, containsAll(<String>['secure-storage', 'user-provider']));
    },
  );

  test('a hung server revocation is abandoned at the logout deadline and the '
      'local PHI wipe still runs', () async {
    // Pins the give-up contract: the pre-wipe network calls get a hard
    // per-step ceiling (networkStepTimeout), so a dead network can never
    // hold the wipe hostage long enough that a user force-kills the app
    // with the JWT and PHI caches still on disk.
    LogoutService.networkStepTimeout = const Duration(milliseconds: 50);
    final calls = <String>[];
    LogoutService.debugSetDependencies(
      _dependencies(
        calls,
        // Never completes — simulates a black-holed request.
        firebaseRevokeGate: Completer<void>(),
      ),
    );

    final outcome = await LogoutService.logout().timeout(
      const Duration(seconds: 5),
    );

    expect(outcome.firebaseSessionRevoked, isFalse);
    expect(outcome.serverSessionRevoked, isFalse);
    // Every later step — including the full local teardown — still ran.
    expect(
      calls,
      containsAll(<String>[
        'device-unregister',
        'vh-server-revoke',
        'secure-storage',
        'api-cache',
        'file-cache',
        'doc-staging',
        'user-provider',
        'firebase-signout',
      ]),
    );
  });

  test(
    'all three revocations hanging still completes quickly and wipes',
    () async {
      LogoutService.networkStepTimeout = const Duration(milliseconds: 50);
      final never = Completer<void>();
      final calls = <String>[];
      final base = _dependencies(calls);
      LogoutService.debugSetDependencies(
        LogoutServiceDependencies(
          revokeFirebaseSession: () async {
            calls.add('firebase-server-revoke');
            await never.future;
            return true;
          },
          unregisterDevice: () async {
            calls.add('device-unregister');
            await never.future;
          },
          revokeVhSession: () async {
            calls.add('vh-server-revoke');
            await never.future;
            return true;
          },
          disconnectRealtime: base.disconnectRealtime,
          clearPushSignedInUser: base.clearPushSignedInUser,
          deleteFcmToken: base.deleteFcmToken,
          cancelNotifications: base.cancelNotifications,
          clearHealthSyncState: base.clearHealthSyncState,
          clearSecureStorage: base.clearSecureStorage,
          clearApiCache: base.clearApiCache,
          clearDownloadedFileCache: base.clearDownloadedFileCache,
          purgeDocumentStaging: base.purgeDocumentStaging,
          clearCycleTracker: base.clearCycleTracker,
          clearDependentsProvider: base.clearDependentsProvider,
          clearUserProvider: base.clearUserProvider,
          signOutFirebase: base.signOutFirebase,
        ),
      );

      final stopwatch = Stopwatch()..start();
      final outcome = await LogoutService.logout().timeout(
        const Duration(seconds: 5),
      );
      stopwatch.stop();

      expect(outcome.serverSessionRevoked, isFalse);
      expect(
        calls,
        containsAll(<String>['secure-storage', 'firebase-signout']),
      );
      // 3 hung steps x 50ms deadline — generous margin, but far below the
      // ~144s the default transport policy would have allowed.
      expect(stopwatch.elapsed, lessThan(const Duration(seconds: 3)));
    },
  );

  test(
    'logout COMPLETES when the realtime stop never resolves — the hang case',
    () async {
      // THE regression test for this packet. Before the bound, a genuinely
      // dead / black-holed socket left `_stop` pending forever, so
      // LogoutService.logout() never returned and the blocking "Signing out…"
      // dialog spun until the user force-quit — reaching the SAME server-side
      // outcome, only later and with no telemetry.
      PatientRealtimeLifecycle.stopTimeout = const Duration(milliseconds: 50);
      PatientRealtimeLifecycle.instance.attach(
        owner: Object(),
        start: () async {},
        // Never completes.
        stop: ({required unsubscribe}) => Completer<void>().future,
      );
      final calls = <String>[];
      LogoutService.debugSetDependencies(_dependencies(calls));

      final outcome = await LogoutService.logout().timeout(
        const Duration(seconds: 5),
        onTimeout: () => fail('logout() hung on the wedged realtime stop'),
      );

      expect(outcome.realtimeTeardownTimedOut, isTrue);
      // The server-side revocation is the authoritative severance and it still
      // happened, so this is a clean logout — not a failed one.
      expect(outcome.serverSessionRevoked, isTrue);
      // Every local wipe step ran, and the final disconnect was still
      // ATTEMPTED (2 realtime calls: step 1 plus the bounded final one).
      expect(
        calls,
        containsAll(<String>[
          'secure-storage',
          'api-cache',
          'file-cache',
          'doc-staging',
          'cycle-tracker',
          'user-provider',
          'firebase-signout',
        ]),
      );
      expect(calls.where((call) => call == 'realtime'), hasLength(2));
      expect(
        calls.lastIndexOf('realtime'),
        greaterThan(calls.indexOf('secure-storage')),
        reason:
            'The bound must not reorder the final disconnect ahead of the '
            'credential wipe.',
      );
    },
  );

  test(
    'logout COMPLETES when the realtime stop AND the disconnect BOTH hang',
    () async {
      // The PRODUCTION configuration, which the previous hang test could not
      // reproduce. `disconnectRealtime` is `RealtimeClient.instance.disconnect`
      // and the lifecycle `stop` reaches the same singleton method through
      // main.dart's `_stopRealtime` → `RealtimeProvider.disconnect`. On a dead
      // or black-holed socket BOTH wedge, on the same pending `sink.close()` —
      // so the escape-hatch disconnect the teardown performs on expiry used to
      // re-enter the very wedge it was escaping, and logout never returned.
      // The old test paired a hung stop with an instantly-returning
      // disconnect, a pairing that cannot occur.
      PatientRealtimeLifecycle.stopTimeout = const Duration(milliseconds: 50);
      PatientRealtimeLifecycle.instance.attach(
        owner: Object(),
        start: () async {},
        stop: ({required unsubscribe}) => Completer<void>().future,
      );
      final calls = <String>[];
      LogoutService.debugSetDependencies(
        _dependencies(calls, hangOn: const {'realtime'}),
      );

      final outcome = await LogoutService.logout().timeout(
        const Duration(seconds: 5),
        onTimeout: () =>
            fail('logout() hung on the wedged realtime stop AND disconnect'),
      );

      expect(outcome.realtimeTeardownTimedOut, isTrue);
      expect(outcome.serverSessionRevoked, isTrue);
      // Both disconnects were still ATTEMPTED, and the whole PHI wipe ran
      // between them.
      expect(calls.where((call) => call == 'realtime'), hasLength(2));
      expect(
        calls,
        containsAll(<String>[
          'secure-storage',
          'api-cache',
          'file-cache',
          'doc-staging',
          'cycle-tracker',
          'user-provider',
          'firebase-signout',
        ]),
      );
    },
  );

  test(
    'a wedged step-1 realtime disconnect can no longer strand PHI on the device',
    () async {
      // The motivating case, and the one the bound at the END of logout did
      // NOT fix. Step 1 runs BEFORE every local wipe and calls the same
      // `RealtimeClient.instance.disconnect()` that wedges on a dead socket.
      // Unbounded, logout hung right there: the teardown bound further down was
      // never reached, and the JWT, the API cache, cached documents and staged
      // plaintext PHI all survived on the device until the user force-quit.
      PatientRealtimeLifecycle.stopTimeout = const Duration(milliseconds: 50);
      final calls = <String>[];
      LogoutService.debugSetDependencies(
        _dependencies(calls, hangOn: const {'realtime'}),
      );

      final outcome = await LogoutService.logout().timeout(
        const Duration(seconds: 5),
        onTimeout: () =>
            fail('logout() hung at the step-1 realtime disconnect'),
      );

      expect(
        calls,
        containsAllInOrder(<String>['realtime', 'secure-storage']),
        reason: 'the wipe must proceed THROUGH the wedged disconnect',
      );
      expect(
        calls,
        containsAll(<String>[
          'api-cache',
          'secure-storage',
          'file-cache',
          'doc-staging',
          'cycle-tracker',
          'dependents',
          'user-provider',
          'firebase-signout',
        ]),
      );
      expect(outcome.serverSessionRevoked, isTrue);
    },
  );

  test('a wedged FCM token delete cannot hold the rest of logout', () async {
    // `FirebaseMessaging.deleteToken()` is a network round trip, and it had no
    // ceiling of its own — so it belonged in the honest worst-case ceiling or
    // in a bound. It is now bounded.
    LogoutService.networkStepTimeout = const Duration(milliseconds: 50);
    final calls = <String>[];
    LogoutService.debugSetDependencies(
      _dependencies(calls, hangOn: const {'fcm-token'}),
    );

    await LogoutService.logout().timeout(
      const Duration(seconds: 5),
      onTimeout: () => fail('logout() hung on the FCM token delete'),
    );

    expect(
      calls,
      containsAllInOrder(<String>[
        'fcm-token',
        'secure-storage',
        'firebase-signout',
      ]),
    );
  });

  test('a wedged Firebase sign-out cannot hold logout open', () async {
    LogoutService.networkStepTimeout = const Duration(milliseconds: 50);
    final calls = <String>[];
    LogoutService.debugSetDependencies(
      _dependencies(calls, hangOn: const {'firebase-signout'}),
    );

    final outcome = await LogoutService.logout().timeout(
      const Duration(seconds: 5),
      onTimeout: () => fail('logout() hung on the Firebase sign-out'),
    );

    expect(calls, contains('firebase-signout'));
    expect(outcome.serverSessionRevoked, isTrue);
  });

  test('EVERY bounded step wedging in the same logout still returns, and still '
      'wipes', () async {
    // Substantiates the worst-case ceiling documented on LogoutService: it is
    // the SUM of the per-step bounds, with no unbounded network or socket
    // call left in the path. If a future step is added without a bound, this
    // test hangs.
    LogoutService.networkStepTimeout = const Duration(milliseconds: 50);
    PatientRealtimeLifecycle.stopTimeout = const Duration(milliseconds: 50);
    PatientRealtimeLifecycle.instance.attach(
      owner: Object(),
      start: () async {},
      stop: ({required unsubscribe}) => Completer<void>().future,
    );
    final calls = <String>[];
    LogoutService.debugSetDependencies(
      _dependencies(
        calls,
        hangOn: const {
          'firebase-server-revoke',
          'device-unregister',
          'vh-server-revoke',
          'realtime',
          'fcm-token',
          'firebase-signout',
        },
      ),
    );

    final stopwatch = Stopwatch()..start();
    final outcome = await LogoutService.logout().timeout(
      const Duration(seconds: 5),
      onTimeout: () => fail('an unbounded step remains in the logout path'),
    );
    stopwatch.stop();

    expect(outcome.serverSessionRevoked, isFalse);
    expect(outcome.realtimeTeardownTimedOut, isTrue);
    // The local PHI wipe is never the thing that gets skipped.
    expect(
      calls,
      containsAll(<String>[
        'api-cache',
        'secure-storage',
        'file-cache',
        'doc-staging',
        'cycle-tracker',
        'dependents',
        'user-provider',
      ]),
    );
    // 7 bounded steps x 50ms, plus the degradation report. Generous margin,
    // but orders of magnitude below "never".
    expect(stopwatch.elapsed, lessThan(const Duration(seconds: 3)));
  });

  test('the teardown timeout is RECORDED, never swallowed', () async {
    // A silently-swallowed bound recreates exactly the quiet-degradation class
    // this codebase keeps being audited for: nobody would learn that patient
    // devices are wedging on teardown.
    final reporter = _RecordingCrashReporter();
    CrashReporter.install(reporter);
    PatientRealtimeLifecycle.stopTimeout = const Duration(milliseconds: 50);
    PatientRealtimeLifecycle.instance.attach(
      owner: Object(),
      start: () async {},
      stop: ({required unsubscribe}) => Completer<void>().future,
    );
    LogoutService.debugSetDependencies(_dependencies(<String>[]));

    final outcome = await LogoutService.logout().timeout(
      const Duration(seconds: 5),
    );

    expect(outcome.realtimeTeardownTimedOut, isTrue);
    expect(reporter.errors, hasLength(1));
    expect(reporter.errors.single.context, 'LogoutService.completeTeardown');
    expect(reporter.errors.single.extra['timeout_ms'], 50);
  });

  test('a teardown inside the bound reports no timeout', () async {
    PatientRealtimeLifecycle.instance.attach(
      owner: Object(),
      start: () async {},
      stop: ({required unsubscribe}) async {},
    );
    final reporter = _RecordingCrashReporter();
    CrashReporter.install(reporter);
    LogoutService.debugSetDependencies(_dependencies(<String>[]));

    final outcome = await LogoutService.logout();

    expect(outcome.realtimeTeardownTimedOut, isFalse);
    expect(reporter.errors, isEmpty);
  });

  test(
    'a failed server revocation tells the user AND durably queues the retry',
    () async {
      // No false "signed out everywhere" claim: local teardown always
      // completes, so without a durable handle the departing JWT would simply
      // stay live server-side for the rest of its 7-day life with nothing on
      // the device able to kill it.
      final store = _FakeRevocationStore(sessionToken: 'jwt-abc');
      LogoutService.debugSetDependencies(
        _dependencies(<String>[], vhRevokeResult: false, store: store),
      );

      final outcome = await LogoutService.logout();

      // Told honestly.
      expect(outcome.serverSessionRevoked, isFalse);
      // And a retry genuinely exists.
      expect(outcome.revocationRetryQueued, isTrue);
      expect(store.record, isNotNull);
      final record = jsonDecode(store.record!) as Map<String, dynamic>;
      expect(record['version'], 1);
      expect(record['token'], 'jwt-abc');
      expect(record['vhPending'], isTrue);
      expect(record['firebasePending'], isFalse);
      // Parked under a key that is never an authentication source — storing it
      // as `jwt` would resurrect the signed-out user on the next app start.
      expect(store.recordKeyIsSessionKey, isFalse);
    },
  );

  test(
    'a confirmed revocation queues nothing and leaves no credential behind',
    () async {
      final store = _FakeRevocationStore(sessionToken: 'jwt-abc');
      LogoutService.debugSetDependencies(
        _dependencies(<String>[], store: store),
      );

      final outcome = await LogoutService.logout();

      expect(outcome.serverSessionRevoked, isTrue);
      expect(outcome.revocationRetryQueued, isFalse);
      expect(store.record, isNull);
    },
  );

  test(
    'a failed revocation with no captured token does NOT claim a retry',
    () async {
      // Promising a retry that cannot exist is the same false reassurance the
      // honest-reporting rule forbids.
      final store = _FakeRevocationStore(sessionToken: null);
      LogoutService.debugSetDependencies(
        _dependencies(<String>[], vhRevokeResult: false, store: store),
      );

      final outcome = await LogoutService.logout();

      expect(outcome.serverSessionRevoked, isFalse);
      expect(outcome.revocationRetryQueued, isFalse);
      expect(store.record, isNull);
    },
  );

  test('the queued retry revokes on the next signed-out start', () async {
    final store = _FakeRevocationStore(sessionToken: null)
      ..record = _pendingRecord(token: 'jwt-abc', vhPending: true);
    LogoutService.debugSetDependencies(_dependencies(<String>[], store: store));

    expect(
      await LogoutService.retryPendingRevocation(),
      PendingRevocationRetry.revoked,
    );
    expect(store.vhRetryBearers, ['jwt-abc']);
    expect(store.record, isNull, reason: 'A confirmed retry must be deleted.');
  });

  test('a still-failing retry keeps the handle for a later attempt', () async {
    final store = _FakeRevocationStore(sessionToken: null, retrySucceeds: false)
      ..record = _pendingRecord(token: 'jwt-abc', vhPending: true);
    LogoutService.debugSetDependencies(_dependencies(<String>[], store: store));

    expect(
      await LogoutService.retryPendingRevocation(),
      PendingRevocationRetry.stillFailing,
    );
    expect(store.record, isNotNull);
  });

  test(
    'the retry defers while a session is live — it must not sign out a fresh '
    'login',
    () async {
      // /auth/logout bumps the identity token epoch, which would invalidate a
      // session minted AFTER this record was queued.
      final store = _FakeRevocationStore(sessionToken: 'fresh-jwt')
        ..record = _pendingRecord(token: 'jwt-abc', vhPending: true);
      LogoutService.debugSetDependencies(
        _dependencies(<String>[], store: store),
      );

      expect(
        await LogoutService.retryPendingRevocation(),
        PendingRevocationRetry.deferredLiveSession,
      );
      expect(store.vhRetryBearers, isEmpty);
      expect(store.record, isNotNull);
    },
  );

  test(
    'a login that lands mid-drain defers the epoch-bumping VH revoke',
    () async {
      // TOCTOU: the live-session probe used to run ONCE, at the top of the
      // drain, and the VH revoke could then fire whole network round trips
      // later. A login completing in that window is bumped by /auth/logout's
      // token-epoch increment and signed straight back out, seconds after
      // signing in, with nothing on screen to explain it.
      final store = _FakeRevocationStore(sessionToken: null)
        ..signInDuringFirebaseRetry = 'fresh-jwt'
        ..record = _pendingRecord(
          token: 'jwt-abc',
          firebasePending: true,
          vhPending: true,
        );
      LogoutService.debugSetDependencies(
        _dependencies(<String>[], store: store),
      );

      expect(
        await LogoutService.retryPendingRevocation(),
        PendingRevocationRetry.deferredLiveSession,
      );
      expect(
        store.vhRetryBearers,
        isEmpty,
        reason: 'the epoch bump must not reach the session that just started',
      );
      // The handle survives, narrowed by the Firebase step that DID land.
      final record = jsonDecode(store.record!) as Map<String, dynamic>;
      expect(record['firebasePending'], isFalse);
      expect(record['vhPending'], isTrue);
    },
  );

  test(
    'a login that appears while the VH revoke is in flight is REPORTED',
    () async {
      // The residual window no client-side check can close: between the probe
      // and the backend acting on the revoke. It cannot be prevented, so it
      // must not be invisible — the user is about to be signed out and support
      // needs to know this happens.
      final reporter = _RecordingCrashReporter();
      CrashReporter.install(reporter);
      final store = _FakeRevocationStore(sessionToken: null)
        ..signInDuringVhRetry = 'fresh-jwt'
        ..record = _pendingRecord(token: 'jwt-abc', vhPending: true);
      LogoutService.debugSetDependencies(
        _dependencies(<String>[], store: store),
      );

      expect(
        await LogoutService.retryPendingRevocation(),
        PendingRevocationRetry.revoked,
      );
      expect(store.record, isNull);
      expect(reporter.errors, hasLength(1));
      expect(
        reporter.errors.single.context,
        'LogoutService.retryPendingRevocation',
      );
    },
  );

  test('a retry older than the cap is purged, not retried', () async {
    final store = _FakeRevocationStore(sessionToken: null)
      ..record = _pendingRecord(
        token: 'jwt-abc',
        vhPending: true,
        queuedAt: DateTime.now().toUtc().subtract(const Duration(days: 8)),
      );
    LogoutService.debugSetDependencies(_dependencies(<String>[], store: store));

    expect(
      await LogoutService.retryPendingRevocation(),
      PendingRevocationRetry.expired,
    );
    expect(store.vhRetryBearers, isEmpty);
    expect(
      store.record,
      isNull,
      reason:
          'A token past its usable life must not linger on a shared device.',
    );
  });

  test('a re-queued retry does not reset its own expiry clock', () async {
    // Otherwise a retry on every app start would hold the departed user's
    // credential on the device forever.
    final queuedAt = DateTime.now().toUtc().subtract(const Duration(days: 3));
    final store = _FakeRevocationStore(sessionToken: null, retrySucceeds: false)
      ..record = _pendingRecord(
        token: 'jwt-abc',
        vhPending: true,
        queuedAt: queuedAt,
      );
    LogoutService.debugSetDependencies(_dependencies(<String>[], store: store));

    await LogoutService.retryPendingRevocation();

    final record = jsonDecode(store.record!) as Map<String, dynamic>;
    expect(DateTime.parse(record['queuedAt'] as String), queuedAt);
  });

  test('draining with nothing queued is a no-op', () async {
    final store = _FakeRevocationStore(sessionToken: null);
    LogoutService.debugSetDependencies(_dependencies(<String>[], store: store));

    expect(
      await LogoutService.retryPendingRevocation(),
      PendingRevocationRetry.nothingQueued,
    );
  });

  test(
    'a refused Firebase revocation makes the combined outcome false',
    () async {
      final calls = <String>[];
      LogoutService.debugSetDependencies(
        _dependencies(calls, firebaseRevokeResult: false),
      );

      final outcome = await LogoutService.logout();

      expect(outcome.firebaseSessionRevoked, isFalse);
      expect(outcome.vhSessionRevoked, isTrue);
      expect(outcome.serverSessionRevoked, isFalse);
    },
  );
}

String _pendingRecord({
  required String token,
  bool firebasePending = false,
  bool vhPending = false,
  DateTime? queuedAt,
}) => jsonEncode({
  'version': 1,
  'queuedAt': (queuedAt ?? DateTime.now().toUtc()).toIso8601String(),
  'token': token,
  'firebasePending': firebasePending,
  'vhPending': vhPending,
});

class _RecordedError {
  const _RecordedError(this.context, this.extra);
  final String? context;
  final Map<String, Object?> extra;
}

class _RecordingCrashReporter implements CrashReporter {
  final List<_RecordedError> errors = [];

  @override
  Future<void> recordError(
    Object error,
    StackTrace? stack, {
    String? context,
    Map<String, Object?> extra = const {},
    bool fatal = false,
  }) async {
    errors.add(_RecordedError(context, extra));
  }

  @override
  Future<void> log(String message) async {}

  @override
  Future<void> setUserId(String? userId) async {}

  @override
  Future<void> setCustomKey(String key, Object value) async {}
}

/// In-memory stand-in for the two secure-storage entries this path touches:
/// the live session token (`jwt`) and the pending-revocation record.
class _FakeRevocationStore {
  _FakeRevocationStore({required this.sessionToken, this.retrySucceeds = true});

  String? sessionToken;
  final bool retrySucceeds;
  String? record;
  final List<String> vhRetryBearers = [];
  final List<String> firebaseRetryBearers = [];

  /// Models a login completing WHILE a retry call is in flight — the window
  /// between the live-session probe and the server acting on the revoke.
  String? signInDuringFirebaseRetry;
  String? signInDuringVhRetry;

  /// The production key is deliberately distinct from `jwt`; this fake proves
  /// the record never lands in the session slot.
  bool get recordKeyIsSessionKey => LogoutService.pendingRevocationKey == 'jwt';

  Future<bool> retryVh(String bearer) async {
    vhRetryBearers.add(bearer);
    if (signInDuringVhRetry != null) sessionToken = signInDuringVhRetry;
    return retrySucceeds;
  }

  Future<bool> retryFirebase(String bearer) async {
    firebaseRetryBearers.add(bearer);
    if (signInDuringFirebaseRetry != null) {
      sessionToken = signInDuringFirebaseRetry;
    }
    return retrySucceeds;
  }
}

LogoutServiceDependencies _dependencies(
  List<String> calls, {
  String? throwOn,
  Set<String> hangOn = const <String>{},
  bool firebaseRevokeResult = true,
  bool vhRevokeResult = true,
  Completer<void>? firebaseRevokeGate,
  _FakeRevocationStore? store,
}) {
  LogoutStep step(String name) {
    return () {
      calls.add(name);
      if (throwOn == name) throw StateError('$name failed');
      // A step that never resolves — a black-holed socket or a dead network,
      // not a step that fails fast. Only a per-step bound escapes this.
      if (hangOn.contains(name)) return Completer<void>().future;
    };
  }

  return LogoutServiceDependencies(
    revokeFirebaseSession: () async {
      calls.add('firebase-server-revoke');
      await firebaseRevokeGate?.future;
      if (hangOn.contains('firebase-server-revoke')) {
        await Completer<void>().future;
      }
      if (throwOn == 'firebase-server-revoke') {
        throw StateError('firebase-server-revoke failed');
      }
      return firebaseRevokeResult;
    },
    unregisterDevice: step('device-unregister'),
    revokeVhSession: () async {
      calls.add('vh-server-revoke');
      if (hangOn.contains('vh-server-revoke')) await Completer<void>().future;
      if (throwOn == 'vh-server-revoke') {
        throw StateError('vh-server-revoke failed');
      }
      return vhRevokeResult;
    },
    disconnectRealtime: step('realtime'),
    clearPushSignedInUser: step('push-user'),
    deleteFcmToken: step('fcm-token'),
    cancelNotifications: step('notifications'),
    clearHealthSyncState: step('health-sync'),
    clearSecureStorage: step('secure-storage'),
    clearApiCache: step('api-cache'),
    clearDownloadedFileCache: step('file-cache'),
    purgeDocumentStaging: step('doc-staging'),
    clearCycleTracker: step('cycle-tracker'),
    clearDependentsProvider: step('dependents'),
    clearUserProvider: step('user-provider'),
    signOutFirebase: step('firebase-signout'),
    readVhToken: () => store?.sessionToken,
    readPendingRevocation: () => store?.record,
    writePendingRevocation: (value) {
      store?.record = value;
    },
    clearPendingRevocation: () {
      store?.record = null;
    },
    retryFirebaseRevocation: (bearer) async =>
        store == null || await store.retryFirebase(bearer),
    retryVhRevocation: (bearer) async =>
        store == null || await store.retryVh(bearer),
  );
}
