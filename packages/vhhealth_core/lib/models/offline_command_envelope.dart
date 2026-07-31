import 'package:flutter/foundation.dart';

enum OfflineCommandState {
  pending('pending'),
  inFlight('in_flight'),
  retryWait('retry_wait'),
  applied('applied'),
  needsReview('needs_review'),
  superseded('superseded'),
  cancelled('cancelled');

  const OfflineCommandState(this.value);

  final String value;

  static OfflineCommandState? fromValue(String? value) {
    for (final state in values) {
      if (state.value == value) return state;
    }
    return null;
  }
}

enum OfflineReconciliationReason {
  recordedElsewhereVerified('recorded_elsewhere_verified'),
  transferredToPaper('transferred_to_paper'),
  manualEntryVerified('manual_entry_verified'),
  duplicateConfirmed('duplicate_confirmed'),
  wrongPatientOrContext('wrong_patient_or_context'),
  policyOrSchemaConflict('policy_or_schema_conflict'),
  draftCancelled('draft_cancelled'),
  legacyReconciliationConfirmed('legacy_reconciliation_confirmed');

  const OfflineReconciliationReason(this.code);

  final String code;

  static OfflineReconciliationReason? fromCode(String? code) {
    for (final reason in values) {
      if (reason.code == code) return reason;
    }
    return null;
  }
}

@immutable
class OfflineClockEvidence {
  const OfflineClockEvidence({
    required this.observedAt,
    required this.serverTime,
    required this.midpoint,
    required this.skewMilliseconds,
    required this.uncertaintyMilliseconds,
    required this.toleranceMilliseconds,
    required this.routeKind,
  });

  final DateTime observedAt;
  final DateTime serverTime;
  final DateTime midpoint;
  final int skewMilliseconds;
  final int uncertaintyMilliseconds;
  final int toleranceMilliseconds;
  final String routeKind;

  Map<String, Object?> toJson() => {
    'midpoint': _timestamp(midpoint),
    'observed_at': _timestamp(observedAt),
    'route_kind': routeKind,
    'server_time': _timestamp(serverTime),
    'skew_milliseconds': skewMilliseconds,
    'tolerance_milliseconds': toleranceMilliseconds,
    'uncertainty_milliseconds': uncertaintyMilliseconds,
  };

  factory OfflineClockEvidence.fromJson(Map<String, dynamic> json) {
    _requireExactKeys(json, const {
      'midpoint',
      'observed_at',
      'route_kind',
      'server_time',
      'skew_milliseconds',
      'tolerance_milliseconds',
      'uncertainty_milliseconds',
    });
    return OfflineClockEvidence(
      observedAt: _requiredTimestamp(json, 'observed_at'),
      serverTime: _requiredTimestamp(json, 'server_time'),
      midpoint: _requiredTimestamp(json, 'midpoint'),
      skewMilliseconds: _requiredInt(json, 'skew_milliseconds'),
      uncertaintyMilliseconds: _requiredNonNegativeInt(
        json,
        'uncertainty_milliseconds',
      ),
      toleranceMilliseconds: _requiredNonNegativeInt(
        json,
        'tolerance_milliseconds',
      ),
      routeKind: _requiredString(json, 'route_kind'),
    );
  }
}

@immutable
class OfflineCommandDraft {
  const OfflineCommandDraft({
    required this.actionId,
    required this.payload,
    required this.appVersion,
    required this.actionVersion,
    required this.actionChecksum,
    required this.actionSchemaId,
    required this.actionSchemaVersion,
    required this.actionSchemaChecksum,
    required this.policyId,
    required this.policyVersion,
    required this.policyChecksum,
    required this.policySigningKeyId,
    required this.policyEffectiveFrom,
    required this.policyEffectiveUntil,
    required this.policyRevocationEpoch,
    required this.registryVersion,
    required this.registryChecksum,
    required this.minimumAppVersion,
    required this.tenantId,
    required this.facilityId,
    required this.deviceId,
    required this.devicePosture,
    required this.captureSessionId,
    required this.captureActorUuid,
    required this.captureRole,
    required this.patientReference,
    required this.occurredAt,
    required this.capturedAt,
    required this.clockEvidence,
    required this.cachedSources,
    required this.expiresAt,
    required this.orderingKey,
    this.policySupersedesId,
    this.unitId,
    this.incidentId,
    this.encounterId,
    this.appointmentId,
    this.admissionId,
    this.sourceCacheVersion,
    this.baseRevision,
    this.baseEtag,
    this.predecessorClientEventId,
    this.supersessionGeneration = 0,
    this.humanReviewRequired = false,
    this.contextLabel,
  });

