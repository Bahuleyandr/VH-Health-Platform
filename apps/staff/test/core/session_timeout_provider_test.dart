import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/providers/session_timeout_provider.dart';

void main() {
  group('SessionTimeoutProvider', () {
    test(
      'marks the session expired and runs privacy cleanup on idle timeout',
      () async {
        var cleanupCount = 0;
        final provider = SessionTimeoutProvider(
          timeoutDuration: const Duration(milliseconds: 10),
          onTimeoutCleanup: () async {
            cleanupCount += 1;
          },
        );
        addTearDown(provider.dispose);

        provider.startTracking();
        await Future<void>.delayed(const Duration(milliseconds: 40));

        expect(provider.isSessionExpired, isTrue);
        expect(cleanupCount, 1);
      },
    );

    test('recordActivity restarts the idle window', () async {
      var cleanupCount = 0;
      final provider = SessionTimeoutProvider(
        timeoutDuration: const Duration(milliseconds: 50),
        onTimeoutCleanup: () async {
          cleanupCount += 1;
        },
      );
      addTearDown(provider.dispose);

      provider.startTracking();
      await Future<void>.delayed(const Duration(milliseconds: 25));
      provider.recordActivity();
      await Future<void>.delayed(const Duration(milliseconds: 30));

      expect(provider.isSessionExpired, isFalse);
      expect(cleanupCount, 0);

      await Future<void>.delayed(const Duration(milliseconds: 35));

      expect(provider.isSessionExpired, isTrue);
      expect(cleanupCount, 1);
    });

    test('stopTracking cancels the idle timer', () async {
      var cleanupCount = 0;
      final provider = SessionTimeoutProvider(
        timeoutDuration: const Duration(milliseconds: 10),
        onTimeoutCleanup: () async {
          cleanupCount += 1;
        },
      );
      addTearDown(provider.dispose);

      provider.startTracking();
      provider.stopTracking();
      await Future<void>.delayed(const Duration(milliseconds: 40));

      expect(provider.isSessionExpired, isFalse);
      expect(cleanupCount, 0);
    });
  });
}
