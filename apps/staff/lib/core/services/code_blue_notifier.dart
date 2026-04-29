import 'dart:ui' show Color;

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

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
    await _plugin.initialize(
      const InitializationSettings(android: androidInit, iOS: iosInit),
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
    FirebaseMessaging.onMessage.listen((msg) {
      if (_isCodeBlue(msg)) showForMessage(msg);
    });
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
      _notificationId,
      'CODE BLUE',
      body,
      const NotificationDetails(
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
