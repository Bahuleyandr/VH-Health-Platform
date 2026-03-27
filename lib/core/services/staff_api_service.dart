import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'api_client.dart';

class StaffApiService {
  StaffApiService._();

  // ─── Helpers ────────────────────────────────────────────────────────────────

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

  static Map<String, dynamic> _handle(ApiResponse resp) {
    if (resp.isSuccess && resp.raw is Map) {
      final raw = resp.raw as Map<String, dynamic>;
      if (raw['success'] == true) {
        return (raw['data'] as Map<String, dynamic>?) ?? raw;
      }
    }
    throw Exception(resp.message ?? 'Request failed (${resp.statusCode})');
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

  /// POST /staff/attendance — mark check-in/out with GPS/WiFi location data
  static Future<Map<String, dynamic>> markAttendanceWithLocation({
    required String staffId,
    required String action,
    required Map<String, dynamic> location,
  }) async {
    return _post('/staff/attendance', {
      'staff_id': staffId,
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
      if (replacementStaffId != null)
        'replacement_staff_id': replacementStaffId,
    });
  }

  /// GET /staff/hr/leave-balance/:staff_id — my leave list (reuses balance endpoint)
  static Future<Map<String, dynamic>> getMyLeaves(String staffId) async {
    return _get('/staff/hr/leave-balance/$staffId');
  }

  /// GET /staff/hr/replacement/pending — pending replacement requests for me
  static Future<List<dynamic>> getReplacementRequests() async {
    try {
      final result = await _get('/staff/hr/replacement/pending');
      return result['data'] as List? ?? result as List? ?? [];
    } catch (e) {
      debugPrint('StaffApiService.getReplacementRequests error: $e');
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
      if (message != null) 'message': message,
    });
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
      debugPrint('StaffApiService.getStaffList error: $e');
      return [];
    }
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
  /// When filePath is provided, uses multipart upload.
  static Future<Map<String, dynamic>> uploadInvestigation({
    required String phone,
    required String testType,
    String? result,
    String? notes,
    String? fileUrl,
    String? date,
    String? filePath,
    String? fileName,
  }) async {
    if (filePath != null) {
      // Multipart upload with file
      final fields = <String, String>{
        'phone': phone,
        'testType': testType,
        if (result != null) 'result': result,
        if (notes != null) 'notes': notes,
        if (date != null) 'date': date,
      };
      final files = [
        await http.MultipartFile.fromPath('file', filePath,
            filename: fileName)
      ];
      final resp = await ApiClient.multipart(
        '/staff/medical/investigations',
        fields: fields,
        files: files,
      );
      return _handle(resp);
    }

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
      if (notes != null) 'notes': notes,
    });
  }

  /// GET /pharmacy-orders/orders/queue — pharmacy order queue
  static Future<List<dynamic>> getPharmacyOrderQueue({String? status}) async {
    final resp = await _get('/pharmacy-orders/orders/queue', query: {
      if (status != null) 'status': status,
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
    final resp = await ApiClient.delete('/auth/staff/device/$deviceId');
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

  // ─── E-Prescriptions ──────────────────────────────────────────────────────

  /// POST /prescriptions/create — create structured e-prescription
  static Future<Map<String, dynamic>> createEPrescription(
      Map<String, dynamic> data, {File? photo}) async {
    if (photo != null) {
      // Multipart upload
      final fields = <String, String>{};
      data.forEach((key, value) {
        if (value != null) {
          fields[key] = value is String ? value : jsonEncode(value);
        }
      });
      final files = [
        await http.MultipartFile.fromPath('handwritten_photo', photo.path)
      ];
      final resp = await ApiClient.multipart(
        '/prescriptions/create',
        fields: fields,
        files: files,
      );
      return _handle(resp);
    }
    return _post('/prescriptions/create', data);
  }

  /// GET /prescriptions/:id — get prescription detail
  static Future<Map<String, dynamic>> getEPrescription(int id) async {
    return _get('/prescriptions/$id');
  }

  /// GET /prescriptions/all — list all prescriptions (admin/staff)
  static Future<List<dynamic>> getEPrescriptionsList({
    String? doctorId,
    String? fromDate,
    String? toDate,
  }) async {
    final data = await _get('/prescriptions/all', query: {
      if (doctorId != null) 'doctor_id': doctorId,
      if (fromDate != null) 'from_date': fromDate,
      if (toDate != null) 'to_date': toDate,
    });
    return data['data'] as List? ?? [];
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
  static Future<Map<String, dynamic>> getHealthRecordsByPhone(
      String phone) async {
    return _get('/records/health-records/$phone');
  }

  // ─── Investigations ──────────────────────────────────────────────────────

  /// GET /investigations/status/pending — pending investigations
  static Future<Map<String, dynamic>> getPendingInvestigations() async {
    return _get('/investigations/status/pending');
  }

  /// GET /investigations/doctor/:doctor_id — investigations for a doctor
  static Future<Map<String, dynamic>> getDoctorInvestigations(
      String doctorId) async {
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
    return _put(
        '/investigations/$investigationId/status', {'status': status});
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
    try {
      await ApiClient.post('/devices/register', body: {
        'phone': phone,
        'fcmToken': fcmToken,
        'deviceId': '${platform}_staff_${phone.hashCode}',
        'deviceName': 'VHHealth Staff App',
        'platform': platform,
      });
    } catch (e) {
      debugPrint('StaffApiService.registerDevice error: $e');
    }
  }

  // ─── Shift Management ───────────────────────────────────────────────────────

  /// GET /api/v1/staff/hr/shift — get current staff shift
  static Future<Map<String, dynamic>> getMyShift() async {
    return _get('/api/v1/staff/hr/shift');
  }

  // ─── Break Tracking ────────────────────────────────────────────────────────

  /// POST /api/v1/staff/attendance/:staffId/break/start — start a break
  static Future<Map<String, dynamic>> startBreak(String staffId) async {
    return _post('/api/v1/staff/attendance/$staffId/break/start', {});
  }

  /// POST /api/v1/staff/attendance/:staffId/break/end — end a break
  static Future<Map<String, dynamic>> endBreak(String staffId) async {
    return _post('/api/v1/staff/attendance/$staffId/break/end', {});
  }

  /// GET /api/v1/staff/attendance/:staffId/break/today — get today's breaks
  static Future<Map<String, dynamic>> getTodayBreaks(String staffId) async {
    return _get('/api/v1/staff/attendance/$staffId/break/today');
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
    return _post('/api/v1/staff/attendance/$staffId/dispute', {
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
        await _get('/api/v1/staff/attendance/$staffId/disputes');
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
    return _post('/api/v1/staff/hr/overtime/request', {
      'date': date,
      'extra_hours': extraHours,
      'reason': reason,
      'type': type,
    });
  }

  /// GET /api/v1/staff/hr/overtime — get my overtime requests
  static Future<List<dynamic>> getMyOvertimeRequests() async {
    final result = await _get('/api/v1/staff/hr/overtime');
    return result['data'] as List? ?? result as List? ?? [];
  }

  // ─── Incident Reports ────────────────────────────────────────────────────────

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

  // ─── Grievances ──────────────────────────────────────────────────────────────

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

  // ===== PAYROLL =====

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
  /// Returns annual tax summary (Form 16 basis) for the given financial year.
  static Future<Map<String, dynamic>> getMyTaxSummary({String? fy}) async {
    final query = fy != null ? {'fy': fy} : null;
    final result = await _get(
      '/api/v1/staff/hr/payroll/tax-summary',
      query: query,
    );
    return (result['data'] as Map<String, dynamic>?) ?? result;
  }

  /// GET /api/v1/staff/hr/payroll/advances
  /// Returns list of salary advances / loans for the current staff.
  static Future<List<dynamic>> getMyAdvances() async {
    final result = await _get('/api/v1/staff/hr/payroll/advances');
    return result['data'] as List? ?? (result is List ? result as List : []);
  }

  // ─── Compliance: Investment Declarations ───────────────────────────────────

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

  // ─── Compliance: Payslip Queries ──────────────────────────────────────────

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

  // ─── Appointment Workflow ─────────────────────────────────────────────────

  /// GET /appointments/queue/today — today's appointment queue
  static Future<List<dynamic>> getTodayAppointmentQueue({
    String? doctorId,
    String? department,
  }) async {
    final r = await _get('/appointments/queue/today', query: {
      if (doctorId != null) 'doctor_id': doctorId,
      if (department != null) 'department': department,
    });
    return r['data'] as List? ?? (r is List ? r as List : []);
  }

  /// GET /appointments/pending — pending appointments needing confirmation
  static Future<List<dynamic>> getPendingAppointments({
    String? fromDate,
    String? toDate,
    String? doctorId,
  }) async {
    final r = await _get('/appointments/pending', query: {
      if (fromDate != null) 'from_date': fromDate,
      if (toDate != null) 'to_date': toDate,
      if (doctorId != null) 'doctor_id': doctorId,
    });
    return r['data'] as List? ?? (r is List ? r as List : []);
  }

  /// POST /appointments/:id/confirm
  static Future<Map<String, dynamic>> confirmAppointment(
    int id,
    Map<String, dynamic> data,
  ) async {
    return _post('/appointments/$id/confirm', data);
  }

  /// POST /appointments/:id/no-show
  static Future<Map<String, dynamic>> markNoShow(int id) async {
    return _post('/appointments/$id/no-show', {});
  }

  /// POST /appointments/:id/complete
  static Future<Map<String, dynamic>> completeAppointmentStaff(
    int id, {
    String? notes,
  }) async {
    return _post('/appointments/$id/complete', {
      if (notes != null) 'notes': notes,
    });
  }

  /// POST /appointments/:id/cancel
  static Future<Map<String, dynamic>> cancelAppointmentStaff(
    int id, {
    String? reason,
  }) async {
    return _post('/appointments/$id/cancel', {
      if (reason != null) 'cancellation_reason': reason,
    });
  }

  /// POST /appointments/documents/upload — multipart upload of prescription/doc
  static Future<Map<String, dynamic>> uploadAppointmentDocument(
    int appointmentId,
    String filePath,
    String documentType, {
    String? notes,
    String? fileName,
  }) async {
    final fields = <String, String>{
      'appointment_id': appointmentId.toString(),
      'document_type': documentType,
      if (notes != null) 'notes': notes,
    };
    final files = [
      await http.MultipartFile.fromPath('file', filePath, filename: fileName)
    ];
    final resp = await ApiClient.multipart(
      '/appointments/documents/upload',
      fields: fields,
      files: files,
    );
    return _handle(resp);
  }

  // ── Walk-in Registration ──────────────────────────────────────────────────

  static Future<Map<String, dynamic>> registerWalkIn({
    required String patientPhone,
    String? patientName,
    int? doctorId,
    String? department,
    String? reason,
    String? appointmentTime,
  }) async {
    final body = <String, dynamic>{
      'patient_phone': patientPhone,
      if (patientName != null && patientName.isNotEmpty)
        'patient_name': patientName,
      if (doctorId != null) 'doctor_id': doctorId,
      if (department != null && department.isNotEmpty)
        'department': department,
      'reason': reason ?? 'Walk-in consultation',
      'appointment_time': appointmentTime ?? 'Walk-in',
    };
    return _post('/appointments/walk-in', body);
  }

  // ── Investigation Bookings ─────────────────────────────────────────────

  /// GET /investigations/bookings/queue
  static Future<Map<String, dynamic>> getInvestigationBookingQueue({
    String? status,
    String? collectionType,
    String? fromDate,
    String? toDate,
  }) async {
    final query = <String, String>{};
    if (status != null) query['status'] = status;
    if (collectionType != null) query['collection_type'] = collectionType;
    if (fromDate != null) query['from_date'] = fromDate;
    if (toDate != null) query['to_date'] = toDate;
    return _get('/investigations/bookings/queue', query: query);
  }

  /// GET /investigations/bookings/:id
  static Future<Map<String, dynamic>> getInvestigationBookingDetail(int id) {
    return _get('/investigations/bookings/$id');
  }

  /// GET /investigations/bookings/sla
  static Future<Map<String, dynamic>> getInvestigationBookingSLA({
    String? fromDate,
    String? toDate,
  }) async {
    final query = <String, String>{};
    if (fromDate != null) query['from_date'] = fromDate;
    if (toDate != null) query['to_date'] = toDate;
    return _get('/investigations/bookings/sla', query: query);
  }

  /// POST /investigations/bookings/:id/confirm
  static Future<Map<String, dynamic>> confirmInvestigationBooking(
    int id,
    Map<String, dynamic> data,
  ) {
    return _post('/investigations/bookings/$id/confirm', data);
  }

  /// POST /investigations/bookings/:id/dispatch
  static Future<Map<String, dynamic>> dispatchCollector(
    int id,
    Map<String, dynamic> data,
  ) {
    return _post('/investigations/bookings/$id/dispatch', data);
  }

  /// POST /investigations/bookings/:id/collected
  static Future<Map<String, dynamic>> markSamplesCollected(
    int id, {
    String? notes,
  }) {
    return _post('/investigations/bookings/$id/collected', {
      if (notes != null) 'collection_notes': notes,
    });
  }

  /// POST /investigations/bookings/:id/processing
  static Future<Map<String, dynamic>> startBookingProcessing(int id) {
    return _post('/investigations/bookings/$id/processing', {});
  }

  /// POST /investigations/bookings/:id/result (multipart)
  static Future<Map<String, dynamic>> uploadBookingResult(
    int id,
    String filePath, {
    String? notes,
    String? fileName,
  }) async {
    final fields = <String, String>{
      if (notes != null) 'result_notes': notes,
    };
    final files = [
      await http.MultipartFile.fromPath('file', filePath, filename: fileName)
    ];
    final resp = await ApiClient.multipart(
      '/investigations/bookings/$id/result',
      fields: fields,
      files: files,
    );
    return _handle(resp);
  }

  // ─── Delivery Tracking ──────────────────────────────────────────────────

  /// POST /delivery/location-update — send GPS location during delivery
  static Future<void> updateDeliveryLocation({
    required String orderType,
    required int orderId,
    required double lat,
    required double lng,
    double? accuracy,
    double? speed,
    double? heading,
    int? batteryLevel,
  }) async {
    await _post('/delivery/location-update', {
      'order_type': orderType,
      'order_id': orderId,
      'lat': lat,
      'lng': lng,
      if (accuracy != null) 'accuracy': accuracy,
      if (speed != null) 'speed': speed,
      if (heading != null) 'heading': heading,
      if (batteryLevel != null) 'battery_level': batteryLevel,
    });
  }

  /// POST /delivery/stop-tracking — stop location sharing
  static Future<void> stopDeliveryTracking({
    required String orderType,
    required int orderId,
  }) async {
    await _post('/delivery/stop-tracking', {
      'order_type': orderType,
      'order_id': orderId,
    });
  }
}
