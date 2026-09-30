import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Client } from 'pg';

import prisma, { ensureTenantRlsRuntimeRoleGrants } from '../lib/prisma.js';

const migration = readFileSync(
  new URL('../migrations/803_restore_tenant_domain_checks.sql', import.meta.url),
  'utf8',
);
const domains = [
  {
    column: 'region',
    values: ['IN', 'EU', 'US', 'AP', 'OTHER'],
    invalid: 'ZZ',
    definition: "CHECK (((region)::text = ANY ((ARRAY['IN'::character varying, 'EU'::character varying, 'US'::character varying, 'AP'::character varying, 'OTHER'::character varying])::text[])))",
  },
  {
    column: 'compliance_profile',
    values: ['DPDP', 'HIPAA', 'GDPR', 'NONE'],
    invalid: 'SOX',
    definition: "CHECK (((compliance_profile)::text = ANY ((ARRAY['DPDP'::character varying, 'HIPAA'::character varying, 'GDPR'::character varying, 'NONE'::character varying])::text[])))",
  },
  {
    column: 'status',
    values: ['active', 'suspended', 'offboarding'],
    invalid: 'paused',
    definition: "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'suspended'::character varying, 'offboarding'::character varying])::text[])))",
  },
];
const constraintName = ({ column }) => `tenants_${column}_check`;

