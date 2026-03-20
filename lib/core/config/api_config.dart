/// Centralized API configuration.
///
/// All backend URLs and keys should reference this class
/// instead of hardcoding values in individual screens.
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class ApiConfig {
  ApiConfig._();

  /// Backend base URL (no trailing slash).
  static const String baseUrl = 'https://api.vhhealth.app/api/v1';

  /// API key sent with every request.
  static const String apiKey = 'vhhealth123';

  static const _storage = FlutterSecureStorage();

  /// Standard headers for JSON requests (no JWT — for public endpoints).
  static Map<String, String> get jsonHeaders => {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      };

  /// Headers for non-JSON requests (e.g. multipart) without JWT.
  static Map<String, String> get authHeaders => {
        'x-api-key': apiKey,
      };

  /// Get headers with JWT for authenticated JSON requests.
  static Future<Map<String, String>> authenticatedHeaders() async {
    final jwt = await _storage.read(key: 'jwt');
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      if (jwt != null) 'Authorization': 'Bearer $jwt',
    };
  }

  /// Get auth-only headers (no Content-Type) with JWT — for multipart etc.
  static Future<Map<String, String>> authenticatedAuthHeaders() async {
    final jwt = await _storage.read(key: 'jwt');
    return {
      'x-api-key': apiKey,
      if (jwt != null) 'Authorization': 'Bearer $jwt',
    };
  }
}
