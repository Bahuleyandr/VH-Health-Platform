import 'api_client.dart';

enum AuditLogKind {
  audit('audit'),
  system('system');

  final String path;
  const AuditLogKind(this.path);
}

class AuditLogQuery {
  final AuditLogKind kind;
  final String? search;
  final String? action;
  final String? resource;
  final String? role;
  final String? dateRange;
  final DateTime? from;
  final DateTime? to;
  final int page;
  final int limit;

  const AuditLogQuery({
    required this.kind,
    this.search,
    this.action,
    this.resource,
    this.role,
    this.dateRange,
    this.from,
    this.to,
    this.page = 1,
    this.limit = 50,
  });

  Map<String, String> toQueryParameters() {
    final query = <String, String>{
      'page': page.toString(),
      'limit': limit.toString(),
    };
    void add(String key, String? value) {
      final trimmed = value?.trim();
      if (trimmed != null && trimmed.isNotEmpty) query[key] = trimmed;
    }

    add('search', search);
    add('action', action);
    add('resource', kind == AuditLogKind.audit ? resource : null);
    add('role', kind == AuditLogKind.audit ? role : null);
    add('dateRange', dateRange);
    if (from != null) query['from'] = _dateOnly(from!);
    if (to != null) query['to'] = _dateOnly(to!);
    return query;
  }

  static String _dateOnly(DateTime value) {
    final local = value.toLocal();
    final month = local.month.toString().padLeft(2, '0');
    final day = local.day.toString().padLeft(2, '0');
    return '${local.year}-$month-$day';
  }
}

class AuditLogResult {
  final List<Map<String, dynamic>> logs;
  final int total;
  final int page;
  final int limit;
  final int totalPages;

  const AuditLogResult({
    required this.logs,
    required this.total,
    required this.page,
    required this.limit,
    required this.totalPages,
  });

  factory AuditLogResult.fromJson(Map<String, dynamic> json) {
    final pagination = json['pagination'] is Map
        ? Map<String, dynamic>.from(json['pagination'] as Map)
        : const <String, dynamic>{};
    final logs = json['logs'] is List
        ? (json['logs'] as List)
              .whereType<Map>()
              .map((row) => Map<String, dynamic>.from(row))
              .toList()
        : <Map<String, dynamic>>[];
    final total = _int(json['total']) ?? _int(pagination['total']) ?? logs.length;
    final limit = _int(json['limit']) ?? _int(pagination['limit']) ?? 50;
    final page = _int(json['page']) ?? _int(pagination['page']) ?? 1;
    return AuditLogResult(
      logs: logs,
      total: total,
      page: page,
      limit: limit,
      totalPages: _int(pagination['totalPages']) ?? 1,
    );
  }

  static int? _int(Object? value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '');
  }
}

class AuditLogApiService {
  AuditLogApiService._();

  static Future<AuditLogResult> fetchLogs(AuditLogQuery query) async {
    final resp = await ApiClient.get(
      '/logs/${query.kind.path}',
      queryParameters: query.toQueryParameters(),
    );
    if (!resp.isSuccess) {
      throw Exception(resp.message ?? 'Failed to fetch audit logs');
    }

    final data = _unwrap(resp);
    return AuditLogResult.fromJson(data);
  }

  static Map<String, dynamic> _unwrap(ApiResponse resp) {
    if (resp.data is Map) return Map<String, dynamic>.from(resp.data as Map);
    if (resp.raw is Map) {
      final raw = Map<String, dynamic>.from(resp.raw as Map);
      final data = raw['data'];
      if (data is Map) return Map<String, dynamic>.from(data);
      if (raw['logs'] is List) return raw;
    }
    return const {'logs': <dynamic>[], 'total': 0};
  }
}
