import { randomUUID } from 'crypto';
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const FORCED_FAILURE = 'forced clinical-inbox acknowledgement write failure';
const ctl = { failPattern: null, faultHit: false };

const actualPrismaModule = await import('../lib/prisma.js');

function acknowledgementFaultProxy(tx) {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === '$queryRawUnsafe') {
        return async (sql, ...params) => {
          if (ctl.failPattern?.test(String(sql))) {
            ctl.faultHit = true;
            throw new Error(FORCED_FAILURE);
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
  setTenantTx: (tenantId, fn, options) => actualPrismaModule.setTenantTx(
    tenantId,
    (tx) => fn(acknowledgementFaultProxy(tx)),
    options,
  ),
}));

const prisma = (await import('../lib/prisma.js')).default;
const { default: clinicalInboxRoutes } = await import('../routes/clinicalInboxRoutes.js');
const { errorHandlerMiddleware } = await import('../middleware/errorHandlerMiddleware.js');

const TENANT_ID = randomUUID();
const ACTOR_UID = randomUUID();
const SLA_ID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const TENANT_SLUG = `clinical-ack-atomic-${SUFFIX}`;
const ACTOR_PHONE = `6${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

let taskId;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'clinical-inbox-ack-atomicity';
  req.tenantId = TENANT_ID;
  req.user = { uid: ACTOR_UID, role: 'DOCTOR', roles: ['DOCTOR'] };
  next();
});
app.use('/api/v1/clinical-inbox', clinicalInboxRoutes);
app.use(errorHandlerMiddleware);

async function cleanup() {
  await actualPrismaModule.setTenantTx(TENANT_ID, async (tx) => {
    await tx.$executeRawUnsafe(
      `DELETE FROM task_comments WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM tasks WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    );
  }).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
    TENANT_ID,
    ACTOR_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
}

async function seedAcknowledgement() {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2, 'Clinical inbox acknowledgement atomicity tenant')`,
    TENANT_ID,
    TENANT_SLUG,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, 'Clinical inbox acknowledgement doctor',
             'DOCTOR', TRUE, $3::uuid, NOW())`,
    ACTOR_UID,
    ACTOR_PHONE,
    TENANT_ID,
  );
  const tasks = await actualPrismaModule.setTenantTx(TENANT_ID, async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO workflow_sla_instances
         (id, tenant_id, rule_code, source_table, source_id, status, priority,
          started_at, due_at, assigned_user_uid, metadata)
       VALUES ($1::uuid, $2::uuid, 'cold_chain_excursion_ack',
                'cold_chain_excursions', 'atomicity-fixture', 'active', 'critical', NOW(),
               NOW() + INTERVAL '15 minutes', $3::uuid,
               '{"test":"clinical_inbox_ack_atomicity",\
                 "task_materialization_contract":"application_atomic_v1"}'::jsonb)`,
      SLA_ID,
      TENANT_ID,
      ACTOR_UID,
    );
    return tx.$queryRawUnsafe(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, description, related_resource_type,
          related_resource_id, priority, status, assigned_to_uid, created_by,
          due_at, workflow_sla_instance_id, sla_completion_semantics, metadata)
       VALUES ($1::uuid, 'review', 'Acknowledge critical result',
                'Clinical inbox atomicity regression fixture', 'cold_chain_excursions',
               'atomicity-fixture', 'critical', 'open', $2::uuid, $2::uuid,
               (SELECT due_at
                  FROM workflow_sla_instances
                 WHERE tenant_id = $1::uuid
                   AND id = $3::uuid),
               $3::uuid, 'acknowledgement',
               jsonb_build_object(
                  'sla_key', 'cold_chain_excursion_ack',
                 'test', 'clinical_inbox_ack_atomicity'
               ))
       RETURNING id`,
      TENANT_ID,
      ACTOR_UID,
      SLA_ID,
    );
  });
  taskId = tasks[0].id;
}

