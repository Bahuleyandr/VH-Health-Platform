import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

import '../../l10n/app_strings.dart';
import '../config/api_config.dart';
import '../navigation/staff_route_policy.dart';
import '../platform_info.dart';
import '../services/code_blue_notifier.dart';
import '../services/hr_api_service.dart';
import '../services/staff_local_notifications.dart';
import '../services/staff_notification_session.dart';

abstract interface class NotificationMessaging {
  Future<AuthorizationStatus> requestPermission();
  Future<String?> getToken();
  Future<void> deleteToken();
  Stream<String> get onTokenRefresh;
  Stream<RemoteMessage> get onMessage;
}

class _FirebaseNotificationMessaging implements NotificationMessaging {
  FirebaseMessaging get _messaging => FirebaseMessaging.instance;

  @override
  Future<AuthorizationStatus> requestPermission() async {
    final settings = await _messaging.requestPermission(
      alert: true,
      badge: true,
      sound: true,
    );
    return settings.authorizationStatus;
  }

  @override
  Future<String?> getToken() => _messaging.getToken();

  @override
  Future<void> deleteToken() => _messaging.deleteToken();

  @override
  Stream<String> get onTokenRefresh => _messaging.onTokenRefresh;

  @override
  Stream<RemoteMessage> get onMessage => FirebaseMessaging.onMessage;
}

typedef NotificationDeviceRegistrar =
    Future<StaffNotificationAudience> Function({
      required String? phone,
      required String fcmToken,
      required String platform,
    });
typedef NotificationDeviceUnregister = Future<void> Function();
typedef NotificationPhoneLoader = Future<String?> Function();
typedef NotificationStaffUidLoader = Future<String?> Function();
typedef NotificationAuthenticationCheck = Future<bool> Function();
typedef NotificationPlatformLoader = String Function();
typedef NotificationFetcher = Future<List<dynamic>> Function();
typedef NotificationForegroundMessageHandler = Future<void> Function(
  RemoteMessage message,
);
typedef NotificationSurfaceCleaner = Future<void> Function();

class NotificationItem {
  static const Set<String> _localizedActionLabelKeys = {
    'clinical_inbox.open_workflow',
    'mar_supply.notification_action',
    'med03.credit_note.notification_action',
    'med03.notification.gateway_refund_reconciliation.action',
    'orders.mar_recovery.action',
    's4.lib.counter_sale.open_finance_workflow',
    's4.lib.counter_sale.open_reconciliation',
  };

  static const Map<String, String> _localizedTitleKeys = {
    'MAR_MEDICATION_EXCEPTION': 'med03.notification.mar_exception.title',
    'MAR_MEDICATION_EXCEPTION_ESCALATION':
        'med03.notification.mar_exception.overdue_title',
    'MAR_MEDICATION_EXCEPTION_ASSIGNMENT_HANDOFF':
        'med03.notification.mar_exception.handoff_title',
    'COUNTER_SALE_VOID_REFUND_REQUIRED':
        'med03.notification.counter_sale.finance_title',
    'COUNTER_SALE_VOID_REFUND_PAYOUT_REQUIRED':
        'med03.notification.counter_sale.finance_title',
    'COUNTER_SALE_VOID_REJECTED_REVIEW_REQUIRED':
        'med03.notification.counter_sale.reconciliation_title',
    'COUNTER_SALE_VOID_REFUND_REJECTED':
        'med03.notification.counter_sale.reconciliation_title',
    'COUNTER_SALE_VOID_COMPLETED':
        'med03.notification.counter_sale.completed_title',
    'WARD_INDENT_CREDIT_NOTE_REVIEW': 'med03.credit_note.title',
    'WARD_INDENT_CREDIT_NOTE_REFUND_APPROVAL':
        'med03.credit_note.refund_approve_title',
    'WARD_INDENT_CREDIT_NOTE_REFUND_PAYOUT': 'med03.credit_note.payout_title',
    'WARD_INDENT_MAR_SUPPLY_RECONCILIATION': 'mar_supply.title',
    'GATEWAY_REFUND_RECONCILIATION':
        'med03.notification.gateway_refund_reconciliation.title',
    'CLINICAL_ALERT_DELIVERY_RECOVERY_OVERDUE':
        'med03.notification.alert_recovery.overdue_title',
  };

