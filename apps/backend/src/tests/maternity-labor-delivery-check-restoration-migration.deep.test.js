import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import prisma, { ensureTenantRlsRuntimeRoleGrants } from '../lib/prisma.js';

const migration = readFileSync(
  new URL('../migrations/801_restore_maternity_labor_delivery_checks.sql', import.meta.url), 'utf8',
);
const widthMigration = readFileSync(
  new URL('../migrations/802_widen_maternity_labor_status.sql', import.meta.url), 'utf8',
);
const domains = [
  {
    table: 'maternity_labor_admissions', column: 'admission_reason', invalid: 'invalid_reason',
    values: [null, 'spontaneous_labour', 'induction', 'elective_lscs', 'pprom', 'reduced_fm', 'postdated', 'other'],
    definition: "CHECK (((admission_reason IS NULL) OR ((admission_reason)::text = ANY ((ARRAY['spontaneous_labour'::character varying, 'induction'::character varying, 'elective_lscs'::character varying, 'pprom'::character varying, 'reduced_fm'::character varying, 'postdated'::character varying, 'other'::character varying])::text[]))))",
  },
  {
    table: 'maternity_labor_admissions', column: 'status', invalid: 'invalid_status',
    values: ['active', 'delivered', 'transferred', 'discharged_undelivered'],
    definition: "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'delivered'::character varying, 'transferred'::character varying, 'discharged_undelivered'::character varying])::text[])))",
  },
  {
    table: 'maternity_partograph_entries', column: 'descent_fifths_above_brim', invalid: 6,
    values: [null, 0, 1, 2, 3, 4, 5],
    definition: 'CHECK (((descent_fifths_above_brim >= 0) AND (descent_fifths_above_brim <= 5)))',
  },
  {
    table: 'maternity_partograph_entries', column: 'contractions_intensity', invalid: 'invalid',
    values: [null, 'weak', 'moderate', 'strong'],
    definition: "CHECK (((contractions_intensity IS NULL) OR ((contractions_intensity)::text = ANY ((ARRAY['weak'::character varying, 'moderate'::character varying, 'strong'::character varying])::text[]))))",
  },
  {
    table: 'maternity_deliveries', column: 'delivery_mode', invalid: 'invalid_mode',
    values: ['nvd', 'lscs_emergency', 'lscs_elective', 'instrumental_forceps', 'instrumental_vacuum', 'breech', 'destructive', 'other'],
    definition: "CHECK (((delivery_mode)::text = ANY ((ARRAY['nvd'::character varying, 'lscs_emergency'::character varying, 'lscs_elective'::character varying, 'instrumental_forceps'::character varying, 'instrumental_vacuum'::character varying, 'breech'::character varying, 'destructive'::character varying, 'other'::character varying])::text[])))",
  },
];
const constraintName = ({ table, column }) => `${table}_${column}_check`;
const widenedStatusDefinition = "CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('delivered'::character varying)::text, ('transferred'::character varying)::text, ('discharged_undelivered'::character varying)::text])))";

