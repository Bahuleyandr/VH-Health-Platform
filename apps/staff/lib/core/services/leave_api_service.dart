import 'package:flutter/foundation.dart';
import 'api_client.dart';

/// Leave-related API calls: apply, balance, history, approvals, replacements.
class LeaveApiService {
  LeaveApiService._();

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
      final raw = resp.raw as Map<String, dynamic>;
      if (raw['success'] == true) {
        return (raw['data'] as Map<String, dynamic>?) ?? raw;
      }
    }
    throw Exception(resp.message ?? 'Request failed (${resp.statusCode})');
  }

  // ─── Leave ──────────────────────────────────────────────────────────────

  /// GET /staff/hr/leave-balance/:staff_id
  static Future<Map<String, dynamic>> getLeaveBalance(
    String staffId, {
    int? year,
  }) async {
    return _get(
      '/staff/hr/leave-balance/$staffId',
      query: year != null ? {'year': year.toString()} : null,
    );
  }

  /// POST /staff/hr/leave/apply
  /// body: { staff_id, leave_type, start_date, end_date, reason, emergency_contact? }
  static Future<Map<String, dynamic>> applyLeave({
    required String staffId,
    required String leaveType,
    required String startDate,
    required String endDate,
    required String reason,
    String? emergencyContact,
  }) async {
    return _post('/staff/hr/leave/apply', {
      'staff_id': staffId,
      'leave_type': leaveType,
      'start_date': startDate,
      'end_date': endDate,
      'reason': reason,
      'emergency_contact': ?emergencyContact,
    });
  }

  /// POST /staff/hr/leave/apply — apply for leave with optional replacement
  static Future<Map<String, dynamic>> applyForLeaveWithReplacement({
    required String staffId,
    required String leaveType,
    required String startDate,
    required String endDate,
    required String reason,
    String? replacementStaffId,
  }) async {
    return _post('/staff/hr/leave/apply', {
      'staff_id': staffId,
      'leave_type': leaveType,
      'start_date': startDate,
      'end_date': endDate,
      'reason': reason,
      'replacement_staff_id': ?replacementStaffId,
    });
  }

  /// GET /staff/hr/leave/my — current staff member's leave applications.
  static Future<Map<String, dynamic>> getMyLeaves(String staffId) async {
    return _get('/staff/hr/leave/my');
  }

  /// GET /staff/hr/replacement/pending — pending replacement requests for me
  static Future<List<dynamic>> getReplacementRequests() async {
    try {
      final resp = await ApiClient.get('/staff/hr/replacement/pending');
      if (resp.isSuccess && resp.raw is Map) {
        final raw = resp.raw as Map<String, dynamic>;
        final data = raw['data'];
        if (raw['success'] == true && data is List) {
          return data;
        }
      }
      throw Exception(resp.message ?? 'Request failed (${resp.statusCode})');
    } catch (e) {
      debugPrint('LeaveApiService.getReplacementRequests error: $e');
      return [];
    }
  }

  /// POST /staff/hr/replacement/:id/respond — accept or decline
  static Future<Map<String, dynamic>> respondToReplacement({
    required String requestId,
    required String status,
    String? message,
  }) async {
    return _post('/staff/hr/replacement/$requestId/respond', {
      'status': status,
      'message': ?message,
    });
  }
}
