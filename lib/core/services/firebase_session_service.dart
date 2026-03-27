import 'package:flutter/foundation.dart';
import 'package:vhhealth/core/services/api_client.dart';

/// Firebase session management API calls.
class FirebaseSessionService {
  FirebaseSessionService._();

  /// Update FCM token on the backend (auth/firebase route).
  static Future<bool> updateFcmToken(String fcmToken) async {
    try {
      final response = await ApiClient.post(
        '/auth/firebase/update-fcm-token',
        body: {'fcmToken': fcmToken},
      );
      return response.isSuccess;
    } catch (e) {
      debugPrint('FirebaseSessionService.updateFcmToken error: $e');
      return false;
    }
  }

  /// Revoke the current Firebase session on the backend (call on logout).
  static Future<bool> revokeSession() async {
    try {
      final response = await ApiClient.post(
        '/auth/firebase/revoke-session',
      );
      return response.isSuccess;
    } catch (e) {
      debugPrint('FirebaseSessionService.revokeSession error: $e');
      return false;
    }
  }
}
