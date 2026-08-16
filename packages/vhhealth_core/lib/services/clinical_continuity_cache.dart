import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:path/path.dart' as path;
import 'package:sqflite/sqflite.dart';

import '../models/clinical_continuity.dart';
import 'clinical_continuity_canonical_json.dart';
import 'clinical_continuity_trust_store.dart';
import 'clinical_continuity_verifier.dart';
import 'secure_blob.dart';
import 'secure_storage.dart';

typedef ClinicalContinuityDatabaseOpener = Future<Database> Function();
typedef ClinicalContinuityCodecFactory = SecureBlobCodec Function(
  String keyName,
);
typedef ClinicalContinuityBeforeCommit = Future<void> Function();
typedef ClinicalContinuityTrustValidator = Future<String?> Function(
  VerifiedClinicalContinuitySet set,
);

class ClinicalContinuityCacheWriteResult {
  final bool stored;
  final String? denialReason;

  const ClinicalContinuityCacheWriteResult._({
    required this.stored,
    this.denialReason,
  });

  const ClinicalContinuityCacheWriteResult.stored() : this._(stored: true);

  const ClinicalContinuityCacheWriteResult.rejected(String reason)
    : this._(stored: false, denialReason: reason);
}

class ClinicalContinuityCacheReadResult {
  final bool found;
  final String? denialReason;
  final VerifiedClinicalContinuitySet? verifiedSet;

  const ClinicalContinuityCacheReadResult._({
    required this.found,
    this.denialReason,
    this.verifiedSet,
  });

  const ClinicalContinuityCacheReadResult.missing() : this._(found: false);

  const ClinicalContinuityCacheReadResult.rejected(String reason)
    : this._(found: true, denialReason: reason);

  const ClinicalContinuityCacheReadResult.opened(
    VerifiedClinicalContinuitySet set,
  ) : this._(found: true, verifiedSet: set);
}

class ClinicalContinuityCache {
  static const maxFacilityBytes = 256 * 1024 * 1024;
  static const maxDeviceBytes = 512 * 1024 * 1024;
  static const _cacheJsonLimits = ClinicalContinuityCanonicalLimits(
    maxDepth: 64,
    maxNodes: 30000000,
    maxUtf8Bytes: maxFacilityBytes,
  );
  static const _indexKeyName = 'clinical_continuity_cache_index_hmac';
  static const _namespaceRegistryKey =
      'clinical_continuity_cache_namespace_registry';
  static const _witnessPrefix = 'clinical_continuity_witness:';
  static const _encryptionPrefix = 'clinical_continuity_cache_key:';

  final ClinicalContinuityDatabaseOpener _openDatabase;
  final ClinicalContinuityCodecFactory _codecFactory;
  final ClinicalContinuityBeforeCommit? _beforeCommit;
  final ClinicalContinuityTrustStore _trustStore;
  final ClinicalContinuityTrustValidator? _trustValidator;
  Database? _database;
  Future<Database>? _opening;

  ClinicalContinuityCache({
    ClinicalContinuityDatabaseOpener? databaseOpener,
    ClinicalContinuityCodecFactory codecFactory = SecureBlobCodec.new,
    ClinicalContinuityBeforeCommit? beforeCommit,
    ClinicalContinuityTrustStore trustStore =
        const ClinicalContinuityTrustStore(),
    ClinicalContinuityTrustValidator? trustValidator,
  }) : _openDatabase = databaseOpener ?? _defaultOpen,
       _codecFactory = codecFactory,
       _beforeCommit = beforeCommit,
       _trustStore = trustStore,
       _trustValidator = trustValidator;

  Future<ClinicalContinuityFloors?> readFloors({
    required String tenantId,
    required String facilityId,
  }) async {
    final namespace = await _namespace(tenantId, facilityId);
    return (await _readWitness(namespace))?.floors;
  }

