// lib/core/widgets/session_revocation_listener.dart
//
// Listens for `session:revoked` events on the realtime fabric. The backend
// pushes this event via wsServer.sendToUser whenever the same user logs in
// elsewhere — so the booted device kicks itself to login the moment the
// event lands, rather than waiting for the next API call to 401.
//
// Mount once near the app root (inside the MultiProvider so RealtimeProvider
// is in scope). The child is rendered unchanged.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/vhhealth_core.dart' show RealtimeProvider;

import '../providers/session_timeout_provider.dart';
import '../services/auth_service.dart';
import '../../l10n/app_strings.dart';

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
    // Subscribe in a post-frame callback so RealtimeProvider is reliably in
    // scope (the listener may be mounted before the provider tree settles).
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final realtime = context.read<RealtimeProvider>();
      // `broadcastChannel: false` — sendToUser targets the per-user socket
      // bucket directly, no server-side subscribe handshake is needed.
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
    final strings = AppStrings.of(context);

    messenger?.showSnackBar(
      SnackBar(
        content: Text(
          reason == 'new_login_elsewhere'
              ? strings.lookup(
                  's4.lib.session_revocation_listener.signed_out_new_login',
                )
              : strings.lookup(
                  's4.lib.session_revocation_listener.session_revoked',
                ),
        ),
        duration: const Duration(seconds: 4),
      ),
    );

    // Best-effort backend logout (the JWT is already blacklisted server-side;
    // this just unregisters the device + tidies up local state). Local
    // credentials are cleared regardless.
    await AuthService.logout();
    if (mounted) {
      context.read<SessionTimeoutProvider>().stopTracking();
    }
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
