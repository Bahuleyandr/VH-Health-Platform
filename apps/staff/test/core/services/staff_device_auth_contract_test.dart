import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/services/auth_service.dart';
import 'package:vhhealth_staff/core/services/hr_api_service.dart';

http.Response _ok(Object data) => http.Response(
  jsonEncode({'success': true, 'data': data}),
  200,
  headers: {'content-type': 'application/json'},
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
    AuthService.debugDisablePostLoginSync = true;
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    AuthService.debugDisablePostLoginSync = false;
  });

  test(
    'password login registers and securely persists this installation',
    () async {
      Map<String, dynamic>? requestBody;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          expect(request.url.path, endsWith('/auth/staff/register-device'));
          requestBody = jsonDecode(request.body) as Map<String, dynamic>;
          return _ok({
            'accessToken': 'header.payload.signature',
            'refreshToken': 'refresh-token',
            'deviceToken': 'trusted-device-token',
            'staff': {
              'id': '42',
              'uid': '22222222-2222-4222-8222-222222222222',
              'employeeId': 'EMP-1001',
              'role': 'NURSE',
            },
          });
        }),
      );

      await AuthService.login(employeeId: 'EMP-1001', password: 'secret');

      final installationId = requestBody!['installationId'];
      expect(
        installationId,
        matches(
          RegExp(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          ),
        ),
      );
      expect(requestBody!['deviceInfo']['deviceId'], installationId);
      expect(requestBody!['deviceInfo']['deviceName'], isNotEmpty);
      expect(requestBody!['deviceInfo']['platform'], isNotEmpty);
      const storage = FlutterSecureStorage();
      expect(await storage.read(key: 'device_token'), 'trusted-device-token');
      expect(await storage.read(key: 'staff_jwt'), 'header.payload.signature');
    },
  );

  test(
    'PIN and biometric login send only the bound device assertion',
    () async {
      FlutterSecureStorage.setMockInitialValues({
        'device_token': 'trusted-device-token',
        'staffInstallationId': '33333333-3333-4333-8333-333333333333',
      });
      final requests = <Map<String, dynamic>>[];
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          requests.add(jsonDecode(request.body) as Map<String, dynamic>);
          return _ok({
            'accessToken': 'header.payload.signature',
            'refreshToken': 'refresh-token',
            'staff': {
              'id': '42',
              'uid': '22222222-2222-4222-8222-222222222222',
              'employeeId': 'EMP-1001',
              'role': 'NURSE',
            },
          });
        }),
      );

      await AuthService.pinLogin(employeeId: 'EMP-1001', pin: '1234');
      await AuthService.quickLogin(employeeId: 'EMP-1001', biometric: true);

      expect(requests[0]['deviceToken'], 'trusted-device-token');
      expect(requests[0]['installationId'], isNotEmpty);
      expect(requests[1]['deviceToken'], 'trusted-device-token');
      expect(requests[1]['biometric'], isTrue);
      expect(requests[1], isNot(contains('biometricToken')));
    },
  );

  test(
    'PIN setup supplies the bound token and removal targets the UUID route',
    () async {
      final observed = <http.Request>[];
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          observed.add(request);
          return _ok({'reauthenticationRequired': false});
        }),
      );

      await HrApiService.setupPin(
        pin: '1234',
        deviceToken: 'trusted-device-token',
      );
      await HrApiService.removeRegisteredDevice(
        '33333333-3333-4333-8333-333333333333',
      );

      expect(observed[0].url.path, endsWith('/auth/staff/setup-pin'));
      expect(jsonDecode(observed[0].body), {
        'pin': '1234',
        'deviceToken': 'trusted-device-token',
      });
      expect(observed[1].method, 'DELETE');
      expect(
        observed[1].url.path,
        endsWith('/auth/staff/device/33333333-3333-4333-8333-333333333333'),
      );
    },
  );
}
