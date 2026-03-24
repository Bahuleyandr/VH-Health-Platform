import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:vhhealth/core/config/api_config.dart';

/// Backend API calls for feedback features.
class FeedbackApiService {
  FeedbackApiService._();

  /// Fetch user's feedback history.
  static Future<Map<String, dynamic>?> getMyFeedback() async {
    try {
      final headers = await ApiConfig.authenticatedHeaders();
      final response = await http.get(
        Uri.parse('${ApiConfig.baseUrl}/feedback/my-feedback'),
        headers: headers,
      );
      if (response.statusCode == 200) {
        return jsonDecode(response.body) as Map<String, dynamic>;
      }
    } catch (_) {}
    return null;
  }

  /// Fetch user's feedback statistics.
  static Future<Map<String, dynamic>?> getMyStats() async {
    try {
      final headers = await ApiConfig.authenticatedHeaders();
      final response = await http.get(
        Uri.parse('${ApiConfig.baseUrl}/feedback/my-stats'),
        headers: headers,
      );
      if (response.statusCode == 200) {
        return jsonDecode(response.body) as Map<String, dynamic>;
      }
    } catch (_) {}
    return null;
  }

  /// Submit a quick star rating (1-5) without a comment.
  static Future<bool> quickRating({
    required String phone,
    required int rating,
    String? appointmentId,
  }) async {
    try {
      final headers = await ApiConfig.authenticatedHeaders();
      final body = <String, dynamic>{
        'phone': phone,
        'rating': rating,
        if (appointmentId != null) 'appointment_id': appointmentId,
      };
      final response = await http.post(
        Uri.parse('${ApiConfig.baseUrl}/feedback/quick-rating'),
        headers: headers,
        body: jsonEncode(body),
      );
      return response.statusCode == 200 || response.statusCode == 201;
    } catch (_) {
      return false;
    }
  }
}
