import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/auth_service.dart';

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

  group('AuthService — clearAll', () {
    test(
      'wipes JWT, refresh token, phone, role, employeeId, staffId',
      () async {
        await AuthService.setJwt('access-123');
        await AuthService.setRefreshToken('refresh-xyz');
        await AuthService.setUserPhone('+919999999999');
        await AuthService.setUserRole('PATIENT');
        await AuthService.setEmployeeId('EMP-001');
        await AuthService.setStaffId('42');

        await AuthService.clearAll();

        expect(await AuthService.getJwt(), isNull);
        expect(await AuthService.getRefreshToken(), isNull);
        expect(await AuthService.getUserPhone(), isNull);
        expect(await AuthService.getUserRole(), isNull);
        expect(await AuthService.getEmployeeId(), isNull);
        expect(await AuthService.getStaffId(), isNull);
      },
    );
  });
}
