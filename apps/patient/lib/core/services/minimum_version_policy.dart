import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:vhhealth/core/config/api_config.dart';
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_core/services/clinical_continuity_canonical_json.dart';
import 'package:vhhealth_core/services/secure_storage.dart';

typedef MinimumVersionStorageRead = Future<String?> Function(String key);
typedef MinimumVersionStorageWrite =
    Future<void> Function(String key, String value);
typedef MinimumVersionStorageDelete = Future<void> Function(String key);

@immutable
class MinimumVersionPolicy {
  const MinimumVersionPolicy._({
    required this.revision,
    required this.minPatientVersionCode,
    required this.issuedAt,
    required this.graceUntil,
    required this.envelope,
  });

  final int revision;
  final int minPatientVersionCode;
  final DateTime issuedAt;
  final DateTime graceUntil;
  final Map<String, Object?> envelope;

  bool sameEnvelopeAs(MinimumVersionPolicy other) =>
      ClinicalContinuityCanonicalJson.canonicalize(envelope) ==
      ClinicalContinuityCanonicalJson.canonicalize(other.envelope);
}

class MinimumVersionPolicyVerifier {
  const MinimumVersionPolicyVerifier({
    required this.trustedKeys,
    this.expectedTenantId = TenantConfig.id,
  });

  static const format = 'vhhealth_patient_minimum_version/v1';
  static const audience = 'vhhealth-patient-minimum-version';
  static const maxGraceDuration = Duration(days: 7);
  static const _maxSafeInteger = 9007199254740991;
  static const _envelopeKeys = <String>{
    'algorithm',
    'format',
    'key_id',
    'policy',
    'signature',
  };
  static const _policyKeys = <String>{
    'audience',
    'tenant_id',
    'revision',
    'min_patient_version_code',
    'issued_at',
    'grace_until',
  };

  final Map<String, PublicKey> trustedKeys;
  final String expectedTenantId;

  Future<MinimumVersionPolicy?> verify(Object? value) async {
    try {
      if (value is! Map) return null;
      final envelope = Map<String, Object?>.from(value);
      if (!setEquals(envelope.keys.toSet(), _envelopeKeys) ||
          envelope['algorithm'] != 'Ed25519' ||
          envelope['format'] != format) {
        return null;
      }

      final keyId = envelope['key_id'];
      if (keyId is! String ||
          !RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$').hasMatch(keyId)) {
        return null;
      }
      final publicKey = trustedKeys[keyId];
      if (publicKey == null) return null;

      final policyValue = envelope['policy'];
      if (policyValue is! Map) return null;
      final policy = Map<String, Object?>.from(policyValue);
      if (!setEquals(policy.keys.toSet(), _policyKeys) ||
          policy['audience'] != audience ||
          policy['tenant_id'] != expectedTenantId) {
        return null;
      }

      final revision = policy['revision'];
      final minimum = policy['min_patient_version_code'];
      final issuedAt = _utc(policy['issued_at']);
      final graceUntil = _utc(policy['grace_until']);
      if (revision is! int ||
          revision <= 0 ||
          revision > _maxSafeInteger ||
          minimum is! int ||
          minimum < 0 ||
          minimum > _maxSafeInteger ||
          issuedAt == null ||
          graceUntil == null ||
          graceUntil.isBefore(issuedAt) ||
          graceUntil.difference(issuedAt) > maxGraceDuration) {
        return null;
      }

      final signatureValue = envelope['signature'];
      if (signatureValue is! String) return null;
      final signatureBytes = base64Decode(signatureValue);
      if (signatureBytes.length != 64 ||
          base64Encode(signatureBytes) != signatureValue) {
        return null;
      }

      final unsigned = Map<String, Object?>.from(envelope)..remove('signature');
      final valid = await Ed25519().verify(
        ClinicalContinuityCanonicalJson.canonicalBytes(unsigned),
        signature: Signature(signatureBytes, publicKey: publicKey),
      );
      if (!valid) return null;
      final verifiedSnapshot = Map<String, Object?>.from(
        jsonDecode(
              ClinicalContinuityCanonicalJson.canonicalize({
                ...unsigned,
                'signature': signatureValue,
              }),
            )
            as Map,
      );

      return MinimumVersionPolicy._(
        revision: revision,
        minPatientVersionCode: minimum,
        issuedAt: issuedAt,
        graceUntil: graceUntil,
        envelope: Map<String, Object?>.unmodifiable(verifiedSnapshot),
      );
    } catch (_) {
      return null;
    }
  }

