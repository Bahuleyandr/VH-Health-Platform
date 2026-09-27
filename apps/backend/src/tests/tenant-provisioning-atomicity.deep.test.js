import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const originalEnv = Object.fromEntries(
  ['DATABASE_URL', 'DATABASE_READ_URL', 'ALLOW_DEFAULT_TENANT', 'AUTH_ENFORCE_TENANT_RLS', 'AUTH_TENANT_RLS_RUNTIME_ROLE', 'AUTH_TENANT_RLS_TEST_ROLE']
    .map(key => [key, process.env[key]]),
);
const ownerDatabaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const applicationUrl = new URL(ownerDatabaseUrl);
applicationUrl.searchParams.set('options', [applicationUrl.searchParams.get('options'), '-c role=vhhealth_app'].filter(Boolean).join(' '));
process.env.DATABASE_URL = applicationUrl.toString();
process.env.DATABASE_READ_URL = applicationUrl.toString();
process.env.ALLOW_DEFAULT_TENANT = 'false';
process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_app';
delete process.env.AUTH_TENANT_RLS_TEST_ROLE;

const { default: prisma, prismaReadOnly, pinSessionTimeZoneToUrl } = await import('../lib/prisma.js');
const { createTenant } = await import('../services/tenant/tenantService.js');
const { DEFAULT_TENANT_ID, TENANT_PROVISIONING_REGISTRY } = await import('../services/tenant/tenantProvisioningRegistry.js');
const { getCurrentTenantContext, runInTenantContext, runWithSuperAdmin } = await import('../lib/tenantContext.js');

const projections = {
  radiology_tat_thresholds: ['priority', 'modality', 'target_minutes', 'warning_minutes', 'critical_minutes', 'metadata'],
  ap_tat_thresholds: ['case_kind', 'priority', 'target_hours', 'is_active'],
  workflow_sla_rules: ['rule_code', 'title', 'trigger_event_type', 'target_minutes', 'severity', 'owner_role_codes', 'escalation_role_codes', 'enabled', 'metadata'],
};
const copiedTables = Object.keys(projections);
const excludedTables = ['lab_critical_thresholds', 'escalation_rules'];
const stages = ['tenant_entitlements', ...copiedTables];
const childTables = [...stages, ...excludedTables];
const owner = new pg.Client({ connectionString: pinSessionTimeZoneToUrl(ownerDatabaseUrl) });
const actingTenantId = randomUUID();
const actingSlug = `atomicity-actor-${randomUUID()}`;
const baseline = {};
let ownerConnected = false;

async function projectedRows(table, tenantId, columns = projections[table]) {
  return (await owner.query(
    `SELECT ${columns.join(', ')} FROM public.${table} WHERE tenant_id = $1::uuid ORDER BY id`,
    [tenantId],
  )).rows;
}

function canonicalRows(rows) {
  return rows.map(row => JSON.stringify(row)).sort();
}

async function assertPopulation() {
  expect(TENANT_PROVISIONING_REGISTRY.map(({ table, columns }) => ({ table, columns })))
    .toEqual(Object.entries(projections).map(([table, columns]) => ({ table, columns })));
  expect((await owner.query('SELECT id FROM tenants WHERE id = $1::uuid', [DEFAULT_TENANT_ID])).rows)
    .toEqual([{ id: DEFAULT_TENANT_ID }]);
  for (const table of copiedTables) {
    const rows = await projectedRows(table, DEFAULT_TENANT_ID);
    expect(rows.length).toBeGreaterThan(0);
    if (baseline[table]) expect(canonicalRows(rows)).toEqual(canonicalRows(baseline[table]));
    else baseline[table] = rows;
  }
}

