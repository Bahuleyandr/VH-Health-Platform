import { randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  applyProviderReceiptToCursor,
  beginProviderAttempts,
  reconcileExpiredClaims,
  recordProviderReceipt,
} from '../services/notification/notificationDeliveryLedgerService.js';
import {
  __testing__ as reminderTesting,
  processPendingScheduledNotifications,
  sendTimedReminders,
} from '../utils/notifications/appointmentReminderJob.js';
import { notificationOutbox } from '../utils/notifications/notificationOutbox.js';
import { deliverNotificationOutboxRow } from '../utils/notifications/notificationOutboxDelivery.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

function uniquePhone() {
  const digits = BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`)
    .toString()
    .slice(-10)
    .padStart(10, '0');
  return `+91${digits}`;
}

async function createRecipientFixture(label, { deviceToken = null } = {}) {
  const tenantId = randomUUID();
  const userUid = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name, settings)
     VALUES ($1::uuid, $2::text, $3::text, $4::jsonb)`,
    tenantId,
    `reminder-${label}-${suffix}`,
    `Reminder ${label} tenant`,
    JSON.stringify({ timezone: 'Asia/Kolkata' }),
  );
  const users = await prisma.$queryRawUnsafe(
    `INSERT INTO users
       (uid, tenant_id, phone, name, role, is_active, device_token, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::text, $4::text, 'PATIENT', true, $5::text, NOW())
     RETURNING id`,
    userUid,
    tenantId,
    uniquePhone(),
    `Reminder ${label} patient`,
    deviceToken,
  );
  return { tenantId, userId: users[0].id, userUid };
}

async function scheduleFeedback({ tenantId, userId, appointmentId }) {
  const rows = await setTenantTx(tenantId, tx => tx.$queryRawUnsafe(
    `INSERT INTO scheduled_notifications
       (tenant_id, user_id, type, data, send_at, status)
     VALUES ($1::uuid, $2::integer, 'feedback_request', $3::jsonb,
             NOW() - INTERVAL '1 minute', 'pending')
     RETURNING id`,
    tenantId,
    userId,
    JSON.stringify({ appointment_id: String(appointmentId), survey: 'nps' }),
  ));
  return rows[0].id;
}

async function scheduledState(tenantId, id) {
  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT status, sent_at
         FROM scheduled_notifications
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      tenantId,
      id,
    );
    return rows[0];
  });
}

async function claimSource(tenantId, sourceEventKey) {
  const claims = await notificationOutbox.claimPendingBatch({ tenantId, limit: 20 });
  const claim = claims.find(row => row.source_event_key === sourceEventKey);
  expect(claim).toBeDefined();
  return claim;
}

function claimFence(tenantId, claim) {
  return {
    tenantId,
    claimToken: claim.claim_token,
    claimGeneration: claim.claim_generation,
  };
}

