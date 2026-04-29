import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../config/api_config.dart';

class WebSocketService {
  WebSocketService._();
  static final WebSocketService instance = WebSocketService._();
  factory WebSocketService() => instance;

  static const _storage = FlutterSecureStorage();
  static const int _maxRetries = 5;
  static const Duration _maxDelay = Duration(seconds: 30);
  static const Duration _heartbeatInterval = Duration(seconds: 25);

  WebSocketChannel? _channel;
  final _controller = StreamController<Map<String, dynamic>>.broadcast();
  Timer? _heartbeatTimer;
  Timer? _reconnectTimer;
  int _retryCount = 0;
  bool _intentionalDisconnect = false;
  bool _isConnected = false;
  List<String> _subscribedChannels = [];

  Stream<Map<String, dynamic>> get stream => _controller.stream;
  bool get isConnected => _isConnected;

  Future<void> connect({List<String> channels = const []}) async {
    _intentionalDisconnect = false;
    _retryCount = 0;
    _subscribedChannels = List.from(channels);
    await _doConnect();
  }

  Future<void> _doConnect() async {
    try {
      final jwt = await _storage.read(key: 'jwt');
      if (jwt == null || jwt.isEmpty) {
        debugPrint('WebSocket: No JWT found, cannot connect');
        return;
      }

      final baseUrl = ApiConfig.baseUrl;
      // Convert https:// to wss:// (or http:// to ws://)
      final wsUrl = baseUrl
          .replaceFirst('https://', 'wss://')
          .replaceFirst('http://', 'ws://');
      // Remove trailing /api/v1 or similar path segments to get the host
      final uri = Uri.parse(wsUrl);
      final wsUri = Uri(
        scheme: uri.scheme,
        host: uri.host,
        port: uri.port,
        path: '/ws',
        queryParameters: {'token': jwt},
      );

      _channel = WebSocketChannel.connect(wsUri);
      await _channel!.ready;

      _isConnected = true;
      _retryCount = 0;
      debugPrint('WebSocket: Connected to $wsUri');

      // Subscribe to channels
      for (final channel in _subscribedChannels) {
        subscribe(channel);
      }

      // Start heartbeat
      _startHeartbeat();

      // Listen for messages
      _channel!.stream.listen(_onMessage, onError: _onError, onDone: _onDone);
    } catch (e) {
      debugPrint('WebSocket: Connection error: $e');
      _isConnected = false;
      _scheduleReconnect();
    }
  }

  void _onMessage(dynamic raw) {
    try {
      final data = json.decode(raw.toString());
      if (data is Map<String, dynamic>) {
        _controller.add(data);
      }
    } catch (e) {
      debugPrint('WebSocket: Failed to parse message: $e');
    }
  }

  void _onError(dynamic error) {
    debugPrint('WebSocket: Error: $error');
    _isConnected = false;
    _stopHeartbeat();
    _scheduleReconnect();
  }

  void _onDone() {
    debugPrint('WebSocket: Connection closed');
    _isConnected = false;
    _stopHeartbeat();
    if (!_intentionalDisconnect) {
      _scheduleReconnect();
    }
  }

  void subscribe(String channel) {
    if (!_subscribedChannels.contains(channel)) {
      _subscribedChannels.add(channel);
    }
    sendMessage({'action': 'subscribe', 'channel': channel});
  }

  void sendMessage(Map<String, dynamic> message) {
    if (_channel != null && _isConnected) {
      try {
        _channel!.sink.add(json.encode(message));
      } catch (e) {
        debugPrint('WebSocket: Send error: $e');
      }
    }
  }

  void _startHeartbeat() {
    _stopHeartbeat();
    _heartbeatTimer = Timer.periodic(_heartbeatInterval, (_) {
      if (_isConnected) {
        try {
          _channel?.sink.add('ping');
        } catch (e) {
          debugPrint('WebSocket: Heartbeat error: $e');
        }
      }
    });
  }

  void _stopHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
  }

  void _scheduleReconnect() {
    if (_intentionalDisconnect || _retryCount >= _maxRetries) {
      if (_retryCount >= _maxRetries) {
        debugPrint('WebSocket: Max retries ($_maxRetries) reached');
      }
      return;
    }

    _reconnectTimer?.cancel();
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
    final delay = Duration(
      milliseconds: min(
        _maxDelay.inMilliseconds,
        (pow(2, _retryCount) * 1000).toInt(),
      ),
    );
    _retryCount++;
    debugPrint(
      'WebSocket: Reconnecting in ${delay.inSeconds}s (attempt $_retryCount/$_maxRetries)',
    );

    _reconnectTimer = Timer(delay, _doConnect);
  }

  void disconnect() {
    _intentionalDisconnect = true;
    _stopHeartbeat();
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _isConnected = false;
    _channel?.sink.close();
    _channel = null;
  }

  void dispose() {
    disconnect();
    _controller.close();
  }
}
