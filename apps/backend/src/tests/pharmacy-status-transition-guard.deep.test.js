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
import prisma from '../lib/prisma.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
const PHONE = '+919999900649';
const NOTE = 'transition-guard-649 fixture';

function pgErrorCode(err) {
  if (!err) return null;
  if (err.meta?.code) return String(err.meta.code);
  if (err.code && /^\d/.test(String(err.code))) return String(err.code);
  return /is not allowed|canonical vocabulary/i.test(err.message || '') ? '23514' : null;
}

async function insertOrder(status = 'PENDING') {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_orders (phone, order_note, status, tenant_id, ordered_at, updated_at)
     VALUES ($1, $2, $3, $4::uuid, NOW(), NOW()) RETURNING id, status`,
    PHONE, NOTE, status, DEFAULT_TENANT,
  );
  return rows[0];
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
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_orders WHERE order_note = $1`, NOTE,
    ).catch(() => {});
  }
  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('rejects an off-vocabulary status on INSERT (the H2 lowercase bypass)', async () => {
    await expect23514(insertOrder('dispensed'));
    await expect23514(insertOrder('SHIPPED'));
  });

  it('walks the legal delivery path end to end', async () => {
    const order = await insertOrder('PENDING');
    await setStatus(order.id, 'CONFIRMED');
    await setStatus(order.id, 'PREPARING');
    await setStatus(order.id, 'READY');
    await setStatus(order.id, 'DISPATCHED');
    await setStatus(order.id, 'DELIVERED');
    const rows = await prisma.$queryRawUnsafe(
      `SELECT status FROM pharmacy_orders WHERE id = $1`, order.id,
    );
    expect(rows[0].status).toBe('DELIVERED');
  });

  it('blocks illegal jumps and terminal-state exits', async () => {
    const order = await insertOrder('PENDING');
    // PENDING cannot jump straight to DELIVERED / DISPATCHED / READY.
    await expect23514(setStatus(order.id, 'DELIVERED'));
    await expect23514(setStatus(order.id, 'DISPATCHED'));
    await expect23514(setStatus(order.id, 'READY'));
    // Counter dispense from PENDING is legal, and DISPENSED is terminal.
    await setStatus(order.id, 'DISPENSED');
    await expect23514(setStatus(order.id, 'PENDING'));
    await expect23514(setStatus(order.id, 'CANCELLED'));
  });

  it('CANCELLED is terminal', async () => {
    const order = await insertOrder('PENDING');
    await setStatus(order.id, 'CANCELLED');
    await expect23514(setStatus(order.id, 'PENDING'));
  });

  it('legacy off-vocabulary rows: non-status updates work, repair must land on the vocabulary', async () => {
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

    // Repair to another off-vocabulary value is blocked …
    await expect23514(setStatus(legacy.id, 'delivered'));
    // … but repair onto the canonical vocabulary is allowed.
    await setStatus(legacy.id, 'CANCELLED');
    const rows = await prisma.$queryRawUnsafe(
      `SELECT status FROM pharmacy_orders WHERE id = $1`, legacy.id,
    );
    expect(rows[0].status).toBe('CANCELLED');
  });
});
