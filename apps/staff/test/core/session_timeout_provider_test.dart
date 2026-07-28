import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:vhhealth_core/services/auth_service.dart' as core_auth;
import 'package:vhhealth_core/services/offline_queue.dart';
import 'package:vhhealth_staff/core/config/c0a_reconciliation_config.dart';
import 'package:vhhealth_staff/core/platform_info.dart';
import 'package:vhhealth_staff/core/providers/session_timeout_provider.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
    OfflineQueue.debugDbFileNameOverride =
        'staff_session_timeout_provider_test.db';
    C0AReconciliationConfig.registerBeforeQueueStartup();
  });

  tearDownAll(() async {
    await OfflineQueue.deleteTestDatabase();
    OfflineQueue.debugDbFileNameOverride = null;
  });

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    await OfflineQueue.deleteTestDatabase();
  });

  tearDown(() async {
    await OfflineQueue.deleteTestDatabase();
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

    test('shows the 60-second warning window and still-here extends', () {
      fakeAsync((async) {
        final provider = SessionTimeoutProvider(
          timeoutDuration: const Duration(milliseconds: 90),
          warningDuration: const Duration(milliseconds: 30),
          countdownTickDuration: const Duration(milliseconds: 10),
          onTimeoutCleanup: () async {},
        );
        addTearDown(provider.dispose);

        provider.startTracking();
        async.elapse(const Duration(milliseconds: 59));
        expect(provider.isWarningVisible, isFalse);
        expect(provider.isSessionExpired, isFalse);

        async.elapse(const Duration(milliseconds: 1));
        expect(provider.isWarningVisible, isTrue);
        expect(provider.warningRemaining, const Duration(milliseconds: 30));

        async.elapse(const Duration(milliseconds: 10));
        expect(provider.warningRemaining, const Duration(milliseconds: 20));

        provider.extendSession();
        expect(provider.isWarningVisible, isFalse);
        expect(provider.isSessionExpired, isFalse);

        async.elapse(const Duration(milliseconds: 89));
        expect(provider.isSessionExpired, isFalse);
        async.elapse(const Duration(milliseconds: 1));
        async.flushMicrotasks();
        expect(provider.isSessionExpired, isTrue);
      });
    });

    test(
      'marks the session expired and runs privacy cleanup on idle timeout',
      () async {
        var cleanupCount = 0;
        final cleanupCompleted = Completer<void>();
        final provider = SessionTimeoutProvider(
          timeoutDuration: const Duration(milliseconds: 10),
          onTimeoutCleanup: () async {
            cleanupCount += 1;
            if (!cleanupCompleted.isCompleted) cleanupCompleted.complete();
          },
        );
        addTearDown(provider.dispose);

        provider.startTracking();
        expect(provider.isTracking, isTrue);
        await cleanupCompleted.future.timeout(const Duration(seconds: 2));

        expect(provider.isSessionExpired, isTrue);
        expect(provider.isTracking, isFalse);
        expect(cleanupCount, 1);
      },
    );

    test(
      'default idle cleanup clears recents and credentials but preserves owner-scoped queue',
      () async {
        FlutterSecureStorage.setMockInitialValues({
          'jwt': 'header.payload.signature',
          'staff_id': 'staff-unindexed',
          'staffId': 'staff-unindexed',
        });
        await core_auth.AuthService.setStaffId('staff-unindexed');
        SharedPreferences.setMockInitialValues({
          'recent_patients:staff:staff-unindexed': jsonEncode([
            {'uid': 'patient-a', 'name': 'Alice'},
          ]),
        });
        await OfflineQueue.enqueue(
          endpoint: '/health/records',
          method: 'POST',
          body: {
            'patient_uid': 'patient-a',
            'vital_signs': {'pulse': 88},
          },
          contextLabel: 'Vitals for patient-a',
        );

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
        expect(await storage.read(key: 'staffId'), isNull);
        expect(await storage.read(key: 'jwt'), isNull);
        expect(provider.preservedOfflineWriteCount, 1);

        await core_auth.AuthService.setStaffId('staff-unindexed');
        final pending = await OfflineQueue.getPending();
        expect(pending, hasLength(1));
        final decoded = await OfflineQueue.decodeBody(
          pending.single['body'] as String,
        );
        expect(decoded['patient_uid'], 'patient-a');
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
      final cleanupCompleted = Completer<void>();
      final provider = SessionTimeoutProvider(
        timeoutDuration: const Duration(milliseconds: 50),
        onTimeoutCleanup: () async {
          cleanupCount += 1;
          if (!cleanupCompleted.isCompleted) cleanupCompleted.complete();
        },
      );
      addTearDown(provider.dispose);

      provider.startTracking();
      await Future<void>.delayed(const Duration(milliseconds: 25));
      provider.recordActivity();
      await Future<void>.delayed(const Duration(milliseconds: 30));

      expect(provider.isSessionExpired, isFalse);
      expect(cleanupCount, 0);

      await cleanupCompleted.future.timeout(const Duration(seconds: 2));

      expect(provider.isSessionExpired, isTrue);
      expect(cleanupCount, 1);
    });

    test('changing timeout while tracking restarts the timer', () async {
      var cleanupCount = 0;
      final cleanupCompleted = Completer<void>();
      final provider = SessionTimeoutProvider(
        timeoutDuration: const Duration(milliseconds: 80),
        onTimeoutCleanup: () async {
          cleanupCount += 1;
          if (!cleanupCompleted.isCompleted) cleanupCompleted.complete();
        },
      );
      addTearDown(provider.dispose);

      provider.startTracking();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      provider.setTimeoutDuration(const Duration(milliseconds: 10));
      await cleanupCompleted.future.timeout(const Duration(seconds: 2));

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
