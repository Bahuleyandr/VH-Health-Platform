// lib/core/services/backend_api_service.dart
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:vhhealth/core/config/api_config.dart';

/// A singleton-like API service class for backend communication.
class BackendApiService {
  /// 🔐 Firebase OTP token login (called after OTP is verified)
  static Future<http.Response> firebaseLogin(String token) async {
    final response = await http.post(
      Uri.parse('${ApiConfig.baseUrl}/auth/firebase-login'),
      headers: ApiConfig.jsonHeaders,
      body: jsonEncode({'idToken': token}),
    );
    return response;
  }

  /// 📝 Save or update user profile after initial login or onboarding
  static Future<bool> saveUserProfile(Map<String, dynamic> profile) async {
    final response = await http.post(
      Uri.parse('${ApiConfig.baseUrl}/users'),
      headers: ApiConfig.jsonHeaders,
      body: jsonEncode(profile),
    );
    return response.statusCode == 200;
  }

  /// 📤 Utility to parse response JSON safely
  static Map<String, dynamic>? parseJson(http.Response response) {
    try {
      return jsonDecode(response.body) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }
}
