import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:timezone/data/latest.dart' as timezone_data;
import 'package:timezone/timezone.dart' as timezone;

import '../models/clinical_continuity.dart';
import 'clinical_continuity_canonical_json.dart';
import 'clinical_continuity_source.dart';
import 'clinical_continuity_trust_store.dart';

class ClinicalContinuityVerificationReasons {
  ClinicalContinuityVerificationReasons._();

  static const invalidEnvelope = 'INVALID_ENVELOPE';
  static const unsupportedAlgorithm = 'UNSUPPORTED_ALGORITHM';
  static const keyIdMismatch = 'KEY_ID_MISMATCH';
  static const keyNotTrusted = 'KEY_NOT_TRUSTED';
  static const keyRevoked = 'KEY_REVOKED';
  static const keyCompromised = 'KEY_COMPROMISED';
  static const keyStateUnsupported = 'KEY_STATE_UNSUPPORTED';
  static const keyInvalid = 'KEY_INVALID';
  static const audienceRequired = 'AUDIENCE_REQUIRED';
  static const audienceMismatch = 'AUDIENCE_MISMATCH';
  static const contentHashMismatch = 'CONTENT_HASH_MISMATCH';
  static const renderHashMismatch = 'RENDER_HASH_MISMATCH';
  static const renderRequired = 'RENDER_REQUIRED';
  static const signatureInvalid = 'SIGNATURE_INVALID';
  static const policyRollback = 'POLICY_ROLLBACK';
  static const manifestRollback = 'MANIFEST_ROLLBACK';
  static const revocationEpochRollback = 'REVOCATION_EPOCH_ROLLBACK';
  static const rollbackStateRequired = 'ROLLBACK_STATE_REQUIRED';
  static const packExpired = 'PACK_EXPIRED';
  static const clockUncertain = 'CLOCK_UNCERTAIN';
  static const canonicalizationFailed = 'CANONICALIZATION_FAILED';
  static const unsafePath = 'UNSAFE_PATH';
  static const manifestInvalid = 'MANIFEST_INVALID';
  static const assetMissing = 'ASSET_MISSING';
  static const assetExtra = 'ASSET_EXTRA';
  static const assetHashMismatch = 'ASSET_HASH_MISMATCH';
  static const coverageMismatch = 'COVERAGE_MISMATCH';
  static const edgeAccessInvalid = 'EDGE_ACCESS_INVALID';
  static const edgeAccessMismatch = 'EDGE_ACCESS_MISMATCH';
  static const accessRevisionRollback = 'ACCESS_REVISION_ROLLBACK';
  static const policyUnavailable = 'POLICY_UNAVAILABLE';
}

class ClinicalContinuityVerificationResult {
  final bool ok;
  final String? reason;
  final VerifiedClinicalContinuitySet? verifiedSet;

  const ClinicalContinuityVerificationResult._({
    required this.ok,
    this.reason,
    this.verifiedSet,
  });

  const ClinicalContinuityVerificationResult.rejected(String reason)
    : this._(ok: false, reason: reason);

  const ClinicalContinuityVerificationResult.accepted(
    VerifiedClinicalContinuitySet set,
  ) : this._(ok: true, verifiedSet: set);
}

class ClinicalContinuityVerifier {
  static const _maxAssets = 512;
  static const _maxFacilityBytes = 256 * 1024 * 1024;
  static const _maxRenderedBytes = 4 * 1024 * 1024;
  static const _hashPattern = r'^[0-9a-f]{64}$';
  static const _uuidPattern =
      r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  static const _safeSegmentPattern = r'^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$';
  static const _tenantPattern =
      r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  final ClinicalContinuityTrustStore _trustStore;

  ClinicalContinuityVerifier({
    ClinicalContinuityTrustStore trustStore =
        const ClinicalContinuityTrustStore(),
  }) : _trustStore = trustStore {
    timezone_data.initializeTimeZones();
  }

  Future<ClinicalContinuityVerificationResult> verify(
    ClinicalContinuitySourceSnapshot snapshot, {
    ClinicalContinuityFloors? persistedFloors,
  }) async {
    try {
      return await _verify(snapshot, persistedFloors: persistedFloors);
    } on _VerificationFailure catch (failure) {
      return ClinicalContinuityVerificationResult.rejected(failure.reason);
    } catch (_) {
      return const ClinicalContinuityVerificationResult.rejected(
        ClinicalContinuityVerificationReasons.invalidEnvelope,
      );
    }
  }

