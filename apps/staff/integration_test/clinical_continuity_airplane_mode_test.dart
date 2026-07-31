import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:sqflite/sqflite.dart' as sqflite;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:vhhealth_core/services/secure_blob.dart';
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

  testWidgets(
    'airplane restart retains queued, legacy-review, and local-draft state',
    (tester) async {
      final persistence = _AirplanePersistence();
      await persistence.setUp();
      try {
        final captured = DateTime.utc(2026, 7, 31, 12);
        final prepared = await OfflineQueue.persistPreparedCommand(
          _offlineCommand(captured),
          queuedAt: captured,
        );
        final legacyId = await OfflineQueue.enqueue(
          endpoint: '/health/records',
          method: 'POST',
          body: const {'pulse': 72},
        );
        final draftPersistence = _AirplaneDraftPersistence();
        final draftStore = ClinicalLocalDraftStore(
          persistence: draftPersistence,
          codec: SecureBlobCodec('airplane_local_draft_key_v1'),
        );
        await draftStore.save(_localDraft(captured));

        expect(
          draftPersistence.values['rx:patient-1'],
          isNot(contains('test medicine')),
        );
        expect(
          draftPersistence.values['rx:patient-1'],
          isNot(contains('patient-1')),
        );

        await ConnectivitySyncService.instance.resetForTesting();
        ConnectivitySyncService.instance.setTransportAvailableForTesting(false);
        await OfflineQueue.resetForTesting();

        final entries = await OfflineQueue.unresolvedEntriesForCurrentOwner();
        final preparedEntry = entries.singleWhere(
          (entry) => entry.id == prepared.rowId,
        );
        final legacyEntry = entries.singleWhere(
          (entry) => entry.id == legacyId,
        );
        final reopenedDrafts =
            await ClinicalLocalDraftStore(
              persistence: draftPersistence,
              codec: SecureBlobCodec('airplane_local_draft_key_v1'),
            ).list(
              tenantId: TenantConfig.id,
              facilityId: 41,
              deviceId: 'staff-device-1',
              actorId: 'staff-user-uid',
            );

        expect(ConnectivitySyncService.instance.isOnline, isFalse);
        expect(preparedEntry.envelopeReady, isTrue);
        expect(preparedEntry.status, OfflineWriteStatus.pending);
        expect(preparedEntry.attemptCount, 0);
        expect(legacyEntry.envelopeReady, isFalse);
        expect(legacyEntry.status, OfflineWriteStatus.needsReview);
        expect(
          legacyEntry.stateReasonCode,
          'legacy_client_row_requires_reconciliation',
        );
        expect(legacyEntry.isSkipped, isFalse);
        expect(reopenedDrafts, hasLength(1));
        expect(reopenedDrafts.single.payload, {
          'medications': [
            {'drug': 'test medicine', 'dose': '5 mg'},
          ],
        });
      } finally {
        await persistence.tearDown();
      }
    },
  );
}

OfflineCommandDraft _offlineCommand(DateTime captured) {
  return OfflineCommandDraft(
    actionId: OfflineActionIds.opNoteDraftStore,
    payload: const {
      'patient_uid': 'patient-1',
      'note_type': 'op_consultation',
      'content': {'assessment': 'stable'},
    },
    appVersion: '1.2.0+4',
    actionVersion: 1,
    actionChecksum: 'action-checksum',
    actionSchemaId: 'schema.op-note-draft',
    actionSchemaVersion: 1,
    actionSchemaChecksum: 'schema-checksum',
    policyId: 'policy-1',
    policyVersion: '1',
    policyChecksum: 'policy-checksum',
    policySigningKeyId: 'key-1',
    policyEffectiveFrom: captured.subtract(const Duration(hours: 1)),
    policyEffectiveUntil: captured.add(const Duration(days: 1)),
    policyRevocationEpoch: '1',
    registryVersion: '1',
    registryChecksum: 'registry-checksum',
    minimumAppVersion: '1.2.0',
    tenantId: TenantConfig.id,
    facilityId: 41,
    deviceId: 'staff-device-1',
    devicePosture: 'desktop',
    captureSessionId: '11111111-1111-4111-8111-111111111111',
    captureActorUuid: 'staff-user-uid',
    captureRole: 'doctor',
    patientReference: 'patient-1',
    appointmentId: 'appointment-1',
    occurredAt: captured,
    capturedAt: captured,
    clockEvidence: OfflineClockEvidence(
      observedAt: captured,
      serverTime: captured,
      midpoint: captured,
      skewMilliseconds: 0,
      uncertaintyMilliseconds: 10,
      toleranceMilliseconds: 30000,
      routeKind: 'public',
    ),
    cachedSources: {'patient_identity': captured},
    expiresAt: captured.add(const Duration(hours: 8)),
    orderingKey: 'patient-1\u0000appointment-1\u0000op-note',
  );
}

