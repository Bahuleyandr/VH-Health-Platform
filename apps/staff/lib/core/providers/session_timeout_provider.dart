import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import '../platform_info.dart';
import '../services/auth_service.dart';
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
    Duration warningDuration = const Duration(seconds: 60),
    Duration countdownTickDuration = const Duration(seconds: 1),
    SessionTimeoutCleanup? beforeTimeoutCleanup,
    SessionTimeoutCleanup? onTimeoutCleanup,
  }) : _timeoutDuration = timeoutDuration,
       _warningDuration = warningDuration,
       _countdownTickDuration = countdownTickDuration,
       _beforeTimeoutCleanup = beforeTimeoutCleanup,
       _onTimeoutCleanup = onTimeoutCleanup ?? _defaultTimeoutCleanup;

  /// How long the user can be idle before automatic logout.
  Duration get timeoutDuration => _timeoutDuration;
  Duration get warningDuration => _warningDuration;

  Duration _timeoutDuration;
  final Duration _warningDuration;
  final Duration _countdownTickDuration;
  final SessionTimeoutCleanup? _beforeTimeoutCleanup;
  final SessionTimeoutCleanup _onTimeoutCleanup;

  Timer? _timer;
  Timer? _warningTimer;
  Timer? _countdownTimer;
  bool _expired = false;
  bool _tracking = false;
  bool _warningVisible = false;
  bool _sessionLocked = false;
  bool _timeoutCleanupInProgress = false;
  bool _disposed = false;
  Duration _warningRemaining = Duration.zero;
  int _preservedOfflineWriteCount = 0;

  /// `true` after the idle timeout fires. Reset by [resetSession].
  bool get isSessionExpired => _expired;

  bool get isTracking => _tracking;
  bool get isSessionLocked => _sessionLocked;
  bool get isTimeoutCleanupInProgress => _timeoutCleanupInProgress;
  bool get isWarningVisible => _warningVisible;
  Duration get warningRemaining => _warningRemaining;
  int get warningSecondsRemaining =>
      (_warningRemaining.inMilliseconds / 1000).ceil().clamp(0, 999999);
  int get preservedOfflineWriteCount => _preservedOfflineWriteCount;
  bool get hasPreservedOfflineWrites => _preservedOfflineWriteCount > 0;

  /// Call this on every user interaction (tap, scroll, keyboard).
  /// Resets the idle countdown.
  void recordActivity() {
    if (!_tracking) return;
    if (_expired) return; // already expired - don't restart
    _scheduleIdleTimers();
  }

  /// Explicit "I'm still here" action from the warning banner/dialog.
  void extendSession() => recordActivity();

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
    final shouldNotify = _expired || _sessionLocked;
    _tracking = true;
    _expired = false;
    _sessionLocked = false;
    _timeoutCleanupInProgress = false;
    _preservedOfflineWriteCount = 0;
    recordActivity();
    if (shouldNotify && !_disposed) notifyListeners();
  }

  /// Stop tracking. Call on explicit logout to avoid double-clear.
  void stopTracking() {
    _tracking = false;
    _cancelTimers();
    _clearWarningState();
  }

  /// Reset after re-login.
  void resetSession() {
    _expired = false;
    _sessionLocked = false;
    _timeoutCleanupInProgress = false;
    _preservedOfflineWriteCount = 0;
    _clearWarningState();
    notifyListeners();
    startTracking();
  }

  /// Immediately hides the authenticated surface while revocation or timeout
  /// cleanup is still running. This is intentionally independent of tracking:
  /// forced revocation stops the timer but must keep the surface locked.
  void lockSession() {
    if (_sessionLocked) return;
    _sessionLocked = true;
    if (!_disposed) notifyListeners();
  }

  void unlockSession() {
    if (!_sessionLocked) return;
    _sessionLocked = false;
    if (!_disposed) notifyListeners();
  }

  Future<void> _onTimeout() async {
    _tracking = false;
    _expired = true;
    _timeoutCleanupInProgress = true;
    _cancelTimers();
    _clearWarningState();
    // Publish the locked state before the first await so the previous
    // clinician's surface cannot remain visible during asynchronous teardown.
    lockSession();
    _preservedOfflineWriteCount = await _pendingOfflineWriteCount();
    try {
      await _beforeTimeoutCleanup?.call();
    } catch (e) {
      debugPrint('SessionTimeout: failed to stop authenticated providers: $e');
    }
    try {
      await _onTimeoutCleanup();
    } catch (e) {
      debugPrint('SessionTimeout: failed to clear local session state: $e');
    }
    _timeoutCleanupInProgress = false;
    if (!_disposed) notifyListeners();
  }

  void _scheduleIdleTimers() {
    final shouldNotify = _warningVisible || _warningRemaining != Duration.zero;
    _cancelTimers();
    _clearWarningState();

    if (_timeoutDuration <= Duration.zero) {
      unawaited(_onTimeout());
      return;
    }

    final effectiveWarningDuration = _timeoutDuration <= _warningDuration
        ? _timeoutDuration
        : _warningDuration;
    final warningDelay = _timeoutDuration - effectiveWarningDuration;
    if (effectiveWarningDuration > Duration.zero) {
      if (warningDelay > Duration.zero) {
        _warningTimer = Timer(
          warningDelay,
          () => _showWarning(effectiveWarningDuration),
        );
      } else {
        scheduleMicrotask(() => _showWarning(effectiveWarningDuration));
      }
    }
    _timer = Timer(_timeoutDuration, _onTimeout);
    if (shouldNotify && !_disposed) notifyListeners();
  }

  void _showWarning(Duration remaining) {
    if (!_tracking || _expired) return;
    _warningVisible = true;
    _warningRemaining = remaining;
    _countdownTimer?.cancel();
    if (_countdownTickDuration > Duration.zero) {
      _countdownTimer = Timer.periodic(_countdownTickDuration, (_) {
        final next = _warningRemaining - _countdownTickDuration;
        _warningRemaining = next.isNegative ? Duration.zero : next;
        if (_warningRemaining == Duration.zero) {
          _countdownTimer?.cancel();
          _countdownTimer = null;
        }
        if (!_disposed) notifyListeners();
      });
    }
    if (!_disposed) notifyListeners();
  }

  void _cancelTimers() {
    _timer?.cancel();
    _timer = null;
    _warningTimer?.cancel();
    _warningTimer = null;
    _countdownTimer?.cancel();
    _countdownTimer = null;
  }

  void _clearWarningState() {
    _warningVisible = false;
    _warningRemaining = Duration.zero;
  }

  static Future<int> _pendingOfflineWriteCount() async {
    try {
      return await ConnectivitySyncService.instance
          .pendingWriteCountForCurrentOwner();
    } catch (e) {
      debugPrint('SessionTimeout: offline queue count failed: $e');
      return 0;
    }
  }

  static Future<void> _defaultTimeoutCleanup() async {
    await RecentPatientsService.clear();
    // Idle timeout must end the session server-side too (STF-5): previously
    // this only cleared local state, leaving the bearer token and refresh
    // credential alive on the backend after the on-device auto-logout.
    // logoutForIdleTimeout revokes best-effort, then clears local identity
    // and tears down the realtime socket.
    await AuthService.logoutForIdleTimeout();
  }

  @override
  void dispose() {
    _disposed = true;
    _cancelTimers();
    super.dispose();
  }
}
