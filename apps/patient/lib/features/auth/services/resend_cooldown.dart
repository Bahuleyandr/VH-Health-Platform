// lib/features/auth/services/resend_cooldown.dart
//
// Client-side countdown gate for the OTP "Resend" button. Firebase throttles
// aggressive resend requests server-side (too-many-requests); this keeps the
// button disabled long enough that a patient tapping repeatedly can't trip
// that throttle — and sets an expectation of when the next SMS can come.

import 'dart:async';

import 'package:flutter/foundation.dart';

/// Counts down from [duration] one second at a time, notifying listeners on
/// every tick. Restartable: call [start] after each successful OTP send.
class ResendCooldown extends ChangeNotifier {
  ResendCooldown({this.duration = const Duration(seconds: 30)});

  final Duration duration;

  Timer? _timer;
  int _remainingSeconds = 0;

  int get remainingSeconds => _remainingSeconds;
  bool get isActive => _remainingSeconds > 0;

  /// (Re)start the countdown. Call whenever an OTP send succeeds.
  void start() {
    _timer?.cancel();
    _remainingSeconds = duration.inSeconds;
    notifyListeners();
    _timer = Timer.periodic(const Duration(seconds: 1), (timer) {
      _remainingSeconds -= 1;
      if (_remainingSeconds <= 0) {
        _remainingSeconds = 0;
        timer.cancel();
        _timer = null;
      }
      notifyListeners();
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}
