import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/clinical_continuity_canonical_json.dart';
import 'package:vhhealth_core/services/clinical_continuity_facility_context.dart';
import 'package:vhhealth_core/services/clinical_continuity_trust_store.dart';

const _tenantId = '52e31913-c846-4458-a21b-31cd2f457e9b';
const _staffUid = '22222222-2222-4222-8222-222222222222';
const _deviceId = '33333333-3333-4333-8333-333333333333';
const _sessionJti = 'session-jti-1';
const _facilityId = '41';
const _packKeyId = 'pack-key-1';
const _policyKeyId = 'policy-key-1';

void main() {
  test('verifies, freezes, and encodes the exact signed context', () async {
    final fixture = await _Fixture.build();
    final rawContent = fixture.envelope['content']! as Map<String, Object?>;

    final result = await fixture.verifier.verify(
      fixture.envelope,
      tenantId: _tenantId,
      facilityId: _facilityId,
      staffUid: _staffUid,
      deviceId: _deviceId,
      sessionJti: _sessionJti,
      trustedNow: DateTime.parse('2026-07-30T01:10:00.000Z'),
    );

    expect(result, isNotNull);
    expect(result!.contextRevision, '31');
    expect(
      utf8.decode(base64Url.decode(base64Url.normalize(result.headerValue))),
      ClinicalContinuityCanonicalJson.canonicalize(result.envelope),
    );
    rawContent['facilityId'] = '99';
    expect(result.facilityId, _facilityId);
    expect(() => result.content['facilityId'] = '99', throwsUnsupportedError);
  });

  test('rejects purpose, session, signature, and audience drift', () async {
    final fixture = await _Fixture.build(grantPurpose: 'edge_read');

    expect(
      await fixture.verifier.verify(
        fixture.envelope,
        tenantId: _tenantId,
        facilityId: _facilityId,
        staffUid: _staffUid,
        deviceId: _deviceId,
        sessionJti: _sessionJti,
        trustedNow: DateTime.parse('2026-07-30T01:10:00.000Z'),
      ),
      isNull,
    );

    final valid = await _Fixture.build();
    expect(
      await valid.verifier.verify(
        valid.envelope,
        tenantId: _tenantId,
        facilityId: _facilityId,
        staffUid: _staffUid,
        deviceId: _deviceId,
        sessionJti: 'different-session',
        trustedNow: DateTime.parse('2026-07-30T01:10:00.000Z'),
      ),
      isNull,
    );
    final tampered = Map<String, Object?>.from(valid.envelope);
    tampered['signature'] = base64Encode(List<int>.filled(64, 0));
    expect(
      await valid.verifier.verify(
        tampered,
        tenantId: _tenantId,
        facilityId: _facilityId,
        staffUid: _staffUid,
        deviceId: _deviceId,
        sessionJti: _sessionJti,
        trustedNow: DateTime.parse('2026-07-30T01:10:00.000Z'),
      ),
      isNull,
    );
    expect(
      await valid.verifier.verify(
        valid.envelope,
        tenantId: _tenantId,
        facilityId: '42',
        staffUid: _staffUid,
        deviceId: _deviceId,
        sessionJti: _sessionJti,
        trustedNow: DateTime.parse('2026-07-30T01:10:00.000Z'),
      ),
      isNull,
    );
  });
}

class _Fixture {
  const _Fixture({required this.verifier, required this.envelope});

  final ClinicalContinuityFacilityContextVerifier verifier;
  final Map<String, Object?> envelope;

  static Future<_Fixture> build({
    String grantPurpose = 'capture_staff_facility',
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
      'minimumPolicyVersion': '12',
      'minimumRevocationEpoch': '4',
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
      'revocationEpoch': '4',
      'revokedKeyIds': <String>[],
    };
    final content = <String, Object?>{
      'captureRevision': '21',
      'contextId': '66666666-6666-4666-8666-666666666666',
      'contextRevision': '31',
      'deviceId': _deviceId,
      'effectiveFrom': '2026-07-30T00:00:00.000Z',
      'expiresAt': '2026-07-30T01:30:00.000Z',
      'facilityId': _facilityId,
      'format': clinicalContinuityFacilityContextFormat,
      'grantId': '44444444-4444-4444-8444-444444444444',
      'grantPurpose': grantPurpose,
      'issuedAt': '2026-07-30T01:00:00.000Z',
      'policyChecksum': List.filled(64, 'a').join(),
      'policyId': '55555555-5555-4555-8555-555555555555',
      'policySigningKeyId': _policyKeyId,
      'policyVersion': '12',
      'revocationEpoch': '4',
      'sessionJtiSha256': _hex(
        (await Sha256().hash(utf8.encode(_sessionJti))).bytes,
      ),
      'staffUid': _staffUid,
      'tenantId': _tenantId,
    };
    final canonicalContent = ClinicalContinuityCanonicalJson.canonicalBytes(
      content,
    );
    final signature = await algorithm.sign(canonicalContent, keyPair: keyPair);
    final envelope = <String, Object?>{
      'algorithm': 'Ed25519',
      'content': content,
      'contentHash': _hex((await Sha256().hash(canonicalContent)).bytes),
      'keyId': _packKeyId,
      'signature': base64Encode(signature.bytes),
    };
    return _Fixture(
      envelope: envelope,
      verifier: ClinicalContinuityFacilityContextVerifier(
        trustStore: ClinicalContinuityTrustStore(
          reader: _MemoryTrustReader(
            ClinicalContinuityCanonicalJson.canonicalize(trust),
          ),
        ),
      ),
    );
  }
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
