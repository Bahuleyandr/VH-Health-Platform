import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../../migrations/621_clinical_trial_catalog_recovery.sql', import.meta.url),
  'utf8',
);
const RLS_ROLE = 'c6_1g_i23_trial_rls';

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
  await client.query('SAVEPOINT expected_i23_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_i23_failure');
  await client.query('RELEASE SAVEPOINT expected_i23_failure');
  expect(failure).toBeDefined();
  expect(failure).toMatchObject(expected);
  return failure;
}

describeIfDb('migration 621 I23 clinical trial catalog recovery', () => {
  const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const actorUid = randomUUID();
  const otherActorUid = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const sourcePartition = `clinicaltrials_gov_v2:${'a'.repeat(64)}`;
  const completePartition = `clinicaltrials_gov_v2:${'b'.repeat(64)}`;
  const otherPartition = `clinicaltrials_gov_v2:${'c'.repeat(64)}`;
  const pageToken = `page-${suffix}`;
  const tokenHash = sha256(pageToken);
  const pageHash = sha256(`body-${sourcePartition}`);
  let failedRunId;
  let completeRunId;
  let otherRunId;
  let inboxId;

  async function insertRun({
    rowTenantId,
    partition,
    token,
    status,
    complete,
    ownerUid,
  }) {
    const result = await client.query(
      `INSERT INTO clinical_ai_trial_sync_runs
         (tenant_id, source, query_conditions, requested_by, status,
          finished_at, error_message, source_partition, provider_page_token,
          provider_page_token_sha256, provider_revision,
          provider_page_sha256, provider_page_complete)
       VALUES
         ($1::uuid, 'clinicaltrials_gov_v2', ARRAY['i23 raw fixture'], $2::uuid,
          $5::text,
          CASE WHEN $5::text IN ('completed', 'failed') THEN NOW() ELSE NULL END,
          CASE WHEN $5::text = 'failed' THEN 'raw provider failure' ELSE NULL END,
          $3::text, $4::text, $6::char(64),
          CASE WHEN $5::text IN ('completed', 'failed') THEN '2026-08-04T00:00:00Z' ELSE NULL END,
          CASE WHEN $5::text IN ('completed', 'failed') THEN $7::char(64) ELSE NULL END,
          $8::boolean)
       RETURNING id`,
      [rowTenantId, ownerUid, partition, token, status, sha256(token),
        sha256(`body-${partition}`), complete],
    );
    return result.rows[0].id;
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
    await client.query(`GRANT SELECT ON clinical_ai_trial_sync_runs TO ${RLS_ROLE}`);
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $3::text, 'I23 raw tenant'),
              ($2::uuid, $4::text, 'I23 raw other tenant')`,
      [tenantId, otherTenantId, `i23-raw-${suffix}`, `i23-raw-other-${suffix}`],
    );
    await client.query(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $3::uuid, $5::text, 'I23 raw owner', 'ADMIN', true, 'active', NOW()),
         ($2::uuid, $4::uuid, $6::text, 'I23 other owner', 'ADMIN', true, 'active', NOW())`,
      [actorUid, otherActorUid, tenantId, otherTenantId,
        `92${suffix.slice(0, 10)}`, `93${suffix.slice(0, 10)}`],
    );
    failedRunId = await insertRun({
      rowTenantId: tenantId,
      partition: sourcePartition,
      token: pageToken,
      status: 'failed',
      complete: false,
      ownerUid: actorUid,
    });
    completeRunId = await insertRun({
      rowTenantId: tenantId,
      partition: completePartition,
      token: 'origin',
      status: 'completed',
      complete: true,
      ownerUid: actorUid,
    });
    otherRunId = await insertRun({
      rowTenantId: otherTenantId,
      partition: otherPartition,
      token: 'origin',
      status: 'completed',
      complete: true,
      ownerUid: otherActorUid,
    });

    const offset = await client.query(
      `INSERT INTO event_consumer_offsets
         (scope_kind, tenant_id, facility_scope, facility_id, interface_family,
          direction, source_partition, consumer_key, generation, cursor_kind,
          high_water_position, high_water_token, retained_from_position,
          retained_from_token, recovery_state, policy_version, policy_signature,
          retention_policy, retention_until, historical_cutoff_event_id,
          backfill_cursor_event_id)
       VALUES
         ('external_interface', $1::uuid, 'tenant', NULL, 'I23', 'inbound',
          $2::text, $3::text, 1, 'opaque_page_token_revision',
          $4::bigint - 1, $5::text, $4::bigint - 1, $5::text,
          'replaying', 'i23-owner-v1', $6::text,
          'clinical-trial-page-evidence-2555d', NOW() + INTERVAL '2555 days', NULL, NULL)
       RETURNING offset_id::text`,
      [tenantId, sourcePartition, `external:I23:${suffix}`, failedRunId,
        `run:${failedRunId - 1}`, `i23-${suffix}`],
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
         ('external_interface', $1::uuid, $2::text, 1, $3::uuid, NULL,
          'I23', 'inbound', $4::text, $5::bigint, $6::text, $7::text,
          $8::text, repeat('d', 64), NOW(), NOW(), NOW(), 'recovery_backlog',
          'late_pending_only', 'pending', NOW(), 'i23-owner-v1', $9::text,
          'clinical-trial-page-evidence-2555d', NOW() + INTERVAL '2555 days')
       RETURNING inbox_id::text`,
      [tenantId, `external:I23:${suffix}`, offset.rows[0].offset_id,
        sourcePartition, failedRunId, pageToken, `run:${failedRunId - 1}`,
        `i23:${failedRunId}:${tokenHash}:${pageHash}`, `i23-${suffix}`],
    );
    inboxId = inbox.rows[0].inbox_id;
  });

  afterAll(async () => {
    await client.query('RESET ROLE').catch(() => {});
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('follows migration 620 and reuses the canonical catalog and run tables', () => {
    const names = readdirSync(new URL('../../migrations/', import.meta.url))
      .filter(name => /^\d+.*\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
    const index = names.indexOf('621_clinical_trial_catalog_recovery.sql');
    expect(names[index - 1]).toBe('620_subscriber_webhook_recovery.sql');
    expect(migrationSql).not.toMatch(/CREATE\s+TABLE/i);
    expect(migrationSql).not.toMatch(/high[_ ]water|hwm_table/i);
    expect(migrationSql).toContain('provider_page_complete');
    expect(migrationSql).toContain('FOREIGN KEY (tenant_id, source_sync_run_id)');
  });

  test('rejects token-hash drift and cross-tenant catalog provenance', async () => {
    await expectFailure(client, () => client.query(
      `UPDATE clinical_ai_trial_sync_runs
          SET provider_page_token_sha256 = repeat('e', 64)
        WHERE id = $1::integer`,
      [failedRunId],
    ), { code: '23514' });
    await expectFailure(client, () => client.query(
      `INSERT INTO clinical_trials_catalog
         (tenant_id, nct_id, title, eligibility_summary, provider_revision,
          source_payload_sha256, source_sync_run_id)
       VALUES ($1::uuid, $2::text, 'I23 cross tenant', 'Not applicable',
               '2026-08-04T00:00:00Z', repeat('f', 64), $3::integer)`,
      [tenantId, `NCT${suffix.slice(0, 8)}`, otherRunId],
    ), { code: '23503', constraint: 'fk_clinical_trials_catalog_source_sync_run' });
  });

  test('makes complete page evidence and exact owner recovery evidence immutable', async () => {
    await expectFailure(client, () => client.query(
      `UPDATE clinical_ai_trial_sync_runs SET upserted_count = upserted_count + 1
        WHERE id = $1::integer`,
      [completeRunId],
    ), { code: '23514', constraint: 'chk_clinical_trial_i23_page_evidence_immutable' });

    await client.query(
      `UPDATE clinical_ai_trial_sync_runs
          SET recovery_inbox_id = $2::uuid,
              recovery_interface_family = 'I23',
              recovery_owner_uid = $3::uuid,
              recovery_owner_reason = 'Owner-reviewed I23 raw fixture',
              recovery_evidence = '{"exact_provider_page_verified":true}'::jsonb,
              effect_disposition = 'late_pending_only'
        WHERE tenant_id = $1::uuid AND id = $4::integer`,
      [tenantId, inboxId, actorUid, failedRunId],
    );
    await expectFailure(client, () => client.query(
      `UPDATE clinical_ai_trial_sync_runs SET recovery_owner_reason = 'rewritten'
        WHERE id = $1::integer`,
      [failedRunId],
    ), { code: '23514', constraint: 'chk_clinical_trial_i23_recovery_immutable' });
    await expectFailure(client, () => client.query(
      'DELETE FROM clinical_ai_trial_sync_runs WHERE id = $1::integer',
      [failedRunId],
    ), { code: '23514', constraint: 'chk_clinical_trial_i23_evidence_immutable' });
  });

  test('enforces forced tenant RLS for both live and owner-held run evidence', async () => {
    const posture = await client.query(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE oid = 'public.clinical_ai_trial_sync_runs'::regclass`,
    );
    expect(posture.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
    for (const [context, expectedCount] of [
      [null, 1],
      ['', 1],
      ['bypass', 1],
      [otherTenantId, 0],
    ]) {
      if (context === null) {
        await client.query("SELECT set_config('app.current_tenant_id', NULL, true)");
      } else {
        await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [context]);
      }
      const hidden = await client.query(
        'SELECT COUNT(*)::integer AS count FROM clinical_ai_trial_sync_runs WHERE id = ANY($1::integer[])',
        [[failedRunId, completeRunId]],
      );
      expect(hidden.rows[0].count).toBe(expectedCount);
      if (expectedCount === 1) {
        const held = await client.query(
          'SELECT id FROM clinical_ai_trial_sync_runs WHERE id = $1::integer',
          [failedRunId],
        );
        expect(held.rows).toEqual([]);
      }
    }
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
    const visible = await client.query(
      'SELECT id FROM clinical_ai_trial_sync_runs WHERE id = ANY($1::integer[]) ORDER BY id',
      [[failedRunId, completeRunId]],
    );
    expect(visible.rows.map(row => row.id)).toEqual([failedRunId, completeRunId]);
    await client.query('RESET ROLE');
  });
});
