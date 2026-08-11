import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:vhhealth/core/navigation/app_router.dart';
import 'package:vhhealth/core/outage/patient_outage_controller.dart';
import 'package:vhhealth/core/providers/notification_provider.dart';
import 'package:vhhealth/core/services/deep_link_service.dart';
import 'package:vhhealth/core/services/device_service.dart';
import 'package:vhhealth/core/services/notification_scheduler.dart';
import 'package:vhhealth/core/services/patient_notification_privacy.dart';
import 'package:vhhealth/core/services/patient_notification_tap_gate.dart';

class PushNotificationService {
  PushNotificationService._();

  static StreamSubscription<String>? _tokenRefreshSub;
  static StreamSubscription<RemoteMessage>? _messageSub;
  static StreamSubscription<RemoteMessage>? _messageOpenSub;
  static String? _currentPhone;
  static NotificationProvider? _notificationProvider;
  static bool _initialMessageHandled = false;
  static final _notificationTapGate = PatientNotificationTapGate(
    revalidateSession: () => PatientOutageController.instance.probeNow(),
    navigate: AppRouter.router.go,
  );

  static bool get _canUseMessaging {
    if (kIsWeb) return false;
    return Platform.isAndroid || Platform.isIOS;
  }

  static Future<void> configureHandlers() async {
    if (!_canUseMessaging) return;

    NotificationScheduler.setPayloadHandler(_handleLocalNotificationPayload);
    await NotificationScheduler.initialize();

    _messageSub ??= FirebaseMessaging.onMessage.listen(_handleForeground);
    _messageOpenSub ??= FirebaseMessaging.onMessageOpenedApp.listen((message) {
      unawaited(_routeRemoteMessage(message));
    });
  }

  static Future<bool> syncForSignedInUser({
    required String phone,
    NotificationProvider? notificationProvider,
    bool routeInitialMessage = true,
  }) async {
    if (!_canUseMessaging || phone.isEmpty || phone == 'guest') return false;

    _currentPhone = phone;
    _notificationProvider = notificationProvider;
    await configureHandlers();
    final initialMessageRouted = routeInitialMessage
        ? await routeInitialMessageIfAny()
        : false;

    final granted = await _requestNotificationPermission();
    if (!granted) return initialMessageRouted;

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
    return initialMessageRouted;
  }

  static void clearSignedInUser() {
    _currentPhone = null;
    _notificationProvider = null;
  }

  static Future<bool> routeInitialMessageIfAny() async {
    if (!_canUseMessaging || _initialMessageHandled) return false;
    _initialMessageHandled = true;
    try {
      final initial = await FirebaseMessaging.instance.getInitialMessage();
      return initial != null && await _routeRemoteMessage(initial);
    } catch (e) {
      if (kDebugMode) debugPrint('FCM initial message read failed: $e');
      return false;
    }
  }

  static String? routeFromPayload(Map<String, dynamic> payload) {
    return DeepLinkService.parseNotificationRoute(payload);
  }

  static Future<void> handleBackgroundMessage(RemoteMessage message) async {
    if (!_canUseMessaging) return;
    if (message.notification != null) return;

    final payload = normalizedPayload(message);
    final copy = patientLockScreenCopy(
      remoteTitle: message.notification?.title,
      remoteBody: message.notification?.body,
      payload: payload,
    );

    try {
      await NotificationScheduler.showPushNotification(
        title: copy.title,
        body: copy.body,
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
    return patientNotificationPayload(data);
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
    final copy = patientLockScreenCopy(
      remoteTitle: message.notification?.title,
      remoteBody: message.notification?.body,
      payload: payload,
    );
    await NotificationScheduler.showPushNotification(
      title: copy.title,
      body: copy.body,
      payload: payload,
    );

    final phone = _currentPhone;
    final provider = _notificationProvider;
    if (phone != null && provider != null) {
      unawaited(provider.refreshBadgeAfterPush(phone));
    }
  }

  static Future<bool> _routeRemoteMessage(RemoteMessage message) =>
      _notificationTapGate.open(normalizedPayload(message));

  static void _handleLocalNotificationPayload(String payload) {
    try {
      final decoded = jsonDecode(payload);
      if (decoded is! Map) return;
      final data = decoded.map((key, value) => MapEntry(key.toString(), value));
      unawaited(_notificationTapGate.open(data));
    } catch (e) {
      if (kDebugMode) debugPrint('Push notification payload rejected: $e');
    }
  }
}
