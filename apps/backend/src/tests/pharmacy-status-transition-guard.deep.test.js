/**
 * pharmacy_orders status state-machine DB backstop (re-review 2026-08-10 H2,
 * migration 649).
 *
 * The deleted legacy staff endpoint could write any string into
 * pharmacy_orders.status, bypassing ORDER_STATUS_TRANSITIONS and the BCMA
 * verification gate. The pharmacy_order_status_transition_guard trigger is
 * the backstop: canonical vocabulary on INSERT/status-change, legal
 * transitions on UPDATE, terminal states stay terminal, legacy off-vocab
 * rows keep working for non-status updates and may only be repaired onto the
 * canonical vocabulary.
 */
import { createHash } from 'node:crypto';
import prisma from '../lib/prisma.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
const PHONE = '+919999900649';
const NOTE = 'transition-guard-649 fixture';
const COURIER_UID = 'c649c649-0000-4000-8000-000000000649';

// Read the REAL SQLSTATE rather than sniffing the refusal's English.
//
// The previous form fell back to matching /is not allowed|canonical vocabulary/
// in err.message, and that fallback was load-bearing: Prisma 7 reports a
// trigger RAISE as P2010 with the driver error nested under
// meta.driverAdapterError.cause, so err.meta.code is undefined and err.code is
// 'P2010'. Migration 753 added a third refusal whose message says neither
// phrase ("... requires governed recovery before transition"), and the helper
// silently returned null for it — i.e. it read a real 23514 as "no error
// raised".
//
// Reading the nested SQLSTATE is strictly stronger in both directions: a
// refusal can no longer be missed because its wording changed, and an
// unrelated failure can no longer be accepted as 23514 because its message
// happens to contain "is not allowed".
function pgErrorCode(err) {
  if (!err) return null;
  const driverCause = err.meta?.driverAdapterError?.cause;
  const driverCode = driverCause?.code ?? driverCause?.originalCode;
  if (driverCode) return String(driverCode);
  if (err.meta?.code) return String(err.meta.code);
  if (err.code && /^\d/.test(String(err.code))) return String(err.code);
  const reported = /Raw query failed\. Code: `(\d+)`/.exec(String(err.message || ''));
  return reported ? reported[1] : null;
}

// Every fixture order names a real facility. Migration 753 added
// chk_pharmacy_orders_facility_progression_753 — `facility_id IS NOT NULL OR
// status IN (CANCELLED, DELIVERED, DISPENSED, UNAVAILABLE)` — so a PENDING row
// with no facility is refused 23514 by the CHECK before this suite's own
// trigger assertions can run. The facility is resolved from the seeded default
// tenant rather than hardcoded, because the check only cares that the row has
// authoritative custody, not which facility it is.
//
// Note the CHECK is not what any case here asserts: CHECK constraints are
// evaluated AFTER the BEFORE-row triggers, so the vocabulary and transition
// refusals this suite pins still fire first and still raise the same 23514.
let facilityId;
let courierUid;
let recoveryId;

async function insertOrder(status = 'PENDING') {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_orders (phone, order_note, status, tenant_id, facility_id, ordered_at, updated_at)
     VALUES ($1, $2, $3, $4::uuid, $5::int, NOW(), NOW()) RETURNING id, status`,
    PHONE, NOTE, status, DEFAULT_TENANT, facilityId,
  );
  return rows[0];
}

// The delivery walk cannot be driven by a bare status write any more.
// migration 753's guard_pharmacy_order_delivery_custody_753 refuses
// DISPATCHED/DELIVERED on a delivery_type='delivery' order (which is the column
// default) unless delivery_custody_contract_version=1, and
// chk_pharmacy_orders_delivery_handoff_lifecycle_753 then fixes the exact shape
// the rest of the custody columns must take at each of those two states. The
// fixture stamps that contract itself: this suite proves the 649 status machine,
// and a custody-bearing status is only reachable on a custody-bearing row.
//
// The handoff identity (assignee, token hash, expiry, generation, notice ids)
// is written once at dispatch and never rewritten — the same guard makes it
// immutable afterwards outside the reissue path — so deliverOrder touches only
// the three columns delivery legitimately changes.
async function dispatchOrder(id) {
  return prisma.$executeRawUnsafe(
    `UPDATE pharmacy_orders
        SET status='DISPATCHED',
            delivery_custody_contract_version=1,
            delivery_custody_status='in_transit',
            delivery_assignee_uid=$2::uuid,
            delivery_handoff_token_sha256=$3,
            delivery_handoff_expires_at=NOW()+INTERVAL '2 hours',
            delivery_handoff_generation=1,
            delivery_handoff_notice_outbox_ids=ARRAY[1]::int[],
            updated_at=NOW()
      WHERE id=$1`,
    id,
    courierUid,
    createHash('sha256').update(`transition-guard-649-handoff:${id}`).digest('hex'),
  );
}

async function deliverOrder(id) {
  return prisma.$executeRawUnsafe(
    `UPDATE pharmacy_orders
        SET status='DELIVERED',
            delivery_custody_status='delivered',
            delivery_handoff_consumed_at=NOW(),
            delivery_handoff_completed_by=$2::uuid,
            updated_at=NOW()
      WHERE id=$1`,
    id,
    courierUid,
  );
}

// A governed legacy repair: the trigger reads app.pharmacy_authority_recovery_id
// from the CURRENT transaction, so the GUC and the UPDATE have to share one.
async function setStatusUnderRecovery(id, status, recoveryWorklistId) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.pharmacy_authority_recovery_id', $1, TRUE)`,
      String(recoveryWorklistId),
    );
    return tx.$executeRawUnsafe(
      `UPDATE pharmacy_orders SET status = $1, updated_at = NOW() WHERE id = $2`,
      status, id,
    );
  });
}

