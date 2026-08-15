import '../../../core/services/auth_service.dart';

class LoginService {
  /// Matches employee IDs like EMP-001, EMP-1234, STAFF-01, DR-001, etc.
  static final _employeeIdPattern = RegExp(r'^[A-Z]{2,6}-\d{1,6}$');

  static const int _minPasswordLength = 8;

  /// Validate that an employee ID has the expected format.
  static String? validateEmployeeId(String? value) {
    if (value == null || value.trim().isEmpty) {
      return 'Employee ID is required';
    }
    final id = value.trim().toUpperCase();
    if (!_employeeIdPattern.hasMatch(id)) {
      return 'Invalid Employee ID format (expected e.g. EMP-001)';
    }
    return null;
  }

  /// Validate password meets minimum requirements.
  static String? validatePassword(String? value) {
    if (value == null || value.isEmpty) {
      return 'Password is required';
    }
    if (value.length < _minPasswordLength) {
      return 'Password must be at least $_minPasswordLength characters';
    }
    return null;
  }

  /// Attempt staff login with employee ID + password.
  /// Returns staff data map on success, throws on failure.
  static Future<Map<String, dynamic>> loginWithPassword({
    required String employeeId,
    required String password,
    bool rememberEmployeeId = true,
  }) async {
    final idError = validateEmployeeId(employeeId);
    if (idError != null) throw Exception(idError);

    final pwError = validatePassword(password);
    if (pwError != null) throw Exception(pwError);

    return AuthService.login(
      employeeId: employeeId.trim().toUpperCase(),
      password: password,
      rememberEmployeeId: rememberEmployeeId,
    );
  }

  /// Attempt staff login with employee ID + PIN.
  static Future<Map<String, dynamic>> loginWithPin({
    required String employeeId,
    required String pin,
    bool rememberEmployeeId = true,
  }) async {
    final idError = validateEmployeeId(employeeId);
    if (idError != null) throw Exception(idError);

    if (pin.length < 4) throw Exception('PIN must be at least 4 digits');
    if (!RegExp(r'^\d+$').hasMatch(pin)) {
      throw Exception('PIN must contain only digits');
    }
    return AuthService.pinLogin(
      employeeId: employeeId.trim().toUpperCase(),
      pin: pin,
      rememberEmployeeId: rememberEmployeeId,
    );
  }

  static Future<List<StaffSsoProvider>> discoverStaffSsoProviders() {
    return AuthService.discoverStaffSsoProviders();
  }

  static Future<Map<String, dynamic>> loginWithStaffSso(
    StaffSsoProvider provider, {
    bool rememberEmployeeId = true,
  }) {
    return AuthService.loginWithStaffSso(
      provider,
      rememberEmployeeId: rememberEmployeeId,
    );
  }

  static Future<StaffLogoutResult> logout() => AuthService.logout();
}
