import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class ApiConfig {
  ApiConfig._();
  static const String baseUrl = 'https://api.vhhealth.app/api/v1';
  static const String apiKey = 'vhhealth123';
  static const _storage = FlutterSecureStorage();

  static Map<String, String> get jsonHeaders => {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      };

  static Future<Map<String, String>> authenticatedHeaders() async {
    final jwt = await _storage.read(key: 'staff_jwt');
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      if (jwt != null) 'Authorization': 'Bearer $jwt',
    };
  }

  static Future<void> saveJwt(String jwt) async {
    await _storage.write(key: 'staff_jwt', value: jwt);
  }

  static Future<void> saveStaffId(String staffId) async {
    await _storage.write(key: 'staff_id', value: staffId);
  }

  static Future<String?> getStaffId() async {
    return await _storage.read(key: 'staff_id');
  }

  static Future<void> saveEmployeeId(String employeeId) async {
    await _storage.write(key: 'employee_id', value: employeeId);
  }

  static Future<String?> getEmployeeId() async {
    return await _storage.read(key: 'employee_id');
  }

  static Future<void> saveRole(String role) async {
    await _storage.write(key: 'staff_role', value: role);
  }

  static Future<String> getRole() async {
    return await _storage.read(key: 'staff_role') ?? 'GENERAL_STAFF';
  }

  static Future<void> clearAll() async {
    await _storage.deleteAll();
  }

  static Future<bool> isLoggedIn() async {
    final jwt = await _storage.read(key: 'staff_jwt');
    return jwt != null && jwt.isNotEmpty;
  }
}
