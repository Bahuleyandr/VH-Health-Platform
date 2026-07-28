import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/secure_storage.dart';

/// Install an in-memory fake for the flutter_secure_storage method channel
/// so [AuthService] can be unit-tested without the native plugin.
void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final Map<String, String> store = {};

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = Map<String, dynamic>.from(call.arguments as Map);
        switch (call.method) {
          case 'read':
            return store[args['key']];
          case 'write':
            store[args['key']] = args['value'] as String;
            return null;
          case 'delete':
            store.remove(args['key']);
            return null;
          case 'readAll':
            return Map<String, String>.from(store);
          case 'deleteAll':
            store.clear();
            return null;
          case 'containsKey':
            return store.containsKey(args['key']);
          default:
            return null;
        }
      });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(_installSecureStorageFake);

  tearDown(() async {
    await AuthService.clearAll();
  });

  group('AuthService — JWT (access token)', () {
    test('setJwt / getJwt round-trip', () async {
      await AuthService.setJwt('access-123');
      expect(await AuthService.getJwt(), 'access-123');
    });

    test('clearJwt removes the stored token', () async {
      await AuthService.setJwt('access-123');
      await AuthService.clearJwt();
      expect(await AuthService.getJwt(), isNull);
    });

    test('isLoggedIn reflects JWT presence', () async {
      expect(await AuthService.isLoggedIn(), isFalse);
      await AuthService.setJwt('access-123');
      expect(await AuthService.isLoggedIn(), isTrue);
      await AuthService.clearJwt();
      expect(await AuthService.isLoggedIn(), isFalse);
    });
  });

  group('AuthService — refresh token', () {
    test('setRefreshToken / getRefreshToken round-trip', () async {
      await AuthService.setRefreshToken('refresh-xyz');
      expect(await AuthService.getRefreshToken(), 'refresh-xyz');
    });

    test('clearRefreshToken removes the stored token', () async {
      await AuthService.setRefreshToken('refresh-xyz');
      await AuthService.clearRefreshToken();
      expect(await AuthService.getRefreshToken(), isNull);
    });

    test('clearJwt does NOT clear refresh token (independent keys)', () async {
      await AuthService.setJwt('access-123');
      await AuthService.setRefreshToken('refresh-xyz');
      await AuthService.clearJwt();
      expect(await AuthService.getJwt(), isNull);
      expect(await AuthService.getRefreshToken(), 'refresh-xyz');
    });
  });

  group('AuthService — setTokens', () {
    test('persists both tokens when refreshToken provided', () async {
      await AuthService.setTokens(
        accessToken: 'access-123',
        refreshToken: 'refresh-xyz',
      );
      expect(await AuthService.getJwt(), 'access-123');
      expect(await AuthService.getRefreshToken(), 'refresh-xyz');
    });

    test('persists only access when refreshToken omitted', () async {
      await AuthService.setTokens(accessToken: 'access-123');
      expect(await AuthService.getJwt(), 'access-123');
      expect(await AuthService.getRefreshToken(), isNull);
    });

    test('ignores empty refreshToken (preserves existing)', () async {
      await AuthService.setRefreshToken('original-refresh');
      await AuthService.setTokens(accessToken: 'access-new', refreshToken: '');
      expect(await AuthService.getJwt(), 'access-new');
      expect(await AuthService.getRefreshToken(), 'original-refresh');
    });
  });

  group('AuthService — session-only clear', () {
    test(
      'wipes identity but preserves device-bound queue encryption key',
      () async {
        await AuthService.setJwt('access-123');
        await AuthService.setRefreshToken('refresh-xyz');
        await AuthService.setUserPhone('+919999999999');
        await AuthService.setUserRole('PATIENT');
        await AuthService.setEmployeeId('EMP-001');
        await AuthService.setStaffId('42');
        await VHSecureStorage.instance.write(
          key: 'offline_queue_aes_key',
          value: 'device-bound-key',
        );

        await AuthService.clearSessionIdentity();

        expect(await AuthService.getJwt(), isNull);
        expect(await AuthService.getRefreshToken(), isNull);
        expect(await AuthService.getUserPhone(), isNull);
        expect(await AuthService.getUserRole(), isNull);
        expect(await AuthService.getEmployeeId(), isNull);
        expect(await AuthService.getStaffId(), isNull);
        expect(
          await VHSecureStorage.instance.read(key: 'offline_queue_aes_key'),
          'device-bound-key',
        );
      },
    );
  });

  group('AuthService — staff owner id', () {
    test('setStaffId writes both core and staff-app key spellings', () async {
      await AuthService.setStaffId('staff-42');

      expect(await AuthService.getStaffId(), 'staff-42');
      expect(await VHSecureStorage.instance.read(key: 'staffId'), 'staff-42');
      expect(await VHSecureStorage.instance.read(key: 'staff_id'), 'staff-42');
    });

    test('getStaffId falls back to legacy staff_id key', () async {
      await VHSecureStorage.instance.write(key: 'staff_id', value: 'legacy-7');

      expect(await AuthService.getStaffId(), 'legacy-7');
    });
  });
}
