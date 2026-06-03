import 'dart:typed_data';

import 'package:http/http.dart' as http;

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

  static Future<List<dynamic>> threads({
    int page = 1,
    int limit = 100,
    String status = 'active',
    String? priority,
    String? search,
  }) async {
    final query = <String, String>{
      'page': page.toString(),
      'limit': limit.toString(),
      'status': status,
    };
    if (priority != null && priority.trim().isNotEmpty) {
      query['priority'] = priority.trim();
    }
    if (search != null && search.trim().isNotEmpty) {
      query['search'] = search.trim();
    }
    final resp = await ApiClient.get(
      '/messaging/threads',
      queryParameters: query,
    );
    final mapped = await _map(resp);
    return mapped['data'] as List? ??
        mapped['threads'] as List? ??
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

  static Future<Map<String, dynamic>> threadMessages(String threadId) async {
    final resp = await ApiClient.get('/messaging/threads/$threadId/messages');
    return _map(resp);
  }

  static Future<List<dynamic>> threadAttachments(String threadId) async {
    final resp = await ApiClient.get(
      '/messaging/threads/$threadId/attachments',
    );
    final mapped = await _map(resp);
    return mapped['data'] as List? ??
        mapped['attachments'] as List? ??
        mapped['items'] as List? ??
        [];
  }

  static Future<Map<String, dynamic>> uploadThreadAttachment({
    required String threadId,
    required String filePath,
    String? fileName,
    String? recipientUid,
    String? body,
    String? subject,
    String priority = 'normal',
  }) async {
    final fields = <String, String>{'priority': priority};
    if (recipientUid != null && recipientUid.trim().isNotEmpty) {
      fields['recipient_uid'] = recipientUid.trim();
    }
    if (body != null && body.trim().isNotEmpty) {
      fields['body'] = body.trim();
    }
    if (subject != null && subject.trim().isNotEmpty) {
      fields['subject'] = subject.trim();
    }
    final resp = await ApiClient.multipart(
      '/messaging/threads/$threadId/attachments',
      fields: fields,
      fileBuilder: () async => [
        await ApiClient.multipartFileFromPath(
          'file',
          filePath,
          filename: fileName,
        ),
      ],
      timeout: const Duration(seconds: 60),
    );
    return _map(resp);
  }

  static Future<Uint8List> downloadAttachment(String attachmentId) async {
    final response = await ApiClient.getBytes(
      '/messaging/attachments/$attachmentId/download',
      timeout: const Duration(seconds: 45),
    );
    return _bytesFrom(response, 'Attachment download failed');
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

  static Future<void> archiveThread(String threadId) async {
    await ApiClient.patch('/messaging/threads/$threadId/archive');
  }

  static Future<void> unarchiveThread(String threadId) async {
    await ApiClient.patch('/messaging/threads/$threadId/unarchive');
  }

  static Future<void> markThreadUnread(String threadId) async {
    await ApiClient.patch('/messaging/threads/$threadId/mark-unread');
  }

  static Future<void> muteThread(String threadId, {int hours = 8}) async {
    await ApiClient.patch(
      '/messaging/threads/$threadId/mute',
      body: {'hours': hours},
    );
  }

  static Future<void> urgentOnlyThread(String threadId) async {
    await ApiClient.patch(
      '/messaging/threads/$threadId/mute',
      body: {'urgent_only': true},
    );
  }

  static Future<void> unmuteThread(String threadId) async {
    await ApiClient.patch('/messaging/threads/$threadId/unmute');
  }

  static Future<Map<String, dynamic>> sendDirect({
    required String recipientUid,
    required String body,
    String? subject,
    String priority = 'normal',
    String? threadId,
    String? patientUid,
    int? admissionId,
  }) async {
    final payload = <String, dynamic>{
      'recipient_uid': recipientUid,
      'body': body,
      'priority': priority,
    };
    if (threadId != null && threadId.trim().isNotEmpty) {
      payload['thread_id'] = threadId.trim();
    }
    if (patientUid != null && patientUid.trim().isNotEmpty) {
      payload['patient_uid'] = patientUid.trim();
    }
    if (admissionId != null) {
      payload['admission_id'] = admissionId;
    }
    if (subject != null && subject.trim().isNotEmpty) {
      payload['subject'] = subject.trim();
    }
    final resp = await ApiClient.post('/messaging/send', body: payload);
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

  static Uint8List _bytesFrom(http.Response response, String fallback) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return response.bodyBytes;
    }
    final parsed = ApiResponse.parse(response.statusCode, response.body);
    throw Exception(parsed.message ?? '$fallback (${response.statusCode})');
  }
}
