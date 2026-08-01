import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:vhhealth_core/models/clinical_continuity.dart';
import 'package:vhhealth_core/services/clinical_continuity_cache.dart';
import 'package:vhhealth_core/services/clinical_continuity_verifier.dart';

const _tenantId = '52e31913-c846-4458-a21b-31cd2f457e9b';
const _staffId = '22222222-2222-4222-8222-222222222222';
const _deviceId = 'staff-device-1';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  sqfliteFfiInit();

  late Map<String, String> secureStorage;
  late Database database;
  late bool databaseOpened;
  late Directory tempDirectory;

  setUp(() async {
    secureStorage = <String, String>{};
    databaseOpened = false;
    tempDirectory = await Directory.systemTemp.createTemp(
      'vh-continuity-cache-test-',
    );
    _installSecureStorageFake(secureStorage);
  });

  tearDown(() async {
    if (databaseOpened && database.isOpen) {
      await database.close();
    }
    await tempDirectory.delete(recursive: true);
  });

  Future<Database> openDatabaseForTest() async {
    if (databaseOpened && database.isOpen) return database;
    database = await databaseFactoryFfi.openDatabase(
      '${tempDirectory.path}${Platform.pathSeparator}continuity.db',
      options: OpenDatabaseOptions(
        version: 1,
        onCreate: (db, _) async {
          await db.execute('''
            CREATE TABLE continuity_facility_sets (
              namespace TEXT PRIMARY KEY,
              aad TEXT NOT NULL,
              ciphertext TEXT NOT NULL,
              byte_size INTEGER NOT NULL,
              expires_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
          ''');
          await db.execute(
            'CREATE INDEX continuity_expiry_idx '
            'ON continuity_facility_sets(expires_at)',
          );
        },
      ),
    );
    databaseOpened = true;
    return database;
  }

  ClinicalContinuityCache cache({
    Future<void> Function()? beforeCommit,
    ClinicalContinuityTrustValidator? trustValidator,
  }) {
    return ClinicalContinuityCache(
      databaseOpener: openDatabaseForTest,
      beforeCommit: beforeCommit,
      trustValidator: trustValidator ?? (_) async => null,
    );
  }

  test('action policy advances shared floors monotonically', () async {
    final subject = cache();
    final firstTrustedAt = DateTime.parse('2026-07-30T00:10:00.000Z');

    expect(
      await subject.advanceActionPolicyFloors(
        tenantId: _tenantId,
        facilityId: '41',
        policyVersion: '7',
        registryVersion: '5',
        registryChecksum: 'a' * 64,
        revocationEpoch: '3',
        trustedNow: firstTrustedAt,
      ),
      isTrue,
    );
    var floors = await subject.readFloors(
      tenantId: _tenantId,
      facilityId: '41',
    );
    expect(floors!.policyVersion, '7');
    expect(floors.manifestVersion, '0');
    expect(floors.revocationEpoch, '3');
    expect(floors.trustedNow, firstTrustedAt);
    expect(
      (await subject.store(
        _verifiedSet(
          packCompositionVersion: '2',
          trustedNow: '2026-07-30T00:11:00.000Z',
        ),
      )).stored,
      isTrue,
    );

    expect(
      await subject.advanceActionPolicyFloors(
        tenantId: _tenantId,
        facilityId: '41',
        policyVersion: '6',
        registryVersion: '5',
        registryChecksum: 'a' * 64,
        revocationEpoch: '3',
        trustedNow: firstTrustedAt.add(const Duration(minutes: 1)),
      ),
      isFalse,
    );
    expect(
      await subject.advanceActionPolicyFloors(
        tenantId: _tenantId,
        facilityId: '41',
        policyVersion: '8',
        registryVersion: '6',
        registryChecksum: 'b' * 64,
        revocationEpoch: '2',
        trustedNow: firstTrustedAt.add(const Duration(minutes: 1)),
      ),
      isFalse,
    );
    expect(
      await subject.advanceActionPolicyFloors(
        tenantId: _tenantId,
        facilityId: '41',
        policyVersion: '8',
        registryVersion: '4',
        registryChecksum: 'b' * 64,
        revocationEpoch: '3',
        trustedNow: firstTrustedAt.add(const Duration(minutes: 1)),
      ),
      isFalse,
    );
    expect(
      await subject.advanceActionPolicyFloors(
        tenantId: _tenantId,
        facilityId: '41',
        policyVersion: '8',
        registryVersion: '5',
        registryChecksum: 'b' * 64,
        revocationEpoch: '3',
        trustedNow: firstTrustedAt.add(const Duration(minutes: 1)),
      ),
      isFalse,
    );
    expect(
      await subject.advanceActionPolicyFloors(
        tenantId: _tenantId,
        facilityId: '41',
        policyVersion: '8',
        registryVersion: '6',
        registryChecksum: 'a' * 64,
        revocationEpoch: '3',
        trustedNow: firstTrustedAt.add(const Duration(minutes: 1)),
      ),
      isFalse,
    );
    expect(
      await subject.advanceActionPolicyFloors(
        tenantId: _tenantId,
        facilityId: '41',
        policyVersion: '8',
        registryVersion: '6',
        registryChecksum: 'b' * 64,
        revocationEpoch: '3',
        trustedNow: firstTrustedAt.add(const Duration(minutes: 2)),
      ),
      isTrue,
    );
    floors = await subject.readFloors(tenantId: _tenantId, facilityId: '41');
    expect(floors!.policyVersion, '8');
    expect(floors.revocationEpoch, '3');
  });

  test('stores and opens one opaque, encrypted facility slot', () async {
    final subject = cache();
    final set = _verifiedSet();

    final stored = await subject.store(set);
    final opened = await subject.open(
      session: set.prefetchSession,
      clock: _clock('2026-07-30T00:10:00.000Z'),
    );
    final rows = await database.query('continuity_facility_sets');

    expect(stored.stored, isTrue);
    expect(opened.verifiedSet?.publicationSetId, set.publicationSetId);
    expect(rows, hasLength(1));
    expect(
      rows.single['namespace'],
      allOf(isNot(_facilityId(set)), matches(RegExp(r'^[0-9a-f]{64}$'))),
    );
    expect(rows.single['ciphertext'], isNot(contains('Test Patient')));
    expect(rows.single['aad'], isNot(contains(_staffId)));
    expect(
      rows.single['byte_size'],
      greaterThanOrEqualTo(
        (rows.single['ciphertext']! as String).length +
            (rows.single['aad']! as String).length,
      ),
    );
  });

  test('binds cache reads to tenant, facility, and device', () async {
    final subject = cache();
    final set = _verifiedSet();
    await subject.store(set);

    Future<ClinicalContinuityCacheReadResult> openWith({
      String staffId = _staffId,
      String role = 'nurse',
      String deviceId = _deviceId,
    }) {
      return subject.open(
        session: ClinicalContinuitySessionContext(
          tenantId: _tenantId,
          facilityId: '41',
          staffId: staffId,
          role: role,
          deviceId: deviceId,
          authenticatedAt: DateTime.parse('2026-07-30T00:00:00.000Z'),
        ),
        clock: _clock('2026-07-30T00:10:00.000Z'),
      );
    }

    expect((await openWith(staffId: 'other-staff')).verifiedSet, isNotNull);
    expect((await openWith(role: 'doctor')).verifiedSet, isNotNull);
    expect(
      (await openWith(deviceId: 'other-device')).denialReason,
      'CACHE_BINDING_MISMATCH',
    );
  });

  test('rejects ciphertext tampering and a missing secure witness', () async {
    final subject = cache();
    final set = _verifiedSet();
    await subject.store(set);
    final row = (await database.query('continuity_facility_sets')).single;
    final ciphertext = row['ciphertext']! as String;
    await database.update(
      'continuity_facility_sets',
      {'ciphertext': '${ciphertext.substring(0, ciphertext.length - 2)}AA'},
      where: 'namespace = ?',
      whereArgs: [row['namespace']],
    );

    final tampered = await subject.open(
      session: set.prefetchSession,
      clock: _clock('2026-07-30T00:10:00.000Z'),
    );
    expect(tampered.denialReason, 'CACHE_AUTHENTICATION_FAILED');

    await subject.store(set);
    final witnessKey = secureStorage.keys.singleWhere(
      (key) => key.startsWith('clinical_continuity_witness:'),
    );
    secureStorage.remove(witnessKey);
    final noWitness = await subject.open(
      session: set.prefetchSession,
      clock: _clock('2026-07-30T00:10:00.000Z'),
    );
    expect(
      noWitness.denialReason,
      ClinicalContinuityVerificationReasons.rollbackStateRequired,
    );
    expect(
      (await subject.store(set)).denialReason,
      ClinicalContinuityVerificationReasons.rollbackStateRequired,
    );

    secureStorage[witnessKey] = '{';
    await expectLater(subject.store(set), throwsStateError);
  });

  test(
    'rejects associated-data tampering before returning clinical content',
    () async {
      final subject = cache();
      final set = _verifiedSet();
      await subject.store(set);
      final row = (await database.query('continuity_facility_sets')).single;
      final aad = row['aad']! as String;
      await database.update(
        'continuity_facility_sets',
        {'aad': '${aad.substring(0, aad.length - 2)}AA'},
        where: 'namespace = ?',
        whereArgs: [row['namespace']],
      );

      final result = await subject.open(
        session: set.prefetchSession,
        clock: _clock('2026-07-30T00:10:00.000Z'),
      );

      expect(result.denialReason, 'CACHE_AUTHENTICATION_FAILED');
      expect(result.verifiedSet, isNull);
    },
  );

  test('re-evaluates provisioned trust on every cache open', () async {
    String? trustFailure;
    var currentFingerprint =
        '0000000000000000000000000000000000000000000000000000000000000000';
    final subject = cache(
      trustValidator: (candidate) async =>
          trustFailure ??
          (candidate.signingKeyFingerprints.values.single == currentFingerprint
              ? null
              : ClinicalContinuityVerificationReasons.keyIdMismatch),
    );
    final set = _verifiedSet();
    await subject.store(set);
    expect(
      (await subject.open(
        session: set.prefetchSession,
        clock: _clock('2026-07-30T00:10:00.000Z'),
      )).verifiedSet,
      isNotNull,
    );

    currentFingerprint =
        '1111111111111111111111111111111111111111111111111111111111111111';
    final replacedKey = await subject.open(
      session: set.prefetchSession,
      clock: _clock('2026-07-30T00:10:00.000Z'),
    );
    expect(
      replacedKey.denialReason,
      ClinicalContinuityVerificationReasons.keyIdMismatch,
    );

    trustFailure = ClinicalContinuityVerificationReasons.keyRevoked;
    final revoked = await subject.open(
      session: set.prefetchSession,
      clock: _clock('2026-07-30T00:10:00.000Z'),
    );

    expect(
      revoked.denialReason,
      ClinicalContinuityVerificationReasons.keyRevoked,
    );
    expect(revoked.verifiedSet, isNull);
  });

  test('rejects rollback writes before replacing the current slot', () async {
    final subject = cache();
    final current = _verifiedSet(
      policyVersion: '7',
      manifestVersion: '9',
      revocationEpoch: '3',
    );
    await subject.store(current);

    final result = await subject.store(
      _verifiedSet(
        policyVersion: '6',
        manifestVersion: '9',
        revocationEpoch: '3',
      ),
    );
    final opened = await subject.open(
      session: current.prefetchSession,
      clock: _clock('2026-07-30T00:10:00.000Z'),
    );

    expect(
      result.denialReason,
      ClinicalContinuityVerificationReasons.rollbackStateRequired,
    );
    expect(opened.verifiedSet?.floors.policyVersion, '7');
  });

  test(
    'crash between witness and commit fails closed against the older row',
    () async {
      var failBeforeCommit = false;
      final subject = cache(
        beforeCommit: () async {
          if (failBeforeCommit) throw StateError('simulated crash');
        },
      );
      final old = _verifiedSet();
      await subject.store(old);
      failBeforeCommit = true;

      await expectLater(
        subject.store(
          _verifiedSet(
            manifestVersion: '10',
            trustedNow: '2026-07-30T00:05:00.000Z',
          ),
        ),
        throwsStateError,
      );
      final opened = await subject.open(
        session: old.prefetchSession,
        clock: _clock('2026-07-30T00:10:00.000Z'),
      );

      expect(
        opened.denialReason,
        ClinicalContinuityVerificationReasons.rollbackStateRequired,
      );
    },
  );

  test('uses exact expiry and clock-regression refusal boundaries', () async {
    final subject = cache();
    final set = _verifiedSet(expiresAt: '2026-07-30T04:00:00.000Z');
    await subject.store(set);

    final expired = await subject.open(
      session: set.prefetchSession,
      clock: _clock('2026-07-30T04:00:00.000Z'),
    );
    final regressed = await subject.open(
      session: set.prefetchSession,
      clock: _clock('2026-07-29T23:59:59.999Z'),
    );

    expect(
      expired.denialReason,
      ClinicalContinuityVerificationReasons.packExpired,
    );
    expect(
      regressed.denialReason,
      ClinicalContinuityVerificationReasons.clockUncertain,
    );
  });

  test('evicts only expired slots at the 512 MiB device ceiling', () async {
    final subject = cache();
    final expired = _verifiedSet(
      facilityId: '41',
      verifiedByteLength: ClinicalContinuityCache.maxFacilityBytes,
      expiresAt: '2026-07-30T01:00:00.000Z',
    );
    final current = _verifiedSet(
      facilityId: '42',
      verifiedByteLength: ClinicalContinuityCache.maxFacilityBytes,
    );
    await subject.store(expired);
    await subject.store(current);

    final refused = await subject.store(
      _verifiedSet(
        facilityId: '43',
        verifiedByteLength: 1,
        trustedNow: '2026-07-30T00:30:00.000Z',
      ),
    );
    expect(refused.denialReason, 'DEVICE_CAPACITY_EXCEEDED');

    final accepted = await subject.store(
      _verifiedSet(
        facilityId: '43',
        verifiedByteLength: 1,
        trustedNow: '2026-07-30T02:00:00.000Z',
        generatedAt: '2026-07-30T02:00:00.000Z',
        expiresAt: '2026-07-30T06:00:00.000Z',
      ),
    );
    final evicted = await subject.open(
      session: expired.prefetchSession,
      clock: _clock('2026-07-30T02:00:00.000Z'),
    );

    expect(accepted.stored, isTrue);
    expect(evicted.found, isFalse);
  });

  test('facility and device wipes remove rows, keys, and witnesses', () async {
    final subject = cache();
    final first = _verifiedSet(facilityId: '41');
    final second = _verifiedSet(facilityId: '42');
    await subject.store(first);
    await subject.store(second);

    await subject.wipeFacility(tenantId: _tenantId, facilityId: '41');
    expect(
      (await subject.open(
        session: first.prefetchSession,
        clock: _clock('2026-07-30T00:10:00.000Z'),
      )).found,
      isFalse,
    );
    expect(
      (await subject.open(
        session: second.prefetchSession,
        clock: _clock('2026-07-30T00:10:00.000Z'),
      )).found,
      isTrue,
    );

    await subject.wipeDevice();
    expect(
      secureStorage.containsKey('clinical_continuity_cache_index_hmac'),
      isFalse,
    );
    expect(
      (await subject.open(
        session: second.prefetchSession,
        clock: _clock('2026-07-30T00:10:00.000Z'),
      )).found,
      isFalse,
    );
    expect(
      secureStorage.keys.where(
        (key) =>
            key.startsWith('clinical_continuity_witness:') ||
            key.startsWith('clinical_continuity_cache_key:'),
      ),
      isEmpty,
    );
  });

  test(
    'rejects a facility payload over 256 MiB without opening storage',
    () async {
      final subject = cache();

      final result = await subject.store(
        _verifiedSet(
          verifiedByteLength: ClinicalContinuityCache.maxFacilityBytes + 1,
        ),
      );

      expect(result.denialReason, 'FACILITY_CAPACITY_EXCEEDED');
      expect(databaseOpened, isFalse);
    },
  );

  test('missing cache index key fails closed while rows remain', () async {
    final subject = cache();
    final set = _verifiedSet();
    await subject.store(set);
    secureStorage.remove('clinical_continuity_cache_index_hmac');

    await expectLater(
      subject.open(
        session: set.prefetchSession,
        clock: _clock('2026-07-30T00:10:00.000Z'),
      ),
      throwsStateError,
    );
  });

  test('cache envelope supports verified sets larger than 2 MiB', () async {
    final subject = cache();
    final payload = String.fromCharCodes(
      List<int>.filled((2 * 1024 * 1024) + 1024, 120),
    );
    final set = _verifiedSet(payload: payload);

    expect((await subject.store(set)).stored, isTrue);
    final opened = await subject.open(
      session: set.prefetchSession,
      clock: _clock('2026-07-30T00:10:00.000Z'),
    );

    expect(opened.verifiedSet, isNotNull);
    expect(
      opened.verifiedSet!.packs.single.content['payload'],
      hasLength(payload.length),
    );
  });
}

