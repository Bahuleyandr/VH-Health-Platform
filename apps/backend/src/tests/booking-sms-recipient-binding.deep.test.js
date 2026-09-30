import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';

import prisma, { setTenant } from '../lib/prisma.js';
import { notificationOutbox } from '../utils/notifications/notificationOutbox.js';

const sendSmsMock = jest.fn();
jest.unstable_mockModule('../services/smsService.js', () => ({ sendSMS: sendSmsMock }));
const { deliverNotificationOutboxRow } = await import('../utils/notifications/notificationOutboxDelivery.js');

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const previousRls = process.env.AUTH_ENFORCE_TENANT_RLS;
const previousRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
const PHONE = '+919000000001';
const NEXT_PHONE = '+919000000002';
let fixture;

async function createFixture() {
  const tenantId = randomUUID();
  const patientUid = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2::text, 'SMS binding test')`,
    tenantId, `sms-binding-${tenantId}`,
  );
  const [patient] = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::text, 'Synthetic SMS patient', 'PATIENT', true, NOW())
     RETURNING id::text`,
    patientUid, tenantId, PHONE,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, tenant_id, name, role, updated_at)
     VALUES ($1::uuid, $2::uuid, 'Synthetic survivor', 'PATIENT', NOW())`,
    randomUUID(), tenantId,
  );
  const [booking] = await prisma.$queryRawUnsafe(
    `INSERT INTO investigation_bookings
       (tenant_id, patient_id, patient_phone, status, selected_tests, actual_tests)
     VALUES ($1::uuid, $2::integer, $3::text, 'CONFIRMED', '{}'::integer[], '{}'::integer[])
     RETURNING id::text`,
    tenantId, patient.id, NEXT_PHONE,
  );
  return { tenantId, patientUid, patientId: patient.id, bookingId: booking.id };
}

function intent(overrides = {}) {
  return {
    tenantId: fixture.tenantId,
    type: 'sms', channel: 'sms',
    sourceEventKey: `investigation-booking-confirmed:${fixture.bookingId}`,
    templateVersion: 'sms.investigation_booking_confirmed.v1',
    recipientId: fixture.patientId,
    recipientPhone: PHONE,
    title: 'Synthetic booking confirmation',
    body: 'Synthetic test message.',
    data: { type: 'investigation_confirmed', booking_id: fixture.bookingId },
    ...overrides,
  };
}

async function claim(queued) {
  expect(queued).toMatchObject({ status: 'PENDING' });
  const claims = await notificationOutbox.claimPendingBatch({ tenantId: fixture.tenantId, limit: 10 });
  expect(claims).toHaveLength(1);
  expect(String(claims[0].id)).toBe(String(queued.id));
  return claims[0];
}

async function receipts(id) {
  return setTenant(fixture.tenantId, tx => tx.$queryRawUnsafe(
    `SELECT outcome, provider_code, evidence FROM notification_provider_receipts
      WHERE tenant_id = $1::uuid AND notification_outbox_id = $2::integer`,
    fixture.tenantId, id,
  ));
}

describeIfDb('booking SMS recipient binding under the runtime tenant role', () => {
  beforeAll(async () => {
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_app';
    const roles = await prisma.$queryRawUnsafe(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'vhhealth_app'`,
    );
    expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    fixture = await createFixture();
    sendSmsMock.mockReset();
    sendSmsMock.mockResolvedValue({
      outcome: 'acknowledged', providerReference: randomUUID(),
      providerCode: 'accepted', evidence: {},
    });
  });

  afterAll(async () => {
    if (previousRls === undefined) delete process.env.AUTH_ENFORCE_TENANT_RLS;
    else process.env.AUTH_ENFORCE_TENANT_RLS = previousRls;
    if (previousRole === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = previousRole;
  });

  test.each(['id', 'uid'])('delivers the active patient by %s, preserving equivalent phone formats and immutable text', async kind => {
    const [context] = await setTenant(fixture.tenantId, tx => tx.$queryRawUnsafe(
      `SELECT current_user AS role, current_setting('app.current_tenant_id') AS tenant_id`,
    ));
    expect(context).toEqual({ role: 'vhhealth_app', tenant_id: fixture.tenantId });
    const request = intent({
      recipientId: kind === 'uid' ? fixture.patientUid.toUpperCase() : fixture.patientId,
      recipientPhone: '09000000001',
    });
    const row = await claim(await notificationOutbox.queue(request, { strict: true }));
    const result = await deliverNotificationOutboxRow(row);
    expect(result).toMatchObject({ outcome: 'acknowledged', terminal: false });
    expect(sendSmsMock).toHaveBeenCalledWith(
      request.recipientPhone, `${request.title}: ${request.body}`,
      { tenantId: fixture.tenantId, templateVersion: request.templateVersion, outboxId: row.id },
    );
    expect(await receipts(row.id)).toEqual([expect.objectContaining({
      outcome: 'acknowledged', provider_code: 'accepted',
    })]);
    expect(await notificationOutbox.markSent(row.id, {
      tenantId: fixture.tenantId, claimToken: row.claim_token, claimGeneration: row.claim_generation,
    })).toMatchObject({ status: 'SENT' });
  });

  test.each([
    ['phone changed', `phone = '+919000000002'`],
    ['inactive', 'is_active = false'],
    ['deleted flag', 'is_deleted = true'],
    ['deleted timestamp', 'deleted_at = NOW()'],
    ['inactive status', "status = 'inactive'"],
    ['merged pointer', `merged_into_uid = (SELECT uid FROM users WHERE tenant_id = $1::uuid AND uid <> $2::uuid ORDER BY id LIMIT 1)`],
    ['merged timestamp', 'merged_at = NOW()'],
    ['non-patient role', "role = 'NURSE'"],
  ])('rejects a queued recipient after %s without contacting the provider', async (_label, update) => {
    const queued = await notificationOutbox.queue(intent(), { strict: true });
    // The updates are closed test literals, not request data.
    await prisma.$executeRawUnsafe(
      `UPDATE users SET ${update} WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      fixture.tenantId, fixture.patientUid,
    );
    const row = await claim(queued);
    expect(await deliverNotificationOutboxRow(row)).toMatchObject({ outcome: 'rejected', terminal: true });
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(await receipts(row.id)).toEqual([{
      outcome: 'rejected', provider_code: 'booking_sms_recipient_mismatch', evidence: {},
    }]);
  });

  test('rejects another tenant booking even when its patient has the same phone', async () => {
    const other = await createFixture();
    const request = intent({
      sourceEventKey: `investigation-booking-confirmed:${other.bookingId}`,
      data: { type: 'investigation_confirmed', booking_id: other.bookingId },
    });
    const row = await claim(await notificationOutbox.queue(request, { strict: true }));
    expect(await deliverNotificationOutboxRow(row)).toMatchObject({ outcome: 'rejected', terminal: true });
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  test('rejects a booking reassigned to a different patient instead of matching only phone', async () => {
    const queued = await notificationOutbox.queue(intent(), { strict: true });
    const [other] = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::text, 'Another synthetic patient', 'PATIENT', NOW())
       RETURNING id`,
      randomUUID(), fixture.tenantId, NEXT_PHONE,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE investigation_bookings SET patient_id = $3::integer
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      fixture.tenantId, fixture.bookingId, other.id,
    );
    const row = await claim(queued);
    expect(await deliverNotificationOutboxRow(row)).toMatchObject({ outcome: 'rejected', terminal: true });
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  test('revalidates an immutable replay and advances past the terminal rejection to the next valid intent', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE users SET phone = $3::text WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      fixture.tenantId, fixture.patientUid, NEXT_PHONE,
    );
    const replay = await notificationOutbox.queue(intent({
      sourceEventKey: `investigation-booking-confirmed:${fixture.bookingId}:operator-replay:123`,
      deliveryChannels: ['sms'],
    }), { strict: true, replayGeneration: 1 });
    const row = await claim(replay);
    expect(await deliverNotificationOutboxRow(row)).toMatchObject({ outcome: 'rejected', terminal: true });
    expect(sendSmsMock).not.toHaveBeenCalled();
    const failed = await notificationOutbox.markTerminalFailed(row.id, 'provider_terminal_rejection', {
      tenantId: fixture.tenantId, claimToken: row.claim_token, claimGeneration: row.claim_generation,
    });
    expect(failed).toMatchObject({ status: 'FAILED', retry_count: 3 });
    const next = await claim(await notificationOutbox.queue(intent({
      sourceEventKey: `investigation-result-ready:${fixture.bookingId}`,
      templateVersion: 'sms.investigation_result_ready.v1', recipientPhone: NEXT_PHONE,
      data: { type: 'investigation_result_ready', booking_id: fixture.bookingId },
    }), { strict: true }));
    expect(await deliverNotificationOutboxRow(next)).toMatchObject({ outcome: 'acknowledged' });
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    expect(sendSmsMock.mock.calls[0][0]).toBe(NEXT_PHONE);
    const cursors = await setTenant(fixture.tenantId, tx => tx.$queryRawUnsafe(
      `SELECT state FROM notification_delivery_cursors WHERE tenant_id = $1::uuid AND channel = 'sms'`,
      fixture.tenantId,
    ));
    expect(cursors).toEqual([{ state: 'ready' }]);
    expect(await receipts(row.id)).toEqual([{
      outcome: 'rejected', provider_code: 'booking_sms_recipient_mismatch', evidence: {},
    }]);
  });
});
