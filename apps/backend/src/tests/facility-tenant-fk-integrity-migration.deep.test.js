import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

function token() {
  return randomUUID().replaceAll('-', '');
}

async function seedTenant(client, label) {
  const tenantId = randomUUID();
  await client.query(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2::text, $3::text)`,
    [tenantId, `fac-fk-${label}-${token()}`.slice(0, 60), `Facility FK ${label}`],
  );
  return tenantId;
}

async function seedFacility(client, tenantId, label) {
  const inserted = await client.query(
    `INSERT INTO facilities (tenant_id, facility_code, display_name)
     VALUES ($1::uuid, $2::text, $3::text)
     RETURNING id`,
    [tenantId, `FAC-${label}-${token()}`.slice(0, 60), `Facility ${label}`],
  );
  return Number(inserted.rows[0].id);
}

async function seedLocation(client, tenantId, facilityId) {
  const inserted = await client.query(
    `INSERT INTO facility_locations (tenant_id, facility_id, location_code, display_name)
     VALUES ($1::uuid, $2::integer, $3::text, 'FK test location')
     RETURNING id`,
    [tenantId, facilityId, `LOC-${token()}`.slice(0, 60)],
  );
  return Number(inserted.rows[0].id);
}

// One insert helper per facility-referencing table, minimal NOT NULL surface.
// Each takes the tenant the ROW belongs to and the facility it points at, so
// the same helper drives both the same-tenant (accept) and cross-tenant
// (reject) cases.
function buildInserters(fixture) {
  return {
    facility_locations: (client, tenantId, facilityId) =>
      client.query(
        `INSERT INTO facility_locations (tenant_id, facility_id, location_code, display_name)
         VALUES ($1::uuid, $2::integer, $3::text, 'Cross-tenant probe')`,
        [tenantId, facilityId, `LOC-${token()}`.slice(0, 60)],
      ),
    facility_rooms: (client, tenantId, facilityId) =>
      client.query(
        `INSERT INTO facility_rooms (tenant_id, facility_id, location_id, room_code, display_name)
         VALUES ($1::uuid, $2::integer, $3::integer, $4::text, 'Cross-tenant probe')`,
        [tenantId, facilityId, fixture.locationA, `ROOM-${token()}`.slice(0, 60)],
      ),
    service_catalog: (client, tenantId, facilityId) =>
      client.query(
        `INSERT INTO service_catalog (tenant_id, facility_id, service_code, display_name)
         VALUES ($1::uuid, $2::integer, $3::text, 'Cross-tenant probe')`,
        [tenantId, facilityId, `SVC-${token()}`.slice(0, 60)],
      ),
    appointment_queues: (client, tenantId, facilityId) =>
      client.query(
        `INSERT INTO appointment_queues (tenant_id, facility_id, queue_date, queue_label)
         VALUES ($1::uuid, $2::integer, CURRENT_DATE, 'Cross-tenant probe')`,
        [tenantId, facilityId],
      ),
    lab_analyzers: (client, tenantId, facilityId) =>
      client.query(
        `INSERT INTO lab_analyzers (tenant_id, facility_id, analyzer_code, display_name)
         VALUES ($1::uuid, $2::integer, $3::text, 'Cross-tenant probe')`,
        [tenantId, facilityId, `ANL-${token()}`.slice(0, 60)],
      ),
    queue_display_profiles: (client, tenantId, facilityId) =>
      client.query(
        `INSERT INTO queue_display_profiles (tenant_id, facility_id, profile_key, display_name)
         VALUES ($1::uuid, $2::integer, $3::text, 'Cross-tenant probe')`,
        [tenantId, facilityId, `qdp-${token()}`.slice(0, 60)],
      ),
  };
}

const FACILITY_REFERENCING_TABLES = [
  'facility_locations',
  'facility_rooms',
  'service_catalog',
  'appointment_queues',
  'lab_analyzers',
  'queue_display_profiles',
];

async function expectInsertFailure(client, insert) {
  await client.query('SAVEPOINT expected_insert_failure');
  let failure;
  try {
    await insert();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_insert_failure');
  expect(failure).toBeDefined();
  return failure;
}

describeIfDb('migration 598 facility tenant integrity', () => {
  let client;
  let fixture;
  let insertInto;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    const tenantA = await seedTenant(client, 'a');
    const tenantB = await seedTenant(client, 'b');
    const facilityA = await seedFacility(client, tenantA, 'a');
    const facilityB = await seedFacility(client, tenantB, 'b');
    const locationA = await seedLocation(client, tenantA, facilityA);
    fixture = { tenantA, tenantB, facilityA, facilityB, locationA };
    insertInto = buildInserters(fixture);
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  afterAll(async () => {
    await client.end();
  });

  test('facilities carries the (tenant_id, id) anchor unique index', async () => {
    const index = await client.query(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'ux_facilities_tenant_id'`,
    );
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0].indexdef).toContain('UNIQUE');
    expect(index.rows[0].indexdef).toContain('(tenant_id, id)');
  });

  test.each(FACILITY_REFERENCING_TABLES)(
    '%s references facilities through the composite FK only',
    async (table) => {
      const constraints = await client.query(
        `SELECT conname, pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE contype = 'f'
            AND conrelid = $1::regclass
            AND confrelid = 'facilities'::regclass
          ORDER BY conname`,
        [table],
      );
      expect(constraints.rows.map((row) => row.conname)).toEqual([
        `fk_${table}_facility_tenant`,
      ]);
      expect(constraints.rows[0].def).toContain('FOREIGN KEY (tenant_id, facility_id)');
      expect(constraints.rows[0].def).toContain('REFERENCES facilities(tenant_id, id)');
      expect(constraints.rows[0].def).not.toContain('NOT VALID');
    },
  );

  test.each(FACILITY_REFERENCING_TABLES)(
    'rejects a %s row pointing at another tenant\'s facility',
    async (table) => {
      const failure = await expectInsertFailure(client, () =>
        insertInto[table](client, fixture.tenantA, fixture.facilityB),
      );
      expect(failure).toMatchObject({
        code: '23503',
        constraint: `fk_${table}_facility_tenant`,
      });
    },
  );

  test.each(FACILITY_REFERENCING_TABLES)(
    'accepts a %s row pointing at a facility of the same tenant',
    async (table) => {
      await expect(
        insertInto[table](client, fixture.tenantA, fixture.facilityA),
      ).resolves.toMatchObject({ rowCount: 1 });
    },
  );

  test('deleting a facility still cascades to its locations', async () => {
    const facility = await seedFacility(client, fixture.tenantA, 'cascade');
    const locationId = await seedLocation(client, fixture.tenantA, facility);
    await client.query(
      `DELETE FROM facilities WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantA, facility],
    );
    const remaining = await client.query(
      `SELECT id FROM facility_locations WHERE id = $1::integer`,
      [locationId],
    );
    expect(remaining.rows).toHaveLength(0);
  });

  test('deleting a facility nulls only facility_id on SET NULL children', async () => {
    const facility = await seedFacility(client, fixture.tenantA, 'setnull');
    const analyzerCode = `ANL-${token()}`.slice(0, 60);
    await client.query(
      `INSERT INTO lab_analyzers (tenant_id, facility_id, analyzer_code, display_name)
       VALUES ($1::uuid, $2::integer, $3::text, 'SET NULL probe')`,
      [fixture.tenantA, facility, analyzerCode],
    );
    await client.query(
      `DELETE FROM facilities WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantA, facility],
    );
    const analyzer = await client.query(
      `SELECT tenant_id, facility_id FROM lab_analyzers
        WHERE tenant_id = $1::uuid AND analyzer_code = $2::text`,
      [fixture.tenantA, analyzerCode],
    );
    expect(analyzer.rows).toHaveLength(1);
    expect(analyzer.rows[0].facility_id).toBeNull();
    expect(analyzer.rows[0].tenant_id).toBe(fixture.tenantA);
  });
});
