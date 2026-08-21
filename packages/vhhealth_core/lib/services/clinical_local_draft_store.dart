import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'clinical_continuity_canonical_json.dart';
import 'offline_action_ids.dart';
import 'secure_blob.dart';
import 'secure_storage.dart';

@immutable
class ClinicalLocalDraft {
  const ClinicalLocalDraft({
    required this.id,
    required this.actionId,
    required this.tenantId,
    required this.facilityId,
    required this.deviceId,
    required this.actorId,
    required this.role,
    required this.patientReference,
    required this.payload,
    required this.createdAt,
    required this.updatedAt,
    this.encounterId,
    this.appointmentId,
    this.admissionId,
  });

  final String id;
  final String actionId;
  final String tenantId;
  final int facilityId;
  final String deviceId;
  final String actorId;
  final String role;
  final String patientReference;
  final String? encounterId;
  final String? appointmentId;
  final String? admissionId;
  final Map<String, Object?> payload;
  final DateTime createdAt;
  final DateTime updatedAt;

  Map<String, Object?> toJson() => {
    'schemaVersion': 1,
    'id': id,
    'actionId': actionId,
    'tenantId': tenantId,
    'facilityId': facilityId,
    'deviceId': deviceId,
    'actorId': actorId,
    'role': role,
    'patientReference': patientReference,
    'encounterId': encounterId,
    'appointmentId': appointmentId,
    'admissionId': admissionId,
    'payload': payload,
    'createdAt': createdAt.toUtc().toIso8601String(),
    'updatedAt': updatedAt.toUtc().toIso8601String(),
    'requiresOnlineReview': true,
  };

  factory ClinicalLocalDraft.fromJson(Map<String, Object?> json) {
    if (json['schemaVersion'] != 1 ||
        json['requiresOnlineReview'] != true ||
        json['payload'] is! Map) {
      throw const FormatException('Invalid clinical local draft');
    }
    return ClinicalLocalDraft(
      id: json['id']! as String,
      actionId: json['actionId']! as String,
      tenantId: json['tenantId']! as String,
      facilityId: json['facilityId']! as int,
      deviceId: json['deviceId']! as String,
      actorId: json['actorId']! as String,
      role: json['role']! as String,
      patientReference: json['patientReference']! as String,
      encounterId: json['encounterId'] as String?,
      appointmentId: json['appointmentId'] as String?,
      admissionId: json['admissionId'] as String?,
      payload: Map<String, Object?>.from(json['payload']! as Map),
      createdAt: DateTime.parse(json['createdAt']! as String),
      updatedAt: DateTime.parse(json['updatedAt']! as String),
    );
  }
}

abstract interface class ClinicalLocalDraftPersistence {
  Future<List<String>> readIds();
  Future<String?> read(String id);
  Future<void> write(String id, String value);
  Future<void> delete(String id);
  Future<void> writeIds(List<String> ids);
}

class SecureClinicalLocalDraftPersistence
    implements ClinicalLocalDraftPersistence {
  static const _indexKey = 'clinical_local_draft_index_v1';
  static const _recordPrefix = 'clinical_local_draft_v1:';

  const SecureClinicalLocalDraftPersistence();

  @override
  Future<List<String>> readIds() async {
    final raw = await VHSecureStorage.instance.read(key: _indexKey);
    if (raw == null) return const [];
    final decoded = jsonDecode(raw);
    if (decoded is! List ||
        decoded.any(
          (value) =>
              value is! String ||
              !RegExp(r'^[A-Za-z0-9._:-]{1,160}$').hasMatch(value),
        )) {
      throw StateError('Clinical local draft index is unavailable');
    }
    return decoded.cast<String>();
  }

  @override
  Future<String?> read(String id) =>
      VHSecureStorage.instance.read(key: '$_recordPrefix$id');

  @override
  Future<void> write(String id, String value) =>
      VHSecureStorage.instance.write(key: '$_recordPrefix$id', value: value);

  @override
  Future<void> delete(String id) =>
      VHSecureStorage.instance.delete(key: '$_recordPrefix$id');

  @override
  Future<void> writeIds(List<String> ids) =>
      VHSecureStorage.instance.write(key: _indexKey, value: jsonEncode(ids));
}

class ClinicalLocalDraftStore {
  ClinicalLocalDraftStore({
    ClinicalLocalDraftPersistence persistence =
        const SecureClinicalLocalDraftPersistence(),
    SecureBlobCodec? codec,
  }) : _persistence = persistence,
       _codec = codec ?? SecureBlobCodec('clinical_local_draft_aes_key_v1');

  final ClinicalLocalDraftPersistence _persistence;
  final SecureBlobCodec _codec;

  Future<void> save(ClinicalLocalDraft draft) async {
    _validate(draft);
    final plaintext = ClinicalContinuityCanonicalJson.canonicalize(
      draft.toJson(),
    );
    final encrypted = await _codec.seal(
      plaintext,
      authenticatedData: _aad(draft.id),
    );
    await _persistence.write(draft.id, encrypted);
    final ids = (await _persistence.readIds()).toSet()..add(draft.id);
    await _persistence.writeIds(ids.toList()..sort());
  }

  Future<ClinicalLocalDraft?> read(String id) async {
    final encrypted = await _persistence.read(id);
    if (encrypted == null) return null;
    final plaintext = await _codec.open(encrypted, authenticatedData: _aad(id));
    final parsed = ClinicalContinuityCanonicalJson.parse(
      Uint8List.fromList(utf8.encode(plaintext)),
    );
    final draft = ClinicalLocalDraft.fromJson(
      Map<String, Object?>.from(parsed! as Map),
    );
    if (draft.id != id) {
      throw StateError('Clinical local draft identity mismatch');
    }
    _validate(draft);
    return draft;
  }

  Future<List<ClinicalLocalDraft>> list({
    required String tenantId,
    required int facilityId,
    required String deviceId,
    required String actorId,
  }) async {
    final result = <ClinicalLocalDraft>[];
    for (final id in await _persistence.readIds()) {
      final draft = await read(id);
      if (draft != null &&
          draft.tenantId == tenantId &&
          draft.facilityId == facilityId &&
          draft.deviceId == deviceId &&
          draft.actorId == actorId) {
        result.add(draft);
      }
    }
    result.sort((left, right) => right.updatedAt.compareTo(left.updatedAt));
    return List.unmodifiable(result);
  }

  Future<void> delete(String id) async {
    await _persistence.delete(id);
    final ids = (await _persistence.readIds()).where((value) => value != id);
    await _persistence.writeIds(ids.toList()..sort());
  }

  void _validate(ClinicalLocalDraft draft) {
    if (draft.id.isEmpty ||
        !RegExp(r'^[A-Za-z0-9._:-]{1,160}$').hasMatch(draft.id) ||
        !const {
          OfflineActionIds.opPrescriptionDraft,
          OfflineActionIds.ipDrugChartDraft,
        }.contains(draft.actionId) ||
        draft.tenantId.isEmpty ||
        draft.facilityId <= 0 ||
        draft.deviceId.isEmpty ||
        draft.actorId.isEmpty ||
        draft.role.isEmpty ||
        draft.patientReference.isEmpty ||
        draft.updatedAt.isBefore(draft.createdAt)) {
      throw const FormatException('Invalid clinical local draft');
    }
  }

  List<int> _aad(String id) =>
      utf8.encode('vhhealth_clinical_local_draft/v1\u0000$id');
}