  final String actionId;
  final Map<String, dynamic> payload;
  final String appVersion;
  final int actionVersion;
  final String actionChecksum;
  final String actionSchemaId;
  final int actionSchemaVersion;
  final String actionSchemaChecksum;
  final String policyId;
  final String policyVersion;
  final String policyChecksum;
  final String policySigningKeyId;
  final DateTime policyEffectiveFrom;
  final DateTime policyEffectiveUntil;
  final String? policySupersedesId;
  final String policyRevocationEpoch;
  final String registryVersion;
  final String registryChecksum;
  final String minimumAppVersion;
  final String tenantId;
  final int facilityId;
  final String? unitId;
  final String deviceId;
  final String devicePosture;
  final String captureSessionId;
  final String? incidentId;
  final String captureActorUuid;
  final String captureRole;
  final String patientReference;
  final String? encounterId;
  final String? appointmentId;
  final String? admissionId;
  final DateTime occurredAt;
  final DateTime capturedAt;
  final OfflineClockEvidence clockEvidence;
  final Map<String, DateTime> cachedSources;
  final String? sourceCacheVersion;
  final String? baseRevision;
  final String? baseEtag;
  final DateTime expiresAt;
  final String orderingKey;
  final String? predecessorClientEventId;
  final int supersessionGeneration;
  final bool humanReviewRequired;
  final String? contextLabel;
}

@immutable
class OfflineCommandEnvelope {
  const OfflineCommandEnvelope({
    required this.clientEventId,
    required this.idempotencyKey,
    required this.actionId,
    required this.commandFingerprint,
    required this.payloadHash,
    required this.appVersion,
    required this.envelopeSchemaVersion,
    required this.queueSchemaVersion,
    required this.actionVersion,
    required this.actionChecksum,
    required this.actionSchemaId,
    required this.actionSchemaVersion,
    required this.actionSchemaChecksum,
    required this.policyId,
    required this.policyVersion,
    required this.policyChecksum,
    required this.policySigningKeyId,
    required this.policyEffectiveFrom,
    required this.policyEffectiveUntil,
    required this.policyRevocationEpoch,
    required this.registryVersion,
    required this.registryChecksum,
    required this.minimumAppVersion,
    required this.tenantId,
    required this.facilityId,
    required this.deviceId,
    required this.devicePosture,
    required this.captureSessionId,
    required this.captureActorUuid,
    required this.captureRole,
    required this.patientReference,
    required this.occurredAt,
    required this.capturedAt,
    required this.queuedAt,
    required this.clockEvidence,
    required this.cachedSources,
    required this.expiresAt,
    required this.orderingKey,
    required this.orderingKeyDigest,
    required this.sequence,
    required this.supersessionGeneration,
    required this.humanReviewRequired,
    this.policySupersedesId,
    this.unitId,
    this.incidentId,
    this.encounterId,
    this.appointmentId,
    this.admissionId,
    this.sourceCacheVersion,
    this.baseRevision,
    this.baseEtag,
    this.predecessorClientEventId,
  });

  static const schemaVersion = 1;

  final String clientEventId;
  final String idempotencyKey;
  final String actionId;
  final String commandFingerprint;
  final String payloadHash;
  final String appVersion;
  final int envelopeSchemaVersion;
  final int queueSchemaVersion;
  final int actionVersion;
  final String actionChecksum;
  final String actionSchemaId;
  final int actionSchemaVersion;
  final String actionSchemaChecksum;
  final String policyId;
  final String policyVersion;
  final String policyChecksum;
  final String policySigningKeyId;
  final DateTime policyEffectiveFrom;
  final DateTime policyEffectiveUntil;
  final String? policySupersedesId;
  final String policyRevocationEpoch;
  final String registryVersion;
  final String registryChecksum;
  final String minimumAppVersion;
  final String tenantId;
  final int facilityId;
  final String? unitId;
  final String deviceId;
  final String devicePosture;
  final String captureSessionId;
  final String? incidentId;
  final String captureActorUuid;
  final String captureRole;
  final String patientReference;
  final String? encounterId;
  final String? appointmentId;
  final String? admissionId;
  final DateTime occurredAt;
  final DateTime capturedAt;
  final DateTime queuedAt;
  final OfflineClockEvidence clockEvidence;
  final Map<String, DateTime> cachedSources;
  final String? sourceCacheVersion;
  final String? baseRevision;
  final String? baseEtag;
  final DateTime expiresAt;
  final String orderingKey;
  final String orderingKeyDigest;
  final int sequence;
  final String? predecessorClientEventId;
  final int supersessionGeneration;
  final bool humanReviewRequired;

