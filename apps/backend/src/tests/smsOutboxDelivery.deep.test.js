// src/tests/smsOutboxDelivery.deep.test.js
//
// End-to-end proof of the SMS gateway wave (migrations 699/700) against a
// real database:
//   1. A type='sms' outbox row drains THROUGH the provider adapter: with a
//      tenant msg91 config + template registration and the provider
//      acknowledging (mocked HTTP), the drain records an acknowledged
//      provider receipt and the row reaches SENT — satisfying the 609
//      trigger (SENT is impossible without acknowledged evidence).
//   2. An unregistered template kind terminally rejects
//      (dlt_template_not_registered) and dead-letters to FAILED without
//      wedging the channel.
//   3. The DLR callback path round-trips: the one-time minted callback token
//      resolves the tenant fail-closed, a terminal delivered report lands as
//      an append-only provider_status_callback receipt (inside setTenant —
//      the 609 tables are RESTRICTIVE fail-closed), a replayed report
//      collapses on the one-per-(attempt, source) unique, and the outbox row
//      stays SENT (a DLR never flips outbox status).
//   4. RLS proof: the same receipt insert WITHOUT tenant context fails.

import { randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  upsertSmsProviderConfig,
  createSmsTemplateRegistration,
  resolveSmsConfigByCallbackToken,
} from '../services/notification/smsProviderConfigService.js';
import { processMsg91Dlr } from '../services/notification/smsDeliveryStatusService.js';
import { notificationOutbox } from '../utils/notifications/notificationOutbox.js';
import { deliverNotificationOutboxRow } from '../utils/notifications/notificationOutboxDelivery.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const TEMPLATE_KEY = 'sms.investigation_booking_confirmed.v1';
const REQUEST_ID = `msg91-req-${SUFFIX}`;
// All-digit phone: the hex SUFFIX can contain a-f, which normalizePhone
// strips — a letterful phone collapses below 10 digits and classifies as
// phone_missing instead of reaching the provider.
const PHONE = `98${String(Date.now()).slice(-8)}`;

const realFetch = global.fetch;
let callbackToken = null;

function intent(sourceEventKey, { templateVersion = TEMPLATE_KEY } = {}) {
  return {
    tenantId: TENANT_ID,
    type: 'sms',
    channel: 'sms',
    sourceEventKey,
    templateVersion,
    recipientId: PATIENT_UID,
    recipientPhone: PHONE,
    title: 'Booking confirmed',
    body: 'Your investigation INV-9 is confirmed.',
    data: { tenant_id: TENANT_ID, event: sourceEventKey },
  };
}

async function claimOne(expectedId) {
  const batch = await notificationOutbox.claimPendingBatch({ tenantId: TENANT_ID, limit: 10 });
  return batch.find(row => row.id === expectedId) || null;
}

async function readOutbox(id) {
  return setTenantTx(TENANT_ID, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, status, failure_reason FROM notification_outbox
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_ID, id,
    );
    return rows[0];
  });
}

async function readReceipts(outboxId) {
  return setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
    `SELECT receipt_id::text, attempt_id::text, outcome, receipt_source,
            provider_reference, provider_code
       FROM notification_provider_receipts
      WHERE tenant_id = $1::uuid AND notification_outbox_id = $2::integer
      ORDER BY observed_at, receipt_id`,
    TENANT_ID, outboxId,
  ));
}

