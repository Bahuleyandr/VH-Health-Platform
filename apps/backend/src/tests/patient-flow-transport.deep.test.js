import request from 'supertest';

import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';
import { runTransportEscalationSweep } from '../services/patientFlow/porterTransportService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const PATIENT_UID = `00000000-0000-4000-8000-0000000a${SUFFIX.slice(-4)}`;
const REQUESTER_UID = `00000000-0000-4000-8000-0000000b${SUFFIX.slice(-4)}`;
const PORTER_UID = `00000000-0000-4000-8000-0000000c${SUFFIX.slice(-4)}`;
const INCHARGE_UID = `00000000-0000-4000-8000-0000000d${SUFFIX.slice(-4)}`;
const TEST_MARKER = `nl8-p3-transport-${SUFFIX}`;
const SOURCE_ID = `NL8P3-${SUFFIX}`;
const ZONE_KEY = `nl8_p3_zone_${SUFFIX}`;

function client(role, { uid, id, phone }) {
  const token = generateTestToken(role, {
    uid,
    id,
    phone,
    tenant_id: TENANT,
  });
  const auth = (req) => req
    .set('x-api-key', API_KEY)
    .set('Authorization', `Bearer ${token}`);
  return {
    get: (path) => auth(request(app).get(path)),
    post: (path) => auth(request(app).post(path)),
    put: (path) => auth(request(app).put(path)),
  };
}

async function ownedTaskIds() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id::text AS id
       FROM porter_transport_tasks
      WHERE tenant_id = $1::uuid
        AND metadata->>'test' = $2`,
    TENANT,
    TEST_MARKER,
  ).catch(() => []);
  return rows.map((row) => row.id);
}

async function cleanup() {
  const ids = await ownedTaskIds();
  if (ids.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM notification_outbox
        WHERE payload->>'task_id' = ANY($1::text[])`,
      ids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM notifications
        WHERE type = 'PORTER_TRANSPORT'
          AND related_id::text = ANY($1::text[])`,
      ids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM porter_transport_task_updates
        WHERE tenant_id = $1::uuid
          AND task_id::text = ANY($2::text[])`,
      TENANT,
      ids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM porter_transport_task_recipients
        WHERE tenant_id = $1::uuid
          AND task_id::text = ANY($2::text[])`,
      TENANT,
      ids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND source_table = 'porter_transport_tasks'
          AND source_id = ANY($2::text[])`,
      TENANT,
      ids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND source_table = 'porter_transport_tasks'
          AND source_id = ANY($2::text[])`,
      TENANT,
      ids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events
        WHERE tenant_id = $1::uuid
          AND resource_table = 'porter_transport_tasks'
          AND resource_id = ANY($2::text[])`,
      TENANT,
      ids,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM porter_transport_tasks
      WHERE tenant_id = $1::uuid
        AND metadata->>'test' = $2`,
    TENANT,
    TEST_MARKER,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM staff_shift_roster_assignments
      WHERE notes = $1`,
    TEST_MARKER,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM staff_shift_roster_boards
      WHERE tenant_id = $1::uuid
        AND notes = $2`,
    TENANT,
    TEST_MARKER,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM porter_transport_zones
      WHERE tenant_id = $1::uuid
        AND zone_key = $2`,
    TENANT,
    ZONE_KEY,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM porter_transport_settings
      WHERE tenant_id = $1::uuid
        AND metadata->>'test' = $2`,
    TENANT,
    TEST_MARKER,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users
      WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
    PATIENT_UID,
    REQUESTER_UID,
    PORTER_UID,
    INCHARGE_UID,
  ).catch(() => {});
}

async function seedUser({ uid, phone, name, role }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (tenant_id, uid, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, true, NOW())
     RETURNING id`,
    TENANT,
    uid,
    phone,
    name,
    role,
  );
  return rows[0].id;
}

