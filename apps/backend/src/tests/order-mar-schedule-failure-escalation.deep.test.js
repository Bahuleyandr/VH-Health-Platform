// BE-H1 (review 2026-08-09) — deep regression: a medication order that
// commits while MAR scheduling fails must leave DURABLE detectors, not just
// a log line.
//
// createOrder commits the order, then the post-commit hook
// dispatchOrderIntegrations expands the schedule; C-L3 made expandSchedule
// throw MAR_DURATION_EXCEEDS_WINDOW for over-window durations, so a
// duration_days beyond the MAR window is a deterministic way to make MAR
// scheduling fail AFTER the order stands. The escalation contract:
//   * the order still exists (post-commit — it must stand),
//   * zero scheduled doses exist for it,
//   * a clinical_audit_events row exists with action_status 'failed' and the
//     deterministic idempotency key clinical_orders:<id>:mar_schedule_failed,
//   * a notification_outbox alert row exists with source_event_key
//     clinical_orders:<id>:mar_schedule_failed:alert.
//
// Needs the test Postgres (DATABASE_URL / TEST_DATABASE_URL, default
// 127.0.0.1:55432 db vhhealth_test). Self-skips when unconfigured.

import { randomUUID } from 'crypto';

import prisma from '../lib/prisma.js';
import { createOrder } from '../services/emr/orderEntryService.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = DEFAULT_TENANT_ID;
const PATIENT_UID = randomUUID();
const DOCTOR_UID = randomUUID();

let phoneSequence = 0;
function nextPhone() {
  phoneSequence += 1;
  return `+9187${String(Date.now()).slice(-7)}${phoneSequence}`;
}

async function seedUser(uid, role, name) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, $5::uuid, NOW()) RETURNING id`,
    uid, nextPhone(), name, role, TENANT,
  );
  return rows[0].id;
}

// The escalation runs on an un-awaited post-commit promise chain (the MAR
// dispatch is deliberately not awaited for medication orders), so poll
// briefly instead of asserting immediately.
async function pollForRows(sql, params, { attempts = 40, delayMs = 250 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const rows = await prisma.$queryRawUnsafe(sql, ...params);
    if (rows.length) return rows;
    await new Promise((resolve) => { setTimeout(resolve, delayMs); });
  }
  return [];
}

async function cleanup() {
  const orderIds = await prisma.$queryRawUnsafe(
    `SELECT id FROM clinical_orders WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => []);
  for (const { id } of orderIds) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM notification_outbox WHERE source_event_key LIKE $1`, `clinical_orders:${id}:%`,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_safety_reviews WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_administrations WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID,
  ).catch(() => {});
}

d('BE-H1 — MAR scheduling failure on a committed medication order escalates durably', () => {
  beforeAll(async () => {
    await cleanup();
    await seedUser(PATIENT_UID, 'PATIENT', 'MAR Escalation Patient');
    await seedUser(DOCTOR_UID, 'DOCTOR', 'MAR Escalation Doctor');
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('order commits, zero MAR doses, and BOTH durable detectors exist', async () => {
    const { order } = await createOrder({
      tenantId: TENANT,
      patient_uid: PATIENT_UID,
      order_type: 'medication',
      priority: 'routine',
      ordered_by: DOCTOR_UID,
      details: {
        medication_name: `Escalatol-${randomUUID().slice(0, 8)}`,
        dose: '500mg',
        route: 'oral',
        frequency: 'BD',
        // Deterministically beyond every MAR scheduling window -> C-L3 throw
        // in the post-commit hook, i.e. order committed + zero doses.
        duration_days: 4000,
      },
    });

    expect(order?.id).toBeTruthy();

    // Durable detector #1 — the failed clinical audit row.
    const auditRows = await pollForRows(
      `SELECT action, action_status, resource_table, resource_id, metadata
         FROM clinical_audit_events
        WHERE idempotency_key = $1`,
      [`clinical_orders:${order.id}:mar_schedule_failed`],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'mar_scheduling_failed',
      action_status: 'failed',
      resource_table: 'clinical_orders',
      resource_id: String(order.id),
    });
    expect(auditRows[0].metadata).toMatchObject({
      failure_stage: 'mar_schedule',
      error_code: 'MAR_DURATION_EXCEEDS_WINDOW',
    });

    // Durable detector #2 — the staff alert in the notification outbox.
    const outboxRows = await pollForRows(
      `SELECT status, channel, title, payload
         FROM notification_outbox
        WHERE tenant_id = $1::uuid AND source_event_key = $2`,
      [TENANT, `clinical_orders:${order.id}:mar_schedule_failed:alert`],
    );
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].status).toBe('PENDING');
    expect(outboxRows[0].title).toMatch(/no scheduled mar doses/i);

    // The failure really did leave zero scheduled doses for this order.
    const marRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM medication_administrations WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    expect(marRows).toHaveLength(0);

    // And the order row itself stands (post-commit hook must not undo it).
    const orderRows = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM clinical_orders WHERE id = $1::int`,
      order.id,
    );
    expect(orderRows).toHaveLength(1);
  }, 30_000);
});
