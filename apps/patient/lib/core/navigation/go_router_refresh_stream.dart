// lib/core/navigation/go_router_refresh_stream.dart
//
// Bridges a Stream into a Listenable so GoRouter's `refreshListenable`
// re-runs its redirect whenever the stream emits. Wired to
// FirebaseAuth.instance.authStateChanges() in app_router.dart: without it,
// a Firebase sign-out (idle timeout, 401 expiry, session revocation via
// LogoutService) never re-fires the redirect, leaving the user stranded on
// a dead authenticated screen until they happen to navigate.

import 'dart:async';

import 'package:flutter/foundation.dart';

/// A [ChangeNotifier] that notifies listeners on every event of [stream].
///
/// Mirrors the reference implementation shipped with go_router's examples.
class GoRouterRefreshStream extends ChangeNotifier {
  GoRouterRefreshStream(Stream<dynamic> stream) {
    _subscription = stream.asBroadcastStream().listen((_) => notifyListeners());
  }

  late final StreamSubscription<dynamic> _subscription;

  @override
  void dispose() {
    _subscription.cancel();
    super.dispose();
  }
}
