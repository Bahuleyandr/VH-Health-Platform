// src/services/pharmacy/inventoryV2Service.js
//
// Sprint 2 — Pharmacy inventory operational surface.
//
// The pharmacy_* schema landed in migration 123 (suppliers / items /
// batches / POs / GRNs / stock_movements / expiry_alerts) but the
// existing inventoryRoutes.js only exposed `GET /categories/list`.
// This module adds the day-to-day operational endpoints the pharmacy
// counter actually needs:
//
//   - browse + create items (drug master)
//   - browse batches by item, by expiry, by status
//   - record stock movements (receive / issue / transfer / dispose etc)
//     with auto-decrement of the chosen batch's remaining_quantity
//   - dispense narcotic / Schedule X drugs with witnessed register entry
//   - daily expiry scan that caches into pharmacy_expiry_scan_cache
//   - regulatory Schedule H / H1 / X register query
//
// All raw queries use $queryRawUnsafe with spread params (Phase 0.5
// convention). All money is stored in *_minor (paise) so quantities
// and money never lose precision.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { boundedInteger } from '../../utils/pagination.js';
import { AppError } from '../../utils/AppError.js';
import {
  ADMIN,
  DOCTOR,
  DUTY_DOCTOR,
  IP_INCHARGE,
  IP_STAFF_NURSE,
  MEDICAL_SUPERINTENDENT,
  NURSING_INCHARGE,
  NURSING_STAFF,
  OP_INCHARGE,
  OP_STAFF_NURSE,
  PHARMACY_INCHARGE,
  PHARMACY_STAFF,
  normalizeRole,
} from '../../utils/roles.js';

const ALLOWED_SCHEDULES = ['H', 'H1', 'X', 'OTC', null];
const VALID_MOVEMENTS = [
  'receive', 'issue', 'transfer_out', 'transfer_in', 'return',
  'adjust_increase', 'adjust_decrease', 'dispose', 'expire', 'recall',
];

function tenantOf(req) {
  return req?.user?.tenantId || req?.tenant?.id ||
    '00000000-0000-4000-8000-000000000001';
}

// ── Drug master / items ───────────────────────────────────────────────

export async function listItems({ tenantId, search, schedule, status = 'active', limit = 100 }) {
  const params = [tenantId];
  const where = [`tenant_id = $1::uuid`];
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (schedule) { params.push(schedule); where.push(`schedule_class = $${params.length}`); }
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    where.push(
      `(LOWER(display_name) LIKE $${params.length}` +
      ` OR LOWER(generic_name) LIKE $${params.length}` +
      ` OR LOWER(sku_code) LIKE $${params.length}` +
      ` OR LOWER(brand_name) LIKE $${params.length})`,
    );
  }
  params.push(boundedInteger(limit, { fallback: 100, min: 1, max: 200 }));
  return prisma.$queryRawUnsafe(
    `SELECT id, sku_code, display_name, generic_name, brand_name, manufacturer,
            form, strength, unit_label, schedule_class, is_narcotic,
            is_cold_chain, reorder_level, reorder_quantity, status
       FROM pharmacy_inventory_items
      WHERE ${where.join(' AND ')}
      ORDER BY display_name
      LIMIT $${params.length}::int`,
    ...params,
  );
}