  Future<ClinicalContinuityVerificationResult> _verify(
    ClinicalContinuitySourceSnapshot snapshot, {
    ClinicalContinuityFloors? persistedFloors,
  }) async {
    final session = snapshot.session;
    final audience = _audience(session.tenantId, session.facilityId);
    final clock = snapshot.clock;
    if (!clock.trusted || clock.trustedNow == null) {
      _reject(ClinicalContinuityVerificationReasons.clockUncertain);
    }
    final trustedNow = clock.trustedNow!.toUtc();
    final previousTrustedNow = _latestTime([
      persistedFloors?.trustedNow,
      clock.minimumTrustedNow,
    ]);
    if (previousTrustedNow != null &&
        trustedNow.isBefore(previousTrustedNow.toUtc())) {
      _reject(ClinicalContinuityVerificationReasons.clockUncertain);
    }

    final trust = await _trustStore.load(expectedAudience: audience);
    if (trust == null) {
      _reject(ClinicalContinuityVerificationReasons.policyUnavailable);
    }
    final manifestFloor = persistedFloors?.manifestVersion ?? '0';
    final policyFloor = _maxGovernance([
      trust.minimumPolicyVersion,
      persistedFloors?.policyVersion,
    ]);
    final revocationFloor = _maxGovernance([
      trust.minimumRevocationEpoch,
      trust.revocationEpoch,
      persistedFloors?.revocationEpoch,
    ], allowZero: true);

    final manifestJson = _parseMap(
      snapshot.manifestEnvelopeBytes,
      ClinicalContinuityVerificationReasons.manifestInvalid,
    );
    final manifest = await _verifyEnvelope(
      manifestJson,
      rendered: ClinicalContinuityCanonicalJson.canonicalBytes(
        manifestJson['content'],
      ),
      trust: trust,
      audience: audience,
      minimumManifestVersion: manifestFloor,
      minimumPolicyVersion: policyFloor,
      minimumRevocationEpoch: revocationFloor,
      trustedNow: trustedNow,
      minimumTrustedNow: previousTrustedNow,
    );
    final content = _map(manifest.content);
    if (content == null ||
        !_exactKeys(content, const {
          'edgeAccess',
          'facility',
          'format',
          'generatedAt',
          'locations',
          'manifestVersion',
          'policy',
          'publicationSetId',
          'sourceWatermark',
          'tenantId',
        }) ||
        content['format'] != 'vhhealth_clinical_continuity_manifest/v1' ||
        content['tenantId'] != audience.tenantId ||
        content['generatedAt'] != manifest.issuedAt ||
        content['manifestVersion'] != manifest.manifestVersion ||
        !_matches(_uuidPattern, content['publicationSetId'])) {
      _reject(ClinicalContinuityVerificationReasons.manifestInvalid);
    }

    final facility = _map(content['facility']);
    final policy = _map(content['policy']);
    final edgeReference = _map(content['edgeAccess']);
    if (facility == null ||
        !_exactKeys(facility, const {'id', 'name', 'timezone'}) ||
        facility['id'] != audience.facilityId ||
        facility['name'] is! String ||
        (facility['name']! as String).isEmpty ||
        facility['timezone'] is! String ||
        !_validTimezone(facility['timezone']! as String) ||
        policy == null ||
        !_exactKeys(policy, const {
          'checksum',
          'id',
          'revocationEpoch',
          'version',
        }) ||
        !_matches(_hashPattern, policy['checksum']) ||
        !_matches(_uuidPattern, policy['id']) ||
        policy['version'] != manifest.policyVersion ||
        policy['revocationEpoch'] != manifest.revocationEpoch ||
        edgeReference == null ||
        !_exactKeys(edgeReference, const {
          'accessRevision',
          'path',
          'sha256',
        }) ||
        edgeReference['path'] != 'edge-access.json' ||
        !_matches(_hashPattern, edgeReference['sha256'])) {
      _reject(ClinicalContinuityVerificationReasons.manifestInvalid);
    }

    final accessRevision = _governance(
      edgeReference['accessRevision'],
      allowZero: true,
    );
    if (accessRevision == null) {
      _reject(ClinicalContinuityVerificationReasons.edgeAccessInvalid);
    }
    final sourceAccessRevision = snapshot.provenance.accessRevision;
    if (sourceAccessRevision != null &&
        _governance(sourceAccessRevision, allowZero: true) != accessRevision) {
      _reject(ClinicalContinuityVerificationReasons.edgeAccessMismatch);
    }

    final locationEntries = content['locations'];
    if (locationEntries is! List ||
        locationEntries.isEmpty ||
        1 + (locationEntries.length * 2) > _maxAssets) {
      _reject(ClinicalContinuityVerificationReasons.coverageMismatch);
    }

    final expectedAssets = <String>{'edge-access.json'};
    final locationKeys = <String>{};
    final entries = <_ManifestLocation>[];
    for (final raw in locationEntries) {
      final entry = _manifestLocation(raw);
      if (entry == null || !locationKeys.add(entry.key)) {
        _reject(ClinicalContinuityVerificationReasons.coverageMismatch);
      }
      entries.add(entry);
      expectedAssets
        ..add(entry.jsonPath)
        ..add(entry.htmlPath);
    }
    _verifyAssetNames(snapshot.assets, expectedAssets);

    final totalBytes =
        snapshot.manifestEnvelopeBytes.length +
        snapshot.assets.values.fold<int>(0, (sum, bytes) => sum + bytes.length);
    if (totalBytes > _maxFacilityBytes) {
      _reject(ClinicalContinuityVerificationReasons.assetHashMismatch);
    }

    final edgeBytes = snapshot.assets['edge-access.json']!;
    if (await _sha256Hex(edgeBytes) != edgeReference['sha256']) {
      _reject(ClinicalContinuityVerificationReasons.assetHashMismatch);
    }
    final edgeJson = _parseMap(
      edgeBytes,
      ClinicalContinuityVerificationReasons.edgeAccessInvalid,
    );
    final edgeEnvelope = await _verifyEnvelope(
      edgeJson,
      rendered: ClinicalContinuityCanonicalJson.canonicalBytes(
        edgeJson['content'],
      ),
      trust: trust,
      audience: audience,
      minimumManifestVersion: manifestFloor,
      minimumPolicyVersion: policyFloor,
      minimumRevocationEpoch: revocationFloor,
      trustedNow: trustedNow,
      minimumTrustedNow: previousTrustedNow,
    );
    final edge = _edgeAccess(
      edgeEnvelope,
      audience: audience,
      expectedPolicyId: policy['id']! as String,
      expectedPolicyVersion: manifest.policyVersion,
      expectedRevocationEpoch: manifest.revocationEpoch,
      expectedAccessRevision: accessRevision,
      coverage: locationKeys,
      session: session,
      trustedNow: trustedNow,
    );

    final packs = <ClinicalContinuityPack>[];
    for (final entry in entries) {
      packs.add(
        await _verifyPack(
          entry,
          snapshot.assets,
          trust: trust,
          audience: audience,
          minimumManifestVersion: manifestFloor,
          minimumPolicyVersion: policyFloor,
          minimumRevocationEpoch: revocationFloor,
          expectedPolicyId: policy['id']! as String,
          trustedNow: trustedNow,
          minimumTrustedNow: previousTrustedNow,
          facilityName: facility['name']! as String,
          facilityTimezone: facility['timezone']! as String,
        ),
      );
    }

    final expiresAt = packs
        .map((pack) => pack.expiresAt)
        .reduce((left, right) => left.isBefore(right) ? left : right);
    final signingKeyIds = {
      manifest.keyId,
      edgeEnvelope.keyId,
      ...entries.map((entry) => entry.keyId),
    };
    final signingKeyFingerprints = <String, String>{};
    for (final keyId in signingKeyIds) {
      signingKeyFingerprints[keyId] = await _sha256Hex(
        trust.packSigningKeys[keyId]!.rawPublicKey,
      );
    }
    final set = VerifiedClinicalContinuitySet(
      audience: audience,
      facilityName: facility['name']! as String,
      facilityTimezone: facility['timezone']! as String,
      policyId: policy['id']! as String,
      publicationSetId: content['publicationSetId']! as String,
      localUnlockPolicy: edge.localUnlockPolicy,
      localGrants: edge.localGrants,
      prefetchSession: session,
      provenance: ClinicalContinuitySourceProvenance(
        sourceRevision: snapshot.provenance.sourceRevision,
        sourceWatermark: ClinicalContinuityCanonicalJson.canonicalize(
          content['sourceWatermark'],
        ),
        accessRevision: accessRevision,
      ),
      signingKeyFingerprints: Map.unmodifiable(signingKeyFingerprints),
      floors: ClinicalContinuityFloors(
        policyVersion: manifest.policyVersion,
        manifestVersion: manifest.manifestVersion,
        revocationEpoch: manifest.revocationEpoch,
        trustedNow: trustedNow,
      ),
      generatedAt: DateTime.parse(manifest.issuedAt),
      expiresAt: expiresAt,
      evaluatedAt: trustedNow,
      packs: List.unmodifiable(packs),
      verifiedByteLength: totalBytes,
    );
    return ClinicalContinuityVerificationResult.accepted(set);
  }

