import { Client } from 'pg';

import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  enqueueCriticalResultTask,
  ensureCriticalResultTaskOpen,
} from '../services/results/resultsInboxService.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import * as taskService from '../services/workflow/taskService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const d = DB_CONFIGURED ? describe : describe.skip;

const SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const PATIENT_UID = `c3100000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const DOCTOR_UID = `c3200000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
// This suite proves the generic resource-lock/rearm primitive. Lab-result
// generations additionally require an immutable per-alert acknowledgement
// receipt and a successor alert in the same transaction; that stricter rail is
// exercised through the real ACK + corrective-signoff race in
// lab-corrected-signoff-reack.deep.test.js.
const RESOURCE_TYPE = 'vital_alert';
const RESOURCE_ID = `8${SUFFIX}`;

async function waitForAdvisoryWaiters(client, blockerPid, expectedCount) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const waiting = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM pg_stat_activity activity
        WHERE $1::int = ANY(pg_blocking_pids(activity.pid))`,
      [blockerPid],
    );
    if (waiting.rows[0]?.count >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${expectedCount} resource-lock waiters`);
}

async function cleanup() {
  await setTenantTx(DEFAULT_TENANT_ID, async (tx) => {
    await tx.$executeRawUnsafe(
      `DELETE FROM task_comments
        WHERE task_id IN (
          SELECT id
            FROM tasks
           WHERE tenant_id = $1::uuid
             AND related_resource_type = $2
             AND related_resource_id = $3
        )`,
      DEFAULT_TENANT_ID,
      RESOURCE_TYPE,
      RESOURCE_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = $2
          AND related_resource_id = $3`,
      DEFAULT_TENANT_ID,
      RESOURCE_TYPE,
      RESOURCE_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND rule_code = 'critical_result_ack'
          AND source_table = $2
          AND source_id = $3`,
      DEFAULT_TENANT_ID,
      RESOURCE_TYPE,
      RESOURCE_ID,
    );
  }).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID,
    DOCTOR_UID,
  ).catch(() => {});
}

d('Results-inbox resource lock concurrency', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Resource Lock Patient [test]', 'PATIENT', true, $3::uuid, NOW()),
              ($4::uuid, $5, 'Resource Lock Doctor [test]', 'DOCTOR', true, $3::uuid, NOW())`,
      PATIENT_UID,
      `+9198111${SUFFIX}`,
      DEFAULT_TENANT_ID,
      DOCTOR_UID,
      `+9198112${SUFFIX}`,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('serializes two simultaneous reopens into one successor task and one SLA rearm', async () => {
    const initial = await enqueueCriticalResultTask({
      tenantId: DEFAULT_TENANT_ID,
      patientUid: PATIENT_UID,
      source: RESOURCE_TYPE,
      resourceType: RESOURCE_TYPE,
      resourceId: RESOURCE_ID,
      severity: 'critical',
      orderingClinicianUid: DOCTOR_UID,
    });
    expect(initial).toMatchObject({ created: true });

    const acknowledged = await taskService.acknowledgeTask({
      tenantId: DEFAULT_TENANT_ID,
      id: initial.taskId,
      actorUid: DOCTOR_UID,
      actorRoles: ['DOCTOR'],
      actorPrimaryRole: 'DOCTOR',
      actorRawRole: 'DOCTOR',
    });
    expect(acknowledged.status).toBe('in_progress');

    const blocker = new Client({ connectionString: DATABASE_URL });
    await blocker.connect();
    let committed = false;
    let reopenPromises = [];
    try {
      await blocker.query('BEGIN');
      const pidRows = await blocker.query('SELECT pg_backend_pid() AS pid');
      const blockerPid = pidRows.rows[0].pid;
      await blocker.query(
        `SELECT pg_advisory_xact_lock(
                  hashtextextended(
                    jsonb_build_array($1::text, $2::text, $3::text)::text,
                    0
                  )
                )`,
        [DEFAULT_TENANT_ID, RESOURCE_TYPE, RESOURCE_ID],
      );

      const reopen = () => ensureCriticalResultTaskOpen({
        tenantId: DEFAULT_TENANT_ID,
        patientUid: PATIENT_UID,
        source: RESOURCE_TYPE,
        resourceType: RESOURCE_TYPE,
        resourceId: RESOURCE_ID,
        severity: 'critical',
        orderingClinicianUid: DOCTOR_UID,
        reason: 'concurrent_corrected_result',
        supersededByActorUid: DOCTOR_UID,
        strict: true,
      });
      reopenPromises = [reopen(), reopen()];
      // PostgreSQL reports the first waiter as blocked by this session and may
      // report the second as queued behind that waiter. Seeing one direct
      // blocker proves both already-started service calls reached the lock
      // barrier before it is released.
      await waitForAdvisoryWaiters(blocker, blockerPid, 1);
      await blocker.query('COMMIT');
      committed = true;

      const results = await Promise.all(reopenPromises);
      const creator = results.find((result) => result.created);
      const follower = results.find((result) => !result.created);
      expect(creator).toMatchObject({
        created: true,
        reopened: true,
        supersededTaskId: initial.taskId,
        slaInstanceId: initial.slaInstanceId,
      });
      expect(follower).toMatchObject({
        created: false,
        reopened: false,
        taskId: creator.taskId,
        supersededTaskId: null,
        slaInstanceId: initial.slaInstanceId,
      });
    } finally {
      if (!committed) await blocker.query('ROLLBACK').catch(() => {});
      if (!committed) await Promise.allSettled(reopenPromises);
      await blocker.end();
    }

    const taskRows = await prisma.$queryRawUnsafe(
      `SELECT id, status, workflow_sla_instance_id, metadata
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = $2
          AND related_resource_id = $3
        ORDER BY id`,
      DEFAULT_TENANT_ID,
      RESOURCE_TYPE,
      RESOURCE_ID,
    );
    expect(taskRows).toHaveLength(2);
    expect(taskRows[0]).toMatchObject({ id: initial.taskId, status: 'completed' });
    expect(taskRows[1]).toMatchObject({
      status: 'open',
      workflow_sla_instance_id: initial.slaInstanceId,
      metadata: { reopened_from_task_id: initial.taskId },
    });

    const slaRows = await prisma.$queryRawUnsafe(
      `SELECT status, completed_at, metadata
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid`,
      DEFAULT_TENANT_ID,
      initial.slaInstanceId,
    );
    expect(slaRows).toHaveLength(1);
    expect(slaRows[0]).toMatchObject({ status: 'active', completed_at: null });
    expect(slaRows[0].metadata?.reopen_history).toHaveLength(1);
  }, 30_000);
});
