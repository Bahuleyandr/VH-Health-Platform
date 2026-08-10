import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/websocket_service.dart';

void main() {
  group('WebSocketService connectivity recovery', () {
    test('connectivity restore reconnects once when authenticated', () async {
      final connections = <_FakeWebSocketConnection>[];
      final service = WebSocketService.test(
        tokenReader: () async => 'jwt-token',
        connector: (_) {
          final connection = _FakeWebSocketConnection.ready();
          connections.add(connection);
          return connection;
        },
      );
      addTearDown(service.dispose);

      await service.handleConnectivityChanged(false);
      expect(connections, isEmpty);

      await service.handleConnectivityChanged(true);
      expect(connections, hasLength(1));
      expect(service.isConnected, isTrue);

      final sent = _decodedMessages(connections.single.sent);
      expect(sent.first, {'action': 'auth', 'token': 'jwt-token'});
      expect(
        sent.where((message) => message['action'] == 'subscribe'),
        containsAll([
          {'action': 'subscribe', 'channel': 'appointment-updates'},
          {'action': 'subscribe', 'channel': 'queue-updates'},
        ]),
      );

      await service.handleConnectivityChanged(true);
      expect(connections, hasLength(1));

      service.disconnect();
      await service.handleConnectivityChanged(true);
      expect(connections, hasLength(1));
    });

    test('connectivity restore skips reconnect without a JWT', () async {
      final connections = <_FakeWebSocketConnection>[];
      final service = WebSocketService.test(
        tokenReader: () async => null,
        connector: (_) {
          final connection = _FakeWebSocketConnection.ready();
          connections.add(connection);
          return connection;
        },
      );
      addTearDown(service.dispose);

      await service.handleConnectivityChanged(true);

      expect(connections, isEmpty);
      expect(service.isConnected, isFalse);
    });

    test(
      'connect is single-flight and keeps channels requested mid-flight',
      () async {
        final connections = <_FakeWebSocketConnection>[];
        final service = WebSocketService.test(
          tokenReader: () async => 'jwt-token',
          connector: (_) {
            final connection = _FakeWebSocketConnection.pending();
            connections.add(connection);
            return connection;
          },
        );
        addTearDown(service.dispose);

        final firstConnect = service.connect(channels: ['appointments']);
        await service.connect(channels: ['notifications']);
        await Future<void>.delayed(Duration.zero);

        expect(connections, hasLength(1));

        connections.single.completeReady();
        await firstConnect;

        final sent = _decodedMessages(connections.single.sent);
        expect(
          sent.where((message) => message['action'] == 'subscribe'),
          containsAll([
            {'action': 'subscribe', 'channel': 'appointments'},
            {'action': 'subscribe', 'channel': 'notifications'},
          ]),
        );
      },
    );

    test(
      'online restore cancels pending retry and reconnects immediately',
      () async {
        final timers = <_FakeTimer>[];
        final connections = <_FakeWebSocketConnection>[];
        final service = WebSocketService.test(
          tokenReader: () async => 'jwt-token',
          connector: (_) {
            final connection = connections.isEmpty
                ? _FakeWebSocketConnection.pending()
                : _FakeWebSocketConnection.ready();
            connections.add(connection);
            return connection;
          },
          timerFactory: (duration, callback) {
            final timer = _FakeTimer(duration, callback);
            timers.add(timer);
            return timer;
          },
        );
        addTearDown(service.dispose);

        final firstConnect = service.connect();
        await Future<void>.delayed(Duration.zero);
        connections.single.completeError(StateError('offline'));
        await firstConnect;

        expect(connections, hasLength(1));
        expect(timers, hasLength(1));
        expect(timers.single.isActive, isTrue);

        await service.handleConnectivityChanged(true);

        expect(timers.single.isActive, isFalse);
        expect(connections, hasLength(2));
        expect(service.isConnected, isTrue);
      },
    );

    test('reconnect never gives up and caps the retry delay at 30s', () async {
      final timers = <_FakeTimer>[];
      final service = WebSocketService.test(
        tokenReader: () async => 'jwt-token',
        connector: (_) {
          final connection = _FakeWebSocketConnection.pending();
          connection.completeError(StateError('backend down'));
          return connection;
        },
        timerFactory: (duration, callback) {
          final timer = _FakeTimer(duration, callback);
          timers.add(timer);
          return timer;
        },
      );
      addTearDown(service.dispose);

      await service.connect();

      // Previously the service silently gave up after 5 attempts, leaving
      // the app without realtime for the rest of the session. Drive well
      // past that: every failure must schedule another retry.
      for (var i = 0; i < 9; i++) {
        expect(timers, hasLength(i + 1));
        timers.last.fire();
        await Future<void>.delayed(Duration.zero);
      }

      expect(timers, hasLength(10));
      expect(timers.last.duration, const Duration(seconds: 30));
      expect(service.isConnected, isFalse);
    });

    test('stale in-flight connect cannot replace a newer reconnect', () async {
      final connections = <_FakeWebSocketConnection>[];
      final service = WebSocketService.test(
        tokenReader: () async => 'jwt-token',
        connector: (_) {
          final connection = connections.isEmpty
              ? _FakeWebSocketConnection.pending()
              : _FakeWebSocketConnection.ready();
          connections.add(connection);
          return connection;
        },
      );
      addTearDown(service.dispose);

      final staleConnect = service.connect();
      await Future<void>.delayed(Duration.zero);
      expect(connections, hasLength(1));

      service.disconnect();
      final freshConnect = service.connect();
      await Future<void>.delayed(Duration.zero);
      expect(connections, hasLength(2));

      connections.first.completeReady();
      await staleConnect;
      await freshConnect;

      expect(connections.first.sent, isEmpty);
      expect(_decodedMessages(connections.last.sent).first, {
        'action': 'auth',
        'token': 'jwt-token',
      });
      expect(service.isConnected, isTrue);
    });
  });
}

List<Map<String, dynamic>> _decodedMessages(List<Object?> messages) {
  return messages
      .map((message) => jsonDecode(message! as String) as Map<String, dynamic>)
      .toList();
}

class _FakeWebSocketConnection implements PatientWebSocketConnection {
  _FakeWebSocketConnection.pending();

  factory _FakeWebSocketConnection.ready() {
    return _FakeWebSocketConnection.pending()..completeReady();
  }

  final _ready = Completer<void>();
  final _incoming = StreamController<dynamic>();
  final sent = <Object?>[];
  var _closed = false;

  @override
  Future<void> get ready => _ready.future;

  @override
  Stream<dynamic> get stream => _incoming.stream;

  @override
  void add(Object? data) => sent.add(data);

  @override
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    await _incoming.close();
  }

  void completeReady() {
    if (!_ready.isCompleted) {
      _ready.complete();
    }
  }

  void completeError(Object error) {
    if (!_ready.isCompleted) {
      _ready.completeError(error);
    }
  }
}

class _FakeTimer implements Timer {
  _FakeTimer(this.duration, this._callback);

  final Duration duration;
  final void Function() _callback;
  var _isActive = true;
  var _tick = 0;

  @override
  bool get isActive => _isActive;

  @override
  int get tick => _tick;

  @override
  void cancel() {
    _isActive = false;
  }

  void fire() {
    if (!_isActive) return;
    _tick++;
    _isActive = false;
    _callback();
  }
}
