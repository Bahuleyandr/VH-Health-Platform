import '../../../core/services/api_client.dart';

class StaffPhoneApiService {
  StaffPhoneApiService._();

  static Future<Map<String, dynamic>> getHome() async {
    final response = await ApiClient.get('/staff/phone/home');
    if (!response.isSuccess) {
      throw Exception(response.message ?? 'Could not load phone home');
    }
    return response.dataAsMap();
  }

  static Future<List<Map<String, dynamic>>> getMyQueries({
    int limit = 30,
  }) async {
    final response = await ApiClient.get(
      '/staff/queries/my',
      queryParameters: {'limit': '$limit'},
    );
    if (!response.isSuccess) {
      throw Exception(response.message ?? 'Could not load queries');
    }
    final data = response.dataAsMap();
    final queries = data['queries'];
    if (queries is List) {
      return queries
          .whereType<Map>()
          .map((row) => Map<String, dynamic>.from(row))
          .toList();
    }
    return const [];
  }

  static Future<Map<String, dynamic>> submitQuery({
    required String category,
    required String subject,
    required String body,
    required String priority,
  }) async {
    final response = await ApiClient.post(
      '/staff/queries',
      body: {
        'category': category,
        'subject': subject,
        'body': body,
        'priority': priority,
      },
    );
    if (!response.isSuccess) {
      throw Exception(response.message ?? 'Could not submit query');
    }
    return response.dataAsMap();
  }
}
