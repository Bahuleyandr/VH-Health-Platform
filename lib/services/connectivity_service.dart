import 'dart:async';
import 'dart:io';
import 'package:flutter/foundation.dart';

/// Lightweight connectivity monitor shared by VHHealth apps.
class ConnectivityService {
  ConnectivityService._();

  static bool _isOnline = true;
  static Timer? _pollingTimer;
  static final _controller = StreamController<bool>.broadcast();

  static bool get isOnline => _isOnline;
  static Stream<bool> get onChange => _controller.stream;

  static void startMonitoring() {
    checkNow();
    _pollingTimer?.cancel();
    _pollingTimer = Timer.periodic(const Duration(seconds: 10), (_) {
      checkNow();
    });
  }

  static void stopMonitoring() {
    _pollingTimer?.cancel();
    _pollingTimer = null;
  }

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

    if (wasOnline != _isOnline) {
      _controller.add(_isOnline);
      if (kDebugMode) {
        debugPrint('Connectivity changed: ${_isOnline ? "online" : "offline"}');
      }
    }
    return _isOnline;
  }
}
