import 'api_client.dart';

class TransplantApiService {
  TransplantApiService._();

  static Future<Map<String, dynamic>> getDashboard({int limit = 100}) async {
    final resp = await ApiClient.get(
      '/transplant/dashboard',
      queryParameters: {'limit': '$limit'},
    );
    if (resp.isSuccess && resp.data is Map) {
      return Map<String, dynamic>.from(resp.data as Map);
    }
    throw Exception(resp.failureMessage('Transplant dashboard request failed'));
  }
}
