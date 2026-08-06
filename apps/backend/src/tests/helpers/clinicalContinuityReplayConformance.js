import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';

import express from 'express';
import request from 'supertest';

import {
  CLINICAL_CONTINUITY_ACTION_CATALOG,
  CLINICAL_CONTINUITY_ACTIONS_BY_ID
} from '../../config/clinicalContinuityActionCatalog.js';
import { getRolePolicy } from '../../config/rolePolicyGraph.js';
import { setTenantTx } from '../../lib/prisma.js';
import { resolveClinicalContinuityActionBinding } from '../../services/downtime/clinicalContinuityActionBindingRegistry.js';
import { evaluateClinicalContinuityActionRequest } from '../../services/downtime/clinicalContinuityActionRegistryService.js';
import {
  applyClinicalContinuityReplay,
  precheckClinicalContinuityReplay
} from '../../services/downtime/clinicalContinuityReplayReceiptService.js';
import {
  buildClinicalContinuityPolicySigningPayload,
  loadActiveClinicalContinuityPolicyForFacilityTx
} from '../../services/downtime/clinicalContinuityPolicyService.js';
import {
  canonicalizeJson,
  hashCanonicalValue,
  sha256Hex,
  signCanonicalValue
} from '../../services/downtime/continuityPackCanonical.js';
import {
  clientFingerprintProjection,
  parseClinicalContinuityReplayEnvelope
} from '../../validators/clinicalContinuityReplayEnvelope.js';

import clinicalNotesRouter from '../../routes/emr/clinicalNotesRoutes.js';

const databaseConfigured = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
const describeIfDb = databaseConfigured ? describe : describe.skip;

function roleCapabilities(role) {
  return (
    getRolePolicy().roles.find(entry => entry.role_code === role)?.access
      ?.route_capability_groups || []
  );
}

function publicPem(keys) {
  return keys.publicKey.export({ type: 'spki', format: 'pem' });
}

function randomPhone(prefix) {
  return `+91${prefix}${Math.floor(10000000 + Math.random() * 89999999)}`;
}

function actionRegistry({ effectiveFrom, effectiveUntil }) {
  const value = {
    actions: CLINICAL_CONTINUITY_ACTION_CATALOG,
    activation: {
      enforcedActionIds: ['emr.nursing_note.draft.store', 'emr.op_note.draft.store'],
      mode: 'enforce'
    },
    approvalEvidence: {
      countersignedAt: '2026-07-30',
      decisionId: 'C-D3',
      source: 'docs/continuity/c0-4-owner-decision-dossier.md#c-d3--offline-action-matrix'
    },
    audience: { devicePostures: ['desktop', 'tablet'] },
    compatibilityRules: [],
    expiresAt: effectiveUntil,
    issuedAt: effectiveFrom,
    minimumAppVersions: { desktop: '1.0.0', tablet: '1.0.0' },
    registrySchemaVersion: 1,
    registryVersion: '1'
  };
  return {
    ...value,
    registryChecksum: hashCanonicalValue(value)
  };
}

