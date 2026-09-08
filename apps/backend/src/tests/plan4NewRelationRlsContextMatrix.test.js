import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const REQUIRED_CONTEXT_QUAL = '(app_current_tenant_id_uuid() IS NOT NULL)';

const PLAN4_FOUNDATION_RELATIONS = [
  'reprocessing_domain_settings',
  'reprocessing_isolation_setting_revisions',
  'reprocessing_domain_policies',
  'reprocessing_protocols',
  'reprocessable_devices',
  'reprocessable_device_usages',
  'reprocessable_device_dialysis_links',
  'dialysis_machines',
  'reprocessable_device_holds',
  'device_processing_events',
  'dialyser_reprocessing_attempts',
  'bloodborne_exposure_outbox',
  'reprocessing_protocol_device_scopes',
  'device_processing_event_revisions',
  'reprocessable_hold_satisfactions',
  'bloodborne_exposure_deliveries',
  'bloodborne_exposure_applications',
  'reprocessable_device_operations',
];
const PLAN4_RELATIONS = [
  ...PLAN4_FOUNDATION_RELATIONS,
  'dialysis_isolation_emergency_authorizations',
];

describeIfDb('Plan 4 new-relation tenant isolation', () => {
  const client = new Client({ connectionString: databaseUrl });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();

  beforeAll(async () => {
    expect(PLAN4_FOUNDATION_RELATIONS).toHaveLength(18);
    expect(PLAN4_RELATIONS).toHaveLength(19);
    await client.connect();
    await client.query('BEGIN');
    for (const [id, suffix] of [[tenantId, 'positive'], [otherTenantId, 'wrong']]) {
      await client.query(
        `INSERT INTO tenants (id, slug, name)
         VALUES ($1::uuid, $2::text, $3::text)`,
        [id, `plan4-rls-${suffix}-${randomUUID()}`, `Plan 4 RLS ${suffix}`],
      );
    }
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
    await client.query(
      `INSERT INTO reprocessing_domain_settings
         (tenant_id, domain, reactive_patient_rule)
       VALUES ($1::uuid, 'dialysis', 'discard')`,
      [tenantId],
    );
  });

  afterAll(async () => {
    await client.query('RESET ROLE').catch(() => {});
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  async function countAsRuntime(context, domain = 'dialysis') {
    await client.query('SAVEPOINT plan4_rls_case');
    try {
      await client.query('SET LOCAL ROLE vhhealth_app');
      if (context === undefined) {
        await client.query('RESET app.current_tenant_id');
      } else {
        await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [context]);
      }
      const result = await client.query(
        `SELECT COUNT(*)::int AS count
           FROM reprocessing_domain_settings
          WHERE tenant_id = $1::uuid
            AND domain = $2::text`,
        [tenantId, domain],
      );
      return result.rows[0].count;
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT plan4_rls_case');
      await client.query('RELEASE SAVEPOINT plan4_rls_case');
    }
  }

  test('plan4NewRelationRlsContextMatrix', async () => {
    expect(await countAsRuntime(tenantId)).toBe(1);
    expect(await countAsRuntime(undefined)).toBe(0);
    expect(await countAsRuntime('')).toBe(0);
    expect(await countAsRuntime('bypass')).toBe(0);
    expect(await countAsRuntime(otherTenantId)).toBe(0);
    await expect(countAsRuntime('not-a-uuid')).rejects.toMatchObject({ code: '22P02' });

    await client.query('SAVEPOINT plan4_rls_insert');
    await client.query('SET LOCAL ROLE vhhealth_app');
    await client.query('RESET app.current_tenant_id');
    await expect(client.query(
      `INSERT INTO reprocessing_domain_settings (tenant_id, domain, reactive_patient_rule)
       VALUES ($1::uuid, 'ot', 'discard')`,
      [tenantId],
    )).rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK TO SAVEPOINT plan4_rls_insert');
    await client.query('RELEASE SAVEPOINT plan4_rls_insert');
    expect(await countAsRuntime(tenantId, 'ot')).toBe(0);

    expect(PLAN4_FOUNDATION_RELATIONS).toHaveLength(18);
    expect(PLAN4_RELATIONS).toHaveLength(19);
    const result = await client.query(
      `SELECT tablename,
              COUNT(*) FILTER (WHERE policyname = 'tenant_isolation' AND permissive = 'PERMISSIVE')::int AS tenant_match,
              COUNT(*) FILTER (WHERE policyname = 'tenant_context_required' AND permissive = 'RESTRICTIVE')::int AS context_required,
              MAX(qual) FILTER (WHERE policyname = 'tenant_context_required') AS context_qual,
              MAX(with_check) FILTER (WHERE policyname = 'tenant_context_required') AS context_with_check
         FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = ANY($1::text[])
        GROUP BY tablename`,
      [PLAN4_RELATIONS],
    );
    expect(result.rows).toHaveLength(19);
    const foundationRows = result.rows.filter((row) => PLAN4_FOUNDATION_RELATIONS.includes(row.tablename));
    expect(foundationRows).toHaveLength(18);
    const contextQualByRelation = {};
    for (const row of result.rows) {
      expect(row).toMatchObject({ tenant_match: 1, context_required: 1 });
      expect(row.context_with_check === null || row.context_with_check === row.context_qual).toBe(true);
      contextQualByRelation[row.tablename] = row.context_qual;
    }
    expect(Object.fromEntries(foundationRows.map((row) => [row.tablename, row.context_qual]))).toEqual(
      Object.fromEntries(PLAN4_FOUNDATION_RELATIONS.map((relation) => [relation, REQUIRED_CONTEXT_QUAL])),
    );
    expect(contextQualByRelation).toEqual(Object.fromEntries(
      PLAN4_RELATIONS.map((relation) => [relation, REQUIRED_CONTEXT_QUAL]),
    ));
  });
});