  Future<ClinicalContinuityPack> _verifyPack(
    _ManifestLocation entry,
    Map<String, Uint8List> assets, {
    required ClinicalContinuityTrustBundle trust,
    required ClinicalContinuityAudience audience,
    required String minimumManifestVersion,
    required String minimumPolicyVersion,
    required String minimumRevocationEpoch,
    required String expectedPolicyId,
    required DateTime trustedNow,
    required DateTime? minimumTrustedNow,
    required String facilityName,
    required String facilityTimezone,
  }) async {
    final jsonBytes = assets[entry.jsonPath]!;
    final htmlBytes = assets[entry.htmlPath]!;
    if (htmlBytes.length > _maxRenderedBytes ||
        await _sha256Hex(jsonBytes) != entry.packJsonSha256 ||
        await _sha256Hex(htmlBytes) != entry.packHtmlSha256) {
      _reject(ClinicalContinuityVerificationReasons.assetHashMismatch);
    }
    final envelopeJson = _parseMap(
      jsonBytes,
      ClinicalContinuityVerificationReasons.invalidEnvelope,
    );
    final envelope = await _verifyEnvelope(
      envelopeJson,
      rendered: htmlBytes,
      trust: trust,
      audience: audience,
      minimumManifestVersion: minimumManifestVersion,
      minimumPolicyVersion: minimumPolicyVersion,
      minimumRevocationEpoch: minimumRevocationEpoch,
      trustedNow: trustedNow,
      minimumTrustedNow: minimumTrustedNow,
    );
    if (envelope.contentHash != entry.contentHash ||
        envelope.renderHash != entry.renderHash ||
        envelope.keyId != entry.keyId ||
        envelope.issuedAt != entry.generatedAt ||
        envelope.expiresAt != entry.expiresAt) {
      _reject(ClinicalContinuityVerificationReasons.assetHashMismatch);
    }
    final content = _map(envelope.content);
    if (!_validPackContent(
          content,
          entry: entry,
          audience: audience,
          envelope: envelope,
          expectedPolicyId: expectedPolicyId,
          facilityName: facilityName,
          facilityTimezone: facilityTimezone,
        ) ||
        _containsBloodGroup(content)) {
      _reject(ClinicalContinuityVerificationReasons.coverageMismatch);
    }
    final location = _map(content!['location'])!;
    if (entry.locationType == 'opd_day') {
      final handling = _map(content['handling']);
      if (handling?['printed_sheet'] != 'DESTROY AFTER CLINIC DAY') {
        _reject(ClinicalContinuityVerificationReasons.coverageMismatch);
      }
    }
    return ClinicalContinuityPack(
      locationType: entry.locationType,
      locationId: entry.locationId,
      locationLabel: (location['label'] as String?) ?? entry.locationId,
      content: content,
      htmlBytes: Uint8List.fromList(htmlBytes),
      generatedAt: DateTime.parse(envelope.issuedAt),
      expiresAt: DateTime.parse(envelope.expiresAt),
      freshness: envelope.freshness,
    );
  }

