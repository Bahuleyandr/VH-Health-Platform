// Phase-3 deep-review fix B-L5 — porter transport trust boundaries, proven
// against a real DB:
//
//   (a) Completion and receiving-handoff verification are distinct actions:
//       the porter cannot self-verify, and the verifier comes from the
//       authenticated receiving staff identity rather than the request body.
//   (b) Cancellation is no longer open to the whole transport role union:
//       only the requester who raised the job or a coordination/escalation
//       role may cancel; the porter executing the job cannot.

import { randomUUID } from 'crypto';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const prisma = (await import('../lib/prisma.js')).default;
const {
  completeTransportTask,
  cancelTransportTask,
  verifyTransportTask,
} = await import('../services/patientFlow/porterTransportService.js');
const {
  PATIENT_TRANSPORT_VERIFY_ROUTE_ROLES,
} = await import('../config/routeRolePolicy.js');
const { deleteWithAuditBypass } = await import('./helpers/auditBypass.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const TEST_MARKER = `bl5-transport-${SUFFIX}`;

const PATIENT_UID = randomUUID();
const REQUESTER_UID = randomUUID();
const PORTER_UID = randomUUID();
const INCHARGE_UID = randomUUID();
const BYSTANDER_NURSE_UID = randomUUID();

let porterId;
let nurseId;

function phone() {
  return `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

async function seedUser({ uid, role, name }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, $5::uuid, NOW())
     RETURNING id`,
    uid, phone(), name, role, TENANT,
  );
  return rows[0].id;
}

