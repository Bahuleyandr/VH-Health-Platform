import {
  clientFingerprintProjection,
  parseClinicalContinuityReplayEnvelope,
  __testing__
} from '../../validators/clinicalContinuityReplayEnvelope.js';
import { CLINICAL_CONTINUITY_ACTION_SCHEMAS } from '../../validators/clinicalContinuityActionSchemas.js';
import {
  canonicalizeJson,
  hashCanonicalValue
} from '../../services/downtime/continuityPackCanonical.js';

const UUIDS = Object.freeze({
  actor: '10000000-0000-4000-8000-000000000001',
  capture: '10000000-0000-4000-8000-000000000002',
  device: '10000000-0000-4000-8000-000000000003',
  event: '10000000-0000-4000-8000-000000000004',
  context: '10000000-0000-4000-8000-000000000005',
  grant: '10000000-0000-4000-8000-000000000006',
  patient: '10000000-0000-4000-8000-000000000007',
  policy: '10000000-0000-4000-8000-000000000008',
  tenant: '10000000-0000-4000-8000-000000000009'
});
const HASHES = Object.freeze({
  action: '1'.repeat(64),
  policy: '2'.repeat(64),
  registry: '3'.repeat(64),
  ordering: '4'.repeat(64)
});
const body = Object.freeze({
  content: Object.freeze({ free_text: 'draft' }),
  note_type: 'nursing_assessment',
  patient_uid: UUIDS.patient
});
const schemaRecord = CLINICAL_CONTINUITY_ACTION_SCHEMAS['emr.nursing_note.draft.store/v1'];
const binding = Object.freeze({
  actionId: 'emr.nursing_note.draft.store',
  bindingId: 'emr.note_draft.store/v1',
  method: 'PUT',
  schemaRecord
});

function fixture() {
  const capturedAt = new Date(Date.now() - 60_000).toISOString();
  const queuedAt = new Date(Date.now() - 30_000).toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const envelope = {
    action_checksum: HASHES.action,
    action_id: binding.actionId,
    action_schema_checksum: schemaRecord.checksum,
    action_schema_id: schemaRecord.id,
    action_schema_version: schemaRecord.version,
    action_version: 1,
    admission_id: null,
    app_version: '1.0.0',
    appointment_id: null,
    base_etag: null,
    base_revision: '0',
    cached_sources: { patient_identity: capturedAt },
    capture_actor_uuid: UUIDS.actor,
    capture_role: 'NURSE',
    capture_session_id: UUIDS.capture,
    captured_at: capturedAt,
    client_event_id: UUIDS.event,
    clock_evidence: {
      midpoint: capturedAt,
      observed_at: capturedAt,
      route_kind: 'internal',
      server_time: capturedAt,
      skew_milliseconds: 0,
      tolerance_milliseconds: 1_000,
      uncertainty_milliseconds: 10
    },
    command_fingerprint: '0'.repeat(64),
    device_id: UUIDS.device,
    device_posture: 'tablet',
    encounter_id: null,
    envelope_schema_version: 1,
    expires_at: expiresAt,
    facility_id: 7,
    human_review_required: false,
    idempotency_key: UUIDS.event,
    incident_id: null,
    minimum_app_version: '1.0.0',
    occurred_at: capturedAt,
    ordering_key: `draft:${UUIDS.patient}`,
    ordering_key_digest: HASHES.ordering,
    patient_reference: UUIDS.patient,
    payload_hash: hashCanonicalValue(body),
    policy_checksum: HASHES.policy,
    policy_effective_from: new Date(Date.now() - 60 * 60_000).toISOString(),
    policy_effective_until: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    policy_id: UUIDS.policy,
    policy_revocation_epoch: '0',
    policy_signing_key_id: 'continuity-policy-1',
    policy_supersedes_id: null,
    policy_version: '1',
    predecessor_client_event_id: null,
    queue_schema_version: 6,
    queued_at: queuedAt,
    registry_checksum: HASHES.registry,
    registry_version: '1',
    sequence: 1,
    source_cache_version: null,
    supersession_generation: 0,
    tenant_id: UUIDS.tenant,
    unit_id: null
  };
  envelope.command_fingerprint = hashCanonicalValue(clientFingerprintProjection(envelope));
  const cachedSourcesHeader = Object.entries(envelope.cached_sources)
    .map(([sourceId, timestamp]) => `${sourceId}=${timestamp}`)
    .join(',');
  const authorization = Object.freeze({
    authorityClaims: Object.freeze({
      actionChecksum: envelope.action_checksum,
      actionSchemaChecksum: envelope.action_schema_checksum,
      actionSchemaVersion: envelope.action_schema_version,
      actionVersion: envelope.action_version,
      policyChecksum: envelope.policy_checksum,
      policyEffectiveFrom: envelope.policy_effective_from,
      policyEffectiveUntil: envelope.policy_effective_until,
      policyId: envelope.policy_id,
      policySigningKeyId: envelope.policy_signing_key_id,
      policySupersedesId: envelope.policy_supersedes_id,
      policyVersion: envelope.policy_version,
      registryChecksum: envelope.registry_checksum,
      registryVersion: envelope.registry_version,
      revocationEpoch: envelope.policy_revocation_epoch
    }),
    cachedSourcesHeader,
    captureSessionId: envelope.capture_session_id,
    capturedAt: envelope.captured_at,
    clientAppVersion: envelope.app_version,
    facilityContext: Object.freeze({
      contextId: UUIDS.context,
      contextRevision: '1',
      deviceId: UUIDS.device,
      facilityId: 7,
      grantId: UUIDS.grant
    }),
    requestContext: Object.freeze({
      actorRole: envelope.capture_role,
      devicePosture: envelope.device_posture
    })
  });
  return { authorization, envelope };
}