  Future<_ClinicalContinuityWitness?> _readWitness(String namespace) async {
    final raw = await VHSecureStorage.instance.read(
      key: '$_witnessPrefix$namespace',
    );
    if (raw == null) return null;
    try {
      final parsed = ClinicalContinuityCanonicalJson.parse(
        Uint8List.fromList(utf8.encode(raw)),
      );
      final witness = Map<String, Object?>.from(parsed! as Map);
      const floorKeys = {
        'packCompositionVersion',
        'policyVersion',
        'manifestVersion',
        'revocationEpoch',
        'trustedNow',
      };
      const actionKeys = {'actionRegistryVersion', 'actionRegistryChecksum'};
      const legacyFloorKeys = {
        'policyVersion',
        'manifestVersion',
        'revocationEpoch',
        'trustedNow',
      };
      if (!witness.keys.toSet().containsAll(legacyFloorKeys) ||
          witness.keys.any(
            (key) => !floorKeys.contains(key) && !actionKeys.contains(key),
          )) {
        throw const FormatException('Invalid rollback witness shape');
      }
      final actionRegistryVersion = witness['actionRegistryVersion'];
      final actionRegistryChecksum = witness['actionRegistryChecksum'];
      final hasActionRegistry =
          actionRegistryVersion != null || actionRegistryChecksum != null;
      if (hasActionRegistry &&
          (actionRegistryVersion is! String ||
              _governanceFloor(actionRegistryVersion, allowZero: false) ==
                  null ||
              actionRegistryChecksum is! String ||
              !RegExp(r'^[0-9a-f]{64}$').hasMatch(actionRegistryChecksum))) {
        throw const FormatException('Invalid action registry witness');
      }
      final floorsJson = Map<String, Object?>.from(witness)
        ..remove('actionRegistryVersion')
        ..remove('actionRegistryChecksum');
      return _ClinicalContinuityWitness(
        floors: ClinicalContinuityFloors.fromJson(floorsJson),
        actionRegistryVersion: hasActionRegistry
            ? actionRegistryVersion! as String
            : null,
        actionRegistryChecksum: hasActionRegistry
            ? actionRegistryChecksum! as String
            : null,
      );
    } catch (_) {
      throw StateError('Clinical continuity rollback witness is unavailable');
    }
  }

  Future<bool> advanceActionPolicyFloors({
    required String tenantId,
    required String facilityId,
    required String policyVersion,
    required String registryVersion,
    required String registryChecksum,
    required String revocationEpoch,
    String packCompositionVersion = '2',
    required DateTime trustedNow,
  }) async {
    if (_governanceFloor(policyVersion, allowZero: false) == null ||
        _governanceFloor(registryVersion, allowZero: false) == null ||
        !RegExp(r'^[0-9a-f]{64}$').hasMatch(registryChecksum) ||
        _governanceFloor(revocationEpoch, allowZero: true) == null ||
        _governanceFloor(packCompositionVersion, allowZero: false) == null) {
      return false;
    }
    final namespace = await _namespace(tenantId, facilityId);
    final existingWitness = await _readWitness(namespace);
    final existing = existingWitness?.floors;
    final existingRegistryVersion =
        existingWitness?.actionRegistryVersion ?? '0';
    final existingRegistryChecksum = existingWitness?.actionRegistryChecksum;
    if (existing != null &&
        (_lower(packCompositionVersion, existing.packCompositionVersion) ||
            _lower(policyVersion, existing.policyVersion) ||
            _lower(registryVersion, existingRegistryVersion) ||
            (registryVersion == existingRegistryVersion &&
                existingRegistryChecksum != null &&
                registryChecksum != existingRegistryChecksum) ||
            (_higher(registryVersion, existingRegistryVersion) &&
                registryChecksum == existingRegistryChecksum) ||
            _lower(revocationEpoch, existing.revocationEpoch) ||
            trustedNow.toUtc().isBefore(existing.trustedNow.toUtc()))) {
      return false;
    }
    final floors = ClinicalContinuityFloors(
      packCompositionVersion: packCompositionVersion,
      policyVersion: policyVersion,
      manifestVersion: existing?.manifestVersion ?? '0',
      revocationEpoch: revocationEpoch,
      trustedNow: trustedNow.toUtc(),
    );
    await _writeWitness(
      namespace,
      floors,
      actionRegistryVersion: registryVersion,
      actionRegistryChecksum: registryChecksum,
    );
    await _registerNamespace(namespace);
    return true;
  }