  bool _validPackContent(
    Map<String, Object?>? content, {
    required _ManifestLocation entry,
    required ClinicalContinuityAudience audience,
    required _VerifiedEnvelope envelope,
    required String expectedPolicyId,
    required String facilityName,
    required String facilityTimezone,
  }) {
    if (content == null) return false;
    final expectedKeys = <String>{
      'expires_at',
      'facility',
      'fresh_until',
      'generated_at',
      'historical_mode',
      'location',
      'not_valid_after',
      'pack_schema_version',
      'patients',
      'policy',
      'source_watermark',
      'tenant_id',
      if (entry.locationType == 'opd_day') 'handling',
    };
    if (!_exactKeys(content, expectedKeys) ||
        content['pack_schema_version'] != 1 ||
        content['tenant_id'] != audience.tenantId ||
        content['historical_mode'] != false) {
      return false;
    }

    final facility = _map(content['facility']);
    final location = _map(content['location']);
    final policy = _map(content['policy']);
    final watermark = _map(content['source_watermark']);
    if (facility == null ||
        !_exactKeys(facility, const {'code', 'id', 'name', 'timezone'}) ||
        facility['id'] != audience.facilityId ||
        facility['code'] is! String ||
        (facility['code']! as String).trim().isEmpty ||
        facility['name'] != facilityName ||
        facility['timezone'] != facilityTimezone ||
        location == null ||
        policy == null ||
        !_exactKeys(policy, const {'id', 'revocation_epoch', 'version'}) ||
        policy['id'] != expectedPolicyId ||
        policy['version'] != envelope.policyVersion ||
        policy['revocation_epoch'] != envelope.revocationEpoch ||
        watermark == null ||
        !_exactKeys(watermark, const {
          'captured_at',
          'transaction_id',
          'transaction_isolation',
          'txid_snapshot',
        }) ||
        watermark['captured_at'] != envelope.issuedAt ||
        watermark['transaction_id'] is! String ||
        watermark['txid_snapshot'] is! String ||
        !const {
          'repeatable read',
          'serializable',
        }.contains(watermark['transaction_isolation'])) {
      return false;
    }

    final expectedLocationKeys =
        entry.locationType == 'ward' || entry.locationType == 'paeds'
        ? const {'area_profile', 'id', 'identifier', 'label', 'type', 'ward_id'}
        : const {'id', 'identifier', 'label', 'type'};
    if (!_exactKeys(location, expectedLocationKeys) ||
        location['type'] != entry.locationType ||
        location['id'] != entry.locationId ||
        location['identifier'] != entry.locationId ||
        location['label'] is! String ||
        (location['label']! as String).trim().isEmpty) {
      return false;
    }
    if ((entry.locationType == 'ward' || entry.locationType == 'paeds') &&
        (location['ward_id'] is! String ||
            _governance(location['ward_id']) == null ||
            location['area_profile'] != entry.locationType)) {
      return false;
    }

    final generated = content['generated_at'];
    final freshUntil = content['fresh_until'];
    final expires = content['expires_at'];
    final notValidAfter = content['not_valid_after'];
    if (!_canonicalTimestamp(generated) ||
        !_canonicalTimestamp(freshUntil) ||
        !_canonicalTimestamp(expires) ||
        !_canonicalTimestamp(notValidAfter) ||
        generated != envelope.issuedAt ||
        expires != envelope.expiresAt ||
        notValidAfter != expires) {
      return false;
    }
    final generatedAt = DateTime.parse(generated! as String);
    final freshAt = DateTime.parse(freshUntil! as String);
    final expiresAt = DateTime.parse(expires! as String);
    if (freshAt != generatedAt.add(const Duration(minutes: 15)) ||
        !expiresAt.isAfter(generatedAt) ||
        expiresAt.isAfter(generatedAt.add(const Duration(hours: 24)))) {
      return false;
    }

    final patients = content['patients'];
    if (patients is! List ||
        patients.any(
          (patient) =>
              !_validPatient(_map(patient), locationType: entry.locationType),
        )) {
      return false;
    }
    if (entry.locationType == 'opd_day') {
      final handling = _map(content['handling']);
      if (handling == null ||
          !_exactKeys(handling, const {'printed_sheet'}) ||
          handling['printed_sheet'] != 'DESTROY AFTER CLINIC DAY') {
        return false;
      }
    }
    return true;
  }

  bool _validPatient(
    Map<String, Object?>? patient, {
    required String locationType,
  }) {
    if (patient == null) return false;
    const common = {
      'active_medication_orders',
      'allergies',
      'attending',
      'care_team',
      'code_status',
      'diagnosis',
      'identity',
      'isolation',
      'latest_vitals',
      'location',
      'medications_due',
      'news2',
      'recent_released_results',
      'recently_administered_medications',
      'unresolved_critical_results',
    };
    final variant = switch (locationType) {
      'paeds' => const {'latest_weight'},
      'ed_board' => const {'arrival_at', 'time_in_department', 'triage'},
      'opd_day' => const {'appointment_status', 'appointment_time', 'phone'},
      _ => const <String>{},
    };
    final required = {...common, ...variant};
    final allowed = {...required, 'patient_sources_resolved'};
    if (!patient.keys.toSet().containsAll(required) ||
        patient.keys.toSet().difference(allowed).isNotEmpty ||
        (patient.containsKey('patient_sources_resolved') &&
            patient['patient_sources_resolved'] != false)) {
      return false;
    }
    for (final fieldName in required) {
      if (!_validClinicalField(patient[fieldName])) return false;
    }
    final identity = _map(_map(patient['identity'])?['value']);
    if (identity == null ||
        !_exactKeys(identity, const {
          'dob',
          'identity_status',
          'mrn',
          'name',
          'uid',
        }) ||
        !const {
          'identified',
          'temporary_or_unidentified',
        }.contains(identity['identity_status']) ||
        !_validClinicalField(identity['name']) ||
        !_validClinicalField(identity['mrn']) ||
        !_validClinicalField(identity['uid']) ||
        !_validClinicalField(identity['dob'])) {
      return false;
    }
    return true;
  }

  bool _validClinicalField(Object? raw) {
    final field = _map(raw);
    if (field == null || field['state'] is! String) return false;
    if (field['state'] == 'known') {
      return _exactKeys(field, const {
            'recorded_at',
            'source',
            'state',
            'timestamp_basis',
            'value',
          }) &&
          _canonicalTimestamp(field['recorded_at']) &&
          field['source'] is String &&
          (field['source']! as String).trim().isNotEmpty &&
          const {
            'snapshot_watermark',
            'source_recorded_at',
          }.contains(field['timestamp_basis']);
    }
    return field['state'] == 'unknown' &&
        _exactKeys(field, const {
          'reason',
          'recorded_at',
          'source',
          'state',
          'timestamp_basis',
          'value',
        }) &&
        field['value'] == null &&
        field['recorded_at'] == null &&
        (field['source'] == null || field['source'] is String) &&
        field['timestamp_basis'] == 'not_available' &&
        field['reason'] is String &&
        (field['reason']! as String).trim().isNotEmpty;
  }

