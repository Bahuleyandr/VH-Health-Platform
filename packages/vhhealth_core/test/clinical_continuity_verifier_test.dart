import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/clinical_continuity.dart';
import 'package:vhhealth_core/services/clinical_continuity_canonical_json.dart';
import 'package:vhhealth_core/services/clinical_continuity_source.dart';
import 'package:vhhealth_core/services/clinical_continuity_trust_store.dart';
import 'package:vhhealth_core/services/clinical_continuity_verifier.dart';
import 'package:vhhealth_core/services/offline_action_ids.dart';

const _tenantId = '52e31913-c846-4458-a21b-31cd2f457e9b';
const _facilityId = '41';
const _staffId = '22222222-2222-4222-8222-222222222222';
const _deviceId = 'staff-device-1';
const _policyId = '55555555-5555-4555-8555-555555555555';
const _publicationSetId = '66666666-6666-4666-8666-666666666666';
const _grantId = '11111111-1111-4111-8111-111111111111';
const _keyId = 'continuity-pack-current-k1';
const _issuedAt = '2026-07-30T00:00:00.000Z';

void main() {
  test('accepts a fully covered current-key facility set', () async {
    final fixture = await _Fixture.build();

    final result = await fixture.verifier.verify(fixture.snapshot);

    expect(result.ok, isTrue);
    expect(result.reason, isNull);
    expect(result.verifiedSet, isNotNull);
    expect(result.verifiedSet!.packs, hasLength(1));
    expect(
      result.verifiedSet!.packs.single.freshness,
      ClinicalContinuityFreshness.current,
    );
    expect(
      result.verifiedSet!.localUnlockPolicy.maximumAuthorizationMinutes,
      37,
    );
    expect(result.verifiedSet!.localUnlockPolicy.isComplete, isTrue);
    expect(result.verifiedSet!.provenance.accessRevision, '11');
    expect(
      result.verifiedSet!.signingKeyFingerprints[_keyId],
      matches(RegExp(r'^[0-9a-f]{64}$')),
    );
  });

  test(
    'accepts a next signing key while retaining a current trust root',
    () async {
      final fixture = await _Fixture.build(keyState: 'next');

      final result = await fixture.verifier.verify(fixture.snapshot);

      expect(result.ok, isTrue);
    },
  );

  test('classifies revoked and compromised signing keys', () async {
    final revoked = await _Fixture.build(revoked: true);
    final compromised = await _Fixture.build(keyState: 'compromised');

    final revokedResult = await revoked.verifier.verify(revoked.snapshot);
    final compromisedResult = await compromised.verifier.verify(
      compromised.snapshot,
    );

    expect(
      revokedResult.reason,
      ClinicalContinuityVerificationReasons.keyRevoked,
    );
    expect(
      compromisedResult.reason,
      ClinicalContinuityVerificationReasons.keyCompromised,
    );
    expect(revokedResult.verifiedSet, isNull);
    expect(compromisedResult.verifiedSet, isNull);
  });

  test('rejects a tampered asset without exposing clinical content', () async {
    final fixture = await _Fixture.build();
    final assets = Map<String, Uint8List>.from(fixture.snapshot.assets);
    assets['locations/ward/ward-10/pack.html'] = Uint8List.fromList(
      utf8.encode('tampered'),
    );

    final result = await fixture.verifier.verify(
      fixture.snapshot.copyWith(assets: assets),
    );

    expect(
      result.reason,
      ClinicalContinuityVerificationReasons.assetHashMismatch,
    );
    expect(result.verifiedSet, isNull);
  });

  test('rejects duplicate JSON members before signature processing', () async {
    final fixture = await _Fixture.build();
    final raw = utf8.decode(fixture.snapshot.manifestEnvelopeBytes);
    final hostile = raw.replaceFirst(
      '"algorithm":',
      '"algorithm":"Ed25519","algorithm":',
    );

    final result = await fixture.verifier.verify(
      fixture.snapshot.copyWith(
        manifestEnvelopeBytes: Uint8List.fromList(utf8.encode(hostile)),
      ),
    );

    expect(
      result.reason,
      ClinicalContinuityVerificationReasons.canonicalizationFailed,
    );
  });

  test('rejects a signed audience mismatch and wrong device grant', () async {
    final audienceFixture = await _Fixture.build(envelopeFacilityId: '42');
    final deviceFixture = await _Fixture.build(grantDeviceId: 'other-device');

    final audienceResult = await audienceFixture.verifier.verify(
      audienceFixture.snapshot,
    );
    final deviceResult = await deviceFixture.verifier.verify(
      deviceFixture.snapshot,
    );

    expect(
      audienceResult.reason,
      ClinicalContinuityVerificationReasons.audienceMismatch,
    );
    expect(
      deviceResult.reason,
      ClinicalContinuityVerificationReasons.edgeAccessMismatch,
    );
  });

  test(
    'matches edge grant revision and device-id validation contract',
    () async {
      final priorRevision = await _Fixture.build(grantAccessRevision: '10');
      final whitespaceDevice = await _Fixture.build(
        grantDeviceId: ' staff-device-1',
      );

      expect(
        (await priorRevision.verifier.verify(priorRevision.snapshot)).ok,
        isTrue,
      );
      expect(
        (await whitespaceDevice.verifier.verify(
          whitespaceDevice.snapshot,
        )).reason,
        ClinicalContinuityVerificationReasons.edgeAccessInvalid,
      );
    },
  );

  test('rejects clinical content that includes blood-group data', () async {
    final fixture = await _Fixture.build(includeBloodGroup: true);

    final result = await fixture.verifier.verify(fixture.snapshot);

    expect(
      result.reason,
      ClinicalContinuityVerificationReasons.coverageMismatch,
    );
  });

  test('enforces persisted governance and trusted-clock floors', () async {
    final fixture = await _Fixture.build();
    final policyRollback = await fixture.verifier.verify(
      fixture.snapshot,
      persistedFloors: ClinicalContinuityFloors(
        policyVersion: '8',
        manifestVersion: '9',
        revocationEpoch: '3',
        trustedNow: DateTime.parse(_issuedAt),
      ),
    );
    final manifestRollback = await fixture.verifier.verify(
      fixture.snapshot,
      persistedFloors: ClinicalContinuityFloors(
        policyVersion: '7',
        manifestVersion: '10',
        revocationEpoch: '3',
        trustedNow: DateTime.parse(_issuedAt),
      ),
    );
    final clockRollback = await fixture.verifier.verify(
      fixture.snapshot,
      persistedFloors: ClinicalContinuityFloors(
        policyVersion: '7',
        manifestVersion: '9',
        revocationEpoch: '3',
        trustedNow: DateTime.parse('2026-07-30T00:02:00.000Z'),
      ),
    );

    expect(
      policyRollback.reason,
      ClinicalContinuityVerificationReasons.policyRollback,
    );
    expect(
      manifestRollback.reason,
      ClinicalContinuityVerificationReasons.manifestRollback,
    );
    expect(
      clockRollback.reason,
      ClinicalContinuityVerificationReasons.clockUncertain,
    );
  });

  test(
    'uses inclusive 15-minute current boundary and refuses expiry',
    () async {
      final current = await _Fixture.build(
        trustedNow: '2026-07-30T00:15:00.000Z',
      );
      final aged = await _Fixture.build(trustedNow: '2026-07-30T00:15:00.001Z');
      final expired = await _Fixture.build(
        trustedNow: '2026-07-30T12:00:00.000Z',
        expiresAt: '2026-07-30T12:00:00.000Z',
      );

      final currentResult = await current.verifier.verify(current.snapshot);
      final agedResult = await aged.verifier.verify(aged.snapshot);
      final expiredResult = await expired.verifier.verify(expired.snapshot);

      expect(
        currentResult.verifiedSet!.packs.single.freshness,
        ClinicalContinuityFreshness.current,
      );
      expect(
        agedResult.verifiedSet!.packs.single.freshness,
        ClinicalContinuityFreshness.aged,
      );
      expect(
        expiredResult.reason,
        ClinicalContinuityVerificationReasons.packExpired,
      );
    },
  );

  test(
    'preserves exact signed timestamps with one to three decimals',
    () async {
      final fixture = await _Fixture.build(
        issuedAt: '2026-07-30T00:00:00.0Z',
        trustedNow: '2026-07-30T00:01:00.000Z',
        expiresAt: '2026-07-30T04:00:00.00Z',
      );

      final result = await fixture.verifier.verify(fixture.snapshot);

      expect(result.ok, isTrue);
    },
  );

  test(
    'signed read-only emergency posture does not authorize local unlock',
    () async {
      final fixture = await _Fixture.build(emergencyReadPosture: 'read_only');

      final result = await fixture.verifier.verify(fixture.snapshot);

      expect(result.ok, isTrue);
      expect(result.verifiedSet!.localUnlockPolicy.isComplete, isFalse);
    },
  );

  test('accepts the exact ward, paediatric, ED, and OPD pack shapes', () async {
    for (final locationType in const ['ward', 'paeds', 'ed_board', 'opd_day']) {
      final fixture = await _Fixture.build(locationType: locationType);
      final result = await fixture.verifier.verify(fixture.snapshot);

      expect(result.ok, isTrue, reason: locationType);
      expect(result.verifiedSet!.packs.single.locationType, locationType);
    }
  });

  test(
    'verifies a complete signed v3 action policy and rejects tampering',
    () async {
      final fixture = await _Fixture.build();
      final envelope = await _actionPolicyEnvelope(fixture.signingPair);
      final bytes = ClinicalContinuityCanonicalJson.canonicalBytes(envelope);

      final accepted = await fixture.verifier.verifyActionPolicy(
        envelopeBytes: bytes,
        policyId: _policyId,
        expectedAudience: const ClinicalContinuityAudience(
          tenantId: _tenantId,
          facilityId: _facilityId,
        ),
        clock: fixture.snapshot.clock,
      );

      expect(accepted.ok, isTrue);
      expect(
        accepted.verifiedPolicy!.actions.keys.toSet(),
        OfflineActionIds.values.difference(const {OfflineActionIds.unknown}),
      );
      expect(accepted.verifiedPolicy!.registryVersion, '5');
      expect(accepted.verifiedPolicy!.compatibilityRules, isEmpty);
      expect(accepted.verifiedPolicy!.enforcedActionIds, {
        OfflineActionIds.nursingNoteDraftStore,
        OfflineActionIds.opNoteDraftStore,
      });
      expect(accepted.verifiedPolicy!.minimumAppVersions['desktop'], '1.2.0');

      final tampered = utf8.decode(bytes).replaceFirst('"1.2.0"', '"1.1.0"');
      final rejected = await fixture.verifier.verifyActionPolicy(
        envelopeBytes: Uint8List.fromList(utf8.encode(tampered)),
        policyId: _policyId,
        expectedAudience: const ClinicalContinuityAudience(
          tenantId: _tenantId,
          facilityId: _facilityId,
        ),
        clock: fixture.snapshot.clock,
      );
      expect(
        rejected.reason,
        ClinicalContinuityVerificationReasons.signatureInvalid,
      );
    },
  );

  test('signed v3 registry and action shapes are closed', () async {
    final fixture = await _Fixture.build();
    final baseline = await _actionPolicyEnvelope(fixture.signingPair);

    final registryExtra = _mutableJson(baseline);
    final registryDocument = _mapForTest(registryExtra['policyDocument']);
    final registry = _mapForTest(registryDocument['actionRegistry']);
    registry['unexpected'] = true;
    registryDocument['actionRegistry'] = registry;
    registryExtra['policyDocument'] = registryDocument;
    await _rehashAndSignActionPolicy(registryExtra, fixture.signingPair);
    final rejectedRegistry = await fixture.verifier.verifyActionPolicy(
      envelopeBytes: ClinicalContinuityCanonicalJson.canonicalBytes(
        registryExtra,
      ),
      policyId: _policyId,
      expectedAudience: const ClinicalContinuityAudience(
        tenantId: _tenantId,
        facilityId: _facilityId,
      ),
      clock: fixture.snapshot.clock,
    );
    expect(
      rejectedRegistry.reason,
      ClinicalContinuityVerificationReasons.actionRegistryInvalid,
    );

    final actionExtra = _mutableJson(baseline);
    final actionDocument = _mapForTest(actionExtra['policyDocument']);
    final actionRegistry = _mapForTest(actionDocument['actionRegistry']);
    final actions = actionRegistry['actions']! as List<dynamic>;
    final action = _mapForTest(actions.first);
    action['unexpected'] = true;
    await _rehashAction(action);
    actions[0] = action;
    actionRegistry['actions'] = actions;
    actionDocument['actionRegistry'] = actionRegistry;
    actionExtra['policyDocument'] = actionDocument;
    await _rehashAndSignActionPolicy(actionExtra, fixture.signingPair);
    final rejectedAction = await fixture.verifier.verifyActionPolicy(
      envelopeBytes: ClinicalContinuityCanonicalJson.canonicalBytes(
        actionExtra,
      ),
      policyId: _policyId,
      expectedAudience: const ClinicalContinuityAudience(
        tenantId: _tenantId,
        facilityId: _facilityId,
      ),
      clock: fixture.snapshot.clock,
    );
    expect(
      rejectedAction.reason,
      ClinicalContinuityVerificationReasons.actionRegistryInvalid,
    );
  });
}