  Future<ClinicalContinuityCacheWriteResult> store(
    VerifiedClinicalContinuitySet set,
  ) async {
    if (set.signingKeyFingerprints.isEmpty ||
        set.signingKeyFingerprints.entries.any(
          (entry) =>
              entry.key.isEmpty ||
              !RegExp(r'^[0-9a-f]{64}$').hasMatch(entry.value),
        )) {
      return const ClinicalContinuityCacheWriteResult.rejected(
        ClinicalContinuityVerificationReasons.keyNotTrusted,
      );
    }
    if (set.verifiedByteLength > maxFacilityBytes) {
      return const ClinicalContinuityCacheWriteResult.rejected(
        'FACILITY_CAPACITY_EXCEEDED',
      );
    }
    final namespace = await _namespace(
      set.audience.tenantId,
      set.audience.facilityId,
    );
    final existingWitness = await _readWitness(namespace);
    final existingFloors = existingWitness?.floors;
    if (existingFloors != null &&
        (_lower(
              set.floors.packCompositionVersion,
              existingFloors.packCompositionVersion,
            ) ||
            _lower(set.floors.policyVersion, existingFloors.policyVersion) ||
            _lower(
              set.floors.manifestVersion,
              existingFloors.manifestVersion,
            ) ||
            _lower(
              set.floors.revocationEpoch,
              existingFloors.revocationEpoch,
            ) ||
            set.floors.trustedNow.isBefore(existingFloors.trustedNow))) {
      return const ClinicalContinuityCacheWriteResult.rejected(
        ClinicalContinuityVerificationReasons.rollbackStateRequired,
      );
    }

    final aad = await _authenticatedData(set);
    final codec = _codecFactory('$_encryptionPrefix$namespace');
    String plaintext;
    try {
      plaintext = ClinicalContinuityCanonicalJson.canonicalize({
        'schemaVersion': 1,
        'binding': {
          'tenantId': set.audience.tenantId,
          'facilityId': set.audience.facilityId,
          'staffId': set.prefetchSession.staffId,
          'role': set.prefetchSession.role,
          'deviceId': set.prefetchSession.deviceId,
          'policyId': set.policyId,
          'packCompositionVersion': set.floors.packCompositionVersion,
          'policyVersion': set.floors.policyVersion,
          'manifestVersion': set.floors.manifestVersion,
          'publicationSetId': set.publicationSetId,
          'revocationEpoch': set.floors.revocationEpoch,
          'accessRevision': set.provenance.accessRevision,
          'sourceRevision': set.provenance.sourceRevision,
          'sourceWatermark': set.provenance.sourceWatermark,
        },
        'set': set.toJson(),
      }, limits: _cacheJsonLimits);
    } catch (_) {
      return const ClinicalContinuityCacheWriteResult.rejected(
        'FACILITY_CAPACITY_EXCEEDED',
      );
    }
    final storedByteLength = _storedEnvelopeByteLength(
      utf8.encode(plaintext).length,
      aad.length,
    );
    if (storedByteLength > maxFacilityBytes) {
      return const ClinicalContinuityCacheWriteResult.rejected(
        'FACILITY_CAPACITY_EXCEEDED',
      );
    }
    final accountedByteLength = max(storedByteLength, set.verifiedByteLength);
    final db = await _db();
    final oldRows = await db.query(
      'continuity_facility_sets',
      columns: const ['namespace', 'byte_size', 'expires_at'],
    );
    final existing = oldRows
        .where((row) => row['namespace'] == namespace)
        .firstOrNull;
    if (existing != null && existingFloors == null) {
      return const ClinicalContinuityCacheWriteResult.rejected(
        ClinicalContinuityVerificationReasons.rollbackStateRequired,
      );
    }
    var projected =
        oldRows.fold<int>(
          0,
          (total, row) => total + (row['byte_size']! as int),
        ) -
        ((existing?['byte_size'] as int?) ?? 0) +
        accountedByteLength;
    final expired =
        oldRows
            .where(
              (row) =>
                  row['namespace'] != namespace &&
                  (row['expires_at']! as int) <=
                      set.floors.trustedNow.millisecondsSinceEpoch,
            )
            .toList()
          ..sort(
            (left, right) => (left['expires_at']! as int).compareTo(
              right['expires_at']! as int,
            ),
          );
    final evictions = <String>[];
    for (final row in expired) {
      if (projected <= maxDeviceBytes) break;
      projected -= row['byte_size']! as int;
      evictions.add(row['namespace']! as String);
    }
    if (projected > maxDeviceBytes) {
      return const ClinicalContinuityCacheWriteResult.rejected(
        'DEVICE_CAPACITY_EXCEEDED',
      );
    }

    await _registerNamespace(namespace);
    final ciphertext = await codec.seal(plaintext, authenticatedData: aad);
    // Advance the secure witness before the cache row. A crash can make the
    // older row unusable, but can never make an older version acceptable.
    await _writeWitness(
      namespace,
      set.floors,
      actionRegistryVersion: existingWitness?.actionRegistryVersion,
      actionRegistryChecksum: existingWitness?.actionRegistryChecksum,
    );
    await db.transaction((transaction) async {
      for (final evicted in evictions) {
        await transaction.delete(
          'continuity_facility_sets',
          where: 'namespace = ?',
          whereArgs: [evicted],
        );
      }
      await transaction.insert('continuity_facility_sets', {
        'namespace': namespace,
        'aad': base64Encode(aad),
        'ciphertext': ciphertext,
        'byte_size': accountedByteLength,
        'expires_at': set.expiresAt.millisecondsSinceEpoch,
        'updated_at': set.floors.trustedNow.millisecondsSinceEpoch,
      }, conflictAlgorithm: ConflictAlgorithm.replace);
      await _beforeCommit?.call();
    });
    for (final evicted in evictions) {
      await _destroyNamespace(evicted, deleteWitness: false);
    }
    return const ClinicalContinuityCacheWriteResult.stored();
  }