  _VerifiedEdgeAccess _edgeAccess(
    _VerifiedEnvelope envelope, {
    required ClinicalContinuityAudience audience,
    required String expectedPolicyId,
    required String expectedPolicyVersion,
    required String expectedRevocationEpoch,
    required String expectedAccessRevision,
    required Set<String> coverage,
    required ClinicalContinuitySessionContext session,
    required DateTime trustedNow,
  }) {
    final content = _map(envelope.content);
    final edge = _map(content?['edgeAccess']);
    final edgeAudience = _map(content?['audience']);
    final policy = _map(content?['policy']);
    if (content == null ||
        !_exactKeys(content, const {
          'accessRevision',
          'audience',
          'edgeAccess',
          'format',
          'generatedAt',
          'grants',
          'policy',
          'revocations',
        }) ||
        content['format'] != 'vhhealth_continuity_edge_access/v1' ||
        content['accessRevision'] != expectedAccessRevision ||
        content['generatedAt'] != envelope.issuedAt ||
        edgeAudience == null ||
        !_exactKeys(edgeAudience, const {'facilityId', 'tenantId'}) ||
        edgeAudience['tenantId'] != audience.tenantId ||
        edgeAudience['facilityId'] != audience.facilityId ||
        policy == null ||
        !_exactKeys(policy, const {'id', 'revocationEpoch', 'version'}) ||
        policy['id'] != expectedPolicyId ||
        policy['version'] != expectedPolicyVersion ||
        policy['revocationEpoch'] != expectedRevocationEpoch ||
        edge == null ||
        !_exactKeys(edge, const {
          'authenticationMode',
          'credentialLifetimeMinutes',
          'emergencyReadPosture',
          'maximumOfflineAuthorizationMinutes',
        })) {
      _reject(ClinicalContinuityVerificationReasons.edgeAccessMismatch);
    }

    final authenticationMode = edge['authenticationMode'];
    final credentialMinutes = edge['credentialLifetimeMinutes'];
    final emergencyReadPosture = edge['emergencyReadPosture'];
    final maximumAuthorizationMinutes =
        edge['maximumOfflineAuthorizationMinutes'];
    if (authenticationMode != 'mtls_client_certificate' ||
        credentialMinutes is! int ||
        credentialMinutes < 1 ||
        maximumAuthorizationMinutes is! int ||
        maximumAuthorizationMinutes < 1 ||
        credentialMinutes < maximumAuthorizationMinutes ||
        emergencyReadPosture is! String ||
        !const {'disabled', 'read_only'}.contains(emergencyReadPosture)) {
      _reject(ClinicalContinuityVerificationReasons.edgeAccessInvalid);
    }

    final grants = content['grants'];
    final revocations = content['revocations'];
    if (grants is! List || revocations is! List) {
      _reject(ClinicalContinuityVerificationReasons.edgeAccessInvalid);
    }
    final revokedGrantIds = <String>{};
    for (final raw in revocations) {
      final revocation = _map(raw);
      if (revocation == null ||
          !_exactKeys(revocation, const {
            'accessRevision',
            'grantId',
            'revokedAt',
          }) ||
          !_matches(_uuidPattern, revocation['grantId']) ||
          !_revisionAtOrBelow(
            revocation['accessRevision'],
            expectedAccessRevision,
          ) ||
          !_canonicalTimestamp(revocation['revokedAt']) ||
          !revokedGrantIds.add(revocation['grantId']! as String)) {
        _reject(ClinicalContinuityVerificationReasons.edgeAccessInvalid);
      }
    }

    final authorizedCoverage = <String>{};
    final seenGrantIds = <String>{};
    final localGrants = <ClinicalContinuityLocalGrant>[];
    for (final raw in grants) {
      final grant = _map(raw);
      if (grant == null ||
          !_exactKeys(grant, const {
            'accessRevision',
            'clientCertificateSha256',
            'deviceId',
            'grantId',
            'locationIdentifier',
            'locationType',
            'staffUid',
            'validFrom',
            'validUntil',
          }) ||
          !_matches(_uuidPattern, grant['grantId']) ||
          !_matches(_uuidPattern, grant['staffUid']) ||
          !_matches(_hashPattern, grant['clientCertificateSha256']) ||
          !_revisionAtOrBelow(
            grant['accessRevision'],
            expectedAccessRevision,
          ) ||
          grant['deviceId'] is! String ||
          (grant['deviceId']! as String).trim() != grant['deviceId'] ||
          (grant['deviceId']! as String).isEmpty ||
          (grant['deviceId']! as String).length > 160 ||
          !const {
            'ward',
            'paeds',
            'ed_board',
            'opd_day',
          }.contains(grant['locationType']) ||
          !_matches(_safeSegmentPattern, grant['locationIdentifier']) ||
          !_canonicalTimestamp(grant['validFrom']) ||
          !_canonicalTimestamp(grant['validUntil']) ||
          !seenGrantIds.add(grant['grantId']! as String)) {
        _reject(ClinicalContinuityVerificationReasons.edgeAccessInvalid);
      }
      final key = '${grant['locationType']}/${grant['locationIdentifier']}';
      final from = DateTime.parse(grant['validFrom']! as String);
      final until = DateTime.parse(grant['validUntil']! as String);
      if (!coverage.contains(key) ||
          !until.isAfter(from) ||
          until.difference(from).inMinutes > credentialMinutes) {
        _reject(ClinicalContinuityVerificationReasons.edgeAccessMismatch);
      }
      if (!revokedGrantIds.contains(grant['grantId'])) {
        localGrants.add(
          ClinicalContinuityLocalGrant(
            staffId: grant['staffUid']! as String,
            deviceId: grant['deviceId']! as String,
            locationType: grant['locationType']! as String,
            locationId: grant['locationIdentifier']! as String,
            validFrom: from,
            validUntil: until,
          ),
        );
      }
      if (grant['staffUid'] == session.staffId &&
          grant['deviceId'] == session.deviceId &&
          coverage.contains(key) &&
          !revokedGrantIds.contains(grant['grantId']) &&
          !trustedNow.isBefore(from) &&
          trustedNow.isBefore(until)) {
        authorizedCoverage.add(key);
      }
    }
    if (!seenGrantIds.containsAll(revokedGrantIds)) {
      _reject(ClinicalContinuityVerificationReasons.edgeAccessInvalid);
    }
    if (!authorizedCoverage.containsAll(coverage)) {
      _reject(ClinicalContinuityVerificationReasons.edgeAccessMismatch);
    }

    return _VerifiedEdgeAccess(
      localUnlockPolicy: ClinicalContinuityLocalUnlockPolicy(
        authenticationMode: authenticationMode! as String,
        maximumAuthorizationMinutes: maximumAuthorizationMinutes,
        emergencyReadPosture: emergencyReadPosture,
      ),
      localGrants: List.unmodifiable(localGrants),
    );
  }

