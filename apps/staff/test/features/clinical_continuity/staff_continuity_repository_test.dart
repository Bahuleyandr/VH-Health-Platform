import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/vhhealth_core.dart';
import 'package:vhhealth_staff/features/clinical_continuity/services/staff_continuity_repository.dart';

void main() {
  test('cache feature flag disables all refresh and open behavior', () async {
    final source = _FakeSource();
    final repository = StaffContinuityRepository(
      source: source,
      cacheEnabled: false,
    );

    expect(repository.state, StaffContinuityState.disabled);
    expect(await repository.requestRefresh(), isFalse);
    expect((await repository.openCached()).denialReason, 'CACHE_DISABLED');
    expect(source.fetchCalls, 0);
    repository.dispose();
  });

  test(
    'refresh waits for readiness and coalesces concurrent requests',
    () async {
      final set = _verifiedSet();
      final source = _FakeSource();
      final pending = Completer<ClinicalContinuitySourceSnapshot>();
      source.fetch = () => pending.future;
      final cache = _FakeCache();
      final repository = StaffContinuityRepository(
        source: source,
        verifier: _FakeVerifier(
          ClinicalContinuityVerificationResult.accepted(set),
        ),
        cache: cache,
        readiness: () async => ClientReadinessOutcome.alwaysReadyForTesting,
        cacheEnabled: true,
      );

      final first = repository.requestRefresh();
      final second = repository.requestRefresh();
      expect(identical(first, second), isTrue);
      await Future<void>.delayed(Duration.zero);
      expect(source.fetchCalls, 1);
      pending.complete(_snapshot(set.prefetchSession));

      expect(await first, isTrue);
      expect(repository.currentSet, same(set));
      expect(repository.state, StaffContinuityState.ready);
      expect(cache.storeCalls, 1);
      repository.dispose();
    },
  );

  test(
    'readiness refusal prevents network fetch and periodic refresh',
    () async {
      final source = _FakeSource();
      final repository = StaffContinuityRepository(
        source: source,
        readiness: () async => const ClientReadinessOutcome(
          ready: false,
          lifecycle: ContinuityLifecycleState.clockUncertain,
        ),
        cacheEnabled: true,
        refreshInterval: const Duration(milliseconds: 1),
      );

      expect(await repository.requestRefresh(), isFalse);
      await Future<void>.delayed(const Duration(milliseconds: 5));

      expect(source.fetchCalls, 0);
      expect(repository.state, StaffContinuityState.refused);
      expect(
        repository.refusalReason,
        ClinicalContinuityVerificationReasons.clockUncertain,
      );
      repository.dispose();
    },
  );

  test(
    'online access uses the named authenticated session without local factor',
    () async {
      final set = _verifiedSet();
      final unlocker = _FakeUnlocker();
      final repository = StaffContinuityRepository(
        source: _FakeSource(
          session: set.prefetchSession,
          clock: _clock('2026-07-30T00:10:00.000Z'),
        ),
        verifier: _FakeVerifier(
          ClinicalContinuityVerificationResult.accepted(set),
        ),
        cache: _FakeCache(openedSet: set),
        readiness: () async => ClientReadinessOutcome.alwaysReadyForTesting,
        unlocker: unlocker,
        cacheEnabled: true,
        localUnlockEnabled: true,
      );

      final decision = await repository.openCached();

      expect(decision.allowed, isTrue);
      expect(decision.mode, ClinicalContinuityAccessMode.onlineAuthenticated);
      expect(unlocker.calls, 0);
      repository.dispose();
    },
  );

  test(
    'offline local unlock uses the signed authorization window exactly',
    () async {
      final set = _verifiedSet(maximumAuthorizationMinutes: 37);
      final unlocker = _FakeUnlocker(
        result: ClinicalContinuityLocalFactor.devicePinOrBiometric,
      );
      final source = _FakeSource(
        session: set.prefetchSession,
        clock: _clock('2026-07-30T00:37:00.000Z'),
      );
      final repository = StaffContinuityRepository(
        source: source,
        cache: _FakeCache(openedSet: set),
        readiness: () async => ClientReadinessOutcome.notReady,
        unlocker: unlocker,
        cacheEnabled: true,
        localUnlockEnabled: true,
      );

      final boundary = await repository.openCached();
      source.clock = _clock('2026-07-30T00:37:00.001Z');
      final expired = await repository.openCached();

      expect(boundary.allowed, isTrue);
      expect(boundary.mode, ClinicalContinuityAccessMode.localUnlock);
      expect(expired.allowed, isFalse);
      expect(expired.denialReason, 'LOCAL_AUTHORIZATION_EXPIRED');
      expect(unlocker.calls, 1);
      repository.dispose();
    },
  );

  test(
    'offline refusal never prompts for the wrong staff or incomplete policy',
    () async {
      final set = _verifiedSet(emergencyReadPosture: 'read_only');
      final unlocker = _FakeUnlocker(
        result: ClinicalContinuityLocalFactor.devicePinOrBiometric,
      );
      final wrongSession = ClinicalContinuitySessionContext(
        tenantId: set.audience.tenantId,
        facilityId: set.audience.facilityId,
        staffId: 'different-staff',
        role: set.prefetchSession.role,
        deviceId: set.prefetchSession.deviceId,
        authenticatedAt: set.prefetchSession.authenticatedAt,
      );
      final repository = StaffContinuityRepository(
        source: _FakeSource(
          session: wrongSession,
          clock: _clock('2026-07-30T00:10:00.000Z'),
        ),
        cache: _FakeCache(openedSet: set),
        readiness: () async => ClientReadinessOutcome.notReady,
        unlocker: unlocker,
        cacheEnabled: true,
        localUnlockEnabled: true,
      );

      final decision = await repository.openCached();

      expect(decision.allowed, isFalse);
      expect(decision.denialReason, 'LOCAL_UNLOCK_POLICY_UNAVAILABLE');
      expect(unlocker.calls, 0);
      repository.dispose();
    },
  );

  test(
    'offline user switch requires that named staff signed grant coverage',
    () async {
      const nextStaff = '33333333-3333-4333-8333-333333333333';
      final set = _verifiedSet(additionalGrantStaffId: nextStaff);
      final nextSession = ClinicalContinuitySessionContext(
        tenantId: set.audience.tenantId,
        facilityId: set.audience.facilityId,
        staffId: nextStaff,
        role: 'doctor',
        deviceId: set.prefetchSession.deviceId,
        authenticatedAt: set.prefetchSession.authenticatedAt,
      );
      final unlocker = _FakeUnlocker(
        result: ClinicalContinuityLocalFactor.devicePinOrBiometric,
      );
      final repository = StaffContinuityRepository(
        source: _FakeSource(
          session: nextSession,
          clock: _clock('2026-07-30T00:10:00.000Z'),
        ),
        cache: _FakeCache(openedSet: set),
        readiness: () async => ClientReadinessOutcome.notReady,
        unlocker: unlocker,
        cacheEnabled: true,
        localUnlockEnabled: true,
      );

      final decision = await repository.openCached();

      expect(decision.allowed, isTrue);
      expect(decision.mode, ClinicalContinuityAccessMode.localUnlock);
      expect(unlocker.calls, 1);
      repository.dispose();
    },
  );

  test('session loss during device unlock fails closed', () async {
    final set = _verifiedSet();
    final source = _FakeSource(
      session: set.prefetchSession,
      clock: _clock('2026-07-30T00:10:00.000Z'),
    );
    final unlocker = _SessionClearingUnlocker(source);
    final repository = StaffContinuityRepository(
      source: source,
      cache: _FakeCache(openedSet: set),
      readiness: () async => ClientReadinessOutcome.notReady,
      unlocker: unlocker,
      cacheEnabled: true,
      localUnlockEnabled: true,
    );

    final decision = await repository.openCached();

    expect(decision.allowed, isFalse);
    expect(decision.denialReason, 'NAMED_SESSION_REQUIRED');
    expect(repository.currentSet, isNull);
    expect(unlocker.calls, 1);
    repository.dispose();
  });

  test(
    'refresh rejection retains prior verified data without extending it',
    () async {
      final set = _verifiedSet();
      final verifier = _FakeVerifier(
        ClinicalContinuityVerificationResult.accepted(set),
      );
      final source = _FakeSource(
        session: set.prefetchSession,
        clock: _clock('2026-07-30T00:10:00.000Z'),
      );
      final repository = StaffContinuityRepository(
        source: source,
        verifier: verifier,
        cache: _FakeCache(),
        readiness: () async => ClientReadinessOutcome.alwaysReadyForTesting,
        cacheEnabled: true,
      );
      expect(await repository.requestRefresh(), isTrue);
      verifier.result = const ClinicalContinuityVerificationResult.rejected(
        ClinicalContinuityVerificationReasons.signatureInvalid,
      );

      expect(await repository.requestRefresh(), isFalse);
      expect(repository.currentSet, same(set));
      expect(repository.currentSet!.expiresAt, set.expiresAt);
      expect(
        repository.refusalReason,
        ClinicalContinuityVerificationReasons.signatureInvalid,
      );
      repository.dispose();
    },
  );

  test('clearing decrypted state cancels source work', () async {
    final set = _verifiedSet();
    final source = _FakeSource(
      session: set.prefetchSession,
      clock: _clock('2026-07-30T00:10:00.000Z'),
    );
    final repository = StaffContinuityRepository(
      source: source,
      cache: _FakeCache(openedSet: set),
      readiness: () async => ClientReadinessOutcome.alwaysReadyForTesting,
      cacheEnabled: true,
    );
    await repository.openCached();

    await repository.clearDecryptedState();

    expect(repository.currentSet, isNull);
    expect(source.cancelCalls, 1);
    repository.dispose();
  });
}

