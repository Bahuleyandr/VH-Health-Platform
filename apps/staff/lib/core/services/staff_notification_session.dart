import 'package:vhhealth_core/services/secure_storage.dart';

import '../config/api_config.dart';

abstract interface class NotificationSessionPersistence {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class _SecureNotificationSessionPersistence
    implements NotificationSessionPersistence {
  final _storage = VHSecureStorage.instance;

  @override
  Future<void> delete(String key) => _storage.delete(key: key);

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);
}

class StaffNotificationSessionStore {
  StaffNotificationSessionStore({NotificationSessionPersistence? persistence})
    : _persistence = persistence ?? _SecureNotificationSessionPersistence();

  static final instance = StaffNotificationSessionStore();
  static const _activeKey = 'staff_notification_session_active';

  final NotificationSessionPersistence _persistence;

  Future<void> markActiveFor(String staffUid) {
    final normalized = staffUid.trim();
    if (normalized.isEmpty) {
      throw ArgumentError.value(staffUid, 'staffUid', 'must not be empty');
    }
    return _persistence.write(_activeKey, normalized);
  }

  Future<void> markInactive() => _persistence.delete(_activeKey);

  Future<bool> isActiveFor(String? staffUid) async {
    final normalized = staffUid?.trim();
    if (normalized == null || normalized.isEmpty) return false;
    return await _persistence.read(_activeKey) == normalized;
  }
}

Future<bool> mayPresentStaffPush({
  StaffNotificationSessionStore? sessionStore,
  Future<bool> Function()? isAuthenticated,
  Future<String?> Function()? staffUidLoader,
}) async {
  if (!await (isAuthenticated ?? ApiConfig.isLoggedIn)()) return false;
  final staffUid = await (staffUidLoader ?? ApiConfig.getStaffUid)();
  return (sessionStore ?? StaffNotificationSessionStore.instance).isActiveFor(
    staffUid,
  );
}
