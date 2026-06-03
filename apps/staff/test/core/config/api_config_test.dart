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
  });
}
