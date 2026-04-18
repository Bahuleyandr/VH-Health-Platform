import 'api_client.dart';

/// Pharmacy order management API calls.
class PharmacyApiService {
  PharmacyApiService._();

  // ─── Helpers ──────────────────────────────────────────────────────────────

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

  static Map<String, dynamic> _handle(ApiResponse resp) {
    if (resp.isSuccess && resp.raw is Map) {
      final raw = resp.raw as Map<String, dynamic>;
      if (raw['success'] == true) {
        return (raw['data'] as Map<String, dynamic>?) ?? raw;
      }
    }
    throw Exception(resp.message ?? 'Request failed (${resp.statusCode})');
  }

  // ─── Pharmacy Orders ──────────────────────────────────────────────────────

  /// PUT /staff/pharmacy/orders (legacy)
  static Future<Map<String, dynamic>> updatePharmacyOrder({
    required String phone,
    required String orderId,
    required String status,
    String? notes,
  }) async {
    return _post('/staff/pharmacy/orders', {
      'phone': phone,
      'orderId': orderId,
      'status': status,
      'notes': ?notes,
    });
  }

  /// GET /pharmacy-orders/orders/queue — pharmacy order queue
  static Future<List<dynamic>> getPharmacyOrderQueue({String? status}) async {
    final resp = await _get('/pharmacy-orders/orders/queue', query: {
      'status': ?status,
    });
    final data = resp['data'];
    if (data is List) return data;
    return [];
  }

  /// POST /pharmacy-orders/orders/:id/confirm
  static Future<Map<String, dynamic>> confirmPharmacyOrder(
      int id, Map<String, dynamic> data) async {
    return _post('/pharmacy-orders/orders/$id/confirm', data);
  }

  /// POST /pharmacy-orders/orders/:id/preparing
  static Future<Map<String, dynamic>> markPharmacyPreparing(int id) async {
    return _post('/pharmacy-orders/orders/$id/preparing', {});
  }

  /// POST /pharmacy-orders/orders/:id/dispatch
  static Future<Map<String, dynamic>> dispatchPharmacyOrder(
      int id, Map<String, dynamic> data) async {
    return _post('/pharmacy-orders/orders/$id/dispatch', data);
  }

  /// POST /pharmacy-orders/orders/:id/delivered
  static Future<Map<String, dynamic>> markPharmacyDelivered(int id) async {
    return _post('/pharmacy-orders/orders/$id/delivered', {});
  }

  /// POST /pharmacy-orders/orders/:id/cancel
  static Future<Map<String, dynamic>> cancelPharmacyOrder(
      int id, String reason) async {
    return _post('/pharmacy-orders/orders/$id/cancel', {
      'cancellation_reason': reason,
    });
  }
}
