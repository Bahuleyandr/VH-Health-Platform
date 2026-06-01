import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_staff/core/platform_info.dart';
import 'package:vhhealth_staff/core/providers/session_timeout_provider.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
  });

  group('SessionTimeoutProvider', () {
    test(
      'uses stricter idle timeout for tablet and desktop workbench modes',
      () {
        expect(
          sessionTimeoutForDeviceMode(AppDeviceMode.mobile),
          const Duration(minutes: 15),
        );
        expect(
          sessionTimeoutForDeviceMode(AppDeviceMode.tablet),
          const Duration(minutes: 10),
        );
        expect(
          sessionTimeoutForDeviceMode(AppDeviceMode.desktop),
          const Duration(minutes: 10),
        );
      },
    );

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
        expect(provider.isTracking, isTrue);
        await Future<void>.delayed(const Duration(milliseconds: 40));

        expect(provider.isSessionExpired, isTrue);
        expect(provider.isTracking, isFalse);
        expect(cleanupCount, 1);
      },
    );

    test(
      'default idle cleanup clears current staff recents before credentials',
      () async {
        FlutterSecureStorage.setMockInitialValues({
          'jwt': 'header.payload.signature',
          'staff_id': 'staff-unindexed',
        });
        SharedPreferences.setMockInitialValues({
          'recent_patients:staff:staff-unindexed': jsonEncode([
            {'uid': 'patient-a', 'name': 'Alice'},
          ]),
        });

        final provider = SessionTimeoutProvider(
          timeoutDuration: const Duration(milliseconds: 10),
        );
        addTearDown(provider.dispose);

        provider.startTracking();
        await Future<void>.delayed(const Duration(milliseconds: 40));

        final prefs = await SharedPreferences.getInstance();
        const storage = FlutterSecureStorage();
        expect(provider.isSessionExpired, isTrue);
        expect(
          prefs.getString('recent_patients:staff:staff-unindexed'),
          isNull,
        );
        expect(await storage.read(key: 'staff_id'), isNull);
        expect(await storage.read(key: 'jwt'), isNull);
      },
    );

    test('recordActivity does not start tracking before login', () async {
      var cleanupCount = 0;
      final provider = SessionTimeoutProvider(
        timeoutDuration: const Duration(milliseconds: 10),
        onTimeoutCleanup: () async {
          cleanupCount += 1;
        },
      );
      addTearDown(provider.dispose);

      provider.recordActivity();
      await Future<void>.delayed(const Duration(milliseconds: 40));

      expect(provider.isTracking, isFalse);
      expect(provider.isSessionExpired, isFalse);
      expect(cleanupCount, 0);
    });

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

    test('changing timeout while tracking restarts the timer', () async {
      var cleanupCount = 0;
      final provider = SessionTimeoutProvider(
        timeoutDuration: const Duration(milliseconds: 80),
        onTimeoutCleanup: () async {
          cleanupCount += 1;
        },
      );
      addTearDown(provider.dispose);

      provider.startTracking();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      provider.setTimeoutDuration(const Duration(milliseconds: 10));
      await Future<void>.delayed(const Duration(milliseconds: 35));

      expect(provider.isSessionExpired, isTrue);
      expect(provider.timeoutDuration, const Duration(milliseconds: 10));
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
      expect(provider.isTracking, isFalse);
      await Future<void>.delayed(const Duration(milliseconds: 40));

      expect(provider.isSessionExpired, isFalse);
      expect(cleanupCount, 0);
    });
  });
}