  Future<ClinicalContinuityCacheReadResult> open({
    required ClinicalContinuitySessionContext session,
    required ClinicalContinuityClockAssessment clock,
  }) async {
    if (!clock.trusted || clock.trustedNow == null) {
      return const ClinicalContinuityCacheReadResult.rejected(
        ClinicalContinuityVerificationReasons.clockUncertain,
      );
    }
    final namespace = await _namespace(session.tenantId, session.facilityId);
    final db = await _db();
    final rows = await db.query(
      'continuity_facility_sets',
      where: 'namespace = ?',
      whereArgs: [namespace],
      limit: 1,
    );
    if (rows.isEmpty) {
      return const ClinicalContinuityCacheReadResult.missing();
    }
    final witness = await readFloors(
      tenantId: session.tenantId,
      facilityId: session.facilityId,
    );
    if (witness == null) {
      return const ClinicalContinuityCacheReadResult.rejected(
        ClinicalContinuityVerificationReasons.rollbackStateRequired,
      );
    }
    try {
      final row = rows.single;
      final aad = base64Decode(row['aad']! as String);
      final codec = _codecFactory('$_encryptionPrefix$namespace');
      final plaintext = await codec.open(
        row['ciphertext']! as String,
        authenticatedData: aad,
      );
      final parsed = ClinicalContinuityCanonicalJson.parse(
        Uint8List.fromList(utf8.encode(plaintext)),
        limits: _cacheJsonLimits,
      );
      final record = Map<String, Object?>.from(parsed! as Map);
      if (record['schemaVersion'] != 1 ||
          record['binding'] is! Map ||
          record['set'] is! Map) {
        throw const FormatException('Invalid cache envelope');
      }
      final set = VerifiedClinicalContinuitySet.fromJson(
        Map<String, Object?>.from(record['set']! as Map),
      );
      final binding = Map<String, Object?>.from(record['binding']! as Map);
      final expectedAad = await _authenticatedData(set);
      if (!_constantTimeEqual(aad, expectedAad) ||
          binding['tenantId'] != session.tenantId ||
          binding['facilityId'] != session.facilityId ||
          binding['staffId'] != set.prefetchSession.staffId ||
          binding['role'] != set.prefetchSession.role ||
          binding['deviceId'] != session.deviceId ||
          binding['policyId'] != set.policyId ||
          (binding['packCompositionVersion'] ?? '1') !=
              set.floors.packCompositionVersion ||
          binding['policyVersion'] != set.floors.policyVersion ||
          binding['manifestVersion'] != set.floors.manifestVersion ||
          binding['publicationSetId'] != set.publicationSetId ||
          binding['revocationEpoch'] != set.floors.revocationEpoch ||
          binding['accessRevision'] != set.provenance.accessRevision ||
          binding['sourceRevision'] != set.provenance.sourceRevision ||
          binding['sourceWatermark'] != set.provenance.sourceWatermark ||
          set.audience.tenantId != session.tenantId ||
          set.audience.facilityId != session.facilityId ||
          set.prefetchSession.deviceId != session.deviceId) {
        return const ClinicalContinuityCacheReadResult.rejected(
          'CACHE_BINDING_MISMATCH',
        );
      }
      if (_lower(
            set.floors.packCompositionVersion,
            witness.packCompositionVersion,
          ) ||
          _lower(set.floors.policyVersion, witness.policyVersion) ||
          _lower(set.floors.manifestVersion, witness.manifestVersion) ||
          _lower(set.floors.revocationEpoch, witness.revocationEpoch) ||
          set.floors.trustedNow.isBefore(witness.trustedNow)) {
        return const ClinicalContinuityCacheReadResult.rejected(
          ClinicalContinuityVerificationReasons.rollbackStateRequired,
        );
      }
      final trustFailure = await _currentTrustFailure(set);
      if (trustFailure != null) {
        return ClinicalContinuityCacheReadResult.rejected(trustFailure);
      }
      final now = clock.trustedNow!.toUtc();
      final minimum = clock.minimumTrustedNow;
      if (now.isBefore(witness.trustedNow) ||
          (minimum != null && now.isBefore(minimum.toUtc()))) {
        return const ClinicalContinuityCacheReadResult.rejected(
          ClinicalContinuityVerificationReasons.clockUncertain,
        );
      }
      final refreshedPacks = <ClinicalContinuityPack>[];
      for (final pack in set.packs) {
        final freshness = _freshness(pack.generatedAt, pack.expiresAt, now);
        if (freshness == ClinicalContinuityFreshness.expired) {
          return const ClinicalContinuityCacheReadResult.rejected(
            ClinicalContinuityVerificationReasons.packExpired,
          );
        }
        if (freshness == ClinicalContinuityFreshness.clockUncertain) {
          return const ClinicalContinuityCacheReadResult.rejected(
            ClinicalContinuityVerificationReasons.clockUncertain,
          );
        }
        refreshedPacks.add(
          ClinicalContinuityPack(
            locationType: pack.locationType,
            locationId: pack.locationId,
            locationLabel: pack.locationLabel,
            content: pack.content,
            htmlBytes: pack.htmlBytes,
            generatedAt: pack.generatedAt,
            expiresAt: pack.expiresAt,
            freshness: freshness,
          ),
        );
      }
      return ClinicalContinuityCacheReadResult.opened(
        VerifiedClinicalContinuitySet(
          audience: set.audience,
          facilityName: set.facilityName,
          facilityTimezone: set.facilityTimezone,
          policyId: set.policyId,
          publicationSetId: set.publicationSetId,
          localUnlockPolicy: set.localUnlockPolicy,
          localGrants: set.localGrants,
          prefetchSession: set.prefetchSession,
          provenance: set.provenance,
          signingKeyFingerprints: set.signingKeyFingerprints,
          floors: set.floors,
          generatedAt: set.generatedAt,
          expiresAt: set.expiresAt,
          evaluatedAt: now,
          packs: List.unmodifiable(refreshedPacks),
          verifiedByteLength: set.verifiedByteLength,
        ),
      );
    } catch (_) {
      return const ClinicalContinuityCacheReadResult.rejected(
        'CACHE_AUTHENTICATION_FAILED',
      );
    }
  }