  static const Map<String, String> _localizedBodyKeys = {
    'MAR_MEDICATION_EXCEPTION': 'med03.notification.mar_exception.body',
    'MAR_MEDICATION_EXCEPTION_ESCALATION':
        'med03.notification.mar_exception.overdue_body',
    'MAR_MEDICATION_EXCEPTION_ASSIGNMENT_HANDOFF':
        'med03.notification.mar_exception.handoff_body',
    'COUNTER_SALE_VOID_REFUND_REQUIRED':
        'med03.notification.counter_sale.finance_body',
    'COUNTER_SALE_VOID_REFUND_PAYOUT_REQUIRED':
        'med03.notification.counter_sale.finance_body',
    'COUNTER_SALE_VOID_REJECTED_REVIEW_REQUIRED':
        'med03.notification.counter_sale.reconciliation_body',
    'COUNTER_SALE_VOID_REFUND_REJECTED':
        'med03.notification.counter_sale.reconciliation_body',
    'COUNTER_SALE_VOID_COMPLETED':
        'med03.notification.counter_sale.completed_body',
    'WARD_INDENT_CREDIT_NOTE_REVIEW': 'med03.credit_note.select',
    'WARD_INDENT_CREDIT_NOTE_REFUND_APPROVAL':
        'med03.credit_note.refund_approve_body',
    'WARD_INDENT_CREDIT_NOTE_REFUND_PAYOUT':
        'med03.notification.credit_note_payout.body',
    'WARD_INDENT_MAR_SUPPLY_RECONCILIATION': 'mar_supply.help',
    'GATEWAY_REFUND_RECONCILIATION':
        'med03.notification.gateway_refund_reconciliation.body',
    'CLINICAL_ALERT_DELIVERY_RECOVERY_OVERDUE':
        'med03.notification.alert_recovery.overdue_body',
  };

  final String? id;
  final String title;
  final String body;
  final DateTime timestamp;
  final String? type;
  final String? priority;
  final Object? relatedId;
  final Map<String, dynamic> data;
  bool isRead;

  NotificationItem({
    this.id,
    required this.title,
    required this.body,
    required this.timestamp,
    this.type,
    this.priority,
    this.relatedId,
    this.data = const {},
    this.isRead = false,
  });

  factory NotificationItem.fromApi(dynamic item) {
    final map = item is Map
        ? Map<String, dynamic>.from(item)
        : <String, dynamic>{};
    final data = _parseDataMap(map['data']);
    final title = (map['title'] ?? '').toString().trim();
    return NotificationItem(
      id: map['id']?.toString(),
      title: title.isNotEmpty ? title : 'Notification',
      body: (map['message'] ?? map['body'] ?? '').toString(),
      timestamp:
          DateTime.tryParse(
            (map['created_at'] ?? map['timestamp'] ?? '').toString(),
          ) ??
          DateTime.now(),
      type: (map['type'] ?? data['type'] ?? data['event_type'])?.toString(),
      priority: map['priority']?.toString(),
      relatedId: map['related_id'] ?? map['relatedId'] ?? data['related_id'],
      data: data,
      isRead: map['is_read'] == true || map['isRead'] == true,
    );
  }

  String get normalizedType =>
      (type ?? data['event_type']?.toString() ?? '').trim().toUpperCase();

  String get normalizedPriority =>
      (priority ?? data['priority']?.toString() ?? '').trim().toUpperCase();

  bool get isHighPriority =>
      normalizedPriority == 'HIGH' ||
      normalizedPriority == 'CRITICAL' ||
      normalizedType.contains('CRITICAL') ||
      normalizedType.contains('EMERGENCY') ||
      normalizedType.contains('SOS');

  bool get isAppointmentAlert =>
      _hasAny(normalizedType, const ['APPOINTMENT', 'BOOKING', 'QUEUE']);

  bool get isAdmissionAlert =>
      _hasAny(normalizedType, const ['ADMISSION', 'IPD']);

  bool get isBedAlert => _hasAny(normalizedType, const ['BED', 'CLEANING']);

  bool get isHousekeepingAlert => normalizedType.contains('HOUSEKEEPING');

  bool get isInvestigationAlert => _hasAny(normalizedType, const [
    'LAB',
    'INVESTIGATION',
    'CRITICAL_VALUE',
    'RADIOLOGY',
  ]);

  String titleFor(AppStrings strings) {
    final key = _localizedTitleKeys[normalizedType];
    return key == null ? title : strings.lookup(key);
  }

