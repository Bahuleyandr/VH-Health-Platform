import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import '../config/api_config.dart';

class AuthService {
  static const _storage = FlutterSecureStorage();

  /// Staff login with employee ID + password
  static Future<Map<String, dynamic>> login({
    required String employeeId,
    required String password,
  }) async {
    final response = await http.post(
      Uri.parse('${ApiConfig.baseUrl}/auth/staff/login'),
      headers: ApiConfig.jsonHeaders,
      body: jsonEncode({'employeeId': employeeId, 'password': password}),
    );

    final data = jsonDecode(response.body);
    if (response.statusCode == 200 && data['success'] == true) {
      final token = data['data']?['token'] ?? data['data']?['jwt'];
      if (token != null) {
        await ApiConfig.saveJwt(token);
        await ApiConfig.saveEmployeeId(employeeId);

        final staffId = data['data']?['staff']?['_id'] ??
            data['data']?['staff']?['id'] ??
            data['data']?['uid'];
        if (staffId != null) await ApiConfig.saveStaffId(staffId.toString());
      }
      return data['data'] ?? data;
    }
    throw Exception(data['message'] ?? 'Login failed');
  }

  /// Staff PIN login
  static Future<Map<String, dynamic>> pinLogin({
    required String employeeId,
    required String pin,
  }) async {
    final response = await http.post(
      Uri.parse('${ApiConfig.baseUrl}/auth/staff/login-pin'),
      headers: ApiConfig.jsonHeaders,
      body: jsonEncode({'employeeId': employeeId, 'pin': pin}),
    );

    final data = jsonDecode(response.body);
    if (response.statusCode == 200 && data['success'] == true) {
      final token = data['data']?['token'] ?? data['data']?['jwt'];
      if (token != null) {
        await ApiConfig.saveJwt(token);
        await ApiConfig.saveEmployeeId(employeeId);

        final staffId = data['data']?['staff']?['_id'] ??
            data['data']?['staff']?['id'] ??
            data['data']?['uid'];
        if (staffId != null) await ApiConfig.saveStaffId(staffId.toString());
      }
      return data['data'] ?? data;
    }
    throw Exception(data['message'] ?? 'PIN login failed');
  }

  /// Logout — clears all local credentials
  static Future<void> logout() async {
    try {
      final headers = await ApiConfig.authenticatedHeaders();
      await http.post(
        Uri.parse('${ApiConfig.baseUrl}/auth/staff/logout'),
        headers: headers,
        body: jsonEncode({}),
      );
    } catch (_) {
      // Best effort
    } finally {
      await ApiConfig.clearAll();
    }
  }

  static Future<bool> isLoggedIn() => ApiConfig.isLoggedIn();
  static Future<String?> getStaffId() => ApiConfig.getStaffId();
  static Future<String?> getEmployeeId() => ApiConfig.getEmployeeId();

  static Future<Map<String, String>?> getSavedCredentials() async {
    final employeeId = await _storage.read(key: 'employee_id');
    return employeeId != null ? {'employeeId': employeeId} : null;
  }
}
