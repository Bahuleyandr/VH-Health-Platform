import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:vhhealth/core/services/logout_service.dart';

/// Tracks user activity and enforces an idle session timeout.
///
/// After [timeoutDuration] of inactivity, clears credentials and sets
/// [isSessionExpired] to true. The router redirect guard should check
/// this flag and navigate to the login screen.
///
/// Lifecycle is owned by the router redirect guard: it calls
/// [startTracking] when a live backend session lands on `/login`
/// (login and re-login — this also clears a previous expiry) and
/// [recordActivity] on every protected navigation. Guest mode calls
/// [pauseForGuest]. Explicit logout does NOT stop the timer: logout
/// triggers are context-free and funnel into the single-flight
/// `LogoutService.logout()`, so a timer that fires after logout is a
/// harmless idempotent re-run of the same teardown, and the next
/// login's [startTracking] re-arms cleanly.
class SessionTimeoutProvider extends ChangeNotifier {
  SessionTimeoutProvider({this.timeoutDuration = const Duration(minutes: 30)});

  final Duration timeoutDuration;

  Timer? _timer;
  bool _expired = false;

  bool get isSessionExpired => _expired;

  /// Call on every user interaction (tap, scroll).
  void recordActivity() {
    if (_expired) return;
    _timer?.cancel();
    _timer = Timer(timeoutDuration, _onTimeout);
  }

  /// Start tracking. Called by the router guard after (re-)login.
  void startTracking() {
    _expired = false;
    recordActivity();
  }

  /// Stop authenticated-session tracking without marking the session expired.
  /// Used for public guest mode, which has no credentials to expire.
  void pauseForGuest() {
    _timer?.cancel();
    _timer = null;
    if (_expired) {
      _expired = false;
      notifyListeners();
    }
  }

  Future<void> _onTimeout() async {
    _expired = true;
    _timer = null;
    // Full teardown on idle timeout: credentials + caches + realtime channels.
    // Previously this only wiped secure storage, leaving the RealtimeClient /
    // WebSocket PHI channels live after timeout. LogoutService centralises the
    // complete teardown (and disconnects both realtime clients).
    try {
      await LogoutService.logout();
    } catch (e) {
      debugPrint('SessionTimeout: logout teardown failed: $e');
    }
    notifyListeners();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}
