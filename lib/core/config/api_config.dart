/// Centralized API configuration.
///
/// All backend URLs and keys should reference this class
/// instead of hardcoding values in individual screens.
class ApiConfig {
  ApiConfig._();

  /// Backend base URL (no trailing slash).
  static const String baseUrl = 'https://api.vhhealth.app/api/v1';

  /// API key sent with every request.
  static const String apiKey = 'vhhealth123';

  /// Standard headers for JSON requests.
  static Map<String, String> get jsonHeaders => {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      };

  /// Headers for non-JSON requests (e.g. multipart).
  static Map<String, String> get authHeaders => {
        'x-api-key': apiKey,
      };
}