  Future<void> wipeFacility({
    required String tenantId,
    required String facilityId,
  }) async {
    final namespace = await _namespace(tenantId, facilityId);
    final db = await _db();
    await db.delete(
      'continuity_facility_sets',
      where: 'namespace = ?',
      whereArgs: [namespace],
    );
    await _destroyNamespace(namespace, deleteWitness: true);
    final remaining = await db.query(
      'continuity_facility_sets',
      where: 'namespace = ?',
      whereArgs: [namespace],
      limit: 1,
    );
    if (remaining.isNotEmpty ||
        await VHSecureStorage.instance.read(key: '$_witnessPrefix$namespace') !=
            null ||
        await VHSecureStorage.instance.read(
              key: '$_encryptionPrefix$namespace',
            ) !=
            null) {
      throw StateError('Continuity facility wipe did not complete');
    }
    await _unregisterNamespace(namespace);
    await close();
  }

  Future<void> wipeDevice() async {
    final db = await _db();
    final rows = await db.query(
      'continuity_facility_sets',
      columns: const ['namespace'],
    );
    final namespaces = {
      ...await _readNamespaces(),
      ...rows.map((row) => row['namespace']! as String),
    };
    await db.delete('continuity_facility_sets');
    for (final namespace in namespaces) {
      await _destroyNamespace(namespace, deleteWitness: true);
    }
    final remaining = Sqflite.firstIntValue(
      await db.rawQuery('SELECT COUNT(*) FROM continuity_facility_sets'),
    );
    if (remaining != 0) {
      throw StateError('Continuity device wipe did not complete');
    }
    await VHSecureStorage.instance.delete(key: _namespaceRegistryKey);
    await VHSecureStorage.instance.delete(key: _indexKeyName);
    for (final namespace in namespaces) {
      if (await VHSecureStorage.instance.read(
                key: '$_witnessPrefix$namespace',
              ) !=
              null ||
          await VHSecureStorage.instance.read(
                key: '$_encryptionPrefix$namespace',
              ) !=
              null) {
        throw StateError('Continuity device wipe did not complete');
      }
    }
    if (await VHSecureStorage.instance.read(key: _indexKeyName) != null) {
      throw StateError('Continuity device wipe did not complete');
    }
    await close();
  }

