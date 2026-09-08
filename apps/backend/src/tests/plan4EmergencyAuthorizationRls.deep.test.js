import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('Plan 4 private emergency authorization tenant isolation', () => {
  const client = new Client({ connectionString: databaseUrl });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const patientUid = randomUUID();
  const consultantUid = randomUUID();
  const infectionControlUid = randomUUID();
  const positiveId = randomUUID();
  let machineId;
  let isolationRevisionId;
  let protocolId;

  async function insertAuthorization(id) {
    return client.query(
      `INSERT INTO dialysis_isolation_emergency_authorizations
         (id, tenant_id, patient_uid, machine_id, machine_revision, scheduled_for,
          decision_fingerprint, settings_revision, policy_revision, isolation_revision_id,
          protocol_id, consultant_approved_by, consultant_approved_role, consultant_approved_at,
          applied_by, applied_role, purpose, reason, expires_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::int, 1, NOW(),
               $5::text, 1, 1, $6::bigint, $7::int, $8::uuid, 'CONSULTANT', NOW(),
               $8::uuid, 'CONSULTANT', 'Dialysis emergency', 'RLS fixture', NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [id, tenantId, patientUid, machineId, 'a'.repeat(64), isolationRevisionId, protocolId, consultantUid],
    );
  }

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    const tenants = [[tenantId, 'positive'], [otherTenantId, 'wrong']];
    expect(tenants).toHaveLength(2);
    for (const [id, suffix] of tenants) {
      await client.query(
        `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2::text, $3::text)`,
        [id, `plan4-erls-${suffix}-${randomUUID()}`, `Plan 4 emergency RLS ${suffix}`],
      );
    }
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
    const users = [
      [patientUid, 'PATIENT'], [consultantUid, 'CONSULTANT'],
      [infectionControlUid, 'INFECTION_CONTROL_OFFICER'],
    ];
    expect(users).toHaveLength(3);
    for (const [uid, role] of users) {
      await client.query(
        `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::text, 'Plan 4 emergency RLS', $4::text, TRUE, 'active', NOW())`,
        [uid, tenantId, `+91${BigInt(`0x${uid.replaceAll('-', '').slice(0, 12)}`)
          .toString().padStart(10, '0').slice(-10)}`, role],
      );
    }
    const machine = await client.query(
      `INSERT INTO dialysis_machines (tenant_id, machine_no, created_by)
       VALUES ($1::uuid, $2::text, $3::uuid) RETURNING id`,
      [tenantId, `ERLS-${randomUUID().slice(0, 8)}`, consultantUid],
    );
    expect(machine.rows).toHaveLength(1);
    machineId = machine.rows[0].id;
    const isolation = await client.query(
      `INSERT INTO reprocessing_isolation_setting_revisions
         (tenant_id, revision, approved_isolation_groups, isolation_groups,
          vocabulary_approved_by, vocabulary_approved_role, vocabulary_approved_at,
          mapping_approved_by, mapping_approved_role, mapping_approved_at, created_by)
       VALUES ($1::uuid, 1, ARRAY['GROUP_A'],
               '{"hbsag":"GROUP_A","hcv":"GROUP_A","hiv":"GROUP_A","isolation_mixed":"GROUP_A"}'::jsonb,
               $2::uuid, 'INFECTION_CONTROL_OFFICER', NOW(),
               $2::uuid, 'INFECTION_CONTROL_OFFICER', NOW(), $2::uuid)
       RETURNING id`,
      [tenantId, infectionControlUid],
    );
    expect(isolation.rows).toHaveLength(1);
    isolationRevisionId = isolation.rows[0].id;
    const protocol = await client.query(
      `INSERT INTO reprocessing_protocols
         (tenant_id, protocol_key, revision, domain, category, name, basis, reference,
          approved_by, approved_role, approved_at, reuse_matrix, created_by)
       VALUES ($1::uuid, $2::uuid, 1, 'dialysis', 'dialyser', 'Emergency RLS fixture',
               'manufacturer_ifu', 'Emergency RLS fixture', $3::uuid, 'CONSULTANT', NOW(),
               '{"hbsag":"no_reuse","hcv":"no_reuse","hiv":"no_reuse","isolation_mixed":"no_reuse"}'::jsonb,
               $3::uuid) RETURNING id`,
      [tenantId, randomUUID(), consultantUid],
    );
    expect(protocol.rows).toHaveLength(1);
    protocolId = protocol.rows[0].id;
    await client.query('SET LOCAL ROLE vhhealth_app');
    expect((await insertAuthorization(positiveId)).rows).toEqual([{ id: positiveId }]);
    await client.query('RESET ROLE');
  });

  afterAll(async () => {
    try {
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  async function asRuntime(context, callback) {
    await client.query('SAVEPOINT emergency_rls_case');
    try {
      await client.query('SET LOCAL ROLE vhhealth_app');
      if (context === undefined) {
        await client.query('RESET app.current_tenant_id');
      } else {
        await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [context]);
      }
      return await callback();
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT emergency_rls_case');
      await client.query('RELEASE SAVEPOINT emergency_rls_case');
    }
  }

  async function countAuthorization(context, id = positiveId) {
    return asRuntime(context, async () => {
      const result = await client.query(
        `SELECT COUNT(*)::int AS count FROM dialysis_isolation_emergency_authorizations
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [tenantId, id],
      );
      expect(result.rows).toHaveLength(1);
      return result.rows[0].count;
    });
  }

  test('plan4EmergencyAuthorizationRlsContextMatrix', async () => {
    await asRuntime(tenantId, async () => {
      const runtime = await client.query(
        `SELECT current_user AS role, rolsuper, rolbypassrls
           FROM pg_roles WHERE rolname = current_user`,
      );
      expect(runtime.rows).toHaveLength(1);
      expect(runtime.rows).toEqual([{ role: 'vhhealth_app', rolsuper: false, rolbypassrls: false }]);
    });
    expect(await countAuthorization(tenantId)).toBe(1);
    expect(await countAuthorization(undefined)).toBe(0);
    expect(await countAuthorization('')).toBe(0);
    expect(await countAuthorization('bypass')).toBe(0);
    expect(await countAuthorization(otherTenantId)).toBe(0);
    await expect(countAuthorization('not-a-uuid')).rejects.toMatchObject({ code: '22P02' });

    const deniedId = randomUUID();
    await expect(asRuntime(undefined, () => insertAuthorization(deniedId)))
      .rejects.toMatchObject({ code: '42501' });
    expect(await countAuthorization(tenantId, deniedId)).toBe(0);
    expect(await countAuthorization(tenantId)).toBe(1);
  });
});
