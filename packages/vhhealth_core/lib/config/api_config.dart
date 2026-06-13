// Centralized API configuration for VHHealth apps.
// All backend URLs and keys should reference this class
// instead of hardcoding values in individual screens.
//
// Security: API Key Injection
// The API key is injected at build time via `--dart-define`:
//   flutter run --dart-define=VH_API_KEY=your-secret-key
//   flutter build apk --dart-define=VH_API_KEY=your-secret-key
// This prevents the key from being committed to source control.
import '../services/secure_storage.dart';

class ApiConfig {
  ApiConfig._();

  /// Backend base URL (no trailing slash).
  /// Override at build time: `--dart-define=VH_BASE_URL=https://...`
  static const String baseUrl = String.fromEnvironment(
    'VH_BASE_URL',
    defaultValue: 'https://api.vhhealth.app/api/v1',
  );

  /// API key sent with every request.
  /// Injected via `--dart-define=VH_API_KEY=xxx` at build time.
  /// **Never hardcode this value in source code.**
  static const String apiKey = String.fromEnvironment('VH_API_KEY');

  // Route through the centralized encrypted-storage singleton.
  static final _storage = VHSecureStorage.instance;

  /// Standard headers for JSON requests (no JWT — for public endpoints).
  static Map<String, String> get jsonHeaders => {
    'Content-Type': 'application/json',
    if (apiKey.isNotEmpty) 'x-api-key': apiKey,
  };

  /// Headers for non-JSON requests (e.g. multipart) without JWT.
  static Map<String, String> get authHeaders => {
    if (apiKey.isNotEmpty) 'x-api-key': apiKey,
  };

  /// Get headers with JWT for authenticated JSON requests.
  static Future<Map<String, String>> authenticatedHeaders() async {
    final jwt = await _storage.read(key: 'jwt');
    return {
      'Content-Type': 'application/json',
      if (apiKey.isNotEmpty) 'x-api-key': apiKey,
      if (jwt != null) 'Authorization': 'Bearer $jwt',
    };
  }

  /// Get auth-only headers (no Content-Type) with JWT — for multipart etc.
  static Future<Map<String, String>> authenticatedAuthHeaders() async {
    final jwt = await _storage.read(key: 'jwt');
    return {
      if (apiKey.isNotEmpty) 'x-api-key': apiKey,
      if (jwt != null) 'Authorization': 'Bearer $jwt',
    };
  }
}
