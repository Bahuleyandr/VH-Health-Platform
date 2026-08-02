import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/clinical_continuity.dart';
import 'package:vhhealth_core/services/clinical_continuity_canonical_json.dart';
import 'package:vhhealth_core/services/clinical_continuity_trust_store.dart';

// Deliberately free of dart:io, sqflite, and on-disk fixtures so this suite
// compiles and runs under `flutter test --platform chrome` as well as the VM.
// It pins the C3.1 governance-revision ceiling on both compilation targets.

const _tenantId = '52e31913-c846-4458-a21b-31cd2f457e9b';
const _facilityId = '41';
const _packKeyId = 'pack-key-1';
const _policyKeyId = 'policy-key-1';

// Held as strings, never int literals: `9223372036854775807` written as an int
// is a dart2js compile error, which is the defect this suite guards.
const _int64Max = '9223372036854775807';
const _aboveInt64Max = '9223372036854775808';
const _nineteenNines = '9999999999999999999';

void main() {
  test('accepts governance revisions at the exact int64 ceiling', () async {
    final bundle = await _loadTrust(minimumPolicyVersion: _int64Max);

    expect(bundle, isNotNull);
    expect(bundle!.minimumPolicyVersion, _int64Max);
  });

  test('rejects governance revisions above the int64 ceiling', () async {
    expect(await _loadTrust(minimumPolicyVersion: _aboveInt64Max), isNull);
    expect(await _loadTrust(minimumPolicyVersion: _nineteenNines), isNull);
  });

  test('applies the same ceiling to revocation epochs', () async {
    expect(
      await _loadTrust(
        minimumRevocationEpoch: _int64Max,
        revocationEpoch: _int64Max,
      ),
      isNotNull,
    );
    expect(await _loadTrust(revocationEpoch: _aboveInt64Max), isNull);
    expect(
      await _loadTrust(
        minimumRevocationEpoch: _aboveInt64Max,
        revocationEpoch: _aboveInt64Max,
      ),
      isNull,
    );
  });

  test('separates the boundary as BigInt where double cannot', () {
    // 2^63-1 and 2^63 are the same IEEE-754 double, so any ceiling that routes
    // through `double` — including `BigInt.from(<int literal>)` on dart2js —
    // cannot separate the last valid revision from the first invalid one.
    expect(double.parse(_int64Max) == double.parse(_aboveInt64Max), isTrue);
    expect(BigInt.parse(_int64Max) < BigInt.parse(_aboveInt64Max), isTrue);
    expect(BigInt.parse(_int64Max).toString(), _int64Max);
  });
}

Future<ClinicalContinuityTrustBundle?> _loadTrust({
  String minimumPolicyVersion = '12',
  String minimumRevocationEpoch = '4',
  String revocationEpoch = '4',
}) async {
  final algorithm = Ed25519();
  final keyPair = await algorithm.newKeyPair();
  final extracted = await keyPair.extract();
  final pem = _publicKeyPem(extracted.publicKey.bytes);
  final pemHash = _hex((await Sha256().hash(utf8.encode(pem))).bytes);
  final trust = <String, Object?>{
    'algorithm': 'Ed25519',
    'audience': {'facilityId': _facilityId, 'tenantId': _tenantId},
    'distribution': 'operator_provisioned_out_of_band',
    'format': 'vhhealth_clinical_continuity_trust/v1',
    'minimumPolicyVersion': minimumPolicyVersion,
    'minimumRevocationEpoch': minimumRevocationEpoch,
    'packSigningKeys': [
      {
        'algorithm': 'Ed25519',
        'keyId': _packKeyId,
        'publicKeySha256': pemHash,
        'publicKeySpkiPem': pem,
        'state': 'current',
      },
    ],
    'policySigningKey': {
      'algorithm': 'Ed25519',
      'keyId': _policyKeyId,
      'publicKeySha256': pemHash,
      'publicKeySpkiPem': pem,
    },
    'refusalPolicy': {
      'compromisedOrRevokedKey': 'reject_pack_use_paper_and_phone',
      'uncertainClock': 'refuse_as_current_use_paper_and_phone',
      'versionRollback': 'reject_pack_use_paper_and_phone',
    },
    'revocationEpoch': revocationEpoch,
    'revokedKeyIds': <String>[],
  };

  final store = ClinicalContinuityTrustStore(
    reader: _MemoryTrustReader(
      ClinicalContinuityCanonicalJson.canonicalize(trust),
    ),
  );
  return store.load(
    expectedAudience: const ClinicalContinuityAudience(
      tenantId: _tenantId,
      facilityId: _facilityId,
    ),
  );
}

class _MemoryTrustReader implements ClinicalContinuityTrustReader {
  const _MemoryTrustReader(this.value);

  final String value;

  @override
  Future<String?> read() async => value;
}

String _publicKeyPem(List<int> raw) {
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
  final body = base64Encode([...prefix, ...raw]);
  return '-----BEGIN PUBLIC KEY-----\n$body\n-----END PUBLIC KEY-----\n';
}

String _hex(List<int> bytes) =>
    bytes.map((value) => value.toRadixString(16).padLeft(2, '0')).join();