  Future<void> close() async {
    final db = _database;
    _database = null;
    _opening = null;
    await db?.close();
  }

  Future<Database> _db() {
    if (_database != null) return Future.value(_database);
    return _opening ??= _openDatabase()
        .then((database) {
          _database = database;
          return database;
        })
        .whenComplete(() => _opening = null);
  }

  Future<String> _namespace(String tenantId, String facilityId) async {
    return _opaqueDigest(
      _lengthDelimited([
        utf8.encode('namespace-v1'),
        utf8.encode(tenantId),
        utf8.encode(facilityId),
      ]),
    );
  }

  Future<Uint8List> _authenticatedData(
    VerifiedClinicalContinuitySet set,
  ) async {
    final digests = await Future.wait([
      _opaqueDigest(utf8.encode(set.audience.tenantId)),
      _opaqueDigest(utf8.encode(set.audience.facilityId)),
      _opaqueDigest(utf8.encode(set.prefetchSession.staffId)),
      _opaqueDigest(utf8.encode(set.prefetchSession.role)),
      _opaqueDigest(utf8.encode(set.prefetchSession.deviceId)),
      _opaqueDigest(utf8.encode(set.policyId)),
      _opaqueDigest(utf8.encode(set.provenance.sourceRevision)),
      _opaqueDigest(utf8.encode(set.provenance.sourceWatermark)),
    ]);
    return _lengthDelimited([
      utf8.encode('vhhealth-continuity-cache-aad-v1'),
      ...digests.map(utf8.encode),
      utf8.encode(set.floors.policyVersion),
      utf8.encode(set.floors.manifestVersion),
      utf8.encode(set.publicationSetId),
      utf8.encode(set.floors.revocationEpoch),
      utf8.encode(set.provenance.accessRevision ?? ''),
    ]);
  }

