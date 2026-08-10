import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/logout_service.dart';

void main() {
  tearDown(LogoutService.debugResetDependencies);

  test(
    'logout revokes both server sessions first, clears realtime, caches, '
    'staging and user provider state, and signs out of Firebase last',
    () async {
      final calls = <String>[];
      LogoutService.debugSetDependencies(_dependencies(calls));

      await LogoutService.logout();

      expect(calls, [
        // Both server revocations run first, with Firebase before VH because
        // the VH logout invalidates the bearer token used by both calls; the
        // device unregister also authenticates with that token so it must
        // run before the VH revoke too.
        'firebase-server-revoke',
        'device-unregister',
        'vh-server-revoke',
        'websocket',
        'realtime',
        'push-user',
        'fcm-token',
        'notifications',
        'secure-storage',
        'api-cache',
        'file-cache',
        'doc-staging',
        'cycle-tracker',
        'dependents',
        'user-provider',
        // Firebase sign-out MUST come last: it is what fires the router's
        // auth-state refreshListenable, and by then every other logged-in
        // signal (JWT, UserProvider) must already be gone so the redirect
        // lands on /login.
        'firebase-signout',
      ]);
    },
  );

  test(
    'logout continues clearing local state when websocket teardown fails',
    () async {
      final calls = <String>[];
      LogoutService.debugSetDependencies(
        _dependencies(calls, throwOn: 'websocket'),
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
}) {
  LogoutStep step(String name) {
    return () {
      calls.add(name);
      if (throwOn == name) throw StateError('$name failed');
    };
  }

  return LogoutServiceDependencies(
    revokeFirebaseSession: () {
      calls.add('firebase-server-revoke');
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
    disconnectWebSocket: step('websocket'),
    disconnectRealtime: step('realtime'),
    clearPushSignedInUser: step('push-user'),
    deleteFcmToken: step('fcm-token'),
    cancelNotifications: step('notifications'),
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
