import 'dart:async';
import 'dart:io' show Platform;
import 'dart:ui' show Color;

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:go_router/go_router.dart';

import '../navigation/app_router.dart';
import 'windows_window_control.dart';

const String codeBlueNotificationPayload = 'code_blue';
const String staffMessageNotificationPayload = 'staff_message';

@visibleForTesting
bool shouldShowDesktopToast({
  required bool isWindows,
  required bool windowFocused,
}) => isWindows && !windowFocused;

@visibleForTesting
String codeBlueToastBodyFromData(Map<String, dynamic> data) {
  final parts = <String>[
    if (_text(data['ward']).isNotEmpty) 'Ward ${_text(data['ward'])}',
    if (_text(data['bedNumber']).isNotEmpty) 'Bed ${_text(data['bedNumber'])}',
    if (_text(data['reason']).isNotEmpty) _text(data['reason']),
  ];
  return parts.isNotEmpty ? parts.join(' · ') : 'Respond immediately';
}

@visibleForTesting
String? routeForNotificationPayload(String? payload) {
  return switch (payload) {
    staffMessageNotificationPayload => '/messaging',
    _ => null,
  };
}

@visibleForTesting
int stableNotificationId(String key, {required int fallback}) {
  final trimmed = key.trim();
  if (trimmed.isEmpty) return fallback;
  var hash = 0;
  for (final unit in trimmed.codeUnits) {
    hash = (hash * 31 + unit) & 0x3fffffff;
  }
  return 9100 + (hash % 100000);
}

class StaffLocalNotifications {
  StaffLocalNotifications._();
  static final StaffLocalNotifications instance = StaffLocalNotifications._();

  static const String _codeBlueChannelId = 'code_blue';
  static const int _codeBlueNotificationId = 9001;
  static const int _messageFallbackNotificationId = 9101;

  final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();

  bool _initialized = false;
  bool _windowFocused = true;

  bool get _isWindows => !kIsWeb && Platform.isWindows;

  void setWindowFocused(bool focused) {
    _windowFocused = focused;
  }

  Future<void> initialize() async {
    if (_initialized) return;
    _initialized = true;

    const androidInit = AndroidInitializationSettings('@mipmap/ic_launcher');
    const iosInit = DarwinInitializationSettings(
      requestAlertPermission: true,
      requestBadgePermission: true,
      requestSoundPermission: true,
    );
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
      onDidReceiveNotificationResponse: (response) {
        unawaited(_handleNotificationActivation(response.payload));
      },
    );

    final androidPlugin = _plugin
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >();
    await androidPlugin?.createNotificationChannel(
      const AndroidNotificationChannel(
        _codeBlueChannelId,
        'Code Blue',
        description: 'Cardiac arrest / rapid response alerts',
        importance: Importance.max,
        playSound: true,
        enableVibration: true,
        showBadge: true,
      ),
    );
    await androidPlugin?.requestNotificationsPermission();
    await androidPlugin?.requestFullScreenIntentPermission();
  }

  Future<void> showCodeBlueFromData(
    Map<String, dynamic> data, {
    bool force = false,
  }) async {
    if (!force &&
        !shouldShowDesktopToast(
          isWindows: _isWindows,
          windowFocused: _windowFocused,
        )) {
      return;
    }
    if (!_initialized) await initialize();

    await _plugin.show(
      id: _codeBlueNotificationId,
      title: 'CODE BLUE',
      body: codeBlueToastBodyFromData(data),
      notificationDetails: NotificationDetails(
        android: const AndroidNotificationDetails(
          _codeBlueChannelId,
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
        iOS: const DarwinNotificationDetails(
          interruptionLevel: InterruptionLevel.critical,
          presentAlert: true,
          presentSound: true,
          presentBanner: true,
        ),
        windows: WindowsNotificationDetails(
          duration: WindowsNotificationDuration.long,
          scenario: WindowsNotificationScenario.alarm,
          audio: WindowsNotificationAudio.preset(
            sound: WindowsNotificationSound.alarm2,
            shouldLoop: true,
          ),
          subtitle: 'Respond immediately',
        ),
      ),
      payload: codeBlueNotificationPayload,
    );
  }

  Future<void> showStaffMessage({
    required String messageId,
    required String title,
    required String body,
    required String priority,
  }) async {
    if (!shouldShowDesktopToast(
      isWindows: _isWindows,
      windowFocused: _windowFocused,
    )) {
      return;
    }
    if (!_initialized) await initialize();

    final urgent = priority == 'critical' || priority == 'urgent';
    await _plugin.show(
      id: stableNotificationId(
        messageId,
        fallback: _messageFallbackNotificationId,
      ),
      title: title,
      body: body,
      notificationDetails: NotificationDetails(
        windows: WindowsNotificationDetails(
          duration: urgent
              ? WindowsNotificationDuration.long
              : WindowsNotificationDuration.short,
          scenario: urgent ? WindowsNotificationScenario.urgent : null,
          audio: urgent
              ? WindowsNotificationAudio.preset(
                  sound: WindowsNotificationSound.reminder,
                )
              : WindowsNotificationAudio.preset(
                  sound: WindowsNotificationSound.defaultSound,
                ),
        ),
      ),
      payload: staffMessageNotificationPayload,
    );
  }

  Future<void> cancelSessionNotifications() async {
    if (!_initialized) await initialize();
    await _plugin.cancelAll();
  }

  Future<void> _handleNotificationActivation(String? payload) async {
    await WindowsWindowControl.focus();
    final route = routeForNotificationPayload(payload);
    if (route == null) return;

    final context = rootNavigatorKey.currentContext;
    if (context == null || !context.mounted) return;
    context.go(route);
  }
}

String _text(Object? value) => value?.toString().trim() ?? '';