  OfflineCommandEnvelope withCommandFingerprint(String value) {
    return OfflineCommandEnvelope(
      clientEventId: clientEventId,
      idempotencyKey: idempotencyKey,
      actionId: actionId,
      commandFingerprint: value,
      payloadHash: payloadHash,
      appVersion: appVersion,
      envelopeSchemaVersion: envelopeSchemaVersion,
      queueSchemaVersion: queueSchemaVersion,
      actionVersion: actionVersion,
      actionChecksum: actionChecksum,
      actionSchemaId: actionSchemaId,
      actionSchemaVersion: actionSchemaVersion,
      actionSchemaChecksum: actionSchemaChecksum,
      policyId: policyId,
      policyVersion: policyVersion,
      policyChecksum: policyChecksum,
      policySigningKeyId: policySigningKeyId,
      policyEffectiveFrom: policyEffectiveFrom,
      policyEffectiveUntil: policyEffectiveUntil,
      policySupersedesId: policySupersedesId,
      policyRevocationEpoch: policyRevocationEpoch,
      registryVersion: registryVersion,
      registryChecksum: registryChecksum,
      minimumAppVersion: minimumAppVersion,
      tenantId: tenantId,
      facilityId: facilityId,
      unitId: unitId,
      deviceId: deviceId,
      devicePosture: devicePosture,
      captureSessionId: captureSessionId,
      incidentId: incidentId,
      captureActorUuid: captureActorUuid,
      captureRole: captureRole,
      patientReference: patientReference,
      encounterId: encounterId,
      appointmentId: appointmentId,
      admissionId: admissionId,
      occurredAt: occurredAt,
      capturedAt: capturedAt,
      queuedAt: queuedAt,
      clockEvidence: clockEvidence,
      cachedSources: cachedSources,
      sourceCacheVersion: sourceCacheVersion,
      baseRevision: baseRevision,
      baseEtag: baseEtag,
      expiresAt: expiresAt,
      orderingKey: orderingKey,
      orderingKeyDigest: orderingKeyDigest,
      sequence: sequence,
      predecessorClientEventId: predecessorClientEventId,
      supersessionGeneration: supersessionGeneration,
      humanReviewRequired: humanReviewRequired,
    );
  }

  Map<String, Object?> toJson() => {
    'action_checksum': actionChecksum,
    'action_id': actionId,
    'action_schema_checksum': actionSchemaChecksum,
    'action_schema_id': actionSchemaId,
    'action_schema_version': actionSchemaVersion,
    'action_version': actionVersion,
    'admission_id': admissionId,
    'app_version': appVersion,
    'appointment_id': appointmentId,
    'base_etag': baseEtag,
    'base_revision': baseRevision,
    'cached_sources': {
      for (final entry in cachedSources.entries)
        entry.key: _timestamp(entry.value),
    },
    'capture_actor_uuid': captureActorUuid,
    'capture_role': captureRole,
    'capture_session_id': captureSessionId,
    'captured_at': _timestamp(capturedAt),
    'client_event_id': clientEventId,
    'clock_evidence': clockEvidence.toJson(),
    'command_fingerprint': commandFingerprint,
    'device_id': deviceId,
    'device_posture': devicePosture,
    'encounter_id': encounterId,
    'envelope_schema_version': envelopeSchemaVersion,
    'expires_at': _timestamp(expiresAt),
    'facility_id': facilityId,
    'human_review_required': humanReviewRequired,
    'idempotency_key': idempotencyKey,
    'incident_id': incidentId,
    'minimum_app_version': minimumAppVersion,
    'occurred_at': _timestamp(occurredAt),
    'ordering_key': orderingKey,
    'ordering_key_digest': orderingKeyDigest,
    'patient_reference': patientReference,
    'payload_hash': payloadHash,
    'policy_checksum': policyChecksum,
    'policy_effective_from': _timestamp(policyEffectiveFrom),
    'policy_effective_until': _timestamp(policyEffectiveUntil),
    'policy_id': policyId,
    'policy_revocation_epoch': policyRevocationEpoch,
    'policy_signing_key_id': policySigningKeyId,
    'policy_supersedes_id': policySupersedesId,
    'policy_version': policyVersion,
    'predecessor_client_event_id': predecessorClientEventId,
    'queue_schema_version': queueSchemaVersion,
    'queued_at': _timestamp(queuedAt),
    'registry_checksum': registryChecksum,
    'registry_version': registryVersion,
    'sequence': sequence,
    'source_cache_version': sourceCacheVersion,
    'supersession_generation': supersessionGeneration,
    'tenant_id': tenantId,
    'unit_id': unitId,
  };

