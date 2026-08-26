// Staff-specific API configuration.
//
// Re-exports core's [ApiConfig] for baseUrl, apiKey, jsonHeaders, etc.
// Adds staff-specific JWT and credential storage using separate keys
// so staff and patient tokens never collide.
import 'dart:convert';

import 'package:vhhealth_core/config/api_config.dart' as core;
import 'package:vhhealth_core/services/secure_storage.dart';

export 'package:vhhealth_core/config/api_config.dart' hide ApiConfig;

class StaffJwtClaims {
  const StaffJwtClaims({
    required this.staffUid,
    required this.tenantId,
    required this.tokenEpoch,
    required this.sessionEpoch,
    required this.expiresAt,
  });

  final String staffUid;
  final String tenantId;
  final String tokenEpoch;
  final String sessionEpoch;
  final DateTime expiresAt;
}

class ApiConfig {
  ApiConfig._();

  // All credential reads/writes route through the centralized encrypted store.
  static final _storage = VHSecureStorage.instance;
  static const _staffJwtKey = 'staff_jwt';
  static const _coreJwtKey = 'jwt';

  // ── Delegate shared config to core ─────────────────────────────────────
  static String get baseUrl => core.ApiConfig.baseUrl;
  static String get apiKey => core.ApiConfig.apiKey;
  static Map<String, String> get jsonHeaders => core.ApiConfig.jsonHeaders;

  // ── Staff-specific authenticated headers (uses staff_jwt key) ──────────
  static Future<Map<String, String>> authenticatedHeaders() async {
    final jwt =
        await _storage.read(key: _staffJwtKey) ??
        await _storage.read(key: _coreJwtKey);
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      if (jwt != null) 'Authorization': 'Bearer $jwt',
    };
  }

  // ── Staff credential storage ───────────────────────────────────────────
  static Future<void> saveJwt(String jwt) async {
    await _storage.write(key: _staffJwtKey, value: jwt);
    await _storage.write(key: _coreJwtKey, value: jwt);
  }

  static Future<void> saveStaffId(String staffId) async {
    await _storage.write(key: 'staff_id', value: staffId);
  }

  static Future<String?> getStaffId() async {
    return await _storage.read(key: 'staff_id');
  }

  static Future<void> saveStaffUid(String staffUid) async {
    await _storage.write(key: 'staff_uid', value: staffUid);
  }

  static Future<String?> getStaffUid() async {
    final stored = await _storage.read(key: 'staff_uid');
    if (stored != null && stored.trim().isNotEmpty) return stored.trim();

    final jwt =
        await _storage.read(key: _staffJwtKey) ??
        await _storage.read(key: _coreJwtKey);
    final decoded = _staffUidFromJwt(jwt);
    if (decoded != null && decoded.isNotEmpty) {
      await saveStaffUid(decoded);
      return decoded;
    }
    return null;
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

  static Future<void> saveDepartment(String department) async {
    await _storage.write(key: 'staff_department', value: department);
  }

  static Future<String?> getDepartment() async {
    return await _storage.read(key: 'staff_department');
  }

  static Future<void> savePhone(String phone) async {
    await _storage.write(key: 'staff_phone', value: phone);
  }

  static Future<String?> getPhone() async {
    return await _storage.read(key: 'staff_phone');
  }

  /// Server-reported specialty gate modes (feature id ->
  /// 'off' | 'report' | 'enforce'), persisted from the last successful
  /// GET /rbac/policy fetch. A null snapshot is authoritative and deletes an
  /// older value so a retired enforce mode cannot survive a server downgrade.
  static Future<void> saveSpecialtyGateModes(Map<String, String>? modes) async {
    if (modes == null) {
      await _storage.delete(key: 'specialty_gate_modes');
      return;
    }
    await _storage.write(key: 'specialty_gate_modes', value: jsonEncode(modes));
  }

  static Future<Map<String, String>?> getSpecialtyGateModes() async {
    final raw = await _storage.read(key: 'specialty_gate_modes');
    if (raw == null || raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      return decoded.map(
        (key, value) => MapEntry(key.toString(), value.toString()),
      );
    } catch (_) {
      return null;
    }
  }

  static Future<void> clearSessionIdentity() async {
    const keys = [
      // Shared core auth keys.
      _coreJwtKey,
      _staffJwtKey,
      'refreshToken',
      'userPhone',
      'userRole',
      'employeeId',
      'staffId',
      // Staff-app auth/profile keys.
      'staff_id',
      'staff_uid',
      'employee_id',
      'staff_role',
      'staff_department',
      'staff_phone',
      'specialty_gate_modes',
    ];
    for (final key in keys) {
      await _storage.delete(key: key);
    }
  }

  static Future<bool> isLoggedIn() async {
    try {
      if (await getStaffJwtClaims() == null) {
        await _storage.delete(key: _staffJwtKey);
        await _storage.delete(key: _coreJwtKey);
        return false;
      }
      return true;
    } catch (_) {
      // SecureStorage corruption / keystore error → log out for safety.
      try {
        await _storage.delete(key: _staffJwtKey);
        await _storage.delete(key: _coreJwtKey);
      } catch (_) {}
      return false;
    }
  }

  static Future<StaffJwtClaims?> getStaffJwtClaims({DateTime? now}) async {
    try {
      final jwt =
          await _storage.read(key: _staffJwtKey) ??
          await _storage.read(key: _coreJwtKey);
      if (jwt == null || jwt.isEmpty) return null;
      final parts = jwt.split('.');
      if (parts.length != 3 || parts.any((part) => part.isEmpty)) return null;
      final payload = jsonDecode(
        utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))),
      );
      if (payload is! Map<String, dynamic>) return null;
      final staffUid = _staffUidFromPayload(payload);
      final tenantId = (payload['tenant_id'] ?? payload['tenantId'])
          ?.toString()
          .trim();
      final tokenEpoch = payload['token_epoch']?.toString().trim();
      final sessionEpoch = payload['sessionFamilyId']?.toString().trim();
      final exp = num.tryParse(payload['exp']?.toString() ?? '');
      if (staffUid == null ||
          tenantId == null ||
          tenantId.isEmpty ||
          tokenEpoch == null ||
          tokenEpoch.isEmpty ||
          sessionEpoch == null ||
          sessionEpoch.isEmpty ||
          exp == null) {
        return null;
      }
      final expiresAt = DateTime.fromMillisecondsSinceEpoch(
        exp.toInt() * 1000,
        isUtc: true,
      );
      if (!expiresAt.isAfter((now ?? DateTime.now()).toUtc())) return null;
      return StaffJwtClaims(
        staffUid: staffUid,
        tenantId: tenantId,
        tokenEpoch: tokenEpoch,
        sessionEpoch: sessionEpoch,
        expiresAt: expiresAt,
      );
    } catch (_) {
      return null;
    }
  }

  static String? _staffUidFromJwt(String? jwt) {
    try {
      if (jwt == null || jwt.isEmpty) return null;
      final parts = jwt.split('.');
      if (parts.length != 3 || parts[1].isEmpty) return null;
      final payload = jsonDecode(
        utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))),
      );
      if (payload is! Map<String, dynamic>) return null;
      return _staffUidFromPayload(payload);
    } catch (_) {
      return null;
    }
  }

  static String? _staffUidFromPayload(Map<String, dynamic> payload) {
    final staff = payload['staff'];
    for (final key in ['uid', 'user_uid', 'staff_uid', 'sub']) {
      final value = payload[key] ?? (staff is Map ? staff[key] : null);
      if (value != null && value.toString().trim().isNotEmpty) {
        return value.toString().trim();
      }
    }
    return null;
  }
}
