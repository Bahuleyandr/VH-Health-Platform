// lib/core/widgets/session_revocation_listener.dart
//
// Listens for `session:revoked` events on the realtime fabric. The backend
// pushes this event via wsServer.sendToUser whenever the same patient logs
// in elsewhere — so the booted device kicks itself to /login the moment
// the event lands, rather than waiting for the next API call to 401.
//
// Mounted near the app root via MaterialApp.router's builder so a
// ScaffoldMessenger is reachable for the snackbar and RealtimeProvider is
// in scope.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth_core/vhhealth_core.dart' show RealtimeProvider;

import '../navigation/app_router.dart';
import '../services/logout_service.dart';
import 'live_region_snack_bar.dart';

class SessionRevocationListener extends StatefulWidget {
  const SessionRevocationListener({
    super.key,
    required this.child,
    this.redirectToLogin,
  });

  final Widget child;

  /// Navigation used after teardown; defaults to the app router. Injectable
  /// because this widget lives in MaterialApp.router's `builder`, ABOVE the
  /// Router — `GoRouter.of(context)` throws there ("No GoRouter found in
  /// context"), which used to kill the whole kick handler before any
  /// teardown ran.
  final VoidCallback? redirectToLogin;

  @override
  State<SessionRevocationListener> createState() =>
      _SessionRevocationListenerState();
}

class _SessionRevocationListenerState extends State<SessionRevocationListener> {
  StreamSubscription? _sub;
  StreamSubscription? _stateSub;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _subscribe();
      // Logout tears the RealtimeClient down completely, closing every
      // channel stream — including ours. Without re-subscribing, the
      // "logged in elsewhere" kick would be dead for every login after the
      // first logout in this process. onConnectionStateChange is never
      // closed, so re-attaching on every connected transition keeps the
      // subscription live across logout/login cycles (re-subscribing to an
      // already-open stream is a cheap cancel + relisten).
      _stateSub = RealtimeClient.instance.onConnectionStateChange.listen((
        state,
      ) {
        if (state == RealtimeConnectionState.connected && mounted) {
          _subscribe();
        }
      });
    });
  }

  void _subscribe() {
    final realtime = context.read<RealtimeProvider>();
    _sub?.cancel();
    // `broadcastChannel: false` — sendToUser pushes to the per-user
    // socket bucket directly; no server-side subscribe handshake.
    _sub = realtime
        .events('session:revoked', broadcastChannel: false)
        .listen(_onRevoked);
  }

  Future<void> _onRevoked(dynamic event) async {
    if (!mounted) return;
    final data = event is Map<String, dynamic>
        ? event
        : (event.data is Map<String, dynamic>
              ? event.data as Map<String, dynamic>
              : <String, dynamic>{});
    final reason = data['reason']?.toString();
    final messenger = ScaffoldMessenger.maybeOf(context);

    messenger?.showSnackBar(
      LiveRegionSnackBar.build(
        message: reason == 'new_login_elsewhere'
            ? 'Signed out — your account just logged in on another device.'
            : 'Your session was revoked.',
      ),
    );

    // LogoutService wipes JWT + caches + clears the realtime fabric, then
    // the redirect lands the user on /login. The backend has already
    // blacklisted the JTI, so any in-flight requests will 401 anyway.
    await LogoutService.logout();
    if (!mounted) return;
    (widget.redirectToLogin ?? () => AppRouter.router.go('/login'))();
  }

  @override
  void dispose() {
    _sub?.cancel();
    _stateSub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
