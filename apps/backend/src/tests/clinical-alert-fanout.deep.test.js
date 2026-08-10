// src/tests/clinical-alert-fanout.deep.test.js
//
// R2 residual (audit 2026-08-10) — broadcast clinical alerts must reach
// CONCRETE recipients. The notification outbox has no topic delivery: a row
// queued with recipientId:null gets a `broadcast:` recipient key nothing can
// deliver, so STAT-order / integration-failure / pre-eclampsia alerts went
// nowhere. queueClinicalAlertFanout resolves the duty-doctor audience at
// enqueue time and queues one immutable outbox intent per clinician.
import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';

import prisma from '../lib/prisma.js';
import {
  queueClinicalAlertFanout,
  resolveClinicalAlertRecipients,
} from '../utils/notifications/clinicalAlertFanout.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const TENANT_EMPTY = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);

const DUTY_1 = randomUUID();
const DUTY_2 = randomUUID();
const SENIOR_B = randomUUID();
const NURSE_A = randomUUID();

async function seedUser(uid, tenantId, role, phoneTail) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at, last_sign_in_at)
     VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, true, NOW(), NOW())`,
    uid, tenantId, `96${phoneTail}${SUFFIX.slice(0, 8)}`, `Fanout ${role} ${phoneTail}`, role,
  );
}

async function outboxRowsFor(tenantId, sourceEventKey) {
  return prisma.$queryRawUnsafe(
    `SELECT id, recipient_id, recipient_key, channel, status, payload
       FROM notification_outbox
      WHERE tenant_id = $1::uuid AND source_event_key = $2::text
      ORDER BY id`,
    tenantId, sourceEventKey,
  );
}

describeIfDb('R2 — broadcast clinical_alert duty-role fan-out', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $4::text, 'Fanout tenant A'),
              ($2::uuid, $5::text, 'Fanout tenant B'),
              ($3::uuid, $6::text, 'Fanout tenant empty')`,
      TENANT_A, TENANT_B, TENANT_EMPTY,
      `fanout-a-${SUFFIX}`, `fanout-b-${SUFFIX}`, `fanout-e-${SUFFIX}`,
    );
    await seedUser(DUTY_1, TENANT_A, 'DUTY_DOCTOR', '11');
    await seedUser(DUTY_2, TENANT_A, 'DUTY_DOCTOR', '12');
    await seedUser(NURSE_A, TENANT_A, 'NURSING_STAFF', '13');
    await seedUser(SENIOR_B, TENANT_B, 'CONSULTANT', '14');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('(b) a broadcast clinical_alert reaches every concrete duty-doctor recipient', async () => {
    const sourceEventKey = `fanout:${SUFFIX}:stat`;
    const result = await queueClinicalAlertFanout({
      type: 'push',
      tenantId: TENANT_A,
      title: 'STAT Order',
      body: 'STAT medication order ORD-1 for patient',
      data: { source_event_key: sourceEventKey, order_id: 1 },
      channel: 'clinical_alert',
    }, { strict: true });

    expect(result).toMatchObject({ resolved: 2, queued: 2 });
    const rows = await outboxRowsFor(TENANT_A, sourceEventKey);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('PENDING');
      expect(row.channel).toBe('push');
      expect(row.recipient_id).not.toBeNull();
      expect(row.recipient_key.startsWith('id:')).toBe(true); // never broadcast:
      expect(row.payload.recipient_role).toBe('DUTY_DOCTOR');
    }
    // The nurse is not in the fan-out audience.
    const recipientIds = rows.map(r => String(r.recipient_id));
    const nurse = await prisma.$queryRawUnsafe(
      `SELECT id FROM users WHERE uid = $1::uuid`, NURSE_A,
    );
    expect(recipientIds).not.toContain(String(nurse[0].id));

    // Re-running the same fan-out dedupes per recipient (immutable intents).
    const rerun = await queueClinicalAlertFanout({
      type: 'push',
      tenantId: TENANT_A,
      title: 'STAT Order',
      body: 'STAT medication order ORD-1 for patient',
      data: { source_event_key: sourceEventKey, order_id: 1 },
      channel: 'clinical_alert',
    }, { strict: true });
    expect(rerun.queued).toBe(2);
    expect(await outboxRowsFor(TENANT_A, sourceEventKey)).toHaveLength(2);
  }, 60_000);

  test('falls back to the doctor-tier family when nobody holds DUTY_DOCTOR', async () => {
    const recipients = await resolveClinicalAlertRecipients(TENANT_B);
    expect(recipients).toHaveLength(1);
    expect(recipients[0].role).toBe('CONSULTANT');

    const sourceEventKey = `fanout:${SUFFIX}:family`;
    const result = await queueClinicalAlertFanout({
      type: 'push',
      tenantId: TENANT_B,
      title: 'MAR scheduling failed',
      body: 'No doses are on the drug chart.',
      data: { source_event_key: sourceEventKey },
      channel: 'clinical_alert',
    }, { strict: true });
    expect(result).toMatchObject({ resolved: 1, queued: 1 });
    const rows = await outboxRowsFor(TENANT_B, sourceEventKey);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.recipient_role).toBe('CONSULTANT');
  }, 60_000);

  test('strict mode throws loudly when a tenant has no clinical audience at all', async () => {
    await expect(queueClinicalAlertFanout({
      type: 'push',
      tenantId: TENANT_EMPTY,
      title: 'STAT Order',
      body: 'STAT order for patient',
      data: { source_event_key: `fanout:${SUFFIX}:empty` },
      channel: 'clinical_alert',
    }, { strict: true })).rejects.toThrow(/zero active clinical recipients/);
    // Non-strict reports the failure without throwing.
    await expect(queueClinicalAlertFanout({
      type: 'push',
      tenantId: TENANT_EMPTY,
      title: 'STAT Order',
      body: 'STAT order for patient',
      data: { source_event_key: `fanout:${SUFFIX}:empty` },
      channel: 'clinical_alert',
    })).resolves.toEqual({ resolved: 0, queued: 0 });
  }, 60_000);

  test('strict mode rejects a partial fan-out so the safe retry can fill the gap', async () => {
    const queue = jest.fn()
      .mockResolvedValueOnce({ id: 1 })
      .mockRejectedValueOnce(new Error('forced queue failure'));
    await expect(queueClinicalAlertFanout({
      type: 'push',
      tenantId: TENANT_A,
      title: 'Partial fan-out',
      body: 'Every recipient must queue',
      data: { source_event_key: `fanout:${SUFFIX}:partial` },
      channel: 'clinical_alert',
    }, {
      strict: true,
      outbox: { queue },
      resolveRecipients: async () => [
        { id: 1, role: 'DUTY_DOCTOR' },
        { id: 2, role: 'DUTY_DOCTOR' },
      ],
    })).rejects.toThrow('queued 1 of 2 notifications');
  });
});