export async function createItem({ tenantId, item }) {
  if (!item.sku_code || !item.display_name) {
    throw AppError.badRequest('sku_code + display_name are required');
  }
  if (item.schedule_class && !ALLOWED_SCHEDULES.includes(item.schedule_class)) {
    throw AppError.badRequest(`Invalid schedule_class. Allowed: ${ALLOWED_SCHEDULES.filter(Boolean).join(', ')}`);
  }
  // Schedule X is always narcotic; auto-flag.
  const isNarcotic = item.schedule_class === 'X' || Boolean(item.is_narcotic);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_inventory_items
       (tenant_id, sku_code, display_name, generic_name, brand_name,
        manufacturer, form, strength, unit_label, pack_size, hsn_code,
        schedule_class, is_narcotic, is_cold_chain, reorder_level,
        reorder_quantity)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING *`,
    tenantId,
    item.sku_code,
    item.display_name,
    item.generic_name || null,
    item.brand_name || null,
    item.manufacturer || null,
    item.form || null,
    item.strength || null,
    item.unit_label || 'each',
    item.pack_size || null,
    item.hsn_code || null,
    item.schedule_class || null,
    isNarcotic,
    Boolean(item.is_cold_chain),
    item.reorder_level || null,
    item.reorder_quantity || null,
  );
  return rows[0];
}

// ── Batches ───────────────────────────────────────────────────────────

export async function listBatches({ tenantId, item_id, expiring_in_days, status = 'in_stock', limit = 200 }) {
  const params = [tenantId];
  const where = [`b.tenant_id = $1::uuid`];
  if (item_id) { params.push(Number(item_id)); where.push(`b.inventory_item_id = $${params.length}::int`); }
  if (status) { params.push(status); where.push(`b.status = $${params.length}`); }
  if (expiring_in_days) {
    params.push(Number(expiring_in_days));
    where.push(`b.expiry_date <= CURRENT_DATE + ($${params.length}::int || ' days')::interval`);
  }
  params.push(boundedInteger(limit, { fallback: 200, min: 1, max: 500 }));
  return prisma.$queryRawUnsafe(
    `SELECT b.id, b.inventory_item_id, b.batch_number, b.lot_number,
            b.manufacture_date, b.expiry_date, b.received_quantity,
            b.remaining_quantity, b.unit_cost_minor, b.mrp_minor,
            b.supplier_id, b.status,
            i.sku_code, i.display_name, i.generic_name, i.unit_label,
            i.schedule_class, i.is_narcotic
       FROM pharmacy_inventory_batches b
       JOIN pharmacy_inventory_items i ON i.id = b.inventory_item_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.expiry_date ASC, b.id
      LIMIT $${params.length}::int`,
    ...params,
  );
}

// ── Stock movements ───────────────────────────────────────────────────

async function existingCathUsageMovement(
  db,
  { tenantId, inventoryItemId, inventoryBatchId, referenceId },
) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, tenant_id, inventory_item_id, inventory_batch_id, movement_kind,
            quantity_delta, reference_type, reference_id, performed_by, notes,
            created_at
       FROM pharmacy_stock_movements
      WHERE tenant_id = $1::uuid
        AND inventory_item_id = $2::int
        AND inventory_batch_id IS NOT DISTINCT FROM $3::int
        AND reference_type = 'cath_consumable_usage'
        AND reference_id = $4
      LIMIT 1`,
    tenantId,
    inventoryItemId,
    inventoryBatchId,
    referenceId,
  );
  return rows[0] || null;
}

function replayedMovementResult(movement, { movementKind, delta, increasing, decreasing }) {
  if (
    movement.movement_kind !== movementKind
    || Number(movement.quantity_delta) !== delta
  ) {
    throw AppError.conflict(
      'Existing cath consumable stock movement does not match the documented usage',
      'CATH_INVENTORY_MOVEMENT_REPLAY_CONFLICT',
    );
  }
  return {
    movement,
    increasing,
    decreasing,
    idempotent_replay: true,
  };
}

export async function recordMovement(params) {
  return setTenantTx(params.tenantId, async (tx) => recordMovementTx(tx, params));
}

/**
 * Transaction-scoped core of recordMovement. Runs every validation, the
 * FOR UPDATE batch lock, the insufficient-stock guard, the movement INSERT
 * and the batch decrement against a caller-supplied `tx` — it does NOT open
 * its own setTenantTx. Callers that must commit the movement atomically with
 * other writes in the same unit (e.g. dispenseControlled's statutory register
 * INSERT) open one setTenantTx themselves and call this directly. The public
 * recordMovement() wrapper above preserves the original single-movement
 * behaviour for every other caller.
 *
 * Exported for same-transaction composers (counterSaleService's walk-in POS
 * finalize/void) that must commit several movements atomically with their own
 * evidence rows.
 */