function encode(envelope) {
  return Buffer.from(canonicalizeJson(envelope), 'utf8').toString('base64url');
}

function parse(overrides = {}) {
  const { authorization, envelope } = fixture();
  return parseClinicalContinuityReplayEnvelope({
    encodedEnvelope: encode(envelope),
    sourceKind: 'electronic_queue',
    body,
    idempotencyKey: envelope.idempotency_key,
    binding,
    authorization,
    tenantId: UUIDS.tenant,
    replayActorUid: UUIDS.actor,
    ...overrides
  });
}

function parseMutation(mutate, mutateAuthorization = () => {}) {
  const { authorization, envelope } = fixture();
  mutate(envelope);
  envelope.command_fingerprint = hashCanonicalValue(clientFingerprintProjection(envelope));
  const mutableAuthorization = {
    ...authorization,
    authorityClaims: { ...authorization.authorityClaims },
    requestContext: { ...authorization.requestContext }
  };
  mutateAuthorization(mutableAuthorization, envelope);
  return () =>
    parseClinicalContinuityReplayEnvelope({
      encodedEnvelope: encode(envelope),
      sourceKind: 'electronic_queue',
      body,
      idempotencyKey: envelope.idempotency_key,
      binding,
      authorization: mutableAuthorization,
      tenantId: UUIDS.tenant,
      replayActorUid: UUIDS.actor
    });
}

function expectConflict(operation, code) {
  let failure;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code });
}

test('accepts the exact canonical C4.1 envelope and derives a server receipt fingerprint', () => {
  const parsed = parse();
  expect(parsed.envelope.client_event_id).toBe(UUIDS.event);
  expect(parsed.payloadHash).toBe(hashCanonicalValue(body));
  expect(parsed.receiptFingerprint).toMatch(/^[0-9a-f]{64}$/);
});

test('rejects non-canonical envelope transport and non-electronic C5.1 sources', () => {
  expect(() => parse({ encodedEnvelope: Buffer.from('{}').toString('base64url') })).toThrow(
    'manual review'
  );
  expect(() => parse({ sourceKind: 'paper_back_entry' })).toThrow('manual review');
});

test('rejects payload and idempotency identity mismatches', () => {
  expect(() => parse({ body: { ...body, content: { free_text: 'changed' } } })).toThrow(
    'manual review'
  );
  expect(() => parse({ idempotencyKey: 'changed-key' })).toThrow('manual review');
});

