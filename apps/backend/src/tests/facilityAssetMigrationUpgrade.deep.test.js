// Retained-database proof for the published facility migration 704 followed
// by additive runtime constraints in migration 710. Runs in an isolated
// schema inside the configured test database.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
const published704 = readFileSync(
  new URL('../migrations/704_facility_asset_register.sql', import.meta.url), 'utf8',
);
const upgrade710 = readFileSync(
  new URL('../migrations/710_facility_asset_runtime_constraints.sql', import.meta.url), 'utf8',
);

d('facility asset retained migration 704 → 710', () => {
  let client;
  let schema;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    schema = `facility_upgrade_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE tenants (id UUID PRIMARY KEY);
      CREATE TABLE users (
        uid UUID NOT NULL,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        role VARCHAR(50) DEFAULT 'STAFF',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        PRIMARY KEY (uid),
        CONSTRAINT ux_users_tenant_uid_for_pathways UNIQUE (tenant_id, uid)
      );
      CREATE FUNCTION app_current_tenant_id_uuid() RETURNS UUID
      LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    `);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query('RESET search_path').catch(() => {});
    if (schema) await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end().catch(() => {});
  });

  it('preserves the published 704 contract and converges retained rows idempotently', async () => {
    expect(published704).not.toMatch(/\bversion\s+INTEGER/);
    expect(published704).not.toContain('fk_facility_assets_custodian');

    await client.query(published704);
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const custodianUid = randomUUID();
    const otherCustodianUid = randomUUID();
    const patientUid = randomUUID();
    const inactiveUid = randomUUID();
    const rolelessUid = randomUUID();
    const nullableRoleUid = randomUUID();
    const deletedUid = randomUUID();
    await client.query(
      'INSERT INTO tenants (id) VALUES ($1), ($2)',
      [tenantId, otherTenantId],
    );
    await client.query(
      `INSERT INTO users (uid, tenant_id, role, is_active)
       VALUES ($1, $2, 'MAINTENANCE', TRUE),
              ($3, $4, 'MAINTENANCE', TRUE),
              ($5, $2, 'PATIENT', TRUE),
              ($6, $2, 'MAINTENANCE', FALSE),
              ($7, $2, NULL, TRUE),
              ($8, $2, 'MAINTENANCE', TRUE),
              ($9, $2, 'MAINTENANCE', TRUE)`,
      [
        custodianUid,
        tenantId,
        otherCustodianUid,
        otherTenantId,
        patientUid,
        inactiveUid,
        rolelessUid,
        nullableRoleUid,
        deletedUid,
      ],
    );
    await client.query(
      `INSERT INTO facility_assets
         (tenant_id, asset_tag, name, category, custodian_uid)
       VALUES ($1, 'VALID-01', 'Valid retained custodian', 'other', $2),
              ($1, 'CROSS-TENANT-01', 'Cross-tenant retained custodian', 'other', $3),
              ($1, 'PATIENT-01', 'Patient retained custodian', 'other', $4),
              ($1, 'INACTIVE-01', 'Inactive retained custodian', 'other', $5),
              ($1, 'ROLELESS-01', 'Role-less retained custodian', 'other', $6),
              ($1, 'NULL-TRANSITION-01', 'Future role-less custodian', 'other', $7),
              ($1, 'DELETE-TRANSITION-01', 'Future deleted custodian', 'other', $8)`,
      [
        tenantId,
        custodianUid,
        otherCustodianUid,
        patientUid,
        inactiveUid,
        rolelessUid,
        nullableRoleUid,
        deletedUid,
      ],
    );

    await client.query(upgrade710);
    await client.query(upgrade710);

    const retained = await client.query(
      `SELECT asset_tag, custodian_uid, version
         FROM facility_assets
        ORDER BY asset_tag`,
    );
    expect(retained.rows).toEqual([
      { asset_tag: 'CROSS-TENANT-01', custodian_uid: null, version: 2 },
      { asset_tag: 'DELETE-TRANSITION-01', custodian_uid: deletedUid, version: 1 },
      { asset_tag: 'INACTIVE-01', custodian_uid: null, version: 2 },
      { asset_tag: 'NULL-TRANSITION-01', custodian_uid: nullableRoleUid, version: 1 },
      { asset_tag: 'PATIENT-01', custodian_uid: null, version: 2 },
      { asset_tag: 'ROLELESS-01', custodian_uid: null, version: 2 },
      { asset_tag: 'VALID-01', custodian_uid: custodianUid, version: 1 },
    ]);

    await expect(client.query(
      `UPDATE facility_assets
          SET custodian_uid = $2
        WHERE tenant_id = $1 AND asset_tag = 'VALID-01'`,
      [tenantId, otherCustodianUid],
    )).rejects.toThrow(
      /fk_facility_assets_custodian|foreign key constraint|active non-patient user/i,
    );

    await expect(client.query(
      `UPDATE facility_assets
          SET custodian_uid = $2
        WHERE tenant_id = $1 AND asset_tag = 'VALID-01'`,
      [tenantId, patientUid],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(client.query(
      `UPDATE facility_assets
          SET custodian_uid = $2
        WHERE tenant_id = $1 AND asset_tag = 'VALID-01'`,
      [tenantId, inactiveUid],
    )).rejects.toMatchObject({ code: '23514' });

    await client.query('UPDATE users SET is_active = FALSE WHERE uid = $1', [custodianUid]);
    const afterDeactivation = await client.query(
      `SELECT custodian_uid, version FROM facility_assets
        WHERE tenant_id = $1 AND asset_tag = 'VALID-01'`,
      [tenantId],
    );
    expect(afterDeactivation.rows[0]).toEqual({ custodian_uid: null, version: 2 });

    await client.query('UPDATE users SET role = NULL WHERE uid = $1', [nullableRoleUid]);
    const afterNullRole = await client.query(
      `SELECT custodian_uid, version FROM facility_assets
        WHERE tenant_id = $1 AND asset_tag = 'NULL-TRANSITION-01'`,
      [tenantId],
    );
    expect(afterNullRole.rows[0]).toEqual({ custodian_uid: null, version: 2 });

    await client.query('DELETE FROM users WHERE uid = $1', [deletedUid]);
    const afterCustodianDelete = await client.query(
      `SELECT custodian_uid, version FROM facility_assets
        WHERE tenant_id = $1 AND asset_tag = 'DELETE-TRANSITION-01'`,
      [tenantId],
    );
    expect(afterCustodianDelete.rows[0]).toEqual({ custodian_uid: null, version: 2 });

    const custodyEvents = await client.query(
      `SELECT asset_tag_snapshot, details->>'reason' AS reason
         FROM facility_asset_events
        WHERE event_type = 'custodian_assigned'
        ORDER BY id`,
    );
    expect(custodyEvents.rows).toHaveLength(7);
    expect(custodyEvents.rows.filter(
      (row) => row.reason === 'migration_710_ineligible_custodian',
    )).toHaveLength(4);
    expect(custodyEvents.rows.filter(
      (row) => row.reason === 'custodian_became_ineligible',
    )).toHaveLength(2);
    expect(custodyEvents.rows.filter(
      (row) => row.reason === 'custodian_deleted',
    )).toHaveLength(1);

    await client.query('DELETE FROM users WHERE uid = $1', [custodianUid]);
    const afterDelete = await client.query(
      `SELECT tenant_id, custodian_uid, version
         FROM facility_assets
        WHERE asset_tag = 'VALID-01'`,
    );
    expect(afterDelete.rows[0]).toEqual({
      tenant_id: tenantId,
      custodian_uid: null,
      version: 2,
    });

    const fresh = await client.query(
      `INSERT INTO facility_assets (tenant_id, asset_tag, name, category)
       VALUES ($1, 'FRESH-01', 'Post-upgrade asset', 'other')
       RETURNING version`,
      [tenantId],
    );
    expect(fresh.rows[0].version).toBe(1);
  });
});