  Future<_VerifiedEnvelope> _verifyEnvelope(
    Map<String, Object?> envelope, {
    required Uint8List rendered,
    required ClinicalContinuityTrustBundle trust,
    required ClinicalContinuityAudience audience,
    required String minimumManifestVersion,
    required String minimumPolicyVersion,
    required String minimumRevocationEpoch,
    required DateTime trustedNow,
    required DateTime? minimumTrustedNow,
  }) async {
    if (!_exactKeys(envelope, const {
      'algorithm',
      'audience',
      'content',
      'contentHash',
      'envelopeVersion',
      'expiresAt',
      'issuedAt',
      'keyId',
      'manifestVersion',
      'policyVersion',
      'revocationEpoch',
      'renderHash',
      'signature',
    })) {
      _reject(ClinicalContinuityVerificationReasons.invalidEnvelope);
    }
    if (envelope['algorithm'] != 'Ed25519') {
      _reject(ClinicalContinuityVerificationReasons.unsupportedAlgorithm);
    }
    final signedAudience = _map(envelope['audience']);
    if (signedAudience == null ||
        !_exactKeys(signedAudience, const {'facilityId', 'tenantId'})) {
      _reject(ClinicalContinuityVerificationReasons.invalidEnvelope);
    }
    if (signedAudience['tenantId'] != audience.tenantId ||
        signedAudience['facilityId'] != audience.facilityId) {
      _reject(ClinicalContinuityVerificationReasons.audienceMismatch);
    }
    final manifestVersion = _governance(envelope['manifestVersion']);
    final policyVersion = _governance(envelope['policyVersion']);
    final revocationEpoch = _governance(
      envelope['revocationEpoch'],
      allowZero: true,
    );
    if (envelope['envelopeVersion'] != 1 ||
        manifestVersion == null ||
        policyVersion == null ||
        revocationEpoch == null ||
        !_matches(_hashPattern, envelope['contentHash']) ||
        !_matches(_hashPattern, envelope['renderHash']) ||
        !_canonicalTimestamp(envelope['issuedAt']) ||
        !_canonicalTimestamp(envelope['expiresAt']) ||
        envelope['keyId'] is! String) {
      _reject(ClinicalContinuityVerificationReasons.invalidEnvelope);
    }
    final keyId = envelope['keyId']! as String;
    if (trust.revokedKeyIds.contains(keyId)) {
      _reject(ClinicalContinuityVerificationReasons.keyRevoked);
    }
    final key = trust.packSigningKeys[keyId];
    if (key == null) {
      _reject(ClinicalContinuityVerificationReasons.keyNotTrusted);
    }
    if (key.state == ClinicalContinuityKeyState.revoked) {
      _reject(ClinicalContinuityVerificationReasons.keyRevoked);
    }
    if (key.state == ClinicalContinuityKeyState.compromised) {
      _reject(ClinicalContinuityVerificationReasons.keyCompromised);
    }
    if (key.state != ClinicalContinuityKeyState.current &&
        key.state != ClinicalContinuityKeyState.next) {
      _reject(ClinicalContinuityVerificationReasons.keyStateUnsupported);
    }
    if (BigInt.parse(policyVersion) < BigInt.parse(minimumPolicyVersion)) {
      _reject(ClinicalContinuityVerificationReasons.policyRollback);
    }
    if (BigInt.parse(manifestVersion) < BigInt.parse(minimumManifestVersion)) {
      _reject(ClinicalContinuityVerificationReasons.manifestRollback);
    }
    if (BigInt.parse(revocationEpoch) < BigInt.parse(minimumRevocationEpoch)) {
      _reject(ClinicalContinuityVerificationReasons.revocationEpochRollback);
    }

    Uint8List canonicalContent;
    try {
      canonicalContent = ClinicalContinuityCanonicalJson.canonicalBytes(
        envelope['content'],
      );
    } catch (_) {
      _reject(ClinicalContinuityVerificationReasons.canonicalizationFailed);
    }
    if (await _sha256Hex(canonicalContent) != envelope['contentHash']) {
      _reject(ClinicalContinuityVerificationReasons.contentHashMismatch);
    }
    if (rendered.length > _maxRenderedBytes ||
        await _sha256Hex(rendered) != envelope['renderHash']) {
      _reject(ClinicalContinuityVerificationReasons.renderHashMismatch);
    }

    final signature = _signature(envelope['signature']);
    if (signature == null) {
      _reject(ClinicalContinuityVerificationReasons.signatureInvalid);
    }
    final unsigned = Map<String, Object?>.from(envelope)..remove('signature');
    final verified = await Ed25519().verify(
      ClinicalContinuityCanonicalJson.canonicalBytes(unsigned),
      signature: Signature(
        signature,
        publicKey: SimplePublicKey(key.rawPublicKey, type: KeyPairType.ed25519),
      ),
    );
    if (!verified) {
      _reject(ClinicalContinuityVerificationReasons.signatureInvalid);
    }

    final issuedAt = DateTime.parse(envelope['issuedAt']! as String);
    final expiresAt = DateTime.parse(envelope['expiresAt']! as String);
    final freshness = _freshness(
      issuedAt,
      expiresAt,
      trustedNow,
      minimumTrustedNow,
    );
    if (freshness == ClinicalContinuityFreshness.expired) {
      _reject(ClinicalContinuityVerificationReasons.packExpired);
    }
    if (freshness == ClinicalContinuityFreshness.clockUncertain) {
      _reject(ClinicalContinuityVerificationReasons.clockUncertain);
    }

    return _VerifiedEnvelope(
      content: envelope['content'],
      contentHash: envelope['contentHash']! as String,
      renderHash: envelope['renderHash']! as String,
      keyId: keyId,
      manifestVersion: manifestVersion,
      policyVersion: policyVersion,
      revocationEpoch: revocationEpoch,
      issuedAt: envelope['issuedAt']! as String,
      expiresAt: envelope['expiresAt']! as String,
      freshness: freshness,
    );
  }

