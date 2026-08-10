import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/vhhealth_core.dart';
import 'package:vhhealth_staff/core/providers/message_unread_provider.dart';

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final store = <String, String>{};

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = Map<String, dynamic>.from(call.arguments as Map);
        switch (call.method) {
          case 'read':
            return store[args['key']];
          case 'write':
            store[args['key'] as String] = args['value'] as String;
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

http.Response _unreadResponse(int count) {
  return http.Response(
    jsonEncode({
      'success': true,
      'data': {'unread_count': count},
    }),
    200,
    headers: {'content-type': 'application/json'},
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    _installSecureStorageFake();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.deviceTypeProvider = null;
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.deviceTypeProvider = null;
  });

  test('markMessagesReadLocally decrements and clamps the unread badge', () {
    final provider = MessageUnreadProvider();

    provider.setUnreadCountFromServer(3);
    provider.markMessagesReadLocally(2, refresh: false);
    expect(provider.unreadCount, 1);

    provider.markMessagesReadLocally(5, refresh: false);
    expect(provider.unreadCount, 0);
  });

  test(
    'refresh queues a follow-up request when called while in flight',
    () async {
      final firstRequestStarted = Completer<void>();
      final releaseFirstRequest = Completer<void>();
      var requestCount = 0;

      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          expect(req.url.path, endsWith('/messaging/unread-count'));
          requestCount += 1;
          if (requestCount == 1) {
            firstRequestStarted.complete();
            await releaseFirstRequest.future;
            return _unreadResponse(2);
          }
          return _unreadResponse(0);
        }),
      );

      final provider = MessageUnreadProvider();
      final firstRefresh = provider.refresh();
      await firstRequestStarted.future;

      await provider.refresh();
      expect(requestCount, 1);

      releaseFirstRequest.complete();
      await firstRefresh;

      expect(requestCount, 2);
      expect(provider.unreadCount, 0);
    },
  );

  test('stop() clears cached alert state and allows a later restart', () async {
    VHHttpClient.setClientForTesting(MockClient((req) async {
      return _unreadResponse(4);
    }));

    final provider = MessageUnreadProvider();
    await provider.start();
    expect(provider.unreadCount, 4);

    // Logout path (STF-1): the badge and the last alert must not survive
    // into the login screen or the next clinician's session.
    provider.stop();
    expect(provider.unreadCount, 0);
    expect(provider.latestAlert, isNull);

    // stop() is idempotent.
    provider.stop();

    // A later login can start the provider again.
    await provider.start();
    expect(provider.unreadCount, 4);
    provider.stop();
  });
}
