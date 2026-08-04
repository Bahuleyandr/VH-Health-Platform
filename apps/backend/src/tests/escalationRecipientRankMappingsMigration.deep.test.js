import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../migrations/623_escalation_recipient_rank_mappings.sql', import.meta.url),
  'utf8',
);
const prismaSchema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const RLS_ROLE = 'escalation_rank_rls_test';

function ownerDatabaseUrl(value) {
  if (!value) return value;
  const url = new URL(value);
  if (url.hostname === '127.0.0.1' && url.port === '55432') {
    url.username = 'postgres';
    url.password = '';
  }
  return url.toString();
}

async function expectFailure(client, operation, expected) {
  await client.query('SAVEPOINT expected_escalation_rank_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_escalation_rank_failure');
  await client.query('RELEASE SAVEPOINT expected_escalation_rank_failure');
  expect(failure).toBeDefined();
  expect(failure).toMatchObject(expected);
  return failure;
}

function insertMapping(client, {
  tenantId,
  sourceKind = 'position',
  sourceValue = 'Senior Consultant',
  normalizedSourceValue = 'senior consultant',
  priorityRank = 1,
} = {}) {
  return client.query(
    `INSERT INTO escalation_recipient_rank_mappings
       (tenant_id, source_kind, source_value, normalized_source_value, priority_rank)
     VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::smallint)
     RETURNING id::text`,
    [tenantId, sourceKind, sourceValue, normalizedSourceValue, priorityRank],
  );
}