  void _verifyAssetNames(Map<String, Uint8List> assets, Set<String> expected) {
    if (assets.length > _maxAssets) {
      _reject(ClinicalContinuityVerificationReasons.assetExtra);
    }
    final folded = <String>{};
    for (final path in assets.keys) {
      if (!_safePath(path) || !folded.add(path.toLowerCase())) {
        _reject(ClinicalContinuityVerificationReasons.unsafePath);
      }
    }
    final actual = assets.keys.toSet();
    if (expected.difference(actual).isNotEmpty) {
      _reject(ClinicalContinuityVerificationReasons.assetMissing);
    }
    if (actual.difference(expected).isNotEmpty) {
      _reject(ClinicalContinuityVerificationReasons.assetExtra);
    }
  }

  _ManifestLocation? _manifestLocation(Object? raw) {
    final value = _map(raw);
    if (value == null ||
        !_exactKeys(value, const {
          'contentHash',
          'expiresAt',
          'generatedAt',
          'keyId',
          'locationId',
          'locationType',
          'packHtmlSha256',
          'packJsonSha256',
          'renderHash',
        }) ||
        !const {
          'ward',
          'paeds',
          'ed_board',
          'opd_day',
        }.contains(value['locationType']) ||
        !_matches(_safeSegmentPattern, value['locationId']) ||
        !_matches(_hashPattern, value['contentHash']) ||
        !_matches(_hashPattern, value['renderHash']) ||
        !_matches(_hashPattern, value['packHtmlSha256']) ||
        !_matches(_hashPattern, value['packJsonSha256']) ||
        value['keyId'] is! String ||
        !_canonicalTimestamp(value['generatedAt']) ||
        !_canonicalTimestamp(value['expiresAt'])) {
      return null;
    }
    return _ManifestLocation(
      locationType: value['locationType']! as String,
      locationId: value['locationId']! as String,
      contentHash: value['contentHash']! as String,
      renderHash: value['renderHash']! as String,
      packHtmlSha256: value['packHtmlSha256']! as String,
      packJsonSha256: value['packJsonSha256']! as String,
      keyId: value['keyId']! as String,
      generatedAt: value['generatedAt']! as String,
      expiresAt: value['expiresAt']! as String,
    );
  }

  static ClinicalContinuityFreshness _freshness(
    DateTime issuedAt,
    DateTime expiresAt,
    DateTime trustedNow,
    DateTime? minimumTrustedNow,
  ) {
    final issued = issuedAt.toUtc();
    final expires = expiresAt.toUtc();
    final now = trustedNow.toUtc();
    if (!expires.isAfter(issued) ||
        now.isBefore(issued) ||
        (minimumTrustedNow != null &&
            now.isBefore(minimumTrustedNow.toUtc()))) {
      return ClinicalContinuityFreshness.clockUncertain;
    }
    final age = now.difference(issued);
    final hardExpiry = issued.add(const Duration(hours: 24));
    if (!now.isBefore(expires) ||
        !now.isBefore(hardExpiry) ||
        age >= const Duration(hours: 24)) {
      return ClinicalContinuityFreshness.expired;
    }
    return age <= const Duration(minutes: 15)
        ? ClinicalContinuityFreshness.current
        : ClinicalContinuityFreshness.aged;
  }

  static bool _safePath(String path) {
    if (path.isEmpty || path.contains(r'\') || path.startsWith('/')) {
      return false;
    }
    final segment = RegExp(_safeSegmentPattern);
    return path
        .split('/')
        .every((part) => part != '.' && part != '..' && segment.hasMatch(part));
  }

  static ClinicalContinuityAudience _audience(
    String tenantId,
    String facilityId,
  ) {
    if (!RegExp(_tenantPattern).hasMatch(tenantId) ||
        _governance(facilityId) == null) {
      _reject(ClinicalContinuityVerificationReasons.audienceMismatch);
    }
    return ClinicalContinuityAudience(
      tenantId: tenantId,
      facilityId: facilityId,
    );
  }

  static Map<String, Object?> _parseMap(Uint8List bytes, String reason) {
    try {
      final parsed = ClinicalContinuityCanonicalJson.parse(bytes);
      final value = _map(parsed);
      if (value == null) _reject(reason);
      return value;
    } on ClinicalContinuityCanonicalizationException catch (error) {
      if (error.code == 'CANONICAL_DUPLICATE_KEY' ||
          error.code == 'CANONICAL_LONE_SURROGATE' ||
          error.code == 'CANONICAL_NON_FINITE_NUMBER' ||
          error.code == 'CANONICAL_BYTE_LIMIT' ||
          error.code == 'CANONICAL_DEPTH_LIMIT' ||
          error.code == 'CANONICAL_NODE_LIMIT') {
        _reject(ClinicalContinuityVerificationReasons.canonicalizationFailed);
      }
      _reject(reason);
    } catch (_) {
      _reject(reason);
    }
  }

  static bool _validTimezone(String value) {
    try {
      timezone.getLocation(value);
      return true;
    } catch (_) {
      return false;
    }
  }

  static bool _containsBloodGroup(Object? value, [int depth = 0]) {
    if (depth > 32) return true;
    if (value is List) {
      return value.any((item) => _containsBloodGroup(item, depth + 1));
    }
    if (value is! Map) return false;
    for (final entry in value.entries) {
      final key = entry.key.toString();
      if (RegExp(
        r'blood.?group|blood.?type|(?:^|[._-])abo(?:$|[._-])|rhesus',
        caseSensitive: false,
      ).hasMatch(key)) {
        return true;
      }
      if (_containsBloodGroup(entry.value, depth + 1)) return true;
    }
    return false;
  }
}

class _VerifiedEnvelope {
  final Object? content;
  final String contentHash;
  final String renderHash;
  final String keyId;
  final String manifestVersion;
  final String policyVersion;
  final String revocationEpoch;
  final String issuedAt;
  final String expiresAt;
  final ClinicalContinuityFreshness freshness;