export async function recordMovementTx(tx, {
  tenantId, inventory_item_id, inventory_batch_id, movement_kind,
  quantity, reference_type, reference_id, notes, performed_by,
  require_usable_batch = false,
  expected_batch_number = null,
  expected_lot_number = null,
  expected_expiry_date = null,
}) {
  if (!VALID_MOVEMENTS.includes(movement_kind)) {
    throw AppError.badRequest(`Invalid movement_kind. Allowed: ${VALID_MOVEMENTS.join(', ')}`);
  }
  if (!inventory_item_id) throw AppError.badRequest('inventory_item_id is required');
  if (!quantity || Number(quantity) <= 0) throw AppError.badRequest('quantity must be > 0');

  const decreasing = ['issue', 'transfer_out', 'dispose', 'expire', 'recall', 'adjust_decrease'].includes(movement_kind);
  const increasing = ['receive', 'transfer_in', 'return', 'adjust_increase'].includes(movement_kind);
  const delta = decreasing ? -Math.abs(Number(quantity)) : Math.abs(Number(quantity));
  const inventoryItemId = Number(inventory_item_id);
  const inventoryBatchId = inventory_batch_id ? Number(inventory_batch_id) : null;
  const cathUsageReplay = reference_type === 'cath_consumable_usage'
    && reference_id !== null
    && reference_id !== undefined
    && String(reference_id).trim() !== '';
  const cathReferenceId = cathUsageReplay ? String(reference_id).trim() : null;

  {
    // Lock the exact tenant/item batch before checking and decrementing it so
    // concurrent issues cannot both consume the same remaining quantity.
    if (inventoryBatchId) {
      const batches = await tx.$queryRawUnsafe(
        `SELECT id, inventory_item_id, batch_number, lot_number, expiry_date,
                remaining_quantity, status,
                (expiry_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS is_expired
           FROM pharmacy_inventory_batches
          WHERE id = $1::int
            AND tenant_id = $2::uuid
            AND inventory_item_id = $3::int
          FOR UPDATE`,
        inventoryBatchId,
        tenantId,
        inventoryItemId,
      );
      if (!batches.length) throw AppError.notFound('Batch not found');
      const batch = batches[0];
      if (cathUsageReplay) {
        const existing = await existingCathUsageMovement(tx, {
          tenantId,
          inventoryItemId,
          inventoryBatchId,
          referenceId: cathReferenceId,
        });
        if (existing) {
          return replayedMovementResult(existing, {
            movementKind: movement_kind,
            delta,
            increasing,
            decreasing,
          });
        }
      }
      const actualExpiry = batch.expiry_date instanceof Date
        ? batch.expiry_date.toISOString().slice(0, 10)
        : String(batch.expiry_date || '').slice(0, 10);
      const expectedBatch = String(expected_batch_number || '').trim();
      const expectedLot = String(expected_lot_number || '').trim();
      const expectedExpiry = expected_expiry_date instanceof Date
        ? expected_expiry_date.toISOString().slice(0, 10)
        : String(expected_expiry_date || '').slice(0, 10);
      if (
        (expectedBatch && expectedBatch !== String(batch.batch_number || '').trim())
        || (expectedLot && expectedLot !== String(batch.lot_number || '').trim())
        || (expectedExpiry && expectedExpiry !== actualExpiry)
      ) {
        throw AppError.badRequest(
          'Inventory batch lineage does not match the documented batch/lot/expiry',
          'INVENTORY_BATCH_LINEAGE_MISMATCH',
        );
      }
      if (require_usable_batch && decreasing && batch.status !== 'in_stock') {
        throw AppError.badRequest(
          `Inventory batch is not available for issue (status: ${batch.status})`,
          'INVENTORY_BATCH_UNAVAILABLE',
        );
      }
      if (require_usable_batch && decreasing && batch.is_expired) {
        throw AppError.badRequest(
          'Inventory batch is expired and cannot be issued',
          'INVENTORY_BATCH_EXPIRED',
        );
      }
      if (decreasing && Number(batch.remaining_quantity) + delta < 0) {
        throw AppError.badRequest(
          `Insufficient stock. Available: ${batch.remaining_quantity}`,
          'INVENTORY_INSUFFICIENT_STOCK',
        );
      }
    } else if (cathUsageReplay) {
      const existing = await existingCathUsageMovement(tx, {
        tenantId,
        inventoryItemId,
        inventoryBatchId: null,
        referenceId: cathReferenceId,
      });
      if (existing) {
        return replayedMovementResult(existing, {
          movementKind: movement_kind,
          delta,
          increasing,
          decreasing,
        });
      }
    }

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO pharmacy_stock_movements
         (tenant_id, inventory_item_id, inventory_batch_id, movement_kind,
        quantity_delta, reference_type, reference_id, performed_by, notes)
       VALUES ($1::uuid, $2::int, $3, $4, $5::numeric, $6, $7, $8::uuid, $9)
       ${cathUsageReplay ? 'ON CONFLICT DO NOTHING' : ''}
       RETURNING *`,
      tenantId,
      inventoryItemId,
      inventoryBatchId,
      movement_kind,
      delta,
      reference_type || null,
      reference_id || null,
      performed_by ? String(performed_by) : null,
      notes || null,
    );
    if (cathUsageReplay && !rows[0]) {
      const existing = await existingCathUsageMovement(tx, {
        tenantId,
        inventoryItemId,
        inventoryBatchId,
        referenceId: cathReferenceId,
      });
      if (!existing) {
        throw AppError.conflict(
          'Cath consumable stock movement replay could not be resolved',
          'CATH_INVENTORY_MOVEMENT_REPLAY_RACE',
        );
      }
      return replayedMovementResult(existing, {
        movementKind: movement_kind,
        delta,
        increasing,
        decreasing,
      });
    }
    if (inventoryBatchId) {
      await tx.$executeRawUnsafe(
        `UPDATE pharmacy_inventory_batches
            SET remaining_quantity = remaining_quantity + $1::numeric,
                status = CASE WHEN remaining_quantity + $1::numeric <= 0 THEN 'depleted' ELSE status END,
                updated_at = NOW()
          WHERE id = $2::int
            AND tenant_id = $3::uuid
            AND inventory_item_id = $4::int`,
        delta,
        inventoryBatchId,
        tenantId,
        inventoryItemId,
      );
    }
    return { movement: rows[0], increasing, decreasing };
  }
}

// ── Schedule H/H1/X register ──────────────────────────────────────────

/**
 * Transaction-scoped core of dispenseControlled. Runs the controlled-substance
 * pre-conditions, the stock decrement (recordMovementTx) and the statutory
 * pharmacy_schedule_register INSERT against a caller-supplied `tx`. Callers
 * that must commit a controlled dispense atomically with other writes in the
 * same unit (the walk-in POS finalize, which pairs it with sale evidence and
 * the invoice payment) open one setTenantTx themselves and call this directly
 * — there is deliberately no second controlled-dispense mechanism. The public
 * dispenseControlled() wrapper below preserves the original single-dispense
 * behaviour for every other caller.
 *
 * `reference_id` optionally overrides the movement's reference (defaults to
 * the prescription number) so composers can point the movement at their own
 * evidence row; `require_usable_batch` adds recordMovementTx's expired/
 * non-in-stock batch rejection.
 */
// ── Controlled-dispense witness validation (PR #875 follow-up) ────────────
//
// witness_uid/witness_name were previously stored as UNVALIDATED client text:
// any uid (or garbage) landed on the statutory Schedule X / narcotic register
// as the legally-required second signature. The witness must be a real,
// active, clinically-appropriate staff identity of the SAME tenant, and a
// different person than the dispenser — validated at dispense time, the same
// posture as marService's retrospective MAR witness check (tenant + active +
// role + FOR KEY SHARE) and taskService's requireAssignableTaskRole.
//
// Eligible roles: the pharmacy dispensing roster (a second pharmacist is the
// normal counter witness) plus doctors and the nursing roster (the ward
// controlled-dispense flow is witnessed at the bedside). Non-clinical
// identities (reception, housekeeping, PATIENT, the PHARMACY_WALKIN anchor…)
// can never witness a controlled dispense.
export const CONTROLLED_DISPENSE_WITNESS_ROLES = [
  ADMIN,
  PHARMACY_STAFF,
  PHARMACY_INCHARGE,
  DOCTOR,
  DUTY_DOCTOR,
  MEDICAL_SUPERINTENDENT,
  NURSING_STAFF,
  NURSING_INCHARGE,
  IP_STAFF_NURSE,
  IP_INCHARGE,
  OP_STAFF_NURSE,
  OP_INCHARGE,
];

const WITNESS_ELIGIBLE_ROLE_SET = new Set(CONTROLLED_DISPENSE_WITNESS_ROLES);
const WITNESS_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a controlled-dispense witness identity against the live staff
 * roster. Runs on the caller's client (`db` may be a transaction client or
 * plain prisma — the counter-sale Phase-0 pre-flight uses the latter so an
 * invalid witness rejects before any invoice is issued). Throws AppError 400
 * with a machine-readable code; returns the validated witness row.
 */
export async function assertControlledDispenseWitness(db, {
  tenantId, witnessUid, witnessName, performedBy,
}) {
  const uid = witnessUid == null ? '' : String(witnessUid).trim();
  if (!WITNESS_UUID_RE.test(uid)) {
    throw AppError.badRequest(
      'witness.uid must be the staff uid (UUID) of the witnessing staff member',
      'CONTROLLED_DISPENSE_WITNESS_INVALID',
    );
  }
  if (performedBy && String(performedBy).trim() === uid) {
    throw AppError.badRequest(
      'The dispensing staff member cannot witness their own controlled dispense — name a second staff member',
      'CONTROLLED_DISPENSE_WITNESS_SELF',
    );
  }
  // FOR KEY SHARE (marService MAR-witness idiom): pin the witness row for the
  // duration of the dispense transaction so a concurrent deactivation cannot
  // race the register write.
  const rows = await db.$queryRawUnsafe(
    `SELECT uid::text AS uid, name, role
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND is_active = true
        AND status = 'active'
        AND COALESCE(is_deleted, false) = false
      LIMIT 1
      FOR KEY SHARE`,
    tenantId,
    uid,
  );
  if (!rows.length) {
    throw AppError.badRequest(
      'Witness is not an active staff member of this facility',
      'CONTROLLED_DISPENSE_WITNESS_NOT_FOUND',
    );
  }
  const witness = rows[0];
  const role = normalizeRole(witness.role);
  if (!role || !WITNESS_ELIGIBLE_ROLE_SET.has(role)) {
    throw AppError.badRequest(
      'Witness must hold a pharmacy, medical, or nursing role to witness a controlled dispense',
      'CONTROLLED_DISPENSE_WITNESS_ROLE_INELIGIBLE',
      { witness_role: witness.role || null },
    );
  }
  void witnessName; // display name stays a caller-supplied snapshot; identity is the uid
  return witness;
}

export async function dispenseControlledTx(tx, {
  tenantId,
  inventory_item_id, inventory_batch_id,
  quantity, patient_uid, patient_name, patient_phone,
  prescription_id, prescription_number,
  prescriber_uid, prescriber_name, prescriber_registration,
  patient_id_proof_type, patient_id_proof_last4,
  performed_by, performed_by_name,
  witness_uid, witness_name, notes,
  reference_id = null,
  require_usable_batch = false,
}) {
  // Pre-conditions: item must be Schedule H/H1/X (or marked narcotic).
  const items = await tx.$queryRawUnsafe(
    `SELECT id, schedule_class, is_narcotic, unit_label
       FROM pharmacy_inventory_items
      WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(inventory_item_id), tenantId,
  );
  if (!items.length) throw AppError.notFound('Inventory item not found');
  const item = items[0];
  if (!['H', 'H1', 'X'].includes(item.schedule_class) && !item.is_narcotic) {
    throw AppError.badRequest('Item is not a controlled substance — use the regular issue path');
  }
  // Witness required for Schedule X / narcotic.
  if ((item.schedule_class === 'X' || item.is_narcotic) && (!witness_uid || !witness_name)) {
    throw AppError.badRequest('Witness (witness_uid + witness_name) is required for Schedule X / narcotic dispense');
  }
  if (!performed_by || !performed_by_name) {
    throw AppError.badRequest('performed_by + performed_by_name are required');
  }
  // Whenever a witness identity is supplied (mandatory for X/narcotic,
  // optional evidence on H/H1), it must be a real, active, appropriately
  // rolled staff member of THIS tenant and not the dispenser — never
  // unvalidated client text on the statutory register (PR #875 follow-up).
  if (witness_uid) {
    await assertControlledDispenseWitness(tx, {
      tenantId,
      witnessUid: witness_uid,
      witnessName: witness_name,
      performedBy: performed_by,
    });
  }

  {
    // Record the underlying stock movement (decrements batch) inside the tx.
    const { movement } = await recordMovementTx(tx, {
      tenantId,
      inventory_item_id,
      inventory_batch_id,
      movement_kind: 'issue',
      quantity,
      reference_type: 'controlled_dispense',
      reference_id: reference_id || prescription_number || `pres-${prescription_id || ''}`,
      performed_by,
      notes: `Schedule ${item.schedule_class} dispense; witness ${witness_name || 'n/a'}`,
      require_usable_batch,
    });

    // Compute running balance across batches, read inside the same tx so it
    // reflects the decrement above (no stale-balance race).
    const balance = await tx.$queryRawUnsafe(
      `SELECT COALESCE(SUM(remaining_quantity), 0)::numeric AS bal
         FROM pharmacy_inventory_batches
        WHERE inventory_item_id = $1::int AND tenant_id = $2::uuid AND status = 'in_stock'`,
      Number(inventory_item_id), tenantId,
    );

    const reg = await tx.$queryRawUnsafe(
      `INSERT INTO pharmacy_schedule_register
         (tenant_id, inventory_item_id, inventory_batch_id, schedule_class,
          movement_kind, quantity, unit_label, running_balance,
          patient_uid, patient_name, patient_phone,
          prescription_id, prescription_number,
          prescriber_uid, prescriber_name, prescriber_registration,
          patient_id_proof_type, patient_id_proof_last4,
          performed_by, performed_by_name, witness_uid, witness_name,
          reference_movement_id, notes)
       VALUES ($1::uuid, $2::int, $3, $4, 'dispense', $5::numeric, $6, $7::numeric,
               $8::uuid, $9, $10, $11, $12, $13::uuid, $14, $15, $16, $17,
               $18::uuid, $19, $20::uuid, $21, $22::int, $23)
       RETURNING *`,
      tenantId,
      Number(inventory_item_id),
      inventory_batch_id ? Number(inventory_batch_id) : null,
      item.schedule_class || (item.is_narcotic ? 'X' : 'H1'),
      Number(quantity),
      item.unit_label,
      Number(balance[0].bal),
      patient_uid ? String(patient_uid) : null,
      patient_name ? String(patient_name).trim().slice(0, 255) : null,
      patient_phone ? String(patient_phone).trim().slice(0, 20) : null,
      prescription_id ? Number(prescription_id) : null,
      prescription_number || null,
      prescriber_uid ? String(prescriber_uid) : null,
      prescriber_name || null,
      prescriber_registration || null,
      patient_id_proof_type || null,
      patient_id_proof_last4 ? String(patient_id_proof_last4).slice(-4) : null,
      String(performed_by),
      performed_by_name,
      witness_uid ? String(witness_uid) : null,
      witness_name || null,
      movement.id,
      notes || null,
    );

    return { register_entry: reg[0], movement };
  }
}