test('rejects a supplied command fingerprint that does not match its canonical projection', () => {
  const { authorization, envelope } = fixture();
  envelope.command_fingerprint = 'f'.repeat(64);
  expect(() =>
    parseClinicalContinuityReplayEnvelope({
      encodedEnvelope: encode(envelope),
      sourceKind: 'electronic_queue',
      body,
      idempotencyKey: envelope.idempotency_key,
      binding,
      authorization,
      tenantId: UUIDS.tenant,
      replayActorUid: UUIDS.actor
    })
  ).toThrow('manual review');
});

test('binds capture role and device posture to the authenticated authorization seam', () => {
  expectConflict(
    parseMutation(envelope => {
      envelope.capture_role = 'DOCTOR';
    }),
    'CONTINUITY_REPLAY_ENVELOPE_IDENTITY_MISMATCH'
  );
  expectConflict(
    parseMutation(envelope => {
      envelope.device_posture = 'desktop';
    }),
    'CONTINUITY_REPLAY_ENVELOPE_IDENTITY_MISMATCH'
  );
});

test.each([
  [
    'unknown route kind',
    envelope => {
      envelope.clock_evidence.route_kind = 'caller';
    }
  ],
  [
    'clock evidence observed after capture',
    envelope => {
      envelope.clock_evidence.observed_at = new Date(
        Date.parse(envelope.captured_at) + 1_000
      ).toISOString();
    }
  ],
  [
    'clock skew inconsistent with midpoint',
    envelope => {
      envelope.clock_evidence.server_time = new Date(
        Date.parse(envelope.clock_evidence.midpoint) + 500
      ).toISOString();
    }
  ],
  [
    'clock uncertainty beyond tolerance',
    envelope => {
      envelope.clock_evidence.server_time = new Date(
        Date.parse(envelope.clock_evidence.midpoint) + 995
      ).toISOString();
      envelope.clock_evidence.skew_milliseconds = 995;
    }
  ],
  [
    'expiry beyond captured policy authority',
    envelope => {
      envelope.expires_at = new Date(
        Date.parse(envelope.policy_effective_until) + 1_000
      ).toISOString();
    }
  ]
])('rejects C4.1 semantic clock evidence: %s', (_label, mutate) => {
  expectConflict(parseMutation(mutate), 'CONTINUITY_REPLAY_TIME_OR_REVIEW_CONFLICT');
});

test('rejects cached-source evidence recorded after capture', () => {
  expectConflict(
    parseMutation(
      envelope => {
        envelope.cached_sources.patient_identity = new Date(
          Date.parse(envelope.captured_at) + 1_000
        ).toISOString();
      },
      (authorization, envelope) => {
        authorization.cachedSourcesHeader = `patient_identity=${envelope.cached_sources.patient_identity}`;
      }
    ),
    'CONTINUITY_REPLAY_TIME_OR_REVIEW_CONFLICT'
  );
});

test.each(
  __testing__.envelopeKeys.filter(
    key => !['client_event_id', 'command_fingerprint', 'idempotency_key', 'queued_at'].includes(key)
  )
)('a one-field %s mutation cannot retain the verified client fingerprint', key => {
  const { authorization, envelope } = fixture();
  if (typeof envelope[key] === 'string') envelope[key] = `${envelope[key]}x`;
  else if (typeof envelope[key] === 'number') envelope[key] += 1;
  else if (typeof envelope[key] === 'boolean') envelope[key] = !envelope[key];
  else if (envelope[key] === null) envelope[key] = 'x';
  else envelope[key] = { ...envelope[key], injected: 'x' };
  expect(() =>
    parseClinicalContinuityReplayEnvelope({
      encodedEnvelope: encode(envelope),
      sourceKind: 'electronic_queue',
      body,
      idempotencyKey: UUIDS.event,
      binding,
      authorization,
      tenantId: UUIDS.tenant,
      replayActorUid: UUIDS.actor
    })
  ).toThrow('manual review');
});
