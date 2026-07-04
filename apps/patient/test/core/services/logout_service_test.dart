import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/logout_service.dart';

void main() {
  tearDown(LogoutService.debugResetDependencies);

  test(
    'logout clears realtime, caches, staging, and user provider state',
    () async {
      final calls = <String>[];
      LogoutService.debugSetDependencies(_dependencies(calls));

      await LogoutService.logout();

      expect(calls, [
        'websocket',
        'realtime',
        'push-user',
        'notifications',
        'secure-storage',
        'api-cache',
        'file-cache',
        'doc-staging',
        'cycle-tracker',
        'user-provider',
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
        ]),
      );
    },
  );
}

LogoutServiceDependencies _dependencies(List<String> calls, {String? throwOn}) {
  LogoutStep step(String name) {
    return () {
      calls.add(name);
      if (throwOn == name) throw StateError('$name failed');
    };
  }

  return LogoutServiceDependencies(
    disconnectWebSocket: step('websocket'),
    disconnectRealtime: step('realtime'),
    clearPushSignedInUser: step('push-user'),
    cancelNotifications: step('notifications'),
    clearSecureStorage: step('secure-storage'),
    clearApiCache: step('api-cache'),
    clearDownloadedFileCache: step('file-cache'),
    purgeDocumentStaging: step('doc-staging'),
    clearCycleTracker: step('cycle-tracker'),
    clearUserProvider: step('user-provider'),
  );
}
