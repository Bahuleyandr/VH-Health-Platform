import 'api_client.dart';

class MessagingApiService {
  MessagingApiService._();

  static Future<Map<String, dynamic>> _map(ApiResponse resp) async {
    if (resp.isSuccess && resp.data is Map) {
      return Map<String, dynamic>.from(resp.data as Map);
    }
    if (resp.isSuccess && resp.data is List) {
      return {'data': resp.data};
    }
    if (resp.isSuccess && resp.raw is Map) {
      final raw = Map<String, dynamic>.from(resp.raw as Map);
      final data = raw['data'];
      if (data is Map) return Map<String, dynamic>.from(data);
      if (data is List) return {'data': data};
      return raw;
    }
    throw Exception(resp.message ?? 'Request failed (${resp.statusCode})');
  }

  static Future<List<dynamic>> inbox({int page = 1, int limit = 100}) async {
    final resp = await ApiClient.get(
      '/messaging/inbox',
      queryParameters: {'page': page.toString(), 'limit': limit.toString()},
    );
    final mapped = await _map(resp);
    return mapped['data'] as List? ??
        mapped['messages'] as List? ??
        mapped['items'] as List? ??
        [];
  }

  static Future<Map<String, dynamic>> unreadCount() async {
    final resp = await ApiClient.get('/messaging/unread-count');
    return _map(resp);
  }

  static Future<Map<String, dynamic>> targets({String? search}) async {
    final query = <String, String>{'limit': '250'};
    if (search != null && search.trim().isNotEmpty) {
      query['search'] = search.trim();
    }
    final resp = await ApiClient.get(
      '/messaging/targets',
      queryParameters: query,
    );
    return _map(resp);
  }

  static Future<List<dynamic>> thread(String otherStaffUid) async {
    final resp = await ApiClient.get('/messaging/thread/$otherStaffUid');
    final mapped = await _map(resp);
    return mapped['data'] as List? ??
        mapped['messages'] as List? ??
        mapped['items'] as List? ??
        [];
  }

  static Future<Map<String, dynamic>> adminLog({
    int page = 1,
    int limit = 100,
    String? search,
  }) async {
    final query = <String, String>{
      'page': page.toString(),
      'limit': limit.toString(),
    };
    if (search != null && search.trim().isNotEmpty) {
      query['search'] = search.trim();
    }
    final resp = await ApiClient.get(
      '/messaging/admin/messages',
      queryParameters: query,
    );
    return _map(resp);
  }

  static Future<void> markRead(int id) async {
    await ApiClient.patch('/messaging/$id/read');
  }

  static Future<Map<String, dynamic>> sendDirect({
    required String recipientUid,
    required String body,
    String? subject,
    String priority = 'normal',
  }) async {
    final resp = await ApiClient.post(
      '/messaging/send',
      body: {
        'recipient_uid': recipientUid,
        'body': body,
        'priority': priority,
        if (subject != null && subject.trim().isNotEmpty)
          'subject': subject.trim(),
      },
    );
    return _map(resp);
  }

  static Future<Map<String, dynamic>> sendBroadcast({
    required String scope,
    required String body,
    String? subject,
    String priority = 'normal',
    String? department,
    List<String> recipientUids = const [],
  }) async {
    final resp = await ApiClient.post(
      '/messaging/broadcast',
      body: {
        'scope': scope,
        'body': body,
        'priority': priority,
        if (subject != null && subject.trim().isNotEmpty)
          'subject': subject.trim(),
        if (department != null && department.trim().isNotEmpty)
          'department': department.trim(),
        if (recipientUids.isNotEmpty) 'recipient_uids': recipientUids,
      },
    );
    return _map(resp);
  }
}