async function assertRuntimeAndPolicies() {
  expect(process.env.AUTH_ENFORCE_TENANT_RLS).toBe('true');
  expect(await prisma.$queryRawUnsafe(
    `SELECT current_user::text AS role, rolsuper, rolbypassrls, rolcanlogin,
            rolcreatedb, rolcreaterole, rolreplication
       FROM pg_roles WHERE rolname = current_user`,
  )).toEqual([{
    role: 'vhhealth_app', rolsuper: false, rolbypassrls: false, rolcanlogin: false,
    rolcreatedb: false, rolcreaterole: false, rolreplication: false,
  }]);
  const tables = (await owner.query(
    `SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS owner,
            c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[])`,
    [['tenants', ...childTables]],
  )).rows;
  expect(tables.map(row => row.table_name).sort()).toEqual(['tenants', ...childTables].sort());
  for (const table of tables) {
    expect(table.owner).not.toBe('vhhealth_app');
    if (table.table_name !== 'tenants') {
      expect(table).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    }
  }
  const policies = (await owner.query(
    `SELECT tablename, policyname, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ANY($1::text[]) AND policyname = 'tenant_isolation'`,
    [childTables],
  )).rows;
  expect(policies.map(row => row.tablename).sort()).toEqual([...childTables].sort());
  for (const policy of policies) {
    expect(policy.qual).toContain('app.current_tenant_id');
    expect(policy.with_check).toContain('app.current_tenant_id');
  }
}

async function inCaller(mode, operation) {
  expect(getCurrentTenantContext()).toBeNull();
  try {
    return await runInTenantContext(actingTenantId, async () => {
      const caller = getCurrentTenantContext();
      try {
        if (mode === 'superAdmin control') {
          return await runWithSuperAdmin(async () => {
            const control = getCurrentTenantContext();
            try {
              return await operation();
            } finally {
              expect(getCurrentTenantContext()).toBe(control);
            }
          });
        }
        return await operation();
      } finally {
        expect(getCurrentTenantContext()).toBe(caller);
        expect(await prisma.$queryRawUnsafe(
          "SELECT current_user::text AS role, current_setting('app.current_tenant_id', true) AS tenant_id",
        )).toEqual([{ role: 'vhhealth_app', tenant_id: actingTenantId }]);
        expect(getCurrentTenantContext()).toBe(caller);
      }
    });
  } finally {
    expect(getCurrentTenantContext()).toBeNull();
  }
}

async function assertProvisioned(fixture, tenant) {
  expect(tenant).toMatchObject({ slug: fixture.slug, name: fixture.slug, region: 'IN', compliance_profile: 'DPDP' });
  expect(tenant.id).not.toBe(actingTenantId);
  expect(tenant.id).not.toBe(DEFAULT_TENANT_ID);
  expect((await owner.query('SELECT id FROM tenants WHERE slug = $1', [fixture.slug])).rows)
    .toEqual([{ id: tenant.id }]);
  fixture.ids.add(tenant.id);
  const entitlements = await projectedRows('tenant_entitlements', tenant.id,
    ['package_key', 'status', 'starts_at', 'source', 'metadata']);
  expect(entitlements).toEqual([{
    package_key: 'enterprise', status: 'active', starts_at: expect.any(Date), source: 'tenant_creation_default',
    metadata: { reason: 'Default package at tenant creation; adjust during commercial onboarding.' },
  }]);
  for (const table of copiedTables) {
    expect(canonicalRows(await projectedRows(table, tenant.id))).toEqual(canonicalRows(baseline[table]));
  }
  for (const table of excludedTables) {
    expect(await projectedRows(table, tenant.id, ['id'])).toEqual([]);
  }
  await inCaller('ordinary ALS', async () => {
    for (const table of stages) {
      expect(await prisma.$queryRawUnsafe(`SELECT tenant_id FROM public.${table} WHERE tenant_id = $1::uuid`, tenant.id))
        .toEqual([]);
    }
  });
  await assertPopulation();
}

async function removeFault(fixture) {
  if (!fixture.fault) return;
  const { table, name } = fixture.fault;
  await owner.query(`DROP TRIGGER IF EXISTS ${name} ON public.${table}`);
  await owner.query(`DROP FUNCTION IF EXISTS public.${name}()`);
  fixture.fault = null;
}