  static DateTime? _utc(Object? value) {
    if (value is! String) return null;
    final parsed = DateTime.tryParse(value);
    return parsed != null && parsed.isUtc ? parsed : null;
  }
}

class MinimumVersionPolicyTrust {
  MinimumVersionPolicyTrust._();

  static const _currentKeyId = String.fromEnvironment(
    'VH_PATIENT_MIN_VERSION_CURRENT_KEY_ID',
  );
  static const _currentPublicKey = String.fromEnvironment(
    'VH_PATIENT_MIN_VERSION_CURRENT_PUBLIC_KEY_BASE64',
  );
  static const _nextKeyId = String.fromEnvironment(
    'VH_PATIENT_MIN_VERSION_NEXT_KEY_ID',
  );
  static const _nextPublicKey = String.fromEnvironment(
    'VH_PATIENT_MIN_VERSION_NEXT_PUBLIC_KEY_BASE64',
  );

  /// Release-stamped trust only. There is deliberately no repository default:
  /// a made-up key would turn an unverifiable value into local authority.
  static Map<String, PublicKey> fromBuild() {
    final keys = <String, PublicKey>{};
    for (final pair in <(String, String)>[
      (_currentKeyId, _currentPublicKey),
      (_nextKeyId, _nextPublicKey),
    ]) {
      final (keyId, encoded) = pair;
      if (keyId.isEmpty && encoded.isEmpty) continue;
      if (keyId.isEmpty ||
          encoded.isEmpty ||
          !RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$').hasMatch(keyId) ||
          keys.containsKey(keyId)) {
        return const {};
      }
      try {
        final bytes = base64Decode(encoded);
        if (bytes.length != 32 || base64Encode(bytes) != encoded) {
          return const {};
        }
        keys[keyId] = SimplePublicKey(bytes, type: KeyPairType.ed25519);
      } catch (_) {
        return const {};
      }
    }
    return Map.unmodifiable(keys);
  }
}

@immutable
class MinimumVersionPolicyLoad {
  const MinimumVersionPolicyLoad._({this.policy, this.corrupted = false});

  const MinimumVersionPolicyLoad.absent() : this._();
  const MinimumVersionPolicyLoad.corrupted() : this._(corrupted: true);
  const MinimumVersionPolicyLoad.found(MinimumVersionPolicy policy)
    : this._(policy: policy);

  final MinimumVersionPolicy? policy;
  final bool corrupted;
}

@immutable
class MinimumVersionUnavailableLoad {
  const MinimumVersionUnavailableLoad._({
    this.firstUnavailableAt,
    this.corrupted = false,
  });

  const MinimumVersionUnavailableLoad.absent() : this._();
  const MinimumVersionUnavailableLoad.corrupted() : this._(corrupted: true);
  const MinimumVersionUnavailableLoad.found(DateTime firstUnavailableAt)
    : this._(firstUnavailableAt: firstUnavailableAt);

  final DateTime? firstUnavailableAt;
  final bool corrupted;
}

class MinimumVersionPolicyStateStore {
  MinimumVersionPolicyStateStore._production()
    : _read = ((key) => VHSecureStorage.instance.read(key: key)),
      _write = ((key, value) =>
          VHSecureStorage.instance.write(key: key, value: value)),
      _delete = ((key) => VHSecureStorage.instance.delete(key: key));

  @visibleForTesting
  MinimumVersionPolicyStateStore.forTesting({
    required MinimumVersionStorageRead read,
    required MinimumVersionStorageWrite write,
    required MinimumVersionStorageDelete delete,
  }) : _read = read,
       _write = write,
       _delete = delete;

