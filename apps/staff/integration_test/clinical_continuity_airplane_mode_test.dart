import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:vhhealth_core/vhhealth_core.dart';
import 'package:vhhealth_staff/features/clinical_continuity/services/staff_continuity_repository.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'prefetched pack opens read-only after transport loss with device factor',
    (tester) async {
      final set = _set();
      var transportAvailable = true;
      final source = _AirplaneSource(set.prefetchSession);
      final cache = _AirplaneCache();
      final unlocker = _AirplaneUnlocker();
      final repository = StaffContinuityRepository(
        source: source,
        verifier: _AirplaneVerifier(set),
        cache: cache,
        readiness: () async => transportAvailable
            ? ClientReadinessOutcome.alwaysReadyForTesting
            : ClientReadinessOutcome.notReady,
        unlocker: unlocker,
        cacheEnabled: true,
        localUnlockEnabled: true,
      );

      expect(await repository.requestRefresh(), isTrue);
      expect(cache.stored, same(set));
      expect(source.fetchCalls, 1);

      transportAvailable = false;
      final offline = await repository.openCached();

      expect(offline.allowed, isTrue);
      expect(offline.mode, ClinicalContinuityAccessMode.localUnlock);
      expect(offline.verifiedSet, same(set));
      expect(unlocker.calls, 1);
      expect(source.fetchCalls, 1);

      source.session = ClinicalContinuitySessionContext(
        tenantId: set.audience.tenantId,
        facilityId: set.audience.facilityId,
        staffId: 'different-staff',
        role: set.prefetchSession.role,
        deviceId: set.prefetchSession.deviceId,
        authenticatedAt: set.prefetchSession.authenticatedAt,
      );
      final wrongStaff = await repository.openCached();
      expect(wrongStaff.allowed, isFalse);
      expect(unlocker.calls, 1);

      source.session = set.prefetchSession;
      source.clock = ClinicalContinuityClockAssessment(
        trusted: true,
        trustedNow: set.prefetchSession.authenticatedAt.add(
          const Duration(hours: 12, milliseconds: 1),
        ),
      );
      final expiredAuthorization = await repository.openCached();
      expect(expiredAuthorization.allowed, isFalse);
      expect(expiredAuthorization.denialReason, 'LOCAL_AUTHORIZATION_EXPIRED');
      expect(unlocker.calls, 1);

      repository.dispose();
    },
  );
}

class _AirplaneSource implements ClinicalContinuitySource {
  ClinicalContinuitySessionContext session;
  ClinicalContinuityClockAssessment clock;
  int fetchCalls = 0;

  _AirplaneSource(this.session)
    : clock = ClinicalContinuityClockAssessment(
        trusted: true,
        trustedNow: session.authenticatedAt.add(const Duration(minutes: 5)),
      );

  @override
  Future<ClinicalContinuityClockAssessment> assessClock() async => clock;

  @override
  Future<void> cancel() async {}

  @override
  Future<ClinicalContinuitySessionContext?> currentSession() async => session;

  @override
  Future<ClinicalContinuitySourceSnapshot> fetchFacilitySet() async {
    fetchCalls += 1;
    return ClinicalContinuitySourceSnapshot(
      manifestEnvelopeBytes: Uint8List(0),
      assets: const {},
      session: session,
      clock: clock,
      provenance: const ClinicalContinuitySourceProvenance(
        sourceRevision: 'source-17',
        sourceWatermark: 'source-watermark',
        accessRevision: '11',
      ),
    );
  }
}

class _AirplaneVerifier extends ClinicalContinuityVerifier {
  final VerifiedClinicalContinuitySet set;

  _AirplaneVerifier(this.set);

  @override
  Future<ClinicalContinuityVerificationResult> verify(
    ClinicalContinuitySourceSnapshot snapshot, {
    ClinicalContinuityFloors? persistedFloors,
  }) async => ClinicalContinuityVerificationResult.accepted(set);
}

class _AirplaneCache extends ClinicalContinuityCache {
  VerifiedClinicalContinuitySet? stored;

  @override
  Future<ClinicalContinuityFloors?> readFloors({
    required String tenantId,
    required String facilityId,
  }) async => stored?.floors;

  @override
  Future<ClinicalContinuityCacheWriteResult> store(
    VerifiedClinicalContinuitySet set,
  ) async {
    stored = set;
    return const ClinicalContinuityCacheWriteResult.stored();
  }

  @override
  Future<ClinicalContinuityCacheReadResult> open({
    required ClinicalContinuitySessionContext session,
    required ClinicalContinuityClockAssessment clock,
  }) async => ClinicalContinuityCacheReadResult.opened(stored!);

  @override
  Future<void> close() async {}
}

class _AirplaneUnlocker implements StaffContinuityDeviceUnlocker {
  int calls = 0;

  @override
  Future<ClinicalContinuityLocalFactor?> unlock() async {
    calls += 1;
    return ClinicalContinuityLocalFactor.devicePinOrBiometric;
  }
}

VerifiedClinicalContinuitySet _set() {
  final generatedAt = DateTime.parse('2026-07-30T00:00:00.000Z');
  final session = ClinicalContinuitySessionContext(
    tenantId: '52e31913-c846-4458-a21b-31cd2f457e9b',
    facilityId: '41',
    staffId: '22222222-2222-4222-8222-222222222222',
    role: 'nurse',
    deviceId: 'staff-device-1',
    authenticatedAt: generatedAt,
  );
  final pack = ClinicalContinuityPack(
    locationType: 'ward',
    locationId: 'ward-10',
    locationLabel: 'Ward 10',
    content: const {'patients': <Object?>[]},
    htmlBytes: Uint8List(0),
    generatedAt: generatedAt,
    expiresAt: generatedAt.add(const Duration(hours: 24)),
    freshness: ClinicalContinuityFreshness.current,
  );
  return VerifiedClinicalContinuitySet(
    audience: const ClinicalContinuityAudience(
      tenantId: '52e31913-c846-4458-a21b-31cd2f457e9b',
      facilityId: '41',
    ),
    facilityName: 'VH Central',
    facilityTimezone: 'Asia/Kolkata',
    policyId: '55555555-5555-4555-8555-555555555555',
    publicationSetId: '66666666-6666-4666-8666-666666666666',
    localUnlockPolicy: const ClinicalContinuityLocalUnlockPolicy(
      authenticationMode: 'mtls_client_certificate',
      maximumAuthorizationMinutes: 720,
      emergencyReadPosture: 'disabled',
    ),
    localGrants: [
      ClinicalContinuityLocalGrant(
        staffId: session.staffId,
        deviceId: session.deviceId,
        locationType: 'ward',
        locationId: 'ward-10',
        validFrom: generatedAt,
        validUntil: generatedAt.add(const Duration(hours: 12)),
      ),
    ],
    prefetchSession: session,
    provenance: const ClinicalContinuitySourceProvenance(
      sourceRevision: 'source-17',
      sourceWatermark: '{"revision":"source-17"}',
      accessRevision: '11',
    ),
    signingKeyFingerprints: const {
      'continuity-pack-current-k1':
          '0000000000000000000000000000000000000000000000000000000000000000',
    },
    floors: ClinicalContinuityFloors(
      policyVersion: '7',
      manifestVersion: '9',
      revocationEpoch: '3',
      trustedNow: generatedAt.add(const Duration(minutes: 5)),
    ),
    generatedAt: generatedAt,
    expiresAt: pack.expiresAt,
    evaluatedAt: generatedAt.add(const Duration(minutes: 5)),
    packs: [pack],
    verifiedByteLength: 2048,
  );
}
