import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Windows-only helpers for top-level runner window actions.
///
/// The native side lives in `windows/runner/flutter_window.cpp`. Other
/// platforms return `false` without touching a platform channel.
class WindowsWindowControl {
  WindowsWindowControl._();

  static const MethodChannel _channel = MethodChannel(
    'vhhealth/windows_window',
  );

  static bool get isSupported => !kIsWeb && Platform.isWindows;

  /// Restore and foreground the Staff workbench window.
  static Future<bool> focus() async {
    if (!isSupported) return false;
    try {
      final focused = await _channel.invokeMethod<bool>('focusWindow');
      return focused ?? false;
    } on PlatformException catch (e) {
      if (kDebugMode) {
        debugPrint('WindowsWindowControl.focus failed: ${e.code}');
      }
      return false;
    } on MissingPluginException {
      if (kDebugMode) {
        debugPrint('WindowsWindowControl.focus: native channel missing');
      }
      return false;
    }
  }
}
