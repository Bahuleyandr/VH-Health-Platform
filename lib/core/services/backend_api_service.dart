// lib/core/services/backend_api_service.dart
import 'dart:convert';
import 'package:http/http.dart' as http;

/// A singleton-like API service class for backend communication.
class BackendApiService {
  static const String _baseUrl = 'https://vh-health-backend.onrender.com/api/v1';
  static const String _apiKey = 'vhhealth123';

  /// 🔐 Firebase OTP token login (called after OTP is verified)
  static Future<http.Response> firebaseLogin(String token) async {
    final response = await http.post(
      Uri.parse('$_baseUrl/auth/firebase-login'),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': _apiKey,
      },
      body: jsonEncode({'idToken': token}), // ✅ Fixed: Changed from firebaseIdToken to idToken
    );
    return response;
  }

  /// 📝 Save or update user profile after initial login or onboarding
  static Future<bool> saveUserProfile(Map<String, dynamic> profile) async {
    final response = await http.post(
      Uri.parse('$_baseUrl/users'),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': _apiKey,
      },
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