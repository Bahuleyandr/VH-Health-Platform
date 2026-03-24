import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:vhhealth/core/config/api_config.dart';

/// Firebase session management API calls.
class FirebaseSessionService {
  FirebaseSessionService._();

  /// Update FCM token on the backend (auth/firebase route).
  static Future<bool> updateFcmToken(String fcmToken) async {
    try {
      final headers = await ApiConfig.authenticatedHeaders();
      final response = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/auth/firebase/update-fcm-token'),
        headers: headers,
        body: jsonEncode({'fcmToken': fcmToken}),
      );
      return response.statusCode == 200;
    } catch (e) {
      debugPrint('FirebaseSessionService.updateFcmToken error: $e');
      return false;
    }
  }

  /// Revoke the current Firebase session on the backend (call on logout).
  static Future<bool> revokeSession() async {
    try {
      final headers = await ApiConfig.authenticatedHeaders();
      final response = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/auth/firebase/revoke-session'),
        headers: headers,
      );
      return response.statusCode == 200;
    } catch (e) {
      debugPrint('FirebaseSessionService.revokeSession error: $e');
      return false;
    }
  }
}