describe('migration 623 static escalation recipient ranking contract', () => {
  test('is the only migration 623 and follows migration 622', () => {
    const names = readdirSync(new URL('../migrations/', import.meta.url))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
    const migration623 = names.filter((name) => name.startsWith('623_'));
    expect(migration623).toEqual(['623_escalation_recipient_rank_mappings.sql']);
    expect(names[names.indexOf(migration623[0]) - 1]).toBe('622_siem_canonical_cutover.sql');
  });

  test('states the Section 6.8 posture and pins forced RLS plus narrow runtime grants', () => {
    expect(migrationSql).toContain('Section 6.8 RLS posture and reasoning');
    expect(migrationSql).toContain(
      'ALTER TABLE public.escalation_recipient_rank_mappings FORCE ROW LEVEL SECURITY',
    );
    expect(migrationSql).toContain('AS RESTRICTIVE');
    expect(migrationSql).toContain("current_setting('app.current_tenant_id', true) <> 'bypass'");
    expect(migrationSql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE');
    expect(migrationSql).toContain('REVOKE TRUNCATE, REFERENCES, TRIGGER');
    expect(prismaSchema).toContain('model escalation_recipient_rank_mappings');
    expect(prismaSchema).toContain(
      '@@unique([tenant_id, source_kind, normalized_source_value], map: "uq_escalation_recipient_rank_mappings_source")',
    );
  });
});

describeIfDb('migration 623 database escalation recipient ranking contract', () => {
  const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);

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
    await client.query(`ALTER ROLE ${RLS_ROLE} NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE
         ON escalation_recipient_rank_mappings TO ${RLS_ROLE}`,
    );
    await client.query(
      `REVOKE TRUNCATE, REFERENCES, TRIGGER
         ON escalation_recipient_rank_mappings FROM ${RLS_ROLE}`,
    );
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $3::text, 'Escalation ranking tenant'),
              ($2::uuid, $4::text, 'Escalation ranking other tenant')`,
      [tenantId, otherTenantId, `escalation-rank-${suffix}`, `escalation-rank-other-${suffix}`],
    );
    await insertMapping(client, { tenantId });
    await insertMapping(client, {
      tenantId: otherTenantId,
      sourceKind: 'designation',
      sourceValue: 'Duty Doctor',
      normalizedSourceValue: 'duty doctor',
      priorityRank: 2,
    });
  }, 60000);

  afterAll(async () => {
    await client.query('RESET ROLE').catch(() => {});
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('installs exact constraints, index, and forced-RLS posture', async () => {
    const contract = await client.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              ARRAY_AGG(DISTINCT con.conname::text) AS constraints,
              ARRAY_AGG(DISTINCT idx.relname::text) FILTER (WHERE idx.relname IS NOT NULL) AS indexes
         FROM pg_class c
         LEFT JOIN pg_constraint con ON con.conrelid = c.oid
         LEFT JOIN pg_index pi ON pi.indrelid = c.oid
         LEFT JOIN pg_class idx ON idx.oid = pi.indexrelid
        WHERE c.oid = 'escalation_recipient_rank_mappings'::regclass
        GROUP BY c.relrowsecurity, c.relforcerowsecurity`,
    );
    expect(contract.rows[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    expect(contract.rows[0].constraints).toEqual(expect.arrayContaining([
      'chk_escalation_recipient_rank_mappings_tenant',
      'chk_escalation_recipient_rank_mappings_source_kind',
      'chk_escalation_recipient_rank_mappings_normalized_value',
      'chk_escalation_recipient_rank_mappings_priority_rank',
      'uq_escalation_recipient_rank_mappings_source',
    ]));
    expect(contract.rows[0].indexes).toContain(
      'idx_escalation_recipient_rank_mappings_tenant_rank',
    );
  });

  test('rejects sentinel, malformed, noncanonical, out-of-range, and duplicate mappings', async () => {
    await expectFailure(client, () => insertMapping(client, {
      tenantId: '00000000-0000-4000-8000-000000000001',
    }), { code: '23514', constraint: 'chk_escalation_recipient_rank_mappings_tenant' });
    await expectFailure(client, () => insertMapping(client, {
      tenantId, sourceKind: 'grade', sourceValue: 'A', normalizedSourceValue: 'a',
    }), { code: '23514', constraint: 'chk_escalation_recipient_rank_mappings_source_kind' });
    await expectFailure(client, () => insertMapping(client, {
      tenantId, sourceValue: '   ', normalizedSourceValue: '',
    }), { code: '23514', constraint: 'chk_escalation_recipient_rank_mappings_normalized_value' });
    await expectFailure(client, () => insertMapping(client, {
      tenantId, sourceValue: 'Senior   Resident', normalizedSourceValue: 'Senior Resident',
    }), { code: '23514', constraint: 'chk_escalation_recipient_rank_mappings_normalized_value' });
    await expectFailure(client, () => insertMapping(client, {
      tenantId, sourceValue: 'Junior Consultant', normalizedSourceValue: 'junior consultant',
      priorityRank: 101,
    }), { code: '23514', constraint: 'chk_escalation_recipient_rank_mappings_priority_rank' });
    await expectFailure(client, () => insertMapping(client, { tenantId }), {
      code: '23505', constraint: 'uq_escalation_recipient_rank_mappings_source',
    });
  });

  test('grants CRUD but denies schema-shaping privileges to the privileged runtime role', async () => {
    const privileges = await client.query(
      `SELECT has_table_privilege($1::text, 'escalation_recipient_rank_mappings', 'SELECT') AS can_select,
              has_table_privilege($1::text, 'escalation_recipient_rank_mappings', 'INSERT') AS can_insert,
              has_table_privilege($1::text, 'escalation_recipient_rank_mappings', 'UPDATE') AS can_update,
              has_table_privilege($1::text, 'escalation_recipient_rank_mappings', 'DELETE') AS can_delete,
              has_table_privilege($1::text, 'escalation_recipient_rank_mappings', 'TRUNCATE') AS can_truncate,
              has_table_privilege($1::text, 'escalation_recipient_rank_mappings', 'REFERENCES') AS can_reference,
              has_table_privilege($1::text, 'escalation_recipient_rank_mappings', 'TRIGGER') AS can_trigger`,
      [RLS_ROLE],
    );
    expect(privileges.rows[0]).toEqual({
      can_select: true,
      can_insert: true,
      can_update: true,
      can_delete: true,
      can_truncate: false,
      can_reference: false,
      can_trigger: false,
    });
    await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
    await expectFailure(client, () => client.query(
      'TRUNCATE TABLE escalation_recipient_rank_mappings',
    ), { code: '42501' });
    await expectFailure(client, () => client.query(
      'ALTER TABLE escalation_recipient_rank_mappings ADD COLUMN forged_rank integer',
    ), { code: '42501' });
    await client.query('RESET ROLE');
  });

  test('fails closed for absent, empty, bypass, and wrong tenant contexts', async () => {
    await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
    for (const context of [null, '', 'bypass']) {
      await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [context]);
      const visible = await client.query(
        'SELECT COUNT(*)::integer AS count FROM escalation_recipient_rank_mappings',
      );
      expect(visible.rows[0].count).toBe(0);
    }
    await client.query(
      "SELECT set_config('app.current_tenant_id', $1::text, true)",
      [otherTenantId],
    );
    const wrongTenant = await client.query(
      'SELECT tenant_id::text FROM escalation_recipient_rank_mappings ORDER BY tenant_id::text',
    );
    expect(wrongTenant.rows).toEqual([{ tenant_id: otherTenantId }]);
    expect(wrongTenant.rows.some((row) => row.tenant_id === tenantId)).toBe(false);
    await client.query('RESET ROLE');
  });

  test('allows same-tenant CRUD and rejects a forged cross-tenant rank insert', async () => {
    await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
    const visible = await client.query(
      'SELECT normalized_source_value FROM escalation_recipient_rank_mappings ORDER BY normalized_source_value',
    );
    expect(visible.rows).toEqual([{ normalized_source_value: 'senior consultant' }]);
    const crossTenantUpdate = await client.query(
      `UPDATE escalation_recipient_rank_mappings
          SET priority_rank = 99
        WHERE tenant_id = $1::uuid`,
      [otherTenantId],
    );
    const crossTenantDelete = await client.query(
      'DELETE FROM escalation_recipient_rank_mappings WHERE tenant_id = $1::uuid',
      [otherTenantId],
    );
    expect(crossTenantUpdate.rowCount).toBe(0);
    expect(crossTenantDelete.rowCount).toBe(0);
    const inserted = await insertMapping(client, {
      tenantId,
      sourceKind: 'designation',
      sourceValue: 'Medical Officer',
      normalizedSourceValue: 'medical officer',
      priorityRank: 3,
    });
    await client.query(
      `UPDATE escalation_recipient_rank_mappings
          SET priority_rank = 4
        WHERE id = $1::uuid`,
      [inserted.rows[0].id],
    );
    await client.query(
      'DELETE FROM escalation_recipient_rank_mappings WHERE id = $1::uuid',
      [inserted.rows[0].id],
    );
    await expectFailure(client, () => insertMapping(client, {
      tenantId: otherTenantId,
      sourceValue: 'Forged Rank',
      normalizedSourceValue: 'forged rank',
      priorityRank: 1,
    }), { code: '42501' });
    await client.query('RESET ROLE');
  });

  test('preserves configured state when direct SQL makes the observed count disagree', async () => {
    await client.query(
      `UPDATE tenants
          SET settings = jsonb_set(
            settings,
            '{escalation_recipient_ranking}',
            '{"configured":true,"revision":7,"presence_window_minutes":720,"expected_mapping_count":1}'::jsonb,
            TRUE
          )
        WHERE id = $1::uuid`,
      [tenantId],
    );
    await client.query(
      'DELETE FROM escalation_recipient_rank_mappings WHERE tenant_id = $1::uuid',
      [tenantId],
    );
    const proof = await client.query(
      `SELECT (settings #>> '{escalation_recipient_ranking,configured}')::boolean AS configured,
              (settings #>> '{escalation_recipient_ranking,expected_mapping_count}')::integer AS expected,
              (SELECT COUNT(*)::integer
                 FROM escalation_recipient_rank_mappings m
                WHERE m.tenant_id = tenants.id) AS observed
         FROM tenants
        WHERE id = $1::uuid`,
      [tenantId],
    );
    expect(proof.rows[0]).toEqual({ configured: true, expected: 1, observed: 0 });
  });
});
