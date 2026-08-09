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

  /// Revoke the signed-in user's own Firebase session on the backend (call on
  /// logout), so a leaked Firebase refresh token cannot mint fresh ID tokens —
  /// and therefore cannot be traded for a new VH JWT — after sign-out.
  ///
  /// Deliberately sends no body: the backend derives the Firebase UID from the
  /// JWT. The sibling `/auth/firebase/revoke-session` takes a UID in the body
  /// and is ADMIN-only force-logout — calling it from here 403s.
  static Future<bool> revokeSession() async {
    try {
      final response = await ApiClient.post('/auth/firebase/revoke-my-session');
      if (!response.isSuccess) {
        // A non-2xx never throws (ApiResponse.parse just sets isSuccess), so
        // without this the whole revocation could fail with no trace at all.
        debugPrint(
          'FirebaseSessionService.revokeSession failed: '
          'HTTP ${response.statusCode} ${response.code ?? ''}',
        );
      }
      return response.isSuccess;
    } catch (e) {
      debugPrint('FirebaseSessionService.revokeSession error: $e');
      return false;
    }
  }
}