  Future<String?> _currentTrustFailure(
    VerifiedClinicalContinuitySet set,
  ) async {
    if (_trustValidator != null) return _trustValidator(set);
    final trust = await _trustStore.load(expectedAudience: set.audience);
    if (trust == null) {
      return ClinicalContinuityVerificationReasons.policyUnavailable;
    }
    if (_lower(set.floors.policyVersion, trust.minimumPolicyVersion)) {
      return ClinicalContinuityVerificationReasons.policyRollback;
    }
    final trustRevocationFloor =
        BigInt.parse(trust.minimumRevocationEpoch) >
            BigInt.parse(trust.revocationEpoch)
        ? trust.minimumRevocationEpoch
        : trust.revocationEpoch;
    if (_lower(set.floors.revocationEpoch, trustRevocationFloor)) {
      return ClinicalContinuityVerificationReasons.revocationEpochRollback;
    }
    for (final entry in set.signingKeyFingerprints.entries) {
      final keyId = entry.key;
      if (trust.revokedKeyIds.contains(keyId)) {
        return ClinicalContinuityVerificationReasons.keyRevoked;
      }
      final key = trust.packSigningKeys[keyId];
      if (key == null) {
        return ClinicalContinuityVerificationReasons.keyNotTrusted;
      }
      if (key.state == ClinicalContinuityKeyState.revoked) {
        return ClinicalContinuityVerificationReasons.keyRevoked;
      }
      if (key.state == ClinicalContinuityKeyState.compromised) {
        return ClinicalContinuityVerificationReasons.keyCompromised;
      }
      if (key.state != ClinicalContinuityKeyState.current &&
          key.state != ClinicalContinuityKeyState.next) {
        return ClinicalContinuityVerificationReasons.keyStateUnsupported;
      }
      final fingerprint = await Sha256().hash(key.rawPublicKey);
      if (_hex(fingerprint.bytes) != entry.value) {
        return ClinicalContinuityVerificationReasons.keyIdMismatch;
      }
    }
    return null;
  }

  Future<String> _opaqueDigest(List<int> value) async {
    final key = await _indexKey();
    final digest = await Hmac.sha256().calculateMac(value, secretKey: key);
    return digest.bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();
  }

  Future<SecretKey> _indexKey() async {
    var raw = await VHSecureStorage.instance.read(key: _indexKeyName);
    if (raw == null) {
      final registry = await VHSecureStorage.instance.read(
        key: _namespaceRegistryKey,
      );
      final database = await _db();
      final rows = Sqflite.firstIntValue(
        await database.rawQuery(
          'SELECT COUNT(*) FROM continuity_facility_sets',
        ),
      );
      if (registry != null || (rows ?? 0) > 0) {
        throw StateError('Clinical continuity cache index is unavailable');
      }
      final random = Random.secure();
      final bytes = List<int>.generate(32, (_) => random.nextInt(256));
      raw = base64Encode(bytes);
      await VHSecureStorage.instance.write(key: _indexKeyName, value: raw);
    }
    return SecretKey(base64Decode(raw));
  }

  Future<void> _writeWitness(
    String namespace,
    ClinicalContinuityFloors floors, {
    String? actionRegistryVersion,
    String? actionRegistryChecksum,
  }) async {
    if ((actionRegistryVersion == null) != (actionRegistryChecksum == null)) {
      throw StateError('Action registry rollback witness is incomplete');
    }
    await VHSecureStorage.instance.write(
      key: '$_witnessPrefix$namespace',
      value: ClinicalContinuityCanonicalJson.canonicalize({
        ...floors.toJson(),
        'actionRegistryVersion': ?actionRegistryVersion,
        'actionRegistryChecksum': ?actionRegistryChecksum,
      }),
    );
  }

  Future<Set<String>> _readNamespaces() async {
    final raw = await VHSecureStorage.instance.read(key: _namespaceRegistryKey);
    if (raw == null) return <String>{};
    try {
      final parsed = ClinicalContinuityCanonicalJson.parse(
        Uint8List.fromList(utf8.encode(raw)),
      );
      if (parsed is! List ||
          parsed.any(
            (value) =>
                value is! String || !RegExp(r'^[0-9a-f]{64}$').hasMatch(value),
          )) {
        throw const FormatException('Invalid continuity namespace registry');
      }
      return parsed.cast<String>().toSet();
    } catch (_) {
      throw StateError('Continuity namespace registry is unavailable');
    }
  }

  Future<void> _registerNamespace(String namespace) async {
    final namespaces = (await _readNamespaces())..add(namespace);
    final sorted = namespaces.toList()..sort();
    await VHSecureStorage.instance.write(
      key: _namespaceRegistryKey,
      value: ClinicalContinuityCanonicalJson.canonicalize(sorted),
    );
  }

