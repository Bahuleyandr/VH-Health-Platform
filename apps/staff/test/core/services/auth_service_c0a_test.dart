import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite/sqflite.dart' as sqflite;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_core/services/auth_service.dart' as core_auth;
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_core/services/offline_queue.dart';
import 'package:vhhealth_staff/core/config/api_config.dart';
import 'package:vhhealth_staff/core/config/c0a_reconciliation_config.dart';
import 'package:vhhealth_staff/core/services/auth_service.dart';
import 'package:vhhealth_staff/core/services/recent_patients_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final secureStorage = _BlockingSecureStorage();

  setUpAll(() {
    sqfliteFfiInit();
    sqflite.databaseFactory = databaseFactoryFfi;
    OfflineQueue.debugDbFileNameOverride = 'staff_auth_service_c0a_test.db';
    C0AReconciliationConfig.registerBeforeQueueStartup();
    secureStorage.install();
  });

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    secureStorage.reset();
    VHHttpClient.resetClientForTesting();
    await RecentPatientsService.resetForTesting();
    await ConnectivitySyncService.instance.resetForTesting();
    await OfflineQueue.deleteTestDatabase();
  });

  tearDown(() async {
    VHHttpClient.resetClientForTesting();
    await RecentPatientsService.resetForTesting();
    await ConnectivitySyncService.instance.resetForTesting();
    await OfflineQueue.deleteTestDatabase();
  });

  tearDownAll(() async {
    await OfflineQueue.deleteTestDatabase();
    OfflineQueue.debugDbFileNameOverride = null;
    secureStorage.uninstall();
  });

  for (final status in ['pending', 'conflict', 'needs_review']) {
    test(
      'ordinary logout blocks current-owner $status before backend POST',
      () async {
        await _seedIdentity('staff-current');
        final id = await _enqueueVitals();
        final db = await OfflineQueue.database;
        if (status == 'conflict') {
          await OfflineQueue.markConflict(id, 'Server conflict');
        } else if (status == 'needs_review') {
          await db.update(
            'pending_writes',
            {'status': 'needs_review', 'review_reason_code': 'retry_exhausted'},
            where: 'id = ?',
            whereArgs: [id],
          );
        }

        var backendPosts = 0;
        VHHttpClient.setClientForTesting(
          MockClient((request) async {
            backendPosts += 1;
            return http.Response(jsonEncode({'success': true}), 200);
          }),
        );

        final result = await AuthService.logout();

        expect(result.isBlocked, isTrue);
        expect(result.blockingWriteCount, 1);
        expect(backendPosts, 0);
        expect(await ApiConfig.getStaffId(), 'staff-current');
        expect(await OfflineQueue.debugAllRows(), hasLength(1));
      },
    );
  }

  test(
    'ordinary logout waits for a race-time enqueue and blocks before backend POST',
    () async {
      await _seedIdentity('staff-current');

      var backendPosts = 0;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          backendPosts += 1;
          return http.Response(jsonEncode({'success': true}), 200);
        }),
      );

      secureStorage.blockRead('staffId');
      final service = ConnectivitySyncService.instance;
      final enqueue = service.enqueue(
        endpoint: '/health/records',
        method: 'POST',
        body: {
          'patient_uid': 'patient-race',
          'vital_signs': {'pulse': 91},
        },
        contextLabel: 'Vitals for patient-race',
      );
      await secureStorage.waitUntilReadBlocked().timeout(
        const Duration(seconds: 5),
        onTimeout: () =>
            throw StateError('Eligible enqueue did not reach the blocked read'),
      );

      var logoutCompleted = false;
      final logout = AuthService.logout().then((result) {
        logoutCompleted = true;
        return result;
      });
      await Future<void>.delayed(Duration.zero);

      expect(service.isSessionBarrierActive, isTrue);
      expect(logoutCompleted, isFalse);

      secureStorage.releaseRead();
      final enqueuedId = await enqueue.timeout(
        const Duration(seconds: 5),
        onTimeout: () =>
            throw StateError('Eligible enqueue did not quiesce after release'),
      );
      final result = await logout.timeout(
        const Duration(seconds: 5),
        onTimeout: () => throw StateError(
          'Logout did not complete its authoritative recheck',
        ),
      );

      expect(result.isBlocked, isTrue);
      expect(result.blockingWriteCount, 1);
      expect(backendPosts, 0);
      expect(await ApiConfig.getStaffId(), 'staff-current');
      final rows = await OfflineQueue.debugAllRows();
      expect(rows, hasLength(1));
      expect(rows.single['id'], enqueuedId);
      expect(rows.single['status'], 'pending');
      expect(rows.single['staff_id'], 'staff-current');
    },
  );

  test(
    'attested needs-review row permits logout but remains preserved',
    () async {
      await _seedIdentity('staff-current', uid: 'uid-current');
      final id = await _enqueueVitals();
      final db = await OfflineQueue.database;
      await db.update(
        'pending_writes',
        {
          'status': 'needs_review',
          'review_reason_code': 'retry_exhausted',
          'handoff_attested_at': 1774700000000,
          'handoff_attested_by': 'uid-current',
        },
        where: 'id = ?',
        whereArgs: [id],
      );
      var backendPosts = 0;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          backendPosts += 1;
          return http.Response(jsonEncode({'success': true}), 200);
        }),
      );

      final result = await AuthService.logout();

      expect(result.isSignedOut, isTrue);
      expect(backendPosts, 1);
      expect(await ApiConfig.getStaffId(), isNull);
      final rows = await OfflineQueue.debugAllRows();
      expect(rows, hasLength(1));
      expect(rows.single['status'], 'needs_review');
      expect(rows.single['handoff_attested_by'], 'uid-current');
    },
  );

  test(
    'empty-owner logout preserves other-owner row, AES key, and device key',
    () async {
      await _seedIdentity('staff-other');
      await _enqueueVitals();
      const storage = FlutterSecureStorage();
      final queueKey = await storage.read(
        key: OfflineQueue.debugEncryptionKeyName,
      );
      await _seedIdentity('staff-current');
      await AuthService.saveDeviceToken('registered-device');
      await storage.write(
        key: 'recent_patients:staff:staff-current',
        value: '[{"uid":"patient-a"}]',
      );
      VHHttpClient.setClientForTesting(
        MockClient(
          (request) async => http.Response(jsonEncode({'success': true}), 200),
        ),
      );

      final result = await AuthService.logout();

      expect(result.isSignedOut, isTrue);
      expect(await ApiConfig.getStaffId(), isNull);
      expect(await storage.read(key: 'device_token'), 'registered-device');
      expect(
        await storage.read(key: 'recent_patients:staff:staff-current'),
        isNull,
      );
      expect(
        await storage.read(key: OfflineQueue.debugEncryptionKeyName),
        queueKey,
      );
      final rows = await OfflineQueue.debugAllRows();
      expect(rows, hasLength(1));
      expect(rows.single['staff_id'], 'staff-other');
    },
  );

  test(
    'forced revocation preserves encrypted row and key across reopen',
    () async {
      await _seedIdentity('staff-current', uid: 'uid-current');
      await _enqueueVitals();
      const storage = FlutterSecureStorage();
      final queueKey = await storage.read(
        key: OfflineQueue.debugEncryptionKeyName,
      );
      await storage.write(
        key: 'recent_patients:staff:staff-current',
        value: '[{"uid":"patient-a"}]',
      );
      var backendPosts = 0;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          backendPosts += 1;
          return http.Response(jsonEncode({'success': true}), 200);
        }),
      );

      final preservedCount = await AuthService.forceLogoutForRevocation();

      expect(preservedCount, 1);
      expect(backendPosts, 0);
      expect(await ApiConfig.getStaffId(), isNull);
      expect(
        await storage.read(key: OfflineQueue.debugEncryptionKeyName),
        queueKey,
      );
      expect(
        await storage.read(key: 'recent_patients:staff:staff-current'),
        isNull,
      );

      await OfflineQueue.resetForTesting();
      await _seedIdentity('staff-current', uid: 'uid-current');
      final rows = await OfflineQueue.debugAllRows();
      expect(rows, hasLength(1));
      expect(await OfflineQueue.decodeBody(rows.single['body']! as String), {
        'patient_uid': 'patient-a',
        'vital_signs': {'pulse': 88},
      });
    },
  );

  test(
    'remote device removal forces reauthentication but keeps this device token',
    () async {
      const currentInstallationId = '33333333-3333-4333-8333-333333333333';
      await _seedIdentity('staff-current');
      const storage = FlutterSecureStorage();
      await storage.write(
        key: 'staffInstallationId',
        value: currentInstallationId,
      );
      await AuthService.saveDeviceToken('current-device-token');

      final removedCurrent = await AuthService.applyDeviceRemovalRevocation(
        '44444444-4444-4444-8444-444444444444',
      );

      expect(removedCurrent, isFalse);
      expect(await ApiConfig.getStaffId(), isNull);
      expect(await AuthService.getDeviceToken(), 'current-device-token');
    },
  );

  test(
    'current device removal clears its token and forces reauthentication',
    () async {
      const currentInstallationId = '33333333-3333-4333-8333-333333333333';
      await _seedIdentity('staff-current');
      const storage = FlutterSecureStorage();
      await storage.write(
        key: 'staffInstallationId',
        value: currentInstallationId,
      );
      await AuthService.saveDeviceToken('current-device-token');

      final removedCurrent = await AuthService.applyDeviceRemovalRevocation(
        currentInstallationId,
      );

      expect(removedCurrent, isTrue);
      expect(await ApiConfig.getStaffId(), isNull);
      expect(await AuthService.getDeviceToken(), isNull);
    },
  );

  // Audit follow-up P12: logout used to swallow the backend result entirely, so
  // a failed revocation was indistinguishable from a real one.
  test('logout reports a confirmed server-side revocation', () async {
    await _seedIdentity('staff-current');
    VHHttpClient.setClientForTesting(
      MockClient(
        (request) async => http.Response(jsonEncode({'success': true}), 200),
      ),
    );

    final result = await AuthService.logout();

    expect(result.isSignedOut, isTrue);
    expect(result.serverRevocationFailed, isFalse);
  });

  test(
    'logout runs notification cleanup after the blocker gate and before revocation',
    () async {
      await _seedIdentity('staff-current');
      final events = <String>[];
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          events.add('server-revocation');
          expect(await ApiConfig.getStaffId(), 'staff-current');
          return http.Response(jsonEncode({'success': true}), 200);
        }),
      );

      final result = await AuthService.logout(
        beforeSessionRevocation: () async {
          events.add('notification-cleanup');
          expect(await ApiConfig.getStaffId(), 'staff-current');
        },
      );

      expect(result.isSignedOut, isTrue);
      expect(result.notificationTeardownFailed, isFalse);
      expect(events, ['notification-cleanup', 'server-revocation']);
      expect(await ApiConfig.getStaffId(), isNull);
    },
  );

  test('blocked logout does not tear down the notification session', () async {
    await _seedIdentity('staff-current');
    await _enqueueVitals();
    var cleanupCalls = 0;

    final result = await AuthService.logout(
      beforeSessionRevocation: () async {
        cleanupCalls += 1;
      },
    );

    expect(result.isBlocked, isTrue);
    expect(cleanupCalls, 0);
    expect(await ApiConfig.getStaffId(), 'staff-current');
  });

  test(
    'logout reports notification teardown uncertainty without trapping user',
    () async {
      await _seedIdentity('staff-current');
      VHHttpClient.setClientForTesting(
        MockClient(
          (request) async => http.Response(jsonEncode({'success': true}), 200),
        ),
      );

      final result = await AuthService.logout(
        beforeSessionRevocation: () async =>
            throw StateError('FCM unavailable'),
      );

      expect(result.isSignedOut, isTrue);
      expect(result.notificationTeardownFailed, isTrue);
      expect(result.serverRevocationFailed, isFalse);
      expect(await ApiConfig.getStaffId(), isNull);
    },
  );

  test(
    'logout still clears local state when the backend refuses, and says so',
    () async {
      // The explicit trade: never trap a staff member in a session because the
      // network is down — but never claim the token is dead when it is not.
      await _seedIdentity('staff-current');
      VHHttpClient.setClientForTesting(
        MockClient(
          (request) async => http.Response(
            jsonEncode({
              'success': false,
              'code': 'REVOCATION_STORE_UNAVAILABLE',
            }),
            503,
          ),
        ),
      );

      final result = await AuthService.logout();

      expect(result.isSignedOut, isTrue);
      expect(result.serverRevocationFailed, isTrue);
      expect(await ApiConfig.getStaffId(), isNull);
    },
  );

  test(
    'logout still clears local state when the backend is unreachable',
    () async {
      await _seedIdentity('staff-current');
      VHHttpClient.setClientForTesting(
        MockClient((request) async => throw const SocketException('offline')),
      );

      final result = await AuthService.logout();

      expect(result.isSignedOut, isTrue);
      expect(result.serverRevocationFailed, isTrue);
      expect(await ApiConfig.getStaffId(), isNull);
    },
  );
}

