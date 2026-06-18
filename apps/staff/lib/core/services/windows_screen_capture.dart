import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Windows-only screen-capture protection for the staff PHI workbench.
///
/// The cross-platform `screen_protector` plugin has **no Windows
/// implementation** (audit 2026-06-18, STF-1), so without this the clinical
/// workbench is fully screenshot-able on Windows desktops. This calls a native
/// method channel in `windows/runner/flutter_window.cpp`, which applies
/// `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` (falling back to
/// `WDA_MONITOR` on older Windows 10 builds) to exclude the top-level window
/// from screenshots and screen-share/recording.
///
/// No-op (returns `false`) on every non-Windows platform — callers stack this
/// after the cross-platform `ScreenProtector` calls, which already cover
/// Android/iOS.
class WindowsScreenCapture {
  WindowsScreenCapture._();

  static const MethodChannel _channel = MethodChannel(
    'vhhealth/screen_protector_windows',
  );

  /// Whether this platform has a native capture-protection implementation.
  static bool get isSupported => !kIsWeb && Platform.isWindows;

  /// Exclude the app window from screen capture. Returns `true` when the
  /// native side reports the affinity was applied. Returns `false` (without
  /// throwing) on unsupported platforms or if the native call fails — the
  /// caller is responsible for surfacing/logging a non-silent gap.
  static Future<bool> enable() => _invoke('enableCaptureProtection');

  /// Re-allow screen capture (e.g. on logout / teardown).
  static Future<bool> disable() => _invoke('disableCaptureProtection');

  static Future<bool> _invoke(String method) async {
    if (!isSupported) return false;
    try {
      // Native returns the applied display-affinity flag (>= 0) on success.
      final applied = await _channel.invokeMethod<int>(method);
      return applied != null && applied >= 0;
    } on PlatformException catch (e) {
      if (kDebugMode) {
        debugPrint('WindowsScreenCapture.$method failed: ${e.code}');
      }
      return false;
    } on MissingPluginException {
      // Native handler not registered (e.g. a stripped/older runner build).
      if (kDebugMode) {
        debugPrint('WindowsScreenCapture.$method: native channel missing');
      }
      return false;
    }
  }
}
