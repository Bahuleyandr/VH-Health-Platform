import { randomUUID } from 'crypto';
import { jest } from '@jest/globals';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const FORCED_STEP_FAILURE = 'forced workflow step materialization failure';
const FORCED_SLA_FAILURE = 'forced linked SLA completion failure';
const ctl = {
  failStepKey: null,
  failSqlPattern: null,
  race: null,
};

const actualPrismaModule = await import('../lib/prisma.js');

function instrumentDb(client) {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === '$queryRawUnsafe') {
        return async (sql, ...params) => {
          const text = String(sql);
          if (
            ctl.failStepKey
            && /INSERT\s+INTO\s+workflow_steps/i.test(text)
            && params.includes(ctl.failStepKey)
          ) {
            throw new Error(FORCED_STEP_FAILURE);
          }
          if (ctl.failSqlPattern?.test(text)) {
            throw new Error(FORCED_SLA_FAILURE);
          }
          if (ctl.race?.pattern.test(text)) {
            await ctl.race.barrier.arrive();
          }
          return target.$queryRawUnsafe(sql, ...params);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

jest.unstable_mockModule('../lib/prisma.js', () => ({
  ...actualPrismaModule,
  default: instrumentDb(actualPrismaModule.default),
  setTenantTx: (tenantId, fn, options) => actualPrismaModule.setTenantTx(
    tenantId,
    (tx) => fn(instrumentDb(tx)),
    options,
  ),
}));

const prisma = (await import('../lib/prisma.js')).default;
const {
  recordApprovalDecision,
  startWorkflowRun,
  transitionTask,
  transitionWorkflowRun,
  transitionWorkflowStep,
} = await import('../services/workflow/taskService.js');

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ACTOR_A = randomUUID();
const ACTOR_B = randomUUID();
const ACTOR_C = randomUUID();
const RUN_TOKEN = randomUUID().replaceAll('-', '').slice(0, 12);
const ROLLBACK_STEP_KEY = `rollback_${RUN_TOKEN}`;

const VALID_STEPS = [
  {
    step_key: 'review_result',
    step_kind: 'task',
    display_name: 'Review result',
    assigned_role: 'DOCTOR',
    metadata: { source: 'workflow_runtime_conformance' },
  },
];

let definitionSequence = 0;

function workflowKey(label) {
  definitionSequence += 1;
  return `s1ba_${label}_${RUN_TOKEN}_${definitionSequence}`;
}

function createTwoPartyBarrier() {
  let arrivals = 0;
  let released = false;
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  return {
    async arrive() {
      arrivals += 1;
      if (arrivals >= 2 && !released) {
        released = true;
        releaseGate();
      }
      await gate;
    },
    forceRelease() {
      if (!released) {
        released = true;
        releaseGate();
      }
    },
    get arrivals() {
      return arrivals;
    },
  };
}

async function runCasRace(pattern, actions, expectedCode, expectedStatusCode = 409) {
  const barrier = createTwoPartyBarrier();
  ctl.race = { pattern, barrier };
  const releaseTimer = setTimeout(() => barrier.forceRelease(), 5_000);
  let results;
  try {
    results = await Promise.allSettled(actions.map((action) => action()));
  } finally {
    clearTimeout(releaseTimer);
    barrier.forceRelease();
    ctl.race = null;
  }

  expect(barrier.arrivals).toBe(2);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0].reason).toMatchObject({ statusCode: expectedStatusCode, code: expectedCode });
  return fulfilled[0].value;
}

async function expectForeignKeyFailure(action) {
  const error = await action().then(() => null, (err) => err);
  expect(error).toBeTruthy();
  expect(`${error?.meta?.code || ''} ${error?.message || ''}`).toMatch(/23503|foreign key/i);
  // Expected integrity violations prove constraints, not infrastructure loss.
  // A successful probe between cases keeps this deliberate negative suite from
  // exhausting the production circuit breaker's consecutive-error budget.
  await prisma.$queryRawUnsafe('SELECT 1');
}