class _FakeSource implements ClinicalContinuitySource {
  ClinicalContinuitySessionContext? session;
  ClinicalContinuityClockAssessment clock;
  Future<ClinicalContinuitySourceSnapshot> Function()? fetch;
  int fetchCalls = 0;
  int cancelCalls = 0;

  _FakeSource({this.session, ClinicalContinuityClockAssessment? clock})
    : clock =
          clock ??
          const ClinicalContinuityClockAssessment(
            trusted: false,
            trustedNow: null,
          );

  @override
  Future<ClinicalContinuityClockAssessment> assessClock() async => clock;

  @override
  Future<void> cancel() async {
    cancelCalls += 1;
  }

  @override
  Future<ClinicalContinuitySessionContext?> currentSession() async => session;

  @override
  Future<ClinicalContinuitySourceSnapshot> fetchFacilitySet() {
    fetchCalls += 1;
    if (fetch != null) return fetch!();
    if (session == null) throw StateError('No test session');
    return Future.value(_snapshot(session!));
  }
}

class _FakeVerifier extends ClinicalContinuityVerifier {
  ClinicalContinuityVerificationResult result;

  _FakeVerifier(this.result);

  @override
  Future<ClinicalContinuityVerificationResult> verify(
    ClinicalContinuitySourceSnapshot snapshot, {
    ClinicalContinuityFloors? persistedFloors,
  }) async {
    return result;
  }
}

