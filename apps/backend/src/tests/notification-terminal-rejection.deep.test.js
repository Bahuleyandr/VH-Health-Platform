// src/tests/notification-terminal-rejection.deep.test.js
//
// R3 (audit 2026-08-10) — one undeliverable recipient must not wedge the
// tenant's whole notification channel.
//
// Before this fix, ANY non-acknowledged provider receipt paused the
// per-tenant/channel delivery cursor (`paused_rejected`), and the paused
// channel excluded the blocked row itself from re-attempt — a single
// tokenless recipient at the head of the queue permanently halted every
// later push for the tenant, with no reachable un-pause path in prod.
//
// Now a TERMINAL per-recipient rejection (fcm_token_missing & friends) is
// recorded as evidence, the row dead-letters through the normal FAILED path,
// and the cursor resumes so the rest of the channel keeps delivering.
// paused_* stays reserved for ambiguous transport/channel-level failures,
// which an operator can now reset (resetChannelCursor) — and dead-lettered
// rows can be replayed (replayNotificationOutboxRow).
//
// Channels are used as isolation domains (cursors and strict ordering are
// per tenant+channel): push = terminal-skip flow, sms = pause/reset/replay
// flow, email = RECONCILIATION_REQUIRED supersede flow.
import { randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  applyProviderReceiptToCursor,
  beginProviderAttempts,
  recordProviderReceipt,
  reconcileExpiredClaims,
  listChannelCursors,
  resetChannelCursor,
} from '../services/notification/notificationDeliveryLedgerService.js';
import {
  listNotificationOutboxRows,
  replayNotificationOutboxRow,
} from '../services/notification/notificationOutboxAdminService.js';
import { notificationOutbox } from '../utils/notifications/notificationOutbox.js';
import { OPERATOR_REPLAY_SUPERSEDED_REASON } from '../utils/notifications/terminalRejectionCodes.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const ACTOR_UID = randomUUID();
const TOKENLESS_UID = randomUUID();
const REACHABLE_UID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);

let ambiguousRowId = null;

function intent(sourceEventKey, recipientUid, channel = 'push') {
  return {
    tenantId: TENANT_ID,
    type: channel,
    channel,
    sourceEventKey,
    templateVersion: 'critical-alert.v1',
    recipientId: recipientUid,
    title: 'Critical alert',
    body: 'Critical result ready.',
    data: { tenant_id: TENANT_ID, event: sourceEventKey },
  };
}

async function claimOne(expectedId) {
  const batch = await notificationOutbox.claimPendingBatch({ tenantId: TENANT_ID, limit: 10 });
  const claim = batch.find(row => row.id === expectedId);
  return { batch, claim };
}

async function attemptAndReceipt(claim, channel, { outcome, providerCode, providerReference = null }) {
  const [attempt] = await beginProviderAttempts({
    tenantId: TENANT_ID,
    outboxId: claim.id,
    claimToken: claim.claim_token,
    claimGeneration: claim.claim_generation,
    renderedIntentHash: claim.rendered_intent_hash,
    channels: [channel],
  });
  expect(attempt.state).toBe('ready');
  const receipt = await recordProviderReceipt({
    tenantId: TENANT_ID,
    attemptId: attempt.attempt_id,
    outboxId: claim.id,
    channel,
    outcome,
    receiptSource: 'provider_response',
    providerReference,
    providerCode,
    evidence: { test: SUFFIX },
  });
  return { attempt, receipt };
}

async function readOutbox(id) {
  return setTenantTx(TENANT_ID, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, status, retry_count, failure_reason, source_event_key
         FROM notification_outbox
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_ID, id,
    );
    return rows[0];
  });
}

