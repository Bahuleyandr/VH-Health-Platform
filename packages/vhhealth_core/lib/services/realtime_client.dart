import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/status.dart' as ws_status;

import '../config/api_config.dart';
import 'auth_service.dart';
import 'crash_reporter.dart';
import 'http_client.dart';

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

/// Coarse transport state so UIs can surface degraded realtime
/// (e.g. a "reconnecting" banner) instead of silently missing events.
enum RealtimeConnectionState { connected, reconnecting, disconnected }

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
///  - Authenticates via JWT pulled from [AuthService.getJwt], sent as the first
///    `auth` message frame (NEVER in the URL query — that would leak the bearer
///    token into reverse-proxy / ingress access logs).
///  - Auto-subscribes tracked channels on every (re)connect.
///  - Auto-reconnects with exponential backoff (1s → 2s → 4s → … cap 30s).
///    When the server closes with 4001 (auth failure), it first joins
///    [VHHttpClient.refreshAuthToken], then reconnects with the rotated JWT.
///    If refresh fails, [onSessionExpired] fires and reconnects stop.
///  - Never silently kills a denied channel (FL-M4): `subscribe-denied` is
///    reported to [CrashReporter], surfaced via [onDeniedChannelsChange], and
///    the channel stays desired so the next successful connect/auth retries
///    the join. The channel's stream stays open.
///  - Exposes [connectionState] / [onConnectionStateChange] so UIs can show
///    degraded realtime.
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
  final StreamController<Set<String>> _subscribedController =
      StreamController<Set<String>>.broadcast();

  /// Channels the server answered with `subscribe-denied` (FL-M4). They STAY
  /// in [_desiredChannels] — a denial can be transient (server hiccup,
  /// role/tenant propagation race) and a channel like `staff:code-blue` must
  /// never die silently — so the join is re-attempted on the next successful
  /// connect/auth rather than looped against the denial.
  final Set<String> _deniedChannels = <String>{};
  final StreamController<Set<String>> _deniedController =
      StreamController<Set<String>>.broadcast();

  int _reconnectAttempts = 0;

  static int _reconnectInitialMs = 1000;
  static int _reconnectMaxMs = 30000;
  static final Random _random = Random();

  bool _connecting = false;
  bool _shouldReconnect = false;
  bool _sessionExpired = false;

  static String? _wsUrlOverrideForTesting;

  RealtimeConnectionState _connectionState =
      RealtimeConnectionState.disconnected;
  final StreamController<RealtimeConnectionState> _stateController =
      StreamController<RealtimeConnectionState>.broadcast();

  /// Current transport state (see [RealtimeConnectionState]).
  RealtimeConnectionState get connectionState => _connectionState;

  /// Emits on every [connectionState] transition. Never closed — the
  /// singleton client survives disconnect/connect cycles.
  Stream<RealtimeConnectionState> get onConnectionStateChange =>
      _stateController.stream;

  /// Channels currently in a server-denied state (still desired, will be
  /// re-attempted on the next successful connect/auth).
  Set<String> get deniedChannels => Set.unmodifiable(_deniedChannels);

  /// Emits the full denied set on every change, so UIs can flag channels
  /// with degraded realtime. Never closed.
  Stream<Set<String>> get onDeniedChannelsChange => _deniedController.stream;

  /// Channels the server has explicitly acknowledged for this connection.
  /// A live socket alone is not evidence that a channel can deliver events.
  Set<String> get subscribedChannels => Set.unmodifiable(_serverSubscribed);

  bool isSubscribed(String channel) => _serverSubscribed.contains(channel);

  /// Emits the full acknowledged-channel set whenever it changes.
  Stream<Set<String>> get onSubscribedChannelsChange =>
      _subscribedController.stream;

  void _setConnectionState(RealtimeConnectionState state) {
    if (_connectionState == state) return;
    _connectionState = state;
    _stateController.add(state);
  }

  void _emitDenied() {
    _deniedController.add(Set.unmodifiable(_deniedChannels));
  }

  void _emitSubscribed() {
    _subscribedController.add(Set.unmodifiable(_serverSubscribed));
  }

  void _clearServerSubscriptions() {
    if (_serverSubscribed.isEmpty) return;
    _serverSubscribed.clear();
    _emitSubscribed();
  }

  /// True while the underlying socket is open.
  bool get isConnected => _channel != null && !_sessionExpired;

  @visibleForTesting
  static void setWsUrlForTesting(String? url) {
    _wsUrlOverrideForTesting = url;
  }

  /// Test-only socket factory. Null in production, where [_openSocket] always
  /// uses [WebSocketChannel.connect].
  ///
  /// Exists for one property that a loopback server cannot express: a
  /// `sink.close()` that never returns. That is the black-holed socket
  /// [disconnect] must survive without tearing down a session a LATER
  /// [connect] established, and a real `WebSocket.close()` always eventually
  /// resolves.
  @visibleForTesting
  static WebSocketChannel Function(Uri url)? channelFactoryForTesting;

  /// Backoff for the [attempt]-th reconnect (1-based), before jitter:
  /// initial → x2 per attempt → capped, then flat forever (never gives up).
  @visibleForTesting
  static int reconnectDelayMs(int attempt) {
    var delay = _reconnectInitialMs;
    for (var i = 1; i < attempt && delay < _reconnectMaxMs; i++) {
      delay *= 2;
    }
    return delay > _reconnectMaxMs ? _reconnectMaxMs : delay;
  }

  @visibleForTesting
  static void setReconnectBackoffForTesting({int? initialMs, int? maxMs}) {
    _reconnectInitialMs = initialMs ?? 1000;
    _reconnectMaxMs = maxMs ?? 30000;
  }

  @visibleForTesting
  int get reconnectAttemptsForTesting => _reconnectAttempts;

  /// 0..25% of the current delay, so simultaneous clients don't reconnect in
  /// lockstep after a shared server hiccup even at the capped retry interval.
  static int _jitterMs(int delayMs) => _random.nextInt(delayMs ~/ 4 + 1);

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
    _setConnectionState(RealtimeConnectionState.reconnecting);
    await _openSocket();
  }

  Future<void> _openSocket() async {
    if (!_shouldReconnect || _connecting || isConnected) return;
    _connecting = true;
    WebSocketChannel? openingChannel;
    try {
      final jwt = await AuthService.getJwt();
      if (!_shouldReconnect) return;
      if (jwt == null || jwt.isEmpty) {
        // No token — don't attempt; caller can re-invoke after login.
        _shouldReconnect = false;
        _setConnectionState(RealtimeConnectionState.disconnected);
        return;
      }

      // Auth is sent as the FIRST message frame, NOT in the URL query string.
      // A bearer JWT in `?token=` leaks into reverse-proxy / ingress access
      // logs (which record full request URIs); the backend's message-frame
      // handshake (wsServer.js: no URL token -> await an `auth` first frame)
      // keeps the token off the URL. Connect to the bare /ws endpoint, then
      // send `{action:'auth', token}` before any subscribe frame.
      final url = Uri.parse(
        _wsUrlOverrideForTesting ?? buildWsUrl(ApiConfig.baseUrl),
      );
      final factory = channelFactoryForTesting;
      final channel = factory == null
          ? WebSocketChannel.connect(url)
          : factory(url);
      openingChannel = channel;
      _channel = channel;
      await channel.ready;
      if (!_shouldReconnect) {
        try {
          await channel.sink.close(ws_status.normalClosure);
        } catch (_) {}
        if (identical(_channel, channel)) _channel = null;
        return;
      }

      _clearServerSubscriptions();

      _wsSub = channel.stream.listen(
        _onMessage,
        onError: (_) => _handleDisconnect(source: channel, reason: 'error'),
        onDone: () => _handleDisconnect(
          source: channel,
          reason: 'done',
          code: channel.closeCode,
        ),
        cancelOnError: true,
      );

      // Install the receive listener before sending auth so an immediate
      // connected/4001 response cannot race past the client.
      channel.sink.add(jsonEncode({'action': 'auth', 'token': jwt}));
    } catch (_) {
      _handleDisconnect(source: openingChannel, reason: 'connect-failed');
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
        // This is the server's authenticated-ready acknowledgement. The real
        // backend installs its subscribe listener only after async token and
        // revocation checks, so sending joins before this frame can lose them.
        if (!_shouldReconnect) return;
        _reconnectAttempts = 0;
        _setConnectionState(RealtimeConnectionState.connected);
        for (final channel in _desiredChannels) {
          _sendSubscribe(channel);
        }
        return;
      case 'subscribed':
        if (msg['channel'] is String) {
          final channel = msg['channel'] as String;
          if (_serverSubscribed.add(channel)) _emitSubscribed();
          // Successful (re)join — the channel is no longer denied.
          if (_deniedChannels.remove(channel)) _emitDenied();
        }
        return;
      case 'unsubscribed':
        if (msg['channel'] is String) {
          if (_serverSubscribed.remove(msg['channel'] as String)) {
            _emitSubscribed();
          }
        }
        return;
      case 'subscribe-denied':
        // FL-M4: never silently kill the channel. The denial may be
        // transient, so keep the channel desired (the resubscribe loop on
        // the next successful connect/auth retries it), keep its stream
        // open, report it, and surface it via [onDeniedChannelsChange].
        // We do NOT hot-loop retries against an authorization denial.
        final denied = msg['channel'] as String?;
        if (denied == null || !_desiredChannels.contains(denied)) return;
        unawaited(
          CrashReporter.instance.recordError(
            StateError('Realtime channel subscribe denied: $denied'),
            StackTrace.current,
            context: 'RealtimeClient subscribe-denied',
            extra: {'channel': denied, 'reason': msg['reason']},
            fatal: false,
          ),
        );
        if (_deniedChannels.add(denied)) _emitDenied();
        return;
    }

    // Any other event name IS the channel name (broadcast / sendToUser format).
    final controller = _controllers[event];
    if (controller == null || controller.isClosed) return;

    final data = msg['data'];
    controller.add(
      RealtimeEvent(
        channel: event,
        data: data is Map<String, dynamic>
            ? data
            : <String, dynamic>{'value': data},
        at: DateTime.now(),
      ),
    );
  }

  void _handleDisconnect({
    WebSocketChannel? source,
    required String reason,
    int? code,
  }) {
    // A late onDone/onError from a superseded socket must not tear down the
    // newer live connection or schedule an overlapping reconnect.
    if (source != null && !identical(source, _channel)) return;
    _wsSub?.cancel();
    _wsSub = null;
    _channel = null;
    _clearServerSubscriptions();

    _setConnectionState(
      _shouldReconnect
          ? RealtimeConnectionState.reconnecting
          : RealtimeConnectionState.disconnected,
    );

    // 4001 == auth failure (token invalid/revoked/expired).
    //
    // Previously: gave up immediately and fired onSessionExpired. That diverged
    // from VHHttpClient's behaviour, which does a single-flight refresh on 401
    // and retries. Now we share that refresh flow:
    //   1. Ask VHHttpClient.refreshAuthToken (joins the single-flight).
    //   2. On success: schedule a reconnect with the rotated token.
    //   3. On failure: mirror VHHttpClient — clear tokens, fire
    //      onSessionExpired, stop trying.
    if (code == 4001) {
      _handleAuthFailureAndMaybeReconnect();
      return;
    }

    if (!_shouldReconnect) return;

    // Transient error/close: rejoin with capped exponential backoff +
    // jitter, retrying indefinitely — realtime must never give up while the
    // caller still wants it. Reopening re-sends every desired channel.
    _reconnectAttempts += 1;
    final baseDelayMs = reconnectDelayMs(_reconnectAttempts);
    final delayMs = baseDelayMs + _jitterMs(baseDelayMs);
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(Duration(milliseconds: delayMs), () {
      if (_shouldReconnect) _openSocket();
    });
  }

  Future<void> _handleAuthFailureAndMaybeReconnect() async {
    final refreshed = await VHHttpClient.refreshAuthToken();
    if (refreshed && _shouldReconnect) {
      // VHHttpClient has already persisted the rotated JWT — our next
      // _openSocket() call picks it up via AuthService.getJwt().
      _reconnectAttempts = 0;
      _reconnectTimer?.cancel();
      _reconnectTimer = Timer(const Duration(milliseconds: 200), _openSocket);
      return;
    }
    // Refresh rejected. Mirror VHHttpClient's 401 failure path: drop both
    // tokens, notify the app, and stop trying to reconnect.
    await AuthService.clearJwt();
    await AuthService.clearRefreshToken();
    _sessionExpired = true;
    _shouldReconnect = false;
    _setConnectionState(RealtimeConnectionState.disconnected);
    try {
      onSessionExpired?.call();
    } catch (_) {
      /* swallow */
    }
  }

  /// Subscribe to [channel] and return a broadcast stream of its events.
  /// Safe to call before [connect] — the subscription will be sent once the
  /// socket is open. Calling twice for the same channel returns the same stream.
  ///
  /// Set [broadcastChannel] to `false` for direct personal-delivery events such
  /// as `notification` that the backend targets by user ID (no server-side
  /// subscribe needed — the client just listens for the event).
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
      _channel?.sink.add(
        jsonEncode({'action': 'subscribe', 'channel': channel}),
      );
    } catch (_) {
      /* will retry on next connect */
    }
  }

  /// Stop receiving events on [channel] and tell the server to drop it.
  void unsubscribe(String channel) {
    _desiredChannels.remove(channel);
    if (_serverSubscribed.remove(channel)) _emitSubscribed();
    if (_deniedChannels.remove(channel)) _emitDenied();
    final c = _controllers.remove(channel);
    c?.close();
    try {
      _channel?.sink.add(
        jsonEncode({'action': 'unsubscribe', 'channel': channel}),
      );
    } catch (_) {}
  }

  /// Close the socket and stop reconnecting. Streams are closed.
  /// Retire this client's session.
  ///
  /// THE ORDER BELOW IS LOAD-BEARING: every piece of client state is retired
  /// SYNCHRONOUSLY first, and only then is the socket I/O awaited.
  ///
  /// The socket close is unbounded by nature — on a dead or black-holed socket
  /// it parks inside `sink.close()` indefinitely — and the patient app
  /// deliberately stops waiting for it (`PatientRealtimeLifecycle.stopTimeout`
  /// bounds the logout teardown), so a LATER login can bind this singleton
  /// while a previous close is still in flight. When the state teardown lived
  /// after that await, two things went wrong at once and both were silent:
  ///
  ///  * `_channel` stayed non-null for the whole park, so `connect()`'s
  ///    `isConnected` short-circuit made the NEW login a no-op — it never
  ///    opened a socket at all;
  ///  * the straggler then resumed and nulled `_channel`, cleared the server
  ///    subscriptions and CLOSED EVERY EVENT CONTROLLER — belonging, by then,
  ///    to a session it had nothing to do with.
  ///
  /// Retiring state first makes the parked close inert: it can no longer block
  /// the next connect, and there is nothing left after it that could touch a
  /// newer session.
  Future<void> disconnect() async {
    _shouldReconnect = false;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _reconnectAttempts = 0;
    if (_deniedChannels.isNotEmpty) {
      _deniedChannels.clear();
      _emitDenied();
    }
    _setConnectionState(RealtimeConnectionState.disconnected);

    final closingChannel = _channel;
    final closingSubscription = _wsSub;
    final closingControllers = List.of(_controllers.values);
    _channel = null;
    _wsSub = null;
    _clearServerSubscriptions();
    _controllers.clear();
    _desiredChannels.clear();

    // Pure-Dart teardown first: it cannot park on the socket, so listeners
    // always get their onDone even when the close below never returns.
    for (final controller in closingControllers) {
      await controller.close();
    }
    await closingSubscription?.cancel();
    try {
      await closingChannel?.sink.close(ws_status.normalClosure);
    } catch (_) {}
  }
}
