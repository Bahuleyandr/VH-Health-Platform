import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/logout_service.dart';

void main() {
  tearDown(() {
    LogoutService.debugResetDependencies();
    LogoutService.networkStepTimeout = const Duration(seconds: 6);
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

LogoutServiceDependencies _dependencies(
  List<String> calls, {
  String? throwOn,
  bool firebaseRevokeResult = true,
  bool vhRevokeResult = true,
  Completer<void>? firebaseRevokeGate,
}) {
  LogoutStep step(String name) {
    return () {
      calls.add(name);
      if (throwOn == name) throw StateError('$name failed');
    };
  }

  return LogoutServiceDependencies(
    revokeFirebaseSession: () async {
      calls.add('firebase-server-revoke');
      await firebaseRevokeGate?.future;
      if (throwOn == 'firebase-server-revoke') {
        throw StateError('firebase-server-revoke failed');
      }
      return firebaseRevokeResult;
    },
    unregisterDevice: step('device-unregister'),
    revokeVhSession: () {
      calls.add('vh-server-revoke');
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
  );
}