Future<void> _seedIdentity(String staffId, {String? uid}) async {
  await core_auth.AuthService.setTokens(
    accessToken: 'header.payload.signature',
    refreshToken: 'refresh-token',
  );
  await ApiConfig.saveJwt('header.payload.signature');
  await core_auth.AuthService.setStaffId(staffId);
  await ApiConfig.saveStaffId(staffId);
  await ApiConfig.saveStaffUid(uid ?? 'uid-$staffId');
  await ApiConfig.saveEmployeeId('EMP-1001');
  await ApiConfig.saveRole('NURSE');
}

Future<int> _enqueueVitals() {
  expect(TenantConfig.id, isNotEmpty);
  return OfflineQueue.enqueue(
    endpoint: '/health/records',
    method: 'POST',
    body: {
      'patient_uid': 'patient-a',
      'vital_signs': {'pulse': 88},
    },
    contextLabel: 'Vitals for patient-a',
  );
}

class _BlockingSecureStorage {
  static const _channel = MethodChannel(
    'plugins.it_nomads.com/flutter_secure_storage',
  );

  final Map<String, String> _values = {};
  String? _blockedReadKey;
  Completer<void>? _blockedReadReached;
  Completer<void>? _blockedReadRelease;

  void install() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, _handleMethodCall);
  }

  void uninstall() {
    releaseRead();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, null);
  }

  void reset() {
    releaseRead();
    _blockedReadReached = null;
    _values.clear();
  }

  void blockRead(String key) {
    _blockedReadKey = key;
    _blockedReadReached = Completer<void>();
    _blockedReadRelease = Completer<void>();
  }

  Future<void> waitUntilReadBlocked() {
    final reached = _blockedReadReached;
    if (reached == null) {
      throw StateError('No secure-storage read is blocked');
    }
    return reached.future;
  }

  void releaseRead() {
    _blockedReadKey = null;
    final release = _blockedReadRelease;
    _blockedReadRelease = null;
    if (release != null && !release.isCompleted) release.complete();
  }

  Future<Object?> _handleMethodCall(MethodCall call) async {
    final arguments = Map<String, dynamic>.from(call.arguments as Map);
    final key = arguments['key'] as String?;
    switch (call.method) {
      case 'read':
        if (key == _blockedReadKey && _blockedReadRelease != null) {
          final reached = _blockedReadReached;
          if (reached != null && !reached.isCompleted) reached.complete();
          await _blockedReadRelease!.future;
        }
        return _values[key];
      case 'write':
        _values[key!] = arguments['value'] as String;
        return null;
      case 'delete':
        _values.remove(key);
        return null;
      case 'readAll':
        return Map<String, String>.from(_values);
      case 'containsKey':
        return _values.containsKey(key);
      case 'deleteAll':
        throw StateError('Bulk secure-storage deletion is forbidden');
      default:
        return null;
    }
  }
}
