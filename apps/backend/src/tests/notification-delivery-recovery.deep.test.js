import { randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  enqueueExternalRecoveryItem,
  processNextItemTx,
} from '../services/integrations/externalInterfaceRecoveryService.js';
import {
  authorizeExternalRecoveryResume,
  registerExternalRecoveryOffset,
} from './helpers/externalRecoveryOperabilityTestHelper.js';
import {
  applyProviderReceiptToCursor,
  beginProviderAttempts,
  reconcileExpiredClaims,
  recordProviderReceipt,
} from '../services/notification/notificationDeliveryLedgerService.js';
import { notificationOutbox } from '../utils/notifications/notificationOutbox.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const ACTOR_UID = randomUUID();
const RECIPIENT_UID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);

function intent(sourceEventKey, body = 'The result is ready.') {
  return {
    tenantId: TENANT_ID,
    type: 'push',
    channel: 'push',
    sourceEventKey,
    templateVersion: 'structured-result-ready.v1',
    recipientId: RECIPIENT_UID,
    title: 'Result ready',
    body,
    data: { tenant_id: TENANT_ID, result_generation: sourceEventKey },
  };
}

async function readOutbox(id) {
  return setTenantTx(TENANT_ID, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, status, claim_token::text, claim_generation,
              source_event_key, rendered_intent_hash, failure_reason
         FROM notification_outbox
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_ID, id,
    );
    return rows[0];
  });
}

