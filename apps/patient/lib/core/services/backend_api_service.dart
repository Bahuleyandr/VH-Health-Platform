// lib/core/services/backend_api_service.dart
import 'package:vhhealth_core/services/http_client.dart';

import 'api_client.dart';

/// A singleton-like API service class for backend communication.
class BackendApiService {
  /// 🔐 Firebase OTP token login (called after OTP is verified).
  ///
  /// Sends `deviceType: 'mobile'` so the backend stamps it into the JWT
  /// claim. Drives the per-user single-active-session policy (see backend
  /// userActiveSession.js / loginSessionHelper.js).
  static Future<ApiResponse> firebaseLogin(String token) => VHHttpClient.post(
    '/auth/firebase/firebase-login',
    auth: false,
    body: {'idToken': token, 'deviceType': 'mobile'},
    timeout: const Duration(seconds: 15),
  );

  /// 📝 Save user profile after initial registration (post-OTP onboarding)
  static Future<bool> saveUserProfile(Map<String, dynamic> profile) async {
    final response = await ApiClient.post(
      '/auth/firebase/complete-profile',
      body: profile,
      timeout: const Duration(seconds: 15),
    );
    return response.isSuccess;
  }
}
