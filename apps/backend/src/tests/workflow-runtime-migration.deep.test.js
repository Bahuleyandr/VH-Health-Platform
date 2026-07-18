import { readFileSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const migrationSql = readFileSync(
  new URL('../migrations/579_workflow_runtime_hardening.sql', import.meta.url),
  'utf8',
);
const preflightStart = migrationSql.indexOf('DO $$');
const preflightEnd = migrationSql.indexOf(
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_definitions_tenant_id',
);

if (preflightStart < 0 || preflightEnd <= preflightStart) {
  throw new Error('Migration 579 cross-tenant preflight block was not found');
}

const preflightSql = migrationSql.slice(preflightStart, preflightEnd).trim();

const SHADOW_TABLES_SQL = `
  CREATE TEMP TABLE workflow_definitions (
    id INTEGER NOT NULL,
    tenant_id UUID NOT NULL
  );
  CREATE TEMP TABLE workflow_runs (
    id INTEGER NOT NULL,
    tenant_id UUID NOT NULL,
    workflow_definition_id INTEGER
  );
  CREATE TEMP TABLE workflow_steps (
    id INTEGER NOT NULL,
    tenant_id UUID NOT NULL,
    workflow_run_id INTEGER NOT NULL
  );
  CREATE TEMP TABLE tasks (
    id INTEGER NOT NULL,
    tenant_id UUID NOT NULL,
    workflow_run_id INTEGER,
    workflow_step_id INTEGER,
    parent_task_id INTEGER
  );
  CREATE TEMP TABLE task_comments (
    id INTEGER NOT NULL,
    tenant_id UUID NOT NULL,
    task_id INTEGER NOT NULL
  );
  CREATE TEMP TABLE approvals (
    id INTEGER NOT NULL,
    tenant_id UUID NOT NULL,
    workflow_run_id INTEGER,
    task_id INTEGER
  );
`;

async function insertDefinition(db, id, tenantId) {
  await db.query(
    'INSERT INTO workflow_definitions (id, tenant_id) VALUES ($1::int, $2::uuid)',
    [id, tenantId],
  );
}

async function insertRun(db, id, tenantId, definitionId = null) {
  await db.query(
    `INSERT INTO workflow_runs (id, tenant_id, workflow_definition_id)
     VALUES ($1::int, $2::uuid, $3::int)`,
    [id, tenantId, definitionId],
  );
}

async function insertStep(db, id, tenantId, runId) {
  await db.query(
    `INSERT INTO workflow_steps (id, tenant_id, workflow_run_id)
     VALUES ($1::int, $2::uuid, $3::int)`,
    [id, tenantId, runId],
  );
}

async function insertTask(db, {
  id,
  tenantId,
  runId = null,
  stepId = null,
  parentTaskId = null,
}) {
  await db.query(
    `INSERT INTO tasks
       (id, tenant_id, workflow_run_id, workflow_step_id, parent_task_id)
     VALUES ($1::int, $2::uuid, $3::int, $4::int, $5::int)`,
    [id, tenantId, runId, stepId, parentTaskId],
  );
}

async function insertTaskComment(db, id, tenantId, taskId) {
  await db.query(
    `INSERT INTO task_comments (id, tenant_id, task_id)
     VALUES ($1::int, $2::uuid, $3::int)`,
    [id, tenantId, taskId],
  );
}

async function insertApproval(db, id, tenantId, runId = null, taskId = null) {
  await db.query(
    `INSERT INTO approvals (id, tenant_id, workflow_run_id, task_id)
     VALUES ($1::int, $2::uuid, $3::int, $4::int)`,
    [id, tenantId, runId, taskId],
  );
}

const CROSS_TENANT_SEAMS = [
  {
    label: 'workflow run to definition',
    expected: 'workflow_runs.workflow_definition_id crosses tenants',
    seed: async (db) => {
      await insertDefinition(db, 1, TENANT_A);
      await insertRun(db, 2, TENANT_B, 1);
    },
  },
  {
    label: 'workflow step to run',
    expected: 'workflow_steps.workflow_run_id crosses tenants',
    seed: async (db) => {
      await insertRun(db, 1, TENANT_A);
      await insertStep(db, 2, TENANT_B, 1);
    },
  },
  {
    label: 'task to workflow run',
    expected: 'tasks.workflow_run_id crosses tenants',
    seed: async (db) => {
      await insertRun(db, 1, TENANT_A);
      await insertTask(db, { id: 2, tenantId: TENANT_B, runId: 1 });
    },
  },
  {
    label: 'task to workflow step',
    expected: 'tasks.workflow_step_id crosses tenants',
    seed: async (db) => {
      await insertRun(db, 1, TENANT_A);
      await insertStep(db, 2, TENANT_A, 1);
      await insertTask(db, { id: 3, tenantId: TENANT_B, stepId: 2 });
    },
  },
  {
    label: 'child task to parent task',
    expected: 'tasks.parent_task_id crosses tenants',
    seed: async (db) => {
      await insertTask(db, { id: 1, tenantId: TENANT_A });
      await insertTask(db, { id: 2, tenantId: TENANT_B, parentTaskId: 1 });
    },
  },
  {
    label: 'task comment to task',
    expected: 'task_comments.task_id crosses tenants',
    seed: async (db) => {
      await insertTask(db, { id: 1, tenantId: TENANT_A });
      await insertTaskComment(db, 2, TENANT_B, 1);
    },
  },
  {
    label: 'approval to workflow run',
    expected: 'approvals.workflow_run_id crosses tenants',
    seed: async (db) => {
      await insertRun(db, 1, TENANT_A);
      await insertApproval(db, 2, TENANT_B, 1);
    },
  },
  {
    label: 'approval to task',
    expected: 'approvals.task_id crosses tenants',
    seed: async (db) => {
      await insertTask(db, { id: 1, tenantId: TENANT_A });
      await insertApproval(db, 2, TENANT_B, null, 1);
    },
  },
];

describeIfDb('migration 579 cross-tenant preflight (PostgreSQL)', () => {
  let client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query(SHADOW_TABLES_SQL);
    await client.query('SET LOCAL search_path = pg_temp');
  });

  afterEach(async () => {
    await client.query('ROLLBACK').catch(() => {});
  });

  afterAll(async () => {
    await client.end();
  });

  test('extracts the complete eight-seam block from the real migration', () => {
    expect(preflightSql).toMatch(/^DO \$\$/);
    expect(preflightSql.match(/crosses tenants/g)).toHaveLength(8);
  });

  test.each(CROSS_TENANT_SEAMS)(
    'fails closed on $label',
    async ({ expected, seed }) => {
      await seed(client);

      let failure;
      try {
        await client.query(preflightSql);
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({ code: 'P0001' });
      expect(failure.message).toContain(`migration 579 blocked: ${expected}`);
    },
  );

  test('accepts a complete same-tenant workflow graph', async () => {
    await insertDefinition(client, 10, TENANT_A);
    await insertRun(client, 20, TENANT_A, 10);
    await insertStep(client, 30, TENANT_A, 20);
    await insertTask(client, {
      id: 40,
      tenantId: TENANT_A,
      runId: 20,
      stepId: 30,
    });
    await insertTask(client, {
      id: 41,
      tenantId: TENANT_A,
      runId: 20,
      stepId: 30,
      parentTaskId: 40,
    });
    await insertTaskComment(client, 50, TENANT_A, 41);
    await insertApproval(client, 60, TENANT_A, 20, 41);

    const result = await client.query(preflightSql);

    expect(result.command).toBe('DO');
  });
});
