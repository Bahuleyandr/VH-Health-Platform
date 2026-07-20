import { randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../lib/prisma.js';
import { createTask } from '../services/workflow/taskService.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('typed task/SLA DB-native deadline binding', () => {
  const slaId = randomUUID();
  const resourceId = `microsecond-${randomUUID()}`;
  const taskIds = [];

  afterAll(async () => {
    await setTenantTx(DEFAULT_TENANT_ID, async (tx) => {
      for (const taskId of taskIds) {
        await tx.$executeRawUnsafe(
          `DELETE FROM tasks WHERE tenant_id = $1::uuid AND id = $2::bigint`,
          DEFAULT_TENANT_ID,
          taskId,
        );
      }
      await tx.$executeRawUnsafe(
        `DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        DEFAULT_TENANT_ID,
        slaId,
      );
    }).catch(() => {});
  });

  it('preserves PostgreSQL microseconds by selecting the linked SLA deadline inside the task INSERT', async () => {
    const task = await setTenantTx(DEFAULT_TENANT_ID, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO workflow_sla_instances
         (id, tenant_id, rule_code, source_table, source_id, status, priority,
            started_at, due_at, metadata)
         VALUES ($1::uuid, $2::uuid, 'critical_result_ack', 'lab_result', $3::text,
                 'active', 'critical', '2026-07-19 05:00:00.000001+00'::timestamptz,
                 '2026-07-19 06:00:00.123456+00'::timestamptz,
                 '{"test":"typed_task_microsecond_deadline",\
                   "task_materialization_contract":"application_atomic_v1"}'::jsonb)`,
        slaId,
        DEFAULT_TENANT_ID,
        resourceId,
      );
      return createTask({
        tenantId: DEFAULT_TENANT_ID,
        tx,
        taskKind: 'review',
        title: 'Microsecond deadline binding',
        relatedResourceType: 'lab_result',
        relatedResourceId: resourceId,
        priority: 'critical',
        assignedToRole: 'DOCTOR',
        workflowSlaInstanceId: slaId,
        slaCompletionSemantics: 'acknowledgement',
        metadata: { source: 'deadline_conformance' },
      });
    });
    taskIds.push(task.id);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT task.due_at = sla.due_at AS exact_deadline,
              to_char(task.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS task_due,
              to_char(sla.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS sla_due
         FROM tasks AS task
         JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.id = $2::bigint`,
      DEFAULT_TENANT_ID,
      task.id,
    );

    expect(rows[0]).toEqual({
      exact_deadline: true,
      task_due: '2026-07-19 06:00:00.123456',
      sla_due: '2026-07-19 06:00:00.123456',
    });
  });

  it('preserves an offset deadline instant for an untyped task', async () => {
    const task = await setTenantTx(DEFAULT_TENANT_ID, (tx) => createTask({
      tenantId: DEFAULT_TENANT_ID,
      tx,
      taskKind: 'follow_up',
      title: 'Offset deadline binding',
      relatedResourceType: 'deadline_conformance',
      relatedResourceId: randomUUID(),
      dueAt: '2026-07-19T11:30:00+05:30',
      metadata: { source: 'deadline_conformance' },
    }));
    taskIds.push(task.id);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT (EXTRACT(EPOCH FROM due_at) * 1000)::bigint AS due_at_epoch_ms
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      DEFAULT_TENANT_ID,
      task.id,
    );

    expect(rows[0].due_at_epoch_ms)
      .toBe(BigInt(new Date('2026-07-19T06:00:00.000Z').getTime()));
  });
});
