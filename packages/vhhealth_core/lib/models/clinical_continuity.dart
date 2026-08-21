import 'dart:convert';
import 'dart:typed_data';

import 'package:intl/intl.dart';
import 'package:timezone/data/latest.dart' as timezone_data;
import 'package:timezone/timezone.dart' as timezone;

enum ClinicalContinuityFreshness { current, aged, expired, clockUncertain }

enum ClinicalContinuityKeyState { current, next, revoked, compromised }

enum ClinicalContinuityLocalFactor { pin, biometric, devicePinOrBiometric }

enum ClinicalContinuityAccessMode { onlineAuthenticated, localUnlock }

class ClinicalContinuityAudience {
  final String tenantId;
  final String facilityId;

  const ClinicalContinuityAudience({
    required this.tenantId,
    required this.facilityId,
  });

  Map<String, Object?> toJson() => {
    'tenantId': tenantId,
    'facilityId': facilityId,
  };
}

class ClinicalContinuityClockAssessment {
  final bool trusted;
  final DateTime? trustedNow;
  final DateTime? minimumTrustedNow;

  const ClinicalContinuityClockAssessment({
    required this.trusted,
    required this.trustedNow,
    this.minimumTrustedNow,
  });
}

class ClinicalContinuitySessionContext {
  final String tenantId;
  final String facilityId;
  final String staffId;
  final String role;
  final String deviceId;
  final DateTime authenticatedAt;

  const ClinicalContinuitySessionContext({
    required this.tenantId,
    required this.facilityId,
    required this.staffId,
    required this.role,
    required this.deviceId,
    required this.authenticatedAt,
  });

  Map<String, Object?> toJson() => {
    'tenantId': tenantId,
    'facilityId': facilityId,
    'staffId': staffId,
    'role': role,
    'deviceId': deviceId,
    'authenticatedAt': authenticatedAt.toUtc().toIso8601String(),
  };

  factory ClinicalContinuitySessionContext.fromJson(Map<String, Object?> json) {
    return ClinicalContinuitySessionContext(
      tenantId: json['tenantId']! as String,
      facilityId: json['facilityId']! as String,
      staffId: json['staffId']! as String,
      role: json['role']! as String,
      deviceId: json['deviceId']! as String,
      authenticatedAt: DateTime.parse(json['authenticatedAt']! as String),
    );
  }
}

class ClinicalContinuitySourceProvenance {
  final String sourceRevision;
  final String sourceWatermark;
  final String? accessRevision;

  const ClinicalContinuitySourceProvenance({
    required this.sourceRevision,
    required this.sourceWatermark,
    this.accessRevision,
  });

  Map<String, Object?> toJson() => {
    'sourceRevision': sourceRevision,
    'sourceWatermark': sourceWatermark,
    if (accessRevision != null) 'accessRevision': accessRevision,
  };

  factory ClinicalContinuitySourceProvenance.fromJson(
    Map<String, Object?> json,
  ) => ClinicalContinuitySourceProvenance(
    sourceRevision: json['sourceRevision']! as String,
    sourceWatermark: json['sourceWatermark']! as String,
    accessRevision: json['accessRevision'] as String?,
  );
}

class ClinicalContinuityLocalUnlockPolicy {
  final String authenticationMode;
  final int maximumAuthorizationMinutes;
  final String emergencyReadPosture;

  const ClinicalContinuityLocalUnlockPolicy({
    required this.authenticationMode,
    required this.maximumAuthorizationMinutes,
    required this.emergencyReadPosture,
  });

  bool get isComplete =>
      authenticationMode == 'mtls_client_certificate' &&
      maximumAuthorizationMinutes > 0 &&
      emergencyReadPosture == 'disabled';

  Map<String, Object?> toJson() => {
    'authenticationMode': authenticationMode,
    'maximumAuthorizationMinutes': maximumAuthorizationMinutes,
    'emergencyReadPosture': emergencyReadPosture,
  };

  factory ClinicalContinuityLocalUnlockPolicy.fromJson(
    Map<String, Object?> json,
  ) => ClinicalContinuityLocalUnlockPolicy(
    authenticationMode: json['authenticationMode']! as String,
    maximumAuthorizationMinutes: json['maximumAuthorizationMinutes']! as int,
    emergencyReadPosture: json['emergencyReadPosture']! as String,
  );
}

class ClinicalContinuityLocalGrant {
  final String staffId;
  final String deviceId;
  final String locationType;
  final String locationId;
  final DateTime validFrom;
  final DateTime validUntil;

  const ClinicalContinuityLocalGrant({
    required this.staffId,
    required this.deviceId,
    required this.locationType,
    required this.locationId,
    required this.validFrom,
    required this.validUntil,
  });

  Map<String, Object?> toJson() => {
    'staffId': staffId,
    'deviceId': deviceId,
    'locationType': locationType,
    'locationId': locationId,
    'validFrom': validFrom.toUtc().toIso8601String(),
    'validUntil': validUntil.toUtc().toIso8601String(),
  };

