// lib/core/services/websocket_service.dart

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'package:vhhealth/core/config/api_config.dart';

typedef WebSocketTokenReader = Future<String?> Function();
typedef WebSocketConnector = PatientWebSocketConnection Function(Uri uri);
typedef WebSocketTimerFactory =
    Timer Function(Duration duration, void Function() callback);

@visibleForTesting
abstract interface class PatientWebSocketConnection {
  Future<void> get ready;
  Stream<dynamic> get stream;

  void add(Object? data);
  Future<void> close();
}

class _WebSocketChannelConnection implements PatientWebSocketConnection {
  _WebSocketChannelConnection(this._channel);

  final WebSocketChannel _channel;

  @override
  Future<void> get ready => _channel.ready;

  @override
  Stream<dynamic> get stream => _channel.stream;

  @override
  void add(Object? data) => _channel.sink.add(data);

  @override
  Future<void> close() => _channel.sink.close();
}

/// Singleton WebSocket service for real-time backend communication.
///
/// Connects to the backend WS server with JWT auth sent via the first
/// message frame (not in the URL) to prevent token leakage in logs.
class WebSocketService {
  WebSocketService._({
    WebSocketTokenReader? tokenReader,
    WebSocketConnector? connector,
    WebSocketTimerFactory? timerFactory,
  }) : _tokenReader = tokenReader ?? (() => _storage.read(key: 'jwt')),
       _connector =
           connector ??
           ((uri) =>
               _WebSocketChannelConnection(WebSocketChannel.connect(uri))),
       _timerFactory = timerFactory ?? Timer.new;

  @visibleForTesting
  factory WebSocketService.test({
    required WebSocketTokenReader tokenReader,
    required WebSocketConnector connector,
    WebSocketTimerFactory? timerFactory,
  }) {
    return WebSocketService._(
      tokenReader: tokenReader,
      connector: connector,
      timerFactory: timerFactory,
    );
  }

  static final WebSocketService instance = WebSocketService._();

  static final _storage = VHSecureStorage.instance;
  static const Duration _maxDelay = Duration(seconds: 30);
  static const List<String> _defaultChannels = [
    'appointment-updates',
    'queue-updates',
  ];

  final WebSocketTokenReader _tokenReader;
  final WebSocketConnector _connector;
  final WebSocketTimerFactory _timerFactory;

  PatientWebSocketConnection? _connection;
  final StreamController<Map<String, dynamic>> _controller =
      StreamController<Map<String, dynamic>>.broadcast();

  StreamSubscription<dynamic>? _subscription;
  int _retryCount = 0;
  Timer? _retryTimer;
  bool _isConnecting = false;
  bool _intentionalDisconnect = false;
  int _connectGeneration = 0;
  final List<String> _subscribedChannels = [];

  /// Broadcast stream of all incoming WS events (parsed JSON maps).
  Stream<Map<String, dynamic>> get stream => _controller.stream;

  /// Whether the WebSocket connection is currently open.
  bool get isConnected => _connection != null;

  /// Connect to the WebSocket server.
  ///
  /// [channels] - channels to subscribe to after connecting.
  Future<void> connect({List<String> channels = _defaultChannels}) async {
    _intentionalDisconnect = false;
    final newlyRequestedChannels = _rememberChannels(channels);

    if (_isConnecting) return;

    if (_connection != null) {
      for (final channel in newlyRequestedChannels) {
        subscribe(channel);
      }
      return;
    }

    _isConnecting = true;
    final generation = ++_connectGeneration;

    PatientWebSocketConnection? connection;

    try {
      final jwt = await _tokenReader();
      if (jwt == null || jwt.isEmpty) {
        if (kDebugMode) {
          debugPrint('WebSocketService: no JWT - skipping connect');
        }
        return;
      }

      _retryTimer?.cancel();
      _retryTimer = null;

      // Connect WITHOUT token in URL to prevent leakage in logs/proxies
      final wsUrl = _buildWsUrl();
      connection = _connector(Uri.parse(wsUrl));
      _connection = connection;

      await connection.ready;

      if (_intentionalDisconnect || generation != _connectGeneration) {
        await connection.close();
        if (identical(_connection, connection)) {
          _connection = null;
        }
        return;
      }

      _retryCount = 0;

      if (kDebugMode) debugPrint('WebSocketService: connected');

      // Send JWT as first message frame for authentication
      sendMessage({'action': 'auth', 'token': jwt});

      // Subscribe to requested channels.
      for (final ch in _subscribedChannels) {
        subscribe(ch);
      }

      _subscription = connection.stream.listen(
        _onData,
        onError: _onError,
        onDone: _onDone,
      );
    } catch (e) {
      if (connection != null && identical(_connection, connection)) {
        _connection = null;
      }
      if (kDebugMode) debugPrint('WebSocketService: connect failed - $e');
      if (generation == _connectGeneration) {
        _scheduleReconnect();
      }
    } finally {
      _isConnecting = false;
    }
  }