  static MinimumVersionPolicyStateStore production() =>
      MinimumVersionPolicyStateStore._production();

  static const _snapshotKeys = <String>{'source', 'envelope'};
  static const _unavailableKeys = <String>{'source', 'first_unavailable_at'};

  final MinimumVersionStorageRead _read;
  final MinimumVersionStorageWrite _write;
  final MinimumVersionStorageDelete _delete;

  String get _policyKey =>
      'patient.minimum_version_policy.v1.${TenantConfig.cacheNamespace}';
  String get _unavailableKey =>
      'patient.minimum_version_unavailable.v1.${TenantConfig.cacheNamespace}';

  Future<MinimumVersionPolicyLoad> loadPolicy(
    MinimumVersionPolicyVerifier verifier,
  ) async {
    try {
      final raw = await _read(_policyKey);
      if (raw == null) return const MinimumVersionPolicyLoad.absent();
      final decoded = ClinicalContinuityCanonicalJson.parse(
        Uint8List.fromList(utf8.encode(raw)),
      );
      if (decoded is! Map) return const MinimumVersionPolicyLoad.corrupted();
      final snapshot = Map<String, Object?>.from(decoded);
      if (!setEquals(snapshot.keys.toSet(), _snapshotKeys) ||
          snapshot['source'] != ApiConfig.baseUrl) {
        return const MinimumVersionPolicyLoad.corrupted();
      }
      final policy = await verifier.verify(snapshot['envelope']);
      return policy == null
          ? const MinimumVersionPolicyLoad.corrupted()
          : MinimumVersionPolicyLoad.found(policy);
    } catch (_) {
      return const MinimumVersionPolicyLoad.corrupted();
    }
  }

  Future<bool> savePolicy(MinimumVersionPolicy policy) async {
    try {
      await _write(
        _policyKey,
        jsonEncode({'source': ApiConfig.baseUrl, 'envelope': policy.envelope}),
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<MinimumVersionUnavailableLoad> loadUnavailableSince() async {
    try {
      final raw = await _read(_unavailableKey);
      if (raw == null) return const MinimumVersionUnavailableLoad.absent();
      final decoded = ClinicalContinuityCanonicalJson.parse(
        Uint8List.fromList(utf8.encode(raw)),
      );
      if (decoded is! Map) {
        return const MinimumVersionUnavailableLoad.corrupted();
      }
      final snapshot = Map<String, Object?>.from(decoded);
      if (!setEquals(snapshot.keys.toSet(), _unavailableKeys) ||
          snapshot['source'] != ApiConfig.baseUrl) {
        return const MinimumVersionUnavailableLoad.corrupted();
      }
      final timestamp = snapshot['first_unavailable_at'];
      final firstUnavailableAt = timestamp is String
          ? DateTime.tryParse(timestamp)
          : null;
      if (firstUnavailableAt == null || !firstUnavailableAt.isUtc) {
        return const MinimumVersionUnavailableLoad.corrupted();
      }
      return MinimumVersionUnavailableLoad.found(firstUnavailableAt);
    } catch (_) {
      return const MinimumVersionUnavailableLoad.corrupted();
    }
  }

  Future<MinimumVersionUnavailableLoad> markUnavailable(DateTime now) async {
    final existing = await loadUnavailableSince();
    if (existing.corrupted || existing.firstUnavailableAt != null) {
      return existing;
    }
    try {
      final timestamp = now.toUtc();
      await _write(
        _unavailableKey,
        jsonEncode({
          'source': ApiConfig.baseUrl,
          'first_unavailable_at': timestamp.toIso8601String(),
        }),
      );
      return MinimumVersionUnavailableLoad.found(timestamp);
    } catch (_) {
      return const MinimumVersionUnavailableLoad.corrupted();
    }
  }

  Future<void> clearUnavailable() async {
    try {
      await _delete(_unavailableKey);
    } catch (_) {
      // A stale marker can only close the gate earlier on a later outage.
    }
  }
}
