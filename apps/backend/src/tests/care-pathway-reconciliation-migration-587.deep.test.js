import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../migrations/587_care_pathway_reconciliation_evidence.sql', import.meta.url),
  'utf8',
);
const prismaSchema = readFileSync(
  new URL('../../prisma/schema.prisma', import.meta.url),
  'utf8',
);
const runtimeGrantBlock = migrationSql.match(
  /DO \$care_pathway_reconciliation_runtime_grants\$[\s\S]*?\$care_pathway_reconciliation_runtime_grants\$;/,
)?.[0];

if (!runtimeGrantBlock) {
  throw new Error('Migration 587 runtime grant block was not found');
}

const FROZEN_MIGRATIONS = {
  '580_care_pathway_execution_spine.sql': [246628, 'a41495fc511bd5238fe548e9185a1461715b47aa54607c7f42ff8ad79edaa979'],
  '581_lab_critical_alert_generations.sql': [110528, '43afb83d57e50e738540addcc02875c35826884b3d9d4d7b31bbaebb77b61cb4'],
  '582_lab_oru_replay_idempotency.sql': [64558, 'f0cea6e6ea63f9cf5932acbd99ee9508a2e838d3715d09b969aed99e3a0e41f0'],
  '583_lab_astm_atomic_replay.sql': [177245, '7d1abe4238fa95d4bafbea9e86052df8c53ca8361fefdcf407ea9e44e10919f1'],
  '584_care_pathway_governance_pinning.sql': [73446, 'f799232a9007cb3a69dea11d7131c96913578e94bb8c62b9c1b6106921c31eb7'],
  '585_care_pathway_exclusive_owner_integrity.sql': [42627, 'e6c2e341fd2a16242e05a348dfb58a531aa046c9f85844a78876e7452f3ba5dc'],
  '586_care_pathway_owner_acceptance.sql': [46145, '73c99367006eac1d22a3bf6aa4436cf9baf565180069d45be0d3650b28f753cf'],
};

function evidenceValues(tenantId, overrides = {}) {
  return {
    sweepId: randomUUID(),
    tenantId,
    pathwayKey: 'diagnostics_order_to_action',
    pathwayMode: 'shadow',
    registryVersion: 1,
    registryChecksum: 'a'.repeat(64),
    governanceChecksum: 'b'.repeat(64),
    governanceCount: 1,
    coveredGovernanceCount: 1,
    expectedCheckCount: 2,
    executedCheckCount: 2,
    findingCount: 0,
    repairCount: 0,
    errorCount: 0,
    registryComplete: true,
    passed: true,
    checkResults: [],
    startedAt: new Date('2026-07-21T10:00:00.000Z'),
    completedAt: new Date('2026-07-21T10:00:01.000Z'),
    ...overrides,
  };
}

async function insertEvidence(client, values) {
  return client.query(
    `INSERT INTO care_pathway_reconciliation_checks
       (sweep_id, tenant_id, pathway_key, pathway_mode,
        registry_version, registry_checksum, governance_checksum,
        governance_count, covered_governance_count,
        expected_check_count, executed_check_count,
        finding_count, repair_count, error_count,
        registry_complete, passed, check_results,
        started_at, completed_at, created_at)
     VALUES
       ($1::uuid, $2::uuid, $3::text, $4::text,
        $5::integer, $6::char(64), $7::char(64),
        $8::integer, $9::integer, $10::integer, $11::integer,
        $12::integer, $13::integer, $14::integer,
        $15::boolean, $16::boolean, $17::jsonb,
        $18::timestamptz, $19::timestamptz, $19::timestamptz)
     RETURNING id::text`,
    [
      values.sweepId,
      values.tenantId,
      values.pathwayKey,
      values.pathwayMode,
      values.registryVersion,
      values.registryChecksum,
      values.governanceChecksum,
      values.governanceCount,
      values.coveredGovernanceCount,
      values.expectedCheckCount,
      values.executedCheckCount,
      values.findingCount,
      values.repairCount,
      values.errorCount,
      values.registryComplete,
      values.passed,
      JSON.stringify(values.checkResults),
      values.startedAt,
      values.completedAt,
    ],
  );
}

async function expectFailure(client, operation, code, message) {
  await client.query('SAVEPOINT expected_reconciliation_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_reconciliation_failure');
  expect(failure).toMatchObject({ code });
  if (message) expect(failure.message).toContain(message);
}

