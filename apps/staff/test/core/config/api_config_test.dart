import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/config/api_config.dart';

String _jwtWithPayload(Map<String, dynamic> payload) {
  String part(Map<String, dynamic> data) =>
      base64Url.encode(utf8.encode(jsonEncode(data))).replaceAll('=', '');
  return '${part({'alg': 'none', 'typ': 'JWT'})}.${part(payload)}.signature';
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
  });

  group('ApiConfig staff identity', () {
    test('returns stored staff uid when available', () async {
      FlutterSecureStorage.setMockInitialValues({
        'staff_uid': 'staff-uuid-stored',
        'jwt': _jwtWithPayload({'uid': 'staff-uuid-token'}),
      });

      expect(await ApiConfig.getStaffUid(), 'staff-uuid-stored');
    });

    test('recovers and caches staff uid from existing JWT sessions', () async {
      const uid = '11111111-1111-4111-8111-111111111111';
      FlutterSecureStorage.setMockInitialValues({
        'staff_id': '97',
        'jwt': _jwtWithPayload({'id': 97, 'uid': uid, 'role': 'RECEPTIONIST'}),
      });

      expect(await ApiConfig.getStaffUid(), uid);

      const storage = FlutterSecureStorage();
      expect(await storage.read(key: 'staff_uid'), uid);
      expect(await storage.read(key: 'staff_id'), '97');
    });

    test('expired JWT shape is not an authenticated staff session', () async {
      FlutterSecureStorage.setMockInitialValues({
        'staff_jwt': _jwtWithPayload({
          'uid': '11111111-1111-4111-8111-111111111111',
          'tenant_id': '22222222-2222-4222-8222-222222222222',
          'token_epoch': 4,
          'sessionFamilyId': 'session-family-1',
          'exp': 1,
        }),
      });

      expect(await ApiConfig.isLoggedIn(), isFalse);
      expect(await ApiConfig.getStaffJwtClaims(), isNull);
    });

    test(
      'clearSessionIdentity preserves queue encryption and device keys',
      () async {
        FlutterSecureStorage.setMockInitialValues({
          'jwt': 'header.payload.signature',
          'staff_jwt': 'header.payload.signature',
          'refreshToken': 'refresh',
          'staff_id': 'staff-snake',
          'staffId': 'staff-camel',
          'staff_uid': 'staff-uid',
          'employee_id': 'EMP-1001',
          'staff_role': 'NURSE',
          'staff_phone': '9999999999',
          'offline_queue_aes_key': 'queue-key',
          'device_token': 'registered-device',
        });

        await ApiConfig.clearSessionIdentity();

        const storage = FlutterSecureStorage();
        expect(await storage.read(key: 'jwt'), isNull);
        expect(await storage.read(key: 'staff_jwt'), isNull);
        expect(await storage.read(key: 'refreshToken'), isNull);
        expect(await storage.read(key: 'staff_id'), isNull);
        expect(await storage.read(key: 'staffId'), isNull);
        expect(await storage.read(key: 'staff_uid'), isNull);
        expect(await storage.read(key: 'employee_id'), isNull);
        expect(await storage.read(key: 'staff_role'), isNull);
        expect(await storage.read(key: 'staff_phone'), isNull);
        expect(await storage.read(key: 'offline_queue_aes_key'), 'queue-key');
        expect(await storage.read(key: 'device_token'), 'registered-device');
      },
    );
  });
}
