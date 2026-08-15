// lib/services/realtime_provider.dart
//
// Lifecycle owner for [RealtimeClient]. Mount once at the app root. Every
// widget that needs realtime data should listen via `events(channel)` —
// individual widgets must NOT call `RealtimeClient.instance.connect()`.
//
// Why a provider at all: realtime connect/disconnect is tied to auth
// lifecycle (log in → open; log out → close; token refresh → reconnect).
// Widgets that `connect()` on their own `initState` lose when the user logs
// out and back in, and nothing ever closes the socket. Centralising in a
// provider makes the whole lifecycle one place to reason about.

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'auth_service.dart';
import 'realtime_client.dart';

class RealtimeProvider extends ChangeNotifier {
  RealtimeProvider({VoidCallback? onSessionExpired}) {
    RealtimeClient.instance.onSessionExpired = () {
      onSessionExpired?.call();
      notifyListeners();
    };
    _connected =
        RealtimeClient.instance.connectionState ==
        RealtimeConnectionState.connected;
    _connectionSubscription = RealtimeClient.instance.onConnectionStateChange
        .listen((state) {
          final connected = state == RealtimeConnectionState.connected;
          if (_connected == connected) return;
          _connected = connected;
          notifyListeners();
        });
    _subscribedSubscription = RealtimeClient.instance.onSubscribedChannelsChange
        .listen((_) => notifyListeners());
  }

  bool _connected = false;
  bool get isConnected => _connected;
  StreamSubscription<RealtimeConnectionState>? _connectionSubscription;
  StreamSubscription<Set<String>>? _subscribedSubscription;

  /// True only after the backend has acknowledged this channel subscription.
  bool isSubscribed(String channel) =>
      RealtimeClient.instance.isSubscribed(channel);

  /// Connect if a JWT is present. Safe to call multiple times — the
  /// underlying client is a singleton with idempotent `connect()`.
  Future<void> ensureConnected() async {
    final jwt = await AuthService.getJwt();
    if (jwt == null || jwt.isEmpty) return;
    await RealtimeClient.instance.connect();
  }

  /// Tear down on logout. Call before clearing the JWT so any last-breath
  /// unsubscribe frames get through.
  Future<void> disconnect() async {
    await RealtimeClient.instance.disconnect();
    if (_connected) {
      _connected = false;
      notifyListeners();
    }
  }

  /// Convenience pass-through so consumers don't have to import
  /// RealtimeClient directly for the one method they care about.
  Stream<RealtimeEvent> events(
    String channel, {
    bool broadcastChannel = true,
  }) => RealtimeClient.instance.events(
    channel,
    broadcastChannel: broadcastChannel,
  );

  void unsubscribe(String channel) =>
      RealtimeClient.instance.unsubscribe(channel);

  @override
  void dispose() {
    _connectionSubscription?.cancel();
    _subscribedSubscription?.cancel();
    RealtimeClient.instance.onSessionExpired = null;
    super.dispose();
  }
}
