import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

// Direct-role negatives for the device-loss Section 6.8 boundary.

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

async function expectDatabaseError(client, operation, expected = {}) {
  await client.query('SAVEPOINT expected_device_loss_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_device_loss_failure');
  await client.query('RELEASE SAVEPOINT expected_device_loss_failure');
  expect(failure).toBeDefined();
  if (expected.code) expect(failure.code).toBe(expected.code);
  if (expected.constraint) expect(failure.constraint).toBe(expected.constraint);
}

describeIfDb('migration 627 raw PostgreSQL device-loss negatives', () => {
  const client = new Client({ connectionString: databaseUrl });
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const actorA = randomUUID();
  const staffA = randomUUID();
  const deviceId = randomUUID();
  const operationId = randomUUID();
  let facilityA;
  let facilityB;

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    for (const [tenantId, label] of [[tenantA, 'a'], [tenantB, 'b']]) {
      await client.query(
        `INSERT INTO tenants (id, slug, name)
         VALUES ($1::uuid, $2::text, $3::text)`,
        [tenantId, `device-loss-${label}-${randomUUID()}`, `Device loss ${label}`],
      );
    }
    const firstFacility = await client.query(
      `INSERT INTO facilities (tenant_id, facility_code, display_name)
       VALUES ($1::uuid, $2::text, 'Device loss facility A') RETURNING id`,
      [tenantA, `DLA-${randomUUID()}`],
    );
    const secondFacility = await client.query(
      `INSERT INTO facilities (tenant_id, facility_code, display_name)
       VALUES ($1::uuid, $2::text, 'Device loss facility B') RETURNING id`,
      [tenantB, `DLB-${randomUUID()}`],
    );
    facilityA = Number(firstFacility.rows[0].id);
    facilityB = Number(secondFacility.rows[0].id);
    for (const [uid, role, phone] of [
      [actorA, 'SUPER_ADMIN', `+918${randomUUID().replaceAll('-', '').slice(0, 9)}`],
      [staffA, 'NURSING_STAFF', `+917${randomUUID().replaceAll('-', '').slice(0, 9)}`],
    ]) {
      await client.query(
        `INSERT INTO users (
           uid, tenant_id, phone, name, role, is_active, status,
           is_deleted, registered_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3, 'Device loss test', $4, true,
                   'active', false, NOW(), NOW())`,
        [uid, tenantA, phone, role],
      );
    }
    await client.query(
      `INSERT INTO clinical_continuity_device_loss_operations (
         id, tenant_id, stable_device_id, request_fingerprint,
         incident_reference, reason, actor_uid, actor_role, step_projection
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'SEC-42',
                 'Lost in transit', $5::uuid, 'SUPER_ADMIN', $6::jsonb)`,
      [operationId, tenantA, deviceId, 'a'.repeat(64), actorA,
        JSON.stringify({ facility_ids: [facilityA] })],
    );
    await client.query(
      `INSERT INTO clinical_continuity_device_loss_subjects (
         tenant_id, operation_id, staff_uid, realm, break_glass
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'staff', false)`,
      [tenantA, operationId, staffA],
    );
  });

  afterAll(async () => {
    await client.query('RESET ROLE').catch(() => {});
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('database owner cannot rewrite operation identity or an append-only route', async () => {
    await expectDatabaseError(client, () => client.query(
      `UPDATE clinical_continuity_device_loss_operations
          SET stable_device_id = $3::uuid, version = version + 1,
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantA, operationId, randomUUID()],
    ), { code: '23514', constraint: 'chk_cc_device_loss_operation_mutation' });

    await client.query(
      `INSERT INTO clinical_continuity_device_loss_routes (
         tenant_id, stable_device_id, facility_id, operation_id,
         fallback_principal, assigned_to_uid
       ) VALUES ($1::uuid, $2::uuid, $3, $4::uuid,
                 'role:clinical_safety_lead', $5::uuid)`,
      [tenantA, deviceId, facilityA, operationId, staffA],
    );
    await expectDatabaseError(client, () => client.query(
      `UPDATE clinical_continuity_device_loss_routes SET active = false
        WHERE tenant_id = $1::uuid AND stable_device_id = $2::uuid`,
      [tenantA, deviceId],
    ), { code: '23514', constraint: 'chk_cc_device_loss_route_append_only' });
  });

  test('default and cross-tenant projections fail hard database constraints', async () => {
    await expectDatabaseError(client, () => client.query(
      `INSERT INTO clinical_continuity_device_loss_operations (
         tenant_id, stable_device_id, request_fingerprint, incident_reference,
         reason, actor_uid, actor_role
       ) VALUES ($1::uuid, $2::uuid, $3, 'SEC-DEFAULT', 'Lost',
                 $4::uuid, 'SUPER_ADMIN')`,
      [DEFAULT_TENANT_ID, randomUUID(), 'b'.repeat(64), actorA],
    ), { code: '23514', constraint: 'chk_cc_device_loss_operation_non_default_tenant' });

    await expectDatabaseError(client, () => client.query(
      `INSERT INTO clinical_continuity_device_loss_routes (
         tenant_id, stable_device_id, facility_id, operation_id,
         fallback_principal, assigned_to_uid
       ) VALUES ($1::uuid, $2::uuid, $3, $4::uuid,
                 'role:clinical_safety_lead', $5::uuid)`,
      [tenantA, randomUUID(), facilityB, operationId, staffA],
    ), { code: '23503', constraint: 'fk_cc_device_loss_route_facility' });
  });

  test('runtime role cannot forge order state and cannot observe wrong-tenant or bypass rows', async () => {
    await client.query('SET LOCAL ROLE vhhealth_app');
    try {
      await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantA]);
      await expectDatabaseError(client, () => client.query(
        `UPDATE clinical_continuity_device_loss_operations
            SET state = 'awaiting_device_contact'
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [tenantA, operationId],
      ), { code: '42501' });

      await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantB]);
      const wrongTenant = await client.query(
        `SELECT COUNT(*)::int AS count
           FROM clinical_continuity_device_loss_operations
          WHERE id = $1::uuid`,
        [operationId],
      );
      expect(wrongTenant.rows[0].count).toBe(0);

      await client.query("SELECT set_config('app.current_tenant_id', 'bypass', true)");
      const bypass = await client.query(
        `SELECT COUNT(*)::int AS count
           FROM clinical_continuity_device_loss_operations
          WHERE id = $1::uuid`,
        [operationId],
      );
      expect(bypass.rows[0].count).toBe(0);
    } finally {
      await client.query('RESET ROLE');
    }
  });

  test('transition functions are fixed-search-path definers without PUBLIC execution', async () => {
    const functions = await client.query(
      `SELECT p.proname, p.prosecdef,
              array_to_string(p.proconfig, ',') AS config,
              COALESCE(p.proacl::text, '') AS acl
         FROM pg_proc AS p
         JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname LIKE 'clinical_continuity_device_loss_%'
        ORDER BY p.proname`,
    );
    expect(functions.rows).toHaveLength(7);
    for (const row of functions.rows) {
      expect(row.prosecdef).toBe(true);
      expect(row.config).toContain('search_path=pg_catalog, pg_temp');
      expect(row.acl).not.toMatch(/(?:\{|,)=X\//);
    }
  });
});