  String bodyFor(AppStrings strings) {
    if (normalizedType == 'CLINICAL_ALERT_DELIVERY_RECOVERY_OVERDUE') {
      final caseKind = data['case_kind']?.toString().trim().toLowerCase();
      if (caseKind == 'manual_hold') {
        return strings.lookup(
          'med03.notification.alert_recovery.manual_hold_body',
        );
      }
      if (caseKind == 'recipient_coverage') {
        return strings.lookup(
          'med03.notification.alert_recovery.recipient_coverage_body',
        );
      }
    }
    final key = _localizedBodyKeys[normalizedType];
    return key == null ? body : strings.lookup(key);
  }

  String? get actionRoute {
    if (normalizedType == 'WARD_PHARMACY_INDENT' &&
        data['dispatch_surface_available'] != true) {
      return null;
    }
    final route = data['route']?.toString().trim();
    final explicit = route != null && route.isNotEmpty
        ? route
        : data['deep_link']?.toString().trim();
    if (explicit != null && explicit.isNotEmpty) {
      return StaffRoutePolicy.sanitizeExternalRoute(explicit);
    }
    // SOS/EMERGENCY deep-links straight to the alert when the backend fan-out
    // carried data.sos_alert_id (mirrors the Code Blue /safety/resus/:eventId
    // deep-link precedent); StaffRoutePolicy still authorizes the role.
    // SOS_BROADCAST is an all-staff informational blast, not a responder
    // work item — it keeps no action route.
    final type = normalizedType;
    if (_isSosResponderType(type)) {
      final alertId = int.tryParse(
        (data['sos_alert_id'] ?? data['sosAlertId'] ?? '').toString(),
      );
      return StaffRoutePolicy.sanitizeExternalRoute(
        alertId != null && alertId > 0
            ? '/sos-response/$alertId'
            : '/sos-response',
      );
    }
    return StaffRoutePolicy.sanitizeExternalRoute(
      _defaultRouteForType(normalizedType),
    );
  }

  String actionLabelFor(AppStrings strings) {
    final localizedKey = data['action_label_key']?.toString().trim();
    if (localizedKey != null &&
        _localizedActionLabelKeys.contains(localizedKey)) {
      return strings.lookup(localizedKey);
    }
    final explicit = data['action_label']?.toString().trim();
    if (explicit != null && explicit.isNotEmpty) return explicit;
    if (_isSosResponderType(normalizedType)) return 'Open SOS alert';
    if (normalizedType == 'WARD_INDENT_MAR_SUPPLY_RECONCILIATION') {
      return strings.lookup('mar_supply.notification_action');
    }
    if (normalizedType.startsWith('MAR_MEDICATION_EXCEPTION')) {
      return strings.lookup('orders.mar_recovery.action');
    }
    if (normalizedType == 'GATEWAY_REFUND_RECONCILIATION') {
      return strings.lookup(
        'med03.notification.gateway_refund_reconciliation.action',
      );
    }
    if (const {
      'COUNTER_SALE_VOID_REFUND_REQUIRED',
      'COUNTER_SALE_VOID_REFUND_PAYOUT_REQUIRED',
    }.contains(normalizedType)) {
      return strings.lookup('s4.lib.counter_sale.open_finance_workflow');
    }
    if (const {
      'COUNTER_SALE_VOID_REJECTED_REVIEW_REQUIRED',
      'COUNTER_SALE_VOID_REFUND_REJECTED',
      'COUNTER_SALE_VOID_COMPLETED',
    }.contains(normalizedType)) {
      return strings.lookup('s4.lib.counter_sale.open_reconciliation');
    }
    if (isAppointmentAlert) return 'Open appointment';
    if (isAdmissionAlert) return 'Open admission';
    if (isHousekeepingAlert) return 'Open housekeeping task';
    if (isBedAlert) return 'Open bed';
    if (isInvestigationAlert) return 'Open investigation';
    if (normalizedType.contains('REFERRAL')) return 'Open referral';
    if (normalizedType.contains('PATIENT')) return 'Open patient';
    if (normalizedType.contains('PHARMACY') ||
        normalizedType.contains('MEDICATION')) {
      return 'Open pharmacy';
    }
    return 'Open';
  }

  String get actionLabel =>
      actionLabelFor(AppStrings.forLocale(const Locale('en')));
}