describe('migration 803 tenant domain CHECK restoration', () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL });
  const originalEnvironment = {};
  const seedId = randomUUID();
  let connected = false;
  let transactionStarted = false;

  async function catalog(relation = 'public.tenants') {
    const { rows } = await client.query(
      `SELECT c.oid::text AS oid, c.conname, c.convalidated,
              pg_get_constraintdef(c.oid, false) AS definition,
              ARRAY(SELECT a.attname::text
                      FROM unnest(c.conkey) WITH ORDINALITY AS k(num, ord)
                      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
                     ORDER BY k.ord) AS columns
         FROM pg_constraint c
        WHERE c.conrelid = $1::regclass AND c.contype = 'c'
          AND c.conname = ANY($2::text[])
        ORDER BY c.conname`,
      [relation, domains.map(constraintName)],
    );
    return rows;
  }

  async function runtimeCase(action, relation = 'public.tenants') {
    await client.query('SAVEPOINT tenant_domain_case');
    try {
      await client.query('SET LOCAL ROLE vhhealth_app');
      await client.query('SET LOCAL row_security = on');
      const { rows } = await client.query(
        `SELECT current_user AS runtime_role, current_setting('row_security') AS row_security,
                r.rolsuper, r.rolbypassrls, c.relowner = r.oid AS owns_table,
                c.relrowsecurity, c.relforcerowsecurity
           FROM pg_roles r CROSS JOIN pg_class c
          WHERE r.rolname = current_user AND c.oid = $1::regclass`,
        [relation],
      );
      expect(rows).toEqual([{
        runtime_role: 'vhhealth_app', row_security: 'on',
        rolsuper: false, rolbypassrls: false, owns_table: false,
        relrowsecurity: false, relforcerowsecurity: false,
      }]);
      return await action();
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT tenant_domain_case');
      await client.query('RELEASE SAVEPOINT tenant_domain_case');
    }
  }

  function insertTenant(overrides = {}) {
    const values = { region: 'IN', compliance_profile: 'DPDP', status: 'active', ...overrides };
    const id = randomUUID();
    return client.query(
      `INSERT INTO public.tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, $2::text, 'Synthetic tenant domain test', $3::text, $4::text, $5::text)
       RETURNING region, compliance_profile, status`,
      [id, `tenant-domain-803-${id}`, values.region, values.compliance_profile, values.status],
    );
  }

  beforeAll(async () => {
    expect(domains).toHaveLength(3);
    expect(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL).toBeTruthy();
    for (const key of ['AUTH_ENFORCE_TENANT_RLS', 'AUTH_TENANT_RLS_RUNTIME_ROLE']) {
      originalEnvironment[key] = process.env[key];
    }
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_app';
    expect(await ensureTenantRlsRuntimeRoleGrants()).toEqual({ skipped: false, role: 'vhhealth_app' });
    await client.connect();
    connected = true;
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query(
      `INSERT INTO public.tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'Synthetic tenant domain replay row')`,
      [seedId, `tenant-domain-803-${seedId}`],
    );
  }, 60_000);

  afterAll(async () => {
    try {
      if (transactionStarted) await client.query('ROLLBACK');
    } finally {
      try {
        if (connected) await client.end();
      } finally {
        for (const [key, value] of Object.entries(originalEnvironment)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await prisma.$disconnect();
      }
    }
  });

  test('all three named CHECKs have their columns, deparsed predicates and validated state', async () => {
    const rows = await catalog();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(({ conname }) => conname)).size).toBe(3);
    for (const domain of domains) {
      expect(rows.find(({ conname }) => conname === constraintName(domain))).toMatchObject({
        conname: constraintName(domain), convalidated: true,
        columns: [domain.column], definition: domain.definition,
      });
    }
  });

  test('migration replay preserves existing CHECK OIDs, definitions and tenant rows', async () => {
    const before = await catalog();
    const rowsBefore = await client.query(
      'SELECT id::text AS id, region, compliance_profile, status FROM public.tenants WHERE id = $1::uuid',
      [seedId],
    );
    expect(before).toHaveLength(3);
    expect(rowsBefore.rows).toEqual([{
      id: seedId, region: 'IN', compliance_profile: 'DPDP', status: 'active',
    }]);
    expect(migration.match(/^BEGIN;\s*$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;\s*$/gm)).toHaveLength(1);
    const body = migration.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
    expect(body).toContain('DO $$');
    await client.query('SAVEPOINT tenant_domain_replay');
    try {
      await client.query(body);
      expect(await catalog()).toEqual(before);
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT tenant_domain_replay');
      await client.query('RELEASE SAVEPOINT tenant_domain_replay');
    }
    expect(await catalog()).toEqual(before);
    expect((await client.query(
      'SELECT id::text AS id, region, compliance_profile, status FROM public.tenants WHERE id = $1::uuid',
      [seedId],
    )).rows).toEqual(rowsBefore.rows);
  });

  test.each(domains)('$column rejects a same-named CHECK with a different predicate', async (domain) => {
    const schema = `tenant_803_${randomUUID().replaceAll('-', '')}`;
    const publicBefore = await catalog();
    await client.query('SAVEPOINT tenant_domain_conflicting_lineage');
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(
        `CREATE TABLE ${schema}.tenants (
          region varchar(10) NOT NULL DEFAULT 'IN',
          compliance_profile varchar(20) NOT NULL DEFAULT 'DPDP',
          status varchar(20) NOT NULL DEFAULT 'active'
        )`,
      );
      await client.query(`INSERT INTO ${schema}.tenants DEFAULT VALUES`);
      await client.query(
        `ALTER TABLE ${schema}.tenants ADD CONSTRAINT ${constraintName(domain)}
         CHECK (${domain.column} <> '${domain.invalid}') NOT VALID`,
      );
      const before = await catalog(`${schema}.tenants`);
      expect(before).toHaveLength(1);
      const body = migration.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '')
        .replaceAll('public.tenants', `${schema}.tenants`);
      await client.query('SAVEPOINT tenant_domain_conflicting_apply');
      try {
        await expect(client.query(body)).rejects.toMatchObject({
          code: 'P0001',
          message: expect.stringContaining('different predicate; operator review required'),
        });
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT tenant_domain_conflicting_apply');
        await client.query('RELEASE SAVEPOINT tenant_domain_conflicting_apply');
      }
      expect(await catalog(`${schema}.tenants`)).toEqual(before);
      expect((await client.query(`SELECT count(*)::int AS rows FROM ${schema}.tenants`)).rows).toEqual([{ rows: 1 }]);
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT tenant_domain_conflicting_lineage');
      await client.query('RELEASE SAVEPOINT tenant_domain_conflicting_lineage');
    }
    expect(await catalog()).toEqual(publicBefore);
  });

  test.each(domains)('$column rejects $invalid with its own 23514 under the runtime role', async (domain) => {
    expect(process.env.AUTH_ENFORCE_TENANT_RLS).toBe('true');
    expect(process.env.AUTH_TENANT_RLS_RUNTIME_ROLE).toBe('vhhealth_app');
    await runtimeCase(async () => {
      await expect(insertTenant({ [domain.column]: domain.invalid })).rejects.toMatchObject({
        code: '23514', constraint: constraintName(domain), table: 'tenants',
      });
    });
  });

  test.each(domains.flatMap(domain => domain.values.map(value => ({ domain, value }))))(
    '$domain.column accepts $value under the runtime role',
    async ({ domain, value }) => {
      await runtimeCase(async () => {
        const result = await insertTenant({ [domain.column]: value });
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0][domain.column]).toBe(value);
      });
    },
  );

  test('tenant defaults remain valid under the runtime role', async () => {
    await runtimeCase(async () => {
      const id = randomUUID();
      const { rows } = await client.query(
        `INSERT INTO public.tenants (id, slug, name)
         VALUES ($1::uuid, $2::text, 'Synthetic tenant default test')
         RETURNING region, compliance_profile, status`,
        [id, `tenant-default-803-${id}`],
      );
      expect(rows).toEqual([{ region: 'IN', compliance_profile: 'DPDP', status: 'active' }]);
    });
  });

  test.each(domains)('$column retains its independent NOT NULL constraint', async (domain) => {
    await runtimeCase(async () => {
      await expect(insertTenant({ [domain.column]: null })).rejects.toMatchObject({
        code: '23502', column: domain.column, table: 'tenants',
      });
    });
  });

  test.each([
    { label: 'missing CHECKs on clean records', invalid: null, existing: false },
    { label: 'already validated CHECKs', invalid: null, existing: true },
    ...domains.flatMap(invalid => [false, true].map(existing => ({
      label: `${existing ? 'existing' : 'missing'} CHECK with historical ${invalid.column}`,
      invalid, existing,
    }))),
  ])('$label preserves historical rows and enforces inserts and unrelated updates', async ({ invalid, existing }) => {
    const schema = `tenant_803_${randomUUID().replaceAll('-', '')}`;
    expect(schema).toMatch(/^tenant_803_[a-f0-9]{32}$/);
    const publicBefore = await catalog();
    const notices = [];
    const onNotice = notice => notices.push(notice.message);
    await client.query('SAVEPOINT tenant_domain_lineage');
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(
        `CREATE TABLE ${schema}.tenants (
          name text NOT NULL DEFAULT 'Synthetic historical tenant',
          region varchar(10) NOT NULL DEFAULT 'IN',
          compliance_profile varchar(20) NOT NULL DEFAULT 'DPDP',
          status varchar(20) NOT NULL DEFAULT 'active'
        )`,
      );
      await client.query(
        `INSERT INTO ${schema}.tenants (region, compliance_profile, status)
         VALUES ($1::text, $2::text, $3::text)`,
        [invalid?.column === 'region' ? invalid.invalid : 'IN',
          invalid?.column === 'compliance_profile' ? invalid.invalid : 'DPDP',
          invalid?.column === 'status' ? invalid.invalid : 'active'],
      );
      const readRows = async () => (await client.query(
        `SELECT name, region, compliance_profile, status FROM ${schema}.tenants`,
      )).rows;
      const beforeRows = await readRows();
      expect(beforeRows).toHaveLength(1);
      if (existing) {
        for (const domain of domains) {
          const predicate = `${domain.column} IN (${domain.values.map(value => `'${value}'`).join(', ')})`;
          await client.query(
            `ALTER TABLE ${schema}.tenants ADD CONSTRAINT ${constraintName(domain)}
             CHECK (${predicate}) NOT VALID`,
          );
          if (domain !== invalid) {
            await client.query(`ALTER TABLE ${schema}.tenants VALIDATE CONSTRAINT ${constraintName(domain)}`);
          }
        }
      }
      const before = await catalog(`${schema}.tenants`);
      expect(before).toHaveLength(existing ? 3 : 0);
      const body = migration.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
      expect(body).toContain('public.tenants');
      const lineageBody = body.replaceAll('public.tenants', `${schema}.tenants`);
      expect(lineageBody).not.toContain('public.tenants');
      client.on('notice', onNotice);
      await client.query(lineageBody);
      client.off('notice', onNotice);
      const after = await catalog(`${schema}.tenants`);
      expect(after).toHaveLength(3);
      for (const domain of domains) {
        const check = after.find(({ conname }) => conname === constraintName(domain));
        expect(check).toMatchObject({
          conname: constraintName(domain), columns: [domain.column],
          convalidated: domain !== invalid,
        });
        expect(check.definition.replace(/ NOT VALID$/, '')).toBe(domain.definition);
        if (existing) {
          const original = before.find(({ conname }) => conname === constraintName(domain));
          expect(check.oid).toBe(original.oid);
          expect(check.definition).toBe(original.definition);
        }
      }
      expect(await readRows()).toEqual(beforeRows);
      if (invalid) {
        expect(notices.some(message => message.includes(`${invalid.column}=1`))).toBe(true);
      } else {
        expect(notices).toHaveLength(0);
      }
      await client.query(`GRANT USAGE ON SCHEMA ${schema} TO vhhealth_app`);
      await client.query(`GRANT SELECT, UPDATE ON ${schema}.tenants TO vhhealth_app`);
      await runtimeCase(async () => {
        const update = client.query(
          `UPDATE ${schema}.tenants SET name = $1::text
           RETURNING name, region, compliance_profile, status`,
          ['Synthetic renamed tenant'],
        );
        if (invalid) {
          await expect(update).rejects.toMatchObject({
            code: '23514', constraint: constraintName(invalid), table: 'tenants', schema,
          });
        } else {
          const result = await update;
          expect(result.rowCount).toBe(1);
          expect(result.rows).toEqual([{ ...beforeRows[0], name: 'Synthetic renamed tenant' }]);
        }
      }, `${schema}.tenants`);
      expect(await readRows()).toEqual(beforeRows);
      expect(await catalog(`${schema}.tenants`)).toEqual(after);
      for (const domain of domains) {
        await client.query('SAVEPOINT tenant_lineage_invalid');
        await expect(client.query(
          `INSERT INTO ${schema}.tenants (${domain.column}) VALUES ($1::text)`, [domain.invalid],
        )).rejects.toMatchObject({
          code: '23514', constraint: constraintName(domain), table: 'tenants',
        });
        await client.query('ROLLBACK TO SAVEPOINT tenant_lineage_invalid');
        await client.query('RELEASE SAVEPOINT tenant_lineage_invalid');
      }
      await client.query(lineageBody);
      expect(await catalog(`${schema}.tenants`)).toEqual(after);
      expect(await readRows()).toEqual(beforeRows);
    } finally {
      client.off('notice', onNotice);
      await client.query('ROLLBACK TO SAVEPOINT tenant_domain_lineage');
      await client.query('RELEASE SAVEPOINT tenant_domain_lineage');
    }
    expect((await client.query('SELECT to_regnamespace($1)::text AS schema', [schema])).rows).toEqual([{ schema: null }]);
    expect(await catalog()).toEqual(publicBefore);
  });
});
