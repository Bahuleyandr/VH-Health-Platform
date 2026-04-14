import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/status.dart' as ws_status;

import '../config/api_config.dart';
import 'auth_service.dart';

/// A single event received from the real-time fabric.
class RealtimeEvent {
  RealtimeEvent({required this.channel, required this.data, required this.at});

  /// Channel name (e.g. `staff:clinical-alerts`, `queue-position`).
  final String channel;

  /// Payload object as decoded from JSON.
  final Map<String, dynamic> data;

  /// Client-side receive timestamp.
  final DateTime at;
}

/// Shared WebSocket client for the VHHealth real-time fabric (backend `/ws`).
///
/// Usage:
/// ```dart
/// final rt = RealtimeClient.instance;
/// rt.onSessionExpired = () => context.go('/login');
/// await rt.connect();
/// rt.events('staff:clinical-alerts').listen((e) => showAlert(e.data));
/// ```
///
/// The client:
///  - Authenticates via JWT pulled from [AuthService.getJwt] (sent as `?token=`).
///  - Auto-subscribes tracked channels on every (re)connect.
///  - Auto-reconnects with exponential backoff (1s → 2s → 4s → … cap 30s) unless
///    the server closes with 4001 (auth failure), in which case [onSessionExpired]
///    fires and the client stops reconnecting until [connect] is called again.
class RealtimeClient {
  RealtimeClient._();
  static final RealtimeClient instance = RealtimeClient._();

  /// Invoked when the server closes with 4001 (token invalid / revoked / expired).
  /// Consumer apps should route to login here.
  VoidCallback? onSessionExpired;

  WebSocketChannel? _channel;
  StreamSubscription? _wsSub;
  Timer? _reconnectTimer;

  /// Channels the caller has asked to listen to. We re-send `subscribe` on reconnect.
  final Set<String> _desiredChannels = <String>{};

  /// Per-channel broadcast controllers. Kept across reconnects.
  final Map<String, StreamController<RealtimeEvent>> _controllers = {};

  /// Channels the server has acknowledged as subscribed this connection.
  final Set<String> _serverSubscribed = <String>{};

  int _backoffMs = 1000;
  static const int _maxBackoffMs = 30000;

  bool _connecting = false;
  bool _shouldReconnect = false;
  bool _sessionExpired = false;

  /// True while the underlying socket is open.
  bool get isConnected => _channel != null && !_sessionExpired;

  /// Derive the WebSocket URL from [ApiConfig.baseUrl]. Strips `/api/v1` and
  /// replaces `https`/`http` with `wss`/`ws`.
  @visibleForTesting
  static String buildWsUrl(String baseUrl) {
    var url = baseUrl;
    if (url.endsWith('/')) url = url.substring(0, url.length - 1);
    // Strip any path suffix (we go to the host root + /ws).
    final uri = Uri.parse(url);
    final scheme = uri.scheme == 'https' ? 'wss' : 'ws';
    final authority = uri.authority;
    return '$scheme://$authority/ws';
  }

  /// Open the socket. Safe to call multiple times — subsequent calls are no-ops
  /// unless the connection has been closed.
  Future<void> connect() async {
    if (_connecting || isConnected) return;
    _shouldReconnect = true;
    _sessionExpired = false;
    await _openSocket();
  }

  Future<void> _openSocket() async {
    _connecting = true;
    try {
      final jwt = await AuthService.getJwt();
      if (jwt == null || jwt.isEmpty) {
        // No token — don't attempt; caller can re-invoke after login.
        _connecting = false;
        _shouldReconnect = false;
        return;
      }

      final url = '${buildWsUrl(ApiConfig.baseUrl)}?token=${Uri.encodeComponent(jwt)}';
      final channel = WebSocketChannel.connect(Uri.parse(url));
      _channel = channel;
      await channel.ready;

      _backoffMs = 1000;
      _serverSubscribed.clear();

      _wsSub = channel.stream.listen(
        _onMessage,
        onError: (_) => _handleDisconnect(reason: 'error'),
        onDone: () => _handleDisconnect(
          reason: 'done',
          code: channel.closeCode,
        ),
        cancelOnError: true,
      );

      // Re-subscribe every desired channel.
      for (final c in _desiredChannels) {
        _sendSubscribe(c);
      }
    } catch (_) {
      _handleDisconnect(reason: 'connect-failed');
    } finally {
      _connecting = false;
    }
  }