class NotificationProvider extends ChangeNotifier {
  NotificationProvider({
    NotificationMessaging? messaging,
    NotificationDeviceRegistrar? registerDevice,
    NotificationDeviceUnregister? unregisterDevice,
    NotificationPhoneLoader? phoneLoader,
    NotificationStaffUidLoader? staffUidLoader,
    NotificationAuthenticationCheck? isAuthenticated,
    StaffNotificationClaimsLoader? notificationClaimsLoader,
    StaffNotificationAuthorityValidator? notificationAuthorityValidator,
    NotificationPlatformLoader? platformLoader,
    NotificationFetcher? fetchNotifications,
    NotificationForegroundMessageHandler? foregroundMessageHandler,
    NotificationSurfaceCleaner? clearDeliveredNotifications,
    StaffNotificationSessionStore? sessionStore,
    bool? supportsPush,
  }) : _messaging = messaging ?? _FirebaseNotificationMessaging(),
       _registerDevice = registerDevice ?? HrApiService.registerDevice,
       _unregisterDevice =
           unregisterDevice ?? HrApiService.unregisterNotificationDevice,
       _phoneLoader = phoneLoader ?? ApiConfig.getPhone,
       _staffUidLoader = staffUidLoader ?? ApiConfig.getStaffUid,
       _isAuthenticated = isAuthenticated ?? ApiConfig.isLoggedIn,
       _notificationClaimsLoader =
           notificationClaimsLoader ?? ApiConfig.getStaffJwtClaims,
       // Public constructor seam intentionally keeps a non-private parameter.
       // ignore: prefer_initializing_formals
       _notificationAuthorityValidator = notificationAuthorityValidator,
       _platformLoader = platformLoader ?? _defaultPlatform,
       _fetchNotifications =
           fetchNotifications ?? HrApiService.getNotifications,
       _foregroundMessageHandler =
           foregroundMessageHandler ??
           CodeBlueNotifier.instance.handleForegroundMessage,
       _clearDeliveredNotifications =
           clearDeliveredNotifications ??
           StaffLocalNotifications.instance.cancelSessionNotifications,
       _sessionStore = sessionStore ?? StaffNotificationSessionStore.instance,
       _supportsPush = supportsPush ?? !isDesktopPlatform;

  final NotificationMessaging _messaging;
  final NotificationDeviceRegistrar _registerDevice;
  final NotificationDeviceUnregister _unregisterDevice;
  final NotificationPhoneLoader _phoneLoader;
  final NotificationStaffUidLoader _staffUidLoader;
  final NotificationAuthenticationCheck _isAuthenticated;
  final StaffNotificationClaimsLoader _notificationClaimsLoader;
  final StaffNotificationAuthorityValidator? _notificationAuthorityValidator;
  final NotificationPlatformLoader _platformLoader;
  final NotificationFetcher _fetchNotifications;
  final NotificationForegroundMessageHandler _foregroundMessageHandler;
  final NotificationSurfaceCleaner _clearDeliveredNotifications;
  final StaffNotificationSessionStore _sessionStore;
  final bool _supportsPush;
  final List<NotificationItem> _notifications = [];
  bool _initialized = false;
  bool _acceptsInitialization = true;
  bool _disposed = false;
  Future<void>? _initializationFuture;
  Future<bool>? _registrationFuture;
  Future<void>? _foregroundDeliveryFuture;
  StreamSubscription<String>? _tokenRefreshSubscription;
  StreamSubscription<RemoteMessage>? _foregroundMessageSubscription;
  int _sessionGeneration = 0;
  String? _fcmToken;
  String? _registeredPhone;
  String? _registeredToken;
  String? _registeredStaffUid;

  List<NotificationItem> get notifications => List.unmodifiable(_notifications);
  int get unreadCount => _notifications.where((n) => !n.isRead).length;
  String? get fcmToken => _fcmToken;

  /// Initialize FCM: request permission, get token, register device, listen
  Future<void> initialize() async {
    if (!_acceptsInitialization) return;
    if (_initialized) {
      await _registerCurrentDevice(_sessionGeneration);
      return;
    }

    final pendingInitialization = _initializationFuture;
    if (pendingInitialization != null) {
      await pendingInitialization;
      return;
    }

    final initialization = _initializeNotificationSession(_sessionGeneration);
    _initializationFuture = initialization;

    try {
      await initialization;
    } catch (e) {
      debugPrint('❌ FCM init error: $e');
    } finally {
      if (identical(_initializationFuture, initialization)) {
        _initializationFuture = null;
      }
    }
  }

