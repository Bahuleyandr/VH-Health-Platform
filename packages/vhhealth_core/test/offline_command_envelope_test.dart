import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/offline_command_envelope.dart';
import 'package:vhhealth_core/services/offline_action_ids.dart';
import 'package:vhhealth_core/services/offline_command_codec.dart';

void main() {
  test('closed envelope round-trips every field and rejects schema drift', () {
    final envelope = _envelope();
    final encoded = OfflineCommandCodec.encodeEnvelope(envelope);
    final decoded = OfflineCommandCodec.decodeEnvelope(encoded);

    expect(decoded.toJson(), envelope.toJson());
    expect(decoded.toJson().keys, hasLength(52));

    final extra = Map<String, dynamic>.from(envelope.toJson())
      ..['unexpected'] = true;
    final missing = Map<String, dynamic>.from(envelope.toJson())
      ..remove('facility_id');
    expect(() => OfflineCommandEnvelope.fromJson(extra), throwsFormatException);
    expect(
      () => OfflineCommandEnvelope.fromJson(missing),
      throwsFormatException,
    );
  });

  test('canonical JSON and semantic fingerprint are deterministic', () async {
    expect(
      OfflineCommandCodec.canonicalize({
        'z': 1,
        'a': {
          'é': true,
          'b': [3, -0.0, 'line\nbreak'],
        },
      }),
      '{"a":{"b":[3,0,"line\\nbreak"],"é":true},"z":1}',
    );
    expect(
      await OfflineCommandCodec.hashCanonical({'b': 2, 'a': 1}),
      await OfflineCommandCodec.hashCanonical({'a': 1, 'b': 2}),
    );

    final first = _envelope(
      clientEventId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      queuedAt: DateTime.utc(2026, 7, 31, 10),
    );
    final second = _envelope(
      clientEventId: '33333333-3333-4333-8333-333333333333',
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
      queuedAt: DateTime.utc(2026, 7, 31, 11),
    );
    expect(
      await OfflineCommandCodec.commandFingerprint(first),
      await OfflineCommandCodec.commandFingerprint(second),
    );
  });

  test('replay projection exactly matches the C4.2 authority contract', () {
    final headers = OfflineCommandCodec.replayHeaders(_envelope());

    expect(headers.keys, {
      'X-VH-Continuity-Action-Id',
      'X-VH-Continuity-Facility-Id',
      'X-VH-Continuity-Captured-At',
      'X-VH-Continuity-Capture-Session-Id',
      'X-VH-Continuity-Cached-Sources',
      'X-VH-Continuity-Client-App-Version',
      'X-VH-Continuity-Action-Version',
      'X-VH-Continuity-Action-Checksum',
      'X-VH-Continuity-Action-Schema-Version',
      'X-VH-Continuity-Action-Schema-Checksum',
      'X-VH-Continuity-Policy-Id',
      'X-VH-Continuity-Policy-Version',
      'X-VH-Continuity-Policy-Checksum',
      'X-VH-Continuity-Policy-Signing-Key-Id',
      'X-VH-Continuity-Policy-Effective-From',
      'X-VH-Continuity-Policy-Effective-Until',
      'X-VH-Continuity-Policy-Supersedes-Id',
      'X-VH-Continuity-Revocation-Epoch',
      'X-VH-Continuity-Registry-Version',
      'X-VH-Continuity-Registry-Checksum',
    });
    expect(
      headers['X-VH-Continuity-Cached-Sources'],
      'medications=2026-07-31T09:59:00.000Z,'
      'patient_identity=2026-07-31T09:58:00.000Z',
    );
    expect(headers['X-VH-Continuity-Policy-Supersedes-Id'], 'none');
    expect(headers, isNot(contains('Idempotency-Key')));
  });
}

OfflineCommandEnvelope _envelope({
  String clientEventId = '11111111-1111-4111-8111-111111111111',
  String idempotencyKey = '22222222-2222-4222-8222-222222222222',
  DateTime? queuedAt,
}) {
  final captured = DateTime.utc(2026, 7, 31, 10);
  return OfflineCommandEnvelope(
    clientEventId: clientEventId,
    idempotencyKey: idempotencyKey,
    actionId: OfflineActionIds.opNoteDraftStore,
    commandFingerprint: 'fingerprint',
    payloadHash: 'payload-hash',
    appVersion: '6.0.0+600',
    envelopeSchemaVersion: OfflineCommandEnvelope.schemaVersion,
    queueSchemaVersion: 6,
    actionVersion: 7,
    actionChecksum: 'action-checksum',
    actionSchemaId: 'schema.op-note-draft',
    actionSchemaVersion: 3,
    actionSchemaChecksum: 'schema-checksum',
    policyId: 'policy-1',
    policyVersion: '12',
    policyChecksum: 'policy-checksum',
    policySigningKeyId: 'key-1',
    policyEffectiveFrom: captured.subtract(const Duration(hours: 1)),
    policyEffectiveUntil: captured.add(const Duration(hours: 8)),
    policyRevocationEpoch: '4',
    registryVersion: '9',
    registryChecksum: 'registry-checksum',
    minimumAppVersion: '6.0.0',
    tenantId: 'vh-main',
    facilityId: 17,
    unitId: 'opd-2',
    deviceId: 'device-opaque',
    devicePosture: 'desktop',
    captureSessionId: '55555555-5555-4555-8555-555555555555',
    captureActorUuid: '66666666-6666-4666-8666-666666666666',
    captureRole: 'doctor',
    patientReference: 'patient-uid',
    appointmentId: 'appt-7',
    occurredAt: captured.subtract(const Duration(minutes: 2)),
    capturedAt: captured,
    queuedAt: queuedAt ?? captured.add(const Duration(seconds: 1)),
    clockEvidence: OfflineClockEvidence(
      observedAt: captured.subtract(const Duration(seconds: 2)),
      serverTime: captured.subtract(const Duration(seconds: 1)),
      midpoint: captured.subtract(const Duration(seconds: 1)),
      skewMilliseconds: 150,
      uncertaintyMilliseconds: 40,
      toleranceMilliseconds: 30000,
      routeKind: 'public',
    ),
    cachedSources: {
      'patient_identity': captured.subtract(const Duration(minutes: 2)),
      'medications': captured.subtract(const Duration(minutes: 1)),
    },
    sourceCacheVersion: 'pack-3',
    baseRevision: 'rev-8',
    baseEtag: '"etag-8"',
    expiresAt: captured.add(const Duration(hours: 4)),
    orderingKey: 'patient-uid\u0000appt-7\u0000op-note',
    orderingKeyDigest: 'ordering-digest',
    sequence: 1,
    supersessionGeneration: 2,
    humanReviewRequired: false,
  );
}
