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
    return _post('/staff/pharmacy/orders', {
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
    return _get('/appointments/list', query: {
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

  // ─── Health Records ────────────────────────────────────────────────────────────

  /// GET /records/health-records/:phone — fetch patient health records by phone
  static Future<Map<String, dynamic>> getHealthRecords(String phone) async {
    return _get('/records/health-records/$phone');
  }

  // ─── Auth / Quick ─────────────────────────────────────────────────────────────

  /// GET /auth/staff/attendance/today — today's check-in status
  static Future<Map<String, dynamic>> getAttendanceStatus() async {
    return _get('/auth/staff/attendance/today');
  }

  /// GET /auth/staff/attendance/today (alias)
  static Future<Map<String, dynamic>> getTodayAttendance() async {
    return _get('/auth/staff/attendance/today');
  }

  // ─── Staff Auth Enhancements ───────────────────────────────────────────────

  /// POST /auth/staff/setup-pin — set up quick-access PIN
  static Future<Map<String, dynamic>> setupPin({
    required String employeeId,
    required String pin,
  }) async {
    return _post('/auth/staff/setup-pin', {
      'employeeId': employeeId,
      'pin': pin,
    });
  }

  /// POST /auth/staff/toggle-biometric — enable/disable biometric login
  static Future<Map<String, dynamic>> toggleBiometric({
    required bool enabled,
    required String deviceToken,
  }) async {
    return _post('/auth/staff/toggle-biometric', {
      'enabled': enabled,
      'deviceToken': deviceToken,
    });
  }

  /// POST /auth/staff/quick-login — PIN or biometric quick login
  static Future<Map<String, dynamic>> quickLogin({
    required String employeeId,
    String? pin,
    String? biometricToken,
    String? deviceToken,
  }) async {
    return _post('/auth/staff/quick-login', {
      'employeeId': employeeId,
      if (pin != null) 'pin': pin,
      if (biometricToken != null) 'biometricToken': biometricToken,
      if (deviceToken != null) 'deviceToken': deviceToken,
    });
  }

  /// POST /auth/staff/register-device — register a trusted device
  static Future<Map<String, dynamic>> registerTrustedDevice({
    required String deviceToken,
    required String deviceName,
    required String platform,
  }) async {
    return _post('/auth/staff/register-device', {
      'deviceToken': deviceToken,
      'deviceName': deviceName,
      'platform': platform,
    });
  }

  /// POST /auth/staff/verify-device — verify a device token
  static Future<Map<String, dynamic>> verifyDevice({
    required String deviceToken,
  }) async {
    return _post('/auth/staff/verify-device', {
      'deviceToken': deviceToken,
    });
  }

  /// GET /auth/staff/profile — get staff profile from auth service
  static Future<Map<String, dynamic>> getAuthProfile() async {
    return _get('/auth/staff/profile');
  }

  /// GET /auth/staff/devices — list registered devices
  static Future<Map<String, dynamic>> getRegisteredDevices() async {
    return _get('/auth/staff/devices');
  }

  /// DELETE /auth/staff/device/:deviceId — remove a registered device
  static Future<Map<String, dynamic>> removeRegisteredDevice(
      String deviceId) async {
    final headers = await ApiConfig.authenticatedHeaders();
    final resp = await http.delete(
      Uri.parse('${ApiConfig.baseUrl}/auth/staff/device/$deviceId'),
      headers: headers,
    );
    return _handle(resp);
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

  // ─── HR Endpoints ──────────────────────────────────────────────────────────

  /// GET /staff/hr/performance-report — performance reports
  static Future<Map<String, dynamic>> getPerformanceReport({
    String? department,
    String? period,
  }) async {
    return _get('/staff/hr/performance-report', query: {
      if (department != null) 'department': department,
      if (period != null) 'period': period,
    });
  }

  /// GET /staff/hr/onboarding/:staff_id — onboarding checklist
  static Future<Map<String, dynamic>> getOnboardingChecklist(
      String staffId) async {
    return _get('/staff/hr/onboarding/$staffId');
  }

  /// GET /staff/hr/department/:department/summary — department summary
  static Future<Map<String, dynamic>> getDepartmentSummary(
      String department) async {
    return _get('/staff/hr/department/$department/summary');
  }

  /// GET /staff/hr/attendance-analytics — attendance analytics
  static Future<Map<String, dynamic>> getAttendanceAnalytics({
    String? startDate,
    String? endDate,
    String? department,
  }) async {
    return _get('/staff/hr/attendance-analytics', query: {
      if (startDate != null) 'startDate': startDate,
      if (endDate != null) 'endDate': endDate,
      if (department != null) 'department': department,
    });
  }

  /// GET /staff/hr/export-report — export staff report
  static Future<Map<String, dynamic>> exportStaffReport({
    String? format,
    String? department,
    String? reportType,
  }) async {
    return _get('/staff/hr/export-report', query: {
      if (format != null) 'format': format,
      if (department != null) 'department': department,
      if (reportType != null) 'reportType': reportType,
    });
  }

  /// POST /staff/hr/performance-review — create a performance review
  static Future<Map<String, dynamic>> createPerformanceReview({
    required String staffId,
    required String period,
    required double overallRating,
    required String comments,
    String? goals,
  }) async {
    return _post('/staff/hr/performance-review', {
      'staff_id': staffId,
      'period': period,
      'overall_rating': overallRating,
      'comments': comments,
      if (goals != null) 'goals': goals,
    });
  }

  // ─── Notifications ────────────────────────────────────────────────────────

  /// GET /notifications/:phone — fetch notifications for staff
  static Future<List<dynamic>> getNotifications(String phone) async {
    final headers = await ApiConfig.authenticatedHeaders();
    final resp = await http.get(
      Uri.parse('${ApiConfig.baseUrl}/notifications/$phone'),
      headers: headers,
    );
    if (resp.statusCode == 200) {
      final data = jsonDecode(resp.body);
      // Response may be a list directly or wrapped in { data: [...] }
      if (data is List) return data;
      if (data is Map && data['data'] is List) return data['data'];
      if (data is Map && data['success'] == true && data['data'] is List) {
        return data['data'];
      }
      return [];
    }
    throw Exception('Failed to fetch notifications (${resp.statusCode})');
  }

  /// PATCH /notifications/:phone/mark-all-read
  static Future<void> markAllNotificationsRead(String phone) async {
    final headers = await ApiConfig.authenticatedHeaders();
    await http.patch(
      Uri.parse('${ApiConfig.baseUrl}/notifications/$phone/mark-all-read'),
      headers: headers,
    );
  }

  // ─── Health Records / Vitals ──────────────────────────────────────────────

  /// POST /health/records — create a health record with vital signs
  static Future<Map<String, dynamic>> recordVitals({
    required int patientId,
    Map<String, dynamic>? vitalSigns,
    Map<String, dynamic>? measurements,
    String? notes,
    int? recordedBy,
  }) async {
    return _post('/health/records', {
      'patient_id': patientId,
      'record_type': 'VITALS',
      if (vitalSigns != null) 'vital_signs': vitalSigns,
      if (measurements != null) 'measurements': measurements,
      if (notes != null) 'notes': notes,
      if (recordedBy != null) 'recorded_by': recordedBy,
    });
  }

  /// GET /health/patient/:patient_id/trends — vital trends for a patient
  static Future<Map<String, dynamic>> getPatientVitalTrends(
    int patientId, {
    int? days,
    String? vitalType,
  }) async {
    return _get('/health/patient/$patientId/trends', query: {
      if (days != null) 'days': days.toString(),
      if (vitalType != null) 'vital_type': vitalType,
    });
  }

  // ─── Medical Records / Prescriptions ─────────────────────────────────────

  /// POST /records/create — create a medical record (prescription, consultation, etc.)
  static Future<Map<String, dynamic>> createPrescription({
    required int patientId,
    required String title,
    String? description,
    String? diagnosis,
    String? treatment,
    String? medications,
    int? privacyLevel,
  }) async {
    return _post('/records/create', {
      'patient_id': patientId,
      'record_type': 'PRESCRIPTION',
      'title': title,
      if (description != null) 'description': description,
      if (diagnosis != null) 'diagnosis': diagnosis,
      if (treatment != null) 'treatment': treatment,
      if (medications != null) 'medications': medications,
      if (privacyLevel != null) 'privacy_level': privacyLevel,
    });
  }

  /// GET /records/doctor/:doctor_id — records created by a doctor
  static Future<Map<String, dynamic>> getDoctorRecords(String doctorId) async {
    return _get('/records/doctor/$doctorId');
  }

  /// GET /records/records — list all medical records with filters
  static Future<Map<String, dynamic>> getMedicalRecords({
    String? type,
    String? dateFrom,
    String? dateTo,
    int? patientId,
    int? doctorId,
    int page = 1,
    int limit = 20,
  }) async {
    return _get('/records/records', query: {
      if (type != null) 'type': type,
      if (dateFrom != null) 'date_from': dateFrom,
      if (dateTo != null) 'date_to': dateTo,
      if (patientId != null) 'patient_id': patientId.toString(),
      if (doctorId != null) 'doctor_id': doctorId.toString(),
      'page': page.toString(),
      'limit': limit.toString(),
    });
  }

  /// GET /records/patient/:patient_id — records for a specific patient
  static Future<Map<String, dynamic>> getPatientRecords(int patientId) async {
    return _get('/records/patient/$patientId');
  }

  /// GET /records/health-records/:phone — health records by phone
  static Future<Map<String, dynamic>> getHealthRecordsByPhone(String phone) async {
    return _get('/records/health-records/$phone');
  }

  // ─── Investigations ──────────────────────────────────────────────────────

  /// GET /investigations/status/pending — pending investigations
  static Future<Map<String, dynamic>> getPendingInvestigations() async {
    return _get('/investigations/status/pending');
  }

  /// GET /investigations/doctor/:doctor_id — investigations for a doctor
  static Future<Map<String, dynamic>> getDoctorInvestigations(String doctorId) async {
    return _get('/investigations/doctor/$doctorId');
  }

  /// PUT /investigations/:id/results — add results to an investigation
  static Future<Map<String, dynamic>> addInvestigationResults(
    String investigationId,
    Map<String, dynamic> results,
  ) async {
    return _put('/investigations/$investigationId/results', results);
  }

  /// PUT /investigations/:id/status — update investigation status
  static Future<Map<String, dynamic>> updateInvestigationStatus(
    String investigationId,
    String status,
  ) async {
    return _put('/investigations/$investigationId/status', {'status': status});
  }

  /// GET /investigations/list — list investigations with filters
  static Future<Map<String, dynamic>> listInvestigations({
    int page = 1,
    int limit = 20,
  }) async {
    return _get('/investigations/list', query: {
      'page': page.toString(),
      'limit': limit.toString(),
    });
  }

  // ─── Device Registration ──────────────────────────────────────────────────

  /// POST /devices/register — register FCM token
  static Future<void> registerDevice({
    required String phone,
    required String fcmToken,
    required String platform,
  }) async {
    final headers = await ApiConfig.authenticatedHeaders();
    await http.post(
      Uri.parse('${ApiConfig.baseUrl}/devices/register'),
      headers: headers,
      body: jsonEncode({
        'phone': phone,
        'fcmToken': fcmToken,
        'deviceId': '${platform}_staff_${phone.hashCode}',
        'deviceName': 'VHHealth Staff App',
        'platform': platform,
      }),
    );
  }
}