function policyDocument({ tenantId, facilityId, registry }) {
  return {
    actionRegistry: registry,
    audience: { tenantId, facilityId: String(facilityId) },
    edgeAccess: {
      authenticationMode: 'mtls_client_certificate',
      credentialLifetimeMinutes: 720,
      emergencyReadPosture: 'read_only',
      maximumOfflineAuthorizationMinutes: 720
    },
    fieldPolicy: {
      allergyUnknownText: 'Allergy status UNKNOWN — not recorded',
      bloodGroupIncluded: false,
      codeStatusUnknownText: 'Code status NOT RECORDED — confirm per hospital policy',
      contextFields: [
        'bedLocation',
        'attendingDoctor',
        'diagnosisOrChiefComplaint',
        'latestVitals',
        'news2',
        'recentReleasedResults',
        'careTeam'
      ],
      isolationSource: 'structured_only',
      opdDestroyAfterClinicDay: true,
      paediatricWeightRequired: true,
      recentlyAdministeredLookbackHours: 12,
      safetyFieldRecordedAtRequired: true,
      safetyFields: [
        'identity.name',
        'identity.mrnOrUid',
        'identity.dateOfBirth',
        'allergies',
        'codeStatus',
        'medicationsDue',
        'activeMedicationOrders',
        'recentlyAdministeredMedications',
        'unresolvedCriticalResults'
      ]
    },
    generation: {
      currentForMinutes: 15,
      hardExpiryHours: 24,
      historicalMode: false,
      intervalMinutes: 15
    },
    includedAreas: { ed: true, opd: true, paediatrics: true, wards: true },
    medicationsDueWindow: { lookaheadHours: 12, lookbackHours: 1 },
    packSchemaVersion: 1,
    policySchemaVersion: 3,
    policyType: 'clinical_continuity_pack',
    recentReleasedResults: {
      itemCodeAllowlist: ['HGB', 'CREATININE'],
      lookbackHours: 72,
      maxPerPatient: 10,
      portalReleaseDelayHours: 24
    },
    requiredCoverage: {
      wards: [{ wardId: 10, locationIdentifier: 'ward-10', label: 'Ward 10' }],
      paediatricWards: [{ wardId: 11, locationIdentifier: 'paeds-11', label: 'PICU' }],
      edBoards: [{ locationIdentifier: 'ed-board', label: 'Emergency' }],
      opdClinicDays: [
        {
          locationIdentifier: 'opd-test-day',
          queueIds: [31],
          label: 'OPD test day'
        }
      ]
    },
    retention: {
      accessLogRetentionHours: 8_760,
      edgePackRetentionHours: 168,
      sourcePackRetentionHours: 61_320
    }
  };
}

