// I04 outbound HL7 delivery contiguity must be evaluated over the ledger
// generation only.
//
// Migration 610 introduced hl7_outbound_messages.ledger_version and backfilled
// EVERY pre-existing row to ledger_version = 0 with
// acknowledgement_state = 'legacy_unknown' (610:39-49). Those rows are held on
// purpose and can never reach 'aa'. The contiguity predicate in
// claimPendingFeedMessages / applyAcknowledgementToCursorTx must therefore skip
// them; if it does not, every feed that carries pre-610 history stops
// permanently and silently, because ids are IDENTITY-allocated and every new
// message sorts after the whole legacy backlog.
//
// The legacy rows seeded here reproduce exactly the state 610's backfill
// produces — verified by staging a database at migrations 000-609, inserting
// pre-610 rows, then applying 610: all three land as
// (ledger_version=0, status='reconciliation_required',
//  transport_state='legacy_unknown', acknowledgement_state='legacy_unknown',
//  send_authority='held_owner_reconciliation').

import { randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../lib/prisma.js';
import { generateACK } from '../services/hl7/hl7Parser.js';
import { queueFeedMessage } from '../services/hl7/hl7OutboundService.js';
import {
  beginTransportAttempt,
  claimPendingFeedMessages,
  recordTransportOutcome,
  sha256Bytes,
} from '../services/hl7/hl7OutboundDeliveryLedgerService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const TENANT_ID = randomUUID();
const ACTOR_UID = randomUUID();
const PATIENT_UID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);

// One message type per subscription: queueFeedMessage fans out to every active
// subscription that lists the type, so distinct types keep each case isolated.
const LEGACY_TYPE = 'ADT^A01';
const GREENFIELD_TYPE = 'ADT^A03';
const CONTIGUITY_TYPE = 'ORU^R01';

function outboundPayload(controlId, type) {
  return [
    `MSH|^~\\&|VHHEALTH|VH_HOSPITALS|DOWNSTREAM|HOSPITAL|20260804120000||${type}|${controlId}|P|2.5`,
    `PID|1||${PATIENT_UID}||Contiguity^Patient`,
  ].join('\r');
}

async function createSubscription(label, messageType) {
  return setTenantTx(TENANT_ID, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO hl7_feed_subscriptions
         (tenant_id, name, endpoint_url, message_types, created_by)
       VALUES ($1::uuid, $2::text, 'https://example.test/hl7',
               ARRAY[$3::text]::text[], $4::uuid)
       RETURNING id`,
      TENANT_ID, `contiguity ${label} ${SUFFIX}`, messageType, ACTOR_UID,
    );
    return rows[0].id;
  });
}

/**
 * Seed rows in exactly the state migration 610's backfill leaves pre-existing
 * history in. `message_control_id` is NULL on one of them because the pre-610
 * schema (283) allowed it — and such a row can never be acknowledged at all,
 * since validate_hl7_outbound_acknowledgement() rejects an acknowledgement for
 * a message with no original control id.
 */
async function seedPreLedgerHistory(subscriptionId) {
  return setTenantTx(TENANT_ID, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO hl7_outbound_messages
         (tenant_id, subscription_id, message_type, message_control_id,
          hl7_payload, source_table, source_id, source_event_key,
          payload_sha256, ledger_version, status, transport_state,
          acknowledgement_state, send_authority, attempts)
       SELECT $1::uuid, $2::integer, $3::text, seed.control_id,
              seed.payload, 'admissions', seed.source_id,
              'legacy-message:' || seed.source_id,
              encode(digest(convert_to(seed.payload, 'UTF8'), 'sha256'), 'hex'),
              0, 'reconciliation_required', 'legacy_unknown',
              'legacy_unknown', 'held_owner_reconciliation', seed.attempts
         FROM (VALUES
                 ($4::text, $5::text, $6::text, 1),
                 ($7::text, $8::text, $9::text, 3),
                 (NULL::text, $10::text, $11::text, 0)
              ) AS seed(control_id, payload, source_id, attempts)
       RETURNING id, ledger_version, status, acknowledgement_state`,
      TENANT_ID, subscriptionId, LEGACY_TYPE,
      `LEGACY1-${SUFFIX}`, outboundPayload(`LEGACY1-${SUFFIX}`, LEGACY_TYPE), `legacy1-${SUFFIX}`,
      `LEGACY2-${SUFFIX}`, outboundPayload(`LEGACY2-${SUFFIX}`, LEGACY_TYPE), `legacy2-${SUFFIX}`,
      'MSH|legacy-row-without-a-control-id', `legacy3-${SUFFIX}`,
    );
    return rows;
  });
}