  void _onMessage(dynamic raw) {
    Map<String, dynamic> msg;
    try {
      msg = jsonDecode(raw as String) as Map<String, dynamic>;
    } catch (_) {
      return;
    }

    final event = msg['event'] as String?;
    if (event == null) return;

    switch (event) {
      case 'connected':
      case 'subscribed':
        if (msg['channel'] is String) {
          _serverSubscribed.add(msg['channel'] as String);
        }
        return;
      case 'unsubscribed':
        if (msg['channel'] is String) {
          _serverSubscribed.remove(msg['channel'] as String);
        }
        return;
      case 'subscribe-denied':
        // Server rejected this channel — stop desiring it so we don't retry.
        final denied = msg['channel'] as String?;
        if (denied != null) {
          _desiredChannels.remove(denied);
          _controllers.remove(denied)?.close();
        }
        return;
    }

    // Any other event name IS the channel name (broadcast / sendToUser format).
    final controller = _controllers[event];
    if (controller == null || controller.isClosed) return;

    final data = msg['data'];
    controller.add(RealtimeEvent(
      channel: event,
      data: data is Map<String, dynamic> ? data : <String, dynamic>{'value': data},
      at: DateTime.now(),
    ));
  }

  void _handleDisconnect({required String reason, int? code}) {
    _wsSub?.cancel();
    _wsSub = null;
    _channel = null;
    _serverSubscribed.clear();

    // 4001 == auth failure (token invalid/revoked/expired). Stop reconnecting.
    if (code == 4001) {
      _sessionExpired = true;
      _shouldReconnect = false;
      try {
        onSessionExpired?.call();
      } catch (_) {/* swallow */}
      return;
    }

    if (!_shouldReconnect) return;

    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(Duration(milliseconds: _backoffMs), () {
      _openSocket();
    });
    _backoffMs = (_backoffMs * 2).clamp(1000, _maxBackoffMs);
  }

  /// Subscribe to [channel] and return a broadcast stream of its events.
  /// Safe to call before [connect] — the subscription will be sent once the
  /// socket is open. Calling twice for the same channel returns the same stream.
  ///
  /// Set [broadcastChannel] to `false` for personal-delivery events like
  /// `queue-position` or `notification` that the backend targets by `userId`
  /// (no server-side subscribe needed — the client just listens for the event).
  Stream<RealtimeEvent> events(String channel, {bool broadcastChannel = true}) {
    final existing = _controllers[channel];
    if (existing != null && !existing.isClosed) {
      if (broadcastChannel) _ensureSubscribed(channel);
      return existing.stream;
    }

    final controller = StreamController<RealtimeEvent>.broadcast(
      onListen: () {
        if (broadcastChannel) _ensureSubscribed(channel);
      },
    );
    _controllers[channel] = controller;
    if (broadcastChannel) _ensureSubscribed(channel);
    return controller.stream;
  }

  void _ensureSubscribed(String channel) {
    _desiredChannels.add(channel);
    if (_channel != null && !_serverSubscribed.contains(channel)) {
      _sendSubscribe(channel);
    }
  }

  void _sendSubscribe(String channel) {
    try {
      _channel?.sink.add(jsonEncode({'action': 'subscribe', 'channel': channel}));
    } catch (_) {/* will retry on next connect */}
  }

  /// Stop receiving events on [channel] and tell the server to drop it.
  void unsubscribe(String channel) {
    _desiredChannels.remove(channel);
    _serverSubscribed.remove(channel);
    final c = _controllers.remove(channel);
    c?.close();
    try {
      _channel?.sink.add(jsonEncode({'action': 'unsubscribe', 'channel': channel}));
    } catch (_) {}
  }

  /// Close the socket and stop reconnecting. Streams are closed.
  Future<void> disconnect() async {
    _shouldReconnect = false;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    await _wsSub?.cancel();
    _wsSub = null;
    try {
      await _channel?.sink.close(ws_status.normalClosure);
    } catch (_) {}
    _channel = null;
    _serverSubscribed.clear();
    for (final c in _controllers.values) {
      await c.close();
    }
    _controllers.clear();
    _desiredChannels.clear();
  }
}
