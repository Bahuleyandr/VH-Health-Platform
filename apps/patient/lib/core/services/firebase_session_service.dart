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
  ///
  /// [timeout] / [retryTransientFailures] let the logout teardown run this
  /// as one short attempt instead of the default 15s x 3-retry policy.
  /// [refreshOnUnauthorized] must be false for logout so an abandoned 401
  /// cannot refresh credentials after the local wipe.
  ///
  /// Returns true on 401 as well as on 2xx. This method answers "is the session
  /// revoked", not "did the server accept this request", and a 401 means the
  /// credential is already dead — the exact end state the caller wanted. The
  /// distinction is load-bearing: `LogoutService` durably queues a retry
  /// (which means writing the departing JWT back to secure storage for up to
  /// seven days) whenever a revocation is reported unconfirmed, and a 401 is
  /// the EXPECTED response on the session-revoked and account-deletion logout
  /// paths.
  static Future<bool> revokeSession({
    Duration? timeout,
    bool retryTransientFailures = true,
    bool refreshOnUnauthorized = true,
  }) async {
    try {
      final response = await ApiClient.post(
        '/auth/firebase/revoke-my-session',
        timeout: timeout,
        retryTransientFailures: retryTransientFailures,
        refreshOnUnauthorized: refreshOnUnauthorized,
      );
      final revoked = response.isSuccess || response.isUnauthorized;
      if (!revoked) {
        // A non-2xx never throws (ApiResponse.parse just sets isSuccess), so
        // without this the whole revocation could fail with no trace at all.
        debugPrint(
          'FirebaseSessionService.revokeSession failed: '
          'HTTP ${response.statusCode} ${response.code ?? ''}',
        );
      }
      return revoked;
    } catch (e) {
      debugPrint('FirebaseSessionService.revokeSession error: $e');
      return false;
    }
  }
}
