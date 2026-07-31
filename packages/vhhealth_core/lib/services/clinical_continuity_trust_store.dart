import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import '../models/clinical_continuity.dart';
import 'clinical_continuity_canonical_json.dart';
import 'secure_storage.dart';

class ClinicalContinuityTrustedKey {
  final String keyId;
  final ClinicalContinuityKeyState state;
  final Uint8List rawPublicKey;
  final String publicKeySha256;

  const ClinicalContinuityTrustedKey({
    required this.keyId,
    required this.state,
    required this.rawPublicKey,
    required this.publicKeySha256,
  });
}

class ClinicalContinuityTrustBundle {
  final ClinicalContinuityAudience audience;
  final String minimumPolicyVersion;
  final String minimumRevocationEpoch;
  final String revocationEpoch;
  final ClinicalContinuityTrustedKey policySigningKey;
  final Map<String, ClinicalContinuityTrustedKey> packSigningKeys;
  final Set<String> revokedKeyIds;

  const ClinicalContinuityTrustBundle({
    required this.audience,
    required this.minimumPolicyVersion,
    required this.minimumRevocationEpoch,
    required this.revocationEpoch,
    required this.policySigningKey,
    required this.packSigningKeys,
    required this.revokedKeyIds,
  });
}

abstract interface class ClinicalContinuityTrustReader {
  Future<String?> read();
}

class SecureStorageClinicalContinuityTrustReader
    implements ClinicalContinuityTrustReader {
  static const storageKey = 'clinical_continuity_trust_root';

  const SecureStorageClinicalContinuityTrustReader();

  @override
  Future<String?> read() => VHSecureStorage.instance.read(key: storageKey);
}

class ClinicalContinuityTrustStore {
  final ClinicalContinuityTrustReader _reader;

  const ClinicalContinuityTrustStore({
    ClinicalContinuityTrustReader reader =
        const SecureStorageClinicalContinuityTrustReader(),
  }) : _reader = reader;

  Future<ClinicalContinuityTrustBundle?> load({
    required ClinicalContinuityAudience expectedAudience,
  }) async {
    final raw = await _reader.read();
    if (raw == null) return null;
    try {
      final decoded = ClinicalContinuityCanonicalJson.parse(
        Uint8List.fromList(utf8.encode(raw)),
      );
      if (decoded is! Map) return null;
      return await _validate(
        Map<String, Object?>.from(decoded),
        expectedAudience,
      );
    } catch (_) {
      return null;
    }
  }

  Future<ClinicalContinuityTrustBundle?> _validate(
    Map<String, Object?> json,
    ClinicalContinuityAudience expectedAudience,
  ) async {
    if (!_exactKeys(json, const {
      'algorithm',
      'audience',
      'distribution',
      'format',
      'minimumPolicyVersion',
      'minimumRevocationEpoch',
      'packSigningKeys',
      'policySigningKey',
      'refusalPolicy',
      'revocationEpoch',
      'revokedKeyIds',
    })) {
      return null;
    }
    if (json['algorithm'] != 'Ed25519' ||
        json['distribution'] != 'operator_provisioned_out_of_band' ||
        json['format'] != 'vhhealth_clinical_continuity_trust/v1') {
      return null;
    }

    final audience = _map(json['audience']);
    if (audience == null ||
        !_exactKeys(audience, const {'facilityId', 'tenantId'}) ||
        audience['tenantId'] != expectedAudience.tenantId ||
        audience['facilityId'] != expectedAudience.facilityId) {
      return null;
    }
    final minimumPolicyVersion = _governance(json['minimumPolicyVersion']);
    final minimumRevocationEpoch = _governance(
      json['minimumRevocationEpoch'],
      allowZero: true,
    );
    final revocationEpoch = _governance(
      json['revocationEpoch'],
      allowZero: true,
    );
    if (minimumPolicyVersion == null ||
        minimumRevocationEpoch == null ||
        revocationEpoch == null ||
        BigInt.parse(revocationEpoch) < BigInt.parse(minimumRevocationEpoch)) {
      return null;
    }

    final refusal = _map(json['refusalPolicy']);
    if (refusal == null ||
        !_exactKeys(refusal, const {
          'compromisedOrRevokedKey',
          'uncertainClock',
          'versionRollback',
        }) ||
        refusal['compromisedOrRevokedKey'] !=
            'reject_pack_use_paper_and_phone' ||
        refusal['uncertainClock'] != 'refuse_as_current_use_paper_and_phone' ||
        refusal['versionRollback'] != 'reject_pack_use_paper_and_phone') {
      return null;
    }

    final revokedRaw = json['revokedKeyIds'];
    if (revokedRaw is! List ||
        revokedRaw.any((key) => !_validKeyId(key)) ||
        revokedRaw.toSet().length != revokedRaw.length) {
      return null;
    }
    final revoked = revokedRaw.cast<String>().toSet();

    final policyKeyMap = _map(json['policySigningKey']);
    final policyKey = policyKeyMap == null
        ? null
        : await _readKey(policyKeyMap, requireState: false);
    if (policyKey == null) {
      return null;
    }

    final keysRaw = json['packSigningKeys'];
    if (keysRaw is! List || keysRaw.isEmpty || keysRaw.length > 2) return null;
    final keys = <String, ClinicalContinuityTrustedKey>{};
    for (final rawKey in keysRaw) {
      final keyMap = _map(rawKey);
      if (keyMap == null) return null;
      final key = await _readKey(keyMap, requireState: true);
      if (key == null || keys.containsKey(key.keyId)) {
        return null;
      }
      keys[key.keyId] = key;
    }
    final states = keys.values.map((key) => key.state).toSet();
    if (!states.contains(ClinicalContinuityKeyState.current)) {
      return null;
    }

    return ClinicalContinuityTrustBundle(
      audience: expectedAudience,
      minimumPolicyVersion: minimumPolicyVersion,
      minimumRevocationEpoch: minimumRevocationEpoch,
      revocationEpoch: revocationEpoch,
      policySigningKey: policyKey,
      packSigningKeys: Map.unmodifiable(keys),
      revokedKeyIds: Set.unmodifiable(revoked),
    );
  }

