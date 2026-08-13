import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/auth_service.dart';
import 'package:vhhealth_core/services/crash_reporter.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth_core/services/realtime_provider.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// A [WebSocketChannel] whose `sink.close()` can be held open indefinitely.
///
/// That is the one property a loopback WebSocket server cannot express: a real
/// `WebSocket.close()` always eventually resolves, so the black-holed socket
/// the patient logout bound exists for is unreachable through the harness.
class _ControllableChannel implements WebSocketChannel {
  _ControllableChannel({Future<void>? closeGate})
    : _sink = _ControllableSink(closeGate);

  final StreamController<dynamic> _incoming = StreamController<dynamic>();
  final _ControllableSink _sink;

  void emitConnected() => _incoming.add(jsonEncode({'event': 'connected'}));

  void emitEvent(String channel, Map<String, Object?> data) =>
      _incoming.add(jsonEncode({'event': channel, 'data': data}));

  void dispose() {
    if (!_incoming.isClosed) unawaited(_incoming.close());
  }

  @override
  Stream<dynamic> get stream => _incoming.stream;

  @override
  WebSocketSink get sink => _sink;

  @override
  Future<void> get ready => Future<void>.value();

  @override
  int? get closeCode => null;

  @override
  String? get closeReason => null;

  @override
  String? get protocol => null;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _ControllableSink implements WebSocketSink {
  _ControllableSink(this._closeGate);

  final Future<void>? _closeGate;
  final Completer<void> _done = Completer<void>();

  @override
  void add(dynamic data) {}

  @override
  void addError(Object error, [StackTrace? stackTrace]) {}

  @override
  Future<void> addStream(Stream<dynamic> stream) async {}

  @override
  Future<void> get done => _done.future;

  @override
  Future<void> close([int? closeCode, String? closeReason]) async {
    final gate = _closeGate;
    if (gate != null) await gate;
    if (!_done.isCompleted) _done.complete();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _RecordingCrashReporter implements CrashReporter {
  final List<Map<String, Object?>> errors = [];

  @override
  Future<void> recordError(
    Object error,
    StackTrace? stack, {
    String? context,
    Map<String, Object?> extra = const {},
    bool fatal = false,
  }) async {
    errors.add({'error': error, 'context': context, ...extra});
  }

  @override
  Future<void> log(String message) async {}

  @override
  Future<void> setUserId(String? userId) async {}

  @override
  Future<void> setCustomKey(String key, Object value) async {}
}

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
  final List<WebSocket> sockets = [];
  final Map<String, int> _deniedCount = {};

  String get wsUrl => 'ws://127.0.0.1:${server.port}/ws';

  static Future<_WsHarness> start({
    required bool acceptFreshToken,
    bool emitAfterFreshSubscribe = false,
    int denyFirstSubscribes = 0,
    bool denyAllSubscribes = false,
    Duration authReadyDelay = Duration.zero,
    Duration subscribeAckDelay = Duration.zero,
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
      harness.sockets.add(socket);
      String? socketToken;
      var authenticated = false;

      socket.listen((raw) {
        final msg = jsonDecode(raw as String) as Map<String, dynamic>;
        switch (msg['action']) {
          case 'auth':
            socketToken = msg['token'] as String?;
            harness.authTokens.add(socketToken ?? '');
            if (socketToken == 'fresh-access' && acceptFreshToken) {
              Future<void>.delayed(authReadyDelay, () {
                if (socket.readyState != WebSocket.open) return;
                authenticated = true;
                socket.add(jsonEncode({'event': 'connected'}));
              });
            } else {
              unawaited(socket.close(4001, 'expired'));
            }

          case 'subscribe':
            final channel = msg['channel'] as String?;
            if (channel == null) return;
            harness.subscribedChannels.add(channel);
            if (socket.readyState != WebSocket.open ||
                !authenticated ||
                !acceptFreshToken) {
              return;
            }
            final denied = harness._deniedCount[channel] ?? 0;
            if (denyAllSubscribes || denied < denyFirstSubscribes) {
              harness._deniedCount[channel] = denied + 1;
              socket.add(
                jsonEncode({
                  'event': 'subscribe-denied',
                  'channel': channel,
                  'reason': 'transient',
                }),
              );
              return;
            }
            void acknowledgeSubscription() {
              if (socket.readyState != WebSocket.open) return;
              socket.add(
                jsonEncode({'event': 'subscribed', 'channel': channel}),
              );
              if (emitAfterFreshSubscribe &&
                  (channel == 'staff:clinical-alerts' ||
                      channel == 'staff:code-blue')) {
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

            if (subscribeAckDelay == Duration.zero) {
              acknowledgeSubscription();
            } else {
              unawaited(
                Future<void>.delayed(
                  subscribeAckDelay,
                  acknowledgeSubscription,
                ),
              );
            }
        }
      });
    });

    return harness;
  }

  /// Server-side close of every live client socket (transient drop).
  Future<void> closeClients() async {
    for (final socket in List.of(sockets)) {
      await socket.close();
    }
    sockets.clear();
  }

  Future<void> close() => server.close(force: true);
}

Future<void> _waitFor(
  bool Function() condition, {
  Duration timeout = const Duration(seconds: 5),
  String reason = 'condition',
}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      fail('timed out waiting for $reason');
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    _installSecureStorageFake();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.deviceTypeProvider = null;
    VHHttpClient.resetClientForTesting();
    RealtimeClient.setWsUrlForTesting(null);
    RealtimeClient.setReconnectBackoffForTesting();
    await RealtimeClient.instance.disconnect();
  });

  tearDown(() async {
    await RealtimeClient.instance.disconnect();
    RealtimeClient.instance.onSessionExpired = null;
    RealtimeClient.setWsUrlForTesting(null);
    RealtimeClient.setReconnectBackoffForTesting();
    CrashReporter.reset();
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

  test('disconnect during 4001 refresh suppresses delayed reconnect', () async {
    final harness = await _WsHarness.start(acceptFreshToken: true);
    addTearDown(harness.close);
    RealtimeClient.setWsUrlForTesting(harness.wsUrl);
    await AuthService.setJwt('expired-access');
    await AuthService.setRefreshToken('refresh-token');

    final refreshStarted = Completer<void>();
    final releaseRefresh = Completer<void>();
    var refreshCalls = 0;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        refreshCalls++;
        if (!refreshStarted.isCompleted) refreshStarted.complete();
        await releaseRefresh.future;
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

    await RealtimeClient.instance.connect();
    await refreshStarted.future.timeout(const Duration(seconds: 3));

    await RealtimeClient.instance.disconnect();
    releaseRefresh.complete();
    await Future<void>.delayed(const Duration(milliseconds: 350));

    expect(refreshCalls, 1);
    expect(harness.authTokens, ['expired-access']);
    expect(RealtimeClient.instance.isConnected, isFalse);
  });

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

  test('a disconnect parked on a black-holed socket neither blocks the next '
      'login nor tears it down', () async {
    // The patient app BOUNDS its logout realtime teardown, so a disconnect
    // parked inside `sink.close()` is abandoned while still in flight and a
    // new login can bind this same singleton. Two silent failures used to
    // follow, and this test pins both closed.
    final wedgedClose = Completer<void>();
    final channels = <_ControllableChannel>[];
    RealtimeClient.channelFactoryForTesting = (_) {
      final channel = _ControllableChannel(
        closeGate: channels.isEmpty ? wedgedClose.future : null,
      );
      channels.add(channel);
      return channel;
    };
    addTearDown(() {
      RealtimeClient.channelFactoryForTesting = null;
      if (!wedgedClose.isCompleted) wedgedClose.complete();
      for (final channel in channels) {
        channel.dispose();
      }
    });
    await AuthService.setJwt('fresh-access');

    final firstSessionEvents = <RealtimeEvent>[];
    final firstSub = RealtimeClient.instance
        .events('patient:1:queue')
        .listen(firstSessionEvents.add);
    addTearDown(firstSub.cancel);

    await RealtimeClient.instance.connect();
    channels.first.emitConnected();
    await _waitFor(
      () =>
          RealtimeClient.instance.connectionState ==
          RealtimeConnectionState.connected,
      reason: 'first socket connected',
    );

    // Logout's teardown: started, then abandoned by its bound. The close
    // never returns, exactly as a black-holed socket behaves.
    final abandoned = RealtimeClient.instance.disconnect();
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(
      abandoned,
      isA<Future<void>>(),
      reason: 'sanity: the teardown is still in flight',
    );

    // FAILURE 1: `_channel` stayed set for the whole park, so connect()'s
    // isConnected short-circuit made the next login a silent no-op.
    final newSessionEvents = <RealtimeEvent>[];
    final newSub = RealtimeClient.instance
        .events('patient:2:queue')
        .listen(newSessionEvents.add);
    addTearDown(newSub.cancel);
    await RealtimeClient.instance.connect();
    await _waitFor(
      () => channels.length == 2,
      reason: 'the next login to actually open a socket',
    );
    channels[1].emitConnected();
    await _waitFor(
      () =>
          RealtimeClient.instance.connectionState ==
          RealtimeConnectionState.connected,
      reason: 'second socket connected',
    );

    // FAILURE 2: the straggler resumed and cleared the state of whatever
    // session was live by then.
    wedgedClose.complete();
    await abandoned.timeout(const Duration(seconds: 5));
    await Future<void>.delayed(const Duration(milliseconds: 50));

    expect(RealtimeClient.instance.isConnected, isTrue);
    channels[1].emitEvent('patient:2:queue', {'position': 3});
    await _waitFor(
      () => newSessionEvents.isNotEmpty,
      reason: 'an event on the new session after the straggler unwedged',
    );
    expect(newSessionEvents.single.data, containsPair('position', 3));
  });

  test('reconnectDelayMs grows exponentially and stays flat at the cap', () {
    expect(RealtimeClient.reconnectDelayMs(1), 1000);
    expect(RealtimeClient.reconnectDelayMs(2), 2000);
    expect(RealtimeClient.reconnectDelayMs(3), 4000);
    expect(RealtimeClient.reconnectDelayMs(4), 8000);
    expect(RealtimeClient.reconnectDelayMs(5), 16000);
    expect(RealtimeClient.reconnectDelayMs(6), 30000);
    expect(RealtimeClient.reconnectDelayMs(7), 30000);
    expect(RealtimeClient.reconnectDelayMs(50), 30000);
  });

  test(
    'waits for the authenticated server acknowledgement before subscribing',
    () async {
      final harness = await _WsHarness.start(
        acceptFreshToken: true,
        emitAfterFreshSubscribe: true,
        authReadyDelay: const Duration(milliseconds: 150),
      );
      addTearDown(harness.close);
      RealtimeClient.setWsUrlForTesting(harness.wsUrl);
      await AuthService.setJwt('fresh-access');

      final received = Completer<RealtimeEvent>();
      final subscription = RealtimeClient.instance
          .events('staff:code-blue')
          .listen((event) {
            if (!received.isCompleted) received.complete(event);
          });
      addTearDown(subscription.cancel);

      await RealtimeClient.instance.connect();

      expect(harness.subscribedChannels, isEmpty);
      expect(RealtimeClient.instance.isSubscribed('staff:code-blue'), isFalse);
      expect(
        RealtimeClient.instance.connectionState,
        RealtimeConnectionState.reconnecting,
      );

      final event = await received.future.timeout(const Duration(seconds: 3));
      expect(event.channel, 'staff:code-blue');
      expect(harness.subscribedChannels, ['staff:code-blue']);
      expect(RealtimeClient.instance.isSubscribed('staff:code-blue'), isTrue);
      expect(
        RealtimeClient.instance.connectionState,
        RealtimeConnectionState.connected,
      );
    },
  );

  test(
    'subscription readiness clears immediately when the socket drops',
    () async {
      final harness = await _WsHarness.start(acceptFreshToken: true);
      addTearDown(harness.close);
      RealtimeClient.setWsUrlForTesting(harness.wsUrl);
      RealtimeClient.setReconnectBackoffForTesting(initialMs: 500, maxMs: 500);
      await AuthService.setJwt('fresh-access');

      final acknowledgedSets = <Set<String>>[];
      final acknowledgedSub = RealtimeClient.instance.onSubscribedChannelsChange
          .listen(acknowledgedSets.add);
      addTearDown(acknowledgedSub.cancel);
      final eventSub = RealtimeClient.instance
          .events('patient:patient-uid-1:appointments')
          .listen((_) {});
      addTearDown(eventSub.cancel);

      await RealtimeClient.instance.connect();
      await _waitFor(
        () => RealtimeClient.instance.isSubscribed(
          'patient:patient-uid-1:appointments',
        ),
        reason: 'patient appointment acknowledgement',
      );

      await harness.closeClients();
      await _waitFor(
        () => !RealtimeClient.instance.isSubscribed(
          'patient:patient-uid-1:appointments',
        ),
        reason: 'acknowledgement cleared after disconnect',
      );
      expect(acknowledgedSets, contains(isEmpty));
    },
  );

  test(
    'RealtimeProvider notifies when channel readiness is acknowledged and retired',
    () async {
      final harness = await _WsHarness.start(
        acceptFreshToken: true,
        subscribeAckDelay: const Duration(milliseconds: 150),
      );
      addTearDown(harness.close);
      RealtimeClient.setWsUrlForTesting(harness.wsUrl);
      RealtimeClient.setReconnectBackoffForTesting(initialMs: 500, maxMs: 500);
      await AuthService.setJwt('fresh-access');

      final provider = RealtimeProvider();
      addTearDown(provider.dispose);
      var notifications = 0;
      provider.addListener(() => notifications += 1);
      const channel =
          'patient:11111111-1111-4111-8111-111111111111:appointments';
      final eventSub = provider.events(channel).listen((_) {});
      addTearDown(eventSub.cancel);

      await provider.ensureConnected();
      await _waitFor(() => provider.isConnected, reason: 'provider connected');
      expect(provider.isSubscribed(channel), isFalse);
      final notificationsBeforeAck = notifications;

      await _waitFor(
        () => provider.isSubscribed(channel),
        reason: 'provider subscription acknowledgement',
      );
      expect(notifications, greaterThan(notificationsBeforeAck));
      final notificationsAfterAck = notifications;

      await harness.closeClients();
      await _waitFor(
        () => !provider.isSubscribed(channel) && !provider.isConnected,
        reason: 'provider readiness retirement',
      );
      expect(notifications, greaterThan(notificationsAfterAck));
    },
  );

  test(
    'transient drop rejoins with backoff, resubscribes, and resets state',
    () async {
      final harness = await _WsHarness.start(
        acceptFreshToken: true,
        emitAfterFreshSubscribe: true,
      );
      addTearDown(harness.close);
      RealtimeClient.setWsUrlForTesting(harness.wsUrl);
      RealtimeClient.setReconnectBackoffForTesting(initialMs: 20, maxMs: 80);
      await AuthService.setJwt('fresh-access');
      await AuthService.setRefreshToken('refresh-token');

      final states = <RealtimeConnectionState>[];
      final stateSub = RealtimeClient.instance.onConnectionStateChange.listen(
        states.add,
      );
      addTearDown(stateSub.cancel);

      final events = <RealtimeEvent>[];
      final subscription = RealtimeClient.instance
          .events('staff:code-blue')
          .listen(events.add);
      addTearDown(subscription.cancel);

      await RealtimeClient.instance.connect();
      await _waitFor(() => events.isNotEmpty, reason: 'first event');

      // Transient server-side drop — the channel must come back on its own.
      await harness.closeClients();
      await _waitFor(
        () => states.contains(RealtimeConnectionState.reconnecting),
        reason: 'reconnecting after drop',
      );
      // The harness emits on every accepted subscribe, so a second event
      // proves the rejoin re-subscribed the channel on the same stream.
      await _waitFor(() => events.length >= 2, reason: 'event after rejoin');

      expect(
        harness.subscribedChannels.where((c) => c == 'staff:code-blue').length,
        greaterThanOrEqualTo(2),
      );
      expect(harness.authTokens.length, greaterThanOrEqualTo(2));
      // Successful rejoin resets the backoff and the state.
      expect(RealtimeClient.instance.reconnectAttemptsForTesting, 0);
      expect(
        RealtimeClient.instance.connectionState,
        RealtimeConnectionState.connected,
      );

      await RealtimeClient.instance.disconnect();
      expect(
        states,
        containsAllInOrder([
          RealtimeConnectionState.connected,
          RealtimeConnectionState.reconnecting,
          RealtimeConnectionState.connected,
          RealtimeConnectionState.disconnected,
        ]),
      );
    },
  );

  test('subscribe-denied is reported, keeps the stream, and rejoins on the '
      'next successful connect (FL-M4)', () async {
    final harness = await _WsHarness.start(
      acceptFreshToken: true,
      emitAfterFreshSubscribe: true,
      denyFirstSubscribes: 1,
    );
    addTearDown(harness.close);
    RealtimeClient.setWsUrlForTesting(harness.wsUrl);
    RealtimeClient.setReconnectBackoffForTesting(initialMs: 20, maxMs: 80);
    await AuthService.setJwt('fresh-access');
    await AuthService.setRefreshToken('refresh-token');

    final reporter = _RecordingCrashReporter();
    CrashReporter.install(reporter);

    final deniedSets = <Set<String>>[];
    final deniedSub = RealtimeClient.instance.onDeniedChannelsChange.listen(
      deniedSets.add,
    );
    addTearDown(deniedSub.cancel);

    final events = <RealtimeEvent>[];
    final subscription = RealtimeClient.instance
        .events('staff:code-blue')
        .listen(events.add);
    addTearDown(subscription.cancel);

    await RealtimeClient.instance.connect();

    // Denial is reported + surfaced, but the channel stays desired and
    // its stream stays open.
    await _waitFor(
      () => RealtimeClient.instance.deniedChannels.contains('staff:code-blue'),
      reason: 'denied channel surfaced',
    );
    expect(reporter.errors, isNotEmpty);
    expect(reporter.errors.first['channel'], 'staff:code-blue');
    expect(reporter.errors.first['reason'], 'transient');
    expect(deniedSets.last, contains('staff:code-blue'));

    // No hot retry loop against the denial: attempts stay at the one
    // denied subscribe while the socket stays healthy.
    await Future<void>.delayed(const Duration(milliseconds: 400));
    expect(
      harness.subscribedChannels.where((c) => c == 'staff:code-blue').length,
      1,
    );

    // Next successful connect re-attempts the join — now accepted.
    await harness.closeClients();
    await _waitFor(() => events.isNotEmpty, reason: 'event after rejoin');
    expect(events.first.channel, 'staff:code-blue');
    expect(RealtimeClient.instance.deniedChannels, isEmpty);
    expect(deniedSets.last, isEmpty);
  });

  test('disconnect during reconnect backoff stops further attempts', () async {
    final harness = await _WsHarness.start(acceptFreshToken: true);
    addTearDown(harness.close);
    RealtimeClient.setWsUrlForTesting(harness.wsUrl);
    RealtimeClient.setReconnectBackoffForTesting(initialMs: 250, maxMs: 500);
    await AuthService.setJwt('fresh-access');
    await AuthService.setRefreshToken('refresh-token');

    await RealtimeClient.instance.connect();
    await _waitFor(
      () => harness.authTokens.length == 1,
      reason: 'initial auth',
    );

    await harness.closeClients();
    await _waitFor(
      () =>
          RealtimeClient.instance.connectionState ==
          RealtimeConnectionState.reconnecting,
      reason: 'reconnecting after drop',
    );
    await RealtimeClient.instance.disconnect();

    // Wait past several backoff periods — no new connection attempts.
    await Future<void>.delayed(const Duration(milliseconds: 900));
    expect(harness.authTokens.length, 1);
    expect(
      RealtimeClient.instance.connectionState,
      RealtimeConnectionState.disconnected,
    );
    expect(RealtimeClient.instance.isConnected, isFalse);
  });

  test('unsubscribed channel is not rejoined after a reconnect', () async {
    final harness = await _WsHarness.start(acceptFreshToken: true);
    addTearDown(harness.close);
    RealtimeClient.setWsUrlForTesting(harness.wsUrl);
    RealtimeClient.setReconnectBackoffForTesting(initialMs: 20, maxMs: 80);
    await AuthService.setJwt('fresh-access');
    await AuthService.setRefreshToken('refresh-token');

    final subscription = RealtimeClient.instance
        .events('staff:code-blue')
        .listen((_) {});
    addTearDown(subscription.cancel);

    await RealtimeClient.instance.connect();
    await _waitFor(
      () => harness.subscribedChannels.contains('staff:code-blue'),
      reason: 'initial subscribe',
    );

    RealtimeClient.instance.unsubscribe('staff:code-blue');
    await harness.closeClients();
    await _waitFor(
      () => harness.authTokens.length >= 2,
      reason: 'reconnect after drop',
    );
    await Future<void>.delayed(const Duration(milliseconds: 200));

    expect(
      harness.subscribedChannels.where((c) => c == 'staff:code-blue').length,
      1,
    );
  });
}
