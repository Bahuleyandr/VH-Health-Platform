// lib/core/services/websocket_service.dart

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'package:vhhealth/core/config/api_config.dart';

/// Singleton WebSocket service for real-time backend communication.
///
/// Connects to the backend WS server with JWT auth sent via the first
/// message frame (not in the URL) to prevent token leakage in logs.
class WebSocketService {
  WebSocketService._();
  static final WebSocketService instance = WebSocketService._();

  static const _storage = FlutterSecureStorage();
  static const int _maxRetries = 5;
  static const Duration _maxDelay = Duration(seconds: 30);

  WebSocketChannel? _channel;
  final StreamController<Map<String, dynamic>> _controller =
      StreamController<Map<String, dynamic>>.broadcast();

  int _retryCount = 0;
  Timer? _retryTimer;
  bool _intentionalDisconnect = false;
  List<String> _subscribedChannels = [];

  /// Broadcast stream of all incoming WS events (parsed JSON maps).
  Stream<Map<String, dynamic>> get stream => _controller.stream;

  /// Whether the WebSocket connection is currently open.
  bool get isConnected => _channel != null;

  /// Connect to the WebSocket server.
  ///
  /// [channels] - channels to subscribe to after connecting.
  Future<void> connect({
    List<String> channels = const ['appointment-updates', 'queue-updates'],
  }) async {
    _intentionalDisconnect = false;
    _subscribedChannels = List.of(channels);

    final jwt = await _storage.read(key: 'jwt');
    if (jwt == null) {
      if (kDebugMode) debugPrint('WebSocketService: no JWT - skipping connect');
      return;
    }

    // Connect WITHOUT token in URL to prevent leakage in logs/proxies
    final wsUrl = _buildWsUrl();

    try {
      _channel = WebSocketChannel.connect(Uri.parse(wsUrl));
      await _channel!.ready;
      _retryCount = 0;

      if (kDebugMode) debugPrint('WebSocketService: connected');

      // Send JWT as first message frame for authentication
      sendMessage({'action': 'auth', 'token': jwt});

      // Subscribe to requested channels.
      for (final ch in _subscribedChannels) {
        subscribe(ch);
      }

      _channel!.stream.listen(
        _onData,
        onError: _onError,
        onDone: _onDone,
      );
    } catch (e) {
      if (kDebugMode) debugPrint('WebSocketService: connect failed - $e');
      _scheduleReconnect();
    }
  }

  /// Disconnect and stop reconnection attempts.
  void disconnect() {
    _intentionalDisconnect = true;
    _retryTimer?.cancel();
    _retryTimer = null;
    _channel?.sink.close();
    _channel = null;
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
    if (_channel == null) {
      if (kDebugMode) {
        debugPrint('WebSocketService: cannot send - not connected');
      }
      return;
    }
    _channel!.sink.add(jsonEncode(message));
  }

  /// Release resources. Call when the app is shutting down.
  void dispose() {
    disconnect();
    _controller.close();
  }

  // -- Private helpers --

  String _buildWsUrl() {
    // Convert https://api.vhhealth.app/api/v1 -> wss://api.vhhealth.app/ws
    // Token is sent via first message frame, NOT in URL
    final base = Uri.parse(ApiConfig.baseUrl);
    final scheme = base.scheme == 'https' ? 'wss' : 'ws';
    return '$scheme://${base.host}/ws';
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
    _channel = null;
    _scheduleReconnect();
  }

  void _onDone() {
    if (kDebugMode) {
      debugPrint('WebSocketService: stream closed');
    }
    _channel = null;
    if (!_intentionalDisconnect) {
      _scheduleReconnect();
    }
  }

  void _scheduleReconnect() {
    if (_intentionalDisconnect || _retryCount >= _maxRetries) {
      if (kDebugMode && _retryCount >= _maxRetries) {
        debugPrint('WebSocketService: max retries reached - giving up');
      }
      return;
    }

    final delay = Duration(
      seconds: (1 << _retryCount).clamp(1, _maxDelay.inSeconds),
    );
    _retryCount++;

    if (kDebugMode) {
      debugPrint(
        'WebSocketService: reconnecting in ${delay.inSeconds}s '
        '(attempt $_retryCount/$_maxRetries)',
      );
    }

    _retryTimer?.cancel();
    _retryTimer = Timer(delay, () {
      connect(channels: _subscribedChannels);
    });
  }
}
