import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/clinical_continuity.dart';
import 'package:vhhealth_core/services/clinical_continuity_facility_context.dart';
import 'package:vhhealth_core/services/clinical_continuity_policy_delivery.dart';
import 'package:vhhealth_staff/core/services/staff_action_policy_source.dart';

const _audience = ClinicalContinuityAudience(
  tenantId: '52e31913-c846-4458-a21b-31cd2f457e9b',
  facilityId: '41',
);
final _now = DateTime.parse('2026-07-31T10:00:00.000Z');

void main() {
  test(
    'backend source returns only exact delivered bytes and provenance',
    () async {
      final delivery = _FakeDeliveryClient(_delivery());
      final source = BackendStaffActionPolicySource(
        deliveryClient: delivery,
        facilityContextClient: _FakeContextClient(_context()),
        capabilityGroupsProvider: () async => {'nursing_governance'},
      );

      final result = await source.fetch(audience: _audience);

      expect(result.policyId, '55555555-5555-4555-8555-555555555555');
      expect(result.policyEnvelopeBytes, [1, 2, 3, 4]);
      expect(result.provenance.sourceRevision, 'etag-1');
      expect(result.capabilityGroups, {'nursing_governance'});
      expect(delivery.facilityId, '41');
      expect(delivery.facilityContextHeader, isNotEmpty);
    },
  );

  test(
    'backend source rejects an absent or mismatched facility context',
    () async {
      final delivery = _FakeDeliveryClient(_delivery());
      final source = BackendStaffActionPolicySource(
        deliveryClient: delivery,
        facilityContextClient: const _FakeContextClient(null),
      );

      await expectLater(
        source.fetch(audience: _audience),
        throwsA(
          isA<StaffActionPolicySourceUnavailable>().having(
            (error) => error.reasonCode,
            'reasonCode',
            'facility_context_unavailable',
          ),
        ),
      );
      expect(delivery.calls, 0);
    },
  );

  test('verified pack source exposes only a complete v2 envelope', () async {
    final source = VerifiedPackStaffActionPolicySource(
      verifiedSetProvider: () => _verifiedSet(),
      trustedClockProvider: () =>
          ClinicalContinuityClockAssessment(trusted: true, trustedNow: _now),
    );

    final result = await source.fetch(audience: _audience);

    expect(result.policyEnvelopeBytes, [9, 8, 7]);
    expect(result.policyId, '55555555-5555-4555-8555-555555555555');
  });

  test('composite falls back only for a transient transport failure', () async {
    final fallback = _StaticSource(_payload());
    final source = CompositeStaffActionPolicySource([
      const _UnavailableSource(
        StaffActionPolicySourceUnavailable(
          'policy_delivery_transport_unavailable',
          allowFallback: true,
        ),
      ),
      fallback,
    ]);

    expect(await source.fetch(audience: _audience), same(fallback.payload));
    expect(fallback.calls, 1);
  });

  test(
    'composite never hides a terminal revocation behind cached pack bytes',
    () async {
      final fallback = _StaticSource(_payload());
      final source = CompositeStaffActionPolicySource([
        const _UnavailableSource(
          StaffActionPolicySourceUnavailable('CONTINUITY_POLICY_REVOKED'),
        ),
        fallback,
      ]);

      await expectLater(
        source.fetch(audience: _audience),
        throwsA(
          isA<StaffActionPolicySourceUnavailable>().having(
            (error) => error.reasonCode,
            'reasonCode',
            'CONTINUITY_POLICY_REVOKED',
          ),
        ),
      );
      expect(fallback.calls, 0);
    },
  );
}

ClinicalContinuityFacilityContext _context() =>
    ClinicalContinuityFacilityContext(
      envelope: const {'format': 'fixture'},
      content: {
        'tenantId': _audience.tenantId,
        'facilityId': _audience.facilityId,
        'staffUid': '22222222-2222-4222-8222-222222222222',
        'deviceId': 'staff-device-1',
        'contextId': '11111111-1111-4111-8111-111111111111',
        'contextRevision': '1',
        'issuedAt': _now.toIso8601String(),
        'expiresAt': _now.add(const Duration(hours: 1)).toIso8601String(),
      },
    );