async function cleanFixture(fixture) {
  const rows = (await owner.query('SELECT id FROM tenants WHERE slug = $1', [fixture.slug])).rows;
  const ids = rows.map(row => row.id);
  const foreignRows = (await owner.query(
    'SELECT id, slug FROM tenants WHERE id = ANY($1::uuid[]) AND slug <> $2',
    [[...fixture.ids], fixture.slug],
  )).rows;
  const errors = foreignRows.length
    ? [new Error(`Captured tenant IDs do not belong to fixture ${fixture.slug}; left untouched: ${JSON.stringify(foreignRows)}`)]
    : [];
  expect(ids).not.toContain(DEFAULT_TENANT_ID);
  expect(ids).not.toContain(actingTenantId);
  // A fault can expose an ID that no longer exists after rollback; it never authorizes deletion.
  try {
    if (ids.length) {
      for (const table of childTables) {
        await owner.query(`DELETE FROM public.${table} WHERE tenant_id = ANY($1::uuid[])`, [ids]);
      }
      await owner.query('DELETE FROM tenants WHERE id = ANY($1::uuid[]) AND slug = $2', [ids, fixture.slug]);
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Tenant fixture ownership or cleanup failed');
}

async function withFixture(operation) {
  const fixture = { slug: `atomicity-${randomUUID()}`, ids: new Set(), fault: null };
  const errors = [];
  try {
    await assertPopulation();
    await operation(fixture);
  } catch (error) {
    errors.push(error);
  } finally {
    for (const cleanup of [() => removeFault(fixture), () => cleanFixture(fixture)]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Tenant provisioning regression or fixture cleanup failed');
}

async function installFault(fixture, table) {
  const name = `tenant_atomicity_${randomUUID().replaceAll('-', '')}`;
  const marker = `${name}_${table}`;
  fixture.fault = { name, table };
  const preceding = stages.slice(0, stages.indexOf(table));
  const preconditions = preceding.map(previous => {
    const expectedCount = previous === 'tenant_entitlements' ? 1 : baseline[previous].length;
    return `IF (SELECT COUNT(*) FROM public.${previous} WHERE tenant_id = NEW.tenant_id) <> ${expectedCount} THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'atomicity_precondition_failed_${previous}';
    END IF;`;
  }).join('\n');
  await owner.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM public.tenants WHERE id = NEW.tenant_id AND slug = TG_ARGV[0]) THEN
        ${preconditions}
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = TG_ARGV[1] || ':' || NEW.tenant_id::text;
      END IF;
      RETURN NEW;
    END;
  $$`);
  // AFTER INSERT keeps an earlier RLS rejection distinguishable from the injected failure.
  await owner.query(`CREATE TRIGGER ${name} AFTER INSERT ON public.${table}
    FOR EACH ROW EXECUTE FUNCTION public.${name}('${fixture.slug}', '${marker}')`);
  return marker;
}

function nativeFailure(error) {
  const cause = error?.meta?.driverAdapterError?.cause;
  return {
    sqlState: cause?.originalCode || cause?.code || error?.meta?.code || error?.code,
    message: [error?.message, error?.meta?.message, cause?.message, cause?.originalMessage].filter(Boolean).join('\n'),
  };
}

async function survivingRows(fixture) {
  const tenants = (await owner.query('SELECT id FROM tenants WHERE slug = $1', [fixture.slug])).rows;
  for (const tenant of tenants) fixture.ids.add(tenant.id);
  const counts = { tenants: tenants.length };
  for (const table of childTables) {
    counts[table] = (await owner.query(
      `SELECT COUNT(*)::int AS count FROM public.${table} WHERE tenant_id = ANY($1::uuid[])`,
      [[...fixture.ids]],
    )).rows[0].count;
  }
  return counts;
}

async function snapshot(tenantId) {
  const result = {
    tenants: (await owner.query(
      `SELECT id, slug, name, region, compliance_profile, status, settings, created_at, updated_at
         FROM tenants WHERE id = $1::uuid`, [tenantId],
    )).rows,
    tenant_entitlements: await projectedRows('tenant_entitlements', tenantId,
      ['id', 'tenant_id', 'package_key', 'status', 'starts_at', 'expires_at', 'grace_ends_at', 'source', 'assigned_by', 'metadata', 'created_at', 'updated_at']),
  };
  for (const table of copiedTables) {
    const uncopiedColumns = table === 'radiology_tat_thresholds' ? ['is_active'] : [];
    result[table] = await projectedRows(table, tenantId,
      ['id', 'tenant_id', ...projections[table], ...uncopiedColumns, 'created_at', 'updated_at']);
  }
  for (const table of excludedTables) result[table] = await projectedRows(table, tenantId, ['id']);
  return result;
}

beforeAll(async () => {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import prisma, { ensureTenantRlsRuntimeRoleGrants } from './src/lib/prisma.js';
    try {
      const result = await ensureTenantRlsRuntimeRoleGrants();
      if (result.skipped || result.error) throw new Error('Runtime role bootstrap failed');
    } finally { await prisma.$disconnect(); }
  `], { env: { ...process.env, DATABASE_URL: ownerDatabaseUrl, DATABASE_READ_URL: ownerDatabaseUrl }, stdio: 'pipe', timeout: 30000 });
  await owner.connect();
  ownerConnected = true;
  await assertRuntimeAndPolicies();
  await assertPopulation();
  await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, $2)', [actingTenantId, actingSlug]);
}, 120000);

