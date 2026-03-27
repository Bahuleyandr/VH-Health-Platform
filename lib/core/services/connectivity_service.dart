// lib/core/services/connectivity_service.dart
import 'dart:async';
import 'dart:io';
import 'package:flutter/foundation.dart';

/// Lightweight connectivity monitor.
///
/// Uses a real DNS lookup (not a package dependency) to detect network state.
/// Exposes a [Stream] of connectivity changes and a synchronous [isOnline] flag.
class ConnectivityService {
  ConnectivityService._();

  static bool _isOnline = true;
  static Timer? _pollingTimer;
  static final _controller = StreamController<bool>.broadcast();

  /// Whether the device currently has internet connectivity.
  static bool get isOnline => _isOnline;

  /// Stream that emits `true`/`false` when connectivity changes.
  static Stream<bool> get onChange => _controller.stream;

  /// Start periodic connectivity checks (every 10 seconds).
  /// Call once from main.dart or app initialization.
  static void startMonitoring() {
    // Immediate check
    checkNow();
    // Periodic checks
    _pollingTimer?.cancel();
    _pollingTimer = Timer.periodic(const Duration(seconds: 10), (_) {
      checkNow();
    });
  }

  /// Stop monitoring (call on app teardown if needed).
  static void stopMonitoring() {
    _pollingTimer?.cancel();
    _pollingTimer = null;
  }

  /// Perform a connectivity check right now.
  static Future<bool> checkNow() async {
    final wasOnline = _isOnline;
    try {
      final result = await InternetAddress.lookup('api.vhhealth.app')
          .timeout(const Duration(seconds: 5));
      _isOnline = result.isNotEmpty && result.first.rawAddress.isNotEmpty;
    } on SocketException catch (_) {
      _isOnline = false;
    } on TimeoutException catch (_) {
      _isOnline = false;
    } catch (e) {
      if (kDebugMode) debugPrint('Connectivity check error: $e');
      _isOnline = false;
    }

    // Notify listeners on change
    if (wasOnline != _isOnline) {
      _controller.add(_isOnline);
      if (kDebugMode) {
        debugPrint('Connectivity changed: ${_isOnline ? "online" : "offline"}');
      }
    }
    return _isOnline;
  }
}
