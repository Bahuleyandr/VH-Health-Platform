import { randomUUID } from 'crypto';
import { jest } from '@jest/globals';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const FORCED_POST_BODY_FAILURE = 'forced failure after cold-chain tenant transaction body';
const ctl = { failAfterBody: false };

const actualPrismaModule = await import('../lib/prisma.js');

jest.unstable_mockModule('../lib/prisma.js', () => ({
  ...actualPrismaModule,
  setTenantTx: async (tenantId, fn, options) => actualPrismaModule.setTenantTx(
    tenantId,
    async (tx) => {
      const result = await fn(tx);
      if (ctl.failAfterBody) throw new Error(FORCED_POST_BODY_FAILURE);
      return result;
    },
    options,
  ),
}));

const prisma = (await import('../lib/prisma.js')).default;
const { acknowledgeColdChainExcursion } = await import('../services/devices/coldChainService.js');
const { acknowledgeTask } = await import('../services/workflow/taskService.js');

const TENANT_ID = randomUUID();
const ACTOR_UID = randomUUID();
const SLA_ID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const TENANT_SLUG = `cc-ack-atomic-${SUFFIX}`;
const DEVICE_CODE = `CC-ACK-DEVICE-${SUFFIX}`;
const UNIT_CODE = `CC-ACK-UNIT-${SUFFIX}`;
const ACTOR_PHONE = `7${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

let deviceId;
let unitId;
let excursionId;
let taskId;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM cold_chain_excursions WHERE tenant_id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tasks WHERE tenant_id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM cold_chain_units WHERE tenant_id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM device_registry WHERE tenant_id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
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

async function seedLinkedExcursion() {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2, 'Cold-chain acknowledgement atomicity tenant')`,
    TENANT_ID,
    TENANT_SLUG,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, 'Cold-chain acknowledgement responder',
             'PHARMACY_STAFF', TRUE, $3::uuid, NOW())`,
    ACTOR_UID,
    ACTOR_PHONE,
    TENANT_ID,
  );
  const devices = await prisma.$queryRawUnsafe(
    `INSERT INTO device_registry
       (tenant_id, device_code, display_name, kind, protocol, status, metadata)
     VALUES ($1::uuid, $2, 'Atomicity test cold-chain sensor',
             'fridge_sensor', 'http-json', 'active', '{"test":"cold_chain_ack_atomicity"}'::jsonb)
     RETURNING id`,
    TENANT_ID,
    DEVICE_CODE,
  );
  deviceId = devices[0].id;

  const units = await prisma.$queryRawUnsafe(
    `INSERT INTO cold_chain_units
       (tenant_id, unit_code, display_name, kind, department, device_registry_id,
        min_temp_c, max_temp_c, excursion_grace_minutes, alert_roles, status,
        retention_days, metadata, created_by)
     VALUES ($1::uuid, $2, 'Atomicity test vaccine refrigerator', 'fridge',
             'pharmacy', $3, 2.00, 8.00, 15, ARRAY['PHARMACY_STAFF']::text[],
             'active', 730, '{"test":"cold_chain_ack_atomicity"}'::jsonb, $4::uuid)
     RETURNING id`,
    TENANT_ID,
    UNIT_CODE,
    deviceId,
    ACTOR_UID,
  );
  unitId = units[0].id;

  const excursions = await prisma.$queryRawUnsafe(
    `INSERT INTO cold_chain_excursions
       (tenant_id, unit_id, breach_started_at, opened_at, last_out_of_range_at,
        breach_direction, peak_temp_c, min_seen_temp_c, max_seen_temp_c,
        severity, status, metadata)
     VALUES ($1::uuid, $2, NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '15 minutes',
             NOW() - INTERVAL '1 minute', 'high', 12.50, 5.00, 12.50,
             'critical', 'open', '{"test":"cold_chain_ack_atomicity"}'::jsonb)
     RETURNING id`,
    TENANT_ID,
    unitId,
  );
  excursionId = excursions[0].id;

  await prisma.$executeRawUnsafe(
    `INSERT INTO workflow_sla_instances
       (id, tenant_id, rule_code, source_table, source_id, status, priority,
        started_at, due_at, assigned_role_codes, metadata)
     VALUES ($1::uuid, $2::uuid, 'cold_chain_excursion_ack',
             'cold_chain_excursions', $3, 'active', 'critical', NOW(),
             NOW() + INTERVAL '15 minutes', ARRAY['PHARMACY_STAFF']::text[],
             '{"test":"cold_chain_ack_atomicity"}'::jsonb)`,
    SLA_ID,
    TENANT_ID,
    String(excursionId),
  );

  const tasks = await prisma.$queryRawUnsafe(
    `INSERT INTO tasks
       (tenant_id, task_kind, title, description, related_resource_type,
        related_resource_id, priority, status, assigned_to_uid, assigned_to_role,
        created_by, due_at, metadata)
     VALUES ($1::uuid, 'review', 'Acknowledge cold-chain excursion',
              'Atomicity regression fixture', 'cold_chain_excursions', $2,
              'critical', 'open', NULL, 'COLD_CHAIN_MANAGER', $3::uuid,
             NOW() + INTERVAL '15 minutes',
             jsonb_build_object(
               'sla_key', 'cold_chain_excursion_ack',
               'sla_instance_id', $4::text,
               'unit_id', $5::int,
               'test', 'cold_chain_ack_atomicity'
             ))
     RETURNING id`,
    TENANT_ID,
    String(excursionId),
    ACTOR_UID,
    SLA_ID,
    unitId,
  );
  taskId = tasks[0].id;

  await prisma.$executeRawUnsafe(
    `UPDATE cold_chain_excursions
        SET task_id = $3, sla_instance_id = $4::uuid, updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::bigint`,
    TENANT_ID,
    excursionId,
    taskId,
    SLA_ID,
  );
}

d('cold-chain acknowledgement transaction atomicity', () => {
  beforeAll(async () => {
    await cleanup();
    await seedLinkedExcursion();
  }, 60_000);

  afterEach(() => {
    ctl.failAfterBody = false;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('rolls back the excursion, linked task, SLA, and task comment when the outer tenant transaction fails', async () => {
    ctl.failAfterBody = true;

    await expect(acknowledgeColdChainExcursion({
      tenantId: TENANT_ID,
      id: excursionId,
      actorUid: ACTOR_UID,
      actorRoles: ['PHARMACY_STAFF'],
    })).rejects.toThrow(FORCED_POST_BODY_FAILURE);

    const excursionRows = await prisma.$queryRawUnsafe(
      `SELECT status, acknowledged_by, acknowledged_at
         FROM cold_chain_excursions
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT_ID,
      excursionId,
    );
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
      excursionStatus: excursionRows[0].status,
      excursionAcknowledgedBy: excursionRows[0].acknowledged_by,
      excursionAcknowledgedAt: excursionRows[0].acknowledged_at,
      taskStatus: taskRows[0].status,
      taskHasAcknowledgedAt: Object.hasOwn(taskRows[0].metadata, 'acknowledged_at'),
      taskHasAcknowledgedBy: Object.hasOwn(taskRows[0].metadata, 'acknowledged_by'),
      taskHasAcknowledgedVia: Object.hasOwn(taskRows[0].metadata, 'acknowledged_via'),
      taskHasOverrideReason: Object.hasOwn(taskRows[0].metadata, 'acknowledge_override_reason'),
      slaStatus: slaRows[0].status,
      slaCompletedAt: slaRows[0].completed_at,
      slaHasCompletedVia: Object.hasOwn(slaRows[0].metadata, 'completed_via'),
      taskCommentCount: comments.length,
    }).toEqual({
      excursionStatus: 'open',
      excursionAcknowledgedBy: null,
      excursionAcknowledgedAt: null,
      taskStatus: 'open',
      taskHasAcknowledgedAt: false,
      taskHasAcknowledgedBy: false,
      taskHasAcknowledgedVia: false,
      taskHasOverrideReason: false,
      slaStatus: 'active',
      slaCompletedAt: null,
      slaHasCompletedVia: false,
      taskCommentCount: 0,
    });
  }, 30_000);

  it('commits an authorized cold-chain responder as a resource-bound audited override', async () => {
    await expect(acknowledgeColdChainExcursion({
      tenantId: TENANT_ID,
      id: excursionId,
      actorUid: ACTOR_UID,
      actorRoles: ['PHARMACY_STAFF'],
    })).resolves.toMatchObject({ status: 'acknowledged' });

    const taskRows = await prisma.$queryRawUnsafe(
      `SELECT status, metadata
         FROM tasks
        WHERE tenant_id = $1::uuid AND id = $2`,
      TENANT_ID,
      taskId,
    );
    expect(taskRows[0]).toMatchObject({
      status: 'in_progress',
      metadata: {
        acknowledged_via: 'override',
        acknowledge_override_source: 'cold_chain_excursion_ack',
        acknowledge_override_id: String(excursionId),
        acknowledge_override_reason: 'Acknowledged via cold-chain excursion acknowledgement',
      },
    });

    const slaRows = await prisma.$queryRawUnsafe(
      `SELECT status, completed_at, metadata
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      TENANT_ID,
      SLA_ID,
    );
    expect(slaRows[0]).toMatchObject({
      status: 'completed',
      metadata: { completed_via: 'task_ack' },
    });
    expect(slaRows[0].completed_at).not.toBeNull();

    const comments = await prisma.$queryRawUnsafe(
      `SELECT body_kind, metadata
         FROM task_comments
        WHERE tenant_id = $1::uuid AND task_id = $2`,
      TENANT_ID,
      taskId,
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      body_kind: 'state_change',
      metadata: {
        via: 'override',
        override_source: 'cold_chain_excursion_ack',
        override_id: String(excursionId),
      },
    });
  }, 30_000);

  it('atomically repairs an in-progress task whose linked SLA remained active', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE tasks
          SET status = 'in_progress',
              assigned_to_uid = $3::uuid,
              assigned_to_role = 'PHARMACY_STAFF',
              metadata = metadata
                - 'acknowledged_at'
                - 'acknowledged_by'
                - 'acknowledged_via'
                - 'acknowledge_override_source'
                - 'acknowledge_override_id'
                - 'acknowledge_override_reason',
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2`,
      TENANT_ID,
      taskId,
      ACTOR_UID,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE workflow_sla_instances
          SET status = 'active',
              completed_at = NULL,
              breached_at = NULL,
              metadata = metadata - 'completed_via' - 'completed_by_task' - 'acknowledged_by',
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      TENANT_ID,
      SLA_ID,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM task_comments
        WHERE tenant_id = $1::uuid AND task_id = $2`,
      TENANT_ID,
      taskId,
    );

    const task = await acknowledgeTask({
      tenantId: TENANT_ID,
      id: taskId,
      actorUid: ACTOR_UID,
      actorRoles: ['PHARMACY_STAFF'],
    });
    expect(task.status).toBe('in_progress');

    const slaRows = await prisma.$queryRawUnsafe(
      `SELECT status, completed_at, metadata
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      TENANT_ID,
      SLA_ID,
    );
    expect(slaRows[0].status).toBe('completed');
    expect(slaRows[0].completed_at).not.toBeNull();
    expect(slaRows[0].metadata).toMatchObject({ completed_via: 'task_ack' });

    const comments = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM task_comments
        WHERE tenant_id = $1::uuid AND task_id = $2`,
      TENANT_ID,
      taskId,
    );
    expect(comments).toHaveLength(0);
  }, 30_000);
});
