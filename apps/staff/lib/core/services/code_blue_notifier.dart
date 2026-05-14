import 'dart:ui' show Color;

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../platform_info.dart';

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

  static const String _channelId = 'code_blue';
  static const int _notificationId = 9001; // stable — replaces itself

  final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();

  bool _initialized = false;

  Future<void> initialize() async {
    if (_initialized) return;
    _initialized = true;

    const androidInit = AndroidInitializationSettings('@mipmap/ic_launcher');
    const iosInit = DarwinInitializationSettings(
      requestAlertPermission: true,
      requestBadgePermission: true,
      requestSoundPermission: true,
    );
    // Windows desktop builds require windowsInitializationSettings —
    // omitting it throws `Windows settings must be set when targeting
    // Windows platform` on the very first call to initialize() and the
    // app crashes before the splash screen renders. The appUserModelId
    // and guid are arbitrary stable identifiers used by Windows to
    // group toast notifications under the right app icon. The guid
    // here is one we generated for VH Health staff (regen with
    // `uuidgen` if you fork — must stay stable per-install).
    const windowsInit = WindowsInitializationSettings(
      appName: 'VH Health Staff',
      appUserModelId: 'com.vhhealth.staff',
      guid: '6f3d2f48-2c9e-4b13-8a3a-8e8c2c9ad701',
    );
    await _plugin.initialize(
      settings: const InitializationSettings(
        android: androidInit,
        iOS: iosInit,
        windows: windowsInit,
      ),
    );

    // Register the high-importance channel used for Code Blue full-screen intents.
    final androidPlugin = _plugin
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >();
    await androidPlugin?.createNotificationChannel(
      const AndroidNotificationChannel(
        _channelId,
        'Code Blue',
        description: 'Cardiac arrest / rapid response alerts',
        importance: Importance.max,
        playSound: true,
        enableVibration: true,
        showBadge: true,
      ),
    );

    // Android 13+ requires runtime consent for POST_NOTIFICATIONS; request it
    // eagerly so the Code Blue channel is actually allowed to notify.
    await androidPlugin?.requestNotificationsPermission();

    // Android 14+ gates USE_FULL_SCREEN_INTENT behind a user-granted runtime
    // permission — without it the notification still fires but won't bypass
    // lockscreen. Ask once at startup; if denied, fall back to a normal
    // high-importance notification.
    await androidPlugin?.requestFullScreenIntentPermission();

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
    final d = message.data;
    final parts = <String>[
      if ((d['ward'] ?? '').toString().isNotEmpty) 'Ward ${d['ward']}',
      if ((d['bedNumber'] ?? '').toString().isNotEmpty) 'Bed ${d['bedNumber']}',
      if ((d['reason'] ?? '').toString().isNotEmpty) d['reason'].toString(),
    ];
    final body = parts.isNotEmpty ? parts.join(' · ') : 'Respond immediately';

    await _plugin.show(
      id: _notificationId,
      title: 'CODE BLUE',
      body: body,
      notificationDetails: const NotificationDetails(
        android: AndroidNotificationDetails(
          _channelId,
          'Code Blue',
          channelDescription: 'Cardiac arrest / rapid response alerts',
          importance: Importance.max,
          priority: Priority.max,
          fullScreenIntent: true,
          category: AndroidNotificationCategory.alarm,
          visibility: NotificationVisibility.public,
          ongoing: true,
          autoCancel: false,
          color: Color(0xFFB71C1C),
          colorized: true,
        ),
        iOS: DarwinNotificationDetails(
          interruptionLevel: InterruptionLevel.critical,
          presentAlert: true,
          presentSound: true,
          presentBanner: true,
        ),
      ),
      payload: 'code_blue',
    );
  }
}
