import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../../migrations/617_scim_identity_recovery.sql', import.meta.url),
  'utf8',
);
const RLS_ROLE = 'c6_1f_i13_scim_rls';

function ownerDatabaseUrl(value) {
  if (!value) return value;
  const url = new URL(value);
  if (url.hostname === '127.0.0.1' && url.port === '55432') {
    url.username = 'postgres';
    url.password = '';
  }
  return url.toString();
}

function sha256(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

async function expectFailure(client, operation, expected) {
  await client.query('SAVEPOINT expected_i13_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_i13_failure');
  await client.query('RELEASE SAVEPOINT expected_i13_failure');
  expect(failure).toBeDefined();
  expect(failure).toMatchObject(expected);
  return failure;
}

describeIfDb('migration 617 I13 SCIM identity recovery', () => {
  const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const actorUid = randomUUID();
  const otherActorUid = randomUUID();
  const targetUid = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const authHash = sha256(`i13-auth-${suffix}`);
  const payloadHash = sha256(`i13-payload-${suffix}`);
  let providerId;
  let otherProviderId;
  let validInbox;
  let otherInbox;
  let receiptId;
  let crossActorFailure;

  async function createInbox(rowTenantId, rowProviderId, label) {
    const partition = `scim-provider:${rowProviderId}:inbound`;
    const predecessor = `${label}-token-10`;
    const token = `${label}-token-11`;
    const duplicate = `i13:${rowProviderId}:PATCH:${targetUid}:${payloadHash}`;
    const offsets = await client.query(
      `INSERT INTO event_consumer_offsets
         (scope_kind, tenant_id, facility_scope, facility_id, interface_family,
          direction, source_partition, consumer_key, generation, cursor_kind,
          high_water_position, high_water_token, retained_from_position,
          retained_from_token, recovery_state, policy_version, policy_signature,
          retention_policy, retention_until, historical_cutoff_event_id,
          backfill_cursor_event_id)
       VALUES
         ('external_interface', $1::uuid, 'tenant', NULL, 'I13', 'inbound',
          $2::text, 'external:I13', 1, 'monotonic_position_and_predecessor',
          10, $3::text, 10, $3::text, 'replaying', 'c-d15-v1',
          $4::text, 'identity-security-2555d', NOW() + INTERVAL '2555 days', NULL, NULL)
       RETURNING offset_id::text`,
      [rowTenantId, partition, predecessor, `i13-${label}-${suffix}`],
    );
    const inbox = await client.query(
      `INSERT INTO pathway_projector_inbox
         (scope_kind, tenant_id, consumer_key, generation, offset_id, facility_id,
          interface_family, direction, source_partition, source_position,
          source_token, predecessor_token, duplicate_key, command_fingerprint,
          occurred_at, received_at, recorded_at, arrival_class,
          effect_disposition, status, next_attempt_at, policy_version,
          policy_signature, retention_policy, retention_until)
       VALUES
         ('external_interface', $1::uuid, 'external:I13', 1, $2::uuid, NULL,
          'I13', 'inbound', $3::text, 11, $4::text, $5::text, $6::text,
          repeat('a', 64), NOW(), NOW(), NOW(), 'recovery_backlog',
          'late_pending_only', 'pending', NOW(), 'c-d15-v1', $7::text,
          'identity-security-2555d', NOW() + INTERVAL '2555 days')
       RETURNING inbox_id::text`,
      [rowTenantId, offsets.rows[0].offset_id, partition, token, predecessor,
        duplicate, `i13-${label}-${suffix}`],
    );
    return { partition, predecessor, token, duplicate, inboxId: inbox.rows[0].inbox_id };
  }

  function insertReceiptSql() {
    return `INSERT INTO scim_provisioning_commands
      (tenant_id, provider_id, provider_key, direction, realm, command_source,
       command_kind, http_method, target_uid, external_id, authenticated_at,
       auth_binding_sha256, body_ciphertext, body_sha256, body_bytes,
       payload_ciphertext, payload_sha256, payload_bytes, occurred_at,
       source_partition, source_position, source_token, predecessor_token,
       duplicate_key, recovery_inbox_id, recovery_interface_family,
       owner_actor_uid, owner_reason, effect_disposition,
       execution_disposition, access_shutdown_evidence, evidence)
    VALUES
      ($1::uuid, $2::bigint, $3::text, 'inbound', 'staff',
       'owner_reconciled_list_diff', 'enable', 'PATCH', $4::uuid,
       $5::text, NOW(), $6::char(64), 'body-ciphertext', $7::char(64), 16,
       'payload-ciphertext', $8::char(64), 128, NOW(), $9::text, 11,
       $10::text, $11::text, $12::text, $13::uuid, $14::text,
       $15::uuid, 'Owner-reviewed raw PostgreSQL I13 fixture',
       'late_pending_only', $16::text, '{}'::jsonb,
       '{"provider_sequence_present":false,"push_replay_authorized":false}'::jsonb)
    RETURNING id::text`;
  }

  function params({ rowTenantId = tenantId, rowProviderId = providerId,
    providerKey = `i13-${suffix}`, rowTargetUid = targetUid,
    rowActorUid = actorUid, inbox = validInbox, recoveryFamily = 'I13',
    rowAuthHash = authHash, rowPayloadHash = payloadHash,
    executionDisposition = 'pending_review_no_mutation' } = {}) {
    return [
      rowTenantId,
      rowProviderId,
      providerKey,
      rowTargetUid,
      `external-${suffix}`,
      rowAuthHash,
      sha256(`i13-body-${suffix}`),
      rowPayloadHash,
      inbox.partition,
      inbox.token,
      inbox.predecessor,
      inbox.duplicate,
      inbox.inboxId,
      recoveryFamily,
      rowActorUid,
      executionDisposition,
    ];
  }

  beforeAll(async () => {
    await client.connect();
    await client.query(`
      DO $role$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_ROLE}') THEN
          CREATE ROLE ${RLS_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END
      $role$;
    `);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`);
    await client.query(`GRANT SELECT ON scim_provisioning_commands TO ${RLS_ROLE}`);
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $3::text, 'I13 raw tenant'),
              ($2::uuid, $4::text, 'I13 raw other tenant')`,
      [tenantId, otherTenantId, `i13-raw-${suffix}`, `i13-raw-other-${suffix}`],
    );
    await client.query(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, status, updated_at,
          identity_source, scim_external_id)
       VALUES
         ($1::uuid, $4::uuid, $5::text, 'I13 raw owner', 'ADMIN', true, 'active', NOW(), 'local', NULL),
         ($2::uuid, $4::uuid, $6::text, 'I13 raw target', 'NURSING_STAFF', false, 'inactive', NOW(), 'scim', $8::text),
         ($3::uuid, $7::uuid, $9::text, 'I13 other owner', 'ADMIN', true, 'active', NOW(), 'local', NULL)`,
      [actorUid, targetUid, otherActorUid, tenantId,
        `94${suffix.slice(0, 10)}`, `95${suffix.slice(0, 10)}`, otherTenantId,
        `external-${suffix}`, `96${suffix.slice(0, 10)}`],
    );
    await client.query(
      `INSERT INTO staff
         (tenant_id, user_id, employee_id, name, is_active, archived, updated_at,
          identity_source, scim_external_id)
       VALUES ($1::uuid, $2::uuid, $3::text, 'I13 raw target', false, true,
               NOW(), 'scim', $4::text)`,
      [tenantId, targetUid, `RAW-${suffix}`, `external-${suffix}`],
    );
    const providers = await client.query(
      `INSERT INTO tenant_identity_providers
         (tenant_id, realm, protocol, provider_key, display_name, status,
          oidc_issuer, oidc_jwks_uri, oidc_authorization_endpoint,
          oidc_token_endpoint, oidc_client_id, scim_enabled,
          scim_bearer_token_hash)
       VALUES
         ($1::uuid, 'staff', 'oidc', $3::text, 'I13 raw IdP', 'active',
          'https://idp.example/raw', 'https://idp.example/raw/jwks',
          'https://idp.example/raw/auth', 'https://idp.example/raw/token',
          'raw-client', true, $5::char(64)),
         ($2::uuid, 'staff', 'oidc', $4::text, 'I13 raw other IdP', 'active',
          'https://idp.example/other', 'https://idp.example/other/jwks',
          'https://idp.example/other/auth', 'https://idp.example/other/token',
          'other-client', true, $6::char(64))
       RETURNING id::text, tenant_id::text`,
      [tenantId, otherTenantId, `i13-${suffix}`, `i13-other-${suffix}`,
        authHash, sha256(`i13-other-auth-${suffix}`)],
    );
    providerId = providers.rows.find(row => row.tenant_id === tenantId).id;
    otherProviderId = providers.rows.find(row => row.tenant_id === otherTenantId).id;
    await client.query(
      `UPDATE users SET scim_provider_id = $3::bigint
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      [tenantId, targetUid, providerId],
    );
    await client.query(
      `UPDATE staff SET scim_provider_id = $3::bigint
        WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
      [tenantId, targetUid, providerId],
    );
    validInbox = await createInbox(tenantId, providerId, 'valid');
    otherInbox = await createInbox(otherTenantId, otherProviderId, 'other');
    await client.query('SAVEPOINT expected_i13_cross_actor');
    try {
      await client.query(insertReceiptSql(), params({ rowActorUid: otherActorUid }));
    } catch (error) {
      crossActorFailure = error;
    }
    await client.query('ROLLBACK TO SAVEPOINT expected_i13_cross_actor');
    await client.query('RELEASE SAVEPOINT expected_i13_cross_actor');
    const receipt = await client.query(insertReceiptSql(), params());
    receiptId = receipt.rows[0].id;
  });

  afterAll(async () => {
    await client.query('RESET ROLE').catch(() => {});
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('follows migration 616 without inventing a replay guard or provider sequence', () => {
    const names = readdirSync(new URL('../../migrations/', import.meta.url))
      .filter(name => /^\d+.*\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
    const index = names.indexOf('617_scim_identity_recovery.sql');
    expect(names[index - 1]).toBe('616_imaging_study_link_recovery.sql');
    expect(migrationSql).not.toContain('interop_replay_guard');
    expect(migrationSql).not.toContain('provider_sequence');
    expect(migrationSql).toContain('owner_reconciled_list_diff');
    expect(migrationSql).toContain('Section 6.8 RLS posture');
    expect(migrationSql).toContain('FORCE ROW LEVEL SECURITY');
    expect(migrationSql).toContain('chk_scim_provisioning_commands_recovery_pair');
    expect(migrationSql).toContain('scim_provisioning_command_append_only');
    expect(migrationSql).toContain('FOREIGN KEY (tenant_id, provider_id)');
    expect(migrationSql).toContain('FOREIGN KEY (tenant_id, owner_actor_uid)');
    expect(migrationSql).toContain(
      'FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)',
    );
  });

  test('accepts exact tenant/provider/owner/inbox evidence and rejects cross-tenant pairs', async () => {
    expect(receiptId).toMatch(/^\d+$/);
    await expectFailure(client, () => client.query(
      insertReceiptSql(),
      params({ rowProviderId: otherProviderId, providerKey: `i13-other-${suffix}` }),
    ), { code: '23514', constraint: 'chk_scim_provisioning_command_provider_binding' });
    expect(crossActorFailure).toMatchObject({ code: '23503' });
    await expectFailure(client, () => client.query(
      insertReceiptSql(),
      params({ inbox: otherInbox }),
    ), { code: '23514', constraint: 'chk_scim_provisioning_command_recovery_provenance' });
  });

  test('rejects malformed hashes, paired-null drift, and false C-D15 execution claims', async () => {
    await expectFailure(client, async () => {
      await client.query(
        'ALTER TABLE scim_provisioning_commands DISABLE TRIGGER validate_scim_provisioning_command',
      );
      return client.query(
        insertReceiptSql(),
        params({ rowPayloadHash: 'A'.repeat(64) }),
      );
    }, { code: '23514', constraint: 'chk_scim_provisioning_commands_hashes' });
    await expectFailure(client, () => client.query(
      insertReceiptSql(),
      params({ recoveryFamily: null }),
    ), { code: '23514', constraint: 'chk_scim_provisioning_commands_recovery_pair' });
    await expectFailure(client, async () => {
      await client.query(
        `INSERT INTO user_active_sessions
           (user_uid, jti, device_type, issued_at, expires_at)
         VALUES ($1::uuid, $2::text, 'staff', NOW(), NOW() + INTERVAL '1 day')`,
        [targetUid, `raw-i13-${suffix}`],
      );
      return client.query(
        insertReceiptSql().replace("'enable', 'PATCH'", "'deactivate', 'PATCH'"),
        params({ executionDisposition: 'revocation_executed_pending_review' }),
      );
    }, { code: '23514', constraint: 'chk_scim_provisioning_command_revocation_effect' });
  });

  test('is append-only and denies absent, empty, bypass, and wrong-tenant RLS contexts', async () => {
    await expectFailure(client, () => client.query(
      'UPDATE scim_provisioning_commands SET owner_reason = owner_reason WHERE id = $1::bigint',
      [receiptId],
    ), { code: '23514', constraint: 'chk_scim_provisioning_command_append_only' });
    await expectFailure(client, () => client.query(
      'DELETE FROM scim_provisioning_commands WHERE id = $1::bigint',
      [receiptId],
    ), { code: '23514', constraint: 'chk_scim_provisioning_command_append_only' });

    await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
    for (const context of [null, '', 'bypass', otherTenantId]) {
      if (context === null) await client.query("SELECT set_config('app.current_tenant_id', NULL, true)");
      else await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [context]);
      const rows = await client.query('SELECT COUNT(*)::integer AS count FROM scim_provisioning_commands');
      expect(rows.rows[0].count).toBe(0);
    }
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
    const visible = await client.query('SELECT id::text FROM scim_provisioning_commands');
    expect(visible.rows).toEqual([{ id: receiptId }]);
    await client.query('RESET ROLE');
  });
});
