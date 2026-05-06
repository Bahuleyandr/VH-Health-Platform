import 'api_client.dart';

/// Pharmacy order management API calls.
class PharmacyApiService {
  PharmacyApiService._();

  // ─── Helpers ──────────────────────────────────────────────────────────────

  static Future<Map<String, dynamic>> _get(
    String path, {
    Map<String, String>? query,
  }) async {
    final resp = await ApiClient.get(path, queryParameters: query);
    return _handle(resp);
  }

  static Future<Map<String, dynamic>> _post(
    String path,
    Map<String, dynamic> body,
  ) async {
    final resp = await ApiClient.post(path, body: body);
    return _handle(resp);
  }

  static Map<String, dynamic> _handle(ApiResponse resp) {
    if (resp.isSuccess && resp.raw is Map) {
      final raw = Map<String, dynamic>.from(resp.raw as Map);
      if (raw['success'] == true) {
        final data = raw['data'];
        if (data is Map) return Map<String, dynamic>.from(data);
        if (data is List) return {'data': data};
        return raw;
      }
    }
    throw Exception(resp.message ?? 'Request failed (${resp.statusCode})');
  }

  static List<dynamic> _listFrom(Map<String, dynamic> data, List<String> keys) {
    dynamic value;
    for (final key in keys) {
      value = data[key];
      if (value != null) break;
    }
    value ??= data['data'];
    if (value is Map) {
      return _listFrom(Map<String, dynamic>.from(value), keys);
    }
    if (value is List) return value;
    return const [];
  }

  // ─── Pharmacy Orders ──────────────────────────────────────────────────────

  /// POST /pharmacy-orders/orders — create a pharmacy order for a patient.
  static Future<Map<String, dynamic>> placePharmacyOrder({
    required String phone,
    required String orderNote,
    bool urgent = false,
  }) async {
    return _post('/pharmacy-orders/orders', {
      'phone': phone,
      'order_note': orderNote,
      'urgent': urgent,
    });
  }

  /// POST /staff/pharmacy/orders (legacy)
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
    final resp = await _get(
      '/pharmacy-orders/orders/queue',
      query: {'status': ?status},
    );
    return _listFrom(resp, const ['orders', 'queue']);
  }

  /// POST /pharmacy-orders/orders/:id/confirm
  static Future<Map<String, dynamic>> confirmPharmacyOrder(
    int id,
    Map<String, dynamic> data,
  ) async {
    return _post('/pharmacy-orders/orders/$id/confirm', data);
  }

  /// POST /pharmacy-orders/orders/:id/preparing
  static Future<Map<String, dynamic>> markPharmacyPreparing(int id) async {
    return _post('/pharmacy-orders/orders/$id/preparing', {});
  }

  /// POST /pharmacy-orders/orders/:id/dispatch
  static Future<Map<String, dynamic>> dispatchPharmacyOrder(
    int id,
    Map<String, dynamic> data,
  ) async {
    return _post('/pharmacy-orders/orders/$id/dispatch', data);
  }

  /// POST /pharmacy-orders/orders/:id/delivered
  static Future<Map<String, dynamic>> markPharmacyDelivered(int id) async {
    return _post('/pharmacy-orders/orders/$id/delivered', {});
  }

  /// POST /pharmacy-orders/orders/:id/cancel
  static Future<Map<String, dynamic>> cancelPharmacyOrder(
    int id,
    String reason,
  ) async {
    return _post('/pharmacy-orders/orders/$id/cancel', {
      'cancellation_reason': reason,
    });
  }
}