  /// Retry the WebSocket when network monitoring reports restored connectivity.
  ///
  /// Calls after an intentional disconnect (pause/logout) are ignored, so the
  /// app only reconnects while it is foregrounded and still has a JWT.
  Future<void> handleConnectivityChanged(bool isOnline) async {
    if (!isOnline || _intentionalDisconnect) return;
    await connect(
      channels: _subscribedChannels.isEmpty
          ? _defaultChannels
          : _subscribedChannels,
    );
  }

  /// Disconnect and stop reconnection attempts.
  void disconnect() {
    _intentionalDisconnect = true;
    _retryTimer?.cancel();
    _retryTimer = null;
    _isConnecting = false;
    _connectGeneration++;
    unawaited(_subscription?.cancel() ?? Future<void>.value());
    _subscription = null;
    unawaited(_connection?.close() ?? Future<void>.value());
    _connection = null;
    if (kDebugMode) debugPrint('WebSocketService: disconnected');
  }

  /// Subscribe to a named channel.
  void subscribe(String channel) {
    sendMessage({'action': 'subscribe', 'channel': channel});
    if (!_subscribedChannels.contains(channel)) {
      _subscribedChannels.add(channel);
    }
  }

  /// Send a JSON message over the WebSocket.
  void sendMessage(Map<String, dynamic> message) {
    if (_connection == null) {
      if (kDebugMode) {
        debugPrint('WebSocketService: cannot send - not connected');
      }
      return;
    }
    _connection!.add(jsonEncode(message));
  }

  /// Release resources. Call when the app is shutting down.
  void dispose() {
    disconnect();
    _controller.close();
  }

  // -- Private helpers --

  String _buildWsUrl() {
    // Convert https://api.vhhealth.app/api/v1 -> wss://api.vhhealth.app/ws
    // and http://10.0.2.2:5000/api/v1 -> ws://10.0.2.2:5000/ws (dev).
    // Preserve a non-default port so emulator/local dev works; without
    // this the URL collapses to ws://host/ws (port 80) and times out.
    // Token is sent via first message frame, NOT in URL.
    final base = Uri.parse(ApiConfig.baseUrl);
    final scheme = base.scheme == 'https' ? 'wss' : 'ws';
    final defaultPort = base.scheme == 'https' ? 443 : 80;
    final hasExplicitPort = base.hasPort && base.port != defaultPort;
    final authority = hasExplicitPort ? '${base.host}:${base.port}' : base.host;
    return '$scheme://$authority/ws';
  }

  void _onData(dynamic raw) {
    try {
      final data = jsonDecode(raw as String) as Map<String, dynamic>;
      _controller.add(data);
      if (kDebugMode) {
        debugPrint('WebSocketService: event=${data['event']}');
      }
    } catch (e) {
      if (kDebugMode) {
        debugPrint('WebSocketService: failed to parse message - $e');
      }
    }
  }

  void _onError(Object error) {
    if (kDebugMode) {
      debugPrint('WebSocketService: stream error - $error');
    }
    _connection = null;
    unawaited(_subscription?.cancel() ?? Future<void>.value());
    _subscription = null;
    _scheduleReconnect();
  }

  void _onDone() {
    if (kDebugMode) {
      debugPrint('WebSocketService: stream closed');
    }
    _connection = null;
    unawaited(_subscription?.cancel() ?? Future<void>.value());
    _subscription = null;
    if (!_intentionalDisconnect) {
      _scheduleReconnect();
    }
  }

  void _scheduleReconnect() {
    if (_intentionalDisconnect) return;

    // Retry indefinitely at a capped interval — this socket carries PHI
    // updates and previously gave up silently after 5 attempts, leaving the
    // app without realtime for the rest of the session even once the backend
    // recovered. The exponent is clamped separately so _retryCount can keep
    // counting without the shift overflowing.
    final delay = Duration(
      seconds: (1 << _retryCount.clamp(0, 5)).clamp(1, _maxDelay.inSeconds),
    );
    _retryCount++;

    if (kDebugMode) {
      debugPrint(
        'WebSocketService: reconnecting in ${delay.inSeconds}s '
        '(attempt $_retryCount)',
      );
    }

    _retryTimer?.cancel();
    _retryTimer = _timerFactory(delay, () {
      connect(channels: _subscribedChannels);
    });
  }

  List<String> _rememberChannels(List<String> channels) {
    final newlyRequested = <String>[];
    for (final channel in channels) {
      if (!_subscribedChannels.contains(channel)) {
        _subscribedChannels.add(channel);
        newlyRequested.add(channel);
      }
    }
    return newlyRequested;
  }
}