/** Insert a ledger_version = 1 row directly, bypassing the delivery worker. */
async function seedLedgerMessage(subscriptionId, {
  controlId, status, acknowledgementState, transportState = 'not_attempted',
  sendAuthority = 'authorized',
}) {
  const payload = outboundPayload(controlId, CONTIGUITY_TYPE);
  return setTenantTx(TENANT_ID, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO hl7_outbound_messages
         (tenant_id, subscription_id, message_type, message_control_id,
          hl7_payload, source_table, source_id, source_event_key,
          payload_sha256, ledger_version, status, transport_state,
          acknowledgement_state, send_authority)
       VALUES ($1::uuid, $2::integer, $3::text, $4::text, $5::text,
               'lab_results', $6::text, $7::text, $8::char(64), 1,
               $9::text, $10::text, $11::text, $12::text)
       RETURNING id`,
      TENANT_ID, subscriptionId, CONTIGUITY_TYPE, controlId, payload,
      controlId, `ledger:${controlId}`, sha256Bytes(payload),
      status, transportState, acknowledgementState, sendAuthority,
    );
    return rows[0].id;
  });
}

async function loadMessages(subscriptionId) {
  return setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
    `SELECT id, ledger_version, status, transport_state,
            acknowledgement_state, send_authority, message_control_id
       FROM hl7_outbound_messages
      WHERE tenant_id = $1::uuid AND subscription_id = $2::integer
      ORDER BY id`,
    TENANT_ID, subscriptionId,
  ));
}

async function loadCursor(subscriptionId) {
  const rows = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
    `SELECT last_contiguous_message_id, state, blocked_message_id
       FROM hl7_outbound_delivery_cursors
      WHERE tenant_id = $1::uuid AND subscription_id = $2::integer`,
    TENANT_ID, subscriptionId,
  ));
  return rows[0] || null;
}

/** Full dispatch pass without network I/O: the transport result is supplied. */
async function dispatchOne(claimed, ackCode) {
  const attempt = await beginTransportAttempt({
    tenantId: TENANT_ID,
    messageId: claimed.id,
    subscriptionId: claimed.subscription_id,
    claimToken: claimed.claim_token,
    claimGeneration: claimed.claim_generation,
    payloadSha256: claimed.payload_sha256,
  });
  expect(attempt.state).toBe('ready');
  return recordTransportOutcome({
    tenantId: TENANT_ID,
    messageId: claimed.id,
    claimToken: claimed.claim_token,
    claimGeneration: claimed.claim_generation,
    attemptId: attempt.attempt_id,
    transport: {
      outcome: 'http_response',
      httpStatus: 200,
      responseBody: generateACK(claimed.message_control_id, ackCode, 'downstream'),
      evidence: { http_ok: true },
    },
  });
}

describeIfDb('I04 outbound contiguity is scoped to the ledger generation', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'I04 contiguity tenant')`,
      TENANT_ID, `i04-contig-${SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, email, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text,
               'I04 contiguity owner', 'ADMIN', true, NOW()),
              ($5::uuid, $2::uuid, $6::text, $7::text,
               'I04 contiguity patient', 'PATIENT', true, NOW())`,
      ACTOR_UID, TENANT_ID, `91${SUFFIX.slice(0, 10)}`,
      `owner-${SUFFIX}@example.test`, PATIENT_UID,
      `92${SUFFIX.slice(0, 10)}`, `patient-${SUFFIX}@example.test`,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('a feed carrying pre-610 history still dispatches and advances its cursor', async () => {
    const subscriptionId = await createSubscription('legacy', LEGACY_TYPE);
    const legacy = await seedPreLedgerHistory(subscriptionId);
    expect(legacy).toHaveLength(3);
    expect(legacy.every(row => row.ledger_version === 0)).toBe(true);
    expect(legacy.every(row => row.acknowledgement_state === 'legacy_unknown')).toBe(true);

    const controlId = `NEW-LEGACYFEED-${SUFFIX}`;
    const queued = await queueFeedMessage({
      tenantId: TENANT_ID,
      messageType: LEGACY_TYPE,
      hl7Payload: outboundPayload(controlId, LEGACY_TYPE),
      sourceTable: 'admissions',
      sourceId: `new-${SUFFIX}`,
      patientUid: PATIENT_UID,
    });
    expect(queued).toBe(1);

    // THE REGRESSION: without the ledger_version qualifier the three legacy
    // rows are unacknowledged predecessors of the new message, so nothing is
    // ever claimed and the feed is silently dead.
    const claimedRows = await claimPendingFeedMessages({ tenantId: TENANT_ID, limit: 25 });
    const claimed = claimedRows.find(row => row.subscription_id === subscriptionId);
    expect(claimed).toBeDefined();
    expect(claimed.message_control_id).toBe(controlId);

    const recorded = await dispatchOne(claimed, 'AA');
    expect(recorded.message).toMatchObject({
      status: 'sent',
      transport_state: 'http_response',
      acknowledgement_state: 'aa',
      send_authority: 'authorized',
    });

    // The cursor advances to the new message rather than pausing on a legacy row.
    const cursor = await loadCursor(subscriptionId);
    expect(cursor).toMatchObject({
      state: 'ready',
      blocked_message_id: null,
      last_contiguous_message_id: claimed.id,
    });

    // The legacy backlog itself stays held — the fix must not release it.
    const rows = await loadMessages(subscriptionId);
    const held = rows.filter(row => row.ledger_version === 0);
    expect(held).toHaveLength(3);
    for (const row of held) {
      expect(row).toMatchObject({
        status: 'reconciliation_required',
        transport_state: 'legacy_unknown',
        acknowledgement_state: 'legacy_unknown',
        send_authority: 'held_owner_reconciliation',
      });
    }
  }, 60_000);

  test('a feed with no pre-610 history is unaffected', async () => {
    const subscriptionId = await createSubscription('greenfield', GREENFIELD_TYPE);
    const controlId = `NEW-GREENFIELD-${SUFFIX}`;
    await queueFeedMessage({
      tenantId: TENANT_ID,
      messageType: GREENFIELD_TYPE,
      hl7Payload: outboundPayload(controlId, GREENFIELD_TYPE),
      sourceTable: 'admissions',
      sourceId: `greenfield-${SUFFIX}`,
      patientUid: PATIENT_UID,
    });

    const claimedRows = await claimPendingFeedMessages({ tenantId: TENANT_ID, limit: 25 });
    const claimed = claimedRows.find(row => row.subscription_id === subscriptionId);
    expect(claimed).toBeDefined();

    const recorded = await dispatchOne(claimed, 'AA');
    expect(recorded.message).toMatchObject({ status: 'sent', acknowledgement_state: 'aa' });
    expect(await loadCursor(subscriptionId)).toMatchObject({
      state: 'ready',
      last_contiguous_message_id: claimed.id,
    });
  }, 60_000);

  test('an unacknowledged LEDGER predecessor still blocks, and stops blocking once it is acknowledged', async () => {
    const subscriptionId = await createSubscription('ordering', CONTIGUITY_TYPE);
    // A ledger message that reached a terminal non-acknowledged state. It is
    // not itself claimable, so anything that lets the next message through
    // would be the contiguity predicate skipping a real gap.
    const predecessorId = await seedLedgerMessage(subscriptionId, {
      controlId: `LEDGER-PRED-${SUFFIX}`,
      status: 'dead',
      acknowledgementState: 'missing',
      transportState: 'transport_failure',
      sendAuthority: 'held_owner_reconciliation',
    });

    const controlId = `LEDGER-NEXT-${SUFFIX}`;
    await queueFeedMessage({
      tenantId: TENANT_ID,
      messageType: CONTIGUITY_TYPE,
      hl7Payload: outboundPayload(controlId, CONTIGUITY_TYPE),
      sourceTable: 'lab_results',
      sourceId: `ordering-${SUFFIX}`,
      patientUid: PATIENT_UID,
    });

    const blocked = await claimPendingFeedMessages({ tenantId: TENANT_ID, limit: 25 });
    expect(blocked.some(row => row.subscription_id === subscriptionId)).toBe(false);

    // Resolve the gap: now — and only now — the successor becomes claimable.
    await setTenantTx(TENANT_ID, tx => tx.$executeRawUnsafe(
      `UPDATE hl7_outbound_messages SET acknowledgement_state = 'aa'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_ID, predecessorId,
    ));

    const unblocked = await claimPendingFeedMessages({ tenantId: TENANT_ID, limit: 25 });
    const claimed = unblocked.find(row => row.subscription_id === subscriptionId);
    expect(claimed).toBeDefined();
    expect(claimed.message_control_id).toBe(controlId);
  }, 60_000);
});
