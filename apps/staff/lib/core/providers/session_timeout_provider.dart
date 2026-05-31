import 'dart:async';
import 'package:flutter/foundation.dart';
import '../config/api_config.dart';
import '../services/recent_patients_service.dart';

typedef SessionTimeoutCleanup = Future<void> Function();

/// Tracks user activity and enforces an idle session timeout.
///
/// After [timeoutDuration] of inactivity the session is expired:
/// all stored credentials are cleared and [isSessionExpired] becomes `true`.
/// The app's router redirect guard should check this flag and navigate
/// to the login screen when it fires.
class SessionTimeoutProvider extends ChangeNotifier {
  SessionTimeoutProvider({
    this.timeoutDuration = const Duration(minutes: 15),
    SessionTimeoutCleanup? onTimeoutCleanup,
  }) : _onTimeoutCleanup = onTimeoutCleanup ?? _defaultTimeoutCleanup;

  /// How long the user can be idle before automatic logout.
  final Duration timeoutDuration;
  final SessionTimeoutCleanup _onTimeoutCleanup;

  Timer? _timer;
  bool _expired = false;

  /// `true` after the idle timeout fires. Reset by [resetSession].
  bool get isSessionExpired => _expired;

  /// Call this on every user interaction (tap, scroll, keyboard).
  /// Resets the idle countdown.
  void recordActivity() {
    if (_expired) return; // already expired — don't restart
    _timer?.cancel();
    _timer = Timer(timeoutDuration, _onTimeout);
  }

  /// Start tracking. Call once after login succeeds.
  void startTracking() {
    _expired = false;
    recordActivity();
  }

  /// Stop tracking. Call on explicit logout to avoid double-clear.
  void stopTracking() {
    _timer?.cancel();
    _timer = null;
  }

  /// Reset after re-login.
  void resetSession() {
    _expired = false;
    notifyListeners();
    startTracking();
  }

  Future<void> _onTimeout() async {
    _expired = true;
    _timer = null;
    try {
      await _onTimeoutCleanup();
    } catch (e) {
      debugPrint('SessionTimeout: failed to clear local session state: $e');
    }
    notifyListeners();
  }

  static Future<void> _defaultTimeoutCleanup() async {
    await ApiConfig.clearAll();
    await RecentPatientsService.clear();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}
