import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Client } from 'pg';

import { executeCiMigrationFile } from '../../scripts/lib/ciMigrationExecutor.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migration692Name = '692_sos_alerts_is_test_alert.sql';
const migration709Name = '709_sos_alert_drill_authorization.sql';
const migration692 = readFileSync(
  new URL(`../migrations/${migration692Name}`, import.meta.url),
  'utf8',
);
const migration709 = readFileSync(
  new URL(`../migrations/${migration709Name}`, import.meta.url),
  'utf8',
);
const migration692Sha256 = createHash('sha256')
  .update(migration692.replaceAll('\r\n', '\n'))
  .digest('hex');

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const upgradeSchema = `sos_709_upgrade_${suffix}`;
const freshSchema = `sos_709_fresh_${suffix}`;

function quoted(identifier) {
  if (!/^[a-z0-9_]+$/.test(identifier)) throw new TypeError('unsafe test identifier');
  return `"${identifier}"`;
}

describe('SOS drill migration artifacts', () => {
  test('migration 692 remains byte-identical and provenance moves to 709', () => {
    expect(migration692Sha256).toBe('61842dd94066e6449282e9b113b13a967a834053a4c093a5e7550040d6796ab3');
    expect(migration692).not.toContain('test_alert_authorized_by');
    expect(migration709).toContain('test_alert_authorized_by');
    expect(migration709).toContain('is_test_alert = FALSE');
  });
});

describeIfDb('migration 709 SOS drill authorization upgrade', () => {
  let client;

  async function useSchema(schema) {
    await client.query(`SET search_path TO ${quoted(schema)}`);
  }

  async function createHarnessSchema(schema, { old692 = false } = {}) {
    await client.query(`CREATE SCHEMA ${quoted(schema)}`);
    await useSchema(schema);
    await client.query(`
      CREATE TABLE _migrations (
        name VARCHAR(255) PRIMARY KEY,
        executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(old692
      ? `CREATE TABLE sos_alerts (
           id BIGSERIAL PRIMARY KEY,
           is_test_alert BOOLEAN NOT NULL DEFAULT FALSE
         )`
      : 'CREATE TABLE sos_alerts (id BIGSERIAL PRIMARY KEY)');
  }

  async function applyTracked(schema, file, sql) {
    await useSchema(schema);
    const tracked = await client.query(
      'SELECT 1 FROM _migrations WHERE name = $1::text',
      [file],
    );
    if (tracked.rowCount > 0) return false;
    const schemaSql = file === migration709Name
      ? sql.replaceAll('public.sos_alerts', `${quoted(schema)}.sos_alerts`)
      : sql;
    await executeCiMigrationFile({ client, file, sql: schemaSql });
    return true;
  }

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();

    await createHarnessSchema(upgradeSchema, { old692: true });
    await client.query('INSERT INTO _migrations (name) VALUES ($1)', [migration692Name]);
    await client.query(`
      INSERT INTO sos_alerts (is_test_alert)
      VALUES (TRUE), (FALSE)
    `);
    expect(await applyTracked(upgradeSchema, migration692Name, migration692)).toBe(false);
    expect(await applyTracked(upgradeSchema, migration709Name, migration709)).toBe(true);
    expect(await applyTracked(upgradeSchema, migration709Name, migration709)).toBe(false);
    // The SQL itself also remains safe after an interrupted no-tracker replay.
    await client.query(
      migration709.replaceAll('public.sos_alerts', `${quoted(upgradeSchema)}.sos_alerts`),
    );

    await createHarnessSchema(freshSchema);
    expect(await applyTracked(freshSchema, migration692Name, migration692)).toBe(true);
    expect(await applyTracked(freshSchema, migration709Name, migration709)).toBe(true);
  }, 30_000);

  afterAll(async () => {
    if (!client) return;
    await client.query('SET search_path TO public').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${quoted(upgradeSchema)} CASCADE`).catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${quoted(freshSchema)} CASCADE`).catch(() => {});
    await client.end();
  });

  test('migration 709 is independently tracked after old 692 is skipped', async () => {
    await useSchema(upgradeSchema);
    const tracked = await client.query('SELECT name FROM _migrations ORDER BY name');
    expect(tracked.rows.map(row => row.name)).toEqual([migration692Name, migration709Name]);
  });

  test('old-692 rows with unproven drill state fail safe to real alerts', async () => {
    await useSchema(upgradeSchema);
    const rows = await client.query(`
      SELECT is_test_alert, test_alert_authorized_by, test_alert_authorized_role
        FROM sos_alerts
       ORDER BY id
    `);
    expect(rows.rows).toEqual([
      {
        is_test_alert: false,
        test_alert_authorized_by: null,
        test_alert_authorized_role: null,
      },
      {
        is_test_alert: false,
        test_alert_authorized_by: null,
        test_alert_authorized_role: null,
      },
    ]);
  });

  test.each([upgradeSchema, freshSchema])(
    'accepts ordinary and privileged drill inserts after migration in %s',
    async (schema) => {
      await useSchema(schema);
      const ordinary = await client.query(`
        INSERT INTO sos_alerts DEFAULT VALUES
        RETURNING is_test_alert, test_alert_authorized_by, test_alert_authorized_role
      `);
      expect(ordinary.rows[0]).toEqual({
        is_test_alert: false,
        test_alert_authorized_by: null,
        test_alert_authorized_role: null,
      });

      const drill = await client.query(`
        INSERT INTO sos_alerts
          (is_test_alert, test_alert_authorized_by, test_alert_authorized_role)
        VALUES (TRUE, $1::uuid, 'ADMIN')
        RETURNING is_test_alert, test_alert_authorized_by::text, test_alert_authorized_role
      `, ['11111111-1111-4111-8111-111111111111']);
      expect(drill.rows[0]).toEqual({
        is_test_alert: true,
        test_alert_authorized_by: '11111111-1111-4111-8111-111111111111',
        test_alert_authorized_role: 'ADMIN',
      });
    },
  );

  test.each([upgradeSchema, freshSchema])(
    'rejects a direct unproven drill insert after migration in %s',
    async (schema) => {
      await useSchema(schema);
      await expect(client.query(`
        INSERT INTO sos_alerts (is_test_alert)
        VALUES (TRUE)
      `)).rejects.toMatchObject({
        code: '23514',
        constraint: 'chk_sos_alert_test_authority',
      });
    },
  );
});