afterAll(async () => {
  const errors = [];
  try {
    for (const cleanup of [
      () => prisma.$disconnect(),
      async () => {
        if (prismaReadOnly !== prisma) await prismaReadOnly.$disconnect();
      },
      async () => {
        if (ownerConnected) await owner.query('DELETE FROM tenants WHERE id = $1::uuid AND slug = $2', [actingTenantId, actingSlug]);
      },
      () => owner.end(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Tenant provisioning suite teardown failed');
}, 120000);

describe('tenant provisioning atomicity under enforced runtime-role RLS', () => {
  test('uses nonempty migrated policies and default sources with a non-owner, non-bypass application role', async () => {
    await assertRuntimeAndPolicies();
    await assertPopulation();
    expect(actingTenantId).not.toBe(DEFAULT_TENANT_ID);
  });

  test('an ordinary nondefault caller provisions exact defaults and retains its isolated context', async () => {
    await withFixture(async fixture => {
      const tenant = await inCaller('ordinary ALS', () => createTenant({ slug: fixture.slug, name: fixture.slug }));
      await assertProvisioned(fixture, tenant);
    });
  }, 120000);

  test('a no-ALS CLI caller provisions exact defaults without acquiring a tenant context', async () => {
    await withFixture(async fixture => {
      expect(getCurrentTenantContext()).toBeNull();
      let tenant;
      try {
        tenant = await createTenant({ slug: fixture.slug, name: fixture.slug });
      } finally {
        expect(getCurrentTenantContext()).toBeNull();
      }
      await assertProvisioned(fixture, tenant);
    });
  }, 120000);

  test('a duplicate slug preserves the existing tenant, entitlement and configuration and restores the caller', async () => {
    await withFixture(async fixture => {
      const tenant = await createTenant({ slug: fixture.slug, name: fixture.slug });
      await assertProvisioned(fixture, tenant);
      const before = await snapshot(tenant.id);
      await expect(inCaller('ordinary ALS', () => createTenant({ slug: fixture.slug, name: 'Must not replace existing tenant' })))
        .rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
      expect(await snapshot(tenant.id)).toEqual(before);
      await assertProvisioned(fixture, tenant);
    });
  }, 120000);

  test.each(['ordinary ALS', 'superAdmin control'].flatMap(mode => stages.map(table => [mode, table])))(
    '%s: native failure in %s rolls back every prior stage and permits a clean retry',
    async (mode, table) => {
      await withFixture(async fixture => {
        const marker = await installFault(fixture, table);
        let failure;
        try {
          await inCaller(mode, () => createTenant({ slug: fixture.slug, name: fixture.slug }));
        } catch (error) {
          failure = error;
        }
        const native = nativeFailure(failure);
        const destinationId = native.message.match(new RegExp(`${marker}:([0-9a-f-]{36})`))?.[1];
        if (destinationId) fixture.ids.add(destinationId);
        const remaining = await survivingRows(fixture);
        expect({
          sqlState: native.sqlState,
          failureKind: native.sqlState === '42501' ? 'RLS rejected before injected stage' : destinationId ? marker : native.message,
          survivingRows: remaining,
        }).toEqual({
          sqlState: 'P0001',
          failureKind: marker,
          survivingRows: Object.fromEntries(['tenants', ...childTables].map(name => [name, 0])),
        });
        await removeFault(fixture);
        const tenant = await inCaller(mode, () => createTenant({ slug: fixture.slug, name: fixture.slug }));
        await assertProvisioned(fixture, tenant);
      });
    },
    120000,
  );
});