export async function dispenseControlled(params) {
  // The stock decrement and the statutory Schedule H/H1/X/narcotic register
  // entry MUST commit as a single unit: a controlled substance can never be
  // decremented off the shelf without its register row (dispensing off the
  // statutory register), and a register row must never outlive a rolled-back
  // decrement. Open ONE tenant-scoped transaction and do both inside it — the
  // batch FOR UPDATE lock, insufficient-stock guard and decrement (via
  // recordMovementTx), the running-balance read, and the register INSERT — so
  // a crash between them rolls the whole thing back with no compensating step.
  return setTenantTx(params.tenantId, async (tx) => dispenseControlledTx(tx, params));
}

export async function listScheduleRegister({ tenantId, schedule_class, item_id, date_from, date_to, limit = 200 }) {
  const params = [tenantId];
  const where = [`tenant_id = $1::uuid`];
  if (schedule_class) { params.push(schedule_class); where.push(`schedule_class = $${params.length}`); }
  if (item_id) { params.push(Number(item_id)); where.push(`(SELECT id FROM pharmacy_inventory_items WHERE id = $${params.length}::int) IS NOT NULL`); }
  // Note: filtering by item_id needs the view's pre-joined columns.
  // We'll filter at the view level.
  if (date_from) { params.push(date_from); where.push(`created_at >= $${params.length}::timestamptz`); }
  if (date_to) { params.push(date_to); where.push(`created_at <= $${params.length}::timestamptz`); }
  params.push(boundedInteger(limit, { fallback: 200, min: 1, max: 500 }));
  return prisma.$queryRawUnsafe(
    `SELECT * FROM pharmacy_schedule_register_full
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${params.length}::int`,
    ...params,
  );
}