  Future<void> beginAuthenticatedSession() {
    _acceptsInitialization = true;
    StaffLocalNotifications.instance.beginAuthenticatedSession();
    return initialize();
  }

  Future<void> _initializeNotificationSession(int generation) async {
    if (!await _markPresentationInactive()) return;
    if (generation != _sessionGeneration || !_acceptsInitialization) {
      return;
    }

    // FCM has no desktop implementation. On Windows/Linux/macOS the panel
    // is populated solely via the API-backed fetchNotifications() path.
    if (!_supportsPush) {
      _initialized = true;
      return;
    }

    await _initializeMessaging(generation);
  }

  Future<void> _initializeMessaging(int generation) async {
    final authorizationStatus = await _messaging.requestPermission();
    if (generation != _sessionGeneration) return;

    if (authorizationStatus == AuthorizationStatus.denied) {
      debugPrint('🔕 Notification permission denied');
      _initialized = true;
      return;
    }

    _fcmToken = await _messaging.getToken();
    if (generation != _sessionGeneration) return;
    final registered = await _registerCurrentDevice(generation);
    if (!registered || generation != _sessionGeneration) return;

    _tokenRefreshSubscription = _messaging.onTokenRefresh.listen((newToken) {
      unawaited(_handleTokenRefresh(newToken, generation));
    });

    _foregroundMessageSubscription = _messaging.onMessage.listen(
      (message) => _queueForegroundMessage(message, generation),
    );
    _initialized = true;
  }

  Future<void> _handleTokenRefresh(String newToken, int generation) async {
    if (generation != _sessionGeneration) return;
    if (!await _markPresentationInactive()) return;
    if (generation != _sessionGeneration) return;
    _fcmToken = newToken;
    await _registerCurrentDevice(generation);
  }

  void _queueForegroundMessage(RemoteMessage message, int generation) {
    final precedingDelivery = _foregroundDeliveryFuture;
    final delivery = (precedingDelivery ?? Future<void>.value()).then((
      _,
    ) async {
      if (generation != _sessionGeneration) return;
      if (!await _mayPresentNotifications(message)) return;
      await _foregroundMessageHandler(message);
      if (generation == _sessionGeneration &&
          await _mayPresentNotifications(message)) {
        _handleForegroundMessage(message);
      }
    });
    _foregroundDeliveryFuture = delivery;
    unawaited(
      delivery
          .catchError((Object error) {
            debugPrint('❌ Foreground notification delivery error: $error');
          })
          .whenComplete(() {
            if (identical(_foregroundDeliveryFuture, delivery)) {
              _foregroundDeliveryFuture = null;
            }
          }),
    );
  }

  Future<bool> _registerCurrentDevice([int? expectedGeneration]) {
    final precedingRegistration = _registrationFuture;
    final registration = (precedingRegistration ?? Future<bool>.value(true))
        .then((_) => _performDeviceRegistration(expectedGeneration));
    _registrationFuture = registration;
    return registration.whenComplete(() {
      if (identical(_registrationFuture, registration)) {
        _registrationFuture = null;
      }
    });
  }

  Future<bool> _performDeviceRegistration(int? expectedGeneration) async {
    final token = _fcmToken;
    if (token == null || token.isEmpty) {
      await _markPresentationInactive();
      return false;
    }
    if (!await _isAuthenticated()) {
      await _markPresentationInactive();
      return false;
    }

    final phone = await _phoneLoader();
    final staffUid = (await _staffUidLoader())?.trim();
    if (expectedGeneration != null &&
        expectedGeneration != _sessionGeneration) {
      return false;
    }
    if (staffUid == null || staffUid.isEmpty) {
      await _markPresentationInactive();
      return false;
    }
    if (_registeredPhone == phone &&
        _registeredToken == token &&
        _registeredStaffUid == staffUid &&
        await _sessionStore.isActiveFor(staffUid)) {
      return true;
    }

    try {
      if (!await _markPresentationInactive()) return false;
      final audience = await _registerDevice(
        phone: phone,
        fcmToken: token,
        platform: _platformLoader(),
      );
      if (expectedGeneration != null &&
          expectedGeneration != _sessionGeneration) {
        return false;
      }
      if (audience.recipientUid != staffUid) {
        throw StateError('Device registration returned another staff audience');
      }
      await _sessionStore.markActive(audience);
      _registeredPhone = phone;
      _registeredToken = token;
      _registeredStaffUid = staffUid;
      debugPrint('✅ Device registered for notifications');
      return true;
    } catch (e) {
      debugPrint('❌ Device registration error: $e');
      try {
        await _sessionStore.markInactive();
      } catch (_) {}
      return false;
    }
  }