async function seedFixture(actorRole) {
  const now = Date.now();
  const fixture = {
    actorRole,
    tenantId: randomUUID(),
    facilityId: 1800000000 + Math.floor(Math.random() * 1000000),
    actorUid: randomUUID(),
    patientUid: randomUUID(),
    secondPatientUid: randomUUID(),
    stalePatientUid: randomUUID(),
    routePatientUid: randomUUID(),
    deviceId: randomUUID(),
    grantId: randomUUID(),
    contextId: randomUUID(),
    contextRevision: String(1000000 + Math.floor(Math.random() * 1000000)),
    captureRevision: String(2000000 + Math.floor(Math.random() * 1000000)),
    captureSessionId: randomUUID(),
    sessionJtiSha256: createHash('sha256').update(randomUUID()).digest('hex'),
    policyId: randomUUID(),
    policyVersion: '1',
    revocationEpoch: '1',
    effectiveFrom: new Date(now - 2 * 60 * 60_000).toISOString(),
    effectiveUntil: new Date(now + 24 * 60 * 60_000).toISOString(),
    policyKeys: generateKeyPairSync('ed25519'),
    packKeys: generateKeyPairSync('ed25519')
  };
  fixture.devicePublicRaw = Buffer.alloc(32, 7);
  fixture.deviceCredentialSha256 = createHash('sha256')
    .update(fixture.devicePublicRaw)
    .digest('hex');
  fixture.registry = actionRegistry(fixture);
  fixture.policyDocument = policyDocument({ ...fixture, registry: fixture.registry });
  fixture.policyChecksum = hashCanonicalValue(fixture.policyDocument);
  fixture.policyKeyId = `policy-${randomUUID()}`;
  fixture.packKeyId = `pack-${randomUUID()}`;
  fixture.policyPublicKeySha256 = sha256Hex(publicPem(fixture.policyKeys));
  fixture.packPublicKeySha256 = sha256Hex(publicPem(fixture.packKeys));

  await setTenantTx(fixture.tenantId, async tx => {
    await tx.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'C5 replay conformance')`,
      fixture.tenantId,
      `c5-conformance-${randomUUID()}`
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO facilities (id, tenant_id, facility_code, display_name, timezone)
       VALUES ($1::integer, $2::uuid, $3, 'C5 conformance facility', 'Asia/Kolkata')`,
      fixture.facilityId,
      fixture.tenantId,
      `C5-${randomUUID()}`
    );
    for (const [uid, role, phone] of [
      [fixture.actorUid, actorRole, randomPhone('71')],
      [fixture.patientUid, 'PATIENT', randomPhone('72')],
      [fixture.secondPatientUid, 'PATIENT', randomPhone('73')],
      [fixture.stalePatientUid, 'PATIENT', randomPhone('74')],
      [fixture.routePatientUid, 'PATIENT', randomPhone('75')]
    ]) {
      await tx.$executeRawUnsafe(
        `INSERT INTO users (
           uid, tenant_id, phone, name, role, is_active, status,
           is_deleted, registered_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3, 'C5 conformance user', $4,
           TRUE, 'active', FALSE, NOW(), NOW()
         )`,
        uid,
        fixture.tenantId,
        phone,
        role
      );
    }
    const patientRows = await tx.$queryRawUnsafe(
      `SELECT id, uid::text FROM users
        WHERE tenant_id = $1::uuid
          AND uid IN ($2::uuid, $3::uuid, $4::uuid, $5::uuid)`,
      fixture.tenantId,
      fixture.patientUid,
      fixture.secondPatientUid,
      fixture.stalePatientUid,
      fixture.routePatientUid
    );
    fixture.patientIds = Object.fromEntries(patientRows.map(row => [row.uid, Number(row.id)]));
    fixture.appointmentIds = {};
    for (const [index, patientUid] of [
      fixture.patientUid,
      fixture.secondPatientUid,
      fixture.stalePatientUid,
      fixture.routePatientUid
    ].entries()) {
      const appointment = await tx.$queryRawUnsafe(
        `INSERT INTO appointments (
           tenant_id, phone, patient_id, doctor_name,
           appointment_date, appointment_time, updated_at
         ) VALUES (
           $1::uuid, $2, $3::integer, 'C5 conformance doctor',
           CURRENT_DATE, $4, NOW()
         ) RETURNING id`,
        fixture.tenantId,
        randomPhone(`7${index + 5}`),
        fixture.patientIds[patientUid],
        `09:0${index}`
      );
      fixture.appointmentIds[patientUid] = Number(appointment[0].id);
    }
    const careTeam = await tx.$queryRawUnsafe(
      `INSERT INTO care_teams (
         tenant_id, patient_uid, appointment_id, team_kind,
         display_name, status, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::integer, 'op',
         'C5 route conformance', 'active', $4::uuid, $4::uuid
       ) RETURNING id`,
      fixture.tenantId,
      fixture.routePatientUid,
      fixture.appointmentIds[fixture.routePatientUid],
      fixture.actorUid
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO care_team_members (
         tenant_id, care_team_id, patient_uid, staff_uid, staff_role,
         relationship_kind, access_scope, status, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::integer, $3::uuid, $4::uuid, $5,
         'care_team', '{}'::jsonb, 'active', $4::uuid, $4::uuid
       )`,
      fixture.tenantId,
      Number(careTeam[0].id),
      fixture.routePatientUid,
      fixture.actorUid,
      fixture.actorRole
    );

    for (const [keyId, purpose, keys] of [
      [fixture.policyKeyId, 'clinical_continuity_policy_signing', fixture.policyKeys],
      [fixture.packKeyId, 'clinical_continuity_pack_signing', fixture.packKeys]
    ]) {
      await tx.$executeRawUnsafe(
        `INSERT INTO encryption_keys (
           tenant_id, key_id, provider, algorithm, status, metadata
         ) VALUES (
           $1::uuid, $2::text, 'env', 'ed25519', 'active',
           jsonb_build_object(
             'purpose', $3::text,
             'public_key_spki_pem', $4::text
           )
         )`,
        fixture.tenantId,
        keyId,
        purpose,
        publicPem(keys)
      );
    }

    const signingRow = {
      action_registry_checksum: fixture.registry.registryChecksum,
      action_registry_schema_version: 1,
      action_registry_version: 1,
      current_pack_signing_key_id: fixture.packKeyId,
      current_pack_signing_public_key_sha256: fixture.packPublicKeySha256,
      effective_from: fixture.effectiveFrom,
      effective_until: fixture.effectiveUntil,
      facility_id: fixture.facilityId,
      next_pack_signing_key_id: null,
      next_pack_signing_public_key_sha256: null,
      policy_checksum: fixture.policyChecksum,
      policy_document: fixture.policyDocument,
      policy_schema_version: 3,
      policy_signing_key_id: fixture.policyKeyId,
      policy_signing_public_key_sha256: fixture.policyPublicKeySha256,
      policy_version: 1,
      revocation_epoch: 1,
      revoked_key_ids: [],
      supersedes_policy_id: null,
      tenant_id: fixture.tenantId
    };
    const payload = buildClinicalContinuityPolicySigningPayload(signingRow);
    const signature = Buffer.from(
      signCanonicalValue(payload, fixture.policyKeys.privateKey),
      'base64'
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO clinical_continuity_policy_versions (
         id, tenant_id, facility_id, policy_version, policy_schema_version,
         action_registry_schema_version, action_registry_version,
         action_registry_checksum, lifecycle_state, policy_document,
         policy_checksum, canonicalization, signature_algorithm,
         policy_signing_key_id, policy_signing_public_key_sha256,
         current_pack_signing_key_id, current_pack_signing_public_key_sha256,
         next_pack_signing_key_id, next_pack_signing_public_key_sha256,
         policy_signature, revocation_epoch, revoked_key_ids,
         effective_from, effective_until, supersedes_policy_id
       ) VALUES (
         $1::uuid, $2::uuid, $3::integer, 1, 3,
         1, 1, $4::char(64), 'draft', $5::jsonb,
         $6::char(64), 'rfc8785-jcs', 'ed25519',
         $7, $8::char(64), $9, $10::char(64),
         NULL, NULL, $11::bytea, 1, '[]'::jsonb,
         $12::timestamptz, $13::timestamptz, NULL
       )`,
      fixture.policyId,
      fixture.tenantId,
      fixture.facilityId,
      fixture.registry.registryChecksum,
      JSON.stringify(fixture.policyDocument),
      fixture.policyChecksum,
      fixture.policyKeyId,
      fixture.policyPublicKeySha256,
      fixture.packKeyId,
      fixture.packPublicKeySha256,
      signature,
      fixture.effectiveFrom,
      fixture.effectiveUntil
    );
    const decidedAt = new Date().toISOString();
    const approval = await tx.$queryRawUnsafe(
      `INSERT INTO approvals (
         tenant_id, approval_kind, subject_resource_type, subject_resource_id,
         required_approvers, status, approved_by, decided_at,
         created_by, decided_by, metadata
       ) VALUES (
         $1::uuid, 'clinical_continuity_policy_governance',
         'clinical_continuity_policy_version', $2,
         1, 'approved', $3::jsonb, $4::timestamptz,
         $5::uuid, $5::uuid, $6::jsonb
       ) RETURNING id`,
      fixture.tenantId,
      fixture.policyId,
      JSON.stringify([{ uid: fixture.actorUid, at: decidedAt }]),
      decidedAt,
      fixture.actorUid,
      JSON.stringify({
        clinical_continuity_policy_governance: {
          action_registry_checksum: fixture.registry.registryChecksum,
          action_registry_decision_id: 'C-D3',
          action_registry_schema_version: 1,
          action_registry_version: '1',
          countersignature_complete: true,
          policy_checksum: fixture.policyChecksum
        }
      })
    );
    await tx.$executeRawUnsafe(
      `UPDATE clinical_continuity_policy_versions
          SET lifecycle_state = 'approved', approval_id = $1::integer,
              approved_by = $2::uuid, approved_at = $3::timestamptz
        WHERE tenant_id = $4::uuid AND id = $5::uuid`,
      Number(approval[0].id),
      fixture.actorUid,
      decidedAt,
      fixture.tenantId,
      fixture.policyId
    );
    await tx.$executeRawUnsafe(
      "SELECT set_config('app.clinical_continuity_activation_bypass', 'migration_or_test', true)"
    );
    await tx.$executeRawUnsafe(
      `UPDATE clinical_continuity_policy_versions SET lifecycle_state = 'active'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      fixture.tenantId,
      fixture.policyId
    );
    await tx.$executeRawUnsafe(
      "SELECT set_config('app.clinical_continuity_activation_bypass', '', true)"
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO clinical_continuity_edge_access_grants (
         id, tenant_id, facility_id, staff_uid, device_id,
         valid_from, valid_until, policy_version_id, policy_version,
         access_revision, created_by, grant_purpose, subject_kind,
         device_public_key_raw, device_credential_sha256, capture_revision
       ) VALUES (
         $1::uuid, $2::uuid, $3::integer, $4::uuid, $5,
         NOW() - INTERVAL '1 hour', NOW() + INTERVAL '12 hours',
         $6::uuid, 1, NULL, $4::uuid, 'capture_staff_facility', 'staff_device',
         $7::bytea, $8::char(64), $9::bigint
       )`,
      fixture.grantId,
      fixture.tenantId,
      fixture.facilityId,
      fixture.actorUid,
      fixture.deviceId,
      fixture.policyId,
      fixture.devicePublicRaw,
      fixture.deviceCredentialSha256,
      fixture.captureRevision
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO user_devices (
         tenant_id, user_uid, device_id, device_type,
         facility_id, continuity_grant_id, continuity_grant_purpose,
         continuity_capture_revision, continuity_context_id,
         continuity_context_revision, continuity_session_jti_sha256,
         continuity_issued_at, continuity_expires_at,
         continuity_validated_at, continuity_validation_state
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'desktop',
         $4::integer, $5::uuid, 'capture_staff_facility',
         $6::bigint, $7::uuid, $8::bigint, $9,
         NOW(), NOW() + INTERVAL '12 hours', NOW(), 'active'
       )`,
      fixture.tenantId,
      fixture.actorUid,
      fixture.deviceId,
      fixture.facilityId,
      fixture.grantId,
      fixture.captureRevision,
      fixture.contextId,
      fixture.contextRevision,
      fixture.sessionJtiSha256
    );
  });
  return fixture;
}

function envelopeFor({ fixture, binding, body, clientEventId = randomUUID(), baseRevision = '0' }) {
  const action = CLINICAL_CONTINUITY_ACTIONS_BY_ID[binding.actionId];
  const capturedAt = new Date(Date.now() - 60_000).toISOString();
  const envelope = {
    action_checksum: action.actionChecksum,
    action_id: binding.actionId,
    action_schema_checksum: binding.schemaRecord.checksum,
    action_schema_id: binding.schemaRecord.id,
    action_schema_version: binding.schemaRecord.version,
    action_version: action.actionVersion,
    admission_id: null,
    app_version: '1.0.0',
    appointment_id: body.appointment_id == null ? null : String(body.appointment_id),
    base_etag: null,
    base_revision: baseRevision,
    cached_sources: { patient_identity: capturedAt },
    capture_actor_uuid: fixture.actorUid,
    capture_role: fixture.actorRole,
    capture_session_id: fixture.captureSessionId,
    captured_at: capturedAt,
    client_event_id: clientEventId,
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
    device_id: fixture.deviceId,
    device_posture: 'desktop',
    encounter_id: null,
    envelope_schema_version: 1,
    expires_at: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
    facility_id: fixture.facilityId,
    human_review_required: false,
    idempotency_key: `c5-${clientEventId}`,
    incident_id: null,
    minimum_app_version: '1.0.0',
    occurred_at: capturedAt,
    ordering_key: `draft:${body.patient_uid}:${body.appointment_id ?? 'none'}`,
    ordering_key_digest: hashCanonicalValue({
      appointment_id: body.appointment_id ?? null,
      patient_uid: body.patient_uid
    }),
    patient_reference: body.patient_uid,
    payload_hash: hashCanonicalValue(body),
    policy_checksum: fixture.policyChecksum,
    policy_effective_from: fixture.effectiveFrom,
    policy_effective_until: fixture.effectiveUntil,
    policy_id: fixture.policyId,
    policy_revocation_epoch: fixture.revocationEpoch,
    policy_signing_key_id: fixture.policyKeyId,
    policy_supersedes_id: null,
    policy_version: fixture.policyVersion,
    predecessor_client_event_id: null,
    queue_schema_version: 1,
    queued_at: new Date(Date.now() - 30_000).toISOString(),
    registry_checksum: fixture.registry.registryChecksum,
    registry_version: fixture.registry.registryVersion,
    sequence: 1,
    source_cache_version: null,
    supersession_generation: 0,
    tenant_id: fixture.tenantId,
    unit_id: null
  };
  envelope.command_fingerprint = hashCanonicalValue(clientFingerprintProjection(envelope));
  return envelope;
}

function replayInput({ fixture, binding, body, clientEventId, baseRevision }) {
  const envelope = envelopeFor({ fixture, binding, body, clientEventId, baseRevision });
  const claims = {
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
  };
  const requestContext = Object.freeze({
    actionId: envelope.action_id,
    actorCapabilities: roleCapabilities(fixture.actorRole),
    actorRole: fixture.actorRole,
    actorUid: fixture.actorUid,
    authorityClaims: claims,
    binding,
    body,
    cachedSourcesSatisfied: true,
    capturedAt: envelope.captured_at,
    clientAppVersion: envelope.app_version,
    devicePosture: envelope.device_posture,
    identitySatisfied: true,
    requestId: randomUUID(),
    routeTemplate: binding.fullRoutePath
  });
  const authorization = Object.freeze({
    authorityClaims: Object.freeze(claims),
    binding,
    cachedSourcesHeader: `patient_identity=${envelope.captured_at}`,
    captureSessionId: envelope.capture_session_id,
    capturedAt: envelope.captured_at,
    clientAppVersion: envelope.app_version,
    facilityContext: Object.freeze({
      actorUid: fixture.actorUid,
      captureRevision: fixture.captureRevision,
      contextId: fixture.contextId,
      contextRevision: fixture.contextRevision,
      deviceId: fixture.deviceId,
      expiresAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
      facilityId: fixture.facilityId,
      grantId: fixture.grantId,
      grantPurpose: 'capture_staff_facility',
      policyChecksum: fixture.policyChecksum,
      policyId: fixture.policyId,
      policySigningKeyId: fixture.policyKeyId,
      policyVersion: fixture.policyVersion,
      revocationEpoch: fixture.revocationEpoch,
      sessionJtiSha256: fixture.sessionJtiSha256,
      tenantId: fixture.tenantId
    }),
    requestContext
  });
  const parsed = parseClinicalContinuityReplayEnvelope({
    encodedEnvelope: Buffer.from(canonicalizeJson(envelope), 'utf8').toString('base64url'),
    sourceKind: 'electronic_queue',
    body,
    idempotencyKey: envelope.idempotency_key,
    binding,
    authorization,
    tenantId: fixture.tenantId,
    replayActorUid: fixture.actorUid
  });
  return Object.freeze({
    authorization,
    binding,
    body,
    facilityContext: authorization.facilityContext,
    parsed,
    replayActorUid: fixture.actorUid,
    replayRole: fixture.actorRole,
    requestId: requestContext.requestId,
    tenantId: fixture.tenantId
  });
}

async function counts(tenantId, patientUid) {
  return setTenantTx(
    tenantId,
    async tx => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT
         (SELECT COUNT(*)::int FROM note_drafts WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid) AS drafts,
         (SELECT COUNT(*)::int FROM clinical_continuity_replay_receipts WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid) AS receipts,
         (SELECT COUNT(*)::int FROM clinical_continuity_replay_effect_evidence AS effect JOIN clinical_continuity_replay_receipts AS receipt USING (tenant_id, client_event_id) WHERE receipt.tenant_id = $1::uuid AND receipt.patient_uid = $2::uuid) AS effects,
         (SELECT COUNT(*)::int FROM clinical_timeline_events WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid) AS timeline,
         (SELECT COUNT(*)::int FROM clinical_audit_events WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid) AS clinical_audit,
         (SELECT COUNT(*)::int FROM event_outbox WHERE tenant_id = $1::uuid) AS outbox,
         (SELECT COUNT(*)::int FROM workflow_sla_instances WHERE tenant_id = $1::uuid) AS sla,
         (SELECT COUNT(*)::int FROM notification_outbox WHERE tenant_id = $1::uuid) AS notifications,
         (SELECT COUNT(*)::int FROM care_pathway_transition_events WHERE tenant_id = $1::uuid) AS pathway`,
        tenantId,
        patientUid
      );
      return rows[0];
    },
    { readOnly: true }
  );
}

