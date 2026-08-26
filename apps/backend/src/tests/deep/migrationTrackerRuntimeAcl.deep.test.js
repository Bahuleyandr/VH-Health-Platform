import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const RUNTIME_ROLE = 'rls_test_app';

describeIfDb('migration tracker runtime ACL', () => {
  let owner;

  async function asRuntimeRole(text, params = []) {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${RUNTIME_ROLE}`);
      return await client.query(text, params);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end().catch(() => {});
    }
  }

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: databaseUrl });
    await owner.connect();
    const role = await owner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [RUNTIME_ROLE]);
    if (role.rowCount !== 1) {
      throw new Error(`${RUNTIME_ROLE} is absent; run ci-setup-db role provisioning first`);
    }
  });

  afterAll(async () => {
    await owner?.end().catch(() => {});
  });

  it('permits readiness SELECT but exposes no effective tracker write privilege', async () => {
    const read = await asRuntimeRole(
      'SELECT name, checksum FROM public._migrations ORDER BY name LIMIT 1',
    );
    expect(read.rowCount).toBeGreaterThan(0);

    const { rows } = await owner.query(
      `SELECT has_table_privilege($1, 'public._migrations', 'SELECT') AS can_select,
              has_table_privilege($1, 'public._migrations', 'INSERT') AS can_insert,
              has_table_privilege($1, 'public._migrations', 'UPDATE') AS can_update,
              has_table_privilege($1, 'public._migrations', 'DELETE') AS can_delete,
              has_table_privilege($1, 'public._migrations', 'TRUNCATE') AS can_truncate,
              has_sequence_privilege($1, 'public._migrations_id_seq', 'USAGE') AS can_use_sequence`,
      [RUNTIME_ROLE],
    );
    expect(rows[0]).toEqual({
      can_select: true,
      can_insert: false,
      can_update: false,
      can_delete: false,
      can_truncate: false,
      can_use_sequence: false,
    });
  });

  it.each([
    [
      'INSERT',
      `INSERT INTO public._migrations (name, checksum)
       VALUES ('runtime-forgery.sql', $1)`,
      ['0'.repeat(64)],
    ],
    [
      'UPDATE',
      `UPDATE public._migrations SET checksum = $1
        WHERE name = (SELECT name FROM public._migrations ORDER BY name LIMIT 1)`,
      ['0'.repeat(64)],
    ],
    ['DELETE', 'DELETE FROM public._migrations WHERE FALSE', []],
    ['TRUNCATE', 'TRUNCATE TABLE public._migrations', []],
    ['sequence allocation', "SELECT nextval('public._migrations_id_seq')", []],
  ])('rejects runtime %s with 42501', async (_operation, sql, params) => {
    await expect(asRuntimeRole(sql, params)).rejects.toMatchObject({ code: '42501' });
  });
});
