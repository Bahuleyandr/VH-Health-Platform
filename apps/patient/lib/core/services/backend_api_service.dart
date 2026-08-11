// lib/core/services/backend_api_service.dart
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:vhhealth/core/config/api_config.dart';

import 'api_client.dart';

/// A singleton-like API service class for backend communication.
class BackendApiService {
  /// 🔐 Firebase OTP token login (called after OTP is verified).
  ///
  /// Sends `deviceType: 'mobile'` so the backend stamps it into the JWT
  /// claim. Drives the per-user single-active-session policy (see backend
  /// userActiveSession.js / loginSessionHelper.js).
  static Future<http.Response> firebaseLogin(String token) async {
    final response = await http
        .post(
          Uri.parse('${ApiConfig.baseUrl}/auth/firebase/firebase-login'),
          headers: ApiConfig.jsonHeaders,
          body: jsonEncode({'idToken': token, 'deviceType': 'mobile'}),
        )
        .timeout(const Duration(seconds: 15));
    return response;
  }

  /// 📝 Save user profile after initial registration (post-OTP onboarding)
  static Future<bool> saveUserProfile(Map<String, dynamic> profile) async {
    final response = await ApiClient.post(
      '/auth/firebase/complete-profile',
      body: profile,
      timeout: const Duration(seconds: 15),
    );
    return response.isSuccess;
  }

  /// 📤 Utility to parse response JSON safely
  static Map<String, dynamic>? parseJson(http.Response response) {
    try {
      return jsonDecode(response.body) as Map<String, dynamic>;
    } catch (e) {
      debugPrint('BackendApiService.parseJson failed: $e');
      return null;
    }
  }
}
