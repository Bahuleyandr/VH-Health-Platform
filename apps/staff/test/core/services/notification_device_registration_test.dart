import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/services/hr_api_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({
      'staff_jwt': 'staff-access-token',
      'jwt': 'staff-access-token',
    });
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  test('posts the authenticated staff FCM token contract', () async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'POST');
        expect(request.url.path, endsWith('/devices/register'));
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        expect(body, {
          'phone': '+919876543210',
          'fcmToken': 'fcm-token-1',
          'deviceId': 'android_staff_${'+919876543210'.hashCode}',
          'deviceName': 'VHHealth Staff App',
          'platform': 'android',
        });
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {'registered': true},
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    await HrApiService.registerDevice(
      phone: '+919876543210',
      fcmToken: 'fcm-token-1',
      platform: 'android',
    );
  });

  test('propagates backend rejection so registration can be retried', () async {
    VHHttpClient.setClientForTesting(
      MockClient(
        (_) async => http.Response(
          jsonEncode({
            'success': false,
            'message': 'Device registry unavailable',
          }),
          503,
          headers: {'content-type': 'application/json'},
        ),
      ),
    );

    await expectLater(
      HrApiService.registerDevice(
        phone: '+919876543210',
        fcmToken: 'fcm-token-1',
        platform: 'android',
      ),
      throwsA(
        isA<Exception>().having(
          (error) => error.toString(),
          'message',
          contains('Device registry unavailable'),
        ),
      ),
    );
  });
}
