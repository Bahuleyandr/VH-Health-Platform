import 'package:flutter/foundation.dart';

import '../config/api_config.dart';
import 'api_client.dart';

class DiagnosticsCheck {
  final String id;
  final String label;
  final String path;
  final bool ok;
  final int? statusCode;
  final String message;
  final Map<String, dynamic> data;

  const DiagnosticsCheck({
    required this.id,
    required this.label,
    required this.path,
    required this.ok,
    required this.statusCode,
    required this.message,
    required this.data,
  });
}

class StaffDiagnosticsSnapshot {
  final String apiBaseUrl;
  final String role;
  final String? staffId;
  final String? staffUid;
  final String? employeeId;
  final DateTime generatedAt;
  final List<DiagnosticsCheck> checks;

  const StaffDiagnosticsSnapshot({
    required this.apiBaseUrl,
    required this.role,
    required this.staffId,
    required this.staffUid,
    required this.employeeId,
    required this.generatedAt,
    required this.checks,
  });

  DiagnosticsCheck? check(String id) {
    for (final item in checks) {
      if (item.id == id) return item;
    }
    return null;
  }

  bool get allRequiredOk => checks
      .where((item) => item.id != 'backend_ready')
      .every((item) => item.ok);
}

class DiagnosticsApiService {
  DiagnosticsApiService._();

  static Future<StaffDiagnosticsSnapshot> load() async {
    final checks = await Future.wait([
      _check(
        id: 'backend_ping',
        label: 'Backend liveness',
        path: '/health/ping',
        auth: false,
      ),
      _check(
        id: 'backend_version',
        label: 'Backend version',
        path: '/health/version',
        auth: false,
      ),
      _check(
        id: 'backend_ready',
        label: 'Backend readiness',
        path: '/health/ready',
        auth: false,
      ),
      _check(
        id: 'role_policy',
        label: 'Role policy graph',
        path: '/rbac/policy',
      ),
      _check(
        id: 'staff_profile',
        label: 'Authenticated staff profile',
        path: '/auth/staff/profile',
      ),
    ]);

    return StaffDiagnosticsSnapshot(
      apiBaseUrl: ApiConfig.baseUrl,
      role: await ApiConfig.getRole(),
      staffId: await ApiConfig.getStaffId(),
      staffUid: await ApiConfig.getStaffUid(),
      employeeId: await ApiConfig.getEmployeeId(),
      generatedAt: DateTime.now(),
      checks: checks,
    );
  }

  static Future<DiagnosticsCheck> _check({
    required String id,
    required String label,
    required String path,
    bool auth = true,
  }) async {
    try {
      final response = await ApiClient.get(
        path,
        auth: auth,
        timeout: const Duration(seconds: 12),
      );
      final data = diagnosticsMapFromResponse(response);
      return DiagnosticsCheck(
        id: id,
        label: label,
        path: path,
        ok: response.isSuccess,
        statusCode: response.statusCode,
        message: response.message ?? (response.isSuccess ? 'OK' : 'Failed'),
        data: data,
      );
    } catch (e) {
      return DiagnosticsCheck(
        id: id,
        label: label,
        path: path,
        ok: false,
        statusCode: null,
        message: e.toString().replaceFirst('Exception: ', ''),
        data: const {},
      );
    }
  }
}

@visibleForTesting
Map<String, dynamic> diagnosticsMapFromResponse(ApiResponse response) {
  final data = response.data;
  if (data is Map) return Map<String, dynamic>.from(data);
  final raw = response.raw;
  if (raw is Map) {
    final rawMap = Map<String, dynamic>.from(raw);
    final nested = rawMap['data'];
    if (nested is Map) return Map<String, dynamic>.from(nested);
    return rawMap;
  }
  if (data == null) return const {};
  return <String, dynamic>{'data': data};
}
