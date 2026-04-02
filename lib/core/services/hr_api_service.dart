import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/models/api_response.dart';
import 'api_client.dart';

/// HR-related API calls: dashboard, staff management, performance,
/// incidents, grievances, housekeeping, payroll.
class HrApiService {
  HrApiService._();

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

  // ─── HR Dashboard ──────────────────────────────────────────────────────────

  /// GET /staff/hr/dashboard
  static Future<Map<String, dynamic>> getHRDashboard(
      {String timeframe = 'current_month'}) async {
    return _get('/staff/hr/dashboard', query: {'timeframe': timeframe});
  }

  /// GET /staff — list of all staff (for replacement picker)
  static Future<List<dynamic>> getStaffList({String? department}) async {
    final url =
        '/staff${department != null ? '?department=$department' : ''}';
    try {
      final result = await _get(url);
      return result['data'] as List? ??
          result['staff'] as List? ??
          result['staffList'] as List? ??
          [];
    } catch (e) {
      debugPrint('HrApiService.getStaffList error: $e');
      return [];
    }
  }

  // ─── Staff Profile ───────────────────────────────────────────────────────

  /// GET /staff/:identifier — fetch profile by employee ID, UID, or phone
  static Future<Map<String, dynamic>> getProfile(String identifier) async {
    return _get('/staff/$identifier');
  }

  /// PUT /staff/:id — update staff profile
  static Future<Map<String, dynamic>> updateProfile(
      String id, Map<String, dynamic> updates) async {
    final resp = await ApiClient.put('/staff/$id', body: updates);
    return _handle(resp);
  }

  // ─── Performance ──────────────────────────────────────────────────────────

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

  // ─── Onboarding / Department ──────────────────────────────────────────────

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

  // ─── Incident Reports ────────────────────────────────────────────────────

  /// POST /api/v1/staff/hr/incidents/submit — submit an incident report
  static Future<Map<String, dynamic>> submitIncidentReport({
    required String incidentType,
    required String severity,
    required String title,
    required String description,
    required String incidentDate,
    String? location,
    bool patientInvolved = false,
    String? patientName,
    String? witnesses,
    String? immediateActionTaken,
    bool isAnonymous = false,
  }) async {
    return await _post('/api/v1/staff/hr/incidents/submit', {
      'incident_type': incidentType,
      'severity': severity,
      'title': title,
      'description': description,
      'incident_date': incidentDate,
      if (location != null) 'location': location,
      'patient_involved': patientInvolved,
      if (patientName != null) 'patient_name': patientName,
      if (witnesses != null) 'witnesses': witnesses,
      if (immediateActionTaken != null)
        'immediate_action_taken': immediateActionTaken,
      'is_anonymous': isAnonymous,
    });
  }

  /// GET /api/v1/staff/hr/incidents — get my incident reports
  static Future<List<dynamic>> getMyIncidents() async {
    final result = await _get('/api/v1/staff/hr/incidents');
    return result['data'] as List? ?? result as List? ?? [];
  }

  /// GET /api/v1/staff/hr/incidents/:id — get incident detail
  static Future<Map<String, dynamic>> getIncidentDetail(String id) async {
    return await _get('/api/v1/staff/hr/incidents/$id');
  }

  // ─── Grievances ──────────────────────────────────────────────────────────

  /// POST /api/v1/staff/hr/grievances/submit — submit a grievance
  static Future<Map<String, dynamic>> submitGrievance({
    required String grievanceType,
    required String subject,
    required String description,
    String? againstWhom,
    String? department,
    String? incidentDate,
    bool isAnonymous = false,
  }) async {
    return await _post('/api/v1/staff/hr/grievances/submit', {
      'grievance_type': grievanceType,
      'subject': subject,
      'description': description,
      if (againstWhom != null) 'against_whom': againstWhom,
      if (department != null) 'department': department,
      if (incidentDate != null) 'incident_date': incidentDate,
      'is_anonymous': isAnonymous,
    });
  }

  /// GET /api/v1/staff/hr/grievances — get my grievances
  static Future<List<dynamic>> getMyGrievances() async {
    final result = await _get('/api/v1/staff/hr/grievances');
    return result['data'] as List? ?? result as List? ?? [];
  }

  /// GET /api/v1/staff/hr/grievances/:id — get grievance detail
  static Future<Map<String, dynamic>> getGrievanceDetail(String id) async {
    return await _get('/api/v1/staff/hr/grievances/$id');
  }

  // ─── Housekeeping ─────────────────────────────────────────────────────────

  /// GET /api/v1/staff/hr/housekeeping/zones
  static Future<List<dynamic>> getHousekeepingZones() async {
    final result =
        await _get('/api/v1/staff/hr/housekeeping/zones');
    return result['data'] as List? ?? result as List? ?? [];
  }

  /// POST /api/v1/staff/hr/housekeeping/log
  static Future<Map<String, dynamic>> submitCleaningLog({
    required String cleaningType,
    int? zoneId,
    String? locationText,
    String? notes,
    String? photoKey,
    String? photoUrl,
    double? latitude,
    double? longitude,
  }) async {
    return await _post('/api/v1/staff/hr/housekeeping/log', {
      'cleaning_type': cleaningType,
      if (zoneId != null) 'zone_id': zoneId,
      if (locationText != null) 'location_text': locationText,
      if (notes != null) 'notes': notes,
      if (photoKey != null) 'photo_key': photoKey,
      if (photoUrl != null) 'photo_url': photoUrl,
      if (latitude != null) 'latitude': latitude,
      if (longitude != null) 'longitude': longitude,
    });
  }