class _Fixture {
  final ClinicalContinuityVerifier verifier;
  final ClinicalContinuitySourceSnapshot snapshot;
  final KeyPair signingPair;

  const _Fixture({
    required this.verifier,
    required this.snapshot,
    required this.signingPair,
  });

  static Future<_Fixture> build({
    String keyState = 'current',
    bool revoked = false,
    String issuedAt = _issuedAt,
    String trustedNow = '2026-07-30T00:01:00.000Z',
    String expiresAt = '2026-07-30T04:00:00.000Z',
    String envelopeFacilityId = _facilityId,
    String grantDeviceId = _deviceId,
    String grantAccessRevision = '11',
    String emergencyReadPosture = 'disabled',
    bool includeBloodGroup = false,
    String locationType = 'ward',
  }) async {
    final algorithm = Ed25519();
    final signingPair = await algorithm.newKeyPair();
    final signingPublic = await signingPair.extractPublicKey();
    final audience = {'tenantId': _tenantId, 'facilityId': envelopeFacilityId};
    final locationId = switch (locationType) {
      'ward' => 'ward-10',
      'paeds' => 'paeds-10',
      'ed_board' => 'ed-main',
      'opd_day' => 'opd-2026-07-30',
      _ => throw ArgumentError.value(locationType),
    };
    final locationLabel = switch (locationType) {
      'ward' => 'Ward 10',
      'paeds' => 'Paediatric Ward 10',
      'ed_board' => 'Emergency department',
      'opd_day' => 'OPD 30 Jul 2026',
      _ => locationId,
    };
    final htmlBytes = Uint8List.fromList(
      utf8.encode(
        '<!doctype html><p>VALID THROUGH $expiresAt</p>'
        '<p>Verified $locationType pack</p>'
        '${locationType == 'opd_day' ? '<p>Destroy after clinic day</p>' : ''}',
      ),
    );
    final fieldSource = 'synthetic.test';
    Map<String, Object?> known(Object? value) => {
      'state': 'known',
      'value': value,
      'recorded_at': issuedAt,
      'source': fieldSource,
      'timestamp_basis': 'source_recorded_at',
    };
    Map<String, Object?> unknown(String reason) => {
      'state': 'unknown',
      'value': null,
      'recorded_at': null,
      'source': fieldSource,
      'timestamp_basis': 'not_available',
      'reason': reason,
    };
    final packContent = <String, Object?>{
      'pack_schema_version': 1,
      'tenant_id': _tenantId,
      'facility': {
        'id': _facilityId,
        'code': 'VHC',
        'name': 'VH Central',
        'timezone': 'Asia/Kolkata',
      },
      'location': {
        'type': locationType,
        'id': locationId,
        'identifier': locationId,
        'label': locationLabel,
        if (locationType == 'ward' || locationType == 'paeds') ...{
          'ward_id': '10',
          'area_profile': locationType,
        },
      },
      'policy': {'id': _policyId, 'version': '7', 'revocation_epoch': '3'},
      'source_watermark': {
        'captured_at': issuedAt,
        'txid_snapshot': '100:100:',
        'transaction_id': '100',
        'transaction_isolation': 'repeatable read',
      },
      'generated_at': issuedAt,
      'fresh_until': DateTime.parse(
        issuedAt,
      ).add(const Duration(minutes: 15)).toUtc().toIso8601String(),
      'expires_at': expiresAt,
      'not_valid_after': expiresAt,
      'historical_mode': false,
      'patients': [
        {
          'identity': known({
            'name': known('Test Patient'),
            'mrn': known('MRN-001'),
            'uid': known('77777777-7777-4777-8777-777777777777'),
            'dob': known('2000-01-01'),
            'identity_status': 'identified',
          }),
          'allergies': unknown('Allergy status is not recorded'),
          'code_status': unknown('Code status is not recorded'),
          'isolation': known('Contact precautions'),
          'location': known({'location_id': locationId}),
          'attending': known({'name': 'Dr Test', 'display': 'Dr Test'}),
          'diagnosis': known('Synthetic diagnosis'),
          'latest_vitals': known(<Object?>[]),
          'news2': known(0),
          'medications_due': known(<Object?>[]),
          'active_medication_orders': known(<Object?>[]),
          'recently_administered_medications': known(<Object?>[]),
          'unresolved_critical_results': known(<Object?>[]),
          'recent_released_results': known(<Object?>[]),
          'care_team': known(<Object?>[]),
          if (locationType == 'paeds') 'latest_weight': known('18.5 kg'),
          if (locationType == 'ed_board') ...{
            'arrival_at': known(issuedAt),
            'triage': known({'level': 'urgent'}),
            'time_in_department': known({'minutes': 30}),
          },
          if (locationType == 'opd_day') ...{
            'appointment_time': known(issuedAt),
            'appointment_status': known('scheduled'),
            'phone': known('+91-0000000000'),
          },
          if (includeBloodGroup) 'blood_group': 'A+',
        },
      ],
      if (locationType == 'opd_day')
        'handling': {'printed_sheet': 'DESTROY AFTER CLINIC DAY'},
    };
    final packEnvelope = await _signedEnvelope(
      content: packContent,
      rendered: htmlBytes,
      keyPair: signingPair,
      audience: audience,
      issuedAt: issuedAt,
      expiresAt: expiresAt,
    );
    final packJsonBytes = Uint8List.fromList(
      utf8.encode('${jsonEncode(packEnvelope)}\n'),
    );

    final grantUntil = DateTime.parse(
      issuedAt,
    ).add(const Duration(hours: 4)).toUtc().toIso8601String();
    final edgeContent = <String, Object?>{
      'accessRevision': '11',
      'audience': audience,
      'edgeAccess': {
        'authenticationMode': 'mtls_client_certificate',
        'credentialLifetimeMinutes': 720,
        'emergencyReadPosture': emergencyReadPosture,
        'maximumOfflineAuthorizationMinutes': 37,
      },
      'format': 'vhhealth_continuity_edge_access/v1',
      'generatedAt': issuedAt,
      'grants': [
        {
          'accessRevision': grantAccessRevision,
          'clientCertificateSha256': 'a' * 64,
          'deviceId': grantDeviceId,
          'grantId': _grantId,
          'locationIdentifier': locationId,
          'locationType': locationType,
          'staffUid': _staffId,
          'validFrom': issuedAt,
          'validUntil': grantUntil,
        },
      ],
      'policy': {'id': _policyId, 'version': '7', 'revocationEpoch': '3'},
      'revocations': <Object?>[],
    };
    final edgeRendered = ClinicalContinuityCanonicalJson.canonicalBytes(
      edgeContent,
    );
    final edgeEnvelope = await _signedEnvelope(
      content: edgeContent,
      rendered: edgeRendered,
      keyPair: signingPair,
      audience: audience,
      issuedAt: issuedAt,
      expiresAt: expiresAt,
    );
    final edgeJsonBytes = Uint8List.fromList(
      utf8.encode('${jsonEncode(edgeEnvelope)}\n'),
    );

    final manifestContent = <String, Object?>{
      'edgeAccess': {
        'accessRevision': '11',
        'path': 'edge-access.json',
        'sha256': await _sha256Hex(edgeJsonBytes),
      },
      'facility': {
        'id': _facilityId,
        'name': 'VH Central',
        'timezone': 'Asia/Kolkata',
      },
      'format': 'vhhealth_clinical_continuity_manifest/v1',
      'generatedAt': issuedAt,
      'locations': [
        {
          'contentHash': packEnvelope['contentHash'],
          'expiresAt': expiresAt,
          'generatedAt': issuedAt,
          'keyId': _keyId,
          'locationId': locationId,
          'locationType': locationType,
          'packHtmlSha256': await _sha256Hex(htmlBytes),
          'packJsonSha256': await _sha256Hex(packJsonBytes),
          'renderHash': packEnvelope['renderHash'],
        },
      ],
      'manifestVersion': '9',
      'publicationSetId': _publicationSetId,
      'policy': {
        'checksum': 'b' * 64,
        'id': _policyId,
        'revocationEpoch': '3',
        'version': '7',
      },
      'sourceWatermark': {'generatedAt': issuedAt},
      'tenantId': _tenantId,
    };
    final manifestEnvelope = await _signedEnvelope(
      content: manifestContent,
      rendered: ClinicalContinuityCanonicalJson.canonicalBytes(manifestContent),
      keyPair: signingPair,
      audience: audience,
      issuedAt: issuedAt,
      expiresAt: expiresAt,
    );
    final manifestBytes = Uint8List.fromList(
      utf8.encode('${jsonEncode(manifestEnvelope)}\n'),
    );

    final signingPem = _publicKeyPem(signingPublic.bytes);
    final signingKey = await _trustedKey(
      keyId: _keyId,
      pem: signingPem,
      state: keyState,
    );
    final packKeys = <Object?>[signingKey];
    if (keyState != 'current') {
      final currentPair = await algorithm.newKeyPair();
      final currentPublic = await currentPair.extractPublicKey();
      packKeys.add(
        await _trustedKey(
          keyId: 'continuity-pack-current-root',
          pem: _publicKeyPem(currentPublic.bytes),
          state: 'current',
        ),
      );
    }
    final policyKey = Map<String, Object?>.from(signingKey)..remove('state');
    final trustJson = <String, Object?>{
      'algorithm': 'Ed25519',
      'audience': {'facilityId': _facilityId, 'tenantId': _tenantId},
      'distribution': 'operator_provisioned_out_of_band',
      'format': 'vhhealth_clinical_continuity_trust/v1',
      'minimumPolicyVersion': '7',
      'minimumRevocationEpoch': '3',
      'packSigningKeys': packKeys,
      'policySigningKey': policyKey,
      'refusalPolicy': {
        'compromisedOrRevokedKey': 'reject_pack_use_paper_and_phone',
        'uncertainClock': 'refuse_as_current_use_paper_and_phone',
        'versionRollback': 'reject_pack_use_paper_and_phone',
      },
      'revocationEpoch': '3',
      'revokedKeyIds': revoked ? [_keyId] : <String>[],
    };
    final verifier = ClinicalContinuityVerifier(
      trustStore: ClinicalContinuityTrustStore(
        reader: _TrustReader(jsonEncode(trustJson)),
      ),
    );
    final session = ClinicalContinuitySessionContext(
      tenantId: _tenantId,
      facilityId: _facilityId,
      staffId: _staffId,
      role: 'nurse',
      deviceId: _deviceId,
      authenticatedAt: DateTime.parse(issuedAt),
    );
    return _Fixture(
      verifier: verifier,
      signingPair: signingPair,
      snapshot: ClinicalContinuitySourceSnapshot(
        manifestEnvelopeBytes: manifestBytes,
        assets: {
          'edge-access.json': edgeJsonBytes,
          'locations/$locationType/$locationId/pack.json': packJsonBytes,
          'locations/$locationType/$locationId/pack.html': htmlBytes,
        },
        session: session,
        clock: ClinicalContinuityClockAssessment(
          trusted: true,
          trustedNow: DateTime.parse(trustedNow),
          minimumTrustedNow: DateTime.parse(issuedAt),
        ),
        provenance: const ClinicalContinuitySourceProvenance(
          sourceRevision: 'source-17',
          sourceWatermark: 'untrusted-source-watermark',
          accessRevision: '11',
        ),
      ),
    );
  }
}

