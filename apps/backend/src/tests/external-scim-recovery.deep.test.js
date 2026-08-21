import { createHash, randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';

process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || 'i13-scim-test-field-key-32-characters';

const persistRevokeAllUserTokens = jest.fn().mockResolvedValue(1_700_000_000);
const publishRevokeAllUserTokens = jest.fn().mockResolvedValue({ database: { persisted: true } });
jest.unstable_mockModule('../utils/tokenBlacklist.js', () => ({
  isSubjectDelegationRevoked: jest.fn().mockResolvedValue(false),
  blacklistToken: jest.fn(),
  isTokenBlacklisted: jest.fn(),
  isUserTokensRevoked: jest.fn(),
  isDelegatedTupleRevoked: jest.fn().mockResolvedValue(false),
  getCurrentTokenEpoch: jest.fn().mockResolvedValue(0),
  persistRevokeDelegatedTuple: jest.fn(),
  publishRevokeDelegatedTuple: jest.fn(),
  RevocationCheckUnavailableError: class RevocationCheckUnavailableError extends Error {},
  persistRevokeAllUserTokens,
  publishRevokeAllUserTokens,
}));

const { default: prisma, setTenantTx } = await import('../lib/prisma.js');
const {
  enqueueExternalRecoveryItem,
  processNextItemTx,
} = await import('../services/integrations/externalInterfaceRecoveryService.js');
const {
  authorizeExternalRecoveryResume,
  registerExternalRecoveryOffset,
} = await import('./helpers/externalRecoveryOperabilityTestHelper.js');
const {
  patchScimUser,
  resolveScimContext,
} = await import('../services/auth/scimProvisioningService.js');
const { decryptField } = await import('../utils/fieldEncryption.js');

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const ACTOR_UID = randomUUID();
const REVOKE_UID = randomUUID();
const ENABLE_UID = randomUUID();
const BREAK_GLASS_UID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const AUTH_HASH_REVOKE = createHash('sha256').update(`revoke-${SUFFIX}`).digest('hex');
const AUTH_HASH_ENABLE = createHash('sha256').update(`enable-${SUFFIX}`).digest('hex');
const AUTH_HASH_BREAK_GLASS = createHash('sha256').update(`break-glass-${SUFFIX}`).digest('hex');
const POLICY = Object.freeze({
  policyVersion: 'c-d15-v1',
  retentionPolicy: 'identity-security-2555d',
  retentionUntil: '2033-08-03T00:00:00.000Z',
});

let revokeProviderId;
let enableProviderId;
let revokeStaffId;
let enableStaffId;
let breakGlassProviderId;
let breakGlassStaffId;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function recover({ providerId, providerKey, authHash, targetUid, externalId,
  commandKind, method, body, occurredAt }) {
  const bodyBytes = Buffer.from(body, 'utf8');
  const rawPayload = JSON.stringify({
    schema: 'vhhealth.i13.scim-owner-list-diff/v1',
    provider_id: String(providerId),
    provider_key: providerKey,
    direction: 'inbound',
    realm: 'staff',
    command_kind: commandKind,
    method,
    resource_uid: targetUid,
    external_id: externalId,
    auth_binding_sha256: authHash,
    authenticated_at: '2026-08-03T02:00:00.000Z',
    occurred_at: occurredAt,
    scim_body_base64: bodyBytes.toString('base64'),
    scim_body_sha256: sha256(bodyBytes),
  });
  const payloadHash = sha256(Buffer.from(rawPayload, 'utf8'));
  const sourcePartition = `scim-provider:${providerId}:inbound`;
  const predecessorToken = `${providerKey}-owner-list-10`;
  const sourceToken = `${providerKey}-owner-list-11`;
  const duplicateKey = `i13:${providerId}:${method}:${targetUid}:${payloadHash}`;
  const offset = await registerExternalRecoveryOffset({
    tenantId: TENANT_ID,
    interfaceFamily: 'I13',
    sourcePartition,
    initialPosition: 10,
    initialToken: predecessorToken,
    retainedFromPosition: 10,
    retainedFromToken: predecessorToken,
    policySignature: `i13-${providerKey}-${SUFFIX}`,
    ...POLICY,
  });
  await authorizeExternalRecoveryResume({
    tenantId: TENANT_ID,
    offsetId: offset.offset_id,
    interfaceFamily: 'I13',
    resumeCutoffPosition: 11,
    resumeCutoffToken: sourceToken,
  });
  const operation = {
    tenantId: TENANT_ID,
    offsetId: offset.offset_id,
    interfaceFamily: 'I13',
    sourcePartition,
    generation: 1,
    sourcePosition: '11',
    sourceToken,
    predecessorToken,
    duplicateKey,
    occurredAt,
    command: {
      raw_payload: rawPayload,
      payload_sha256: payloadHash,
      actor_uid: ACTOR_UID,
      owner_reason: 'Owner-directed reconciliation of a provider SCIM list/diff',
      evidence: { owner_reviewed: true, source_export: 'synthetic_i13_fixture' },
    },
  };
  await enqueueExternalRecoveryItem(operation);
  return {
    outcome: await processNextItemTx(operation),
    rawPayload,
    payloadHash,
    body,
  };
}

describeIfDb('C6.1-F I13 late SCIM recovery', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'I13 SCIM recovery tenant')`,
      TENANT_ID,
      `i13-scim-${SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, email, name, role, is_active, status, updated_at,
          identity_source, scim_external_id)
       VALUES
         ($1::uuid, $4::uuid, $5::text, $8::text, 'I13 owner', 'ADMIN', true, 'active', NOW(), 'local', NULL),
         ($2::uuid, $4::uuid, $6::text, $9::text, 'I13 revoke staff', 'NURSING_STAFF', true, 'active', NOW(), 'scim', $11::text),
         ($3::uuid, $4::uuid, $7::text, $10::text, 'I13 enable staff', 'NURSING_STAFF', false, 'inactive', NOW(), 'scim', $12::text)`,
      ACTOR_UID,
      REVOKE_UID,
      ENABLE_UID,
      TENANT_ID,
      `91${SUFFIX.slice(0, 10)}`,
      `92${SUFFIX.slice(0, 10)}`,
      `93${SUFFIX.slice(0, 10)}`,
      `owner-${SUFFIX}@example.test`,
      `revoke-${SUFFIX}@example.test`,
      `enable-${SUFFIX}@example.test`,
      `scim-revoke-${SUFFIX}`,
      `scim-enable-${SUFFIX}`,
    );
    const staff = await prisma.$queryRawUnsafe(
      `INSERT INTO staff
         (tenant_id, user_id, employee_id, name, designation, is_active,
          archived, updated_at, identity_source, scim_external_id)
       VALUES
         ($1::uuid, $2::uuid, $4::text, 'I13 revoke staff', 'Nurse', true,
          false, NOW(), 'scim', $6::text),
         ($1::uuid, $3::uuid, $5::text, 'I13 enable staff', 'Nurse', false,
          true, NOW(), 'scim', $7::text)
       RETURNING id, user_id::text`,
      TENANT_ID,
      REVOKE_UID,
      ENABLE_UID,
      `R-${SUFFIX}`,
      `E-${SUFFIX}`,
      `scim-revoke-${SUFFIX}`,
      `scim-enable-${SUFFIX}`,
    );
    revokeStaffId = Number(staff.find(row => row.user_id === REVOKE_UID).id);
    enableStaffId = Number(staff.find(row => row.user_id === ENABLE_UID).id);
    const providers = await prisma.$queryRawUnsafe(
      `INSERT INTO tenant_identity_providers
         (tenant_id, realm, protocol, provider_key, display_name, status,
          oidc_issuer, oidc_jwks_uri, oidc_authorization_endpoint,
          oidc_token_endpoint, oidc_client_id, scim_enabled,
          scim_bearer_token_hash, scim_bearer_token_hint)
       VALUES
         ($1::uuid, 'staff', 'oidc', $2::text, 'I13 revoke IdP', 'active',
          'https://idp.example.test/revoke', 'https://idp.example.test/revoke/jwks',
          'https://idp.example.test/revoke/auth', 'https://idp.example.test/revoke/token',
          'i13-revoke', true, $4::char(64), 'revoke'),
         ($1::uuid, 'staff', 'oidc', $3::text, 'I13 enable IdP', 'active',
          'https://idp.example.test/enable', 'https://idp.example.test/enable/jwks',
          'https://idp.example.test/enable/auth', 'https://idp.example.test/enable/token',
          'i13-enable', true, $5::char(64), 'enable')
       RETURNING id::text, provider_key`,
      TENANT_ID,
      `revoke-${SUFFIX}`,
      `enable-${SUFFIX}`,
      AUTH_HASH_REVOKE,
      AUTH_HASH_ENABLE,
    );
    revokeProviderId = providers.find(row => row.provider_key === `revoke-${SUFFIX}`).id;
    enableProviderId = providers.find(row => row.provider_key === `enable-${SUFFIX}`).id;
    await prisma.$executeRawUnsafe(
      `UPDATE users
          SET scim_provider_id = CASE uid WHEN $2::uuid THEN $4::bigint ELSE $5::bigint END
        WHERE tenant_id = $1::uuid AND uid IN ($2::uuid, $3::uuid)`,
      TENANT_ID,
      REVOKE_UID,
      ENABLE_UID,
      revokeProviderId,
      enableProviderId,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE staff
          SET scim_provider_id = CASE user_id WHEN $2::uuid THEN $4::bigint ELSE $5::bigint END
        WHERE tenant_id = $1::uuid AND user_id IN ($2::uuid, $3::uuid)`,
      TENANT_ID,
      REVOKE_UID,
      ENABLE_UID,
      revokeProviderId,
      enableProviderId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, email, name, role, is_active, status, updated_at,
          identity_source, scim_external_id, is_break_glass_account, break_glass_name)
       VALUES
         ($1::uuid, $2::uuid, $3::text, $4::text, 'I13 named break-glass staff',
          'NURSING_STAFF', true, 'active', NOW(), 'scim', $5::text, true,
          'I13 emergency local account')`,
      BREAK_GLASS_UID,
      TENANT_ID,
      `97${SUFFIX.slice(0, 10)}`,
      `break-glass-${SUFFIX}@example.test`,
      `scim-break-glass-${SUFFIX}`,
    );
    const breakGlassStaff = await prisma.$queryRawUnsafe(
      `INSERT INTO staff
         (tenant_id, user_id, employee_id, name, designation, is_active,
          archived, updated_at, identity_source, scim_external_id)
       VALUES
         ($1::uuid, $2::uuid, $3::text, 'I13 named break-glass staff',
          'Nurse', true, false, NOW(), 'scim', $4::text)
       RETURNING id`,
      TENANT_ID,
      BREAK_GLASS_UID,
      `B-${SUFFIX}`,
      `scim-break-glass-${SUFFIX}`,
    );
    breakGlassStaffId = Number(breakGlassStaff[0].id);
    const breakGlassProviders = await prisma.$queryRawUnsafe(
      `INSERT INTO tenant_identity_providers
         (tenant_id, realm, protocol, provider_key, display_name, status,
          oidc_issuer, oidc_jwks_uri, oidc_authorization_endpoint,
          oidc_token_endpoint, oidc_client_id, scim_enabled,
          scim_bearer_token_hash, scim_bearer_token_hint)
       VALUES
         ($1::uuid, 'staff', 'oidc', $2::text, 'I13 break-glass IdP', 'active',
          'https://idp.example.test/break-glass',
          'https://idp.example.test/break-glass/jwks',
          'https://idp.example.test/break-glass/auth',
          'https://idp.example.test/break-glass/token',
          'i13-break-glass', true, $3::char(64), 'break-glass')
       RETURNING id::text`,
      TENANT_ID,
      `break-glass-${SUFFIX}`,
      AUTH_HASH_BREAK_GLASS,
    );
    breakGlassProviderId = breakGlassProviders[0].id;
    await prisma.$executeRawUnsafe(
      `UPDATE users
          SET scim_provider_id = $3::bigint
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      TENANT_ID,
      BREAK_GLASS_UID,
      breakGlassProviderId,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE staff
          SET scim_provider_id = $3::bigint
        WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
      TENANT_ID,
      BREAK_GLASS_UID,
      breakGlassProviderId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO user_active_sessions
         (user_uid, jti, device_type, issued_at, expires_at)
       VALUES ($1::uuid, $2::text, 'staff', NOW(), NOW() + INTERVAL '1 day')`,
      REVOKE_UID,
      `jti-${SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff_auth_sessions
         (staff_id, device_id, session_token, expires_at, created_at)
       VALUES ($1::integer, $2::text, $3::text, NOW() + INTERVAL '1 day', NOW())`,
      revokeStaffId,
      `device-${SUFFIX}`,
      `session-${SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO user_devices
         (tenant_id, user_uid, device_id, device_name, device_type)
       VALUES ($1::uuid, $2::uuid, $3::text, 'I13 staff device', 'staff')`,
      TENANT_ID,
      REVOKE_UID,
      `device-${SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff_devices
         (tenant_id, staff_id, user_uid, device_id, is_active, pin_hash, biometric_enabled)
       VALUES ($1::uuid, $2::integer, $3::uuid, $4::text, true, 'pin-fixture', true)`,
      TENANT_ID,
      revokeStaffId,
      REVOKE_UID,
      `device-${SUFFIX}`,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('writes the exact live provider command receipt inside the provisioning transaction', async () => {
    const body = '{"Operations":[{"op":"replace","path":"displayName","value":"I13 live-updated staff"}]}';
    const context = await resolveScimContext({
      tenantSlug: `i13-scim-${SUFFIX}`,
      providerKey: `revoke-${SUFFIX}`,
      req: {
        id: `live-${SUFFIX}`,
        ip: '127.0.0.1',
        headers: {
          authorization: `Bearer revoke-${SUFFIX}`,
          'user-agent': 'i13-live-receipt-test',
        },
      },
    });
    const result = await patchScimUser(context, REVOKE_UID, JSON.parse(body), {
      req: {
        id: `live-${SUFFIX}`,
        ip: '127.0.0.1',
        scimRawBody: Buffer.from(body, 'utf8'),
        headers: { 'user-agent': 'i13-live-receipt-test' },
      },
    });
    expect(result.resource.displayName).toBe('I13 live-updated staff');

    const receipts = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT body_ciphertext, body_sha256::text, body_bytes,
              command_source, command_kind, http_method,
              effect_disposition, execution_disposition, evidence
         FROM scim_provisioning_commands
        WHERE tenant_id = $1::uuid AND target_uid = $2::uuid
          AND command_source = 'live_provider_push'
        ORDER BY id DESC
        LIMIT 1`,
      TENANT_ID,
      REVOKE_UID,
    ));
    expect(Buffer.from(decryptField(receipts[0].body_ciphertext), 'base64').toString('utf8')).toBe(body);
    expect(receipts[0]).toMatchObject({
      body_sha256: sha256(Buffer.from(body, 'utf8')),
      body_bytes: Buffer.byteLength(body, 'utf8'),
      command_source: 'live_provider_push',
      command_kind: 'profile_update',
      http_method: 'PATCH',
      effect_disposition: 'live_applied',
      execution_disposition: 'applied',
      evidence: expect.objectContaining({
        exact_scim_body_byte_parity_verified: true,
        provider_sequence_present: false,
        push_replay_authorized: false,
      }),
    });

    await expect(patchScimUser(context, REVOKE_UID, {
      Operations: [{ op: 'replace', path: 'displayName', value: 'must roll back' }],
    }, {
      req: { id: `missing-body-${SUFFIX}`, headers: {} },
    })).rejects.toMatchObject({ code: 'SCIM_EXACT_BODY_REQUIRED' });
    const rollbackProof = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT u.name,
              (SELECT COUNT(*)::integer
                 FROM scim_provisioning_commands r
                WHERE r.tenant_id = u.tenant_id
                  AND r.target_uid = u.uid
                  AND r.command_source = 'live_provider_push') AS receipt_count
         FROM users u
        WHERE u.tenant_id = $1::uuid AND u.uid = $2::uuid`,
      TENANT_ID,
      REVOKE_UID,
    ));
    expect(rollbackProof[0]).toEqual({
      name: 'I13 live-updated staff',
      receipt_count: 1,
    });
  });

  test('executes the C-D15 late revocation and retains exact pending evidence', async () => {
    const body = '{"Operations":[{"op":"replace","path":"active","value":false}]}';
    publishRevokeAllUserTokens.mockClear();
    publishRevokeAllUserTokens.mockImplementationOnce(async (uid) => {
      const committed = await prisma.$queryRawUnsafe(
        `SELECT is_active, status
           FROM users
          WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
        TENANT_ID,
        uid,
      );
      expect(committed[0]).toMatchObject({ is_active: false, status: 'inactive' });
      return { database: { persisted: true } };
    });
    const recovered = await recover({
      providerId: revokeProviderId,
      providerKey: `revoke-${SUFFIX}`,
      authHash: AUTH_HASH_REVOKE,
      targetUid: REVOKE_UID,
      externalId: `scim-revoke-${SUFFIX}`,
      commandKind: 'deactivate',
      method: 'PATCH',
      body,
      occurredAt: '2026-08-03T01:59:00.000Z',
    });
    expect(recovered.outcome).toMatchObject({
      status: 'handled',
      outcome_code: 'i13_revocation_executed_pending_identity_review',
      cursor: {
        high_water_position: '10',
        recovery_state: 'reconciliation_required_provider_state',
      },
    });
    expect(persistRevokeAllUserTokens).toHaveBeenCalledTimes(1);
    expect(persistRevokeAllUserTokens).toHaveBeenCalledWith(REVOKE_UID, expect.objectContaining({
      reason: 'scim_deprovision',
      notificationTenantId: TENANT_ID,
    }));
    expect(publishRevokeAllUserTokens).toHaveBeenCalledWith(
      REVOKE_UID,
      1_700_000_000,
      { reason: 'scim_deprovision' },
    );
    const state = await prisma.$queryRawUnsafe(
      `SELECT u.is_active, u.status, s.is_active AS staff_is_active, s.archived,
              (SELECT COUNT(*)::integer FROM user_active_sessions WHERE user_uid = u.uid) AS active_sessions,
              (SELECT COUNT(*)::integer FROM staff_auth_sessions WHERE staff_id = s.id) AS staff_sessions,
              (SELECT COUNT(*)::integer FROM staff_devices
                WHERE staff_id = s.id AND (is_active OR pin_hash IS NOT NULL OR biometric_enabled)) AS unsafe_devices
         FROM users u JOIN staff s ON s.tenant_id = u.tenant_id AND s.user_id = u.uid
        WHERE u.tenant_id = $1::uuid AND u.uid = $2::uuid`,
      TENANT_ID,
      REVOKE_UID,
    );
    expect(state[0]).toEqual({
      is_active: false,
      status: 'inactive',
      staff_is_active: false,
      archived: true,
      active_sessions: 0,
      staff_sessions: 0,
      unsafe_devices: 0,
    });
    const receipts = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT r.payload_ciphertext, r.payload_sha256::text, r.payload_bytes,
              r.body_ciphertext, r.body_sha256::text, r.body_bytes,
              r.execution_disposition, r.evidence, t.status AS task_status,
              t.assigned_to_role, t.workflow_sla_instance_id
         FROM scim_provisioning_commands r
         JOIN pathway_projector_inbox i
           ON i.tenant_id = r.tenant_id AND i.inbox_id = r.recovery_inbox_id
         JOIN tasks t ON t.tenant_id = i.tenant_id AND t.id = i.pending_task_id
        WHERE r.tenant_id = $1::uuid AND r.id = $2::bigint`,
      TENANT_ID,
      recovered.outcome.receipt_id,
    ));
    expect(decryptField(receipts[0].payload_ciphertext)).toBe(recovered.rawPayload);
    expect(Buffer.from(decryptField(receipts[0].body_ciphertext), 'base64').toString('utf8')).toBe(body);
    expect(receipts[0]).toMatchObject({
      payload_sha256: recovered.payloadHash,
      payload_bytes: Buffer.byteLength(recovered.rawPayload, 'utf8'),
      body_sha256: sha256(Buffer.from(body, 'utf8')),
      body_bytes: Buffer.byteLength(body, 'utf8'),
      execution_disposition: 'revocation_executed_pending_review',
      task_status: 'open',
      assigned_to_role: 'TENANT_ADMIN',
      workflow_sla_instance_id: null,
      evidence: expect.objectContaining({
        exact_payload_byte_parity_verified: true,
        exact_scim_body_byte_parity_verified: true,
        provider_sequence_present: false,
        push_replay_authorized: false,
        c_d15_revocation_exception_applied: true,
      }),
    });
  });

  test('keeps a late named break-glass revocation pending without shutting access off', async () => {
    const body = '{"Operations":[{"op":"replace","path":"active","value":false}]}';
    const recovered = await recover({
      providerId: breakGlassProviderId,
      providerKey: `break-glass-${SUFFIX}`,
      authHash: AUTH_HASH_BREAK_GLASS,
      targetUid: BREAK_GLASS_UID,
      externalId: `scim-break-glass-${SUFFIX}`,
      commandKind: 'deactivate',
      method: 'PATCH',
      body,
      occurredAt: '2026-08-03T02:00:00.000Z',
    });
    expect(recovered.outcome).toMatchObject({
      status: 'handled',
      outcome_code: 'i13_break_glass_pending_identity_review',
      cursor: {
        high_water_position: '10',
        recovery_state: 'reconciliation_required_provider_state',
      },
    });
    expect(persistRevokeAllUserTokens).not.toHaveBeenCalledWith(BREAK_GLASS_UID, expect.anything());
    const state = await prisma.$queryRawUnsafe(
      `SELECT u.is_active, u.status, s.id AS staff_id,
              s.is_active AS staff_is_active, s.archived
         FROM users u
         JOIN staff s ON s.tenant_id = u.tenant_id AND s.user_id = u.uid
        WHERE u.tenant_id = $1::uuid AND u.uid = $2::uuid`,
      TENANT_ID,
      BREAK_GLASS_UID,
    );
    expect(state[0]).toEqual({
      is_active: true,
      status: 'active',
      staff_id: breakGlassStaffId,
      staff_is_active: true,
      archived: false,
    });
    const receipts = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT execution_disposition, access_shutdown_evidence, evidence
         FROM scim_provisioning_commands
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT_ID,
      recovered.outcome.receipt_id,
    ));
    expect(receipts[0]).toMatchObject({
      execution_disposition: 'break_glass_excluded_pending_review',
      access_shutdown_evidence: {
        excluded_break_glass: true,
        revoked_sessions: 0,
        disabled_staff_devices: 0,
        deleted_staff_sessions: 0,
      },
      evidence: expect.objectContaining({
        automatic_access_mutation: false,
        c_d15_revocation_exception_applied: false,
      }),
    });
  });

  test('keeps a late enable pending and cannot restore disabled access', async () => {
    const body = '{"Operations":[{"op":"replace","path":"active","value":true}]}';
    const recovered = await recover({
      providerId: enableProviderId,
      providerKey: `enable-${SUFFIX}`,
      authHash: AUTH_HASH_ENABLE,
      targetUid: ENABLE_UID,
      externalId: `scim-enable-${SUFFIX}`,
      commandKind: 'enable',
      method: 'PATCH',
      body,
      occurredAt: '2026-08-03T02:01:00.000Z',
    });
    expect(recovered.outcome).toMatchObject({
      status: 'handled',
      outcome_code: 'i13_command_pending_identity_review',
      cursor: {
        high_water_position: '10',
        recovery_state: 'reconciliation_required_provider_state',
      },
    });
    expect(persistRevokeAllUserTokens).not.toHaveBeenCalledWith(ENABLE_UID, expect.anything());
    const state = await prisma.$queryRawUnsafe(
      `SELECT u.is_active, u.status, s.is_active AS staff_is_active, s.archived
         FROM users u JOIN staff s ON s.tenant_id = u.tenant_id AND s.user_id = u.uid
        WHERE u.tenant_id = $1::uuid AND u.uid = $2::uuid`,
      TENANT_ID,
      ENABLE_UID,
    );
    expect(state[0]).toEqual({
      is_active: false,
      status: 'inactive',
      staff_is_active: false,
      archived: true,
    });
    const receipts = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT execution_disposition, access_shutdown_evidence, evidence
         FROM scim_provisioning_commands
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT_ID,
      recovered.outcome.receipt_id,
    ));
    expect(receipts[0]).toMatchObject({
      execution_disposition: 'pending_review_no_mutation',
      access_shutdown_evidence: {},
      evidence: expect.objectContaining({
        provider_sequence_present: false,
        push_replay_authorized: false,
        automatic_access_mutation: false,
      }),
    });
  });
});
