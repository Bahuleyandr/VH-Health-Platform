import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/services/messaging_api_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  test('void mutations reject an HTTP failure response', () async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'PATCH');
        expect(request.url.path, endsWith('/messaging/17/read'));
        return http.Response(
          jsonEncode({'success': false, 'message': 'Write was rejected'}),
          503,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    await expectLater(
      MessagingApiService.markRead(17),
      throwsA(
        isA<Exception>().having(
          (error) => error.toString(),
          'message',
          contains('Write was rejected'),
        ),
      ),
    );
  });

  test('void mutations complete after a successful response', () async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'PATCH');
        expect(request.url.path, endsWith('/messaging/threads/thread-7/mute'));
        expect(jsonDecode(request.body), {'hours': 4});
        return http.Response(
          jsonEncode({'success': true}),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    await MessagingApiService.muteThread('thread-7', hours: 4);
  });
}