class _FakeCache extends ClinicalContinuityCache {
  VerifiedClinicalContinuitySet? openedSet;
  final ClinicalContinuityCacheWriteResult writeResult =
      const ClinicalContinuityCacheWriteResult.stored();
  int storeCalls = 0;

  _FakeCache({this.openedSet});

  @override
  Future<ClinicalContinuityFloors?> readFloors({
    required String tenantId,
    required String facilityId,
  }) async {
    return null;
  }

  @override
  Future<ClinicalContinuityCacheWriteResult> store(
    VerifiedClinicalContinuitySet set,
  ) async {
    storeCalls += 1;
    openedSet = set;
    return writeResult;
  }

  @override
  Future<ClinicalContinuityCacheReadResult> open({
    required ClinicalContinuitySessionContext session,
    required ClinicalContinuityClockAssessment clock,
  }) async {
    return openedSet == null
        ? const ClinicalContinuityCacheReadResult.missing()
        : ClinicalContinuityCacheReadResult.opened(openedSet!);
  }

  @override
  Future<void> close() async {}
}

class _FakeUnlocker implements StaffContinuityDeviceUnlocker {
  final ClinicalContinuityLocalFactor? result;
  int calls = 0;

  _FakeUnlocker({this.result});

  @override
  Future<ClinicalContinuityLocalFactor?> unlock() async {
    calls += 1;
    return result;
  }
}

