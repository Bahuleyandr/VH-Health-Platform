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

  // /messaging/send and /messaging/broadcast are mounted with
  // requireIdempotencyKey({ required: true }) — without the header the backend
  // answers 400 and the message is never sent. Pin that the client sends one.
  test(
    'sendDirect puts the caller key on the Idempotency-Key header',
    () async {
      String? seenHeader;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          expect(request.url.path, endsWith('/messaging/send'));
          seenHeader =
              request.headers['idempotency-key'] ??
              request.headers['Idempotency-Key'];
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'id': 1},
            }),
            201,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      await MessagingApiService.sendDirect(
        recipientUid: 'u-1',
        body: 'hello',
        idempotencyKey: 'staff-message-send:abc-123',
      );

      expect(seenHeader, 'staff-message-send:abc-123');
    },
  );

  test(
    'sendBroadcast puts the caller key on the Idempotency-Key header',
    () async {
      String? seenHeader;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          expect(request.url.path, endsWith('/messaging/broadcast'));
          seenHeader =
              request.headers['idempotency-key'] ??
              request.headers['Idempotency-Key'];
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'sent': 3},
            }),
            201,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      await MessagingApiService.sendBroadcast(
        scope: 'all',
        body: 'ward meeting at 6',
        idempotencyKey: 'staff-message-send:def-456',
      );

      expect(seenHeader, 'staff-message-send:def-456');
    },
  );

  // A blank key would reach the backend as a missing header and 400. Fail in
  // the app instead, where the cause is obvious.
  test('rejects a blank idempotency key before any request is made', () async {
    var called = false;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        called = true;
        return http.Response(
          '{}',
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    await expectLater(
      MessagingApiService.sendDirect(
        recipientUid: 'u-1',
        body: 'hello',
        idempotencyKey: '   ',
      ),
      throwsA(isA<ArgumentError>()),
    );
    expect(called, isFalse);
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
