import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config/api_config.dart';

class StaffApiService {
  StaffApiService._();

  // ─── Helpers ────────────────────────────────────────────────────────────────

  static Future<Map<String, dynamic>> _get(String path,
      {Map<String, String>? query}) async {
    final headers = await ApiConfig.authenticatedHeaders();
    var uri = Uri.parse('${ApiConfig.baseUrl}$path');
    if (query != null && query.isNotEmpty) {
      uri = uri.replace(queryParameters: query);
    }
    final resp = await http.get(uri, headers: headers);
    return _handle(resp);
  }

  static Future<Map<String, dynamic>> _post(String path,
      Map<String, dynamic> body) async {
    final headers = await ApiConfig.authenticatedHeaders();
    final resp = await http.post(
      Uri.parse('${ApiConfig.baseUrl}$path'),
      headers: headers,
      body: jsonEncode(body),
    );
    return _handle(resp);
  }

  static Future<Map<String, dynamic>> _put(String path,
      Map<String, dynamic> body) async {
    final headers = await ApiConfig.authenticatedHeaders();
    final resp = await http.put(
      Uri.parse('${ApiConfig.baseUrl}$path'),
      headers: headers,
      body: jsonEncode(body),
    );
    return _handle(resp);
  }

  static Map<String, dynamic> _handle(http.Response resp) {
    final data = jsonDecode(resp.body);
    if (resp.statusCode >= 200 &&
        resp.statusCode < 300 &&
        data['success'] == true) {
      return (data['data'] as Map<String, dynamic>?) ?? data;
    }
    throw Exception(data['message'] ?? 'Request failed (${resp.statusCode})');
  }

  // ─── Staff Profile ───────────────────────────────────────────────────────────

  /// GET /staff/:identifier — fetch profile by employee ID, UID, or phone
  static Future<Map<String, dynamic>> getProfile(String identifier) async {
    return _get('/staff/$identifier');
  }

  /// PUT /staff/:id — update staff profile
  static Future<Map<String, dynamic>> updateProfile(
      String id, Map<String, dynamic> updates) async {
    return _put('/staff/$id', updates);
  }

  // ─── Attendance ──────────────────────────────────────────────────────────────

  /// POST /staff/attendance — mark check-in or check-out
  /// body: { staffId, action: 'check-in'|'check-out', location? }
  static Future<Map<String, dynamic>> markAttendance({
    required String staffId,
    required String action, // 'check-in' or 'check-out'
    Map<String, dynamic>? location,
  }) async {
    return _post('/staff/attendance', {
      'staffId': staffId,
      'action': action,
      if (location != null) 'location': location,
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

  // ─── HR / Leave ──────────────────────────────────────────────────────────────

  /// GET /staff/hr/dashboard
  static Future<Map<String, dynamic>> getHRDashboard(
      {String timeframe = 'current_month'}) async {
    return _get('/staff/hr/dashboard', query: {'timeframe': timeframe});
  }

  /// GET /staff/hr/leave-balance/:staff_id
  static Future<Map<String, dynamic>> getLeaveBalance(
    String staffId, {
    int? year,
  }) async {
    return _get('/staff/hr/leave-balance/$staffId',
        query: year != null ? {'year': year.toString()} : null);
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
      if (emergencyContact != null) 'emergency_contact': emergencyContact,
    });
  }

  // ─── Medical / Consultations ─────────────────────────────────────────────────

  /// POST /staff/medical/consultations
  /// body: { phone, patientName, consultationType, notes, date, ... }
  static Future<Map<String, dynamic>> uploadConsultation({
    required String phone,
    required String consultationType,
    String? patientName,
    String? notes,
    String? date,
    Map<String, dynamic>? additionalData,
  }) async {
    return _post('/staff/medical/consultations', {
      'phone': phone,
      'consultationType': consultationType,
      if (patientName != null) 'patientName': patientName,
      if (notes != null) 'notes': notes,
      if (date != null) 'date': date,
      if (additionalData != null) ...additionalData,
    });
  }

  /// POST /staff/medical/investigations
  /// body: { phone, testType, result, notes, fileUrl?, date }
  static Future<Map<String, dynamic>> uploadInvestigation({
    required String phone,
    required String testType,
    String? result,
    String? notes,
    String? fileUrl,
    String? date,
  }) async {
    return _post('/staff/medical/investigations', {
      'phone': phone,
      'testType': testType,
      if (result != null) 'result': result,
      if (notes != null) 'notes': notes,
      if (fileUrl != null) 'fileUrl': fileUrl,
      if (date != null) 'date': date,
    });
  }

  // ─── Pharmacy ────────────────────────────────────────────────────────────────

  /// PUT /staff/pharmacy/orders
  /// body: { phone, orderId, status, notes? }
  static Future<Map<String, dynamic>> updatePharmacyOrder({
    required String phone,
    required String orderId,
    required String status,
    String? notes,
  }) async {
    return _put('/staff/pharmacy/orders', {
      'phone': phone,
      'orderId': orderId,
      'status': status,
      if (notes != null) 'notes': notes,
    });
  }

  // ─── Appointments (via patient records) ──────────────────────────────────────

  /// GET /appointments — list appointments optionally filtered by department/staff
  static Future<Map<String, dynamic>> getAppointments({
    String? department,
    String? staffId,
    String? date,
    String? status,
    int page = 1,
    int limit = 20,
  }) async {
    return _get('/appointments', query: {
      if (department != null) 'department': department,
      if (staffId != null) 'staffId': staffId,
      if (date != null) 'date': date,
      if (status != null) 'status': status,
      'page': page.toString(),
      'limit': limit.toString(),
    });
  }

  /// PUT /appointments/:id/status — confirm or reschedule
  static Future<Map<String, dynamic>> updateAppointmentStatus(
    String appointmentId,
    String status, {
    String? notes,
  }) async {
    return _put('/appointments/$appointmentId/status', {
      'status': status,
      if (notes != null) 'notes': notes,
    });
  }

  // ─── Auth / Quick ─────────────────────────────────────────────────────────────

  /// GET /auth/staff/attendance-status — today's check-in status
  static Future<Map<String, dynamic>> getAttendanceStatus() async {
    return _get('/auth/staff/attendance-status');
  }

  /// GET /auth/staff/today-attendance
  static Future<Map<String, dynamic>> getTodayAttendance() async {
    return _get('/auth/staff/today-attendance');
  }
}