async function setStatus(id, status) {
  return prisma.$executeRawUnsafe(
    `UPDATE pharmacy_orders SET status = $1, updated_at = NOW() WHERE id = $2`,
    status, id,
  );
}

async function expect23514(promise) {
  let code = null;
  try {
    await promise;
  } catch (err) {
    code = pgErrorCode(err);
  }
  expect(code).toBe('23514');
}

d('pharmacy_orders status transition guard (migration 649)', () => {
  async function cleanup() {
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_order_history WHERE order_id IN
         (SELECT id FROM pharmacy_orders WHERE order_note = $1)`,
      NOTE,
    ).catch(() => {});
    // The governed-repair worklist rows and their append-only event trail have
    // to go before the orders they name. trg_pharmacy_authority_recovery_event_753
    // records every worklist mutation, so the sweep runs under
    // session_replication_role='replica' — SET LOCAL, this superuser session
    // only, guards untouched everywhere else.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_inventory_authority_recovery_events
          WHERE recovery_id IN (
            SELECT recovery.id
              FROM pharmacy_inventory_authority_recovery_worklist recovery
             WHERE recovery.tenant_id=$1::uuid
               AND recovery.entity_type='pharmacy_order'
               AND recovery.entity_id IN (
                 SELECT id FROM pharmacy_orders WHERE order_note=$2
               ))`,
        DEFAULT_TENANT, NOTE,
      ).catch(() => {});
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_inventory_authority_recovery_worklist
          WHERE tenant_id=$1::uuid AND entity_type='pharmacy_order'
            AND entity_id IN (SELECT id FROM pharmacy_orders WHERE order_note=$2)`,
        DEFAULT_TENANT, NOTE,
      );
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
    }).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_orders WHERE order_note = $1`, NOTE,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = $1::uuid`, COURIER_UID,
    ).catch(() => {});
  }
  beforeAll(async () => {
    await cleanup();
    const facilities = await prisma.$queryRawUnsafe(
      `SELECT id FROM facilities
        WHERE tenant_id=$1::uuid AND status='active'
        ORDER BY id
        LIMIT 1`,
      DEFAULT_TENANT,
    );
    if (!facilities.length) {
      throw new Error('The default tenant has no active facility to bind these fixture orders to');
    }
    facilityId = Number(facilities[0].id);

    // delivery_assignee_uid / delivery_handoff_completed_by both FK to
    // users(tenant_id, uid), so the custody contract needs a real courier.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2::uuid, '9999900649', 'Transition Guard Courier',
               'DELIVERY_STAFF', TRUE, 'active', NOW())`,
      COURIER_UID,
      DEFAULT_TENANT,
    );
    courierUid = COURIER_UID;
  }, 120_000);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  }, 120_000);

  it('rejects an off-vocabulary status on INSERT (the H2 lowercase bypass)', async () => {
    await expect23514(insertOrder('dispensed'));
    await expect23514(insertOrder('SHIPPED'));
  });

  it('walks the legal delivery path end to end', async () => {
    const order = await insertOrder('PENDING');
    await setStatus(order.id, 'CONFIRMED');
    await setStatus(order.id, 'PREPARING');
    await setStatus(order.id, 'READY');
    await dispatchOrder(order.id);
    await deliverOrder(order.id);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT status FROM pharmacy_orders WHERE id = $1`, order.id,
    );
    expect(rows[0].status).toBe('DELIVERED');
  });

  it('blocks illegal jumps and terminal-state exits', async () => {
    const order = await insertOrder('PENDING');
    // PENDING cannot jump straight to DELIVERED / DISPATCHED / PREPARING.
    await expect23514(setStatus(order.id, 'DELIVERED'));
    await expect23514(setStatus(order.id, 'DISPATCHED'));
    await expect23514(setStatus(order.id, 'PREPARING'));
    // Counter dispense from PENDING is legal, and DISPENSED is terminal.
    await setStatus(order.id, 'DISPENSED');
    await expect23514(setStatus(order.id, 'PENDING'));
    await expect23514(setStatus(order.id, 'CANCELLED'));
  });

  // Migration 753 re-declared the transition table 649 installed and widened
  // PENDING, which used to allow only CONFIRMED/DISPENSED/UNAVAILABLE/CANCELLED
  // (649:92). PENDING -> READY is the walk-in counter case: an order picked and
  // set aside without a separate confirm step. This case exists so that
  // widening is pinned in the same place the refusals are, rather than being
  // discoverable only as a formerly-red assertion that quietly went green.
  it('accepts the transitions migration 753 added to the table', async () => {
    const straightToReady = await insertOrder('PENDING');
    await setStatus(straightToReady.id, 'READY');
    const onHold = await insertOrder('PENDING');
    await setStatus(onHold.id, 'ON_HOLD');
    await setStatus(onHold.id, 'CONFIRMED');
    const partial = await insertOrder('PENDING');
    await setStatus(partial.id, 'PARTIALLY_DISPENSED');
    await setStatus(partial.id, 'DISPENSED');
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM pharmacy_orders
        WHERE id IN ($1::int, $2::int, $3::int)
        ORDER BY id`,
      straightToReady.id, onHold.id, partial.id,
    );
    expect(rows.map((row) => row.status)).toEqual(['READY', 'CONFIRMED', 'DISPENSED']);
  });

  it('CANCELLED is terminal', async () => {
    const order = await insertOrder('PENDING');
    await setStatus(order.id, 'CANCELLED');
    await expect23514(setStatus(order.id, 'PENDING'));
  });

  it('legacy known statuses keep lifecycle semantics while unknown values remain repairable', async () => {
    // Simulate a pre-backstop legacy row by inserting with triggers disabled
    // (session_replication_role only affects this superuser session).
    await prisma.$executeRawUnsafe(`SET session_replication_role = replica`);
    let legacy;
    try {
      legacy = await insertOrder('dispensed');
    } finally {
      await prisma.$executeRawUnsafe(`SET session_replication_role = DEFAULT`);
    }
    expect(legacy.status).toBe('dispensed');

    // Non-status columns stay writable on the legacy row.
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_orders SET pharmacist_notes = 'ok' WHERE id = $1`, legacy.id,
    );

    // Repair to another off-vocabulary value is blocked.
    await expect23514(setStatus(legacy.id, 'delivered'));
    // A lowercase terminal state cannot use the generic repair path to
    // reopen or transition elsewhere, but a spelling-only repair is legal.
    await expect23514(setStatus(legacy.id, 'PENDING'));
    await expect23514(setStatus(legacy.id, 'CANCELLED'));
    await setStatus(legacy.id, 'DISPENSED');
    const rows = await prisma.$queryRawUnsafe(
      `SELECT status FROM pharmacy_orders WHERE id = $1`, legacy.id,
    );
    expect(rows[0].status).toBe('DISPENSED');

    // A genuinely unknown legacy value still has a repair path, but migration
    // 753 made that path GOVERNED. 649 let an unrecognised status move to any
    // canonical target on a bare UPDATE (649:78-85, "Truly unknown legacy rows
    // may be repaired to any canonical target"); 753 replaced that with an
    // exception unless the same transaction (a) targets ON_HOLD or CANCELLED,
    // (b) sets app.pharmacy_authority_recovery_id, and (c) that id names an
    // OPEN pharmacy_inventory_authority_recovery_worklist row for this exact
    // tenant + pharmacy_order + reason_code ORDER_STATUS_NONCANONICAL.
    // All three conjuncts are asserted below, so the repair path is now pinned
    // as an authorised operator action rather than as an unconditional escape.
    await prisma.$executeRawUnsafe(`SET session_replication_role = replica`);
    let unknown;
    try {
      unknown = await insertOrder('legacy_archived');
    } finally {
      await prisma.$executeRawUnsafe(`SET session_replication_role = DEFAULT`);
    }

    // (a) Ungoverned: refused, with no worklist row and no GUC.
    await expect23514(setStatus(unknown.id, 'CANCELLED'));

    const recoveryRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_authority_recovery_worklist
         (tenant_id, entity_type, entity_id, reason_code, authority_snapshot, status)
       VALUES ($1::uuid, 'pharmacy_order', $2::int, 'ORDER_STATUS_NONCANONICAL',
               $3::jsonb, 'OPEN')
       RETURNING id::text AS id`,
      DEFAULT_TENANT,
      unknown.id,
      JSON.stringify({ observed_status: 'legacy_archived' }),
    );
    recoveryId = recoveryRows[0].id;

    // (b) The worklist row alone is not authority — the transaction must also
    // name it. Still refused without the GUC.
    await expect23514(setStatus(unknown.id, 'CANCELLED'));

    // (c) A governed repair may only land on ON_HOLD or CANCELLED, even with
    // the worklist row and the GUC both present.
    await expect23514(setStatusUnderRecovery(unknown.id, 'PENDING', recoveryId));

    await setStatusUnderRecovery(unknown.id, 'CANCELLED', recoveryId);
    const repaired = await prisma.$queryRawUnsafe(
      `SELECT status FROM pharmacy_orders WHERE id = $1`, unknown.id,
    );
    expect(repaired[0].status).toBe('CANCELLED');
  });
});
