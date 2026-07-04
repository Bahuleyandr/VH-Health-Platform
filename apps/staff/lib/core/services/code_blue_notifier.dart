import 'package:firebase_messaging/firebase_messaging.dart';

import '../platform_info.dart';
import 'staff_local_notifications.dart';

/// Full-screen-intent Code Blue notifier for the staff app.
///
/// The in-app dialog in [CodeBlueListener] covers the foreground case. This
/// class covers **background/terminated** cases via a high-importance FCM data
/// message (sent by the backend `emitCodeBlue` fan-out) that wakes the device
/// and displays a full-screen notification which bypasses lockscreen per
/// Android's `USE_FULL_SCREEN_INTENT` permission.
///
/// **Platform setup required** (not done automatically — verify before build):
///   * Android manifest: `<uses-permission android:name="android.permission.USE_FULL_SCREEN_INTENT"/>`
///     plus POST_NOTIFICATIONS on Android 13+.
///   * Android 14+ requires the user granting full-screen intent permission at runtime.
///   * iOS: enable Critical Alerts entitlement if `interruption-level: critical`
///     should bypass silent mode.
class CodeBlueNotifier {
  CodeBlueNotifier._();
  static final CodeBlueNotifier instance = CodeBlueNotifier._();

  bool _initialized = false;

  Future<void> initialize() async {
    if (_initialized) return;
    _initialized = true;

    await StaffLocalNotifications.instance.initialize();

    // Wire the FCM data-message handler (foreground path — backend already
    // delivers via staff:code-blue WS on foreground, but showing the full
    // notification here too is cheap and makes the two channels convergent).
    // firebase_messaging has no desktop implementation; on Windows/Linux/macOS
    // the WebSocket staff:code-blue channel is the sole delivery path, so the
    // local-notification plumbing above is still wired but the FCM listener
    // is skipped.
    if (!isDesktopPlatform) {
      FirebaseMessaging.onMessage.listen((msg) {
        if (_isCodeBlue(msg)) showForMessage(msg);
      });
    }
  }

  bool _isCodeBlue(RemoteMessage msg) =>
      msg.data['type']?.toString() == 'code_blue';

  Future<void> showForMessage(RemoteMessage message) async {
    if (!_initialized) await initialize();
    await StaffLocalNotifications.instance.showCodeBlueFromData(
      Map<String, dynamic>.from(message.data),
      force: true,
    );
  }
}
