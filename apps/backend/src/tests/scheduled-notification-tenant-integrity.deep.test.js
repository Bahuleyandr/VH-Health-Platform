import { randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../lib/prisma.js';
import { processPendingScheduledNotifications } from '../utils/notifications/appointmentReminderJob.js';

const fixtures = [];

async function createTenantRecipient(label) {
  const tenantId = randomUUID();
  const uid = randomUUID();
  const slug = `scheduled-owner-${label}-${randomUUID().slice(0, 8)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name, status, settings)
     VALUES ($1::uuid, $2::text, $3::text, 'active', '{}'::jsonb)`,
    tenantId,
    slug,
    `Scheduled owner ${label}`,
  );
  const [user] = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, tenant_id, name, role, is_active, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::text, 'PATIENT', true, NOW())
     RETURNING id`,
    uid,
    tenantId,
    `Scheduled ${label} recipient`,
  );
  fixtures.push({ tenantId, userId: user.id });
  return { tenantId, userId: user.id };
}

async function insertDue(tenantId, userId, appointmentId) {
  const [row] = await setTenantTx(tenantId, tx => tx.$queryRawUnsafe(
    `INSERT INTO scheduled_notifications
       (tenant_id, user_id, type, data, send_at, status)
     VALUES ($1::uuid, $2::integer, 'feedback_request', $3::jsonb,
             NOW() - INTERVAL '1 minute', 'pending')
     RETURNING id`,
    tenantId,
    userId,
    JSON.stringify({ appointment_id: appointmentId, survey: 'nps' }),
  ));
  return row.id;
}

afterAll(async () => {
  for (const fixture of fixtures) {
    await setTenantTx(fixture.tenantId, async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM notification_outbox WHERE tenant_id = $1::uuid`,
        fixture.tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM scheduled_notifications WHERE tenant_id = $1::uuid`,
        fixture.tenantId,
      );
    }).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE tenant_id = $1::uuid`,
      fixture.tenantId,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id = $1::uuid`,
      fixture.tenantId,
    ).catch(() => {});
  }
  await prisma.$disconnect().catch(() => {});
}, 30000);

describe('scheduled notification composite tenant ownership', () => {
  it('rejects a recipient from another tenant', async () => {
    const tenantA = await createTenantRecipient('a');
    const tenantB = await createTenantRecipient('b');

    await expect(setTenantTx(tenantA.tenantId, tx => tx.$executeRawUnsafe(
      `INSERT INTO scheduled_notifications
         (tenant_id, user_id, type, data, send_at, status)
       VALUES ($1::uuid, $2::integer, 'feedback_request', '{}'::jsonb, NOW(), 'pending')`,
      tenantA.tenantId,
      tenantB.userId,
    ))).rejects.toBeDefined();

    const constraints = await prisma.$queryRawUnsafe(
      `SELECT conname, convalidated
         FROM pg_constraint
        WHERE conrelid = 'public.scheduled_notifications'::regclass
          AND conname = 'scheduled_notifications_tenant_user_fk'`,
    );
    expect(constraints).toEqual([
      { conname: 'scheduled_notifications_tenant_user_fk', convalidated: true },
    ]);
  }, 30000);

  it('processes one tenant without claiming the other tenant schedule', async () => {
    const tenantA = fixtures[0] || await createTenantRecipient('a-process');
    const tenantB = fixtures[1] || await createTenantRecipient('b-process');
    const idA = await insertDue(tenantA.tenantId, tenantA.userId, 'tenant-a');
    const idB = await insertDue(tenantB.tenantId, tenantB.userId, 'tenant-b');

    const result = await processPendingScheduledNotifications({ tenantId: tenantA.tenantId });
    expect(result).toMatchObject({ due: 1, queued: 1 });

    const [stateA] = await setTenantTx(tenantA.tenantId, tx => tx.$queryRawUnsafe(
      `SELECT status FROM scheduled_notifications
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      tenantA.tenantId,
      idA,
    ));
    const [stateB] = await setTenantTx(tenantB.tenantId, tx => tx.$queryRawUnsafe(
      `SELECT status FROM scheduled_notifications
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      tenantB.tenantId,
      idB,
    ));
    expect(stateA.status).toBe('queued');
    expect(stateB.status).toBe('pending');
  }, 30000);
});
