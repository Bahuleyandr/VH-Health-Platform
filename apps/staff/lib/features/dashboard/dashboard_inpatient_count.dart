import '../../core/config/role_config.dart';

bool dashboardInpatientCountUsesCommandBoard(StaffRole role) =>
    role == StaffRole.doctor ||
    role == StaffRole.dutyDoctor ||
    role == StaffRole.medicalSuperintendent ||
    role == StaffRole.nurse ||
    role == StaffRole.nursingIncharge ||
    role == StaffRole.nursingSuperintendent ||
    role.isAdminTier;

String dashboardInpatientCountEndpointForRole(StaffRole role) =>
    dashboardInpatientCountUsesCommandBoard(role)
    ? '/admissions/command-board'
    : '/admissions/occupancy';

Map<String, String>? dashboardInpatientCountQueryForRole(StaffRole role) =>
    dashboardInpatientCountUsesCommandBoard(role)
    ? const {'status': 'active', 'limit': '1'}
    : null;

int dashboardInpatientCountFromRaw(Object? raw) {
  final root = _asMap(raw);
  if (root == null) return 0;
  final payload = root['data'];
  final data = _asMap(payload);

  final board = _asMap(data?['board']) ?? _asMap(root['board']);
  final counts =
      _asMap(board?['counts']) ??
      _asMap(data?['counts']) ??
      _asMap(root['counts']);
  final scopedTotal = _asInt(counts?['total']);
  if (scopedTotal != null) return scopedTotal;

  final dataTotal = _asInt(data?['total']);
  if (dataTotal != null) return dataTotal;

  final meta = _asMap(root['meta']);
  final pagination = _asMap(meta?['pagination']);
  final pagedTotal =
      _asInt(pagination?['total']) ?? _asInt(pagination?['totalItems']);
  if (pagedTotal != null) return pagedTotal;

  if (payload is List) return payload.length;
  final dataList = data?['admissions'] ?? data?['items'];
  if (dataList is List) return dataList.length;
  return 0;
}

Map<dynamic, dynamic>? _asMap(Object? value) => value is Map ? value : null;

int? _asInt(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  if (value == null) return null;
  return int.tryParse('$value');
}
