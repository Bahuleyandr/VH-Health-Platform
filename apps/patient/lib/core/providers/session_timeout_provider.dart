import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Tracks user activity and enforces an idle session timeout.
///
/// After [timeoutDuration] of inactivity, clears credentials and sets
/// [isSessionExpired] to true. The router redirect guard should check
/// this flag and navigate to the login screen.
class SessionTimeoutProvider extends ChangeNotifier {
  SessionTimeoutProvider({this.timeoutDuration = const Duration(minutes: 30)});

  final Duration timeoutDuration;

  Timer? _timer;
  bool _expired = false;
  static const _storage = FlutterSecureStorage();

  bool get isSessionExpired => _expired;

  /// Call on every user interaction (tap, scroll).
  void recordActivity() {
    if (_expired) return;
    _timer?.cancel();
    _timer = Timer(timeoutDuration, _onTimeout);
  }

  /// Start tracking. Call after login.
  void startTracking() {
    _expired = false;
    recordActivity();
  }

  /// Stop tracking. Call on explicit logout.
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
      await _storage.deleteAll();
    } catch (e) {
      debugPrint('SessionTimeout: failed to clear credentials: $e');
    }
    notifyListeners();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}