void _installSecureStorageFake(Map<String, String> store) {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = Map<String, dynamic>.from(call.arguments as Map);
        switch (call.method) {
          case 'read':
            return store[args['key']];
          case 'write':
            store[args['key'] as String] = args['value'] as String;
            return null;
          case 'delete':
            store.remove(args['key']);
            return null;
          case 'deleteAll':
            store.clear();
            return null;
          default:
            return null;
        }
      });
}

VerifiedClinicalContinuitySet _verifiedSet({
  String packCompositionVersion = '1',
  String facilityId = '41',
  String policyVersion = '7',
  String manifestVersion = '9',
  String revocationEpoch = '3',
  String trustedNow = '2026-07-30T00:01:00.000Z',
  String generatedAt = '2026-07-30T00:00:00.000Z',
  String expiresAt = '2026-07-30T04:00:00.000Z',
  int verifiedByteLength = 2048,
  String? payload,
}) {
  final session = ClinicalContinuitySessionContext(
    tenantId: _tenantId,
    facilityId: facilityId,
    staffId: _staffId,
    role: 'nurse',
    deviceId: _deviceId,
    authenticatedAt: DateTime.parse(generatedAt),
  );
  final pack = ClinicalContinuityPack(
    locationType: 'ward',
    locationId: 'ward-10',
    locationLabel: 'Ward 10',
    content: {
      'patients': [
        {
          'identity': {'name': 'Test Patient', 'mrn': 'MRN-001'},
        },
      ],
      'payload': ?payload,
    },
    htmlBytes: Uint8List.fromList([60, 112, 62, 111, 107, 60, 47, 112, 62]),
    generatedAt: DateTime.parse(generatedAt),
    expiresAt: DateTime.parse(expiresAt),
    freshness: ClinicalContinuityFreshness.current,
  );
  return VerifiedClinicalContinuitySet(
    audience: ClinicalContinuityAudience(
      tenantId: _tenantId,
      facilityId: facilityId,
    ),
    facilityName: 'VH Central',
    facilityTimezone: 'Asia/Kolkata',
    policyId: '55555555-5555-4555-8555-555555555555',
    packCompositionVersion: packCompositionVersion,
    publicationSetId: '66666666-6666-4666-8666-${facilityId.padLeft(12, '0')}',
    localUnlockPolicy: const ClinicalContinuityLocalUnlockPolicy(
      authenticationMode: 'mtls_client_certificate',
      maximumAuthorizationMinutes: 720,
      emergencyReadPosture: 'disabled',
    ),
    localGrants: [
      ClinicalContinuityLocalGrant(
        staffId: _staffId,
        deviceId: _deviceId,
        locationType: 'ward',
        locationId: 'ward-10',
        validFrom: DateTime.parse(generatedAt),
        validUntil: DateTime.parse(expiresAt),
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
      packCompositionVersion: packCompositionVersion,
      policyVersion: policyVersion,
      manifestVersion: manifestVersion,
      revocationEpoch: revocationEpoch,
      trustedNow: DateTime.parse(trustedNow),
    ),
    generatedAt: DateTime.parse(generatedAt),
    expiresAt: DateTime.parse(expiresAt),
    evaluatedAt: DateTime.parse(trustedNow),
    packs: [pack],
    verifiedByteLength: verifiedByteLength,
  );
}

ClinicalContinuityClockAssessment _clock(String trustedNow) {
  return ClinicalContinuityClockAssessment(
    trusted: true,
    trustedNow: DateTime.parse(trustedNow),
  );
}

String _facilityId(VerifiedClinicalContinuitySet set) =>
    set.audience.facilityId;