describe('migration 587 static reconciliation evidence contract', () => {
  test('keeps migrations 580 through 586 byte-for-byte frozen', () => {
    for (const [name, [bytes, checksum]] of Object.entries(FROZEN_MIGRATIONS)) {
      const contents = readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n');
      expect(Buffer.byteLength(contents, 'utf8')).toBe(bytes);
      expect(createHash('sha256').update(contents).digest('hex')).toBe(checksum);
    }
  });

  test('reserves one additive migration 587 with no settings or clinical-state rewrite', () => {
    const migrationNames = readdirSync(new URL('../migrations/', import.meta.url))
      .filter((name) => name.startsWith('587_'));
    expect(migrationNames).toEqual(['587_care_pathway_reconciliation_evidence.sql']);
    expect(migrationSql).toContain("SET LOCAL lock_timeout = '10s'");
    expect(migrationSql).toContain("SET LOCAL statement_timeout = '60s'");
    expect(migrationSql).toContain('CREATE TABLE care_pathway_reconciliation_checks');
    expect(migrationSql).toContain('ALTER TABLE care_pathway_reconciliation_checks FORCE ROW LEVEL SECURITY');
    expect(migrationSql).toContain('WITH CHECK');
    expect(migrationSql).toContain('care_pathway_reconciliation_block_mutation');
    expect(migrationSql).not.toMatch(/\bUPDATE\s+tenants\b/i);
    expect(migrationSql).not.toMatch(/\bUPDATE\s+care_pathway_instances\b/i);
    expect(migrationSql).not.toMatch(/\bINSERT\s+INTO\s+workflow_definitions\b/i);
  });

  test('pins Prisma parity for the append-only evidence model', () => {
    expect(prismaSchema).toContain('model care_pathway_reconciliation_checks');
    expect(prismaSchema).toContain('@@unique([tenant_id, pathway_key, sweep_id], map: "ux_care_pathway_reconciliation_sweep")');
    expect(prismaSchema).toContain('@@index([tenant_id, pathway_key, registry_checksum, governance_checksum, completed_at(sort: Desc), id(sort: Desc)], map: "idx_care_pathway_reconciliation_cohort")');
  });
});