  Future<ClinicalContinuityTrustedKey?> _readKey(
    Map<String, Object?> json, {
    required bool requireState,
  }) async {
    final expected = {
      'algorithm',
      'keyId',
      'publicKeySha256',
      'publicKeySpkiPem',
      if (requireState) 'state',
    };
    if (!_exactKeys(json, expected) ||
        json['algorithm'] != 'Ed25519' ||
        !_validKeyId(json['keyId']) ||
        json['publicKeySpkiPem'] is! String ||
        json['publicKeySha256'] is! String) {
      return null;
    }
    final pem = json['publicKeySpkiPem']! as String;
    final digest = await Sha256().hash(utf8.encode(pem));
    if (_hex(digest.bytes) != json['publicKeySha256']) return null;
    final raw = _parseEd25519SpkiPem(pem);
    if (raw == null) return null;

    final state = switch (json['state']) {
      'current' => ClinicalContinuityKeyState.current,
      'next' => ClinicalContinuityKeyState.next,
      'revoked' => ClinicalContinuityKeyState.revoked,
      'compromised' => ClinicalContinuityKeyState.compromised,
      null when !requireState => ClinicalContinuityKeyState.current,
      _ => null,
    };
    if (state == null) return null;
    return ClinicalContinuityTrustedKey(
      keyId: json['keyId']! as String,
      state: state,
      rawPublicKey: raw,
      publicKeySha256: json['publicKeySha256']! as String,
    );
  }
}

Uint8List? _parseEd25519SpkiPem(String pem) {
  const header = '-----BEGIN PUBLIC KEY-----';
  const footer = '-----END PUBLIC KEY-----';
  final normalized = pem.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('$header\n')) return null;
  final footerIndex = normalized.indexOf('\n$footer');
  if (footerIndex < 0) return null;
  final trailing = normalized.substring(footerIndex + footer.length + 1);
  if (trailing.isNotEmpty && trailing != '\n') return null;
  final body = normalized
      .substring(header.length + 1, footerIndex)
      .replaceAll('\n', '');
  Uint8List der;
  try {
    der = Uint8List.fromList(base64Decode(body));
  } catch (_) {
    return null;
  }
  const prefix = <int>[
    0x30,
    0x2a,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x70,
    0x03,
    0x21,
    0x00,
  ];
  if (der.length != prefix.length + 32) return null;
  for (var i = 0; i < prefix.length; i++) {
    if (der[i] != prefix[i]) return null;
  }
  return Uint8List.fromList(der.sublist(prefix.length));
}

Map<String, Object?>? _map(Object? value) =>
    value is Map ? Map<String, Object?>.from(value) : null;

bool _exactKeys(Map<String, Object?> value, Set<String> expected) =>
    value.length == expected.length && value.keys.toSet().containsAll(expected);

bool _validKeyId(Object? value) =>
    value is String &&
    RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$').hasMatch(value);

String? _governance(Object? value, {bool allowZero = false}) {
  if (value is! String ||
      !RegExp(r'^(?:0|[1-9][0-9]{0,18})$').hasMatch(value) ||
      (!allowZero && value == '0')) {
    return null;
  }
  final parsed = BigInt.parse(value);
  if (parsed > BigInt.from(9223372036854775807)) return null;
  return value;
}

String _hex(List<int> bytes) =>
    bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