async function seedTask({ status = 'accepted' } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO porter_transport_tasks
       (tenant_id, source_type, source_id, patient_uid,
        pickup_label, destination_label,
        requested_by, assigned_porter_uid, assigned_porter_id,
        status, assigned_at, accepted_at, accepted_by, metadata)
     VALUES ($1::uuid, 'manual', $2, $3::uuid,
             'Ward A', 'Radiology',
             $4::uuid, $5::uuid, $6::int,
             $7::varchar, NOW(), CASE WHEN $7::varchar = 'accepted' THEN NOW() ELSE NULL END,
             CASE WHEN $7::varchar = 'accepted' THEN $5::uuid ELSE NULL END,
             jsonb_build_object('test', $8::text))
     RETURNING id`,
    TENANT, `BL5-${randomUUID().slice(0, 12)}`, PATIENT_UID,
    REQUESTER_UID, PORTER_UID, porterId,
    status, TEST_MARKER,
  );
  return Number(rows[0].id);
}

async function cleanup() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id::text AS id FROM porter_transport_tasks
      WHERE tenant_id = $1::uuid AND metadata->>'test' = $2`,
    TENANT, TEST_MARKER,
  ).catch(() => []);
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM porter_transport_task_updates
        WHERE tenant_id = $1::uuid AND task_id::text = ANY($2::text[])`,
      TENANT, ids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid AND source_table = 'porter_transport_tasks'
          AND source_id = ANY($2::text[])`,
      TENANT, ids,
    ).catch(() => {});
    await deleteWithAuditBypass(
      prisma,
      `DELETE FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid AND source_table = 'porter_transport_tasks'
          AND source_id = ANY($2::text[])`,
      TENANT, ids,
    ).catch(() => {});
    await deleteWithAuditBypass(
      prisma,
      `DELETE FROM clinical_audit_events
        WHERE tenant_id = $1::uuid AND resource_table = 'porter_transport_tasks'
          AND resource_id = ANY($2::text[])`,
      TENANT, ids,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM porter_transport_tasks
      WHERE tenant_id = $1::uuid AND metadata->>'test' = $2`,
    TENANT, TEST_MARKER,
  ).catch(() => {});
  for (const uid of [PATIENT_UID, REQUESTER_UID, PORTER_UID, INCHARGE_UID, BYSTANDER_NURSE_UID]) {
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, uid).catch(() => {});
  }
}

d('B-L5 porter transport trust boundaries (deep)', () => {
  beforeAll(async () => {
    await cleanup();
    await seedUser({ uid: PATIENT_UID, role: 'PATIENT', name: 'BL5 Patient' });
    await seedUser({ uid: REQUESTER_UID, role: 'RECEPTIONIST', name: 'BL5 Requester' });
    porterId = await seedUser({ uid: PORTER_UID, role: 'DRIVER', name: 'BL5 Porter' });
    await seedUser({ uid: INCHARGE_UID, role: 'RECEPTION_INCHARGE', name: 'BL5 Incharge' });
    nurseId = await seedUser({ uid: BYSTANDER_NURSE_UID, role: 'IP_STAFF_NURSE', name: 'BL5 Nurse' });
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 60_000);

  // ── (a) completion and handoff verification are distinct ─────────────────

  it('completion records the porter but ignores body-supplied verifier identities', async () => {
    const taskId = await seedTask({ status: 'accepted' });

    const task = await completeTransportTask({
      tenantId: TENANT,
      taskId,
      actorUid: PORTER_UID,
      actorRole: 'DRIVER',
      body: {
        // Attacker-controlled: claims a ward nurse verified the handoff.
        verified_by: BYSTANDER_NURSE_UID,
        verifier_id: nurseId,
        location_text: 'Radiology',
      },
    });

    expect(task.status).toBe('completed');
    expect(task.completed_by).toBe(PORTER_UID);
    expect(task.verified_by).toBeNull();
    expect(task.verifier_id).toBeNull();
    expect(task.verified_by).not.toBe(BYSTANDER_NURSE_UID);
  }, 60_000);

  it('the porter who completed the task cannot verify their own handoff', async () => {
    const taskId = await seedTask({ status: 'accepted' });
    await completeTransportTask({
      tenantId: TENANT,
      taskId,
      actorUid: PORTER_UID,
      actorRole: 'DRIVER',
    });

    await expect(verifyTransportTask({
      tenantId: TENANT,
      taskId,
      actorUid: PORTER_UID,
      actorRole: 'DRIVER',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'TRANSPORT_INDEPENDENT_VERIFIER_REQUIRED',
    });
  }, 60_000);

  it('authenticated receiving staff verifies after completion and body spoofing is ignored', async () => {
    const taskId = await seedTask({ status: 'accepted' });
    await completeTransportTask({
      tenantId: TENANT,
      taskId,
      actorUid: PORTER_UID,
      actorRole: 'DRIVER',
    });

    const task = await verifyTransportTask({
      tenantId: TENANT,
      taskId,
      actorUid: BYSTANDER_NURSE_UID,
      actorRole: 'IP_STAFF_NURSE',
      body: {
        verified_by: REQUESTER_UID,
        verifier_id: porterId,
        location_text: 'Radiology reception',
      },
    });

    expect(task.status).toBe('completed');
    expect(task.completed_by).toBe(PORTER_UID);
    expect(task.verified_by).toBe(BYSTANDER_NURSE_UID);
    expect(Number(task.verifier_id)).toBe(Number(nurseId));
    expect(task.verified_by).not.toBe(REQUESTER_UID);

    const retried = await verifyTransportTask({
      tenantId: TENANT,
      taskId,
      actorUid: BYSTANDER_NURSE_UID,
      actorRole: 'IP_STAFF_NURSE',
    });
    expect(retried.verified_by).toBe(BYSTANDER_NURSE_UID);

    await expect(verifyTransportTask({
      tenantId: TENANT,
      taskId,
      actorUid: INCHARGE_UID,
      actorRole: 'RECEPTION_INCHARGE',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'TRANSPORT_HANDOFF_ALREADY_VERIFIED',
    });

    const evidence = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM porter_transport_task_updates
           WHERE tenant_id = $1::uuid AND task_id = $2::bigint
             AND metadata->>'handoff_verified' = 'true') AS task_updates,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id = $1::uuid AND source_table = 'porter_transport_tasks'
             AND source_id = $2::text AND event_subtype = 'verified') AS timeline,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE tenant_id = $1::uuid AND resource_table = 'porter_transport_tasks'
             AND resource_id = $2::text AND action = 'porter_transport.verified') AS audit`,
      TENANT,
      String(taskId),
    );
    expect(evidence[0]).toMatchObject({ task_updates: 1, timeline: 1, audit: 1 });
  }, 60_000);

  it('the service rejects an active non-receiving role even if its caller role is spoofed', async () => {
    const taskId = await seedTask({ status: 'accepted' });
    await completeTransportTask({
      tenantId: TENANT,
      taskId,
      actorUid: PORTER_UID,
      actorRole: 'DRIVER',
    });

    await expect(verifyTransportTask({
      tenantId: TENANT,
      taskId,
      actorUid: REQUESTER_UID,
      actorRole: 'IP_STAFF_NURSE',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'TRANSPORT_VERIFIER_ROLE_REQUIRED',
    });
  }, 60_000);

  it('handoff verification is unavailable before the porter completes the task', async () => {
    const taskId = await seedTask({ status: 'accepted' });

    await expect(verifyTransportTask({
      tenantId: TENANT,
      taskId,
      actorUid: BYSTANDER_NURSE_UID,
      actorRole: 'IP_STAFF_NURSE',
    })).rejects.toMatchObject({ statusCode: 400 });
  }, 60_000);

  it('the verification route admits receiving staff but excludes porter execution roles', () => {
    expect(PATIENT_TRANSPORT_VERIFY_ROUTE_ROLES).toContain('IP_STAFF_NURSE');
    expect(PATIENT_TRANSPORT_VERIFY_ROUTE_ROLES).not.toContain('DRIVER');
    expect(PATIENT_TRANSPORT_VERIFY_ROUTE_ROLES).not.toContain('DELIVERY_STAFF');
    expect(PATIENT_TRANSPORT_VERIFY_ROUTE_ROLES).not.toContain('EMERGENCY_RESPONDER');
  });

  // ── (b) cancellation restricted to requester + coordination roles ─────────

  it('the assigned porter cannot cancel the task (403 TRANSPORT_CANCEL_ROLE_REQUIRED)', async () => {
    const taskId = await seedTask({ status: 'accepted' });

    await expect(
      cancelTransportTask({
        tenantId: TENANT,
        taskId,
        actorUid: PORTER_UID,
        actorRole: 'DRIVER',
        body: { reason: 'porter tries to drop the job' },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'TRANSPORT_CANCEL_ROLE_REQUIRED',
    });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT status FROM porter_transport_tasks WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT, taskId,
    );
    expect(rows[0].status).toBe('accepted');
  }, 60_000);

  it('a random transport-union role that did not raise the job cannot cancel it', async () => {
    const taskId = await seedTask({ status: 'assigned' });

    await expect(
      cancelTransportTask({
        tenantId: TENANT,
        taskId,
        actorUid: BYSTANDER_NURSE_UID,
        actorRole: 'IP_STAFF_NURSE',
        body: { reason: 'not my job to cancel' },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'TRANSPORT_CANCEL_ROLE_REQUIRED',
    });
  }, 60_000);

  it('the requester who raised the job can cancel it', async () => {
    const taskId = await seedTask({ status: 'assigned' });

    const task = await cancelTransportTask({
      tenantId: TENANT,
      taskId,
      actorUid: REQUESTER_UID,
      actorRole: 'RECEPTIONIST',
      body: { reason: 'patient no longer needs transport' },
    });
    expect(task.status).toBe('cancelled');
    expect(task.cancelled_by).toBe(REQUESTER_UID);
  }, 60_000);

  it('a coordination/escalation role (RECEPTION_INCHARGE) can cancel a job it did not raise', async () => {
    const taskId = await seedTask({ status: 'accepted' });

    const task = await cancelTransportTask({
      tenantId: TENANT,
      taskId,
      actorUid: INCHARGE_UID,
      actorRole: 'RECEPTION_INCHARGE',
      body: { reason: 'duplicate request' },
    });
    expect(task.status).toBe('cancelled');
    expect(task.cancelled_by).toBe(INCHARGE_UID);
  }, 60_000);
});