class _TrustReader implements ClinicalContinuityTrustReader {
  final String value;

  const _TrustReader(this.value);

  @override
  Future<String?> read() async => value;
}

extension on ClinicalContinuitySourceSnapshot {
  ClinicalContinuitySourceSnapshot copyWith({
    Uint8List? manifestEnvelopeBytes,
    Map<String, Uint8List>? assets,
  }) {
    return ClinicalContinuitySourceSnapshot(
      manifestEnvelopeBytes:
          manifestEnvelopeBytes ?? this.manifestEnvelopeBytes,
      assets: assets ?? this.assets,
      session: session,
      clock: clock,
      provenance: provenance,
    );
  }
}

Future<Map<String, Object?>> _signedEnvelope({
  required Object? content,
  required Uint8List rendered,
  required KeyPair keyPair,
  required Map<String, Object?> audience,
  required String issuedAt,
  required String expiresAt,
}) async {
  final unsigned = <String, Object?>{
    'algorithm': 'Ed25519',
    'audience': audience,
    'content': content,
    'contentHash': await _sha256Hex(
      ClinicalContinuityCanonicalJson.canonicalBytes(content),
    ),
    'envelopeVersion': 1,
    'expiresAt': expiresAt,
    'issuedAt': issuedAt,
    'keyId': _keyId,
    'manifestVersion': '9',
    'policyVersion': '7',
    'revocationEpoch': '3',
    'renderHash': await _sha256Hex(rendered),
  };
  final signature = await Ed25519().sign(
    ClinicalContinuityCanonicalJson.canonicalBytes(unsigned),
    keyPair: keyPair,
  );
  return {...unsigned, 'signature': base64Encode(signature.bytes)};
}

