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
    required double latitude,
    required double longitude,
    String? wifiSSID,
    String? wifiMAC,
  }) => AttendanceApiService.markAttendanceWithLocation(
        staffId: staffId, action: action,
        latitude: latitude, longitude: longitude,
        wifiSSID: wifiSSID, wifiMAC: wifiMAC);

  static Future<Map<String, dynamic>> getAttendanceCalendar({
    String? staffId,
    int? month,
    int? year,
  }) => AttendanceApiService.getAttendanceCalendar(staffId: staffId, month: month, year: year);

  static Future<Map<String, dynamic>> requestRegularization({
    required String staffId,
    required String date,
    required String reason,
    String? checkIn,
    String? checkOut,
  }) => AttendanceApiService.requestRegularization(
        staffId: staffId, date: date, reason: reason,
        checkIn: checkIn, checkOut: checkOut);

  static Future<Map<String, dynamic>> getAttendance(
    String staffId, {
    String? from,
    String? to,
  }) => AttendanceApiService.getAttendance(staffId, from: from, to: to);

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
    String? substituteId,
  }) => LeaveApiService.applyLeave(
        staffId: staffId, leaveType: leaveType,
        startDate: startDate, endDate: endDate,
        reason: reason, substituteId: substituteId);

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
    required String response,
  }) => LeaveApiService.respondToReplacement(requestId: requestId, response: response);

  // ── HrApiService ─────────────────────────────────────────────────────────
  static Future<Map<String, dynamic>> getHRDashboard(String staffId) =>
      HrApiService.getHRDashboard(staffId);

  static Future<List<dynamic>> getStaffList({String? department}) =>
      HrApiService.getStaffList(department: department);

  static Future<Map<String, dynamic>> getProfile(String identifier) =>
      HrApiService.getProfile(identifier);

  static Future<Map<String, dynamic>> updateProfile(
    String staffId, {
    String? name,
    String? email,
    String? phone,
    String? address,
  }) => HrApiService.updateProfile(staffId, name: name, email: email, phone: phone, address: address);

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
    int id, {
    String? deliveryPersonId,
  }) => PharmacyApiService.dispatchPharmacyOrder(id, deliveryPersonId: deliveryPersonId);

  static Future<Map<String, dynamic>> markPharmacyDelivered(int id) =>
      PharmacyApiService.markPharmacyDelivered(id);

  static Future<Map<String, dynamic>> cancelPharmacyOrder(
    int id, {
    String? reason,
  }) => PharmacyApiService.cancelPharmacyOrder(id, reason: reason);

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
    String? doctorId,
  }) => ScheduleApiService.updateAppointmentStatus(
        appointmentId, status, notes: notes, doctorId: doctorId);

  // ── Auth/Device (HrApiService) ───────────────────────────────────────────
  static Future<Map<String, dynamic>> setupPin({
    required String staffId,
    required String pin,
  }) => HrApiService.setupPin(staffId: staffId, pin: pin);

  static Future<Map<String, dynamic>> toggleBiometric({
    required String staffId,
    required bool enabled,
  }) => HrApiService.toggleBiometric(staffId: staffId, enabled: enabled);

  static Future<Map<String, dynamic>> quickLogin({
    required String staffId,
    required String pin,
  }) => HrApiService.quickLogin(staffId: staffId, pin: pin);

  static Future<Map<String, dynamic>> registerTrustedDevice({
    required String staffId,
    required String deviceId,
    required String deviceName,
  }) => HrApiService.registerTrustedDevice(
        staffId: staffId, deviceId: deviceId, deviceName: deviceName);

  static Future<Map<String, dynamic>> verifyDevice({
    required String staffId,
    required String deviceId,
  }) => HrApiService.verifyDevice(staffId: staffId, deviceId: deviceId);

  static Future<Map<String, dynamic>> getAuthProfile() =>
      HrApiService.getAuthProfile();

  static Future<Map<String, dynamic>> getRegisteredDevices() =>
      HrApiService.getRegisteredDevices();
}