d('clinical-inbox acknowledgement transaction atomicity', () => {
  beforeEach(async () => {
    ctl.failPattern = null;
    ctl.faultHit = false;
    await cleanup();
    await seedAcknowledgement();
  }, 60_000);

  afterEach(() => {
    ctl.failPattern = null;
    ctl.faultHit = false;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it.each([
    ['linked SLA', /UPDATE\s+workflow_sla_instances/i],
    ['audit comment', /INSERT\s+INTO\s+task_comments/i],
  ])('rolls back the task, SLA, and comment when the %s write fails', async (_label, pattern) => {
    ctl.failPattern = pattern;

    const response = await request(app)
      .post(`/api/v1/clinical-inbox/tasks/${taskId}/acknowledge`)
      .send({});

    expect(ctl.faultHit).toBe(true);
    expect(response.statusCode).toBe(500);

    const taskRows = await prisma.$queryRawUnsafe(
      `SELECT status, metadata
         FROM tasks
        WHERE tenant_id = $1::uuid AND id = $2`,
      TENANT_ID,
      taskId,
    );
    const slaRows = await prisma.$queryRawUnsafe(
      `SELECT status, completed_at, metadata
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      TENANT_ID,
      SLA_ID,
    );
    const comments = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM task_comments
        WHERE tenant_id = $1::uuid AND task_id = $2`,
      TENANT_ID,
      taskId,
    );

    expect({
      taskStatus: taskRows[0].status,
      taskHasAcknowledgedAt: Object.hasOwn(taskRows[0].metadata, 'acknowledged_at'),
      taskHasAcknowledgedBy: Object.hasOwn(taskRows[0].metadata, 'acknowledged_by'),
      taskHasAcknowledgedVia: Object.hasOwn(taskRows[0].metadata, 'acknowledged_via'),
      slaStatus: slaRows[0].status,
      slaCompletedAt: slaRows[0].completed_at,
      slaHasCompletedVia: Object.hasOwn(slaRows[0].metadata, 'completed_via'),
      taskCommentCount: comments.length,
    }).toEqual({
      taskStatus: 'open',
      taskHasAcknowledgedAt: false,
      taskHasAcknowledgedBy: false,
      taskHasAcknowledgedVia: false,
      slaStatus: 'active',
      slaCompletedAt: null,
      slaHasCompletedVia: false,
      taskCommentCount: 0,
    });
  }, 30_000);

  it('does not restamp a valid acknowledged task/completed breached SLA pair on replay', async () => {
    const dueAt = new Date(Date.now() - 10 * 60_000);
    const acknowledgedAt = new Date(dueAt.getTime() + 5 * 60_000);
    await actualPrismaModule.setTenantTx(TENANT_ID, async (tx) => {
      // Migration 580 makes the task/SLA lifecycle and deadline checks deferred:
      // seed both sides in one short transaction so no impossible split commits.
      await tx.$executeRawUnsafe(
        `UPDATE tasks
            SET status = 'in_progress',
                due_at = $3::timestamptz,
                metadata = metadata || jsonb_build_object(
                  'acknowledged_at', to_char(
                    to_timestamp($4::double precision / 1000.0) AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                  ),
                  'acknowledged_by', $5::text,
                  'acknowledged_via', 'assignee'
                )
          WHERE tenant_id = $1::uuid AND id = $2`,
        TENANT_ID,
        taskId,
        dueAt.toISOString(),
        acknowledgedAt.getTime(),
        ACTOR_UID,
      );
      await tx.$executeRawUnsafe(
        `UPDATE workflow_sla_instances
            SET started_at = $3::timestamptz - INTERVAL '10 minutes',
                status = 'breached',
                due_at = $3::timestamptz,
                completed_at = to_timestamp($4::double precision / 1000.0),
                breached_at = $3::timestamptz,
                metadata = metadata || jsonb_build_object(
                  'completed_via', 'task_ack',
                  'completed_by_task', $5::int,
                  'acknowledged_by', $6::text
                ),
                updated_at = to_timestamp($4::double precision / 1000.0)
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        TENANT_ID,
        SLA_ID,
        dueAt.toISOString(),
        acknowledgedAt.getTime(),
        taskId,
        ACTOR_UID,
      );
    });
    const before = await prisma.$queryRawUnsafe(
      `SELECT status, completed_at, breached_at, updated_at, metadata,
              (EXTRACT(EPOCH FROM completed_at) * 1000)::bigint
                AS completed_at_epoch_ms
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      TENANT_ID,
      SLA_ID,
    );
    const response = await request(app)
      .post(`/api/v1/clinical-inbox/tasks/${taskId}/acknowledge`)
      .send({});

    expect(response.statusCode).toBe(200);
    const after = await prisma.$queryRawUnsafe(
      `SELECT status, completed_at, breached_at, updated_at, metadata,
              (EXTRACT(EPOCH FROM completed_at) * 1000)::bigint
                AS completed_at_epoch_ms
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      TENANT_ID,
      SLA_ID,
    );
    expect(after[0]).toEqual(before[0]);

    const comments = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM task_comments
        WHERE tenant_id = $1::uuid AND task_id = $2`,
      TENANT_ID,
      taskId,
    );
    expect(comments).toHaveLength(0);
  }, 30_000);

  it('replays a valid on-time acknowledged pair after due without falsely recording a breach', async () => {
    const dueAt = new Date(Date.now() - 5 * 60_000);
    const acknowledgedAt = new Date(dueAt.getTime() - 60_000);
    await actualPrismaModule.setTenantTx(TENANT_ID, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE tasks
            SET status = 'in_progress', due_at = $3::timestamptz,
                metadata = metadata || jsonb_build_object(
                  'acknowledged_at', to_char(
                    to_timestamp($4::double precision / 1000.0) AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                  ),
                  'acknowledged_by', $5::text,
                  'acknowledged_via', 'assignee'
                ),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2`,
        TENANT_ID,
        taskId,
        dueAt.toISOString(),
        acknowledgedAt.getTime(),
        ACTOR_UID,
      );
      await tx.$executeRawUnsafe(
        `UPDATE workflow_sla_instances
            SET started_at = $3::timestamptz - INTERVAL '10 minutes',
                status = 'completed', due_at = $3::timestamptz,
                completed_at = to_timestamp($4::double precision / 1000.0),
                breached_at = NULL, escalated_at = NULL,
                metadata = metadata || jsonb_build_object(
                  'completed_via', 'task_ack',
                  'completed_by_task', $5::int,
                  'acknowledged_by', $6::text
                ),
                updated_at = to_timestamp($4::double precision / 1000.0)
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        TENANT_ID,
        SLA_ID,
        dueAt.toISOString(),
        acknowledgedAt.getTime(),
        taskId,
        ACTOR_UID,
      );
    });

    const before = await prisma.$queryRawUnsafe(
      `SELECT status, completed_at, breached_at, updated_at, metadata,
              (EXTRACT(EPOCH FROM completed_at) * 1000)::bigint
                AS completed_at_epoch_ms
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      TENANT_ID,
      SLA_ID,
    );
    const response = await request(app)
      .post(`/api/v1/clinical-inbox/tasks/${taskId}/acknowledge`)
      .send({});

    expect(response.statusCode).toBe(200);
    const after = await prisma.$queryRawUnsafe(
      `SELECT status, completed_at, breached_at, updated_at, metadata,
              (EXTRACT(EPOCH FROM completed_at) * 1000)::bigint
                AS completed_at_epoch_ms
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      TENANT_ID,
      SLA_ID,
    );
    expect(after[0]).toEqual(before[0]);
    expect(after[0].status).toBe('completed');
    expect(after[0].completed_at_epoch_ms).toBe(BigInt(acknowledgedAt.getTime()));
    expect(after[0].breached_at).toBeNull();

    const comments = await prisma.$queryRawUnsafe(
      `SELECT id FROM task_comments WHERE tenant_id = $1::uuid AND task_id = $2`,
      TENANT_ID,
      taskId,
    );
    expect(comments).toHaveLength(0);
  }, 30_000);
});