ClinicalLocalDraft _localDraft(DateTime captured) {
  return ClinicalLocalDraft(
    id: 'rx:patient-1',
    actionId: OfflineActionIds.opPrescriptionDraft,
    tenantId: TenantConfig.id,
    facilityId: 41,
    deviceId: 'staff-device-1',
    actorId: 'staff-user-uid',
    role: 'doctor',
    patientReference: 'patient-1',
    appointmentId: 'appointment-1',
    payload: const {
      'medications': [
        {'drug': 'test medicine', 'dose': '5 mg'},
      ],
    },
    createdAt: captured,
    updatedAt: captured,
  );
}

class _AirplanePersistence {
  static const _storageChannel = MethodChannel(
    'plugins.it_nomads.com/flutter_secure_storage',
  );

  final secureValues = <String, String>{};
  final dbName =
      'clinical_continuity_airplane_'
      '${DateTime.now().microsecondsSinceEpoch}.db';

  Future<void> setUp() async {
    sqfliteFfiInit();
    sqflite.databaseFactory = databaseFactoryFfi;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_storageChannel, (call) async {
          final arguments = Map<String, dynamic>.from(call.arguments as Map);
          switch (call.method) {
            case 'read':
              return secureValues[arguments['key']];
            case 'write':
              secureValues[arguments['key'] as String] =
                  arguments['value'] as String;
              return null;
            case 'delete':
              secureValues.remove(arguments['key']);
              return null;
            case 'deleteAll':
              secureValues.clear();
              return null;
            case 'readAll':
              return Map<String, String>.from(secureValues);
            case 'containsKey':
              return secureValues.containsKey(arguments['key']);
          }
          return null;
        });
    OfflineQueue.debugDbFileNameOverride = dbName;
    OfflineQueue.registerMetadataResolvers(
      tenantIdResolver: () => TenantConfig.id,
      reconciliationOwnerResolver: (_) =>
          OfflineQueue.fallbackReconciliationRole,
      currentActorUidResolver: () async => 'staff-user-uid',
      currentActorRoleResolver: () async => 'doctor',
    );
    await OfflineQueue.deleteTestDatabase();
    await AuthService.setStaffId('staff-1');
    await AuthService.setJwt('test-jwt');
    await ConnectivitySyncService.instance.resetForTesting();
    ConnectivitySyncService.instance.setTransportAvailableForTesting(false);
  }

  Future<void> tearDown() async {
    await ConnectivitySyncService.instance.resetForTesting();
    await OfflineQueue.deleteTestDatabase();
    OfflineQueue.resetMetadataResolversForTesting();
    OfflineQueue.debugDbFileNameOverride = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_storageChannel, null);
    secureValues.clear();
  }
}

class _AirplaneDraftPersistence implements ClinicalLocalDraftPersistence {
  final values = <String, String>{};
  List<String> ids = [];

  @override
  Future<void> delete(String id) async => values.remove(id);

  @override
  Future<String?> read(String id) async => values[id];

  @override
  Future<List<String>> readIds() async => List.of(ids);

  @override
  Future<void> write(String id, String value) async => values[id] = value;

  @override
  Future<void> writeIds(List<String> ids) async => this.ids = List.of(ids);
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
