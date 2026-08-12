import 'package:firebase_messaging/firebase_messaging.dart';

import 'staff_local_notifications.dart';
import 'staff_notification_session.dart';

/// Full-screen-intent Code Blue notifier for the staff app.
///
/// The in-app dialog in [CodeBlueListener] covers the foreground case. This
/// class covers **background/terminated** cases via a high-importance, opaque
/// FCM data message. Detailed ward/bed/reason content is fetched only through
/// the authenticated current-audience endpoint before local presentation.
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
  }

  bool _isCodeBlue(RemoteMessage msg) =>
      msg.data['type']?.toString() == 'code_blue';

  Future<void> handleForegroundMessage(RemoteMessage message) async {
    if (_isCodeBlue(message)) await showForMessage(message);
  }

  Future<void> showForMessage(RemoteMessage message) async {
    if (!_initialized) await initialize();
    final content = await codeBlueContentForMessage(message: message);
    await StaffLocalNotifications.instance.showCodeBlueFromData(
      content ?? const <String, dynamic>{},
      force: true,
    );
  }
}
