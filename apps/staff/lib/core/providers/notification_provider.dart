import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import '../config/api_config.dart';
import '../platform_info.dart';
import '../services/hr_api_service.dart';

class NotificationItem {
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

  String? get actionRoute {
    final explicit = data['route']?.toString().trim();
    if (explicit != null && explicit.isNotEmpty) {
      return _normalizeStaffRoute(explicit);
    }
    return _defaultRouteForType(normalizedType);
  }
}

class NotificationProvider extends ChangeNotifier {
  final List<NotificationItem> _notifications = [];
  bool _initialized = false;
  String? _fcmToken;

  List<NotificationItem> get notifications => List.unmodifiable(_notifications);
  int get unreadCount => _notifications.where((n) => !n.isRead).length;
  String? get fcmToken => _fcmToken;

  /// Initialize FCM: request permission, get token, register device, listen
  Future<void> initialize() async {
    if (_initialized) return;
    _initialized = true;

    // FCM has no desktop implementation. On Windows/Linux/macOS the panel
    // is populated solely via the API-backed fetchNotifications() path —
    // skip the FCM setup entirely rather than relying on the catch below.
    if (isDesktopPlatform) return;

    try {
      final messaging = FirebaseMessaging.instance;

      // Request permission
      final settings = await messaging.requestPermission(
        alert: true,
        badge: true,
        sound: true,
      );

      if (settings.authorizationStatus == AuthorizationStatus.denied) {
        debugPrint('🔕 Notification permission denied');
        return;
      }

      // Get FCM token
      _fcmToken = await messaging.getToken();
      debugPrint('🔔 FCM token: ${_fcmToken?.substring(0, 20)}...');

      // Register device with backend
      if (_fcmToken != null) {
        await _registerDevice(_fcmToken!);
      }

      // Listen for token refresh
      messaging.onTokenRefresh.listen((newToken) async {
        _fcmToken = newToken;
        await _registerDevice(newToken);
      });

      // Listen for foreground messages
      FirebaseMessaging.onMessage.listen(_handleForegroundMessage);
    } catch (e) {
      debugPrint('❌ FCM init error: $e');
    }
  }

  Future<void> _registerDevice(String token) async {
    try {
      final phone = await ApiConfig.getPhone();
      if (phone == null || phone.isEmpty) {
        debugPrint('⚠️ No phone saved — skipping device registration');
        return;
      }

      final platform = Platform.isIOS ? 'ios' : 'android';
      await HrApiService.registerDevice(
        phone: phone,
        fcmToken: token,
        platform: platform,
      );
      debugPrint('✅ Device registered for notifications');
    } catch (e) {
      debugPrint('❌ Device registration error: $e');
    }
  }

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
    try {
      final data = await HrApiService.getNotifications();

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

String? _defaultRouteForType(String type) {
  final t = type.toUpperCase();
  if (t.contains('APPOINTMENT') || t == 'BOOKING') return '/appointments';
  if (t.contains('ADMISSION')) return '/emr/admissions';
  if (t.contains('BED') || t.contains('CLEANING')) return '/beds';
  if (t.contains('HOUSEKEEPING')) return '/housekeeping-tasks';
  if (t.contains('HANDOVER')) return '/handover';
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

String _normalizeStaffRoute(String route) {
  if (route == '/admissions') return '/emr/admissions';
  if (route.startsWith('/admissions?')) {
    return route.replaceFirst('/admissions', '/emr/admissions');
  }
  if (route == '/housekeeping') return '/housekeeping-tasks';
  return route;
}