describeIfDb('migration 587 database reconciliation evidence contract', () => {
  let client;
  let tenantOne;
  let tenantTwo;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('BEGIN');
    const runtimeRole = await client.query(
      "SELECT pg_catalog.to_regrole('vhhealth_runtime') IS NOT NULL AS exists",
    );
    if (!runtimeRole.rows[0].exists) {
      await client.query('CREATE ROLE vhhealth_runtime NOLOGIN');
      await client.query(runtimeGrantBlock);
    }
    tenantOne = randomUUID();
    tenantTwo = randomUUID();
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'Reconciliation tenant one'),
              ($3::uuid, $4::text, 'Reconciliation tenant two')`,
      [tenantOne, `reconciliation-${randomUUID()}`, tenantTwo, `reconciliation-${randomUUID()}`],
    );
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  test('installs exact columns, constraints, indexes, trigger, and forced RLS', async () => {
    const columns = await client.query(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'care_pathway_reconciliation_checks'
        ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'id', 'sweep_id', 'tenant_id', 'pathway_key', 'pathway_mode',
      'registry_version', 'registry_checksum', 'governance_checksum',
      'governance_count', 'covered_governance_count', 'expected_check_count',
      'executed_check_count', 'finding_count', 'repair_count', 'error_count',
      'registry_complete', 'passed', 'check_results', 'started_at',
      'completed_at', 'created_at',
    ]);
    const contract = await client.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              ARRAY_AGG(DISTINCT i.relname::text) FILTER (WHERE i.relname IS NOT NULL) AS indexes,
              ARRAY_AGG(DISTINCT t.tgname::text) FILTER (WHERE t.tgname IS NOT NULL) AS triggers
         FROM pg_class AS c
         LEFT JOIN pg_index AS x ON x.indrelid = c.oid
         LEFT JOIN pg_class AS i ON i.oid = x.indexrelid
         LEFT JOIN pg_trigger AS t ON t.tgrelid = c.oid AND NOT t.tgisinternal
        WHERE c.oid = 'care_pathway_reconciliation_checks'::regclass
        GROUP BY c.relrowsecurity, c.relforcerowsecurity`,
    );
    expect(contract.rows[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    expect(contract.rows[0].indexes).toEqual(expect.arrayContaining([
      'ux_care_pathway_reconciliation_sweep',
      'ux_care_pathway_reconciliation_tenant_id',
      'idx_care_pathway_reconciliation_latest',
      'idx_care_pathway_reconciliation_cohort',
    ]));
    expect(contract.rows[0].triggers).toContain('trg_care_pathway_reconciliation_append_only');
  });

  test('accepts the exact clean shadow receipt and rejects every false-pass variant', async () => {
    await expect(insertEvidence(client, evidenceValues(tenantOne))).resolves.toMatchObject({
      rowCount: 1,
    });
    const falsePasses = [
      { pathwayMode: 'active' },
      { registryComplete: false },
      { governanceCount: 0, coveredGovernanceCount: 0 },
      { coveredGovernanceCount: 0 },
      { expectedCheckCount: 0, executedCheckCount: 0 },
      { executedCheckCount: 1 },
      { findingCount: 1 },
      { repairCount: 1 },
      { errorCount: 1 },
    ];
    for (const overrides of falsePasses) {
      await expectFailure(
        client,
        () => insertEvidence(client, evidenceValues(tenantOne, overrides)),
        '23514',
        'care_pathway_reconciliation_pass_check',
      );
    }
  });

  test('rejects duplicate sweep identity and unbounded result arrays', async () => {
    const values = evidenceValues(tenantOne, { passed: false });
    await insertEvidence(client, values);
    await expectFailure(
      client,
      () => insertEvidence(client, values),
      '23505',
      'ux_care_pathway_reconciliation_sweep',
    );
    await expectFailure(
      client,
      () => insertEvidence(client, evidenceValues(tenantOne, {
        passed: false,
        checkResults: Array.from({ length: 201 }, () => ({ code: 'X', finding_count: 0 })),
      })),
      '23514',
      'care_pathway_reconciliation_results_check',
    );
  });

  test('blocks update and delete even for the table owner', async () => {
    const inserted = await insertEvidence(client, evidenceValues(tenantOne, { passed: false }));
    const id = inserted.rows[0].id;
    await expectFailure(
      client,
      () => client.query(
        'UPDATE care_pathway_reconciliation_checks SET passed = FALSE WHERE id = $1::bigint',
        [id],
      ),
      'P0001',
      'append-only',
    );
    await expectFailure(
      client,
      () => client.query(
        'DELETE FROM care_pathway_reconciliation_checks WHERE id = $1::bigint',
        [id],
      ),
      'P0001',
      'append-only',
    );
  });

  test('grants only append/read table rights and next-value sequence rights', async () => {
    const privileges = await client.query(
      `SELECT has_table_privilege('vhhealth_runtime', 'care_pathway_reconciliation_checks', 'SELECT') AS can_select,
              has_table_privilege('vhhealth_runtime', 'care_pathway_reconciliation_checks', 'INSERT') AS can_insert,
              has_table_privilege('vhhealth_runtime', 'care_pathway_reconciliation_checks', 'UPDATE') AS can_update,
              has_table_privilege('vhhealth_runtime', 'care_pathway_reconciliation_checks', 'DELETE') AS can_delete,
              has_sequence_privilege('vhhealth_runtime', 'care_pathway_reconciliation_checks_id_seq', 'USAGE') AS sequence_usage`,
    );
    expect(privileges.rows[0]).toEqual({
      can_select: true,
      can_insert: true,
      can_update: false,
      can_delete: false,
      sequence_usage: true,
    });
  });

  test('enforces tenant isolation for runtime reads and writes', async () => {
    await insertEvidence(client, evidenceValues(tenantOne, { passed: false }));
    await insertEvidence(client, evidenceValues(tenantTwo, { passed: false }));
    await client.query('SAVEPOINT runtime_rls_scope');
    await client.query('SET LOCAL ROLE vhhealth_runtime');
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantOne]);
    const visible = await client.query(
      'SELECT DISTINCT tenant_id::text FROM care_pathway_reconciliation_checks ORDER BY tenant_id::text',
    );
    expect(visible.rows).toEqual([{ tenant_id: tenantOne }]);
    await expectFailure(
      client,
      () => insertEvidence(client, evidenceValues(tenantTwo, { passed: false })),
      '42501',
      'row-level security',
    );
    await client.query('ROLLBACK TO SAVEPOINT runtime_rls_scope');
  });
});