async function seedDefinition({
  tenantId = TENANT_A,
  label,
  steps = VALID_STEPS,
  isActive = true,
  useDatabaseDefault = false,
} = {}) {
  const key = workflowKey(label);
  if (useDatabaseDefault) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO workflow_definitions
         (tenant_id, workflow_key, version, steps)
       VALUES ($1::uuid, $2, 1, $3::jsonb)
       RETURNING id, tenant_id, workflow_key, version, steps, is_active`,
      tenantId,
      key,
      JSON.stringify(steps),
    );
    return rows[0];
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO workflow_definitions
       (tenant_id, workflow_key, version, steps, is_active)
     VALUES ($1::uuid, $2, 1, $3::jsonb, $4)
     RETURNING id, tenant_id, workflow_key, version, steps, is_active`,
    tenantId,
    key,
    JSON.stringify(steps),
    isActive,
  );
  return rows[0];
}

async function seedRun(definition, { tenantId = definition.tenant_id, status = 'started' } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO workflow_runs
       (tenant_id, workflow_definition_id, workflow_key, workflow_version,
        trigger_kind, status, initiated_by)
     VALUES ($1::uuid, $2, $3, $4, 'manual', $5, $6::uuid)
     RETURNING id, tenant_id, workflow_definition_id, workflow_key, workflow_version, status`,
    tenantId,
    definition.id,
    definition.workflow_key,
    definition.version,
    status,
    ACTOR_A,
  );
  return rows[0];
}

async function seedStep(run, {
  tenantId = run.tenant_id,
  stepKey = `step_${RUN_TOKEN}`,
  status = 'pending',
} = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO workflow_steps
       (tenant_id, workflow_run_id, step_key, step_kind, status, ordering)
     VALUES ($1::uuid, $2, $3, 'task', $4, 0)
     RETURNING id, tenant_id, workflow_run_id, step_key, status`,
    tenantId,
    run.id,
    stepKey,
    status,
  );
  return rows[0];
}

async function seedTask({
  tenantId = TENANT_A,
  runId = null,
  stepId = null,
  parentTaskId = null,
  status = 'open',
  title = `Workflow conformance ${RUN_TOKEN}`,
  relatedResourceType = null,
  relatedResourceId = null,
  workflowSlaInstanceId = null,
  slaCompletionSemantics = 'none',
  metadata = { test: 'workflow_runtime_conformance' },
} = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO tasks
         (tenant_id, workflow_run_id, workflow_step_id, parent_task_id,
         task_kind, title, status, created_by,
         related_resource_type, related_resource_id,
         workflow_sla_instance_id, sla_completion_semantics, due_at, metadata)
      VALUES ($1::uuid, $2, $3, $4, 'general', $5, $6, $7::uuid,
              $8, $9, $10::uuid, $11,
              CASE WHEN $10::uuid IS NULL THEN NULL ELSE (
                SELECT sla.due_at
                  FROM workflow_sla_instances AS sla
                 WHERE sla.tenant_id = $1::uuid
                   AND sla.id = $10::uuid
              ) END,
              $12::jsonb)
     RETURNING id, tenant_id, workflow_run_id, workflow_step_id, parent_task_id, status`,
    tenantId,
    runId,
    stepId,
    parentTaskId,
    title,
    status,
    ACTOR_A,
    relatedResourceType,
    relatedResourceId,
    workflowSlaInstanceId,
    slaCompletionSemantics,
    JSON.stringify(metadata),
  );
  return rows[0];
}

async function seedTaskComment({ tenantId = TENANT_A, taskId } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO task_comments (tenant_id, task_id, author_uid, body, body_kind)
     VALUES ($1::uuid, $2, $3::uuid, $4, 'comment')
     RETURNING id, tenant_id, task_id`,
    tenantId,
    taskId,
    ACTOR_A,
    `Workflow runtime conformance ${RUN_TOKEN}`,
  );
  return rows[0];
}