  const _VerifiedEnvelope({
    required this.content,
    required this.contentHash,
    required this.renderHash,
    required this.keyId,
    required this.manifestVersion,
    required this.policyVersion,
    required this.revocationEpoch,
    required this.issuedAt,
    required this.expiresAt,
    required this.freshness,
  });
}

class _VerifiedEdgeAccess {
  final ClinicalContinuityLocalUnlockPolicy localUnlockPolicy;
  final List<ClinicalContinuityLocalGrant> localGrants;

  const _VerifiedEdgeAccess({
    required this.localUnlockPolicy,
    required this.localGrants,
  });
}

class _ManifestLocation {
  final String locationType;
  final String locationId;
  final String contentHash;
  final String renderHash;
  final String packHtmlSha256;
  final String packJsonSha256;
  final String keyId;
  final String generatedAt;
  final String expiresAt;

  const _ManifestLocation({
    required this.locationType,
    required this.locationId,
    required this.contentHash,
    required this.renderHash,
    required this.packHtmlSha256,
    required this.packJsonSha256,
    required this.keyId,
    required this.generatedAt,
    required this.expiresAt,
  });

  String get key => '$locationType/$locationId';
  String get jsonPath => 'locations/$key/pack.json';
  String get htmlPath => 'locations/$key/pack.html';
}

class _VerificationFailure implements Exception {
  final String reason;

  const _VerificationFailure(this.reason);
}

Never _reject(String reason) => throw _VerificationFailure(reason);

Map<String, Object?>? _map(Object? value) =>
    value is Map ? Map<String, Object?>.from(value) : null;

bool _exactKeys(Map<String, Object?> value, Set<String> expected) =>
    value.length == expected.length && value.keys.toSet().containsAll(expected);

bool _matches(String pattern, Object? value) =>
    value is String && RegExp(pattern).hasMatch(value);

bool _canonicalTimestamp(Object? value) {
  if (value is! String) {
    return false;
  }
  final match = RegExp(
    r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$',
  ).firstMatch(value);
  if (match == null) return false;
  final parsed = DateTime.tryParse(value);
  if (parsed == null || !parsed.isUtc) return false;
  final year = int.parse(match.group(1)!);
  final month = int.parse(match.group(2)!);
  final day = int.parse(match.group(3)!);
  final hour = int.parse(match.group(4)!);
  final minute = int.parse(match.group(5)!);
  final second = int.parse(match.group(6)!);
  final milliseconds = int.parse((match.group(7) ?? '0').padRight(3, '0'));
  final expected = DateTime.utc(
    year,
    month,
    day,
    hour,
    minute,
    second,
    milliseconds,
  );
  return expected.year == year &&
      expected.month == month &&
      expected.day == day &&
      expected.hour == hour &&
      expected.minute == minute &&
      expected.second == second &&
      expected.millisecond == milliseconds &&
      parsed == expected;
}

String? _governance(Object? value, {bool allowZero = false}) {
  if (value is! String ||
      !RegExp(r'^(?:0|[1-9][0-9]{0,18})$').hasMatch(value) ||
      (!allowZero && value == '0')) {
    return null;
  }
  if (BigInt.parse(value) > BigInt.from(9223372036854775807)) return null;
  return value;
}

bool _revisionAtOrBelow(Object? value, String ceiling) {
  final revision = _governance(value);
  return revision != null && BigInt.parse(revision) <= BigInt.parse(ceiling);
}

String _maxGovernance(List<String?> values, {bool allowZero = false}) {
  var maximum = allowZero ? '0' : '1';
  for (final value in values.whereType<String>()) {
    final normalized = _governance(value, allowZero: allowZero);
    if (normalized == null) {
      _reject(ClinicalContinuityVerificationReasons.rollbackStateRequired);
    }
    if (BigInt.parse(normalized) > BigInt.parse(maximum)) {
      maximum = normalized;
    }
  }
  return maximum;
}

DateTime? _latestTime(List<DateTime?> values) {
  DateTime? latest;
  for (final value in values.whereType<DateTime>()) {
    final utc = value.toUtc();
    if (latest == null || utc.isAfter(latest)) latest = utc;
  }
  return latest;
}

List<int>? _signature(Object? raw) {
  if (raw is! String ||
      raw.length != 88 ||
      !RegExp(
        r'^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
      ).hasMatch(raw)) {
    return null;
  }
  try {
    final bytes = base64Decode(raw);
    return bytes.length == 64 && base64Encode(bytes) == raw ? bytes : null;
  } catch (_) {
    return null;
  }
}

Future<String> _sha256Hex(List<int> bytes) async {
  final digest = await Sha256().hash(bytes);
  return digest.bytes
      .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();
}