describeIfDb('appointment and scheduled notification delivery durability', () => {
  test('1h and 24h reminder windows include the lower bound and exclude the upper bound', async () => {
    const fixture = await createRecipientFixture('boundaries');
    const clock = new Date('2031-03-15T03:30:00.000Z'); // 09:00 Asia/Kolkata
    const appointments = await prisma.$queryRawUnsafe(
      `INSERT INTO appointments
         (tenant_id, phone, patient_id, patient_name, doctor_name,
          appointment_date, appointment_time, status, token_number,
          created_at, updated_at)
       VALUES
         ($1::uuid, $2::text, $3::integer, 'Boundary patient', 'Rao',
          '2031-03-15'::date, '09:30', 'CONFIRMED', 'B1', NOW(), NOW()),
         ($1::uuid, $2::text, $3::integer, 'Boundary patient', 'Rao',
          '2031-03-15'::date, '10:30', 'CONFIRMED', 'B2', NOW(), NOW()),
         ($1::uuid, $2::text, $3::integer, 'Boundary patient', 'Rao',
          '2031-03-16'::date, '08:00', 'CONFIRMED', 'B3', NOW(), NOW()),
         ($1::uuid, $2::text, $3::integer, 'Boundary patient', 'Rao',
          '2031-03-16'::date, '09:00', 'CONFIRMED', 'B4', NOW(), NOW())
       RETURNING id, appointment_date::text, appointment_time`,
      fixture.tenantId,
      uniquePhone(),
      fixture.userId,
    );

    const result = await sendTimedReminders({ tenantId: fixture.tenantId, now: clock });
    expect(result).toMatchObject({ due1h: 1, due24h: 1, queued1h: 1, queued24h: 1 });

    const intents = await setTenantTx(fixture.tenantId, tx => tx.$queryRawUnsafe(
      `SELECT source_event_key
         FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND source_event_key LIKE 'appointment-reminder-%'
        ORDER BY source_event_key`,
      fixture.tenantId,
    ));
    const lower1h = appointments.find(row => row.appointment_time === '09:30');
    const upper1h = appointments.find(row => row.appointment_time === '10:30');
    const lower24h = appointments.find(row => row.appointment_time === '08:00');
    const upper24h = appointments.find(row => row.appointment_time === '09:00');
    expect(intents.map(row => row.source_event_key)).toEqual([
      `appointment-reminder-1h:${lower1h.id}`,
      `appointment-reminder-1h:${lower1h.id}`,
      `appointment-reminder-24h:${lower24h.id}`,
      `appointment-reminder-24h:${lower24h.id}`,
    ]);
    expect(intents.some(row => row.source_event_key.endsWith(`:${upper1h.id}`))).toBe(false);
    expect(intents.some(row => row.source_event_key.endsWith(`:${upper24h.id}`))).toBe(false);
  }, 30000);

  test('due selection is identical in UTC and non-UTC database sessions', async () => {
    const fixture = await createRecipientFixture('session-timezone');
    const [appointment] = await prisma.$queryRawUnsafe(
      `INSERT INTO appointments
         (tenant_id, phone, patient_id, patient_name, doctor_name,
          appointment_date, appointment_time, status, token_number,
          created_at, updated_at)
       VALUES
         ($1::uuid, $2::text, $3::integer, 'Timezone patient', 'Rao',
          '2031-03-15'::date, '09:30', 'CONFIRMED', 'TZ1', NOW(), NOW())
       RETURNING id`,
      fixture.tenantId,
      uniquePhone(),
      fixture.userId,
    );
    const window = reminderTesting.reminderWindow(
      new Date('2031-03-15T03:30:00.000Z'),
      '1h',
    );

    async function selectInSession(timeZone) {
      return setTenantTx(fixture.tenantId, async (tx) => {
        const [posture] = await tx.$queryRawUnsafe(
          `SELECT set_config('TimeZone', $1::text, true) AS timezone`,
          timeZone,
        );
        const due = await reminderTesting.loadDueAppointmentsWithClient(tx, {
          tenantId: fixture.tenantId,
          ...window,
          reminderKind: '1h',
        });
        return { timeZone: posture.timezone, ids: due.map(row => row.id) };
      });
    }

    const utc = await selectInSession('UTC');
    const kolkata = await selectInSession('Asia/Kolkata');
    expect(utc).toEqual({ timeZone: 'UTC', ids: [appointment.id] });
    expect(kolkata).toEqual({ timeZone: 'Asia/Kolkata', ids: utc.ids });
  }, 30000);

  test('two same-day appointments are filtered by their tenant-local time and queued SMS is not delivery', async () => {
    const fixture = await createRecipientFixture('same-day');
    const clock = new Date('2031-03-15T03:30:00.000Z'); // 09:00 Asia/Kolkata
    const appointments = await prisma.$queryRawUnsafe(
      `INSERT INTO appointments
         (tenant_id, phone, patient_id, patient_name, doctor_name,
          appointment_date, appointment_time, status, token_number,
          created_at, updated_at)
       VALUES
         ($1::uuid, $2::text, $3::integer, 'Same-day patient', 'Rao',
          '2031-03-15'::date, '10:00', 'CONFIRMED', 'A1', NOW(), NOW()),
         ($1::uuid, $2::text, $3::integer, 'Same-day patient', 'Rao',
          '2031-03-15'::date, '15:00', 'CONFIRMED', 'A2', NOW(), NOW())
       RETURNING id, appointment_time`,
      fixture.tenantId,
      uniquePhone(),
      fixture.userId,
    );
    const due = appointments.find(row => row.appointment_time === '10:00');
    const outside = appointments.find(row => row.appointment_time === '15:00');

    const firstSweep = await sendTimedReminders({ tenantId: fixture.tenantId, now: clock });
    expect(firstSweep).toMatchObject({ due1h: 1, queued1h: 1, reconciled1h: 0 });

    const intents = await setTenantTx(fixture.tenantId, tx => tx.$queryRawUnsafe(
      `SELECT id, channel, source_event_key, status
         FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND source_event_key IN ($2::text, $3::text)
        ORDER BY channel`,
      fixture.tenantId,
      `appointment-reminder-1h:${due.id}`,
      `appointment-reminder-1h:${outside.id}`,
    ));
    // ORDER BY channel, not id: queuePatientReminder queues the sms and push
    // intents via Promise.allSettled, so their row-id order is a race — CI
    // shard 2 on 8215b901 (2026-08-14) caught the [push, sms] interleaving.
    expect(intents.map(row => ({
      channel: row.channel,
      source: row.source_event_key,
      status: row.status,
    }))).toEqual([
      { channel: 'push', source: `appointment-reminder-1h:${due.id}`, status: 'PENDING' },
      { channel: 'sms', source: `appointment-reminder-1h:${due.id}`, status: 'PENDING' },
    ]);

    const claims = await notificationOutbox.claimPendingBatch({
      tenantId: fixture.tenantId,
      limit: 20,
    });
    expect(claims).toHaveLength(2);
    for (const claim of claims) {
      const result = await deliverNotificationOutboxRow(claim);
      expect(result.outcome).toBe('rejected');
      if (result.terminal) {
        await notificationOutbox.markTerminalFailed(
          claim.id,
          'provider_terminal_rejection',
          claimFence(fixture.tenantId, claim),
        );
      } else {
        await notificationOutbox.markFailed(
          claim.id,
          'provider_rejected_notification',
          claimFence(fixture.tenantId, claim),
        );
      }
    }

    const secondSweep = await sendTimedReminders({ tenantId: fixture.tenantId, now: clock });
    expect(secondSweep.reconciled1h).toBe(0);
    const state = await prisma.$queryRawUnsafe(
      `SELECT id, reminder_1h_sent
         FROM appointments
        WHERE tenant_id = $1::uuid AND id IN ($2::integer, $3::integer)
        ORDER BY id`,
      fixture.tenantId,
      due.id,
      outside.id,
    );
    expect(state).toEqual([
      { id: due.id, reminder_1h_sent: false },
      { id: outside.id, reminder_1h_sent: false },
    ]);
    const receipts = await setTenantTx(fixture.tenantId, tx => tx.$queryRawUnsafe(
      `SELECT channel, outcome, provider_code
         FROM notification_provider_receipts
        WHERE tenant_id = $1::uuid
          AND notification_outbox_id = ANY($2::integer[])
        ORDER BY channel`,
      fixture.tenantId,
      intents.map(row => row.id),
    ));
    expect(receipts).toEqual([
      { channel: 'push', outcome: 'rejected', provider_code: 'fcm_token_missing' },
      { channel: 'sms', outcome: 'rejected', provider_code: 'sms_gateway_not_configured' },
    ]);
  }, 30000);

  test('appointment reminder state advances only after a provider acknowledgement', async () => {
    const fixture = await createRecipientFixture('appointment-ack', {
      deviceToken: 'appointment-accepted-fcm-token',
    });
    const clock = new Date('2031-03-15T03:30:00.000Z'); // 09:00 Asia/Kolkata
    const [appointment] = await prisma.$queryRawUnsafe(
      `INSERT INTO appointments
         (tenant_id, phone, patient_id, patient_name, doctor_name,
          appointment_date, appointment_time, status, token_number,
          created_at, updated_at)
       VALUES
         ($1::uuid, $2::text, $3::integer, 'Acknowledged patient', 'Rao',
          '2031-03-15'::date, '10:00', 'CONFIRMED', 'ACK1', NOW(), NOW())
       RETURNING id`,
      fixture.tenantId,
      uniquePhone(),
      fixture.userId,
    );

    await sendTimedReminders({ tenantId: fixture.tenantId, now: clock });
    const before = await prisma.$queryRawUnsafe(
      `SELECT reminder_1h_sent
         FROM appointments
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      fixture.tenantId,
      appointment.id,
    );
    expect(before[0].reminder_1h_sent).toBe(false);

    const claims = await notificationOutbox.claimPendingBatch({
      tenantId: fixture.tenantId,
      limit: 20,
    });
    const smsClaim = claims.find(row => (
      row.channel === 'sms'
      && row.source_event_key === `appointment-reminder-1h:${appointment.id}`
    ));
    const pushClaim = claims.find(row => (
      row.channel === 'push'
      && row.source_event_key === `appointment-reminder-1h:${appointment.id}`
    ));
    expect(smsClaim).toBeDefined();
    expect(pushClaim).toBeDefined();
    const smsDelivery = await deliverNotificationOutboxRow(smsClaim);
    expect(smsDelivery).toMatchObject({
      outcome: 'rejected',
      terminal: false,
      receipts: [expect.objectContaining({ provider_code: 'sms_gateway_not_configured' })],
    });
    await notificationOutbox.markFailed(
      smsClaim.id,
      'provider_rejected_notification',
      claimFence(fixture.tenantId, smsClaim),
    );
    const [attempt] = await beginProviderAttempts({
      tenantId: fixture.tenantId,
      outboxId: pushClaim.id,
      claimToken: pushClaim.claim_token,
      claimGeneration: pushClaim.claim_generation,
      renderedIntentHash: pushClaim.rendered_intent_hash,
      channels: ['push'],
    });
    const receipt = await recordProviderReceipt({
      tenantId: fixture.tenantId,
      attemptId: attempt.attempt_id,
      outboxId: pushClaim.id,
      channel: 'push',
      outcome: 'acknowledged',
      receiptSource: 'provider_response',
      providerReference: `projects/test/messages/${randomUUID()}`,
      providerCode: 'accepted',
      evidence: { success_count: 1, failure_count: 0 },
    });
    await applyProviderReceiptToCursor({
      tenantId: fixture.tenantId,
      receiptId: receipt.receipt_id,
    });

    const sweep = await sendTimedReminders({ tenantId: fixture.tenantId, now: clock });
    expect(sweep.reconciled1h).toBe(1);
    const after = await prisma.$queryRawUnsafe(
      `SELECT reminder_1h_sent
         FROM appointments
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      fixture.tenantId,
      appointment.id,
    );
    expect(after[0].reminder_1h_sent).toBe(true);
    await notificationOutbox.markSent(
      pushClaim.id,
      claimFence(fixture.tenantId, pushClaim),
    );
  }, 30000);

  test('missing FCM recipient is retained as explicit evidence and never marked sent', async () => {
    const fixture = await createRecipientFixture('missing-fcm');
    const scheduledId = await scheduleFeedback({ ...fixture, appointmentId: 701 });

    await processPendingScheduledNotifications({ tenantId: fixture.tenantId });
    expect(await scheduledState(fixture.tenantId, scheduledId)).toMatchObject({
      status: 'queued',
      sent_at: null,
    });

    const source = `scheduled-notification:${scheduledId}`;
    const claim = await claimSource(fixture.tenantId, source);
    const delivery = await deliverNotificationOutboxRow(claim);
    expect(delivery).toMatchObject({ outcome: 'rejected', terminal: true });
    await notificationOutbox.markTerminalFailed(
      claim.id,
      'provider_terminal_rejection',
      claimFence(fixture.tenantId, claim),
    );

    await processPendingScheduledNotifications({ tenantId: fixture.tenantId });
    expect(await scheduledState(fixture.tenantId, scheduledId)).toMatchObject({
      status: 'recipient_missing',
      sent_at: null,
    });
  }, 30000);

  test('provider rejection remains retryable and does not become sent', async () => {
    const fixture = await createRecipientFixture('retry', { deviceToken: 'retry-fcm-token' });
    const scheduledId = await scheduleFeedback({ ...fixture, appointmentId: 702 });
    await processPendingScheduledNotifications({ tenantId: fixture.tenantId });
    const claim = await claimSource(fixture.tenantId, `scheduled-notification:${scheduledId}`);
    const [attempt] = await beginProviderAttempts({
      tenantId: fixture.tenantId,
      outboxId: claim.id,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
      renderedIntentHash: claim.rendered_intent_hash,
      channels: ['push'],
    });
    const receipt = await recordProviderReceipt({
      tenantId: fixture.tenantId,
      attemptId: attempt.attempt_id,
      outboxId: claim.id,
      channel: 'push',
      outcome: 'rejected',
      receiptSource: 'provider_response',
      providerCode: 'fcm_provider_rejected',
      evidence: { status: 503 },
    });
    await applyProviderReceiptToCursor({
      tenantId: fixture.tenantId,
      receiptId: receipt.receipt_id,
    });
    await notificationOutbox.markFailed(
      claim.id,
      'provider_rejected_notification',
      claimFence(fixture.tenantId, claim),
    );

    await processPendingScheduledNotifications({ tenantId: fixture.tenantId });
    expect(await scheduledState(fixture.tenantId, scheduledId)).toMatchObject({
      status: 'retrying',
      sent_at: null,
    });
  }, 30000);

  test('scheduled row becomes sent only after an acknowledged provider receipt exists', async () => {
    const fixture = await createRecipientFixture('ack', { deviceToken: 'accepted-fcm-token' });
    const scheduledId = await scheduleFeedback({ ...fixture, appointmentId: 704 });
    await processPendingScheduledNotifications({ tenantId: fixture.tenantId });
    const claim = await claimSource(fixture.tenantId, `scheduled-notification:${scheduledId}`);
    const [attempt] = await beginProviderAttempts({
      tenantId: fixture.tenantId,
      outboxId: claim.id,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
      renderedIntentHash: claim.rendered_intent_hash,
      channels: ['push'],
    });
    const receipt = await recordProviderReceipt({
      tenantId: fixture.tenantId,
      attemptId: attempt.attempt_id,
      outboxId: claim.id,
      channel: 'push',
      outcome: 'acknowledged',
      receiptSource: 'provider_response',
      providerReference: `projects/test/messages/${randomUUID()}`,
      providerCode: 'accepted',
      evidence: { success_count: 1, failure_count: 0 },
    });
    await applyProviderReceiptToCursor({
      tenantId: fixture.tenantId,
      receiptId: receipt.receipt_id,
    });

    // Simulate a worker crash after the durable receipt but before it finalized
    // the outbox row. The scheduled row may still become sent because provider
    // acceptance exists; queue/claim state alone could never do this.
    await processPendingScheduledNotifications({ tenantId: fixture.tenantId });
    expect(await scheduledState(fixture.tenantId, scheduledId)).toMatchObject({
      status: 'sent',
      sent_at: expect.any(Date),
    });
    await notificationOutbox.markSent(claim.id, claimFence(fixture.tenantId, claim));
  }, 30000);

  test('a crash after provider claim becomes reconciliation-required instead of a false retry', async () => {
    const fixture = await createRecipientFixture('crash', { deviceToken: 'crash-fcm-token' });
    const scheduledId = await scheduleFeedback({ ...fixture, appointmentId: 703 });
    await processPendingScheduledNotifications({ tenantId: fixture.tenantId });
    const claim = await claimSource(fixture.tenantId, `scheduled-notification:${scheduledId}`);
    await beginProviderAttempts({
      tenantId: fixture.tenantId,
      outboxId: claim.id,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
      renderedIntentHash: claim.rendered_intent_hash,
      channels: ['push'],
    });
    await setTenantTx(fixture.tenantId, tx => tx.$executeRawUnsafe(
      `UPDATE notification_outbox
          SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND id = $2::integer
          AND claim_token = $3::uuid`,
      fixture.tenantId,
      claim.id,
      claim.claim_token,
    ));

    const recovery = await reconcileExpiredClaims({ tenantId: fixture.tenantId });
    expect(recovery).toMatchObject({ expired: 1, reconciled: 1 });
    await processPendingScheduledNotifications({ tenantId: fixture.tenantId });
    expect(await scheduledState(fixture.tenantId, scheduledId)).toMatchObject({
      status: 'reconcile_required',
      sent_at: null,
    });
  }, 30000);
});
