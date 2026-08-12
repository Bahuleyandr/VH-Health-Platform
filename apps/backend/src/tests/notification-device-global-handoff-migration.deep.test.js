import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { jest } from '@jest/globals';
import pg from 'pg';

import { splitStatements } from '../utils/migrations/splitStatements.js';

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(__dirname, '..', 'migrations', '661_notification_device_global_handoff.sql');
const migrationSql = readFileSync(migrationPath, 'utf8');
const statements = splitStatements(migrationSql);
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
const TENANT_B = '00000000-0000-4000-8000-0000000000b2';
const TENANT_C = '00000000-0000-4000-8000-0000000000c3';
const USER_A = '10000000-0000-4000-8000-0000000000a1';
const USER_B = '10000000-0000-4000-8000-0000000000b2';
const USER_C = '10000000-0000-4000-8000-0000000000c3';
const RUNTIME_ROLE = 'vhhealth_runtime';
const APP_ROLE = 'vhhealth_app';

jest.setTimeout(90_000);

describe('migration 661 static security contract', () => {
  test('keeps global privilege inside one tenant-bound definer function', () => {
    expect(migrationSql).toMatch(/LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/);
    expect(migrationSql).toMatch(/current_setting\('app\.current_tenant_id', true\)/);
    expect(migrationSql).toMatch(/ERRCODE = '42501'/);
    expect(migrationSql).toMatch(/'notification-device:' \|\| p_device_id/);
    expect(migrationSql).toMatch(/'notification-token:' \|\| p_fcm_token/);
    expect(migrationSql).toMatch(/ORDER BY candidate\.key/);
    expect(migrationSql).toMatch(/UPDATE public\.users AS displaced_user[\s\S]*SET device_token = NULL/);
    expect(migrationSql).toMatch(/UPDATE public\.user_devices AS displaced_device[\s\S]*SET fcm_token = NULL/);
    expect(migrationSql).not.toMatch(/DELETE FROM public\.user_devices/i);
    expect(migrationSql).not.toMatch(/ALTER TABLE public\.user_devices.*(?:NO FORCE|DISABLE) ROW LEVEL SECURITY/is);
    expect(migrationSql).not.toMatch(/DROP POLICY|CREATE POLICY/i);
    expect(migrationSql).toMatch(/rolsuper OR role\.rolbypassrls/);
    expect(migrationSql).toMatch(/REVOKE ALL PRIVILEGES[\s\S]*FROM PUBLIC/);
    expect(migrationSql).toMatch(/ARRAY\['vhhealth_app', 'vhhealth_runtime'\]/);
  });
});