describe('migration 801 labour and delivery CHECK restoration', () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const patientUid = randomUUID();
  const originalEnvironment = {};
  let connected = false;
  let transactionStarted = false;
  let pregnancyId;
  let laborId;

  async function catalog() {
    const { rows } = await client.query(
      `SELECT c.oid::text AS oid, c.conname, c.convalidated,
              pg_get_constraintdef(c.oid, false) AS definition
         FROM pg_constraint c WHERE c.contype='c'
          AND c.connamespace='public'::regnamespace AND c.conname=ANY($1::text[])
        ORDER BY c.conname`, [domains.map(constraintName)],
    );
    return rows;
  }

  async function maternityRows() {
    const rows = [];
    for (const table of [...new Set(domains.map(domain => domain.table))]) {
      const result = await client.query(`SELECT to_jsonb(t) AS record FROM public.${table} t ORDER BY id`);
      rows.push({ table, records: result.rows });
    }
    expect(rows).toHaveLength(3);
    expect(rows.find(row => row.table === 'maternity_labor_admissions').records.length).toBeGreaterThan(0);
    return rows;
  }

  async function runtimeCase(table, action, context = tenantId) {
    await client.query('SAVEPOINT maternity_domain_case');
    try {
      await client.query('SET LOCAL ROLE vhhealth_app');
      await client.query('SET LOCAL row_security = on');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [context]);
      const { rows } = await client.query(
        `SELECT current_user AS role, current_setting('app.current_tenant_id') AS tenant,
                r.rolsuper, r.rolbypassrls, c.relowner=r.oid AS owns_table,
                c.relrowsecurity, c.relforcerowsecurity
           FROM pg_roles r CROSS JOIN pg_class c
          WHERE r.rolname=current_user AND c.oid=$1::regclass`, [`public.${table}`],
      );
      expect(rows).toEqual([{
        role: 'vhhealth_app', tenant: context, rolsuper: false, rolbypassrls: false,
        owns_table: false, relrowsecurity: true, relforcerowsecurity: true,
      }]);
      return await action();
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT maternity_domain_case');
      await client.query('RELEASE SAVEPOINT maternity_domain_case');
    }
  }

  function insert(domain, value) {
    if (domain.table === 'maternity_labor_admissions') {
      return client.query(
        `INSERT INTO public.maternity_labor_admissions (pregnancy_id,tenant_id,admission_reason,status)
         VALUES ($1::int,$2::uuid,$3::text,$4::text) RETURNING *`,
        [pregnancyId, tenantId, domain.column === 'admission_reason' ? value : null,
          domain.column === 'status' ? value : 'active'],
      );
    }
    if (domain.table === 'maternity_partograph_entries') {
      return client.query(
        `INSERT INTO public.maternity_partograph_entries
         (labor_admission_id,tenant_id,descent_fifths_above_brim,contractions_intensity)
         VALUES ($1::int,$2::uuid,$3::int,$4::text) RETURNING *`,
        [laborId, tenantId, domain.column === 'descent_fifths_above_brim' ? value : null,
          domain.column === 'contractions_intensity' ? value : null],
      );
    }
    return client.query(
      `INSERT INTO public.maternity_deliveries (pregnancy_id,tenant_id,delivery_datetime,delivery_mode)
       VALUES ($1::int,$2::uuid,'2026-09-16T00:00:00Z'::timestamptz,$3::text) RETURNING *`,
      [pregnancyId, tenantId, value],
    );
  }

  beforeAll(async () => {
    expect(domains).toHaveLength(5);
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
    for (const id of [tenantId, otherTenantId]) {
      await client.query('INSERT INTO tenants(id,slug,name) VALUES ($1::uuid,$2,$3)',
        [id, `maternity-check-801-${id}`, 'Synthetic maternity domain test']);
    }
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await client.query(
      `INSERT INTO users(uid,phone,name,role,is_active,is_pregnant,tenant_id,updated_at)
       VALUES ($1::uuid,$2,'Synthetic maternity domain patient','PATIENT',true,true,$3::uuid,NOW())`,
      [patientUid, `9${String(parseInt(patientUid.replaceAll('-', '').slice(0, 11), 16)).slice(-9).padStart(9, '0')}`, tenantId],
    );
    const pregnancy = await client.query(
      `INSERT INTO maternity_pregnancies(patient_uid,tenant_id,booking_status,status)
       VALUES ($1::uuid,$2::uuid,'booked','ongoing') RETURNING id`, [patientUid, tenantId],
    );
    pregnancyId = pregnancy.rows[0].id;
    const labor = await client.query(
      'INSERT INTO maternity_labor_admissions(pregnancy_id,tenant_id) VALUES ($1::int,$2::uuid) RETURNING id',
      [pregnancyId, tenantId],
    );
    laborId = labor.rows[0].id;
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

  test('all five named constraints carry their exact deparsed domains', async () => {
    const rows = await catalog();
    expect(rows).toHaveLength(5);
    for (const domain of domains) {
      const row = rows.find(item => item.conname === constraintName(domain));
      expect(row).toBeDefined();
      expect(row.definition.replace(/ NOT VALID$/, '')).toBe(domain.column === 'status' ? widenedStatusDefinition : domain.definition);
      if (domain.column !== 'delivery_mode') expect(row.convalidated).toBe(true);
    }
  });

  test('migration 802 represents every declared status and matches the Prisma width', async () => {
    const { rows } = await client.query(
      `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
        WHERE attrelid='public.maternity_labor_admissions'::regclass
          AND attname='status' AND attnum>0 AND NOT attisdropped`,
    );
    expect(rows).toEqual([{ type: 'character varying(22)' }]);
    const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
    const model = schema.match(/model maternity_labor_admissions \{([\s\S]*?)\n\}/);
    expect(model).not.toBeNull();
    expect(model[1]).toMatch(/status\s+String\s+@default\("active"\) @db\.VarChar\(22\)/);
  });

  test.each([
    { type: 'varchar(20)', expected: 'character varying(22)', historical: 'active', validated: true },
    { type: 'varchar(20)', expected: 'character varying(22)', historical: 'legacy_status', validated: false },
    { type: 'varchar(22)', expected: 'character varying(22)', historical: 'active', validated: true },
    { type: 'varchar(30)', expected: 'character varying(30)', historical: 'long_historical_status_value', validated: false },
    { type: 'varchar', expected: 'character varying', historical: 'long_historical_status_value', validated: false },
    { type: 'text', expected: 'text', historical: 'long_historical_status_value', validated: false },
  ])('migration 802 preserves $type lineage and validation=$validated', async ({ type, expected, historical, validated }) => {
    const schema = `maternity_802_${randomUUID().replaceAll('-', '')}`;
    expect(schema).toMatch(/^maternity_802_[a-f0-9]{32}$/);
    const publicBefore = await catalog();
    const recordsBefore = await maternityRows();
    await client.query('SAVEPOINT maternity_width_lineage');
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`CREATE TABLE ${schema}.maternity_labor_admissions (status ${type} NOT NULL DEFAULT 'active')`);
      await client.query(`INSERT INTO ${schema}.maternity_labor_admissions(status) VALUES ($1)`, [historical]);
      await client.query(`ALTER TABLE ${schema}.maternity_labor_admissions
        ADD CONSTRAINT maternity_labor_admissions_status_check
        CHECK (status IN ('active','delivered','transferred','discharged_undelivered')) NOT VALID`);
      if (validated) await client.query(`ALTER TABLE ${schema}.maternity_labor_admissions VALIDATE CONSTRAINT maternity_labor_admissions_status_check`);
      const readCheck = async () => (await client.query(
        `SELECT oid::text AS oid, conname, convalidated, pg_get_constraintdef(oid, false) AS definition
           FROM pg_constraint WHERE conrelid=$1::regclass AND contype='c'`, [`${schema}.maternity_labor_admissions`],
      )).rows;
      const before = await readCheck();
      expect(before).toHaveLength(1);
      expect(widthMigration.match(/^BEGIN;\s*$/gm)).toHaveLength(1);
      expect(widthMigration.match(/^COMMIT;\s*$/gm)).toHaveLength(1);
      let body = widthMigration.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
      expect(body.match(/public\.maternity_labor_admissions/g)).toHaveLength(2);
      body = body.replaceAll('public.maternity_labor_admissions', `${schema}.maternity_labor_admissions`);
      expect(body).not.toContain('public.');
      await client.query(body);
      expect((await client.query(
        `SELECT format_type(atttypid, atttypmod) AS type, attnotnull FROM pg_attribute
          WHERE attrelid=$1::regclass AND attname='status' AND NOT attisdropped`, [`${schema}.maternity_labor_admissions`],
      )).rows).toEqual([{ type: expected, attnotnull: true }]);
      const after = await readCheck();
      expect(after).toHaveLength(1);
      const expectedDefinition = type === 'varchar(20)'
        ? `${widenedStatusDefinition}${validated ? '' : ' NOT VALID'}` : before[0].definition;
      expect(after[0]).toMatchObject({ conname: before[0].conname, convalidated: validated, definition: expectedDefinition });
      const expression = definition => definition.replace(/^CHECK /, '').replace(/ NOT VALID$/, '');
      const candidates = [...domains.find(domain => domain.column === 'status').values, 'invalid_status', historical, '', null];
      const { rows: meanings } = await client.query(
        `SELECT status, ${expression(before[0].definition)} AS before, ${expression(after[0].definition)} AS after
           FROM unnest($1::text[]) AS input(status)`, [candidates],
      );
      expect(meanings).toHaveLength(candidates.length);
      for (const row of meanings) expect(row.after).toBe(row.before);
      expect((await client.query(`SELECT status FROM ${schema}.maternity_labor_admissions`)).rows).toEqual([{ status: historical }]);
      for (const status of domains.find(domain => domain.column === 'status').values) {
        expect((await client.query(`INSERT INTO ${schema}.maternity_labor_admissions(status) VALUES ($1) RETURNING status`, [status])).rows).toEqual([{ status }]);
      }
      expect((await client.query(`INSERT INTO ${schema}.maternity_labor_admissions DEFAULT VALUES RETURNING status`)).rows).toEqual([{ status: 'active' }]);
      await client.query('SAVEPOINT maternity_width_invalid');
      await expect(client.query(`INSERT INTO ${schema}.maternity_labor_admissions(status) VALUES ('invalid_status')`))
        .rejects.toMatchObject({ code: '23514', constraint: 'maternity_labor_admissions_status_check' });
      await client.query('ROLLBACK TO SAVEPOINT maternity_width_invalid');
      await client.query('RELEASE SAVEPOINT maternity_width_invalid');
      await client.query(body);
      expect(await readCheck()).toEqual(after);
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT maternity_width_lineage');
      await client.query('RELEASE SAVEPOINT maternity_width_lineage');
    }
    expect((await client.query('SELECT to_regnamespace($1)::text AS schema', [schema])).rows).toEqual([{ schema: null }]);
    expect(await catalog()).toEqual(publicBefore);
    expect(await maternityRows()).toEqual(recordsBefore);
  });

  test('migration replay preserves existing constraint OIDs, definitions and validation state', async () => {
    const before = await catalog();
    const recordsBefore = await maternityRows();
    expect(before).toHaveLength(5);
    const body = migration.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
    expect(body).toContain('DO $$');
    await client.query(body);
    expect(await catalog()).toEqual(before);
    expect(await maternityRows()).toEqual(recordsBefore);
  });

  // Domain-only projections exercise older lineages without removing public constraints.
  test.each([
    { label: 'missing checks on clean records', invalidDomain: null, existing: false },
    { label: 'already validated checks', invalidDomain: null, existing: true },
    ...domains.flatMap(domain => [false, true].map(existing => ({
      label: `${existing ? 'existing' : 'missing'} check with historical ${domain.column}`,
      invalidDomain: domain, existing,
    }))),
  ])('$label preserves records and enforces new writes', async ({ invalidDomain, existing }) => {
    const schema = `maternity_801_${randomUUID().replaceAll('-', '')}`;
    expect(schema).toMatch(/^maternity_801_[a-f0-9]{32}$/);
    const publicBefore = await catalog();
    const recordsBefore = await maternityRows();
    const tables = [...new Set(domains.map(domain => domain.table))];
    const notices = [];
    const onNotice = notice => notices.push(notice.message);
    await client.query('SAVEPOINT maternity_domain_lineage');
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      for (const table of tables) {
        const columns = domains.filter(domain => domain.table === table).map(domain => domain.column);
        const { rows } = await client.query(
          `SELECT attname, format_type(atttypid, atttypmod) AS type
             FROM pg_attribute
            WHERE attrelid=$1::regclass AND attname=ANY($2::text[])
              AND attnum>0 AND NOT attisdropped ORDER BY attname`,
          [`public.${table}`, columns],
        );
        expect(rows).toHaveLength(columns.length);
        for (const row of rows) expect(row.type).toMatch(/^(character varying\(\d+\)|integer|smallint)$/);
        await client.query(`CREATE TABLE ${schema}.${table} (${rows.map(row => `${row.attname} ${row.type}`).join(', ')})`);
      }
      await client.query(`INSERT INTO ${schema}.maternity_labor_admissions (admission_reason,status) VALUES ('spontaneous_labour','active')`);
      await client.query(`INSERT INTO ${schema}.maternity_partograph_entries (contractions_intensity,descent_fifths_above_brim) VALUES ('moderate',2)`);
      await client.query(`INSERT INTO ${schema}.maternity_deliveries (delivery_mode) VALUES ('nvd')`);
      if (invalidDomain) {
        await client.query(
          `UPDATE ${schema}.${invalidDomain.table} SET ${invalidDomain.column}=$1`, [invalidDomain.invalid],
        );
      }
      const readRows = async () => {
        const records = [];
        for (const table of tables) {
          const result = await client.query(`SELECT to_jsonb(t) AS record FROM ${schema}.${table} t`);
          expect(result.rows).toHaveLength(1);
          records.push({ table, records: result.rows });
        }
        return records;
      };
      const readChecks = async () => (await client.query(
        `SELECT oid::text AS oid, conname, convalidated, pg_get_constraintdef(oid, false) AS definition
           FROM pg_constraint WHERE connamespace=$1::regnamespace AND contype='c' ORDER BY conname`,
        [schema],
      )).rows;
      if (existing) {
        for (const domain of domains) {
          const predicate = domain.column === 'descent_fifths_above_brim'
            ? `${domain.column} BETWEEN 0 AND 5`
            : `${domain.values.includes(null) ? `${domain.column} IS NULL OR ` : ''}${domain.column} IN (${domain.values.filter(value => value !== null).map(value => `'${value}'`).join(', ')})`;
          await client.query(
            `ALTER TABLE ${schema}.${domain.table} ADD CONSTRAINT ${constraintName(domain)} CHECK (${predicate}) NOT VALID`,
          );
          if (domain !== invalidDomain) {
            await client.query(`ALTER TABLE ${schema}.${domain.table} VALIDATE CONSTRAINT ${constraintName(domain)}`);
          }
        }
      }
      const before = await readRows();
      const checksBefore = await readChecks();
      expect(checksBefore).toHaveLength(existing ? 5 : 0);
      if (existing) {
        for (const domain of domains) {
          expect(checksBefore.find(check => check.conname === constraintName(domain)).definition.replace(/ NOT VALID$/, '')).toBe(domain.definition);
        }
      }
      expect(migration.match(/^BEGIN;\s*$/gm)).toHaveLength(1);
      expect(migration.match(/^COMMIT;\s*$/gm)).toHaveLength(1);
      let body = migration.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
      for (const table of tables) {
        expect(body).toContain(`public.${table}`);
        body = body.replaceAll(`public.${table}`, `${schema}.${table}`);
      }
      expect(body).not.toContain('public.');
      expect(body).toContain('DO $$');
      client.on('notice', onNotice);
      await client.query(body);
      client.off('notice', onNotice);
      const after = await readChecks();
      expect(after).toHaveLength(5);
      for (const domain of domains) {
        const row = after.find(check => check.conname === constraintName(domain));
        expect(row.definition.replace(/ NOT VALID$/, '')).toBe(domain.definition);
        expect(row.convalidated).toBe(domain !== invalidDomain && (existing || domain.column !== 'delivery_mode'));
      }
      if (existing) expect(after).toEqual(checksBefore);
      if (invalidDomain) {
        expect(notices.some(message => message.includes('no records changed'))).toBe(true);
        const field = {
          admission_reason: 'admission_reason', status: 'status',
          descent_fifths_above_brim: 'descent', contractions_intensity: 'contractions_intensity',
          delivery_mode: 'historical violations',
        }[invalidDomain.column];
        expect(notices.some(message => message.includes(`${field}=1`))).toBe(true);
      }
      expect(await readRows()).toEqual(before);
      for (const domain of domains) {
        await client.query('SAVEPOINT lineage_invalid_write');
        await expect(client.query(
          `INSERT INTO ${schema}.${domain.table} (${domain.column}) VALUES ($1)`, [domain.invalid],
        )).rejects.toMatchObject({ code: '23514', constraint: constraintName(domain), table: domain.table });
        await client.query('ROLLBACK TO SAVEPOINT lineage_invalid_write');
        await client.query('RELEASE SAVEPOINT lineage_invalid_write');
      }
      await client.query(body);
      expect(await readChecks()).toEqual(after);
      expect(await readRows()).toEqual(before);
    } finally {
      client.off('notice', onNotice);
      await client.query('ROLLBACK TO SAVEPOINT maternity_domain_lineage');
      await client.query('RELEASE SAVEPOINT maternity_domain_lineage');
    }
    expect((await client.query('SELECT to_regnamespace($1)::text AS schema', [schema])).rows).toEqual([{ schema: null }]);
    expect(await catalog()).toEqual(publicBefore);
    expect(await maternityRows()).toEqual(recordsBefore);
  });

  test.each(domains)('$table.$column rejects an invalid INSERT with its named 23514', async (domain) => {
    expect(process.env.AUTH_ENFORCE_TENANT_RLS).toBe('true');
    expect(process.env.AUTH_TENANT_RLS_RUNTIME_ROLE).toBe('vhhealth_app');
    await runtimeCase(domain.table, async () => {
      await expect(insert(domain, domain.invalid)).rejects.toMatchObject({
        code: '23514', constraint: constraintName(domain), table: domain.table,
      });
    });
  });

  test.each(domains.flatMap(domain => domain.values.map(value => ({ domain, value }))))(
    '$domain.column accepts $value under the tenant runtime role', async ({ domain, value }) => {
      await runtimeCase(domain.table, async () => {
        const result = await insert(domain, value);
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0][domain.column]).toBe(value);
        expect(result.rows[0].tenant_id).toBe(tenantId);
      });
    },
  );

  test.each(domains)('$table.$column does not permit another tenant to INSERT valid data', async (domain) => {
    await runtimeCase(domain.table, async () => {
      await expect(insert(domain, domain.values.at(-1))).rejects.toMatchObject({ code: '42501' });
    }, otherTenantId);
  });
});
