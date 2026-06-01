import 'dart:async';
import 'package:flutter/foundation.dart';
import '../config/api_config.dart';
import '../platform_info.dart';
import '../services/recent_patients_service.dart';

typedef SessionTimeoutCleanup = Future<void> Function();

Duration sessionTimeoutForDeviceMode(AppDeviceMode mode) => mode.isWorkbench
    ? const Duration(minutes: 10)
    : const Duration(minutes: 15);

/// Tracks user activity and enforces an idle session timeout.
///
/// After [timeoutDuration] of inactivity the session is expired:
/// all stored credentials are cleared and [isSessionExpired] becomes `true`.
/// The app's router redirect guard should check this flag and navigate
/// to the login screen when it fires.
class SessionTimeoutProvider extends ChangeNotifier {
  SessionTimeoutProvider({
    Duration timeoutDuration = const Duration(minutes: 15),
    SessionTimeoutCleanup? onTimeoutCleanup,
  }) : _timeoutDuration = timeoutDuration,
       _onTimeoutCleanup = onTimeoutCleanup ?? _defaultTimeoutCleanup;

  /// How long the user can be idle before automatic logout.
  Duration get timeoutDuration => _timeoutDuration;

  Duration _timeoutDuration;
  final SessionTimeoutCleanup _onTimeoutCleanup;

  Timer? _timer;
  bool _expired = false;
  bool _tracking = false;

  /// `true` after the idle timeout fires. Reset by [resetSession].
  bool get isSessionExpired => _expired;

  bool get isTracking => _tracking;

  /// Call this on every user interaction (tap, scroll, keyboard).
  /// Resets the idle countdown.
  void recordActivity() {
    if (!_tracking) return;
    if (_expired) return; // already expired — don't restart
    _timer?.cancel();
    _timer = Timer(_timeoutDuration, _onTimeout);
  }

  void configureForDeviceMode(AppDeviceMode mode) {
    setTimeoutDuration(sessionTimeoutForDeviceMode(mode));
  }

  void setTimeoutDuration(Duration duration) {
    if (duration == _timeoutDuration) return;
    _timeoutDuration = duration;
    if (_tracking && !_expired) {
      recordActivity();
    }
  }

  /// Start tracking. Call once after login succeeds.
  void startTracking() {
    _tracking = true;
    _expired = false;
    recordActivity();
  }

  /// Stop tracking. Call on explicit logout to avoid double-clear.
  void stopTracking() {
    _tracking = false;
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
    _tracking = false;
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
    await RecentPatientsService.clear();
    await ApiConfig.clearAll();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}