async function seedRoster({ porterId, zoneId }) {
  const boards = await prisma.$queryRawUnsafe(
    `INSERT INTO staff_shift_roster_boards (
       tenant_id, department, roster_date, shift_label, shift_start, shift_end,
       status, notes, created_at, updated_at
     )
     VALUES (
       $1::uuid, 'ambulance', (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
       $2, '00:00', '23:59', 'published', $3, NOW(), NOW()
     )
     RETURNING id`,
    TENANT,
    `NL8-P3-${SUFFIX}`,
    TEST_MARKER,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO staff_shift_roster_assignments (
       roster_id, staff_id, staff_uid, staff_role, assignment_target_type,
       assignment_target_id, assignment_target_label, is_lead, status, notes,
       created_at, updated_at
     )
     VALUES ($1::int, $2::int, $3::uuid, 'DRIVER', 'porter_transport_zone',
             $4::int, 'NL8 P3 transport zone', true, 'published', $5, NOW(), NOW())`,
    boards[0].id,
    porterId,
    PORTER_UID,
    zoneId,
    TEST_MARKER,
  );
}

d('NL8 P3 porter transport tasks', () => {
  let admin;
  let requester;
  let porter;
  let porterId;
  let zoneId;
  let taskId;

  beforeAll(async () => {
    await cleanup();
    await seedUser({
      uid: PATIENT_UID,
      phone: `+919100${SUFFIX}1`,
      name: 'NL8 P3 Transport Patient',
      role: 'PATIENT',
    });
    const requesterId = await seedUser({
      uid: REQUESTER_UID,
      phone: `+919100${SUFFIX}2`,
      name: 'NL8 P3 Receptionist',
      role: 'RECEPTIONIST',
    });
    porterId = await seedUser({
      uid: PORTER_UID,
      phone: `+919100${SUFFIX}3`,
      name: 'NL8 P3 Porter',
      role: 'DRIVER',
    });
    const inchargeId = await seedUser({
      uid: INCHARGE_UID,
      phone: `+919100${SUFFIX}4`,
      name: 'NL8 P3 Transport Incharge',
      role: 'RECEPTION_INCHARGE',
    });

    admin = client('ADMIN', {
      uid: INCHARGE_UID,
      id: inchargeId,
      phone: `+919100${SUFFIX}4`,
    });
    requester = client('RECEPTIONIST', {
      uid: REQUESTER_UID,
      id: requesterId,
      phone: `+919100${SUFFIX}2`,
    });
    porter = client('DRIVER', {
      uid: PORTER_UID,
      id: porterId,
      phone: `+919100${SUFFIX}3`,
    });

    const settings = await admin.put('/api/v1/patient-flow/transport/settings').send({
      enabled: true,
      roster_department: 'ambulance',
      roster_target_type: 'porter_transport_zone',
      recipient_role_codes: ['DRIVER'],
      escalation_role_codes: ['RECEPTION_INCHARGE'],
      source_sla_minutes: { sample: 20, manual: 30 },
      source_priority: { sample: 'high', manual: 'medium' },
      metadata: { test: TEST_MARKER },
    });
    expect(settings.statusCode).toBe(200);

    const zone = await admin.put(`/api/v1/patient-flow/transport/zones/${ZONE_KEY}`).send({
      name: 'NL8 P3 transport zone',
      zone_type: 'lab',
      role_codes: ['DRIVER'],
      metadata: { test: TEST_MARKER },
    });
    expect(zone.statusCode).toBe(200);
    zoneId = zone.body.data.zone.id;
    await seedRoster({ porterId, zoneId });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  test('creates, escalates, accepts, picks up, and completes an atomic transport task', async () => {
    const created = await requester.post('/api/v1/patient-flow/transport/tasks').send({
      source_type: 'sample',
      source_id: SOURCE_ID,
      patient_uid: PATIENT_UID,
      pickup_zone_id: zoneId,
      pickup_label: 'Lab sample counter',
      destination_label: 'Main laboratory',
      mobility_notes: { assistance: 'wheelchair' },
      infection_flags: { isolation: false },
      metadata: { test: TEST_MARKER },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body.data.task.status).toBe('assigned');
    expect(created.body.data.task.patient_uid).toBe(PATIENT_UID);
    expect(created.body.data.recipients.some((row) => row.source === 'published_roster')).toBe(true);
    taskId = created.body.data.task.id;

    const duplicate = await requester.post('/api/v1/patient-flow/transport/tasks').send({
      source_type: 'sample',
      source_id: SOURCE_ID,
      patient_uid: PATIENT_UID,
      pickup_label: 'Lab sample counter',
      destination_label: 'Main laboratory',
      metadata: { test: TEST_MARKER },
    });
    expect(duplicate.statusCode).toBe(409);

    const past = new Date(Date.now() - 120_000);
    const now = new Date(Date.now() + 60_000);
    await prisma.$executeRawUnsafe(
      `UPDATE porter_transport_tasks
          SET sla_due_at = $3::timestamptz
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      TENANT,
      taskId,
      past.toISOString(),
    );
    await prisma.$executeRawUnsafe(
      `UPDATE workflow_sla_instances
          SET due_at = $3::timestamptz,
              status = 'active',
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND source_table = 'porter_transport_tasks'
          AND source_id = $2`,
      TENANT,
      String(taskId),
      past.toISOString(),
    );
    const escalated = await runTransportEscalationSweep({ now, limit: 10 });
    expect(escalated.breached).toBeGreaterThanOrEqual(1);

    const breached = await prisma.$queryRawUnsafe(
      `SELECT status, breached_at
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND source_table = 'porter_transport_tasks'
          AND source_id = $2
        LIMIT 1`,
      TENANT,
      String(taskId),
    );
    expect(breached[0].status).toBe('breached');
    expect(breached[0].breached_at).toBeTruthy();

    const myTasks = await porter.get('/api/v1/patient-flow/transport/tasks/my');
    expect(myTasks.statusCode).toBe(200);
    expect(myTasks.body.data.tasks.some((task) => task.id === taskId)).toBe(true);

    const accepted = await porter.post(`/api/v1/patient-flow/transport/tasks/${taskId}/accept`).send({
      message: 'Accepted by porter',
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body.data.task.status).toBe('accepted');

    const pickedUp = await porter.post(`/api/v1/patient-flow/transport/tasks/${taskId}/pickup`).send({
      location_text: 'Sample counter',
    });
    expect(pickedUp.statusCode).toBe(200);
    expect(pickedUp.body.data.task.status).toBe('picked_up');

    const completed = await porter.post(`/api/v1/patient-flow/transport/tasks/${taskId}/complete`).send({
      location_text: 'Main laboratory',
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.body.data.task.status).toBe('completed');

    const finalSla = await prisma.$queryRawUnsafe(
      `SELECT status, completed_at
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND source_table = 'porter_transport_tasks'
          AND source_id = $2
        LIMIT 1`,
      TENANT,
      String(taskId),
    );
    expect(finalSla[0].status).toBe('completed');
    expect(finalSla[0].completed_at).toBeTruthy();

    const canonical = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id = $1::uuid
             AND source_table = 'porter_transport_tasks'
             AND source_id = $2) AS timeline_count,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE tenant_id = $1::uuid
             AND resource_table = 'porter_transport_tasks'
             AND resource_id = $2) AS audit_count,
         (SELECT COUNT(*)::int FROM notification_outbox
           WHERE payload->>'task_id' = $2) AS outbox_count`,
      TENANT,
      String(taskId),
    );
    expect(canonical[0].timeline_count).toBeGreaterThanOrEqual(4);
    expect(canonical[0].audit_count).toBeGreaterThanOrEqual(4);
    expect(canonical[0].outbox_count).toBeGreaterThanOrEqual(1);
  });
});
