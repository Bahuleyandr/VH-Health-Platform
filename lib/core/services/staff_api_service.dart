// Backward-compatible facade.
// All callers using StaffApiService.method() continue to work.
// New code should import the domain-specific services directly:
//   - AttendanceApiService  (attendance_api_service.dart)
//   - LeaveApiService       (leave_api_service.dart)
//   - HrApiService          (hr_api_service.dart)
//   - MedicalApiService     (medical_api_service.dart)
//   - PharmacyApiService    (pharmacy_api_service.dart)
//   - ScheduleApiService    (schedule_api_service.dart)

export 'attendance_api_service.dart';
export 'leave_api_service.dart';
export 'hr_api_service.dart';
export 'medical_api_service.dart';
export 'pharmacy_api_service.dart';
export 'schedule_api_service.dart';

import 'attendance_api_service.dart';
import 'leave_api_service.dart';
import 'hr_api_service.dart';
import 'medical_api_service.dart';
import 'pharmacy_api_service.dart';
import 'schedule_api_service.dart';

// ignore_for_file: deprecated_member_use_from_same_package

/// @deprecated Use domain-specific services directly.
/// This class is a thin facade forwarding to the decomposed services.
class StaffApiService {
  StaffApiService._();

  // ── AttendanceApiService ─────────────────────────────────────────────────
  static Future<Map<String, dynamic>> markAttendance({
    required String staffId,
    required String action,
    Map<String, dynamic>? location,
  }) => AttendanceApiService.markAttendance(staffId: staffId, action: action, location: location);

  static Future<Map<String, dynamic>> markAttendanceWithLocation({
    required String staffId,
    required String action,
    required Map<String, dynamic> location,
  }) => AttendanceApiService.markAttendanceWithLocation(
        staffId: staffId, action: action, location: location);

  static Future<Map<String, dynamic>> getAttendanceCalendar({
    required String staffId,
    required int year,
    required int month,
  }) => AttendanceApiService.getAttendanceCalendar(staffId: staffId, year: year, month: month);

  static Future<Map<String, dynamic>> requestRegularization({
    required String staffId,
    required String date,
    required String reason,
    String? checkInTime,
    String? checkOutTime,
  }) => AttendanceApiService.requestRegularization(
        staffId: staffId, date: date, reason: reason,
        checkInTime: checkInTime, checkOutTime: checkOutTime);

  static Future<Map<String, dynamic>> getAttendance(
    String staffId, {
    String? startDate,
    String? endDate,
    int page = 1,
    int limit = 30,
  }) => AttendanceApiService.getAttendance(staffId, startDate: startDate, endDate: endDate, page: page, limit: limit);

  static Future<Map<String, dynamic>> getAttendanceStatus() =>
      AttendanceApiService.getAttendanceStatus();

  static Future<Map<String, dynamic>> getTodayAttendance() =>
      AttendanceApiService.getTodayAttendance();

  // ── LeaveApiService ──────────────────────────────────────────────────────
  static Future<Map<String, dynamic>> getLeaveBalance(String staffId) =>
      LeaveApiService.getLeaveBalance(staffId);

  static Future<Map<String, dynamic>> applyLeave({
    required String staffId,
    required String leaveType,
    required String startDate,
    required String endDate,
    required String reason,
    String? emergencyContact,
  }) => LeaveApiService.applyLeave(
        staffId: staffId, leaveType: leaveType,
        startDate: startDate, endDate: endDate,
        reason: reason, emergencyContact: emergencyContact);

  static Future<Map<String, dynamic>> applyForLeaveWithReplacement({
    required String staffId,
    required String leaveType,
    required String startDate,
    required String endDate,
    required String reason,
    required String replacementStaffId,
  }) => LeaveApiService.applyForLeaveWithReplacement(
        staffId: staffId, leaveType: leaveType,
        startDate: startDate, endDate: endDate,
        reason: reason, replacementStaffId: replacementStaffId);

  static Future<Map<String, dynamic>> getMyLeaves(String staffId) =>
      LeaveApiService.getMyLeaves(staffId);

  static Future<List<dynamic>> getReplacementRequests() =>
      LeaveApiService.getReplacementRequests();

  static Future<Map<String, dynamic>> respondToReplacement({
    required String requestId,
    required String status,
    String? message,
  }) => LeaveApiService.respondToReplacement(requestId: requestId, status: status, message: message);

  // ── HrApiService ─────────────────────────────────────────────────────────
  static Future<Map<String, dynamic>> getHRDashboard(String staffId) =>
      HrApiService.getHRDashboard(staffId);

  static Future<List<dynamic>> getStaffList({String? department}) =>
      HrApiService.getStaffList(department: department);

  static Future<Map<String, dynamic>> getProfile(String identifier) =>
      HrApiService.getProfile(identifier);

