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
import 'package:provider/provider.dart';
import 'package:vhhealth_core/vhhealth_core.dart' show RealtimeProvider;

import '../navigation/app_router.dart' show appRouter;
import '../providers/session_timeout_provider.dart';
import '../services/auth_service.dart';
import '../../l10n/app_strings.dart';
import 'logout_flow.dart';

class SessionRevocationListener extends StatefulWidget {
  const SessionRevocationListener({
    super.key,
    required this.child,
    @visibleForTesting this.revocationEvents,
    @visibleForTesting this.forcedLogout,
    @visibleForTesting this.navigateToLogin,
    this.recentPatientsClear,
  });
  final Widget child;
  final Stream<dynamic>? revocationEvents;
  final Future<int> Function()? forcedLogout;
  final VoidCallback? navigateToLogin;
  final StaffRecentPatientsClear? recentPatientsClear;

  @override
  State<SessionRevocationListener> createState() =>
      _SessionRevocationListenerState();
}

class _SessionRevocationListenerState extends State<SessionRevocationListener> {
  StreamSubscription? _sub;
  bool _handlingRevocation = false;

  @override
  void initState() {
    super.initState();
    // Subscribe in a post-frame callback so RealtimeProvider is reliably in
    // scope (the listener may be mounted before the provider tree settles).
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final events =
          widget.revocationEvents ??
          context.read<RealtimeProvider>().events(
            'session:revoked',
            broadcastChannel: false,
          );
      _sub = events.listen(_onRevoked);
    });
  }

  Future<void> _onRevoked(dynamic event) async {
    if (!mounted || _handlingRevocation) return;
    _handlingRevocation = true;
    final timeout = context.read<SessionTimeoutProvider>();
    // Lock synchronously, before forced logout performs any asynchronous
    // credential, queue, notification, or realtime teardown.
    timeout.lockSession();
    final messenger = ScaffoldMessenger.maybeOf(context);
    final strings = AppStrings.of(context);

    try {
      await ForcedLogoutFlow.run(
        forcedLogout:
            widget.forcedLogout ?? AuthService.forceLogoutForRevocation,
        stopSessionTracking: () async {
          if (mounted) {
            timeout.stopTracking();
            // Kill the poll-timer providers too — the forced cleanup already
            // tears down the WebSocket, but the pollers would keep firing
            // authenticated-looking requests and holding cached PHI (STF-1).
            await stopStaffRealtimePollers(
              context,
              recentPatientsClear: widget.recentPatientsClear,
            );
          }
        },
        navigateToLogin: () {
          if (mounted) {
            (widget.navigateToLogin ?? () => appRouter.go('/login'))();
            WidgetsBinding.instance.addPostFrameCallback((_) {
              timeout.unlockSession();
            });
          }
        },
        reportPreservedItems: (count) {
          if (!mounted) return;
          messenger
            ?..clearSnackBars()
            ..showSnackBar(
              SnackBar(
                content: Text(strings.sessionRevocationPreservedItems(count)),
                duration: const Duration(seconds: 6),
              ),
            );
        },
      );
    } finally {
      _handlingRevocation = false;
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
