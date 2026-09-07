import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('isolationSettingsRevisionApproval', () => {
  const client = new Client({ connectionString: databaseUrl });
  const tenantId = randomUUID();
  const actorId = randomUUID();

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, 'Plan 4 isolation')`,
      [tenantId, `plan4-isolation-${randomUUID()}`],
    );
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
  });

  afterAll(async () => {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('isolationSettingsRevisionApproval', async () => {
    const result = await client.query(
      `INSERT INTO reprocessing_isolation_setting_revisions
         (tenant_id, revision, approved_isolation_groups, isolation_groups,
          vocabulary_approved_by, vocabulary_approved_role, vocabulary_approved_at,
          mapping_approved_by, mapping_approved_role, mapping_approved_at, created_by)
       VALUES ($1::uuid, 1, ARRAY['Bay 1'],
               '{"hbsag":"Bay 1","hcv":"Bay 1","hiv":"Bay 1","isolation_mixed":"Bay 1"}'::jsonb,
               $2::uuid, 'INFECTION_CONTROL_OFFICER', NOW(),
               $2::uuid, 'INFECTION_CONTROL_OFFICER', NOW(), $2::uuid)
       RETURNING id`,
      [tenantId, actorId],
    );
    await expect(client.query(
      `INSERT INTO reprocessing_domain_settings
         (tenant_id, domain, reactive_patient_rule, isolation_revision_id,
          isolation_applied_by, isolation_applied_role, isolation_applied_at)
       VALUES ($1::uuid, 'dialysis', 'discard', $2::bigint,
               $3::uuid, 'ADMIN', NOW())`,
      [tenantId, result.rows[0].id, actorId],
    )).resolves.toBeDefined();

    await client.query('SAVEPOINT invalid_approval');
    await expect(client.query(
      `INSERT INTO reprocessing_isolation_setting_revisions
         (tenant_id, revision, approved_isolation_groups, isolation_groups,
          vocabulary_approved_by, vocabulary_approved_role, vocabulary_approved_at,
          mapping_approved_by, mapping_approved_role, mapping_approved_at, created_by)
       VALUES ($1::uuid, 2, ARRAY['Bay 1'],
               '{"hbsag":"Bay 1","hcv":"Bay 1","hiv":"Bay 1","isolation_mixed":"Bay 1"}'::jsonb,
               $2::uuid, 'ADMIN', NOW(), $2::uuid, 'INFECTION_CONTROL_OFFICER', NOW(), $2::uuid)`,
      [tenantId, actorId],
    )).rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT invalid_approval');
    await client.query('RELEASE SAVEPOINT invalid_approval');
  });
});