  static Future<Map<String, dynamic>> updateProfile(
    String staffId, Map<String, dynamic> updates,
  ) => HrApiService.updateProfile(staffId, updates);

  static Future<Map<String, dynamic>> markAllNotificationsRead() =>
      HrApiService.markAllNotificationsRead();

  static Future<Map<String, dynamic>> registerDevice(
    String token, {
    String platform = 'android',
  }) => HrApiService.registerDevice(token, platform: platform);

  // ── MedicalApiService ────────────────────────────────────────────────────
  static Future<Map<String, dynamic>> uploadConsultation({
    required String appointmentId,
    required Map<String, dynamic> data,
  }) => MedicalApiService.uploadConsultation(appointmentId: appointmentId, data: data);

  static Future<Map<String, dynamic>> uploadInvestigation({
    required String investigationId,
    required Map<String, dynamic> results,
  }) => MedicalApiService.uploadInvestigation(investigationId: investigationId, results: results);

  static Future<Map<String, dynamic>> getHealthRecords(String phone) =>
      MedicalApiService.getHealthRecords(phone);

  static Future<Map<String, dynamic>> updateDeliveryLocation(
    String orderId,
    double lat,
    double lng,
  ) => MedicalApiService.updateDeliveryLocation(orderId, lat, lng);

  static Future<Map<String, dynamic>> stopDeliveryTracking(String orderId) =>
      MedicalApiService.stopDeliveryTracking(orderId);

  // ── PharmacyApiService ───────────────────────────────────────────────────
  static Future<Map<String, dynamic>> updatePharmacyOrder({
    required int id,
    required String status,
    String? notes,
  }) => PharmacyApiService.updatePharmacyOrder(id: id, status: status, notes: notes);

  static Future<List<dynamic>> getPharmacyOrderQueue({String? status}) =>
      PharmacyApiService.getPharmacyOrderQueue(status: status);

  static Future<Map<String, dynamic>> confirmPharmacyOrder(int id) =>
      PharmacyApiService.confirmPharmacyOrder(id);

  static Future<Map<String, dynamic>> markPharmacyPreparing(int id) =>
      PharmacyApiService.markPharmacyPreparing(id);

  static Future<Map<String, dynamic>> dispatchPharmacyOrder(
    int id, Map<String, dynamic> data,
  ) => PharmacyApiService.dispatchPharmacyOrder(id, data);

  static Future<Map<String, dynamic>> markPharmacyDelivered(int id) =>
      PharmacyApiService.markPharmacyDelivered(id);

  static Future<Map<String, dynamic>> cancelPharmacyOrder(
    int id, String reason,
  ) => PharmacyApiService.cancelPharmacyOrder(id, reason);

  // ── ScheduleApiService ───────────────────────────────────────────────────
  static Future<Map<String, dynamic>> fetchCampusConfig() =>
      ScheduleApiService.fetchCampusConfig();

  static Future<Map<String, dynamic>> getMyShift() =>
      ScheduleApiService.getMyShift();

  static Future<Map<String, dynamic>> getAppointments({
    String? doctorId,
    String? date,
    String? status,
  }) => ScheduleApiService.getAppointments(doctorId: doctorId, date: date, status: status);

  static Future<Map<String, dynamic>> updateAppointmentStatus(
    String appointmentId,
    String status, {
    String? notes,
  }) => ScheduleApiService.updateAppointmentStatus(
        appointmentId, status, notes: notes);

  // ── Auth/Device (HrApiService) ───────────────────────────────────────────
  static Future<Map<String, dynamic>> setupPin({
    required String employeeId,
    required String pin,
  }) => HrApiService.setupPin(employeeId: employeeId, pin: pin);

  static Future<Map<String, dynamic>> toggleBiometric({
    required bool enabled,
    required String deviceToken,
  }) => HrApiService.toggleBiometric(enabled: enabled, deviceToken: deviceToken);

  static Future<Map<String, dynamic>> quickLogin({
    required String employeeId,
    String? pin,
    String? biometricToken,
    String? deviceToken,
  }) => HrApiService.quickLogin(employeeId: employeeId, pin: pin, biometricToken: biometricToken, deviceToken: deviceToken);

  static Future<Map<String, dynamic>> registerTrustedDevice({
    required String deviceToken,
    required String deviceName,
    required String platform,
  }) => HrApiService.registerTrustedDevice(
        deviceToken: deviceToken, deviceName: deviceName, platform: platform);

  static Future<Map<String, dynamic>> verifyDevice({
    required String deviceToken,
  }) => HrApiService.verifyDevice(deviceToken: deviceToken);

  static Future<Map<String, dynamic>> getAuthProfile() =>
      HrApiService.getAuthProfile();

  static Future<Map<String, dynamic>> getRegisteredDevices() =>
      HrApiService.getRegisteredDevices();
}
