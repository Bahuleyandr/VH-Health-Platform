import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:vhhealth/core/navigation/app_router.dart';
import 'package:vhhealth/core/providers/notification_provider.dart';
import 'package:vhhealth/core/services/deep_link_service.dart';
import 'package:vhhealth/core/services/device_service.dart';
import 'package:vhhealth/core/services/notification_scheduler.dart';

class PushNotificationService {
  PushNotificationService._();

  static StreamSubscription<String>? _tokenRefreshSub;
  static StreamSubscription<RemoteMessage>? _messageSub;
  static StreamSubscription<RemoteMessage>? _messageOpenSub;
  static String? _currentPhone;
  static NotificationProvider? _notificationProvider;
  static bool _initialMessageHandled = false;

  static bool get _canUseMessaging {
    if (kIsWeb) return false;
    return Platform.isAndroid || Platform.isIOS;
  }

  static Future<void> configureHandlers() async {
    if (!_canUseMessaging) return;

    NotificationScheduler.setPayloadHandler(_handleLocalNotificationPayload);
    await NotificationScheduler.initialize();

    _messageSub ??= FirebaseMessaging.onMessage.listen(_handleForeground);
    _messageOpenSub ??= FirebaseMessaging.onMessageOpenedApp.listen(
      _routeRemoteMessage,
    );
  }

  static Future<void> syncForSignedInUser({
    required String phone,
    NotificationProvider? notificationProvider,
  }) async {
    if (!_canUseMessaging || phone.isEmpty || phone == 'guest') return;

    _currentPhone = phone;
    _notificationProvider = notificationProvider;
    await configureHandlers();
    await routeInitialMessageIfAny();

    final granted = await _requestNotificationPermission();
    if (!granted) return;

    try {
      final token = await FirebaseMessaging.instance.getToken();
      if (token != null && token.isNotEmpty) {
        await _uploadToken(phone: phone, token: token);
      }
    } catch (e) {
      if (kDebugMode) debugPrint('FCM token fetch failed: $e');
    }

    _tokenRefreshSub ??= FirebaseMessaging.instance.onTokenRefresh.listen((
      token,
    ) {
      final phone = _currentPhone;
      if (phone == null || phone.isEmpty || phone == 'guest') return;
      unawaited(_uploadToken(phone: phone, token: token));
    });
  }

  static void clearSignedInUser() {
    _currentPhone = null;
    _notificationProvider = null;
  }

  static Future<void> routeInitialMessageIfAny() async {
    if (!_canUseMessaging || _initialMessageHandled) return;
    _initialMessageHandled = true;
    try {
      final initial = await FirebaseMessaging.instance.getInitialMessage();
      if (initial != null) _routeRemoteMessage(initial);
    } catch (e) {
      if (kDebugMode) debugPrint('FCM initial message read failed: $e');
    }
  }

  static String? routeFromPayload(Map<String, dynamic> payload) {
    return DeepLinkService.parseNotificationRoute(payload);
  }

  static Future<void> handleBackgroundMessage(RemoteMessage message) async {
    if (!_canUseMessaging) return;
    if (message.notification != null) return;

    final payload = normalizedPayload(message);
    final title = _notificationTitle(message, payload);
    final body = _notificationBody(message, payload);
    if (title.isEmpty && body.isEmpty) return;

    try {
      await NotificationScheduler.showPushNotification(
        title: title,
        body: body,
        payload: payload,
      );
    } catch (e) {
      if (kDebugMode) debugPrint('Background push display skipped: $e');
    }
  }

  @visibleForTesting
  static Map<String, dynamic> normalizedPayload(RemoteMessage message) {
    return normalizePayload(message.data);
  }

  @visibleForTesting
  static Map<String, dynamic> normalizePayload(Map<String, dynamic> data) {
    final normalized = <String, dynamic>{};
    data.forEach((key, value) {
      normalized[key] = value?.toString();
    });
    return normalized;
  }

  static Future<bool> _requestNotificationPermission() async {
    try {
      var status = await Permission.notification.status;
      if (status.isDenied) {
        status = await Permission.notification.request();
      }
      return status.isGranted || status.isLimited || status.isProvisional;
    } catch (e) {
      if (kDebugMode) debugPrint('Notification permission request failed: $e');
      return false;
    }
  }

  static Future<void> _uploadToken({
    required String phone,
    required String token,
  }) async {
    final ok = await DeviceService.updateFcmToken(
      phone: phone,
      fcmToken: token,
    );
    if (!ok && kDebugMode) {
      debugPrint('FCM token upload rejected by backend');
    }
  }

  static Future<void> _handleForeground(RemoteMessage message) async {
    final payload = normalizedPayload(message);
    await NotificationScheduler.showPushNotification(
      title: _notificationTitle(message, payload),
      body: _notificationBody(message, payload),
      payload: payload,
    );

    final phone = _currentPhone;
    final provider = _notificationProvider;
    if (phone != null && provider != null) {
      unawaited(provider.refreshBadgeAfterPush(phone));
    }
  }

  static String _notificationTitle(
    RemoteMessage message,
    Map<String, dynamic> payload,
  ) {
    return message.notification?.title ??
        payload['title']?.toString() ??
        'VH Health';
  }

  static String _notificationBody(
    RemoteMessage message,
    Map<String, dynamic> payload,
  ) {
    return message.notification?.body ?? payload['body']?.toString() ?? '';
  }

  static void _routeRemoteMessage(RemoteMessage message) {
    final route = routeFromPayload(normalizedPayload(message));
    if (route != null) AppRouter.router.go(route);
  }

  static void _handleLocalNotificationPayload(String payload) {
    try {
      final decoded = jsonDecode(payload);
      if (decoded is! Map) return;
      final data = decoded.map((key, value) => MapEntry(key.toString(), value));
      final route = routeFromPayload(data);
      if (route != null) AppRouter.router.go(route);
    } catch (e) {
      if (kDebugMode) debugPrint('Push notification payload rejected: $e');
    }
  }
}
