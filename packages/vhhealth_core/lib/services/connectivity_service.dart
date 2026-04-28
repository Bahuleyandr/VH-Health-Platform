import 'dart:async';
import 'dart:io';
import 'package:flutter/foundation.dart';

import '../config/api_config.dart';

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

  /// Probe host derived from ApiConfig.baseUrl. The previous hard-coded
  /// `api.vhhealth.app` lookup gave a permanent "offline" verdict on dev
  /// builds pointed at 10.0.2.2 / localhost / a staging host — which the
  /// dashboard surfaces as a sticky offline banner gating real
  /// interactions. Using the configured host makes the probe match the
  /// surface the rest of the app actually talks to.
  static String _probeHost() {
    try {
      final host = Uri.parse(ApiConfig.baseUrl).host;
      return host.isNotEmpty ? host : 'api.vhhealth.app';
    } catch (_) {
      return 'api.vhhealth.app';
    }
  }

  static Future<bool> checkNow() async {
    final wasOnline = _isOnline;
    final host = _probeHost();
    try {
      // Numeric host (e.g. 10.0.2.2) bypasses DNS — accept it as reachable
      // since DNS lookup of an IP literal is degenerate.
      if (InternetAddress.tryParse(host) != null) {
        _isOnline = true;
      } else {
        final result = await InternetAddress.lookup(host)
            .timeout(const Duration(seconds: 5));
        _isOnline = result.isNotEmpty && result.first.rawAddress.isNotEmpty;
      }
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