  Future<bool> _markPresentationInactive() async {
    try {
      await _sessionStore.markInactive();
      return true;
    } catch (e) {
      debugPrint('❌ Notification session marker cleanup error: $e');
      return false;
    }
  }

  Future<bool> _mayPresentNotifications(RemoteMessage message) =>
      mayPresentStaffPush(
        message: message,
        sessionStore: _sessionStore,
        claimsLoader: _notificationClaimsLoader,
        authorityValidator: _notificationAuthorityValidator,
      );

  /// Ends the current authenticated notification session before account
  /// navigation. It drains an in-flight registration, cancels both Firebase
  /// listeners, removes the backend binding while the JWT is still present,
  /// rotates the FCM token, and clears cached notification PHI.
  Future<void> endAuthenticatedSession({bool unregisterBackend = true}) async {
    _acceptsInitialization = false;
    _sessionGeneration += 1;
    StaffLocalNotifications.instance.endAuthenticatedSession();
    final deliveredNotificationsCleanup = _clearDeliveredNotifications();
    final inactiveSessionWrite = _sessionStore.markInactive().then(
      (_) => true,
      onError: (Object error, StackTrace stack) {
        debugPrint('❌ Notification session marker cleanup error: $error');
        return false;
      },
    );

    var deliveredNotificationsCleared = false;
    try {
      await deliveredNotificationsCleanup;
      deliveredNotificationsCleared = true;
    } catch (e) {
      debugPrint('❌ Delivered notification cleanup error: $e');
    }
    var sessionMarkedInactive = await inactiveSessionWrite;
    final pendingInitialization = _initializationFuture;
    if (pendingInitialization != null) {
      try {
        await pendingInitialization;
      } catch (_) {}
    }

    final tokenRefreshSubscription = _tokenRefreshSubscription;
    final foregroundMessageSubscription = _foregroundMessageSubscription;
    _tokenRefreshSubscription = null;
    _foregroundMessageSubscription = null;
    var listenersCancelled = true;
    try {
      await tokenRefreshSubscription?.cancel();
    } catch (e) {
      listenersCancelled = false;
      debugPrint('❌ Token refresh listener cleanup error: $e');
    }
    try {
      await foregroundMessageSubscription?.cancel();
    } catch (e) {
      listenersCancelled = false;
      debugPrint('❌ Foreground notification listener cleanup error: $e');
    }
    final pendingRegistration = _registrationFuture;
    if (pendingRegistration != null) {
      try {
        await pendingRegistration;
      } catch (_) {}
    }

    final pendingForegroundDelivery = _foregroundDeliveryFuture;
    if (pendingForegroundDelivery != null) {
      try {
        await pendingForegroundDelivery;
      } catch (_) {}
    }

    // Cover an initialization that raced the first inactive write.
    try {
      await _sessionStore.markInactive();
      sessionMarkedInactive = true;
    } catch (e) {
      debugPrint('❌ Notification session marker cleanup error: $e');
    }

    var backendUnregistered = false;
    var tokenDeleted = !_supportsPush;
    if (unregisterBackend) {
      try {
        await _unregisterDevice();
        backendUnregistered = true;
      } catch (e) {
        debugPrint('❌ Device unregistration error: $e');
      }
    }
    if (_supportsPush) {
      try {
        await _messaging.deleteToken();
        tokenDeleted = true;
      } catch (e) {
        debugPrint('❌ FCM token rotation error: $e');
      }
    }

    _notifications.clear();
    _fcmToken = null;
    _registeredPhone = null;
    _registeredToken = null;
    _registeredStaffUid = null;
    _initialized = false;
    if (!_disposed) notifyListeners();

    final teardownVerified =
        sessionMarkedInactive &&
        listenersCancelled &&
        deliveredNotificationsCleared &&
        (!unregisterBackend || backendUnregistered) &&
        tokenDeleted;
    if (!teardownVerified) {
      throw StateError('Notification session teardown could not be verified.');
    }
  }