// ── Expiry scan ───────────────────────────────────────────────────────

/**
 * Scan all in_stock batches for the tenant; bucket by expiry-window;
 * upsert into pharmacy_expiry_scan_cache and mark expired batches.
 * Returns counts per bucket. Idempotent and safe to run multiple times.
 *
 * Run nightly via the scheduler; expose POST /run-expiry-scan to trigger
 * manually for testing or after a recall.
 */
export async function runExpiryScan({ tenantId }) {
  // Mark batches with expiry_date < today as 'expired' (only for those
  // still in_stock — depleted/disposed/recalled stays terminal).
  const expired = await prisma.$executeRawUnsafe(
    `UPDATE pharmacy_inventory_batches
        SET status = 'expired', updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND status = 'in_stock'
        AND expiry_date < CURRENT_DATE`,
    tenantId,
  );

  // Wipe + repopulate the scan cache for this tenant. Wipe is fine
  // because the cache is decorative; scan is authoritative.
  await prisma.$executeRawUnsafe(
    `DELETE FROM pharmacy_expiry_scan_cache WHERE tenant_id = $1::uuid`,
    tenantId,
  );

  await prisma.$executeRawUnsafe(
    `INSERT INTO pharmacy_expiry_scan_cache
       (tenant_id, inventory_batch_id, inventory_item_id, expiry_date,
        remaining_quantity, days_to_expiry, bucket)
     SELECT tenant_id, id, inventory_item_id, expiry_date,
            remaining_quantity,
            (expiry_date - CURRENT_DATE)::int,
            CASE
              WHEN expiry_date < CURRENT_DATE THEN 'expired'
              WHEN expiry_date - CURRENT_DATE <= 30 THEN '0-30'
              WHEN expiry_date - CURRENT_DATE <= 60 THEN '31-60'
              WHEN expiry_date - CURRENT_DATE <= 90 THEN '61-90'
              ELSE 'beyond-90'
            END
       FROM pharmacy_inventory_batches
      WHERE tenant_id = $1::uuid
        AND status IN ('in_stock', 'expired')
        AND remaining_quantity > 0`,
    tenantId,
  );

  const counts = await prisma.$queryRawUnsafe(
    `SELECT bucket, COUNT(*)::int AS batch_count, SUM(remaining_quantity)::numeric AS units
       FROM pharmacy_expiry_scan_cache
      WHERE tenant_id = $1::uuid AND bucket != 'beyond-90'
      GROUP BY bucket
      ORDER BY bucket`,
    tenantId,
  );
  logger.info(`Pharmacy expiry scan completed for tenant=${tenantId}: ${expired} newly-expired, ${counts.length} buckets`);
  return { newly_expired: expired, buckets: counts };
}

export async function listExpiryAlerts({ tenantId, bucket, limit = 100 }) {
  const params = [tenantId];
  const where = [`c.tenant_id = $1::uuid`];
  if (bucket) { params.push(bucket); where.push(`c.bucket = $${params.length}`); }
  // Default: anything not "beyond-90"
  if (!bucket) where.push(`c.bucket != 'beyond-90'`);
  params.push(boundedInteger(limit, { fallback: 100, min: 1, max: 200 }));
  return prisma.$queryRawUnsafe(
    `SELECT c.*, i.sku_code, i.display_name, i.generic_name, i.unit_label, i.schedule_class,
            b.batch_number, b.lot_number, b.supplier_id
       FROM pharmacy_expiry_scan_cache c
       JOIN pharmacy_inventory_items i ON i.id = c.inventory_item_id
       JOIN pharmacy_inventory_batches b ON b.id = c.inventory_batch_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.days_to_expiry ASC
      LIMIT $${params.length}::int`,
    ...params,
  );
}

export { tenantOf, ALLOWED_SCHEDULES, VALID_MOVEMENTS };
