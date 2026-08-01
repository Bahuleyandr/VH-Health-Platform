import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/features/settings/models/record_access_grant.dart';

abstract class RecordAccessRepository {
  Future<RecordAccessGrantsPage> listGrants();

  Future<RecordAccessGrant> createGrant({
    required String proxyUid,
    required String relationship,
    required List<String> scope,
    required String consentMethod,
    Uint8List? signaturePngBytes,
  });

  Future<void> revokeGrant(int id, {String? reason});
}

class ApiRecordAccessRepository implements RecordAccessRepository {
  const ApiRecordAccessRepository();

  @override
  Future<RecordAccessGrantsPage> listGrants() async {
    final result = await ApiClient.cachedGet('/portal/proxy/grants');
    if (!result.isSuccess) {
      throw Exception(result.failureMessage('Failed to load record access'));
    }
    final snapshot = _parseSnapshot(result.data);
    return RecordAccessGrantsPage(
      grantedByMe: snapshot.grantedByMe,
      heldByMe: snapshot.heldByMe,
      staleLabel: result.staleLabel,
      cachedAt: result.cachedAt,
      onFresh: result.onFresh?.then((fresh) {
        if (!fresh.isSuccess) {
          throw Exception(
            fresh.failureMessage('Failed to refresh record access'),
          );
        }
        return _parseSnapshot(fresh.data);
      }),
    );
  }

  @override
  Future<RecordAccessGrant> createGrant({
    required String proxyUid,
    required String relationship,
    required List<String> scope,
    required String consentMethod,
    Uint8List? signaturePngBytes,
  }) async {
    final response = signaturePngBytes == null
        ? await ApiClient.post(
            '/portal/proxy/grants',
            body: {
              'proxy_uid': proxyUid,
              'relationship': relationship,
              'scope': scope,
              'consent_method': consentMethod,
            },
          )
        : await ApiClient.multipart(
            '/portal/proxy/grants',
            fields: {
              'proxy_uid': proxyUid,
              'relationship': relationship,
              'scope': jsonEncode(scope),
              'consent_method': consentMethod,
            },
            files: [
              http.MultipartFile.fromBytes(
                'file',
                signaturePngBytes,
                filename: 'record-access-signature.png',
                contentType: MediaType('image', 'png'),
              ),
            ],
          );
    if (!response.isSuccess) {
      throw Exception(response.failureMessage('Could not grant record access'));
    }
    final data = response.data;
    if (data is Map<String, dynamic>) return RecordAccessGrant.fromJson(data);
    if (data is Map) {
      return RecordAccessGrant.fromJson(Map<String, dynamic>.from(data));
    }
    throw Exception('Invalid grant response');
  }

  @override
  Future<void> revokeGrant(int id, {String? reason}) async {
    final response = await ApiClient.post(
      '/portal/proxy/grants/$id/revoke',
      body: {
        if (reason != null && reason.trim().isNotEmpty) 'reason': reason.trim(),
      },
    );
    if (!response.isSuccess) {
      throw Exception(
        response.failureMessage('Could not revoke record access'),
      );
    }
  }
}

RecordAccessGrantsSnapshot _parseSnapshot(dynamic raw) {
  final map = raw is Map<String, dynamic>
      ? raw
      : raw is Map
      ? Map<String, dynamic>.from(raw)
      : const <String, dynamic>{};
  final grantedRaw = map['granted_by_me'];
  final heldRaw = map['held_by_me'];
  final granted = grantedRaw is List
      ? grantedRaw
            .whereType<Map>()
            .map(
              (item) =>
                  RecordAccessGrant.fromJson(Map<String, dynamic>.from(item)),
            )
            .where((grant) => grant.id > 0)
            .toList(growable: false)
      : const <RecordAccessGrant>[];
  final held = heldRaw is List
      ? heldRaw
            .whereType<Map>()
            .map(
              (item) => HeldRecordAccessGrant.fromJson(
                Map<String, dynamic>.from(item),
              ),
            )
            .where((grant) => grant.id > 0)
            .toList(growable: false)
      : const <HeldRecordAccessGrant>[];
  return RecordAccessGrantsSnapshot(grantedByMe: granted, heldByMe: held);
}