async function seedApproval({
  tenantId = TENANT_A,
  runId = null,
  taskId = null,
  requiredApprovers = 1,
  requiredRole = null,
} = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO approvals
       (tenant_id, workflow_run_id, task_id, approval_kind,
        required_approvers, required_role, status, metadata)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, 'pending',
             '{"test":"workflow_runtime_conformance"}'::jsonb)
     RETURNING id, tenant_id, workflow_run_id, task_id, required_approvers,
               required_role, status, approved_by`,
    tenantId,
    runId,
    taskId,
    `conformance_${RUN_TOKEN}`,
    requiredApprovers,
    requiredRole,
  );
  return rows[0];
}

async function approvalRow(id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, approved_by, rejection_reason, decided_at, updated_at
       FROM approvals
      WHERE tenant_id = $1::uuid AND id = $2`,
    TENANT_A,
    id,
  );
  return rows[0];
}

async function cleanup() {
  ctl.failStepKey = null;
  ctl.failSqlPattern = null;
  ctl.race?.barrier.forceRelease();
  ctl.race = null;
  await prisma.$executeRawUnsafe(
    `DELETE FROM task_comments WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM approvals WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  for (const tenantId of [TENANT_A, TENANT_B]) {
    await actualPrismaModule.setTenantTx(tenantId, async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM tasks WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    }).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM workflow_steps WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM workflow_runs WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM workflow_definitions WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users
      WHERE tenant_id = $1::uuid
        AND uid IN ($2::uuid, $3::uuid, $4::uuid)`,
    TENANT_A,
    ACTOR_A,
    ACTOR_B,
    ACTOR_C,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
    TENANT_A,
    TENANT_B,
  ).catch(() => {});
}