  factory ClinicalContinuityLocalGrant.fromJson(Map<String, Object?> json) {
    return ClinicalContinuityLocalGrant(
      staffId: json['staffId']! as String,
      deviceId: json['deviceId']! as String,
      locationType: json['locationType']! as String,
      locationId: json['locationId']! as String,
      validFrom: DateTime.parse(json['validFrom']! as String),
      validUntil: DateTime.parse(json['validUntil']! as String),
    );
  }
}

class ClinicalContinuityPack {
  final String locationType;
  final String locationId;
  final String locationLabel;
  final Map<String, Object?> content;
  final Uint8List htmlBytes;
  final DateTime generatedAt;
  final DateTime expiresAt;
  final ClinicalContinuityFreshness freshness;
  final Uint8List? policyEnvelopeBytes;
  final String? policyEnvelopeSha256;

  const ClinicalContinuityPack({
    required this.locationType,
    required this.locationId,
    required this.locationLabel,
    required this.content,
    required this.htmlBytes,
    required this.generatedAt,
    required this.expiresAt,
    required this.freshness,
    this.policyEnvelopeBytes,
    this.policyEnvelopeSha256,
  });

  Map<String, Object?> toJson() => {
    'locationType': locationType,
    'locationId': locationId,
    'locationLabel': locationLabel,
    'content': content,
    'html': base64Encode(htmlBytes),
    'generatedAt': generatedAt.toUtc().toIso8601String(),
    'expiresAt': expiresAt.toUtc().toIso8601String(),
    'freshness': freshness.name,
    if (policyEnvelopeBytes != null)
      'policyEnvelope': base64Encode(policyEnvelopeBytes!),
    if (policyEnvelopeSha256 != null)
      'policyEnvelopeSha256': policyEnvelopeSha256,
  };

  factory ClinicalContinuityPack.fromJson(Map<String, Object?> json) {
    return ClinicalContinuityPack(
      locationType: json['locationType']! as String,
      locationId: json['locationId']! as String,
      locationLabel: json['locationLabel']! as String,
      content: Map<String, Object?>.from(json['content']! as Map),
      htmlBytes: Uint8List.fromList(base64Decode(json['html']! as String)),
      generatedAt: DateTime.parse(json['generatedAt']! as String),
      expiresAt: DateTime.parse(json['expiresAt']! as String),
      freshness: ClinicalContinuityFreshness.values.byName(
        json['freshness']! as String,
      ),
      policyEnvelopeBytes: json['policyEnvelope'] == null
          ? null
          : Uint8List.fromList(base64Decode(json['policyEnvelope']! as String)),
      policyEnvelopeSha256: json['policyEnvelopeSha256'] as String?,
    );
  }
}

class ClinicalContinuityFloors {
  final String packCompositionVersion;
  final String policyVersion;
  final String manifestVersion;
  final String revocationEpoch;
  final DateTime trustedNow;

  const ClinicalContinuityFloors({
    this.packCompositionVersion = '1',
    required this.policyVersion,
    required this.manifestVersion,
    required this.revocationEpoch,
    required this.trustedNow,
  });

  Map<String, Object?> toJson() => {
    'packCompositionVersion': packCompositionVersion,
    'policyVersion': policyVersion,
    'manifestVersion': manifestVersion,
    'revocationEpoch': revocationEpoch,
    'trustedNow': trustedNow.toUtc().toIso8601String(),
  };

  factory ClinicalContinuityFloors.fromJson(Map<String, Object?> json) =>
      ClinicalContinuityFloors(
        packCompositionVersion:
            (json['packCompositionVersion'] as String?) ?? '1',
        policyVersion: json['policyVersion']! as String,
        manifestVersion: json['manifestVersion']! as String,
        revocationEpoch: json['revocationEpoch']! as String,
        trustedNow: DateTime.parse(json['trustedNow']! as String),
      );
}

class VerifiedClinicalContinuitySet {
  final ClinicalContinuityAudience audience;
  final String facilityName;
  final String facilityTimezone;
  final String policyId;
  final String packCompositionVersion;
  final Uint8List? policyEnvelopeBytes;
  final String? policyEnvelopeSha256;
  final String publicationSetId;
  final ClinicalContinuityLocalUnlockPolicy localUnlockPolicy;
  final List<ClinicalContinuityLocalGrant> localGrants;
  final ClinicalContinuitySessionContext prefetchSession;
  final ClinicalContinuitySourceProvenance provenance;
  final Map<String, String> signingKeyFingerprints;
  final ClinicalContinuityFloors floors;
  final DateTime generatedAt;
  final DateTime expiresAt;
  final DateTime evaluatedAt;
  final List<ClinicalContinuityPack> packs;
  final int verifiedByteLength;

  const VerifiedClinicalContinuitySet({
    required this.audience,
    required this.facilityName,
    required this.facilityTimezone,
    required this.policyId,
    required this.publicationSetId,
    required this.localUnlockPolicy,
    required this.localGrants,
    required this.prefetchSession,
    required this.provenance,
    required this.signingKeyFingerprints,
    required this.floors,
    required this.generatedAt,
    required this.expiresAt,
    required this.evaluatedAt,
    required this.packs,
    required this.verifiedByteLength,
    this.packCompositionVersion = '1',
    this.policyEnvelopeBytes,
    this.policyEnvelopeSha256,
  });

