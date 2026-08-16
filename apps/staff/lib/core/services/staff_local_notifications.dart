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
const String sosAlertNotificationPayload = 'sos_alert';

/// Payload for an SOS responder toast: `sos_alert:<alertId>` when the FCM
/// data carries the durable alert id (`sos_alert_id`, set by the backend
/// emergency fan-out), else the bare [sosAlertNotificationPayload]. Mirrors
/// [codeBluePayloadFromData].
@visibleForTesting
String sosAlertPayloadFromData(Map<String, dynamic> data) {
  final raw = _text(data['sos_alert_id'] ?? data['sosAlertId']);
  final alertId = int.tryParse(raw);
  if (alertId == null || alertId <= 0) return sosAlertNotificationPayload;
  return '$sosAlertNotificationPayload:$alertId';
}

/// Payload for a Code Blue toast: `code_blue:<eventId>` when the event data
/// carries a usable durable-event id, else the bare [codeBlueNotificationPayload].
/// Both the WS `staff:code-blue` event and the FCM authority-fetched content
/// carry `eventId` (the FCM path also historically `event_id`).
@visibleForTesting
String codeBluePayloadFromData(Map<String, dynamic> data) {
  final raw = _text(data['eventId'] ?? data['event_id']);
  final eventId = int.tryParse(raw);
  if (eventId == null || eventId <= 0) return codeBlueNotificationPayload;
  return '$codeBlueNotificationPayload:$eventId';
}

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
  if (payload == null) return null;
  // Code Blue tap deep-links straight to the durable resus record when the
  // payload carries the event id ("deep-link when cheap"). The router's
  // StaffRoutePolicy redirect still authorizes /safety/resus/:eventId, so an
  // unauthorized role bounces to the dashboard rather than the record.
  final codeBluePrefix = '$codeBlueNotificationPayload:';
  if (payload.startsWith(codeBluePrefix)) {
    final eventId = int.tryParse(payload.substring(codeBluePrefix.length));
    if (eventId != null && eventId > 0) return '/safety/resus/$eventId';
    return null;
  }
  // SOS tap deep-links to the responder surface (alert-focused when the
  // payload carries the id) — same policy note as Code Blue above: the
  // router's StaffRoutePolicy redirect still authorizes /sos-response.
  final sosPrefix = '$sosAlertNotificationPayload:';
  if (payload.startsWith(sosPrefix)) {
    final alertId = int.tryParse(payload.substring(sosPrefix.length));
    if (alertId != null && alertId > 0) return '/sos-response/$alertId';
    return '/sos-response';
  }
  return switch (payload) {
    sosAlertNotificationPayload => '/sos-response',
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
  static const String _sosChannelId = 'sos_alert';
  static const int _codeBlueNotificationId = 9001;
  static const int _sosNotificationId = 9002;
  static const int _messageFallbackNotificationId = 9101;

  final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();

  bool _initialized = false;
  bool _windowFocused = true;
  bool _acceptsSessionNotifications = true;

  bool get _isWindows => !kIsWeb && Platform.isWindows;

  @visibleForTesting
  bool get acceptsSessionNotifications => _acceptsSessionNotifications;

  void setWindowFocused(bool focused) {
    _windowFocused = focused;
  }

  void beginAuthenticatedSession() {
    _acceptsSessionNotifications = true;
  }

  void endAuthenticatedSession() {
    _acceptsSessionNotifications = false;
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
    await androidPlugin?.createNotificationChannel(
      const AndroidNotificationChannel(
        _sosChannelId,
        'SOS Alerts',
        description: 'Patient SOS emergency alerts for responders',
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
    if (!_acceptsSessionNotifications) return;
    if (!force &&
        !shouldShowDesktopToast(
          isWindows: _isWindows,
          windowFocused: _windowFocused,
        )) {
      return;
    }
    if (!_initialized) await initialize();
    if (!_acceptsSessionNotifications) return;

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
      payload: codeBluePayloadFromData(data),
    );
  }

  /// SOS responder alert (HIGH-1). Urgent but not the looping full-screen
  /// alarm reserved for Code Blue — responders get a max-importance toast
  /// whose tap deep-links to the alert on the responder surface.
  Future<void> showSosAlertFromData(
    Map<String, dynamic> data, {
    bool force = false,
  }) async {
    if (!_acceptsSessionNotifications) return;
    if (!force &&
        !shouldShowDesktopToast(
          isWindows: _isWindows,
          windowFocused: _windowFocused,
        )) {
      return;
    }
    if (!_initialized) await initialize();
    if (!_acceptsSessionNotifications) return;

    final body = <String>[
      if (_text(data['severity']).isNotEmpty)
        _text(data['severity']).toUpperCase(),
      if (_text(data['user_phone']).isNotEmpty) _text(data['user_phone']),
      if (_text(data['message']).isNotEmpty) _text(data['message']),
    ];
    await _plugin.show(
      id: _sosNotificationId,
      title: 'SOS ALERT',
      body: body.isNotEmpty ? body.join(' · ') : 'Open the SOS responder list',
      notificationDetails: NotificationDetails(
        android: const AndroidNotificationDetails(
          _sosChannelId,
          'SOS Alerts',
          channelDescription: 'Patient SOS emergency alerts for responders',
          importance: Importance.max,
          priority: Priority.max,
          category: AndroidNotificationCategory.alarm,
          visibility: NotificationVisibility.public,
          color: Color(0xFFB71C1C),
          colorized: true,
        ),
        iOS: const DarwinNotificationDetails(
          interruptionLevel: InterruptionLevel.timeSensitive,
          presentAlert: true,
          presentSound: true,
          presentBanner: true,
        ),
        windows: WindowsNotificationDetails(
          duration: WindowsNotificationDuration.long,
          scenario: WindowsNotificationScenario.urgent,
          audio: WindowsNotificationAudio.preset(
            sound: WindowsNotificationSound.alarm1,
          ),
          subtitle: 'Respond or resolve from the SOS list',
        ),
      ),
      payload: sosAlertPayloadFromData(data),
    );
  }

  Future<void> showStaffMessage({
    required String messageId,
    required String title,
    required String body,
    required String priority,
  }) async {
    if (!_acceptsSessionNotifications) return;
    if (!shouldShowDesktopToast(
      isWindows: _isWindows,
      windowFocused: _windowFocused,
    )) {
      return;
    }
    if (!_initialized) await initialize();
    if (!_acceptsSessionNotifications) return;

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
    endAuthenticatedSession();
    if (!_initialized) return;
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