  static String _defaultPlatform() => currentAppDeviceMode == AppDeviceMode.web
      ? 'web'
      : Platform.isIOS
      ? 'ios'
      : 'android';

  void _handleForegroundMessage(RemoteMessage message) {
    final notification = message.notification;
    _notifications.insert(
      0,
      NotificationItem(
        id: message.data['id']?.toString(),
        title: notification?.title ?? message.data['title'] ?? 'Notification',
        body: notification?.body ?? message.data['body'] ?? '',
        timestamp: DateTime.now(),
        type: message.data['type']?.toString(),
        priority: message.data['priority']?.toString(),
        relatedId: message.data['related_id'],
        data: Map<String, dynamic>.from(message.data),
      ),
    );
    notifyListeners();
  }

  /// Fetch notifications from backend
  Future<void> fetchNotifications() async {
    final generation = _sessionGeneration;
    try {
      final data = await _fetchNotifications();
      if (generation != _sessionGeneration || !_acceptsInitialization) return;

      _notifications.clear();
      for (final item in data) {
        _notifications.add(NotificationItem.fromApi(item));
      }
      notifyListeners();
    } catch (e) {
      debugPrint('❌ Error fetching notifications: $e');
    }
  }

  /// Mark a single notification as read.
  Future<void> markRead(NotificationItem item) async {
    final id = item.id;
    item.isRead = true;
    notifyListeners();

    if (id == null || id.isEmpty) return;

    try {
      await HrApiService.markNotificationRead(id);
    } catch (e) {
      debugPrint('❌ Error marking notification as read: $e');
    }
  }

  /// Explicitly acknowledge a workflow alert. This also marks it read locally.
  Future<void> acknowledge(NotificationItem item) async {
    final id = item.id;
    item.isRead = true;
    notifyListeners();

    if (id == null || id.isEmpty) return;

    try {
      await HrApiService.acknowledgeNotification(id);
    } catch (e) {
      debugPrint('❌ Error acknowledging notification: $e');
    }
  }

  /// Mark all notifications as read
  Future<void> markAllRead() async {
    for (final n in _notifications) {
      n.isRead = true;
    }
    notifyListeners();

    try {
      await HrApiService.markAllNotificationsRead();
    } catch (e) {
      debugPrint('❌ Error marking notifications as read: $e');
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _acceptsInitialization = false;
    _sessionGeneration += 1;
    unawaited(_tokenRefreshSubscription?.cancel());
    unawaited(_foregroundMessageSubscription?.cancel());
    super.dispose();
  }
}

bool _hasAny(String source, List<String> needles) {
  return needles.any((needle) => source.contains(needle));
}

Map<String, dynamic> _parseDataMap(dynamic raw) {
  if (raw is Map) return Map<String, dynamic>.from(raw);
  if (raw is String && raw.trim().isNotEmpty) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
    } catch (_) {
      return <String, dynamic>{};
    }
  }
  return <String, dynamic>{};
}

bool _isSosResponderType(String type) {
  final t = type.toUpperCase();
  return (t.contains('SOS') || t.contains('EMERGENCY')) &&
      !t.contains('BROADCAST');
}

String? _defaultRouteForType(String type) {
  final t = type.toUpperCase();
  // EMERGENCY/SOS previously fell through to null: the push was flagged
  // high-priority but had NO action route (HIGH-1). The alert-id deep-link
  // variant is handled in NotificationItem.actionRoute, which has the data.
  if (_isSosResponderType(t)) return '/sos-response';
  if (t.contains('APPOINTMENT') || t == 'BOOKING') return '/appointments';
  if (t.contains('ADMISSION')) return '/emr/admissions';
  if (t.contains('HOUSEKEEPING')) return '/housekeeping-tasks';
  if (t.contains('BED') || t.contains('CLEANING')) return '/beds';
  if (t.contains('HANDOVER')) return '/handover';
  if (t == 'GATEWAY_REFUND_RECONCILIATION') {
    return '/billing/gateway-refund-reconciliation';
  }
  if (t.contains('REFERRAL')) return '/referrals';
  if (t.contains('LAB') ||
      t.contains('INVESTIGATION') ||
      t.contains('CRITICAL_VALUE')) {
    return '/investigations';
  }
  if (t.contains('PHARMACY') || t.contains('MEDICATION')) return '/pharmacy';
  if (t.contains('ATTENDANCE')) return '/attendance';
  if (t.contains('LEAVE')) return '/leave';
  return null;
}