describeIfDb('SMS gateway wave (699/700) — drain, DLT gate, DLR', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, settings)
       VALUES ($1::uuid, $2::text, 'SMS gateway deep tenant',
               '{"sms": {"enabled": true}}'::jsonb)`,
      TENANT_ID, `sms-deep-${SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, email, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text, 'SMS deep patient', 'PATIENT', true, NOW())`,
      PATIENT_UID, TENANT_ID, PHONE, `sms-deep-${SUFFIX}@example.test`,
    );

    const view = await upsertSmsProviderConfig({
      tenantId: TENANT_ID,
      provider: 'msg91',
      enabled: true,
      sender_id: 'VHHLTH',
      dlt_entity_id: `11010000${SUFFIX}`,
      auth_key: `authkey-${SUFFIX}`,
      created_by: PATIENT_UID,
    });
    expect(view.has_auth_key).toBe(true);
    // The mint returns the plaintext token exactly once.
    expect(typeof view.callback_token).toBe('string');
    expect(view.dlr_path).toBe(`/webhooks/sms/dlr/${view.callback_token}`);
    callbackToken = view.callback_token;

    const registration = await createSmsTemplateRegistration({
      tenantId: TENANT_ID,
      template_key: TEMPLATE_KEY,
      dlt_template_id: '1107100000000012345',
      created_by: PATIENT_UID,
    });
    expect(registration.active).toBe(true);
  });

  afterAll(async () => {
    global.fetch = realFetch;
    await prisma.$disconnect();
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  let sentOutboxId = null;

  test('acknowledged provider send drains a type=sms row to SENT (609 trigger satisfied)', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ type: 'success', message: REQUEST_ID }),
    });

    const queued = await notificationOutbox.queue(intent(`sms-deep-ack-${SUFFIX}`));
    expect(queued).toMatchObject({ status: 'PENDING' });
    const claim = await claimOne(queued.id);
    expect(claim).not.toBeNull();

    const result = await deliverNotificationOutboxRow(claim);
    expect(result.outcome).toBe('acknowledged');

    const receipts = await readReceipts(claim.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      outcome: 'acknowledged',
      receipt_source: 'provider_response',
      provider_reference: REQUEST_ID,
      provider_code: 'accepted',
    });

    const sent = await notificationOutbox.markSent(claim.id, {
      tenantId: TENANT_ID,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
    });
    expect(sent.status).toBe('SENT');
    sentOutboxId = claim.id;
  });

  test('an unregistered template kind terminally rejects and dead-letters to FAILED', async () => {
    global.fetch = async () => {
      throw new Error('provider must not be called for an unregistered template');
    };

    const queued = await notificationOutbox.queue(intent(`sms-deep-unreg-${SUFFIX}`, {
      templateVersion: 'sms.never_registered_kind.v1',
    }));
    expect(queued).toMatchObject({ status: 'PENDING' });
    const claim = await claimOne(queued.id);
    expect(claim).not.toBeNull();

    const result = await deliverNotificationOutboxRow(claim);
    expect(result).toMatchObject({ outcome: 'rejected', terminal: true });

    const receipts = await readReceipts(claim.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      outcome: 'rejected',
      provider_code: 'dlt_template_not_registered',
    });

    const failed = await notificationOutbox.markTerminalFailed(
      claim.id,
      'provider_terminal_rejection',
      {
        tenantId: TENANT_ID,
        claimToken: claim.claim_token,
        claimGeneration: claim.claim_generation,
      },
    );
    expect(failed.status).toBe('FAILED');
  });

  test('DLR round-trip: token resolves fail-closed, terminal report lands once, outbox stays SENT', async () => {
    expect(sentOutboxId).not.toBeNull();

    // Fail-closed: an unknown token resolves nothing.
    await expect(resolveSmsConfigByCallbackToken('not-a-real-token-aaaaaaaaaa', 'msg91')).resolves.toBeNull();
    const unauthorized = await processMsg91Dlr({
      token: 'not-a-real-token-aaaaaaaaaa',
      payload: { requestId: REQUEST_ID, status: 'delivered' },
    });
    expect(unauthorized.authorized).toBe(false);

    // The minted token resolves the owning tenant.
    const config = await resolveSmsConfigByCallbackToken(callbackToken, 'msg91');
    expect(config).not.toBeNull();
    expect(String(config.tenant_id)).toBe(TENANT_ID);

    const first = await processMsg91Dlr({
      token: callbackToken,
      payload: { requestId: REQUEST_ID, status: 'delivered' },
    });
    expect(first.authorized).toBe(true);
    expect(first.results).toEqual([expect.objectContaining({ handled: 'recorded' })]);

    // Replay collapses on ux_notification_provider_receipt_source_once.
    const replay = await processMsg91Dlr({
      token: callbackToken,
      payload: { requestId: REQUEST_ID, status: 'delivered' },
    });
    expect(replay.results).toEqual([expect.objectContaining({ handled: 'recorded' })]);

    const receipts = await readReceipts(sentOutboxId);
    expect(receipts).toHaveLength(2); // send-time + exactly ONE DLR receipt
    const dlr = receipts.filter(r => r.receipt_source === 'provider_status_callback');
    expect(dlr).toHaveLength(1);
    expect(dlr[0]).toMatchObject({
      outcome: 'acknowledged',
      provider_reference: REQUEST_ID,
      provider_code: 'dlr_delivered',
      attempt_id: receipts[0].attempt_id, // same attempt as the send receipt
    });

    // Intermediate + unknown-reference reports never write.
    const intermediate = await processMsg91Dlr({
      token: callbackToken,
      payload: { requestId: REQUEST_ID, status: 'queued' },
    });
    expect(intermediate.results).toEqual([{ handled: 'ignored_intermediate', status: 'queued' }]);
    const unknown = await processMsg91Dlr({
      token: callbackToken,
      payload: { requestId: `never-sent-${SUFFIX}`, status: 'delivered' },
    });
    expect(unknown.results).toEqual([{ handled: 'unknown_reference' }]);
    expect(await readReceipts(sentOutboxId)).toHaveLength(2);

    // Outbox law: the DLR never flipped the row out of SENT.
    const outbox = await readOutbox(sentOutboxId);
    expect(outbox.status).toBe('SENT');
  });

  test('RLS proof: the 609 receipt store rejects a write without explicit tenant context', async () => {
    // The superuser test connection bypasses RLS, so — like
    // audit-logs-tenant-rls.deep.test.js — the proof runs as the sealed
    // non-superuser app role with the GUC left UNSET. The RESTRICTIVE
    // notification_delivery_explicit_context policy must fail the write
    // closed. Self-skips when the role is not provisioned.
    const APP_ROLE = process.env.AUDIT_APPEND_ONLY_TEST_ROLE || 'rls_test_app';
    const roleRows = await prisma.$queryRawUnsafe(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`, APP_ROLE,
    );
    if (!roleRows.length || roleRows[0].rolsuper || roleRows[0].rolbypassrls) {
      console.warn(`RLS proof skipped: role ${APP_ROLE} unavailable`);
      return;
    }

    const receipts = await readReceipts(sentOutboxId);
    const attemptId = receipts[0].attempt_id;
    // A DIFFERENT receipt source than test 3 used, so the one-per-(attempt,
    // source) unique cannot be what rejects the row — only RLS can.
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
      await tx.$executeRawUnsafe(
        `INSERT INTO notification_provider_receipts
           (tenant_id, attempt_id, notification_outbox_id, channel, outcome,
            receipt_source, provider_reference, provider_code, evidence)
         VALUES ($1::uuid, $2::uuid, $3::integer, 'sms', 'uncertain',
                 'transport_failure', $4::text, 'rls_probe', '{}'::jsonb)`,
        TENANT_ID, attemptId, sentOutboxId, `rls-probe-${SUFFIX}`,
      );
    })).rejects.toThrow(/row-level security/i);

    // Same insert WITH the tenant GUC set succeeds for the same sealed role
    // (then rolls back nothing — it is a real receipt append, remove it to
    // keep the receipt set stable for reruns on a reused DB… receipts are
    // append-only evidence, so instead use a throwaway probe transaction
    // that raises after proving insertability).
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
      await tx.$queryRawUnsafe(
        `SELECT set_config('app.current_tenant_id', $1, true)`, TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO notification_provider_receipts
           (tenant_id, attempt_id, notification_outbox_id, channel, outcome,
            receipt_source, provider_reference, provider_code, evidence)
         VALUES ($1::uuid, $2::uuid, $3::integer, 'sms', 'uncertain',
                 'transport_failure', $4::text, 'rls_probe', '{}'::jsonb)`,
        TENANT_ID, attemptId, sentOutboxId, `rls-probe-${SUFFIX}`,
      );
      throw new Error('PROBE_ROLLBACK');
    })).rejects.toThrow('PROBE_ROLLBACK');
  });
});
