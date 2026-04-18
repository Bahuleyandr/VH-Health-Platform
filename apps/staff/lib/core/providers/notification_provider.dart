import 'dart:io';
import 'package:flutter/material.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import '../config/api_config.dart';
import '../services/hr_api_service.dart';

class NotificationItem {
  final String title;
  final String body;
  final DateTime timestamp;
  final String? type;
  bool isRead;

  NotificationItem({
    required this.title,
    required this.body,
    required this.timestamp,
    this.type,
    this.isRead = false,
  });
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
        title: notification?.title ?? message.data['title'] ?? 'Notification',
        body: notification?.body ?? message.data['body'] ?? '',
        timestamp: DateTime.now(),
        type: message.data['type']?.toString(),
      ),
    );
    notifyListeners();
  }

  /// Fetch notifications from backend
  Future<void> fetchNotifications() async {
    try {
      final phone = await ApiConfig.getPhone();
      if (phone == null || phone.isEmpty) return;

      final data = await HrApiService.getNotifications(phone);

      _notifications.clear();
      for (final item in data) {
        _notifications.add(NotificationItem(
          title: item['title'] ?? 'Notification',
          body: item['message'] ?? item['body'] ?? '',
          timestamp: DateTime.tryParse(item['created_at'] ?? '') ?? DateTime.now(),
          type: item['type']?.toString(),
          isRead: item['is_read'] == true,
        ));
      }
      notifyListeners();
    } catch (e) {
      debugPrint('❌ Error fetching notifications: $e');
    }
  }

  /// Mark all notifications as read
  Future<void> markAllRead() async {
    for (final n in _notifications) {
      n.isRead = true;
    }
    notifyListeners();

    try {
      final phone = await ApiConfig.getPhone();
      if (phone != null && phone.isNotEmpty) {
        await HrApiService.markAllNotificationsRead(phone);
      }
    } catch (e) {
      debugPrint('❌ Error marking notifications as read: $e');
    }
  }
}
