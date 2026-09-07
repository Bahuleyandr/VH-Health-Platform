import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('reprocessingProtocolReuseMatrixDomainCheck', () => {
  const client = new Client({ connectionString: databaseUrl });
  const tenantId = randomUUID();
  const actorId = randomUUID();
  const validMatrix = {
    hbsag: 'no_reuse',
    hcv: 'dedicated_reuse',
    hiv: 'no_reuse',
    isolation_mixed: 'no_reuse',
  };

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, 'Plan 4 matrix')`,
      [tenantId, `plan4-matrix-${randomUUID()}`],
    );
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
    await client.query(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, is_deleted, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'Plan 4 approver', 'INFECTION_CONTROL_OFFICER', true, 'active', false, NOW())`,
      [actorId, tenantId, `+919${randomUUID().replaceAll('-', '').slice(0, 9)}`],
    );
  });

  afterAll(async () => {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  async function insertProtocol(domain, matrix) {
    return client.query(
      `INSERT INTO reprocessing_protocols
         (tenant_id, protocol_key, revision, domain, category, name, basis, reference,
          approved_by, approved_role, approved_at, reuse_matrix, created_by)
       VALUES ($1::uuid, $2::uuid, 1, $3, $4, 'Plan 4 protocol', 'manufacturer_ifu',
               'IFU-1', $5::uuid, 'INFECTION_CONTROL_OFFICER', NOW(), $6::jsonb, $5::uuid)`,
      [tenantId, randomUUID(), domain, domain === 'dialysis' ? 'dialyser' : 'instrument_set', actorId,
        matrix === null ? null : JSON.stringify(matrix)],
    );
  }

  test('reprocessingProtocolReuseMatrixDomainCheck', async () => {
    await expect(insertProtocol('dialysis', validMatrix)).resolves.toBeDefined();
    await expect(insertProtocol('ot', null)).resolves.toBeDefined();

    const mutations = [
      null,
      {},
      { ...validMatrix, hbsag: 'dedicated_reuse' },
      { ...validMatrix, hcv: null },
      { ...validMatrix, extra: 'no_reuse' },
    ];
    expect(mutations).toHaveLength(5);
    for (const matrix of mutations) {
      await client.query('SAVEPOINT invalid_matrix');
      await expect(insertProtocol('dialysis', matrix)).rejects.toMatchObject({
        code: '23514',
        constraint: 'reprocessing_protocols_reuse_matrix_domain_check',
      });
      await client.query('ROLLBACK TO SAVEPOINT invalid_matrix');
      await client.query('RELEASE SAVEPOINT invalid_matrix');
    }
    await client.query('SAVEPOINT invalid_ot_matrix');
    await expect(insertProtocol('ot', validMatrix)).rejects.toMatchObject({
      code: '23514',
      constraint: 'reprocessing_protocols_reuse_matrix_domain_check',
    });
    await client.query('ROLLBACK TO SAVEPOINT invalid_ot_matrix');
    await client.query('RELEASE SAVEPOINT invalid_ot_matrix');
  });
});