  factory OfflineCommandEnvelope.fromJson(Map<String, dynamic> json) {
    _requireExactKeys(json, _keys);
    final rawSources = json['cached_sources'];
    if (rawSources is! Map<String, dynamic>) {
      throw const FormatException('cached_sources must be an object');
    }
    final sources = <String, DateTime>{};
    for (final entry in rawSources.entries) {
      if (entry.key.trim().isEmpty || entry.value is! String) {
        throw const FormatException('Invalid cached source evidence');
      }
      sources[entry.key] = _parseTimestamp(entry.value as String);
    }
    return OfflineCommandEnvelope(
      clientEventId: _requiredString(json, 'client_event_id'),
      idempotencyKey: _requiredString(json, 'idempotency_key'),
      actionId: _requiredString(json, 'action_id'),
      commandFingerprint: _requiredString(json, 'command_fingerprint'),
      payloadHash: _requiredString(json, 'payload_hash'),
      appVersion: _requiredString(json, 'app_version'),
      envelopeSchemaVersion: _requiredInt(json, 'envelope_schema_version'),
      queueSchemaVersion: _requiredInt(json, 'queue_schema_version'),
      actionVersion: _requiredInt(json, 'action_version'),
      actionChecksum: _requiredString(json, 'action_checksum'),
      actionSchemaId: _requiredString(json, 'action_schema_id'),
      actionSchemaVersion: _requiredInt(json, 'action_schema_version'),
      actionSchemaChecksum: _requiredString(json, 'action_schema_checksum'),
      policyId: _requiredString(json, 'policy_id'),
      policyVersion: _requiredString(json, 'policy_version'),
      policyChecksum: _requiredString(json, 'policy_checksum'),
      policySigningKeyId: _requiredString(json, 'policy_signing_key_id'),
      policyEffectiveFrom: _requiredTimestamp(json, 'policy_effective_from'),
      policyEffectiveUntil: _requiredTimestamp(json, 'policy_effective_until'),
      policySupersedesId: _nullableString(json, 'policy_supersedes_id'),
      policyRevocationEpoch: _requiredString(json, 'policy_revocation_epoch'),
      registryVersion: _requiredString(json, 'registry_version'),
      registryChecksum: _requiredString(json, 'registry_checksum'),
      minimumAppVersion: _requiredString(json, 'minimum_app_version'),
      tenantId: _requiredString(json, 'tenant_id'),
      facilityId: _requiredPositiveInt(json, 'facility_id'),
      unitId: _nullableString(json, 'unit_id'),
      deviceId: _requiredString(json, 'device_id'),
      devicePosture: _requiredString(json, 'device_posture'),
      captureSessionId: _requiredString(json, 'capture_session_id'),
      incidentId: _nullableString(json, 'incident_id'),
      captureActorUuid: _requiredString(json, 'capture_actor_uuid'),
      captureRole: _requiredString(json, 'capture_role'),
      patientReference: _requiredString(json, 'patient_reference'),
      encounterId: _nullableString(json, 'encounter_id'),
      appointmentId: _nullableString(json, 'appointment_id'),
      admissionId: _nullableString(json, 'admission_id'),
      occurredAt: _requiredTimestamp(json, 'occurred_at'),
      capturedAt: _requiredTimestamp(json, 'captured_at'),
      queuedAt: _requiredTimestamp(json, 'queued_at'),
      clockEvidence: OfflineClockEvidence.fromJson(
        _requiredMap(json, 'clock_evidence'),
      ),
      cachedSources: sources,
      sourceCacheVersion: _nullableString(json, 'source_cache_version'),
      baseRevision: _nullableString(json, 'base_revision'),
      baseEtag: _nullableString(json, 'base_etag'),
      expiresAt: _requiredTimestamp(json, 'expires_at'),
      orderingKey: _requiredString(json, 'ordering_key'),
      orderingKeyDigest: _requiredString(json, 'ordering_key_digest'),
      sequence: _requiredPositiveInt(json, 'sequence'),
      predecessorClientEventId: _nullableString(
        json,
        'predecessor_client_event_id',
      ),
      supersessionGeneration: _requiredNonNegativeInt(
        json,
        'supersession_generation',
      ),
      humanReviewRequired: _requiredBool(json, 'human_review_required'),
    );
  }