  /// GET /api/v1/staff/hr/housekeeping/logs/my
  static Future<List<dynamic>> getMyCleaningLogs() async {
    final result =
        await _get('/api/v1/staff/hr/housekeeping/logs/my');
    return result['data'] as List? ?? result as List? ?? [];
  }

  /// POST /api/v1/staff/hr/housekeeping/request
  static Future<Map<String, dynamic>> raiseHousekeepingRequest({
    required String locationText,
    required String requestType,
    required String urgency,
    int? zoneId,
    String? description,
    String? photoKey,
    String? photoUrl,
    double? latitude,
    double? longitude,
  }) async {
    return await _post('/api/v1/staff/hr/housekeeping/request', {
      'location_text': locationText,
      'request_type': requestType,
      'urgency': urgency,
      if (zoneId != null) 'zone_id': zoneId,
      if (description != null) 'description': description,
      if (photoKey != null) 'photo_key': photoKey,
      if (photoUrl != null) 'photo_url': photoUrl,
      if (latitude != null) 'latitude': latitude,
      if (longitude != null) 'longitude': longitude,
    });
  }

  /// GET /api/v1/staff/hr/housekeeping/requests/my
  static Future<Map<String, dynamic>> getMyHousekeepingRequests() async {
    return await _get('/api/v1/staff/hr/housekeeping/requests/my');
  }

  /// POST /api/v1/staff/hr/housekeeping/requests/:id/complete
  static Future<Map<String, dynamic>> completeHousekeepingRequest({
    required String requestId,
    String? completionNotes,
    String? photoKey,
    String? photoUrl,
  }) async {
    return await _post(
        '/api/v1/staff/hr/housekeeping/requests/$requestId/complete', {
      if (completionNotes != null) 'completion_notes': completionNotes,
      if (photoKey != null) 'completion_photo_key': photoKey,
      if (photoUrl != null) 'completion_photo_url': photoUrl,
    });
  }

  // ─── Payroll ──────────────────────────────────────────────────────────────

  /// GET /api/v1/staff/hr/payslips?months=N
  static Future<List<dynamic>> getMyPayslips({int months = 3}) async {
    final result = await _get(
      '/api/v1/staff/hr/payslips',
      query: {'months': months.toString()},
    );
    return result['data'] as List? ?? (result is List ? result as List : []);
  }

  /// GET /api/v1/staff/hr/payslips/:id
  static Future<Map<String, dynamic>> getPayslipDetail(String id) async {
    final result = await _get('/api/v1/staff/hr/payslips/$id');
    return (result['data'] as Map<String, dynamic>?) ?? result;
  }

  /// GET /api/v1/staff/hr/payroll/tax-summary?fy=2025-26
  static Future<Map<String, dynamic>> getMyTaxSummary({String? fy}) async {
    final query = fy != null ? {'fy': fy} : null;
    final result = await _get(
      '/api/v1/staff/hr/payroll/tax-summary',
      query: query,
    );
    return (result['data'] as Map<String, dynamic>?) ?? result;
  }

  /// GET /api/v1/staff/hr/payroll/advances
  static Future<List<dynamic>> getMyAdvances() async {
    final result = await _get('/api/v1/staff/hr/payroll/advances');
    return result['data'] as List? ?? (result is List ? result as List : []);
  }

  /// POST /api/v1/staff/hr/payroll/declarations/submit
  static Future<Map<String, dynamic>> submitInvestmentDeclaration(
      Map<String, dynamic> data) async {
    return await _post(
        '/api/v1/staff/hr/payroll/declarations/submit', data);
  }

  /// GET /api/v1/staff/hr/payroll/declarations
  static Future<List<dynamic>> getMyDeclarations() async {
    final r = await _get('/api/v1/staff/hr/payroll/declarations');
    return r['data'] as List? ?? [];
  }

  /// POST /api/v1/staff/hr/payroll/queries/raise
  static Future<Map<String, dynamic>> raisePayslipQuery(
      Map<String, dynamic> data) async {
    return await _post('/api/v1/staff/hr/payroll/queries/raise', data);
  }

  /// GET /api/v1/staff/hr/payroll/queries
  static Future<List<dynamic>> getMyPayslipQueries() async {
    final r = await _get('/api/v1/staff/hr/payroll/queries');
    return r['data'] as List? ?? [];
  }

  // ─── Notifications ────────────────────────────────────────────────────────

  /// GET /notifications/:phone — fetch notifications for staff
  static Future<List<dynamic>> getNotifications(String phone) async {
    final resp = await ApiClient.get('/notifications/$phone');
    if (resp.isSuccess) {
      if (resp.data is List) return resp.data;
      if (resp.raw is Map) {
        final raw = resp.raw as Map<String, dynamic>;
        if (raw['data'] is List) return raw['data'];
      }
      return [];
    }
    throw Exception('Failed to fetch notifications (${resp.statusCode})');
  }

  /// PATCH /notifications/:phone/mark-all-read
  static Future<void> markAllNotificationsRead(String phone) async {
    await ApiClient.patch('/notifications/$phone/mark-all-read');
  }

  // ─── Device Registration ──────────────────────────────────────────────────

  /// POST /devices/register — register FCM token
  static Future<void> registerDevice({
    required String phone,
    required String fcmToken,
    required String platform,
  }) async {
    try {
      await ApiClient.post('/devices/register', body: {
        'phone': phone,
        'fcmToken': fcmToken,
        'deviceId': '${platform}_staff_${phone.hashCode}',
        'deviceName': 'VHHealth Staff App',
        'platform': platform,
      });
    } catch (e) {
      debugPrint('HrApiService.registerDevice error: $e');
    }
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
    final resp = await ApiClient.delete('/auth/staff/device/$deviceId');
    return _handle(resp);
  }
}
