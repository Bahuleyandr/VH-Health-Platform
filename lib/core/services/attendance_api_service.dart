import 'package:vhhealth_core/models/api_response.dart';
import 'api_client.dart';

/// Attendance-related API calls: check-in, check-out, history, breaks,
/// disputes, overtime, and regularisation.
class AttendanceApiService {
  AttendanceApiService._();

  // ─── Helpers (shared with StaffApiService) ────────────────────────────────

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

  // ─── Attendance ──────────────────────────────────────────────────────────

  /// POST /staff/attendance — mark check-in or check-out
  /// body: { staffId, action: 'check-in'|'check-out', location? }
  static Future<Map<String, dynamic>> markAttendance({
    required String staffId,
    required String action,
    Map<String, dynamic>? location,
  }) async {
    return _post('/staff/attendance', {
      'staffId': staffId,
      'action': action,
      if (location != null) 'location': location,
    });
  }

  /// POST /staff/attendance — mark check-in/out with GPS/WiFi location data
  static Future<Map<String, dynamic>> markAttendanceWithLocation({
    required String staffId,
    required String action,
    required Map<String, dynamic> location,
  }) async {
    return _post('/staff/attendance', {
      'staffId': staffId,
      'action': action,
      'location': location,
    });
  }

  /// GET /staff/attendance/:id/calendar — monthly attendance calendar
  static Future<Map<String, dynamic>> getAttendanceCalendar({
    required String staffId,
    required int year,
    required int month,
  }) async {
    return _get('/staff/attendance/$staffId/calendar',
        query: {'year': year.toString(), 'month': month.toString()});
  }

  /// POST /staff/attendance/:id/regularize — request attendance correction
  static Future<Map<String, dynamic>> requestRegularization({
    required String staffId,
    required String date,
    required String reason,
    String? checkInTime,
    String? checkOutTime,
  }) async {
    return _post('/staff/attendance/$staffId/regularize', {
      'date': date,
      'reason': reason,
      if (checkInTime != null) 'check_in_time': checkInTime,
      if (checkOutTime != null) 'check_out_time': checkOutTime,
    });
  }

  /// GET /staff/attendance/:id — get attendance records for a staff member
  static Future<Map<String, dynamic>> getAttendance(
    String staffId, {
    String? startDate,
    String? endDate,
    int page = 1,
    int limit = 30,
  }) async {
    return _get('/staff/attendance/$staffId', query: {
      if (startDate != null) 'startDate': startDate,
      if (endDate != null) 'endDate': endDate,
      'page': page.toString(),
      'limit': limit.toString(),
    });
  }

  /// GET /auth/staff/attendance/today — today's check-in status
  static Future<Map<String, dynamic>> getAttendanceStatus() async {
    return _get('/auth/staff/attendance/today');
  }

  /// GET /auth/staff/attendance/today (alias)
  static Future<Map<String, dynamic>> getTodayAttendance() async {
    return _get('/auth/staff/attendance/today');
  }

  /// GET /auth/staff/attendance/history — attendance history from auth service
  static Future<Map<String, dynamic>> getAttendanceHistory({
    String? startDate,
    String? endDate,
    int? page,
    int? limit,
  }) async {
    return _get('/auth/staff/attendance/history', query: {
      if (startDate != null) 'startDate': startDate,
      if (endDate != null) 'endDate': endDate,
      if (page != null) 'page': page.toString(),
      if (limit != null) 'limit': limit.toString(),
    });
  }

  // ─── Break Tracking ────────────────────────────────────────────────────────

  /// POST /api/v1/staff/attendance/:staffId/break/start — start a break
  static Future<Map<String, dynamic>> startBreak(String staffId) async {
    return _post('/staff/attendance/$staffId/break/start', {});
  }

  /// POST /api/v1/staff/attendance/:staffId/break/end — end a break
  static Future<Map<String, dynamic>> endBreak(String staffId) async {
    return _post('/staff/attendance/$staffId/break/end', {});
  }

  /// GET /api/v1/staff/attendance/:staffId/break/today — get today's breaks
  static Future<Map<String, dynamic>> getTodayBreaks(String staffId) async {
    return _get('/staff/attendance/$staffId/break/today');
  }

  // ─── Attendance Disputes ────────────────────────────────────────────────────

  /// POST /api/v1/staff/attendance/:staffId/dispute — submit attendance dispute
  static Future<Map<String, dynamic>> submitDispute({
    required String staffId,
    required String date,
    required String disputeType,
    required String description,
    String? requestedCheckIn,
    String? requestedCheckOut,
  }) async {
    return _post('/staff/attendance/$staffId/dispute', {
      'date': date,
      'dispute_type': disputeType,
      'description': description,
      if (requestedCheckIn != null) 'requested_check_in': requestedCheckIn,
      if (requestedCheckOut != null)
        'requested_check_out': requestedCheckOut,
    });
  }

  /// GET /api/v1/staff/attendance/:staffId/disputes — get my disputes
  static Future<List<dynamic>> getMyDisputes(String staffId) async {
    final result =
        await _get('/staff/attendance/$staffId/disputes');
    return result['data'] as List? ?? result as List? ?? [];
  }

  // ─── Overtime Requests ──────────────────────────────────────────────────────

  /// POST /api/v1/staff/hr/overtime/request — request overtime
  static Future<Map<String, dynamic>> requestOvertime({
    required String date,
    required double extraHours,
    required String reason,
    String type = 'comp_time',
  }) async {
    return _post('/staff/hr/overtime/request', {
      'date': date,
      'extra_hours': extraHours,
      'reason': reason,
      'type': type,
    });
  }

  /// GET /api/v1/staff/hr/overtime — get my overtime requests
  static Future<List<dynamic>> getMyOvertimeRequests() async {
    final result = await _get('/staff/hr/overtime');
    return result['data'] as List? ?? result as List? ?? [];
  }
}