async function readCursor(channel) {
  return setTenantTx(TENANT_ID, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT channel, state, last_contiguous_outbox_id, blocked_outbox_id,
              inflight_outbox_id
         FROM notification_delivery_cursors
        WHERE tenant_id = $1::uuid AND channel = $2::text`,
      TENANT_ID, channel,
    );
    return rows[0];
  });
}

async function clearAttemptBackoff(id) {
  await setTenantTx(TENANT_ID, tx => tx.$executeRawUnsafe(
    `UPDATE notification_outbox SET last_attempt_at = NULL
      WHERE tenant_id = $1::uuid AND id = $2::integer`,
    TENANT_ID, id,
  ));
}

describeIfDb('R3 — terminal per-recipient rejection does not wedge the channel', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'R3 terminal-rejection tenant')`,
      TENANT_ID, `r3-terminal-${SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, email, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, $4::uuid, $5::text, $6::text, 'R3 admin', 'ADMIN', true, NOW()),
         ($2::uuid, $4::uuid, $7::text, $8::text, 'R3 tokenless nurse', 'NURSING_STAFF', true, NOW()),
         ($3::uuid, $4::uuid, $9::text, $10::text, 'R3 reachable doctor', 'DUTY_DOCTOR', true, NOW())`,
      ACTOR_UID, TOKENLESS_UID, REACHABLE_UID, TENANT_ID,
      `93${SUFFIX.slice(0, 10)}`, `r3-admin-${SUFFIX}@example.test`,
      `94${SUFFIX.slice(0, 10)}`, `r3-tokenless-${SUFFIX}@example.test`,
      `95${SUFFIX.slice(0, 10)}`, `r3-reachable-${SUFFIX}@example.test`,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('(a) a terminal rejection skips the bad row, the REST of the channel delivers', async () => {
    const bad = await notificationOutbox.queue(intent(`r3:${SUFFIX}:bad`, TOKENLESS_UID), { strict: true });
    const good = await notificationOutbox.queue(intent(`r3:${SUFFIX}:good`, REACHABLE_UID), { strict: true });
    expect(good.id).toBeGreaterThan(bad.id);

    // Head of the queue: the tokenless recipient rejects terminally.
    const { claim: badClaim } = await claimOne(bad.id);
    expect(badClaim).toBeDefined();
    const { receipt: badReceipt } = await attemptAndReceipt(badClaim, 'push', {
      outcome: 'rejected',
      providerCode: 'fcm_token_missing',
    });
    const cursorAfterSkip = await applyProviderReceiptToCursor({
      tenantId: TENANT_ID,
      receiptId: badReceipt.receipt_id,
    });
    // The cursor RESUMES instead of pausing; the skipped row is reported.
    expect(cursorAfterSkip.state).toBe('ready');
    expect(Number(cursorAfterSkip.skipped_outbox_id)).toBe(bad.id);
    expect(cursorAfterSkip.terminal_rejection_code).toBe('fcm_token_missing');
    await notificationOutbox.markFailed(bad.id, 'provider_rejected_notification', {
      tenantId: TENANT_ID,
      claimToken: badClaim.claim_token,
      claimGeneration: badClaim.claim_generation,
    });

    // The REST of the channel still claims and delivers.
    const { claim: goodClaim } = await claimOne(good.id);
    expect(goodClaim).toBeDefined();
    const { receipt: goodReceipt } = await attemptAndReceipt(goodClaim, 'push', {
      outcome: 'acknowledged',
      providerCode: 'accepted',
      providerReference: `projects/test/messages/${SUFFIX}`,
    });
    const advanced = await applyProviderReceiptToCursor({
      tenantId: TENANT_ID,
      receiptId: goodReceipt.receipt_id,
    });
    // Cursor advances PAST the terminally-rejected row onto the acked one.
    expect(advanced.state).toBe('ready');
    expect(Number(advanced.last_contiguous_outbox_id)).toBe(good.id);
    await notificationOutbox.markSent(good.id, {
      tenantId: TENANT_ID,
      claimToken: goodClaim.claim_token,
      claimGeneration: goodClaim.claim_generation,
    });
    expect(await readOutbox(good.id)).toMatchObject({ status: 'SENT' });
    expect(await readOutbox(bad.id)).toMatchObject({ status: 'FAILED' });
  }, 60_000);

  test('operator reset cannot clear a live delivery lease', async () => {
    const row = await notificationOutbox.queue(
      intent(`r3:${SUFFIX}:live-lease`, REACHABLE_UID, 'print'),
      { strict: true },
    );
    const { claim } = await claimOne(row.id);
    expect(claim).toBeDefined();
    const [attempt] = await beginProviderAttempts({
      tenantId: TENANT_ID,
      outboxId: claim.id,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
      renderedIntentHash: claim.rendered_intent_hash,
      channels: ['print'],
    });
    expect(attempt.state).toBe('ready');
    expect((await readCursor('print')).state).toBe('delivering');

    await expect(resetChannelCursor({
      tenantId: TENANT_ID,
      channel: 'print',
      reason: 'Must not reset an active provider attempt.',
      actorUid: ACTOR_UID,
      actorRole: 'SUPER_ADMIN',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'NOTIFICATION_DELIVERY_CURSOR_NOT_PAUSED',
    });
    expect((await readCursor('print')).state).toBe('delivering');

    const receipt = await recordProviderReceipt({
      tenantId: TENANT_ID,
      attemptId: attempt.attempt_id,
      outboxId: row.id,
      channel: 'print',
      outcome: 'uncertain',
      receiptSource: 'transport_failure',
      providerCode: 'test_cleanup_uncertain',
      evidence: { test: SUFFIX },
    });
    await applyProviderReceiptToCursor({ tenantId: TENANT_ID, receiptId: receipt.receipt_id });
    await notificationOutbox.markReconciliationRequired(
      row.id,
      'test_cleanup_uncertain',
      {
        tenantId: TENANT_ID,
        claimToken: claim.claim_token,
        claimGeneration: claim.claim_generation,
      },
    );
  }, 60_000);

  test('lease reconciliation preserves a recorded terminal rejection as a dead letter', async () => {
    const row = await notificationOutbox.queue(
      intent(`r3:${SUFFIX}:terminal-crash`, REACHABLE_UID, 'whatsapp'),
      { strict: true },
    );
    const { claim } = await claimOne(row.id);
    expect(claim).toBeDefined();
    const [attempt] = await beginProviderAttempts({
      tenantId: TENANT_ID,
      outboxId: claim.id,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
      renderedIntentHash: claim.rendered_intent_hash,
      channels: ['whatsapp'],
    });
    await recordProviderReceipt({
      tenantId: TENANT_ID,
      attemptId: attempt.attempt_id,
      outboxId: row.id,
      channel: 'whatsapp',
      outcome: 'rejected',
      receiptSource: 'provider_response',
      providerCode: 'recipient_not_found',
      evidence: { test: SUFFIX },
    });
    await setTenantTx(TENANT_ID, tx => tx.$executeRawUnsafe(
      `UPDATE notification_outbox
          SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_ID, row.id,
    ));

    await reconcileExpiredClaims({ tenantId: TENANT_ID });

    expect(await readOutbox(row.id)).toMatchObject({
      status: 'FAILED',
      retry_count: 3,
      failure_reason: 'provider_terminal_rejection',
    });
    expect((await readCursor('whatsapp')).state).toBe('ready');
  }, 60_000);

  test('a late receipt cannot clear a newer delivery from the channel cursor', async () => {
    const oldRow = await notificationOutbox.queue(
      intent(`r3:${SUFFIX}:old-terminal`, TOKENLESS_UID, 'voice'),
      { strict: true },
    );
    const { claim: oldClaim } = await claimOne(oldRow.id);
    const { receipt: oldReceipt } = await attemptAndReceipt(oldClaim, 'voice', {
      outcome: 'rejected',
      providerCode: 'recipient_not_found',
    });
    await applyProviderReceiptToCursor({
      tenantId: TENANT_ID,
      receiptId: oldReceipt.receipt_id,
    });
    await notificationOutbox.markTerminalFailed(
      oldRow.id,
      'provider_terminal_rejection',
      {
        tenantId: TENANT_ID,
        claimToken: oldClaim.claim_token,
        claimGeneration: oldClaim.claim_generation,
      },
    );

    const newRow = await notificationOutbox.queue(
      intent(`r3:${SUFFIX}:new-inflight`, REACHABLE_UID, 'voice'),
      { strict: true },
    );
    const { claim: newClaim } = await claimOne(newRow.id);
    const [newAttempt] = await beginProviderAttempts({
      tenantId: TENANT_ID,
      outboxId: newClaim.id,
      claimToken: newClaim.claim_token,
      claimGeneration: newClaim.claim_generation,
      renderedIntentHash: newClaim.rendered_intent_hash,
      channels: ['voice'],
    });

    const stale = await applyProviderReceiptToCursor({
      tenantId: TENANT_ID,
      receiptId: oldReceipt.receipt_id,
    });
    expect(stale.stale).toBe(true);
    expect(await readCursor('voice')).toMatchObject({
      state: 'delivering',
      inflight_outbox_id: newRow.id,
      blocked_outbox_id: newRow.id,
    });

    const cleanupReceipt = await recordProviderReceipt({
      tenantId: TENANT_ID,
      attemptId: newAttempt.attempt_id,
      outboxId: newRow.id,
      channel: 'voice',
      outcome: 'uncertain',
      receiptSource: 'transport_failure',
      providerCode: 'test_cleanup_uncertain',
      evidence: { test: SUFFIX },
    });
    await applyProviderReceiptToCursor({
      tenantId: TENANT_ID,
      receiptId: cleanupReceipt.receipt_id,
    });
    await notificationOutbox.markReconciliationRequired(
      newRow.id,
      'test_cleanup_uncertain',
      {
        tenantId: TENANT_ID,
        claimToken: newClaim.claim_token,
        claimGeneration: newClaim.claim_generation,
      },
    );
  }, 60_000);

  test('a non-terminal (ambiguous) rejection still pauses, and the operator reset recovers it', async () => {
    const row = await notificationOutbox.queue(
      intent(`r3:${SUFFIX}:ambiguous`, REACHABLE_UID, 'sms'),
      { strict: true },
    );
    ambiguousRowId = row.id;
    const { claim } = await claimOne(row.id);
    expect(claim).toBeDefined();
    const { receipt } = await attemptAndReceipt(claim, 'sms', {
      outcome: 'rejected',
      providerCode: 'sms_gateway_not_configured',
    });
    const paused = await applyProviderReceiptToCursor({
      tenantId: TENANT_ID,
      receiptId: receipt.receipt_id,
    });
    expect(paused.state).toBe('paused_rejected');
    expect(Number(paused.blocked_outbox_id)).toBe(row.id);
    await notificationOutbox.markFailed(row.id, 'provider_rejected_notification', {
      tenantId: TENANT_ID,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
    });

    // Paused channel claims nothing — including the blocked row itself.
    await clearAttemptBackoff(row.id);
    const { claim: blockedClaim } = await claimOne(row.id);
    expect(blockedClaim).toBeUndefined();

    const cursors = await listChannelCursors({ tenantId: TENANT_ID });
    expect(cursors.find(c => c.channel === 'sms')).toMatchObject({ state: 'paused_rejected' });

    // Operator reset (named actor + reason) un-pauses; audit row persisted.
    const reset = await resetChannelCursor({
      tenantId: TENANT_ID,
      channel: 'sms',
      reason: 'Gateway configured; resuming the channel.',
      actorUid: ACTOR_UID,
      actorRole: 'SUPER_ADMIN',
      requestId: `r3-${SUFFIX}`,
    });
    expect(reset.state).toBe('ready');
    expect(reset.blocked_outbox_id).toBeNull();
    const audit = await prisma.$queryRawUnsafe(
      `SELECT action FROM audit_logs
        WHERE tenant_id = $1::uuid AND action = 'NOTIFICATION_CHANNEL_CURSOR_RESET'`,
      TENANT_ID,
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);

    // The FAILED row is claimable again after the pause lifts, and we leave it
    // FAILED for the replay test below.
    const { claim: reclaim } = await claimOne(row.id);
    expect(reclaim).toBeDefined();
    await notificationOutbox.markFailed(row.id, 'provider_rejected_notification', {
      tenantId: TENANT_ID,
      claimToken: reclaim.claim_token,
      claimGeneration: reclaim.claim_generation,
    });
  }, 60_000);

  test('operator replay of a FAILED row resumes the cursor blocked on that row', async () => {
    const row = await notificationOutbox.queue(
      intent(`r3:${SUFFIX}:failed-replay`, REACHABLE_UID, 'inapp'),
      { strict: true },
    );
    const { claim } = await claimOne(row.id);
    const { receipt } = await attemptAndReceipt(claim, 'inapp', {
      outcome: 'rejected',
      providerCode: 'inapp_provider_not_configured',
    });
    await applyProviderReceiptToCursor({ tenantId: TENANT_ID, receiptId: receipt.receipt_id });
    await notificationOutbox.markFailed(row.id, 'provider_rejected_notification', {
      tenantId: TENANT_ID,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
    });
    await setTenantTx(TENANT_ID, tx => tx.$executeRawUnsafe(
      `UPDATE notification_outbox SET retry_count = 3
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_ID, row.id,
    ));
    expect(await readCursor('inapp')).toMatchObject({
      state: 'paused_rejected',
      blocked_outbox_id: row.id,
    });

    await replayNotificationOutboxRow({
      tenantId: TENANT_ID,
      id: row.id,
      reason: 'Provider repaired; resume the exact blocked cursor.',
      actorUid: ACTOR_UID,
      actorRole: 'SUPER_ADMIN',
      requestId: `r3-failed-replay-${SUFFIX}`,
    });

    expect(await readCursor('inapp')).toMatchObject({
      state: 'ready',
      blocked_outbox_id: null,
    });
    expect(await readOutbox(row.id)).toMatchObject({
      status: 'FAILED',
      retry_count: 0,
      failure_reason: 'operator_replay_requested',
    });
  }, 60_000);

  test('(c-admin) operator replay: FAILED dead-letter gets its retry budget back', async () => {
    expect(ambiguousRowId).not.toBeNull();
    await setTenantTx(TENANT_ID, tx => tx.$executeRawUnsafe(
      `UPDATE notification_outbox SET retry_count = 3
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_ID, ambiguousRowId,
    ));
    const dead = await listNotificationOutboxRows({ tenantId: TENANT_ID, status: 'FAILED' });
    expect(dead.find(r => r.id === ambiguousRowId)?.dead_letter).toBe(true);

    const replayed = await replayNotificationOutboxRow({
      tenantId: TENANT_ID,
      id: ambiguousRowId,
      reason: 'Operator reviewed the failure; provider is back.',
      actorUid: ACTOR_UID,
      actorRole: 'SUPER_ADMIN',
      requestId: `r3-replay-${SUFFIX}`,
    });
    expect(replayed.mode).toBe('retry_reset');
    expect(await readOutbox(ambiguousRowId)).toMatchObject({
      status: 'FAILED',
      retry_count: 0,
      failure_reason: 'operator_replay_requested',
    });
    const audit = await prisma.$queryRawUnsafe(
      `SELECT action FROM audit_logs
        WHERE tenant_id = $1::uuid AND action = 'NOTIFICATION_OUTBOX_REPLAYED'
          AND resource_id = $2::text`,
      TENANT_ID, String(ambiguousRowId),
    );
    expect(audit).toHaveLength(1);
  }, 60_000);

  test('operator replay: RECONCILIATION_REQUIRED is superseded by a new intent and stops blocking', async () => {
    const row = await notificationOutbox.queue(
      intent(`r3:${SUFFIX}:uncertain`, REACHABLE_UID, 'email'),
      { strict: true },
    );
    const { claim } = await claimOne(row.id);
    expect(claim).toBeDefined();
    await beginProviderAttempts({
      tenantId: TENANT_ID,
      outboxId: row.id,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
      renderedIntentHash: claim.rendered_intent_hash,
      channels: ['email'],
    });
    await setTenantTx(TENANT_ID, tx => tx.$executeRawUnsafe(
      `UPDATE notification_outbox
          SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_ID, row.id,
    ));
    await reconcileExpiredClaims({ tenantId: TENANT_ID });
    expect(await readOutbox(row.id)).toMatchObject({ status: 'RECONCILIATION_REQUIRED' });
    expect((await readCursor('email')).state).toBe('paused_uncertain');

    const replayed = await replayNotificationOutboxRow({
      tenantId: TENANT_ID,
      id: row.id,
      reason: 'Provider console shows the send never left; duplicate risk accepted.',
      actorUid: ACTOR_UID,
      actorRole: 'SUPER_ADMIN',
      requestId: `r3-replay2-${SUFFIX}`,
    });
    expect(replayed.mode).toBe('requeued_new_intent');
    expect(replayed.replacement_id).toBeGreaterThan(row.id);
    expect(await readOutbox(row.id)).toMatchObject({
      status: 'RECONCILIATION_REQUIRED',
      failure_reason: OPERATOR_REPLAY_SUPERSEDED_REASON,
    });
    expect(await readOutbox(replayed.replacement_id)).toMatchObject({
      status: 'PENDING',
      source_event_key: `r3:${SUFFIX}:uncertain:operator-replay:${row.id}`,
    });
    // Cursor resumed in the same transaction...
    expect((await readCursor('email')).state).toBe('ready');
    // ...and the superseded row no longer blocks the channel: the replacement
    // is claimable even though an earlier email row is RECONCILIATION_REQUIRED.
    const { claim: replacementClaim } = await claimOne(replayed.replacement_id);
    expect(replacementClaim).toBeDefined();
    await notificationOutbox.releaseClaim(replayed.replacement_id, 'test_cleanup_defer', {
      tenantId: TENANT_ID,
      claimToken: replacementClaim.claim_token,
      claimGeneration: replacementClaim.claim_generation,
    });
    // A second replay of the same superseded row refuses.
    await expect(replayNotificationOutboxRow({
      tenantId: TENANT_ID,
      id: row.id,
      reason: 'Second attempt should refuse.',
      actorUid: ACTOR_UID,
      actorRole: 'SUPER_ADMIN',
    })).rejects.toMatchObject({ statusCode: 409 });
  }, 60_000);
});
