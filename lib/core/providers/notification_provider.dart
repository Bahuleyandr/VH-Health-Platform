// lib/core/providers/notification_provider.dart

import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:firebase_auth/firebase_auth.dart';

class NotificationProvider extends ChangeNotifier {
  int _unreadCount = 0;
  int get unreadCount => _unreadCount;

  final String _baseUrl = 'https://vh-health-backend.onrender.com/api/v1';
  final Map<String, String> _headers = {
    'x-api-key': 'vhhealth123',
  };

  /// Fetch unread notifications for the given phone number
  Future<void> fetchUnreadCount(String phone) async {
    // Skip for guest users
    if (phone == 'guest' || phone.isEmpty) {
      _unreadCount = 0;
      notifyListeners();
      return;
    }

    final uri = Uri.parse('$_baseUrl/notifications/$phone');

    try {
      final token = await FirebaseAuth.instance.currentUser?.getIdToken();
      final response = await http.get(
        uri,
        headers: {
          ..._headers,
          if (token != null) 'Authorization': 'Bearer $token',
        },
      ).timeout(
        const Duration(seconds: 10),
        onTimeout: () {
          debugPrint('⏱️ Request timeout');
          return http.Response('Timeout', 408);
        },
      );

      if (response.statusCode == 200) {
        final List<dynamic> data = jsonDecode(response.body.trim());
        _unreadCount = data.where((n) => n['is_read'] == false).length;
        notifyListeners();
      } else if (response.statusCode == 408) {
        debugPrint('⏱️ Request timed out');
        _unreadCount = 0;
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

  /// Mark all notifications as read for the given phone number
  Future<void> markAllRead(String phone) async {
    if (phone == 'guest' || phone.isEmpty) return;

    final uri = Uri.parse('$_baseUrl/notifications/$phone/mark-all-read');

    try {
      final token = await FirebaseAuth.instance.currentUser?.getIdToken();
      final response = await http.patch(
        uri,
        headers: {
          ..._headers,
          if (token != null) 'Authorization': 'Bearer $token',
        },
      ).timeout(
        const Duration(seconds: 10),
        onTimeout: () => http.Response('Timeout', 408),
      );

      if (response.statusCode == 200) {
        _unreadCount = 0;
        notifyListeners();
      } else {
        debugPrint('❌ Failed to mark notifications as read: ${response.statusCode}');
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