d('workflow runtime PostgreSQL conformance', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'Workflow runtime conformance tenant A'),
              ($3::uuid, $4, 'Workflow runtime conformance tenant B')`,
      TENANT_A,
      `workflow-runtime-a-${RUN_TOKEN}`,
       TENANT_B,
       `workflow-runtime-b-${RUN_TOKEN}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, registered_at, updated_at)
       VALUES
         ($1::uuid, $4::uuid, $5, 'Workflow conformance actor A', 'DOCTOR', TRUE, NOW(), NOW()),
         ($2::uuid, $4::uuid, $6, 'Workflow conformance actor B', 'DOCTOR', TRUE, NOW(), NOW()),
         ($3::uuid, $4::uuid, $7, 'Workflow conformance actor C', 'ADMIN', TRUE, NOW(), NOW())`,
      ACTOR_A,
      ACTOR_B,
      ACTOR_C,
      TENANT_A,
      `71${RUN_TOKEN.slice(0, 10)}1`,
      `71${RUN_TOKEN.slice(0, 10)}2`,
      `71${RUN_TOKEN.slice(0, 10)}3`,
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 30_000);

  it('defaults new definitions to inactive and prevents inactive starts', async () => {
    const definition = await seedDefinition({
      label: 'default_inactive',
      useDatabaseDefault: true,
    });
    expect(definition.is_active).toBe(false);

    await expect(startWorkflowRun({
      tenantId: TENANT_A,
      workflowDefinitionId: definition.id,
      initiatedBy: ACTOR_A,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'INACTIVE_WORKFLOW_DEFINITION',
    });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count
         FROM workflow_runs
        WHERE workflow_definition_id = $1`,
      definition.id,
    );
    expect(rows[0].count).toBe(0);
  });

  it('rejects malformed stored definitions before creating a run or step', async () => {
    const definition = await seedDefinition({
      label: 'malformed',
      isActive: true,
      steps: [
        { step_key: 'review', step_kind: 'task' },
        { step_key: 'review', step_kind: 'approval' },
      ],
    });

    await expect(startWorkflowRun({
      tenantId: TENANT_A,
      workflowDefinitionId: definition.id,
      initiatedBy: ACTOR_A,
    })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_WORKFLOW_DEFINITION' });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer FROM workflow_runs WHERE workflow_definition_id = $1) AS runs,
         (SELECT COUNT(*)::integer
            FROM workflow_steps AS step
            JOIN workflow_runs AS run ON run.id = step.workflow_run_id
           WHERE run.workflow_definition_id = $1) AS steps`,
      definition.id,
    );
    expect(rows[0]).toEqual({ runs: 0, steps: 0 });
  });

  it('rolls back the run and every step when materialization fails', async () => {
    const definition = await seedDefinition({
      label: 'atomic_start',
      isActive: true,
      steps: [
        { step_key: 'first_safe_step', step_kind: 'task' },
        { step_key: ROLLBACK_STEP_KEY, step_kind: 'approval' },
      ],
    });

    ctl.failStepKey = ROLLBACK_STEP_KEY;
    try {
      await expect(startWorkflowRun({
        tenantId: TENANT_A,
        workflowDefinitionId: definition.id,
        initiatedBy: ACTOR_A,
      })).rejects.toThrow(FORCED_STEP_FAILURE);
    } finally {
      ctl.failStepKey = null;
    }

    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer FROM workflow_runs WHERE workflow_definition_id = $1) AS runs,
         (SELECT COUNT(*)::integer
            FROM workflow_steps AS step
            JOIN workflow_runs AS run ON run.id = step.workflow_run_id
           WHERE run.workflow_definition_id = $1) AS steps`,
      definition.id,
    );
    expect(rows[0]).toEqual({ runs: 0, steps: 0 });
  });

  it('accepts same-tenant links and rejects all eight cross-tenant workflow links', async () => {
    const definition = await seedDefinition({ label: 'foreign_keys', isActive: true });

    await expectForeignKeyFailure(() => seedRun(definition, { tenantId: TENANT_B }));
    const run = await seedRun(definition);

    await expectForeignKeyFailure(() => seedStep(run, {
      tenantId: TENANT_B,
      stepKey: `wrong_tenant_${RUN_TOKEN}`,
    }));
    const step = await seedStep(run, { stepKey: `same_tenant_${RUN_TOKEN}` });

    await expectForeignKeyFailure(() => seedTask({
      tenantId: TENANT_B,
      runId: run.id,
      title: `Wrong run tenant ${RUN_TOKEN}`,
    }));
    await expectForeignKeyFailure(() => seedTask({
      tenantId: TENANT_B,
      runId: run.id,
      stepId: step.id,
      title: `Wrong step tenant ${RUN_TOKEN}`,
    }));
    const task = await seedTask({ runId: run.id, stepId: step.id });

    await expectForeignKeyFailure(() => seedTask({
      tenantId: TENANT_B,
      runId: run.id,
      parentTaskId: task.id,
      title: `Wrong parent tenant ${RUN_TOKEN}`,
    }));
    const childTask = await seedTask({
      runId: run.id,
      parentTaskId: task.id,
      title: `Same parent tenant ${RUN_TOKEN}`,
    });

    await expectForeignKeyFailure(() => seedTaskComment({
      tenantId: TENANT_B,
      taskId: task.id,
    }));
    const taskComment = await seedTaskComment({ taskId: task.id });

    await expectForeignKeyFailure(() => seedApproval({
      tenantId: TENANT_B,
      runId: run.id,
    }));
    await expectForeignKeyFailure(() => seedApproval({
      tenantId: TENANT_B,
      runId: run.id,
      taskId: task.id,
    }));
    const approval = await seedApproval({ runId: run.id, taskId: task.id });

    expect({
      run: run.tenant_id,
      step: step.tenant_id,
      task: task.tenant_id,
      childTask: childTask.tenant_id,
      taskComment: taskComment.tenant_id,
      approval: approval.tenant_id,
    }).toEqual({
      run: TENANT_A,
      step: TENANT_A,
      task: TENANT_A,
      childTask: TENANT_A,
      taskComment: TENANT_A,
      approval: TENANT_A,
    });
  });

  it('returns generic not-found errors for another tenant without changing state', async () => {
    const definition = await seedDefinition({ label: 'tenant_mismatch', isActive: true });
    const run = await seedRun(definition);
    const step = await seedStep(run, { stepKey: `tenant_guard_${RUN_TOKEN}` });
    const task = await seedTask({ runId: run.id, stepId: step.id });
    const approval = await seedApproval({ runId: run.id, taskId: task.id });

    await expect(startWorkflowRun({
      tenantId: TENANT_B,
      workflowDefinitionId: definition.id,
      initiatedBy: ACTOR_B,
    })).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    await expect(transitionWorkflowRun({
      tenantId: TENANT_B,
      id: run.id,
      nextStatus: 'running',
      actorUid: ACTOR_B,
    })).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    await expect(transitionWorkflowStep({
      tenantId: TENANT_B,
      workflowRunId: run.id,
      stepKey: step.step_key,
      nextStatus: 'in_progress',
      actorUid: ACTOR_B,
    })).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    await expect(transitionTask({
      tenantId: TENANT_B,
      id: task.id,
      nextStatus: 'in_progress',
      actorUid: ACTOR_B,
    })).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    await expect(recordApprovalDecision({
      tenantId: TENANT_B,
      id: approval.id,
      actorUid: ACTOR_B,
      actorRoles: ['DOCTOR'],
      decision: 'approve',
    })).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT status FROM workflow_runs WHERE id = $1) AS run_status,
         (SELECT status FROM workflow_steps WHERE id = $2) AS step_status,
         (SELECT status FROM tasks WHERE id = $3) AS task_status,
         (SELECT status FROM approvals WHERE id = $4) AS approval_status`,
      run.id,
      step.id,
      task.id,
      approval.id,
    );
    expect(rows[0]).toEqual({
      run_status: 'started',
      step_status: 'pending',
      task_status: 'open',
      approval_status: 'pending',
    });
  });

  it('allows exactly one concurrent run transition and keeps completed runs terminal', async () => {
    const definition = await seedDefinition({ label: 'run_cas', isActive: true });
    const run = await seedRun(definition);
    await runCasRace(
      /UPDATE\s+workflow_runs\s+SET/i,
      [
        () => transitionWorkflowRun({
          tenantId: TENANT_A, id: run.id, nextStatus: 'running', actorUid: ACTOR_A,
        }),
        () => transitionWorkflowRun({
          tenantId: TENANT_A, id: run.id, nextStatus: 'running', actorUid: ACTOR_B,
        }),
      ],
      'WORKFLOW_RUN_TRANSITION_CONFLICT',
    );

    await transitionWorkflowRun({
      tenantId: TENANT_A,
      id: run.id,
      nextStatus: 'completed',
      actorUid: ACTOR_A,
    });
    await expect(transitionWorkflowRun({
      tenantId: TENANT_A,
      id: run.id,
      nextStatus: 'running',
      actorUid: ACTOR_A,
    })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_STATE_TRANSITION' });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT status, ended_at FROM workflow_runs WHERE tenant_id = $1::uuid AND id = $2`,
      TENANT_A,
      run.id,
    );
    expect(rows[0].status).toBe('completed');
    expect(rows[0].ended_at).not.toBeNull();
  });

  it('allows exactly one concurrent step transition and keeps completed steps terminal', async () => {
    const definition = await seedDefinition({ label: 'step_cas', isActive: true });
    const run = await seedRun(definition);
    const step = await seedStep(run, { stepKey: `step_cas_${RUN_TOKEN}` });
    await runCasRace(
      /UPDATE\s+workflow_steps\s+SET/i,
      [
        () => transitionWorkflowStep({
          tenantId: TENANT_A,
          workflowRunId: run.id,
          stepKey: step.step_key,
          nextStatus: 'in_progress',
          actorUid: ACTOR_A,
        }),
        () => transitionWorkflowStep({
          tenantId: TENANT_A,
          workflowRunId: run.id,
          stepKey: step.step_key,
          nextStatus: 'in_progress',
          actorUid: ACTOR_B,
        }),
      ],
      'WORKFLOW_STEP_TRANSITION_CONFLICT',
    );

    const [startedBeforeBlock] = await prisma.$queryRawUnsafe(
      `SELECT started_at FROM workflow_steps
        WHERE tenant_id = $1::uuid AND id = $2`,
      TENANT_A,
      step.id,
    );
    await transitionWorkflowStep({
      tenantId: TENANT_A,
      workflowRunId: run.id,
      stepKey: step.step_key,
      nextStatus: 'blocked',
      actorUid: ACTOR_A,
    });
    await transitionWorkflowStep({
      tenantId: TENANT_A,
      workflowRunId: run.id,
      stepKey: step.step_key,
      nextStatus: 'in_progress',
      actorUid: ACTOR_A,
    });
    const [resumedStep] = await prisma.$queryRawUnsafe(
      `SELECT started_at FROM workflow_steps
        WHERE tenant_id = $1::uuid AND id = $2`,
      TENANT_A,
      step.id,
    );
    expect(resumedStep.started_at.toISOString())
      .toBe(startedBeforeBlock.started_at.toISOString());

    await transitionWorkflowStep({
      tenantId: TENANT_A,
      workflowRunId: run.id,
      stepKey: step.step_key,
      nextStatus: 'completed',
      actorUid: ACTOR_A,
    });
    await expect(transitionWorkflowStep({
      tenantId: TENANT_A,
      workflowRunId: run.id,
      stepKey: step.step_key,
      nextStatus: 'in_progress',
      actorUid: ACTOR_A,
    })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_STATE_TRANSITION' });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT status, completed_at FROM workflow_steps
        WHERE tenant_id = $1::uuid AND id = $2`,
      TENANT_A,
      step.id,
    );
    expect(rows[0].status).toBe('completed');
    expect(rows[0].completed_at).not.toBeNull();
  });

  it('allows exactly one concurrent task transition and keeps completed tasks terminal', async () => {
    const task = await seedTask();
    await runCasRace(
      /SELECT[\s\S]*?FROM\s+tasks\s+WHERE\s+id\s*=\s*\$1\s+AND\s+tenant_id\s*=\s*\$2::uuid\s+FOR\s+UPDATE/i,
      [
        () => transitionTask({
          tenantId: TENANT_A, id: task.id, nextStatus: 'in_progress', actorUid: ACTOR_A,
        }),
        () => transitionTask({
          tenantId: TENANT_A, id: task.id, nextStatus: 'in_progress', actorUid: ACTOR_B,
        }),
      ],
      'INVALID_STATE_TRANSITION',
      400,
    );

    await transitionTask({
      tenantId: TENANT_A,
      id: task.id,
      nextStatus: 'completed',
      actorUid: ACTOR_A,
    });
    await expect(transitionTask({
      tenantId: TENANT_A,
      id: task.id,
      nextStatus: 'in_progress',
      actorUid: ACTOR_A,
    })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_STATE_TRANSITION' });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT status, completed_at FROM tasks WHERE tenant_id = $1::uuid AND id = $2`,
      TENANT_A,
      task.id,
    );
    expect(rows[0].status).toBe('completed');
    expect(rows[0].completed_at).not.toBeNull();
  });

  it('rolls back a terminal task transition when linked SLA completion fails', async () => {
    const slaId = randomUUID();
    const task = await actualPrismaModule.setTenantTx(TENANT_A, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO workflow_sla_instances
           (id, tenant_id, rule_code, source_table, source_id, status, priority,
            started_at, due_at, assigned_user_uid, metadata)
         VALUES ($1::uuid, $2::uuid, 'critical_result_ack',
                 'lab_result', $3, 'active', 'normal', NOW(),
                 NOW() + INTERVAL '15 minutes', $4::uuid,
                 '{"test":"workflow_runtime_conformance",\
                   "task_materialization_contract":"application_atomic_v1"}'::jsonb)`,
        slaId,
        TENANT_A,
        `sla-${RUN_TOKEN}`,
        ACTOR_A,
      );
      const tasks = await tx.$queryRawUnsafe(
        `INSERT INTO tasks
           (tenant_id, task_kind, title, status, assigned_to_uid, created_by,
            related_resource_type, related_resource_id, due_at,
            workflow_sla_instance_id, sla_completion_semantics, metadata)
         SELECT $1::uuid, 'review', $2, 'open', $3::uuid, $3::uuid,
                'lab_result', $4, sla.due_at, sla.id, 'acknowledgement',
                jsonb_build_object(
                  'sla_key', 'critical_result_ack',
                  'test', 'workflow_runtime_conformance',
                  -- A durable receipt so the terminal transition passes the
                  -- acknowledgement gate; this test is about SLA-write rollback.
                  'acknowledged_at', to_char(
                    NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                  )
                )
           FROM workflow_sla_instances AS sla
          WHERE sla.tenant_id = $1::uuid AND sla.id = $5::uuid
         RETURNING id, status`,
        TENANT_A,
        `Linked SLA rollback ${RUN_TOKEN}`,
        ACTOR_A,
        `sla-${RUN_TOKEN}`,
        slaId,
      );
      return tasks[0];
    });

    ctl.failSqlPattern = /UPDATE\s+workflow_sla_instances/i;
    try {
      await expect(transitionTask({
        tenantId: TENANT_A,
        id: task.id,
        nextStatus: 'completed',
        actorUid: ACTOR_A,
      })).rejects.toThrow(FORCED_SLA_FAILURE);
    } finally {
      ctl.failSqlPattern = null;
    }

    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT status FROM tasks WHERE tenant_id = $1::uuid AND id = $2) AS task_status,
         (SELECT completed_at FROM tasks WHERE tenant_id = $1::uuid AND id = $2) AS task_completed_at,
         (SELECT status FROM workflow_sla_instances
           WHERE tenant_id = $1::uuid AND id = $3::uuid) AS sla_status,
         (SELECT completed_at FROM workflow_sla_instances
           WHERE tenant_id = $1::uuid AND id = $3::uuid) AS sla_completed_at`,
      TENANT_A,
      task.id,
      slaId,
    );
    expect(rows[0]).toEqual({
      task_status: 'open',
      task_completed_at: null,
      sla_status: 'active',
      sla_completed_at: null,
    });
  });

  it('serializes approval role checks and quorum without lost approvers', async () => {
    const approval = await seedApproval({ requiredApprovers: 2, requiredRole: 'DOCTOR' });

    await expect(recordApprovalDecision({
      tenantId: TENANT_A,
      id: approval.id,
      actorUid: ACTOR_C,
      actorRoles: ['NURSING_STAFF'],
      decision: 'approve',
    })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(await approvalRow(approval.id)).toMatchObject({ status: 'pending', approved_by: [] });

    const decisions = await Promise.allSettled([
      recordApprovalDecision({
        tenantId: TENANT_A,
        id: approval.id,
        actorUid: ACTOR_A,
        actorRoles: ['DOCTOR'],
        decision: 'approve',
      }),
      recordApprovalDecision({
        tenantId: TENANT_A,
        id: approval.id,
        actorUid: ACTOR_B,
        actorRoles: ['DOCTOR'],
        decision: 'approve',
      }),
    ]);
    expect(decisions.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(decisions.map((result) => result.value.status).sort()).toEqual(['approved', 'pending']);

    const final = await approvalRow(approval.id);
    expect(final.status).toBe('approved');
    expect(final.approved_by).toHaveLength(2);
    expect(new Set(final.approved_by.map((entry) => entry.uid)))
      .toEqual(new Set([ACTOR_A, ACTOR_B]));
    expect(final.decided_at).not.toBeNull();

    const adminOverride = await seedApproval({ requiredRole: 'DOCTOR' });
    const decided = await recordApprovalDecision({
      tenantId: TENANT_A,
      id: adminOverride.id,
      actorUid: ACTOR_C,
      actorRoles: ['ADMIN'],
      decision: 'approve',
    });
    expect(decided.status).toBe('approved');
  });

  it('allows exactly one concurrent terminal approval decision and keeps it immutable', async () => {
    const approval = await seedApproval({ requiredApprovers: 1, requiredRole: 'DOCTOR' });
    const results = await Promise.allSettled([
      recordApprovalDecision({
        tenantId: TENANT_A,
        id: approval.id,
        actorUid: ACTOR_A,
        actorRoles: ['DOCTOR'],
        decision: 'approve',
      }),
      recordApprovalDecision({
        tenantId: TENANT_A,
        id: approval.id,
        actorUid: ACTOR_B,
        actorRoles: ['DOCTOR'],
        decision: 'reject',
        rejectionReason: 'Concurrent rejection',
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const before = await approvalRow(approval.id);
    expect(['approved', 'rejected']).toContain(before.status);
    await expect(recordApprovalDecision({
      tenantId: TENANT_A,
      id: approval.id,
      actorUid: ACTOR_C,
      actorRoles: ['DOCTOR'],
      decision: 'approve',
    })).rejects.toMatchObject({ statusCode: 400, code: 'BAD_REQUEST' });
    expect(await approvalRow(approval.id)).toEqual(before);
  });
});
