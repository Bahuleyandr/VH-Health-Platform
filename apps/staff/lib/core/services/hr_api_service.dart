import 'package:flutter/foundation.dart';
import 'api_client.dart';

/// HR-related API calls: dashboard, staff management, performance,
/// incidents, grievances, housekeeping, payroll.
class HrApiService {
  HrApiService._();

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
    if (resp.isSuccess && resp.data is Map) {
      return Map<String, dynamic>.from(resp.data as Map);
    }
    if (resp.isSuccess && resp.data is List) {
      return {'data': resp.data};
    }
    if (resp.isSuccess && resp.raw is Map) {
      final raw = resp.raw as Map<String, dynamic>;
      if (raw['success'] == true) {
        final data = raw['data'];
        if (data is Map) return Map<String, dynamic>.from(data);
        if (data is List) return {'data': data};
        return raw;
      }
    }
    throw Exception(resp.message ?? 'Request failed (${resp.statusCode})');
  }

  // ─── HR Dashboard ──────────────────────────────────────────────────────────

  /// GET /staff/hr/dashboard
  static Future<Map<String, dynamic>> getHRDashboard({
    String timeframe = 'current_month',
  }) async {
    return _get('/staff/hr/dashboard', query: {'timeframe': timeframe});
  }

  /// GET /staff/list — list of all staff (for replacement picker).
  /// Path was `/staff` historically; that hits `/api/v1/staff` which
  /// the backend's staffRoutes router does not register (no GET `/`),
  /// so it returned `Cannot GET /api/v1/staff` (404). The actual
  /// listing endpoint is `/staff/list`.
  static Future<List<dynamic>> getStaffList({String? department}) async {
    final url =
        '/staff/list${department != null ? '?department=$department' : ''}';
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
    String id,
    Map<String, dynamic> updates,
  ) async {
    final resp = await ApiClient.put('/staff/$id', body: updates);
    return _handle(resp);
  }

  // ─── Performance ──────────────────────────────────────────────────────────

  /// GET /staff/hr/performance-report — performance reports
  static Future<Map<String, dynamic>> getPerformanceReport({
    String? department,
    String? period,
  }) async {
    return _get(
      '/staff/hr/performance-report',
      query: {'department': ?department, 'period': ?period},
    );
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
      'goals': ?goals,
    });
  }

  // ─── Onboarding / Department ──────────────────────────────────────────────

  /// GET /staff/hr/onboarding/:staff_id — onboarding checklist
  static Future<Map<String, dynamic>> getOnboardingChecklist(
    String staffId,
  ) async {
    return _get('/staff/hr/onboarding/$staffId');
  }

  /// GET /staff/hr/department/:department/summary — department summary
  static Future<Map<String, dynamic>> getDepartmentSummary(
    String department,
  ) async {
    return _get('/staff/hr/department/$department/summary');
  }

  /// GET /staff/hr/attendance-analytics — attendance analytics
  static Future<Map<String, dynamic>> getAttendanceAnalytics({
    String? startDate,
    String? endDate,
    String? department,
  }) async {
    return _get(
      '/staff/hr/attendance-analytics',
      query: {
        'startDate': ?startDate,
        'endDate': ?endDate,
        'department': ?department,
      },
    );
  }

  /// GET /staff/hr/export-report — export staff report
  static Future<Map<String, dynamic>> exportStaffReport({
    String? format,
    String? department,
    String? reportType,
  }) async {
    return _get(
      '/staff/hr/export-report',
      query: {
        'format': ?format,
        'department': ?department,
        'reportType': ?reportType,
      },
    );
  }

  // ─── Incident Reports ────────────────────────────────────────────────────

  /// POST /staff/hr/incidents/submit — submit an incident report
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
    return await _post('/staff/hr/incidents/submit', {
      'incident_type': incidentType,
      'severity': severity,
      'title': title,
      'description': description,
      'incident_date': incidentDate,
      'location': ?location,
      'patient_involved': patientInvolved,
      'patient_name': ?patientName,
      'witnesses': ?witnesses,
      'immediate_action_taken': ?immediateActionTaken,
      'is_anonymous': isAnonymous,
    });
  }

  /// GET /api/v1/staff/hr/incidents — get my incident reports
  static Future<List<dynamic>> getMyIncidents() async {
    final result = await _get('/staff/hr/incidents');
    return result['data'] as List? ?? result as List? ?? [];
  }

  /// GET /api/v1/staff/hr/incidents/:id — get incident detail
  static Future<Map<String, dynamic>> getIncidentDetail(String id) async {
    return await _get('/staff/hr/incidents/$id');
  }

  // ─── Grievances ──────────────────────────────────────────────────────────

  /// POST /staff/hr/grievances/submit — submit a grievance
  static Future<Map<String, dynamic>> submitGrievance({
    required String grievanceType,
    required String subject,
    required String description,
    String? againstWhom,
    String? department,
    String? incidentDate,
    bool isAnonymous = false,
  }) async {
    return await _post('/staff/hr/grievances/submit', {
      'grievance_type': grievanceType,
      'subject': subject,
      'description': description,
      'against_whom': ?againstWhom,
      'department': ?department,
      'incident_date': ?incidentDate,
      'is_anonymous': isAnonymous,
    });
  }

  /// GET /api/v1/staff/hr/grievances — get my grievances
  static Future<List<dynamic>> getMyGrievances() async {
    final result = await _get('/staff/hr/grievances');
    return result['data'] as List? ?? result as List? ?? [];
  }

  /// GET /api/v1/staff/hr/grievances/:id — get grievance detail
  static Future<Map<String, dynamic>> getGrievanceDetail(String id) async {
    return await _get('/staff/hr/grievances/$id');
  }

  // ─── Housekeeping ─────────────────────────────────────────────────────────

  /// GET /housekeeping/zones
  static Future<List<dynamic>> getHousekeepingZones() async {
    final result = await _get('/housekeeping/zones');
    return result['data'] as List? ?? result as List? ?? [];
  }

  /// POST /housekeeping/logs
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
    return await _post('/housekeeping/logs', {
      'cleaning_type': cleaningType,
      'zone_id': ?zoneId,
      'location_text': ?locationText,
      'notes': ?notes,
      'photo_key': ?photoKey,
      'photo_url': ?photoUrl,
      'latitude': ?latitude,
      'longitude': ?longitude,
    });
  }

  /// GET /housekeeping/logs/my
  static Future<List<dynamic>> getMyCleaningLogs() async {
    final result = await _get('/housekeeping/logs/my');
    return result['data'] as List? ?? result as List? ?? [];
  }

  /// POST /housekeeping/requests
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
    return await _post('/housekeeping/requests', {
      'location_text': locationText,
      'request_type': requestType,
      'urgency': urgency,
      'zone_id': ?zoneId,
      'description': ?description,
      'photo_key': ?photoKey,
      'photo_url': ?photoUrl,
      'latitude': ?latitude,
      'longitude': ?longitude,
    });
  }

  /// GET /housekeeping/requests/my
  static Future<Map<String, dynamic>> getMyHousekeepingRequests() async {
    return await _get('/housekeeping/requests/my');
  }

  /// POST /housekeeping/requests/:id/start
  static Future<Map<String, dynamic>> startHousekeepingRequest({
    required String requestId,
  }) async {
    return await _post('/housekeeping/requests/$requestId/start', {});
  }

  /// POST /housekeeping/requests/:id/complete
  static Future<Map<String, dynamic>> completeHousekeepingRequest({
    required String requestId,
    String? completionNotes,
    String? photoKey,
    String? photoUrl,
  }) async {
    return await _post('/housekeeping/requests/$requestId/complete', {
      'completion_notes': ?completionNotes,
      'completion_photo_key': ?photoKey,
      'completion_photo_url': ?photoUrl,
    });
  }

  /// GET /housekeeping/delegation/overview
  static Future<Map<String, dynamic>>
  getHousekeepingDelegationOverview() async {
    return await _get('/housekeeping/delegation/overview');
  }

  /// POST /housekeeping/delegation/assignments
  static Future<Map<String, dynamic>> delegateHousekeepingStaff({
    required int staffId,
    int? zoneId,
    String? floor,
    String? building,
    String shiftLabel = 'current',
    String? reason,
    bool isTemporary = true,
    bool closeExisting = true,
    bool reassignUnassignedRequests = true,
  }) async {
    return await _post('/housekeeping/delegation/assignments', {
      'staff_id': staffId,
      'zone_id': ?zoneId,
      'floor': ?floor,
      'building': ?building,
      'shift_label': shiftLabel,
      'reason': ?reason,
      'is_temporary': isTemporary,
      'close_existing': closeExisting,
      'reassign_unassigned_requests': reassignUnassignedRequests,
    });
  }

  /// POST /housekeeping/delegation/assignments/:id/end
  static Future<Map<String, dynamic>> endHousekeepingAssignment({
    required int assignmentId,
    String? reason,
  }) async {
    return await _post(
      '/housekeeping/delegation/assignments/$assignmentId/end',
      {'reason': ?reason},
    );
  }

  /// GET /staff/roster-board/departments/:department
  static Future<Map<String, dynamic>> getRosterBoard({
    required String department,
    required String rosterDate,
  }) async {
    return await _get(
      '/staff/roster-board/departments/$department',
      query: {'date': rosterDate},
    );
  }

  /// POST /staff/roster-board/departments/:department/boards
  static Future<Map<String, dynamic>> saveRosterBoard({
    required String department,
    required String rosterDate,
    required String shiftLabel,
    int? shiftId,
    String? notes,
    required List<Map<String, dynamic>> assignments,
  }) async {
    return await _post('/staff/roster-board/departments/$department/boards', {
      'roster_date': rosterDate,
      'shift_label': shiftLabel,
      'shift_id': ?shiftId,
      'notes': ?notes,
      'assignments': assignments,
    });
  }

  /// POST /staff/roster-board/boards/:id/publish
  static Future<Map<String, dynamic>> publishRosterBoard({
    required int rosterId,
    String? reason,
  }) async {
    return await _post('/staff/roster-board/boards/$rosterId/publish', {
      'reason': ?reason,
    });
  }

  /// POST /staff/roster-board/departments/:department/copy-previous
  static Future<Map<String, dynamic>> copyPreviousRosterBoard({
    required String department,
    required String rosterDate,
    required String shiftLabel,
  }) async {
    return await _post(
      '/staff/roster-board/departments/$department/copy-previous',
      {'target_date': rosterDate, 'shift_label': shiftLabel},
    );
  }

  // ─── Payroll ──────────────────────────────────────────────────────────────

  /// GET /staff/hr/payslips?months=N
  static Future<List<dynamic>> getMyPayslips({int months = 3}) async {
    final result = await _get(
      '/staff/hr/payslips',
      query: {'months': months.toString()},
    );
    return result['data'] as List? ?? (result is List ? result as List : []);
  }

  /// GET /staff/hr/payslips/:id
  static Future<Map<String, dynamic>> getPayslipDetail(String id) async {
    final result = await _get('/staff/hr/payslips/$id');
    return (result['data'] as Map<String, dynamic>?) ?? result;
  }

  /// GET /staff/hr/payroll/tax-summary?fy=2025-26
  static Future<Map<String, dynamic>> getMyTaxSummary({String? fy}) async {
    final query = fy != null ? {'fy': fy} : null;
    final result = await _get('/staff/hr/payroll/tax-summary', query: query);
    return (result['data'] as Map<String, dynamic>?) ?? result;
  }

  /// GET /staff/hr/payroll/advances
  static Future<List<dynamic>> getMyAdvances() async {
    final result = await _get('/staff/hr/payroll/advances');
    return result['data'] as List? ?? (result is List ? result as List : []);
  }

  /// POST /staff/hr/payroll/declarations/submit
  static Future<Map<String, dynamic>> submitInvestmentDeclaration(
    Map<String, dynamic> data,
  ) async {
    return await _post('/staff/hr/payroll/declarations/submit', data);
  }

  /// GET /staff/hr/payroll/declarations
  static Future<List<dynamic>> getMyDeclarations() async {
    final r = await _get('/staff/hr/payroll/declarations');
    return r['data'] as List? ?? [];
  }

  /// POST /staff/hr/payroll/queries/raise
  static Future<Map<String, dynamic>> raisePayslipQuery(
    Map<String, dynamic> data,
  ) async {
    return await _post('/staff/hr/payroll/queries/raise', data);
  }

  /// GET /staff/hr/payroll/queries
  static Future<List<dynamic>> getMyPayslipQueries() async {
    final r = await _get('/staff/hr/payroll/queries');
    return r['data'] as List? ?? [];
  }

  // ─── Notifications ────────────────────────────────────────────────────────

  /// GET /notifications/my — fetch notifications for the authenticated staff member.
  ///
  /// Uses the JWT-derived identity instead of putting the phone number in the URL.
  static Future<List<dynamic>> getNotifications(String phone) async {
    final resp = await ApiClient.get('/notifications/my');
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

  /// PATCH /notifications/my/mark-all-read
  static Future<void> markAllNotificationsRead(String phone) async {
    await ApiClient.patch('/notifications/my/mark-all-read');
  }

  // ─── Device Registration ──────────────────────────────────────────────────

  /// POST /devices/register — register FCM token
  static Future<void> registerDevice({
    required String phone,
    required String fcmToken,
    required String platform,
  }) async {
    try {
      await ApiClient.post(
        '/devices/register',
        body: {
          'phone': phone,
          'fcmToken': fcmToken,
          'deviceId': '${platform}_staff_${phone.hashCode}',
          'deviceName': 'VHHealth Staff App',
          'platform': platform,
        },
      );
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
      'pin': ?pin,
      'biometricToken': ?biometricToken,
      'deviceToken': ?deviceToken,
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
    return _post('/auth/staff/verify-device', {'deviceToken': deviceToken});
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
    String deviceId,
  ) async {
    final resp = await ApiClient.delete('/auth/staff/device/$deviceId');
    return _handle(resp);
  }
}
