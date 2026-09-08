import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Client } from 'pg';

import prisma, { ensureTenantRlsRuntimeRoleGrants } from '../lib/prisma.js';

const migration = readFileSync(
  new URL('../migrations/800_restore_maternity_pregnancy_checks.sql', import.meta.url),
  'utf8',
);
const domains = [
  {
    column: 'edd_method',
    values: [null, 'lmp', 'usg', 'mixed'],
    invalid: 'invalid_edd',
    definition: "CHECK (((edd_method IS NULL) OR ((edd_method)::text = ANY ((ARRAY['lmp'::character varying, 'usg'::character varying, 'mixed'::character varying])::text[]))))",
  },
  {
    column: 'booking_status',
    values: ['booked', 'unbooked', 'transferred_in', 'transferred_out'],
    invalid: 'invalid_booking',
    definition: "CHECK (((booking_status)::text = ANY ((ARRAY['booked'::character varying, 'unbooked'::character varying, 'transferred_in'::character varying, 'transferred_out'::character varying])::text[])))",
  },
  {
    column: 'status',
    values: ['ongoing', 'delivered', 'aborted', 'still_birth', 'transferred'],
    invalid: 'invalid_status',
    definition: "CHECK (((status)::text = ANY ((ARRAY['ongoing'::character varying, 'delivered'::character varying, 'aborted'::character varying, 'still_birth'::character varying, 'transferred'::character varying])::text[])))",
  },
];
const constraintName = (column) => `maternity_pregnancies_${column}_check`;

describe('migration 800 pregnancy CHECK restoration', () => {
  const client = new Client({
    connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
  });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const patientUid = randomUUID();
  const previousEnvironment = {};
  let connected = false;
  let transactionStarted = false;

  async function catalog() {
    const result = await client.query(
      `SELECT c.oid::text AS oid, c.conname, c.convalidated,
              pg_get_constraintdef(c.oid, false) AS definition,
              ARRAY(SELECT a.attname::text
                      FROM unnest(c.conkey) WITH ORDINALITY AS k(num, ord)
                      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
                     ORDER BY k.ord) AS columns
         FROM pg_constraint c
        WHERE c.conrelid = 'public.maternity_pregnancies'::regclass
          AND c.contype = 'c' AND c.conname = ANY($1::text[])
        ORDER BY c.conname`,
      [domains.map(({ column }) => constraintName(column))],
    );
    return result.rows;
  }

  async function runtimeCase(action, context = tenantId) {
    await client.query('SAVEPOINT pregnancy_constraint_case');
    try {
      await client.query('SET LOCAL ROLE vhhealth_app');
      await client.query('SET LOCAL row_security = on');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [context]);
      const { rows } = await client.query(
        `SELECT current_user AS runtime_role,
                current_setting('app.current_tenant_id') AS tenant,
                current_setting('row_security') AS row_security,
                r.rolsuper, r.rolbypassrls, c.relowner = r.oid AS owns_table,
                c.relrowsecurity, c.relforcerowsecurity
           FROM pg_roles r CROSS JOIN pg_class c
          WHERE r.rolname = current_user
            AND c.oid = 'public.maternity_pregnancies'::regclass`,
      );
      expect(rows).toEqual([{
        runtime_role: 'vhhealth_app', tenant: context, row_security: 'on',
        rolsuper: false, rolbypassrls: false, owns_table: false,
        relrowsecurity: true, relforcerowsecurity: true,
      }]);
      return await action();
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT pregnancy_constraint_case');
      await client.query('RELEASE SAVEPOINT pregnancy_constraint_case');
    }
  }

  function insertPregnancy(overrides = {}) {
    const values = { edd_method: 'lmp', booking_status: 'booked', status: 'ongoing', ...overrides };
    return client.query(
      `INSERT INTO public.maternity_pregnancies
         (patient_uid, tenant_id, edd_method, booking_status, status)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text)
       RETURNING patient_uid, tenant_id, edd_method, booking_status, status`,
      [patientUid, tenantId, values.edd_method, values.booking_status, values.status],
    );
  }

  beforeAll(async () => {
    expect(domains).toHaveLength(3);
    expect(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL).toBeTruthy();
    for (const key of ['AUTH_ENFORCE_TENANT_RLS', 'AUTH_TENANT_RLS_RUNTIME_ROLE']) {
      previousEnvironment[key] = process.env[key];
    }
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_app';
    expect(await ensureTenantRlsRuntimeRoleGrants()).toEqual({ skipped: false, role: 'vhhealth_app' });
    await client.connect();
    connected = true;
    await client.query('BEGIN');
    transactionStarted = true;
    for (const id of [tenantId, otherTenantId]) {
      await client.query(
        'INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, $3)',
        [id, `pregnancy-check-800-${id}`, 'Synthetic pregnancy constraint test'],
      );
    }
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await client.query(
      `INSERT INTO users (uid, phone, name, role, is_active, is_pregnant, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Synthetic pregnancy constraint patient', 'PATIENT', true, true, $3::uuid, NOW())`,
      [patientUid, `9${String(parseInt(patientUid.replaceAll('-', '').slice(0, 11), 16)).slice(-9).padStart(9, '0')}`, tenantId],
    );
    const positive = await runtimeCase(() => insertPregnancy());
    expect(positive.rows).toEqual([{
      patient_uid: patientUid, tenant_id: tenantId,
      edd_method: 'lmp', booking_status: 'booked', status: 'ongoing',
    }]);
  }, 60_000);

  afterAll(async () => {
    try {
      if (transactionStarted) await client.query('ROLLBACK');
    } finally {
      try {
        if (connected) await client.end();
      } finally {
        for (const [key, value] of Object.entries(previousEnvironment)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await prisma.$disconnect();
      }
    }
  });

  test('all three named CHECKs have the exact deparsed predicates and validated state', async () => {
    const rows = await catalog();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(({ conname }) => conname)).size).toBe(3);
    for (const domain of domains) {
      expect(rows.find(({ conname }) => conname === constraintName(domain.column))).toMatchObject({
        conname: constraintName(domain.column), convalidated: true,
        columns: [domain.column], definition: domain.definition,
      });
    }
  });

  test('replaying the migration preserves every existing CHECK OID and definition', async () => {
    const before = await catalog();
    expect(before).toHaveLength(3);
    const body = migration.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
    expect(body).toContain('DO $$');
    await client.query(body);
    expect(await catalog()).toEqual(before);
  });

  test.each(domains)('$column rejects an invalid non-null INSERT with its own 23514', async (domain) => {
    expect(process.env.AUTH_ENFORCE_TENANT_RLS).toBe('true');
    expect(process.env.AUTH_TENANT_RLS_RUNTIME_ROLE).toBe('vhhealth_app');
    await runtimeCase(async () => {
      await expect(insertPregnancy({ [domain.column]: domain.invalid })).rejects.toMatchObject({
        code: '23514', constraint: constraintName(domain.column), table: 'maternity_pregnancies',
      });
    });
  });

  test.each(domains.flatMap(({ column, values }) => values.map((value) => [column, value])))(
    '%s accepts declared value %s under the tenant runtime role',
    async (column, value) => {
      await runtimeCase(async () => {
        const result = await insertPregnancy({ [column]: value });
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0][column]).toBe(value);
        expect(result.rows[0].tenant_id).toBe(tenantId);
      });
    },
  );

  test.each(['booking_status', 'status'])('%s keeps its separate NOT NULL constraint', async (column) => {
    await runtimeCase(async () => {
      await expect(insertPregnancy({ [column]: null })).rejects.toMatchObject({ code: '23502', column });
    });
  });
});