Future<Map<String, Object?>> _trustedKey({
  required String keyId,
  required String pem,
  required String state,
}) async {
  return {
    'algorithm': 'Ed25519',
    'keyId': keyId,
    'publicKeySha256': await _sha256Hex(utf8.encode(pem)),
    'publicKeySpkiPem': pem,
    'state': state,
  };
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

Future<String> _sha256Hex(List<int> bytes) async {
  final digest = await Sha256().hash(bytes);
  return digest.bytes
      .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();
}

Future<Map<String, Object?>> _actionPolicyEnvelope(KeyPair keyPair) async {
  const effectiveUntil = '2026-07-30T04:00:00.000Z';
  final actions = <Map<String, Object?>>[];
  for (final actionId in OfflineActionIds.values.difference(const {
    OfflineActionIds.unknown,
  }).toList()..sort()) {
    actions.add(await _c4_2Action(actionId));
  }

  final registryProjection = <String, Object?>{
    'actions': actions,
    'activation': {
      'enforcedActionIds': const [
        OfflineActionIds.nursingNoteDraftStore,
        OfflineActionIds.opNoteDraftStore,
      ],
      'mode': 'enforce',
    },
    'approvalEvidence': _cD3Approval,
    'audience': {
      'devicePostures': const ['desktop', 'tablet'],
    },
    'compatibilityRules': const [],
    'expiresAt': effectiveUntil,
    'issuedAt': _issuedAt,
    'minimumAppVersions': const {'desktop': '1.2.0', 'tablet': '1.2.0'},
    'registrySchemaVersion': 1,
    'registryVersion': '5',
  };
  final registry = <String, Object?>{
    ...registryProjection,
    'registryChecksum': await _sha256Hex(
      ClinicalContinuityCanonicalJson.canonicalBytes(registryProjection),
    ),
  };
  final document = <String, Object?>{
    'actionRegistry': registry,
    'audience': const {'tenantId': _tenantId, 'facilityId': _facilityId},
    'edgeAccess': const <String, Object?>{},
    'fieldPolicy': const <String, Object?>{},
    'generation': const <String, Object?>{},
    'includedAreas': const <String, Object?>{},
    'medicationsDueWindow': const <String, Object?>{},
    'packSchemaVersion': 1,
    'policySchemaVersion': 3,
    'policyType': 'clinical_continuity_pack',
    'recentReleasedResults': const <String, Object?>{},
    'requiredCoverage': const <String, Object?>{},
    'retention': const <String, Object?>{},
  };
  final policyPublicKey = await keyPair.extractPublicKey() as SimplePublicKey;
  final policyPublicKeyPem = _publicKeyPem(policyPublicKey.bytes);
  final payload = <String, Object?>{
    'actionRegistryChecksum': registry['registryChecksum'],
    'actionRegistrySchemaVersion': 1,
    'actionRegistryVersion': '5',
    'algorithm': 'Ed25519',
    'audience': const {'tenantId': _tenantId, 'facilityId': _facilityId},
    'canonicalization': 'rfc8785-jcs',
    'currentPackSigningKeyId': 'pack-current-1',
    'currentPackSigningPublicKeySha256': 'a' * 64,
    'effectiveFrom': _issuedAt,
    'effectiveUntil': effectiveUntil,
    'nextPackSigningKeyId': null,
    'nextPackSigningPublicKeySha256': null,
    'policyChecksum': await _sha256Hex(
      ClinicalContinuityCanonicalJson.canonicalBytes(document),
    ),
    'policyDocument': document,
    'policySchemaVersion': 3,
    'policySigningKeyId': _keyId,
    'policySigningPublicKeySha256': await _sha256Hex(
      utf8.encode(policyPublicKeyPem),
    ),
    'policyVersion': '7',
    'revocationEpoch': '3',
    'revokedKeyIds': const <String>[],
    'supersedesPolicyId': null,
  };
  final signature = await Ed25519().sign(
    ClinicalContinuityCanonicalJson.canonicalBytes(payload),
    keyPair: keyPair,
  );
  return {...payload, 'policySignature': base64Encode(signature.bytes)};
}

const _cD3Approval = <String, Object?>{
  'countersignedAt': '2026-07-30',
  'decisionId': 'C-D3',
  'source':
      'docs/continuity/c0-4-owner-decision-dossier.md#c-d3--offline-action-matrix',
};

Future<Map<String, Object?>> _c4_2Action(String actionId) async {
  final captureReady = OfflineActionIds.draftStoreActions.contains(actionId);
  final offlineClass = switch (actionId) {
    OfflineActionIds.opPrescriptionDraft ||
    OfflineActionIds.ipDrugChartDraft => 'local_draft_only',
    OfflineActionIds.marAdministrationBackfill ||
    OfflineActionIds.labSpecimenCollectionBackfill ||
    OfflineActionIds.bloodTransfusionVerificationBackfill =>
      'paper_only_backfill',
    OfflineActionIds.vitalsCapture ||
    OfflineActionIds.nursingNoteDraftStore ||
    OfflineActionIds.opNoteDraftStore => 'queueable_capture',
    _ => 'unknown_default_deny',
  };
  final actionSchema = captureReady
      ? <String, Object?>{
          'checksum': 'b' * 64,
          'id': '$actionId/v1',
          'version': 1,
        }
      : const <String, Object?>{'checksum': null, 'id': 'none', 'version': 0};
  final projection = <String, Object?>{
    'actionId': actionId,
    'actionSchema': actionSchema,
    'actionVersion': 1,
    'allowedRoles': captureReady ? const ['NURSING_STAFF'] : const <String>[],
    'approvalEvidence': _cD3Approval,
    'breakGlass': 'blocked',
    'cachedSourceContract': {
      'mode': captureReady ? 'required' : 'not_capture_ready',
      'sources': captureReady
          ? const [
              {
                'maxAgeMinutes': 1440,
                'sourceId': 'patient_identity',
                'staleAtMinutes': 15,
              },
            ]
          : const <Object?>[],
    },
    'classification': {
      'captureReady': captureReady,
      'clinicalObjectClass': captureReady ? 'draft' : 'non_executable',
      'offlineClass': offlineClass,
    },
    'conflictOwnership': const {
      'outcome': 'needs_review',
      'owner': 'clinical_governance',
    },
    'idempotency': const {
      'contract': 'stable_client_event_and_fingerprint_required',
      'fingerprint': 'rfc8785-jcs-sha256',
    },
    'notifications': const {'contract': 'none'},
    'occurrence': const {
      'lateArrival': 'explicit_compatibility_or_needs_review',
      'occurrenceTime': 'capture_time_required',
    },
    'optimisticConcurrency': const {
      'contract': 'draft_revision_compare_and_swap_required',
    },
    'quarantineOwnership': const {
      'durableState': 'needs_review',
      'owner': 'clinical_governance',
    },
    'replayEndpoint': {
      'bindingId': captureReady ? 'emr.note_draft.store/v1' : 'none',
      'disposition': captureReady
          ? 'private_draft_storage_only'
          : 'electronic_replay_denied',
    },
    'requiredCapabilities': captureReady
        ? const ['clinical_notes']
        : const <String>[],
    'requiredIdentity': const ['actor', 'tenant', 'facility', 'patient'],
    'scope': const {
      'client': 'staff',
      'domain': 'test',
      'facilityScoped': true,
    },
    'sla': const {'contract': 'no_clinical_sla_draft_storage_only'},
    'witness': 'not_applicable',
  };
  return {
    ...projection,
    'actionChecksum': await _sha256Hex(
      ClinicalContinuityCanonicalJson.canonicalBytes(projection),
    ),
  };
}

Map<String, Object?> _mutableJson(Map<String, Object?> value) {
  return Map<String, Object?>.from(
    jsonDecode(jsonEncode(value))! as Map<String, dynamic>,
  );
}

Map<String, Object?> _mapForTest(Object? value) {
  return Map<String, Object?>.from(value! as Map<dynamic, dynamic>);
}

Future<void> _rehashAction(Map<String, Object?> action) async {
  final projection = Map<String, Object?>.from(action)
    ..remove('actionChecksum');
  action['actionChecksum'] = await _sha256Hex(
    ClinicalContinuityCanonicalJson.canonicalBytes(projection),
  );
}

Future<void> _rehashAndSignActionPolicy(
  Map<String, Object?> envelope,
  KeyPair keyPair,
) async {
  final document = _mapForTest(envelope['policyDocument']);
  final registry = _mapForTest(document['actionRegistry']);
  final registryProjection = Map<String, Object?>.from(registry)
    ..remove('registryChecksum');
  registry['registryChecksum'] = await _sha256Hex(
    ClinicalContinuityCanonicalJson.canonicalBytes(registryProjection),
  );
  envelope['actionRegistryChecksum'] = registry['registryChecksum'];
  document['actionRegistry'] = registry;
  envelope['policyDocument'] = document;
  envelope['policyChecksum'] = await _sha256Hex(
    ClinicalContinuityCanonicalJson.canonicalBytes(document),
  );
  final unsigned = Map<String, Object?>.from(envelope)
    ..remove('policySignature');
  final signature = await Ed25519().sign(
    ClinicalContinuityCanonicalJson.canonicalBytes(unsigned),
    keyPair: keyPair,
  );
  envelope['policySignature'] = base64Encode(signature.bytes);
}
