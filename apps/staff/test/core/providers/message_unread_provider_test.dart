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

  test(
    'stop prevents an in-flight refresh from restoring signed-out data',
    () async {
      final requestStarted = Completer<void>();
      final response = Completer<Map<String, dynamic>>();
      final provider = MessageUnreadProvider(
        loadUnreadCount: () {
          requestStarted.complete();
          return response.future;
        },
      );

      final refresh = provider.refresh();
      await requestStarted.future;
      provider.stop();
      response.complete({'unread_count': 7});
      await refresh;

      expect(provider.unreadCount, 0);
    },
  );

  test('a stale refresh cannot overwrite the next signed-in session', () async {
    final firstResponse = Completer<Map<String, dynamic>>();
    final secondResponse = Completer<Map<String, dynamic>>();
    var requestCount = 0;
    final provider = MessageUnreadProvider(
      loadUnreadCount: () {
        requestCount += 1;
        return requestCount == 1 ? firstResponse.future : secondResponse.future;
      },
    );

    final firstStart = provider.start();
    await Future<void>.delayed(Duration.zero);
    provider.stop();
    final secondStart = provider.start();
    await Future<void>.delayed(Duration.zero);

    secondResponse.complete({'unread_count': 2});
    await secondStart;
    firstResponse.complete({'unread_count': 9});
    await firstStart;

    expect(provider.unreadCount, 2);
    provider.stop();
  });

  test('stop() clears cached alert state and allows a later restart', () async {
    VHHttpClient.setClientForTesting(
      MockClient((req) async {
        return _unreadResponse(4);
      }),
    );

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
