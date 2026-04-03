import 'package:vhhealth_core/models/api_response.dart';
import 'api_client.dart';

/// Theatre/OT API calls: schedule, availability, status, checklists.
class TheatreApiService {
  TheatreApiService._();

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

  static Future<Map<String, dynamic>> _delete(String path) async {
    final resp = await ApiClient.delete(path);
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

  // --- Theatre Endpoints -----------------------------------------------------

  /// GET /theatre/today?date=&ot_room=&status=
  static Future<List<dynamic>> getTodaySchedule({
    String? date,
    String? otRoom,
    String? status,
  }) async {
    final query = <String, String>{};
    if (date != null) query['date'] = date;
    if (otRoom != null) query['ot_room'] = otRoom;
    if (status != null) query['status'] = status;
    final data = await _get('/theatre/today', query: query);
    return data['schedules'] as List? ?? data['data'] as List? ?? [];
  }

  /// GET /theatre/availability?date=
  static Future<List<dynamic>> getAvailability(String date) async {
    final data = await _get('/theatre/availability', query: {'date': date});
    return data['rooms'] as List? ?? data['data'] as List? ?? [];
  }

  /// POST /theatre/schedule
  static Future<Map<String, dynamic>> scheduleSurgery(
      Map<String, dynamic> data) async {
    return _post('/theatre/schedule', data);
  }

  /// PUT /theatre/:id/status
  static Future<Map<String, dynamic>> updateStatus(
      int id, String status) async {
    return _put('/theatre/$id/status', {'status': status});
  }

  /// PUT /theatre/:id/checklist
  static Future<Map<String, dynamic>> updateChecklist(
      int id, Map<String, dynamic> checklist) async {
    return _put('/theatre/$id/checklist', {'checklist': checklist});
  }

  /// DELETE /theatre/:id
  static Future<Map<String, dynamic>> cancelSurgery(int id) async {
    return _delete('/theatre/$id');
  }
}