async function attemptCount(tenantId, clientEventId) {
  return setTenantTx(
    tenantId,
    async tx => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count
         FROM clinical_continuity_replay_attempts
        WHERE tenant_id = $1::uuid
          AND client_event_id = $2::uuid`,
        tenantId,
        clientEventId
      );
      return Number(rows[0].count);
    },
    { readOnly: true }
  );
}

function routeHarness(input) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = input.requestId;
    req.tenantId = input.tenantId;
    req.user = {
      deviceType: 'desktop',
      role: input.replayRole,
      uid: input.replayActorUid
    };
    Object.defineProperty(req, 'clinicalContinuityActionAuthorization', {
      configurable: false,
      enumerable: true,
      value: input.authorization,
      writable: false
    });
    next();
  });
  app.use('/api/v1/emr', clinicalNotesRouter);
  app.use((err, _req, res, _next) => {
    res.status(err?.statusCode || 500).json({
      code: err?.code || 'INTERNAL_ERROR',
      message: err?.message || 'Internal error'
    });
  });
  return app;
}

function replayHeaders(input) {
  return {
    'Idempotency-Key': input.parsed.envelope.idempotency_key,
    'X-VH-Continuity-Command-Envelope': Buffer.from(
      canonicalizeJson(input.parsed.envelope),
      'utf8'
    ).toString('base64url'),
    'X-VH-Continuity-Receipt-Source': input.parsed.sourceKind
  };
}

export function runClinicalContinuityReplayConformance({
  actionId,
  actorRole,
  bodyFactory,
  expectedEffectContract
}) {
  describeIfDb(`${actionId} replay conformance`, () => {
    let fixture;
    let binding;

    beforeAll(async () => {
      fixture = await seedFixture(actorRole);
      binding = resolveClinicalContinuityActionBinding({
        actionId,
        method: 'PUT',
        path: '/api/v1/emr/notes/draft'
      });
    }, 60_000);

    test('binds the exact registered transaction handler and private-draft effect contract', () => {
      expect(binding).toMatchObject({
        actionId,
        bindingId: 'emr.note_draft.store/v1',
        effectContract: expectedEffectContract,
        method: 'PUT'
      });
      expect(binding.transactionalHandler.name).toBe('upsertNoteDraftTx');
    });

    test('rechecks the active signed policy inside the caller Serializable transaction', async () => {
      const body = bodyFactory({ fixture, patientUid: fixture.patientUid });
      const input = replayInput({ fixture, binding, body, baseRevision: '0' });
      const result = await setTenantTx(
        fixture.tenantId,
        async tx => {
          await loadActiveClinicalContinuityPolicyForFacilityTx({
            tx,
            tenantId: fixture.tenantId,
            facilityId: fixture.facilityId
          });
          return evaluateClinicalContinuityActionRequest({
            tenantId: fixture.tenantId,
            facilityId: fixture.facilityId,
            capturedPolicyId: fixture.policyId,
            capturedPolicyVersion: fixture.policyVersion,
            requestContext: input.authorization.requestContext,
            scopeRunner: async (_tenantId, callback) => callback(tx)
          });
        },
        { isolationLevel: 'Serializable' }
      );
      expect(result).toMatchObject({
        decision: 'allow',
        proceed: true,
        reasonCode: 'CONTINUITY_ACTION_ALLOWED'
      });
    });

    test('applies and rejoins through the real Express route, middleware, controller, and transaction handler', async () => {
      const body = bodyFactory({ fixture, patientUid: fixture.routePatientUid });
      const input = replayInput({ fixture, binding, body, baseRevision: '0' });
      const app = routeHarness(input);
      const first = await request(app)
        .put('/api/v1/emr/notes/draft')
        .set(replayHeaders(input))
        .send(body);
      expect({ status: first.status, body: first.body }).toMatchObject({
        status: 200,
        body: {
          data: {
            disposition: 'applied',
            replayed: false
          }
        }
      });

      const duplicate = await request(app)
        .put('/api/v1/emr/notes/draft')
        .set(replayHeaders(input))
        .send(body);
      expect({ status: duplicate.status, body: duplicate.body }).toMatchObject({
        status: 200,
        body: {
          data: {
            disposition: 'applied',
            replayed: true
          }
        }
      });
      expect(await counts(fixture.tenantId, fixture.routePatientUid)).toMatchObject({
        drafts: 1,
        effects: 1,
        receipts: 1
      });
    });

    test('applies once, returns an exact duplicate, and creates no canonical/SLA/outbox effect', async () => {
      const body = bodyFactory({ fixture, patientUid: fixture.patientUid });
      const input = replayInput({ fixture, binding, body, baseRevision: '0' });
      const first = await applyClinicalContinuityReplay(input);
      expect(first).toMatchObject({ disposition: 'applied', replayed: false });
      expect(await attemptCount(fixture.tenantId, input.parsed.envelope.client_event_id)).toBe(1);
      const afterFirst = await counts(fixture.tenantId, fixture.patientUid);
      expect(afterFirst).toMatchObject({
        drafts: 1,
        receipts: 1,
        effects: 1,
        timeline: 0,
        clinical_audit: 0,
        outbox: 0,
        sla: 0,
        notifications: 0,
        pathway: 0
      });

      const duplicate = await precheckClinicalContinuityReplay(input);
      expect(duplicate).toMatchObject({
        client_event_id: input.parsed.envelope.client_event_id,
        disposition: 'applied',
        replayed: true
      });
      expect(await attemptCount(fixture.tenantId, input.parsed.envelope.client_event_id)).toBe(2);
      expect(await counts(fixture.tenantId, fixture.patientUid)).toMatchObject(afterFirst);

      const changed = {
        ...input,
        parsed: {
          ...input.parsed,
          receiptFingerprint: 'f'.repeat(64)
        }
      };
      await expect(precheckClinicalContinuityReplay(changed)).rejects.toMatchObject({
        code: 'CONTINUITY_REPLAY_FINGERPRINT_MISMATCH'
      });
      expect(await attemptCount(fixture.tenantId, input.parsed.envelope.client_event_id)).toBe(3);
      expect(await counts(fixture.tenantId, fixture.patientUid)).toMatchObject(afterFirst);
    });

    test('concurrent identical replay joins one receipt and one draft effect', async () => {
      const body = bodyFactory({ fixture, patientUid: fixture.secondPatientUid });
      const input = replayInput({ fixture, binding, body, baseRevision: '0' });
      const outcomes = await Promise.all([
        applyClinicalContinuityReplay(input),
        applyClinicalContinuityReplay(input)
      ]);
      expect(outcomes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ disposition: 'applied', replayed: false }),
          expect.objectContaining({ disposition: 'applied', replayed: true })
        ])
      );
      expect(await counts(fixture.tenantId, fixture.secondPatientUid)).toMatchObject({
        drafts: 1,
        receipts: 1,
        effects: 1
      });
    });

    test('two event identities on one stale base revision cannot overwrite the draft', async () => {
      const body = bodyFactory({ fixture, patientUid: fixture.stalePatientUid });
      const first = replayInput({ fixture, binding, body, baseRevision: '0' });
      const stale = replayInput({ fixture, binding, body, baseRevision: '0' });
      await expect(applyClinicalContinuityReplay(first)).resolves.toMatchObject({
        disposition: 'applied'
      });
      await expect(applyClinicalContinuityReplay(stale)).rejects.toMatchObject({
        code: 'CONTINUITY_REPLAY_CONCURRENCY_NEEDS_REVIEW'
      });
      expect(await counts(fixture.tenantId, fixture.stalePatientUid)).toMatchObject({
        drafts: 1,
        receipts: 2,
        effects: 1
      });
    });
  });
}