  Future<void> _unregisterNamespace(String namespace) async {
    final namespaces = (await _readNamespaces())..remove(namespace);
    if (namespaces.isEmpty) {
      await VHSecureStorage.instance.delete(key: _namespaceRegistryKey);
      return;
    }
    final sorted = namespaces.toList()..sort();
    await VHSecureStorage.instance.write(
      key: _namespaceRegistryKey,
      value: ClinicalContinuityCanonicalJson.canonicalize(sorted),
    );
  }

  Future<void> _destroyNamespace(
    String namespace, {
    required bool deleteWitness,
  }) async {
    await _codecFactory('$_encryptionPrefix$namespace').destroyKey();
    if (deleteWitness) {
      await VHSecureStorage.instance.delete(key: '$_witnessPrefix$namespace');
    }
  }

  static Future<Database> _defaultOpen() async {
    final root = await getDatabasesPath();
    return openDatabase(
      path.join(root, 'clinical_continuity_cache.db'),
      version: 1,
      onConfigure: (database) async {
        await database.execute('PRAGMA secure_delete = ON');
      },
      onCreate: (database, _) async {
        await database.execute('''
          CREATE TABLE continuity_facility_sets (
            namespace TEXT PRIMARY KEY,
            aad TEXT NOT NULL,
            ciphertext TEXT NOT NULL,
            byte_size INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        ''');
        await database.execute(
          'CREATE INDEX continuity_expiry_idx '
          'ON continuity_facility_sets(expires_at)',
        );
      },
    );
  }
}

class _ClinicalContinuityWitness {
  const _ClinicalContinuityWitness({
    required this.floors,
    required this.actionRegistryVersion,
    required this.actionRegistryChecksum,
  });

  final ClinicalContinuityFloors floors;
  final String? actionRegistryVersion;
  final String? actionRegistryChecksum;
}

Uint8List _lengthDelimited(List<List<int>> values) {
  final builder = BytesBuilder(copy: false);
  final length = ByteData(4);
  for (final value in values) {
    length.setUint32(0, value.length, Endian.big);
    builder
      ..add(length.buffer.asUint8List())
      ..add(value);
  }
  return builder.takeBytes();
}

int _storedEnvelopeByteLength(int plaintextBytes, int aadBytes) {
  const nonceBytes = 12;
  const authenticationTagBytes = 16;
  return _base64Length(nonceBytes) +
      1 +
      _base64Length(plaintextBytes + authenticationTagBytes) +
      _base64Length(aadBytes);
}

int _base64Length(int bytes) => ((bytes + 2) ~/ 3) * 4;

bool _lower(String left, String right) =>
    BigInt.parse(left) < BigInt.parse(right);

bool _higher(String left, String right) =>
    BigInt.parse(left) > BigInt.parse(right);

// PostgreSQL BIGINT ceiling (2^63-1) for C3.1 revision values. Parsed from a
// string, never `BigInt.from(9223372036854775807)`: that int literal is not
// exactly representable as a JS double, so it fails to compile under dart2js,
// and the nearest double rounds up to 2^63 — which would widen this bound by
// one. BigInt is arbitrary precision on every target, so parsing is exact.
final BigInt _governanceCeiling = BigInt.parse('9223372036854775807');

String? _governanceFloor(String value, {required bool allowZero}) {
  if (!RegExp(r'^(?:0|[1-9][0-9]{0,18})$').hasMatch(value) ||
      (!allowZero && value == '0') ||
      BigInt.parse(value) > _governanceCeiling) {
    return null;
  }
  return value;
}

bool _constantTimeEqual(List<int> left, List<int> right) {
  if (left.length != right.length) return false;
  var difference = 0;
  for (var i = 0; i < left.length; i++) {
    difference |= left[i] ^ right[i];
  }
  return difference == 0;
}

String _hex(List<int> bytes) =>
    bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();

ClinicalContinuityFreshness _freshness(
  DateTime issuedAt,
  DateTime expiresAt,
  DateTime now,
) {
  if (now.isBefore(issuedAt)) {
    return ClinicalContinuityFreshness.clockUncertain;
  }
  if (!now.isBefore(expiresAt) ||
      !now.isBefore(issuedAt.add(const Duration(hours: 24)))) {
    return ClinicalContinuityFreshness.expired;
  }
  return now.difference(issuedAt) <= const Duration(minutes: 15)
      ? ClinicalContinuityFreshness.current
      : ClinicalContinuityFreshness.aged;
}
