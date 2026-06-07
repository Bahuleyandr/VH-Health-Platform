// lib/core/providers/notification_provider.dart

import 'package:flutter/material.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/providers/websocket_provider.dart';

class NotificationProvider extends ChangeNotifier {
  int _unreadCount = 0;
  int get unreadCount => _unreadCount;

  /// Merge any pending WS-delivered notifications into the unread count.
  void mergeFromWebSocket(WebSocketProvider wsProv) {
    final pending = wsProv.wsNotifications;
    if (pending.isEmpty) return;
    _unreadCount += pending.length;
    wsProv.clearNotifications();
    notifyListeners();
  }

  /// Fetch unread notifications for the authenticated user.
  ///
  /// The [phone] parameter is kept for API compatibility but is no longer
  /// sent to the backend — the `/my` endpoint derives the user from the JWT.
  Future<void> fetchUnreadCount(String phone) async {
    if (phone.isEmpty || phone == 'guest') {
      _unreadCount = 0;
      notifyListeners();
      return;
    }

    try {
      final response = await ApiClient.get(
        '/notifications/my',
        timeout: const Duration(seconds: 10),
      );

      if (response.isSuccess) {
        final data = response.data;
        final List<dynamic> notifications;
        if (data is List) {
          notifications = data;
        } else if (data is Map) {
          notifications = (data['notifications'] as List?) ?? [];
        } else {
          notifications = [];
        }
        _unreadCount = notifications.where((n) => n['is_read'] == false).length;
        notifyListeners();
      } else {
        debugPrint('❌ Failed to fetch notifications: ${response.statusCode}');
      }
    } catch (e) {
      debugPrint('❌ Error fetching unread notifications: $e');
      _unreadCount = 0;
      notifyListeners();
    }
  }

  /// Mark all notifications as read for the authenticated user.
  Future<void> markAllRead(String phone) async {
    if (phone.isEmpty || phone == 'guest') return;

    try {
      final response = await ApiClient.patch(
        '/notifications/my/mark-all-read',
        timeout: const Duration(seconds: 10),
      );

      if (response.isSuccess) {
        _unreadCount = 0;
        notifyListeners();
      } else {
        debugPrint(
          '❌ Failed to mark notifications as read: ${response.statusCode}',
        );
      }
    } catch (e) {
      debugPrint('❌ Error marking notifications as read: $e');
    }
  }

  /// Convenience alias for `markAllRead`
  void markAllAsRead(String phone) {
    markAllRead(phone);
  }
}