d('migration 661 notification ownership runtime contract (isolated scratch database)', () => {
  const scratchName = `vh_m661_${process.pid}_${Date.now().toString(36)}`;
  let admin;
  let owner;
  let scratchUrl;
  let createdRuntimeRole = false;
  let createdAppRole = false;

  const functionCallSql = `
    SELECT id, device_name, is_new_registration
      FROM public.notification_device_handoff(
        $1::uuid, $2::uuid, $3::text, $4::text, $5::text,
        $6::text, $7::text, $8::text, $9::boolean
      )`;

  async function withRuntimeCall({
    tenantId,
    userUid,
    deviceId,
    token,
    deviceName = 'Ward handset',
    platform = 'android',
    appVersion = '1.2.3',
    osVersion = '16',
    requireExisting = false,
    context = tenantId,
  }) {
    const client = new Client({ connectionString: scratchUrl.toString() });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${RUNTIME_ROLE}`);
      if (context !== null) {
        await client.query(`SELECT pg_catalog.set_config('app.current_tenant_id', $1, true)`, [context]);
      }
      const result = await client.query(functionCallSql, [
        tenantId,
        userUid,
        deviceId,
        token,
        deviceName,
        platform,
        appVersion,
        osVersion,
        requireExisting,
      ]);
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await client.end();
    }
  }

  async function codeBlueTokens(tenantId) {
    const result = await owner.query(
      `SELECT DISTINCT token
         FROM (
           SELECT app_user.device_token AS token
             FROM public.users AS app_user
            WHERE app_user.tenant_id = $1::uuid
              AND app_user.is_active = TRUE
              AND app_user.role = ANY($2::text[])
              AND app_user.device_token IS NOT NULL
           UNION
           SELECT device.fcm_token AS token
             FROM public.user_devices AS device
             JOIN public.users AS app_user
               ON app_user.tenant_id = device.tenant_id
              AND app_user.uid = device.user_uid
            WHERE device.tenant_id = $1::uuid
              AND app_user.is_active = TRUE
              AND app_user.role = ANY($2::text[])
              AND device.fcm_token IS NOT NULL
         ) AS eligible
        WHERE token IS NOT NULL`,
      [tenantId, ['DOCTOR', 'NURSING_STAFF']],
    );
    return result.rows.map((row) => row.token).sort();
  }

  beforeAll(async () => {
    if (!/^[a-z0-9_]+$/.test(scratchName)) throw new Error('Unsafe scratch database name');
    const adminUrl = new URL(databaseUrl);
    adminUrl.pathname = '/postgres';
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();

    for (const roleName of [RUNTIME_ROLE, APP_ROLE]) {
      const existing = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [roleName]);
      if (existing.rowCount === 0) {
        await admin.query(`CREATE ROLE ${roleName} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
        if (roleName === RUNTIME_ROLE) createdRuntimeRole = true;
        if (roleName === APP_ROLE) createdAppRole = true;
      }
    }
    await admin.query(`CREATE DATABASE ${scratchName}`);

    scratchUrl = new URL(databaseUrl);
    scratchUrl.pathname = `/${scratchName}`;
    owner = new Client({ connectionString: scratchUrl.toString() });
    await owner.connect();
    await owner.query(`
      CREATE TABLE public.tenants (
        id UUID PRIMARY KEY
      );
      CREATE TABLE public.users (
        id SERIAL PRIMARY KEY,
        uid UUID NOT NULL,
        tenant_id UUID NOT NULL REFERENCES public.tenants(id),
        role TEXT NOT NULL DEFAULT 'NURSING_STAFF',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        device_token TEXT,
        updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, uid)
      );
      CREATE TABLE public.user_devices (
        id SERIAL PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES public.tenants(id),
        user_uid UUID NOT NULL,
        device_id VARCHAR(255) NOT NULL,
        device_name VARCHAR(255),
        platform VARCHAR(50),
        app_version VARCHAR(50),
        os_version VARCHAR(50),
        fcm_token TEXT,
        last_active TIMESTAMPTZ(6),
        created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
        CONSTRAINT cc_user_devices_user_tenant_fk
          FOREIGN KEY (tenant_id, user_uid) REFERENCES public.users(tenant_id, uid),
        CONSTRAINT notification_device_test_failure
          CHECK (device_name IS DISTINCT FROM 'force-fail'),
        UNIQUE (tenant_id, user_uid, device_id)
      );
      CREATE TABLE public.staff_devices (
        id SERIAL PRIMARY KEY,
        tenant_id UUID NOT NULL,
        user_uid UUID NOT NULL,
        device_id VARCHAR(255) NOT NULL,
        CONSTRAINT cc_staff_device_projection_fk
          FOREIGN KEY (tenant_id, user_uid, device_id)
          REFERENCES public.user_devices(tenant_id, user_uid, device_id)
          ON DELETE RESTRICT
      );
      CREATE FUNCTION public.app_current_tenant_id_uuid()
      RETURNS UUID LANGUAGE sql STABLE AS $$
        SELECT NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid
      $$;
      ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.user_devices FORCE ROW LEVEL SECURITY;
      CREATE POLICY cc_user_devices_explicit_context
        ON public.user_devices AS RESTRICTIVE FOR ALL
        USING (tenant_id = public.app_current_tenant_id_uuid())
        WITH CHECK (tenant_id = public.app_current_tenant_id_uuid());
    `);
    for (const statement of statements) await owner.query(statement);
  });

  afterAll(async () => {
    await owner?.end().catch(() => {});
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`).catch(() => {});
      if (createdRuntimeRole) await admin.query(`DROP ROLE IF EXISTS ${RUNTIME_ROLE}`).catch(() => {});
      if (createdAppRole) await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => {});
      await admin.end().catch(() => {});
    }
  });

  beforeEach(async () => {
    await owner.query('TRUNCATE public.staff_devices, public.user_devices, public.users, public.tenants RESTART IDENTITY CASCADE');
    await owner.query(
      `INSERT INTO public.tenants (id) VALUES ($1::uuid), ($2::uuid), ($3::uuid)`,
      [TENANT_A, TENANT_B, TENANT_C],
    );
    await owner.query(
      `INSERT INTO public.users (tenant_id, uid, role)
       VALUES ($1::uuid, $2::uuid, 'NURSING_STAFF'),
              ($3::uuid, $4::uuid, 'DOCTOR'),
              ($5::uuid, $6::uuid, 'NURSING_STAFF')`,
      [TENANT_A, USER_A, TENANT_B, USER_B, TENANT_C, USER_C],
    );
  });

  test('catalog keeps FORCE RLS, policy, owner, search path, and grants intact', async () => {
    const table = await owner.query(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_catalog.pg_class
        WHERE oid = 'public.user_devices'::regclass`,
    );
    expect(table.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const policy = await owner.query(
      `SELECT polname,
              pg_catalog.pg_get_expr(polqual, polrelid) AS using_expression,
              pg_catalog.pg_get_expr(polwithcheck, polrelid) AS check_expression
         FROM pg_catalog.pg_policy
        WHERE polrelid = 'public.user_devices'::regclass`,
    );
    expect(policy.rows).toHaveLength(1);
    expect(policy.rows[0]).toMatchObject({ polname: 'cc_user_devices_explicit_context' });
    expect(policy.rows[0].using_expression).toMatch(/tenant_id = app_current_tenant_id_uuid\(\)/);
    expect(policy.rows[0].check_expression).toMatch(/tenant_id = app_current_tenant_id_uuid\(\)/);

    const routine = await owner.query(
      `SELECT routine.prosecdef,
              routine.proconfig,
              role.rolsuper,
              role.rolbypassrls,
              NOT EXISTS (
                SELECT 1
                  FROM pg_catalog.aclexplode(
                    COALESCE(
                      routine.proacl,
                      pg_catalog.acldefault('f', routine.proowner)
                    )
                  ) AS grant_row
                 WHERE grant_row.grantee = 0
                   AND grant_row.privilege_type = 'EXECUTE'
              ) AS public_execute_revoked,
              has_function_privilege($1, routine.oid, 'EXECUTE') AS runtime_execute,
              has_function_privilege($2, routine.oid, 'EXECUTE') AS app_execute
         FROM pg_catalog.pg_proc AS routine
         JOIN pg_catalog.pg_roles AS role ON role.oid = routine.proowner
        WHERE routine.oid = 'public.notification_device_handoff(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN)'::regprocedure`,
      [RUNTIME_ROLE, APP_ROLE],
    );
    expect(routine.rows[0]).toMatchObject({
      prosecdef: true,
      public_execute_revoked: true,
      runtime_execute: true,
      app_execute: true,
    });
    expect(routine.rows[0].rolsuper || routine.rows[0].rolbypassrls).toBe(true);
    expect(routine.rows[0].proconfig).toContain('search_path=pg_catalog, pg_temp');
  });

  test.each([
    ['unset', null],
    ['empty', ''],
    ['bypass', 'bypass'],
    ['malformed', 'not-a-uuid'],
    ['wrong tenant', TENANT_A],
  ])('rejects %s caller context with 42501 and no mutation', async (_label, context) => {
    await expect(withRuntimeCall({
      tenantId: TENANT_B,
      userUid: USER_B,
      deviceId: 'context-device',
      token: 'context-token',
      context,
    })).rejects.toMatchObject({ code: '42501' });
    const count = await owner.query('SELECT COUNT(*)::int AS count FROM public.user_devices');
    expect(count.rows[0].count).toBe(0);
  });

  test('hands the exact Code Blue token union to the new tenant across a caller restart', async () => {
    await owner.query(
      `UPDATE public.users SET device_token = 'shared-token'
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      [TENANT_A, USER_A],
    );
    await owner.query(
      `INSERT INTO public.user_devices
         (tenant_id, user_uid, device_id, device_name, fcm_token)
       VALUES ($1::uuid, $2::uuid, 'installation-1', 'Old owner', 'shared-token')`,
      [TENANT_A, USER_A],
    );

    const registration = await withRuntimeCall({
      tenantId: TENANT_B,
      userUid: USER_B,
      deviceId: 'installation-1',
      token: 'shared-token',
    });

    expect(registration[0]).toMatchObject({ is_new_registration: true });
    expect(await codeBlueTokens(TENANT_A)).toEqual([]);
    expect(await codeBlueTokens(TENANT_B)).toEqual(['shared-token']);
  });

  test('clears the displaced old legacy token and preserves a linked staff projection', async () => {
    await owner.query(
      `UPDATE public.users SET device_token = 'old-token'
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      [TENANT_A, USER_A],
    );
    await owner.query(
      `INSERT INTO public.user_devices
         (tenant_id, user_uid, device_id, device_name, fcm_token)
       VALUES ($1::uuid, $2::uuid, 'linked-device', 'Linked projection', 'old-token')`,
      [TENANT_A, USER_A],
    );
    await owner.query(
      `INSERT INTO public.staff_devices (tenant_id, user_uid, device_id)
       VALUES ($1::uuid, $2::uuid, 'linked-device')`,
      [TENANT_A, USER_A],
    );

    await withRuntimeCall({
      tenantId: TENANT_B,
      userUid: USER_B,
      deviceId: 'linked-device',
      token: 'rotated-token',
    });

    const oldOwner = await owner.query(
      `SELECT app_user.device_token, device.fcm_token,
              EXISTS (
                SELECT 1 FROM public.staff_devices AS linked
                 WHERE linked.tenant_id = device.tenant_id
                   AND linked.user_uid = device.user_uid
                   AND linked.device_id = device.device_id
              ) AS staff_link_remains
         FROM public.users AS app_user
         JOIN public.user_devices AS device
           ON device.tenant_id = app_user.tenant_id AND device.user_uid = app_user.uid
        WHERE app_user.tenant_id = $1::uuid AND app_user.uid = $2::uuid`,
      [TENANT_A, USER_A],
    );
    expect(oldOwner.rows[0]).toEqual({
      device_token: null,
      fcm_token: null,
      staff_link_remains: true,
    });
    expect(await codeBlueTokens(TENANT_B)).toEqual(['rotated-token']);
  });

  test('serializes conflicting claims without deadlock and leaves one deliverable owner', async () => {
    const sameDevice = await Promise.all([
      withRuntimeCall({ tenantId: TENANT_A, userUid: USER_A, deviceId: 'race-device', token: 'race-token-a' }),
      withRuntimeCall({ tenantId: TENANT_B, userUid: USER_B, deviceId: 'race-device', token: 'race-token-b' }),
    ]);
    expect(sameDevice).toHaveLength(2);
    const deviceOwners = await owner.query(
      `SELECT tenant_id::text, fcm_token
         FROM public.user_devices
        WHERE device_id = 'race-device' AND fcm_token IS NOT NULL`,
    );
    expect(deviceOwners.rows).toHaveLength(1);

    const sameToken = await Promise.all([
      withRuntimeCall({ tenantId: TENANT_A, userUid: USER_A, deviceId: 'race-a', token: 'one-token' }),
      withRuntimeCall({ tenantId: TENANT_C, userUid: USER_C, deviceId: 'race-c', token: 'one-token' }),
    ]);
    expect(sameToken).toHaveLength(2);
    const tokenOwners = await owner.query(
      `SELECT tenant_id::text, device_id
         FROM public.user_devices
        WHERE fcm_token = 'one-token'`,
    );
    expect(tokenOwners.rows).toHaveLength(1);
    const selected = [];
    for (const tenantId of [TENANT_A, TENANT_B, TENANT_C]) {
      selected.push(await codeBlueTokens(tenantId));
    }
    expect(selected.flat().filter((token) => token === 'one-token')).toHaveLength(1);
  });

  test('rolls back displacement when the target upsert fails', async () => {
    await owner.query(
      `UPDATE public.users SET device_token = 'rollback-token'
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      [TENANT_A, USER_A],
    );
    await owner.query(
      `INSERT INTO public.user_devices
         (tenant_id, user_uid, device_id, device_name, fcm_token)
       VALUES ($1::uuid, $2::uuid, 'rollback-device', 'Original', 'rollback-token')`,
      [TENANT_A, USER_A],
    );

    await expect(withRuntimeCall({
      tenantId: TENANT_B,
      userUid: USER_B,
      deviceId: 'rollback-device',
      token: 'rollback-token',
      deviceName: 'force-fail',
    })).rejects.toMatchObject({ code: '23514' });

    expect(await codeBlueTokens(TENANT_A)).toEqual(['rollback-token']);
    expect(await codeBlueTokens(TENANT_B)).toEqual([]);
  });

  test('preserves positive re-registration and absent update-only behavior', async () => {
    const first = await withRuntimeCall({
      tenantId: TENANT_A,
      userUid: USER_A,
      deviceId: 'stable-device',
      token: 'stable-token',
    });
    const second = await withRuntimeCall({
      tenantId: TENANT_A,
      userUid: USER_A,
      deviceId: 'stable-device',
      token: 'stable-token',
    });
    expect(second[0]).toMatchObject({
      id: first[0].id,
      is_new_registration: false,
    });

    const absent = await withRuntimeCall({
      tenantId: TENANT_B,
      userUid: USER_B,
      deviceId: 'missing-device',
      token: 'stable-token',
      requireExisting: true,
    });
    expect(absent).toEqual([]);
    expect(await codeBlueTokens(TENANT_A)).toEqual(['stable-token']);
  });
});
