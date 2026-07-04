import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_core/services/realtime_client.dart';

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

class _WsHarness {
  _WsHarness._(this.server);

  final HttpServer server;
  final List<String> authTokens = [];
  final List<String> subscribedChannels = [];

  String get wsUrl => 'ws://127.0.0.1:${server.port}/ws';

  static Future<_WsHarness> start({
    required bool acceptFreshToken,
    bool emitAfterFreshSubscribe = false,
  }) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final harness = _WsHarness._(server);

    server.listen((request) async {
      if (request.uri.path != '/ws') {
        request.response.statusCode = HttpStatus.notFound;
        await request.response.close();
        return;
      }

      final socket = await WebSocketTransformer.upgrade(request);
      String? socketToken;

      socket.listen((raw) {
        final msg = jsonDecode(raw as String) as Map<String, dynamic>;
        switch (msg['action']) {
          case 'auth':
            socketToken = msg['token'] as String?;
            harness.authTokens.add(socketToken ?? '');
            if (socketToken == 'fresh-access' && acceptFreshToken) {
              socket.add(jsonEncode({'event': 'connected'}));
            } else {
              unawaited(socket.close(4001, 'expired'));
            }

          case 'subscribe':
            final channel = msg['channel'] as String?;
            if (channel == null) return;
            harness.subscribedChannels.add(channel);
            if (socket.readyState != WebSocket.open ||
                socketToken != 'fresh-access' ||
                !acceptFreshToken) {
              return;
            }
            socket.add(jsonEncode({'event': 'subscribed', 'channel': channel}));
            if (emitAfterFreshSubscribe && channel == 'staff:clinical-alerts') {
              scheduleMicrotask(() {
                socket.add(
                  jsonEncode({
                    'event': channel,
                    'data': {'taskId': 'task-1', 'status': 'pending'},
                  }),
                );
              });
            }
        }
      });
    });

    return harness;
  }

  Future<void> close() => server.close(force: true);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    _installSecureStorageFake();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.deviceTypeProvider = null;
    VHHttpClient.resetClientForTesting();
    RealtimeClient.setWsUrlForTesting(null);
    await RealtimeClient.instance.disconnect();
  });

  tearDown(() async {
    await RealtimeClient.instance.disconnect();
    RealtimeClient.instance.onSessionExpired = null;
    RealtimeClient.setWsUrlForTesting(null);
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.deviceTypeProvider = null;
    await AuthService.clearAll();
  });

  test(
    '4001 refreshes once, reconnects with the rotated JWT, and keeps streams',
    () async {
      final harness = await _WsHarness.start(
        acceptFreshToken: true,
        emitAfterFreshSubscribe: true,
      );
      addTearDown(harness.close);
      RealtimeClient.setWsUrlForTesting(harness.wsUrl);
      await AuthService.setJwt('expired-access');
      await AuthService.setRefreshToken('refresh-token');

      var refreshCalls = 0;
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          refreshCalls++;
          expect(request.method, 'POST');
          expect(request.url.path, endsWith('/auth/refresh-token'));
          expect(
            jsonDecode(request.body),
            containsPair('refreshToken', 'refresh-token'),
          );
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {'accessToken': 'fresh-access'},
            }),
            HttpStatus.ok,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final received = Completer<RealtimeEvent>();
      final subscription = RealtimeClient.instance
          .events('staff:clinical-alerts')
          .listen((event) {
            if (!received.isCompleted) received.complete(event);
          });
      addTearDown(subscription.cancel);

      await RealtimeClient.instance.connect();

      final event = await received.future.timeout(const Duration(seconds: 5));
      expect(event.channel, 'staff:clinical-alerts');
      expect(event.data, containsPair('taskId', 'task-1'));
      expect(refreshCalls, 1);
      expect(await AuthService.getJwt(), 'fresh-access');
      expect(
        harness.authTokens,
        containsAllInOrder(['expired-access', 'fresh-access']),
      );
      expect(harness.subscribedChannels, contains('staff:clinical-alerts'));
    },
  );

  test('4001 refresh failure clears tokens and stops reconnecting', () async {
    final harness = await _WsHarness.start(acceptFreshToken: false);
    addTearDown(harness.close);
    RealtimeClient.setWsUrlForTesting(harness.wsUrl);
    await AuthService.setJwt('expired-access');
    await AuthService.setRefreshToken('refresh-token');

    var refreshCalls = 0;
    VHHttpClient.setClientForTesting(
      MockClient((_) async {
        refreshCalls++;
        return http.Response(
          jsonEncode({'success': false, 'message': 'Expired'}),
          HttpStatus.unauthorized,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final expired = Completer<void>();
    RealtimeClient.instance.onSessionExpired = () {
      if (!expired.isCompleted) expired.complete();
    };

    await RealtimeClient.instance.connect();
    await expired.future.timeout(const Duration(seconds: 3));
    await Future<void>.delayed(const Duration(milliseconds: 300));

    expect(refreshCalls, 1);
    expect(await AuthService.getJwt(), isNull);
    expect(await AuthService.getRefreshToken(), isNull);
    expect(harness.authTokens, ['expired-access']);
    expect(RealtimeClient.instance.isConnected, isFalse);
  });
}
