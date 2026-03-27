import 'package:vhhealth/core/services/api_client.dart';

/// Backend API calls for feedback features.
class FeedbackApiService {
  FeedbackApiService._();

  /// Fetch user's feedback history.
  static Future<Map<String, dynamic>?> getMyFeedback() async {
    try {
      final response = await ApiClient.get('/feedback/my-feedback');
      if (response.isSuccess) {
        return response.raw as Map<String, dynamic>;
      }
    } catch (_) {}
    return null;
  }

  /// Fetch user's feedback statistics.
  static Future<Map<String, dynamic>?> getMyStats() async {
    try {
      final response = await ApiClient.get('/feedback/my-stats');
      if (response.isSuccess) {
        return response.raw as Map<String, dynamic>;
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
      final response = await ApiClient.post(
        '/feedback/quick-rating',
        body: {
          'phone': phone,
          'rating': rating,
          if (appointmentId != null) 'appointment_id': appointmentId,
        },
      );
      return response.isSuccess;
    } catch (_) {
      return false;
    }
  }
}
