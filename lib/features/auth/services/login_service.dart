import '../../../core/services/auth_service.dart';

class LoginService {
  /// Attempt staff login with employee ID + password.
  /// Returns staff data map on success, throws on failure.
  static Future<Map<String, dynamic>> loginWithPassword({
    required String employeeId,
    required String password,
  }) async {
    if (employeeId.trim().isEmpty) throw Exception('Employee ID is required');
    if (password.isEmpty) throw Exception('Password is required');
    return AuthService.login(
        employeeId: employeeId.trim(), password: password);
  }

  /// Attempt staff login with employee ID + PIN.
  static Future<Map<String, dynamic>> loginWithPin({
    required String employeeId,
    required String pin,
  }) async {
    if (employeeId.trim().isEmpty) throw Exception('Employee ID is required');
    if (pin.length < 4) throw Exception('PIN must be at least 4 digits');
    return AuthService.pinLogin(
        employeeId: employeeId.trim(), pin: pin);
  }

  static Future<void> logout() => AuthService.logout();
}