  static const _keys = <String>{
    'action_checksum',
    'action_id',
    'action_schema_checksum',
    'action_schema_id',
    'action_schema_version',
    'action_version',
    'admission_id',
    'app_version',
    'appointment_id',
    'base_etag',
    'base_revision',
    'cached_sources',
    'capture_actor_uuid',
    'capture_role',
    'capture_session_id',
    'captured_at',
    'client_event_id',
    'clock_evidence',
    'command_fingerprint',
    'device_id',
    'device_posture',
    'encounter_id',
    'envelope_schema_version',
    'expires_at',
    'facility_id',
    'human_review_required',
    'idempotency_key',
    'incident_id',
    'minimum_app_version',
    'occurred_at',
    'ordering_key',
    'ordering_key_digest',
    'patient_reference',
    'payload_hash',
    'policy_checksum',
    'policy_effective_from',
    'policy_effective_until',
    'policy_id',
    'policy_revocation_epoch',
    'policy_signing_key_id',
    'policy_supersedes_id',
    'policy_version',
    'predecessor_client_event_id',
    'queue_schema_version',
    'queued_at',
    'registry_checksum',
    'registry_version',
    'sequence',
    'source_cache_version',
    'supersession_generation',
    'tenant_id',
    'unit_id',
  };
}

@immutable
class PersistedOfflineCommand {
  const PersistedOfflineCommand({
    required this.rowId,
    required this.envelope,
    required this.payload,
    required this.state,
    required this.attemptCount,
    this.leaseId,
    this.leaseExpiresAt,
  });

  final int rowId;
  final OfflineCommandEnvelope envelope;
  final Map<String, dynamic> payload;
  final OfflineCommandState state;
  final int attemptCount;
  final String? leaseId;
  final DateTime? leaseExpiresAt;
}

@immutable
class OfflineReconciliationRequest {
  const OfflineReconciliationRequest({
    required this.reason,
    required this.actorUuid,
    required this.confirmedNotRecordedOnServer,
    this.explanation,
  });

  final OfflineReconciliationReason reason;
  final String actorUuid;
  final bool confirmedNotRecordedOnServer;
  final String? explanation;
}

String _timestamp(DateTime value) => value.toUtc().toIso8601String();

DateTime _parseTimestamp(String value) {
  final parsed = DateTime.tryParse(value);
  if (parsed == null || !value.endsWith('Z')) {
    throw FormatException('Invalid UTC timestamp: $value');
  }
  return parsed.toUtc();
}

DateTime _requiredTimestamp(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! String) throw FormatException('$key must be a timestamp');
  return _parseTimestamp(value);
}

String _requiredString(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! String || value.trim().isEmpty || value != value.trim()) {
    throw FormatException('$key must be a non-empty canonical string');
  }
  return value;
}

String? _nullableString(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value == null) return null;
  if (value is! String || value.trim().isEmpty || value != value.trim()) {
    throw FormatException('$key must be null or a canonical string');
  }
  return value;
}

int _requiredInt(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! int) throw FormatException('$key must be an integer');
  return value;
}

int _requiredPositiveInt(Map<String, dynamic> json, String key) {
  final value = _requiredInt(json, key);
  if (value <= 0) throw FormatException('$key must be positive');
  return value;
}

int _requiredNonNegativeInt(Map<String, dynamic> json, String key) {
  final value = _requiredInt(json, key);
  if (value < 0) throw FormatException('$key must be non-negative');
  return value;
}

bool _requiredBool(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! bool) throw FormatException('$key must be a boolean');
  return value;
}

Map<String, dynamic> _requiredMap(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! Map<String, dynamic>) {
    throw FormatException('$key must be an object');
  }
  return value;
}

void _requireExactKeys(Map<String, dynamic> json, Set<String> expected) {
  if (json.length != expected.length ||
      !json.keys.every(expected.contains) ||
      !expected.every(json.containsKey)) {
    throw const FormatException('Envelope keys do not match the closed schema');
  }
}