describeIfDb('C6.1-D notification delivery recovery', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'C6.1-D delivery tenant')`,
      TENANT_ID, `c61d-delivery-${SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, email, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, $3::uuid, $4::text, $5::text,
          'C6.1-D owner', 'ADMIN', true, NOW()),
         ($2::uuid, $3::uuid, $6::text, $7::text,
          'C6.1-D recipient', 'PATIENT', true, NOW())`,
      ACTOR_UID,
      RECIPIENT_UID,
      TENANT_ID,
      `91${SUFFIX.slice(0, 10)}`,
      `owner-${SUFFIX}@example.test`,
      `92${SUFFIX.slice(0, 10)}`,
      `recipient-${SUFFIX}@example.test`,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('deduplicates the exact source-recipient-channel-template-rendered intent', async () => {
    const first = await notificationOutbox.queue(intent(`event:${SUFFIX}:1`), { strict: true });
    const duplicate = await notificationOutbox.queue(intent(`event:${SUFFIX}:1`), { strict: true });
    const differentRender = await notificationOutbox.queue(
      intent(`event:${SUFFIX}:1`, 'The corrected result is ready.'),
      { strict: true },
    );

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.duplicate).toBe(true);
    expect(differentRender.id).not.toBe(first.id);
    expect(differentRender.rendered_intent_hash).not.toBe(first.rendered_intent_hash);

    await setTenantTx(TENANT_ID, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE notification_outbox
            SET status = 'SUPPRESSED', failure_reason = 'test_render_variant'
          WHERE tenant_id = $1::uuid AND id IN ($2::integer, $3::integer)`,
        TENANT_ID, first.id, differentRender.id,
      );
    });
  });

  test('persists one lease across concurrent claimers and advances only on provider acceptance', async () => {
    const queued = await notificationOutbox.queue(intent(`event:${SUFFIX}:claim`), { strict: true });
    const [left, right] = await Promise.all([
      notificationOutbox.claimPendingBatch({ tenantId: TENANT_ID, limit: 1 }),
      notificationOutbox.claimPendingBatch({ tenantId: TENANT_ID, limit: 1 }),
    ]);
    const claims = [...left, ...right].filter(row => row.id === queued.id);
    expect(claims).toHaveLength(1);
    expect(claims[0].claim_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(claims[0].claim_generation).toBe(1);

    const [attempt] = await beginProviderAttempts({
      tenantId: TENANT_ID,
      outboxId: queued.id,
      claimToken: claims[0].claim_token,
      claimGeneration: claims[0].claim_generation,
      renderedIntentHash: claims[0].rendered_intent_hash,
      channels: ['push'],
    });
    const receipt = await recordProviderReceipt({
      tenantId: TENANT_ID,
      attemptId: attempt.attempt_id,
      outboxId: queued.id,
      channel: 'push',
      outcome: 'acknowledged',
      receiptSource: 'provider_response',
      providerReference: `projects/test/messages/${SUFFIX}`,
      providerCode: 'accepted',
      evidence: { success_count: 1, failure_count: 0 },
    });
    const beforeApply = await setTenantTx(TENANT_ID, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT last_contiguous_outbox_id, state
           FROM notification_delivery_cursors
          WHERE tenant_id = $1::uuid AND channel = 'push'`,
        TENANT_ID,
      );
      return rows[0];
    });
    expect(beforeApply).toMatchObject({ state: 'delivering', last_contiguous_outbox_id: null });

    const cursor = await applyProviderReceiptToCursor({
      tenantId: TENANT_ID,
      receiptId: receipt.receipt_id,
    });
    expect(cursor).toMatchObject({
      state: 'ready',
      last_contiguous_outbox_id: queued.id,
      blocked_outbox_id: null,
    });
    await notificationOutbox.markSent(queued.id, {
      tenantId: TENANT_ID,
      claimToken: claims[0].claim_token,
      claimGeneration: claims[0].claim_generation,
    });
    expect(await readOutbox(queued.id)).toMatchObject({ status: 'SENT', claim_token: null });
  });

  test('turns an expired post-attempt lease into uncertain evidence and pauses the cursor', async () => {
    const queued = await notificationOutbox.queue(intent(`event:${SUFFIX}:uncertain`), { strict: true });
    const [claim] = await notificationOutbox.claimPendingBatch({ tenantId: TENANT_ID, limit: 1 });
    expect(claim.id).toBe(queued.id);
    const [attempt] = await beginProviderAttempts({
      tenantId: TENANT_ID,
      outboxId: queued.id,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
      renderedIntentHash: claim.rendered_intent_hash,
      channels: ['push'],
    });
    await setTenantTx(TENANT_ID, tx => tx.$executeRawUnsafe(
      `UPDATE notification_outbox
          SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND id = $2::integer
          AND claim_token = $3::uuid`,
      TENANT_ID, queued.id, claim.claim_token,
    ));

    const reconciliation = await reconcileExpiredClaims({ tenantId: TENANT_ID });
    expect(reconciliation).toMatchObject({ expired: 1, reset: 0, reconciled: 1 });
    expect(await readOutbox(queued.id)).toMatchObject({
      status: 'RECONCILIATION_REQUIRED',
      failure_reason: 'provider_state_requires_owner_reconciliation',
    });
    const state = await setTenantTx(TENANT_ID, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT cursor.state, cursor.last_contiguous_outbox_id,
                cursor.blocked_outbox_id, receipt.receipt_id::text,
                receipt.outcome, receipt.receipt_source
           FROM notification_delivery_cursors AS cursor
           JOIN notification_provider_receipts AS receipt
             ON receipt.tenant_id = cursor.tenant_id
            AND receipt.notification_outbox_id = cursor.blocked_outbox_id
            AND receipt.channel = cursor.channel
          WHERE cursor.tenant_id = $1::uuid AND cursor.channel = 'push'
            AND receipt.attempt_id = $2::uuid`,
        TENANT_ID, attempt.attempt_id,
      );
      return rows[0];
    });
    expect(state).toMatchObject({
      state: 'paused_uncertain',
      last_contiguous_outbox_id: expect.any(Number),
      blocked_outbox_id: queued.id,
      outcome: 'uncertain',
      receipt_source: 'lease_expiry',
    });

    const offset = await registerExternalRecoveryOffset({
      tenantId: TENANT_ID,
      interfaceFamily: 'I17',
      sourcePartition: 'push',
      initialPosition: queued.id - 1,
      initialToken: `token-${queued.id - 1}`,
      retainedFromPosition: queued.id - 1,
      retainedFromToken: `token-${queued.id - 1}`,
      policyVersion: 'c-d8-v1',
      policySignature: `owner-signature-${SUFFIX}`,
      retentionPolicy: 'notification-receipts-730d',
      retentionUntil: '2029-08-01T00:00:00.000Z',
    });
    expect(offset).toMatchObject({
      facility_scope: 'tenant',
      facility_id: null,
      interface_family: 'I17',
      direction: 'outbound',
    });
    await authorizeExternalRecoveryResume({
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      interfaceFamily: 'I17',
      resumeCutoffPosition: queued.id,
      resumeCutoffToken: `token-${queued.id}`,
    });
    const command = {
      attempt_id: attempt.attempt_id,
      notification_outbox_id: queued.id,
      channel: 'push',
      outcome: 'acknowledged',
      provider_reference: `projects/test/messages/reconciled-${SUFFIX}`,
      provider_code: 'accepted_from_provider_console',
      evidence: { provider_console_export_sha256: 'd'.repeat(64) },
      actor_uid: ACTOR_UID,
      owner_reason: 'Provider console confirms acceptance after the worker response was lost.',
    };
    await enqueueExternalRecoveryItem({
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      interfaceFamily: 'I17',
      sourcePartition: 'push',
      sourcePosition: queued.id,
      sourceToken: `token-${queued.id}`,
      predecessorToken: `token-${queued.id - 1}`,
      duplicateKey: `i17:${TENANT_ID}:push:${queued.id}`,
      occurredAt: '2026-08-02T08:30:00.000Z',
      command,
    });

    const outboxCountBefore = await setTenantTx(TENANT_ID, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::integer AS count FROM notification_outbox
          WHERE tenant_id = $1::uuid`,
        TENANT_ID,
      );
      return rows[0].count;
    });
    const recovered = await processNextItemTx({
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      interfaceFamily: 'I17',
      sourcePartition: 'push',
      sourcePosition: queued.id,
      sourceToken: `token-${queued.id}`,
      predecessorToken: `token-${queued.id - 1}`,
      duplicateKey: `i17:${TENANT_ID}:push:${queued.id}`,
      command,
    });
    expect(recovered).toMatchObject({
      status: 'handled',
      outcome_code: 'i17_provider_acknowledged',
      cursor: {
        high_water_position: String(queued.id),
        recovery_state: 'ready',
      },
    });
    expect(recovered.receipt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readOutbox(queued.id)).toMatchObject({
      status: 'RECONCILIATION_REQUIRED',
      claim_token: null,
    });
    const outboxCountAfter = await setTenantTx(TENANT_ID, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::integer AS count FROM notification_outbox
          WHERE tenant_id = $1::uuid`,
        TENANT_ID,
      );
      return rows[0].count;
    });
    expect(outboxCountAfter).toBe(outboxCountBefore);
  }, 60_000);

  test('operator reconciliation writes a real operator_reconciliation receipt (migration 700 CHECK keeps 658 vocabulary)', async () => {
    // Regression for the 700 rewrite of chk_notification_provider_receipt_source:
    // the operator path (POST /admin/notifications/outbox/:id/reconcile) INSERTs
    // receipt_source = 'operator_reconciliation' UNMOCKED here — a CHECK that
    // drops the 658 value fails this with 23514.
    const { reconcileNotificationOutboxAttempt } = await import(
      '../services/notification/notificationOutboxAdminService.js'
    );
    const queued = await notificationOutbox.queue(intent(`event:${SUFFIX}:operator`), { strict: true });
    const [claim] = await notificationOutbox.claimPendingBatch({ tenantId: TENANT_ID, limit: 1 });
    expect(claim.id).toBe(queued.id);
    const [attempt] = await beginProviderAttempts({
      tenantId: TENANT_ID,
      outboxId: queued.id,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
      renderedIntentHash: claim.rendered_intent_hash,
      channels: ['push'],
    });
    await setTenantTx(TENANT_ID, tx => tx.$executeRawUnsafe(
      `UPDATE notification_outbox
          SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND id = $2::integer
          AND claim_token = $3::uuid`,
      TENANT_ID, queued.id, claim.claim_token,
    ));
    await reconcileExpiredClaims({ tenantId: TENANT_ID });
    expect(await readOutbox(queued.id)).toMatchObject({ status: 'RECONCILIATION_REQUIRED' });

    const reconciled = await reconcileNotificationOutboxAttempt({
      tenantId: TENANT_ID,
      id: queued.id,
      attemptId: attempt.attempt_id,
      providerReference: `projects/test/messages/operator-${SUFFIX}`,
      evidence: { provider_console_export_sha256: 'e'.repeat(64) },
      reason: 'Provider console confirms acceptance; recording operator evidence.',
      actorUid: ACTOR_UID,
      actorRole: 'ADMIN',
    });
    expect(reconciled.fully_reconciled).toBe(true);
    expect(reconciled.row).toMatchObject({ status: 'SENT' });

    const receipts = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT receipt_source, outcome, owner_actor_uid::text, owner_reason
         FROM notification_provider_receipts
        WHERE tenant_id = $1::uuid AND attempt_id = $2::uuid
          AND receipt_source = 'operator_reconciliation'`,
      TENANT_ID, attempt.attempt_id,
    ));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      receipt_source: 'operator_reconciliation',
      outcome: 'acknowledged',
      owner_actor_uid: ACTOR_UID,
    });
  }, 60_000);

  test('the 603 database guard blocks late notification intent creation but not factual receipts', async () => {
    await setTenantTx(TENANT_ID, async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.external_recovery_effect_disposition',
                           'late_pending_only', true)`,
      );
      await tx.$executeRawUnsafe('SAVEPOINT late_notification_intent');
      let failure;
      try {
        await notificationOutbox.queue(intent(`event:${SUFFIX}:late`), {
          tx,
          strict: true,
        });
      } catch (error) {
        failure = error;
      }
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT late_notification_intent');
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT late_notification_intent');
      expect(failure).toMatchObject({ code: 'P2010' });
      expect(String(failure?.message)).toContain(
        'late external recovery cannot mutate notification_outbox',
      );
    });
  });
});