class _SessionClearingUnlocker implements StaffContinuityDeviceUnlocker {
  final _FakeSource source;
  int calls = 0;

  _SessionClearingUnlocker(this.source);

  @override
  Future<ClinicalContinuityLocalFactor?> unlock() async {
    calls += 1;
    source.session = null;
    return ClinicalContinuityLocalFactor.devicePinOrBiometric;
  }
}

ClinicalContinuitySourceSnapshot _snapshot(
  ClinicalContinuitySessionContext session,
) {
  return ClinicalContinuitySourceSnapshot(
    manifestEnvelopeBytes: Uint8List(0),
    assets: const {},
    session: session,
    clock: _clock('2026-07-30T00:01:00.000Z'),
    provenance: const ClinicalContinuitySourceProvenance(
      sourceRevision: 'source-17',
      sourceWatermark: 'source-watermark',
      accessRevision: '11',
    ),
  );
}

VerifiedClinicalContinuitySet _verifiedSet({
  int maximumAuthorizationMinutes = 720,
  String emergencyReadPosture = 'disabled',
  String? additionalGrantStaffId,
}) {
  final session = ClinicalContinuitySessionContext(
    tenantId: '52e31913-c846-4458-a21b-31cd2f457e9b',
    facilityId: '41',
    staffId: '22222222-2222-4222-8222-222222222222',
    role: 'nurse',
    deviceId: 'staff-device-1',
    authenticatedAt: DateTime.parse('2026-07-30T00:00:00.000Z'),
  );
  final pack = ClinicalContinuityPack(
    locationType: 'ward',
    locationId: 'ward-10',
    locationLabel: 'Ward 10',
    content: const {'patients': <Object?>[]},
    htmlBytes: Uint8List(0),
    generatedAt: DateTime.parse('2026-07-30T00:00:00.000Z'),
    expiresAt: DateTime.parse('2026-07-30T04:00:00.000Z'),
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
    localUnlockPolicy: ClinicalContinuityLocalUnlockPolicy(
      authenticationMode: 'mtls_client_certificate',
      maximumAuthorizationMinutes: maximumAuthorizationMinutes,
      emergencyReadPosture: emergencyReadPosture,
    ),
    localGrants: [
      ClinicalContinuityLocalGrant(
        staffId: session.staffId,
        deviceId: session.deviceId,
        locationType: 'ward',
        locationId: 'ward-10',
        validFrom: session.authenticatedAt,
        validUntil: session.authenticatedAt.add(const Duration(hours: 12)),
      ),
      if (additionalGrantStaffId != null)
        ClinicalContinuityLocalGrant(
          staffId: additionalGrantStaffId,
          deviceId: session.deviceId,
          locationType: 'ward',
          locationId: 'ward-10',
          validFrom: session.authenticatedAt,
          validUntil: session.authenticatedAt.add(const Duration(hours: 12)),
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
      trustedNow: DateTime.parse('2026-07-30T00:01:00.000Z'),
    ),
    generatedAt: DateTime.parse('2026-07-30T00:00:00.000Z'),
    expiresAt: DateTime.parse('2026-07-30T04:00:00.000Z'),
    evaluatedAt: DateTime.parse('2026-07-30T00:01:00.000Z'),
    packs: [pack],
    verifiedByteLength: 2048,
  );
}

ClinicalContinuityClockAssessment _clock(String trustedNow) =>
    ClinicalContinuityClockAssessment(
      trusted: true,
      trustedNow: DateTime.parse(trustedNow),
    );
