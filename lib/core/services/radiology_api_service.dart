import 'package:vhhealth_core/models/api_response.dart';
import 'api_client.dart';

/// Radiology API calls: worklist, orders, reports.
class RadiologyApiService {
  RadiologyApiService._();

  // --- Helpers ---------------------------------------------------------------

  static Future<Map<String, dynamic>> _get(String path,
      {Map<String, String>? query}) async {
    final resp = await ApiClient.get(path, queryParameters: query);
    return _handle(resp);
  }

  static Future<Map<String, dynamic>> _post(
      String path, Map<String, dynamic> body) async {
    final resp = await ApiClient.post(path, body: body);
    return _handle(resp);
  }

  static Future<Map<String, dynamic>> _put(
      String path, Map<String, dynamic> body) async {
    final resp = await ApiClient.put(path, body: body);
    return _handle(resp);
  }

  static Map<String, dynamic> _handle(ApiResponse resp) {
    if (resp.isSuccess && resp.raw is Map) {
      final raw = resp.raw as Map<String, dynamic>;
      if (raw['success'] == true) {
        return (raw['data'] as Map<String, dynamic>?) ?? raw;
      }
    }
    throw Exception(resp.message ?? 'Request failed (${resp.statusCode})');
  }

  // --- Radiology Endpoints ---------------------------------------------------

  /// GET /radiology/worklist?status=&modality=&priority=&page=&limit=
  static Future<Map<String, dynamic>> getWorklist({
    String? status,
    String? modality,
    String? priority,
    int page = 1,
  }) async {
    final query = <String, String>{
      'page': page.toString(),
      'limit': '20',
    };
    if (status != null) query['status'] = status;
    if (modality != null) query['modality'] = modality;
    if (priority != null) query['priority'] = priority;
    return _get('/radiology/worklist', query: query);
  }

  /// GET /radiology/patient/:uid?page=&limit=
  static Future<Map<String, dynamic>> getPatientHistory(String uid,
      {int page = 1}) async {
    return _get('/radiology/patient/$uid', query: {
      'page': page.toString(),
      'limit': '20',
    });
  }

  /// GET /radiology/:id
  static Future<Map<String, dynamic>> getOrderDetail(int id) async {
    return _get('/radiology/$id');
  }

  /// POST /radiology/orders
  static Future<Map<String, dynamic>> createOrder(
      Map<String, dynamic> data) async {
    return _post('/radiology/orders', data);
  }

  /// PUT /radiology/:id/report
  static Future<Map<String, dynamic>> submitReport(
      int id, Map<String, dynamic> reportData) async {
    return _put('/radiology/$id/report', reportData);
  }

  /// PUT /radiology/:id/cancel
  static Future<Map<String, dynamic>> cancelOrder(int id) async {
    return _put('/radiology/$id/cancel', {});
  }
}
