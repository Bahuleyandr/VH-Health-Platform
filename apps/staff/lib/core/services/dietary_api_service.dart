import 'api_client.dart';

/// Dietary kitchen management API calls (menu master, meal tickets, tray
/// tracking, production summary) — migration 685 backend surface under
/// /api/v1/dietary/*.
class DietaryApiService {
  DietaryApiService._();

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

  static List<Map<String, dynamic>> _mapList(dynamic value) {
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList();
  }

  // ─── Kitchen board / tray tracking ───────────────────────────────────────

  /// GET /dietary/kitchen/tickets — the day's meal tickets (default today
  /// IST), filterable by meal window, status, and ward.
  static Future<List<Map<String, dynamic>>> getMealTickets({
    String? date,
    String? mealType,
    String? status,
    String? ward,
  }) async {
    final data = await _get(
      '/dietary/kitchen/tickets',
      query: {
        if (date != null && date.isNotEmpty) 'date': date,
        if (mealType != null && mealType.isNotEmpty) 'meal_type': mealType,
        if (status != null && status.isNotEmpty) 'status': status,
        if (ward != null && ward.isNotEmpty) 'ward': ward,
      },
    );
    return _mapList(data['tickets']);
  }

  /// GET /dietary/kitchen/summary — live-ticket counts by meal x diet type
  /// plus a per-meal status rollup.
  static Future<Map<String, dynamic>> getProductionSummary({
    String? date,
  }) async {
    return _get(
      '/dietary/kitchen/summary',
      query: {if (date != null && date.isNotEmpty) 'date': date},
    );
  }

  /// POST /dietary/kitchen/generate — manual (idempotent) re-cut of the
  /// day's tickets for every active diet order of an admitted patient.
  static Future<Map<String, dynamic>> generateTickets({String? date}) async {
    return _post('/dietary/kitchen/generate', {
      if (date != null && date.isNotEmpty) 'service_date': date,
    });
  }

  /// POST /dietary/kitchen/tickets/:id/status — lifecycle transition
  /// (kitchen leg role-gated server-side; cancel requires a reason).
  static Future<Map<String, dynamic>> transitionTicket(
    String id,
    String status, {
    String? reason,
  }) async {
    return _post('/dietary/kitchen/tickets/$id/status', {
      'status': status,
      if (reason != null && reason.isNotEmpty) 'reason': reason,
    });
  }

  // ─── Menu master ─────────────────────────────────────────────────────────

  /// GET /dietary/menu-items — tenant menu master.
  static Future<List<Map<String, dynamic>>> getMenuItems({
    String? mealType,
    bool? active,
  }) async {
    final data = await _get(
      '/dietary/menu-items',
      query: {
        if (mealType != null && mealType.isNotEmpty) 'meal_type': mealType,
        if (active != null) 'active': '$active',
      },
    );
    return _mapList(data['items']);
  }
}
