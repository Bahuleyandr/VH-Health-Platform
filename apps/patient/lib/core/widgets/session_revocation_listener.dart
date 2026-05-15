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
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/vhhealth_core.dart' show RealtimeProvider;

import '../services/logout_service.dart';

class SessionRevocationListener extends StatefulWidget {
  const SessionRevocationListener({super.key, required this.child});
  final Widget child;

  @override
  State<SessionRevocationListener> createState() =>
      _SessionRevocationListenerState();
}

class _SessionRevocationListenerState extends State<SessionRevocationListener> {
  StreamSubscription? _sub;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final realtime = context.read<RealtimeProvider>();
      // `broadcastChannel: false` — sendToUser pushes to the per-user
      // socket bucket directly; no server-side subscribe handshake.
      _sub = realtime
          .events('session:revoked', broadcastChannel: false)
          .listen(_onRevoked);
    });
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
    final goRouter = GoRouter.of(context);

    messenger?.showSnackBar(
      SnackBar(
        content: Text(
          reason == 'new_login_elsewhere'
              ? 'Signed out — your account just logged in on another device.'
              : 'Your session was revoked.',
        ),
        duration: const Duration(seconds: 4),
      ),
    );

    // LogoutService wipes JWT + caches + clears the realtime fabric, then
    // the redirect lands the user on /login. The backend has already
    // blacklisted the JTI, so any in-flight requests will 401 anyway.
    await LogoutService.logout();
    if (!mounted) return;
    goRouter.go('/login');
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