  Set<String> get signingKeyIds =>
      Set.unmodifiable(signingKeyFingerprints.keys);

  Map<String, Object?> toJson() => {
    'audience': audience.toJson(),
    'facilityName': facilityName,
    'facilityTimezone': facilityTimezone,
    'policyId': policyId,
    'packCompositionVersion': packCompositionVersion,
    if (policyEnvelopeBytes != null)
      'policyEnvelope': base64Encode(policyEnvelopeBytes!),
    if (policyEnvelopeSha256 != null)
      'policyEnvelopeSha256': policyEnvelopeSha256,
    'publicationSetId': publicationSetId,
    'localUnlockPolicy': localUnlockPolicy.toJson(),
    'localGrants': localGrants.map((grant) => grant.toJson()).toList(),
    'prefetchSession': prefetchSession.toJson(),
    'provenance': provenance.toJson(),
    'signingKeyFingerprints': Map.fromEntries(
      signingKeyFingerprints.entries.toList()
        ..sort((left, right) => left.key.compareTo(right.key)),
    ),
    'floors': floors.toJson(),
    'generatedAt': generatedAt.toUtc().toIso8601String(),
    'expiresAt': expiresAt.toUtc().toIso8601String(),
    'evaluatedAt': evaluatedAt.toUtc().toIso8601String(),
    'packs': packs.map((pack) => pack.toJson()).toList(),
    'verifiedByteLength': verifiedByteLength,
  };

  factory VerifiedClinicalContinuitySet.fromJson(Map<String, Object?> json) {
    final audienceJson = Map<String, Object?>.from(json['audience']! as Map);
    return VerifiedClinicalContinuitySet(
      audience: ClinicalContinuityAudience(
        tenantId: audienceJson['tenantId']! as String,
        facilityId: audienceJson['facilityId']! as String,
      ),
      facilityName: json['facilityName']! as String,
      facilityTimezone: json['facilityTimezone']! as String,
      policyId: json['policyId']! as String,
      packCompositionVersion:
          (json['packCompositionVersion'] as String?) ?? '1',
      policyEnvelopeBytes: json['policyEnvelope'] == null
          ? null
          : Uint8List.fromList(base64Decode(json['policyEnvelope']! as String)),
      policyEnvelopeSha256: json['policyEnvelopeSha256'] as String?,
      publicationSetId: json['publicationSetId']! as String,
      localUnlockPolicy: ClinicalContinuityLocalUnlockPolicy.fromJson(
        Map<String, Object?>.from(json['localUnlockPolicy']! as Map),
      ),
      localGrants: (json['localGrants']! as List)
          .map(
            (grant) => ClinicalContinuityLocalGrant.fromJson(
              Map<String, Object?>.from(grant! as Map),
            ),
          )
          .toList(growable: false),
      prefetchSession: ClinicalContinuitySessionContext.fromJson(
        Map<String, Object?>.from(json['prefetchSession']! as Map),
      ),
      provenance: ClinicalContinuitySourceProvenance.fromJson(
        Map<String, Object?>.from(json['provenance']! as Map),
      ),
      signingKeyFingerprints: Map.unmodifiable(
        Map<String, Object?>.from(json['signingKeyFingerprints']! as Map)
            .map((key, value) => MapEntry(key, value! as String)),
      ),
      floors: ClinicalContinuityFloors.fromJson(
        Map<String, Object?>.from(json['floors']! as Map),
      ),
      generatedAt: DateTime.parse(json['generatedAt']! as String),
      expiresAt: DateTime.parse(json['expiresAt']! as String),
      evaluatedAt: DateTime.parse(json['evaluatedAt']! as String),
      packs: (json['packs']! as List)
          .map(
            (pack) => ClinicalContinuityPack.fromJson(
              Map<String, Object?>.from(pack as Map),
            ),
          )
          .toList(growable: false),
      verifiedByteLength: json['verifiedByteLength']! as int,
    );
  }
}

class ClinicalContinuityAccessDecision {
  final bool allowed;
  final String? denialReason;
  final ClinicalContinuityAccessMode? mode;
  final VerifiedClinicalContinuitySet? verifiedSet;

  const ClinicalContinuityAccessDecision._({
    required this.allowed,
    this.denialReason,
    this.mode,
    this.verifiedSet,
  });

  const ClinicalContinuityAccessDecision.denied(String reason)
    : this._(allowed: false, denialReason: reason);

  const ClinicalContinuityAccessDecision.allowed({
    required ClinicalContinuityAccessMode mode,
    required VerifiedClinicalContinuitySet verifiedSet,
  }) : this._(allowed: true, mode: mode, verifiedSet: verifiedSet);
}

String formatClinicalContinuityFacilityTime(
  DateTime instant,
  String facilityTimezone,
) {
  timezone_data.initializeTimeZones();
  final location = timezone.getLocation(facilityTimezone);
  final local = timezone.TZDateTime.from(instant.toUtc(), location);
  return '${DateFormat('dd MMM yyyy, HH:mm').format(local)} '
      '(${local.timeZoneName})';
}