ClinicalContinuityPolicyDeliveryResult _delivery() =>
    ClinicalContinuityPolicyDeliveryResult(
      policyId: '55555555-5555-4555-8555-555555555555',
      envelopeBytes: Uint8List.fromList([1, 2, 3, 4]),
      etag: 'etag-1',
      contentDigest: 'digest-1',
      clock: ClinicalContinuityClockAssessment(trusted: true, trustedNow: _now),
      provenance: const ClinicalContinuitySourceProvenance(
        sourceRevision: 'etag-1',
        sourceWatermark: 'digest-1',
      ),
    );

StaffActionPolicySourcePayload _payload() => StaffActionPolicySourcePayload(
  policyId: '55555555-5555-4555-8555-555555555555',
  policyEnvelopeBytes: Uint8List.fromList([9, 8, 7]),
  provenance: const ClinicalContinuitySourceProvenance(
    sourceRevision: 'pack-1',
    sourceWatermark: 'watermark-1',
  ),
  clock: ClinicalContinuityClockAssessment(trusted: true, trustedNow: _now),
  capabilityGroups: const {},
);

VerifiedClinicalContinuitySet _verifiedSet() => VerifiedClinicalContinuitySet(
  audience: _audience,
  facilityName: 'VH Central',
  facilityTimezone: 'Asia/Kolkata',
  policyId: '55555555-5555-4555-8555-555555555555',
  packCompositionVersion: '2',
  policyEnvelopeBytes: Uint8List.fromList([9, 8, 7]),
  policyEnvelopeSha256: 'a' * 64,
  publicationSetId: '66666666-6666-4666-8666-666666666666',
  localUnlockPolicy: const ClinicalContinuityLocalUnlockPolicy(
    authenticationMode: 'mtls_client_certificate',
    maximumAuthorizationMinutes: 37,
    emergencyReadPosture: 'disabled',
  ),
  localGrants: const [],
  prefetchSession: ClinicalContinuitySessionContext(
    tenantId: _audience.tenantId,
    facilityId: _audience.facilityId,
    staffId: '22222222-2222-4222-8222-222222222222',
    role: 'NURSING_STAFF',
    deviceId: 'staff-device-1',
    authenticatedAt: _now,
  ),
  provenance: const ClinicalContinuitySourceProvenance(
    sourceRevision: 'pack-1',
    sourceWatermark: 'watermark-1',
    accessRevision: '11',
  ),
  signingKeyFingerprints: const {'key-1': 'fingerprint-1'},
  floors: ClinicalContinuityFloors(
    packCompositionVersion: '2',
    policyVersion: '7',
    manifestVersion: '9',
    revocationEpoch: '3',
    trustedNow: _now,
  ),
  generatedAt: _now,
  expiresAt: _now.add(const Duration(hours: 4)),
  evaluatedAt: _now,
  packs: const [],
  verifiedByteLength: 3,
);

class _FakeDeliveryClient extends ClinicalContinuityPolicyDeliveryClient {
  _FakeDeliveryClient(this.result);

  final ClinicalContinuityPolicyDeliveryResult result;
  int calls = 0;
  String? facilityId;
  String? facilityContextHeader;

  @override
  Future<ClinicalContinuityPolicyDeliveryResult> fetch({
    required String facilityId,
    required String facilityContextHeader,
  }) async {
    calls += 1;
    this.facilityId = facilityId;
    this.facilityContextHeader = facilityContextHeader;
    return result;
  }
}

class _FakeContextClient extends ClinicalContinuityFacilityContextClient {
  const _FakeContextClient(this.value);

  final ClinicalContinuityFacilityContext? value;

  @override
  Future<ClinicalContinuityFacilityContext?> current() async => value;
}

class _StaticSource implements StaffActionPolicySource {
  _StaticSource(this.payload);

  final StaffActionPolicySourcePayload payload;
  int calls = 0;

  @override
  Future<StaffActionPolicySourcePayload> fetch({
    required ClinicalContinuityAudience audience,
  }) async {
    calls += 1;
    return payload;
  }
}

class _UnavailableSource implements StaffActionPolicySource {
  const _UnavailableSource(this.error);

  final StaffActionPolicySourceUnavailable error;

  @override
  Future<StaffActionPolicySourcePayload> fetch({
    required ClinicalContinuityAudience audience,
  }) => Future.error(error);
}
