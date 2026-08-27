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
  CONTROLLED_DISPENSE_APPROVAL_SCOPES,
  CONTROLLED_DISPENSE_WITNESS_ROLES,
  approveControlledDispenseWitnessApproval,
  consumeControlledDispenseWitnessApproval,
  createControlledDispenseWitnessApproval,
  isControlledDispenseWitnessEvidence,
} from './controlledDispenseWitnessService.js';

export { CONTROLLED_DISPENSE_WITNESS_ROLES };

const ALLOWED_SCHEDULES = ['H', 'H1', 'X', 'OTC', null];
const VALID_MOVEMENTS = [
  'receive', 'issue', 'transfer_out', 'transfer_in', 'return',
  'adjust_increase', 'adjust_decrease', 'dispose', 'expire', 'recall',
];
const CONTROLLED_DECREASING_MOVEMENTS = new Set([
  'transfer_out', 'adjust_decrease', 'dispose', 'expire', 'recall',
]);
const CONTROLLED_BATCH_POLICY_BY_MOVEMENT = Object.freeze({
  transfer_out: 'usable',
  adjust_decrease: 'usable',
  dispose: 'disposable',
  expire: 'expired',
  recall: 'recallable',
});
const CONTROLLED_MOVEMENT_BATCH_CONTRACT =
  'controlled_movement_exact_batch_policy_v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Schedule H / H1 / X are the register-tracked controlled classes (migration
// 150); Schedule X and any narcotic-flagged item additionally demand a witness
// on every decrement. Kept in lockstep with counterSaleService's SCHEDULED_CLASSES.
const CONTROLLED_SCHEDULES = ['H', 'H1', 'X'];

function isControlledItem(item) {
  return CONTROLLED_SCHEDULES.includes(item?.schedule_class) || item?.is_narcotic === true;
}

// Maps a stock movement_kind onto the statutory register's own vocabulary
// (migration 150: receive / dispense / return / dispose / recall / adjust).
// 'issue' is deliberately absent — a controlled issue is a patient dispense and
// must go through the witnessed /controlled-dispense path, never this endpoint.
const REGISTER_KIND_BY_MOVEMENT = {
  receive: 'receive',
  transfer_in: 'receive',
  return: 'return',
  adjust_increase: 'adjust',
  adjust_decrease: 'adjust',
  dispose: 'dispose',
  expire: 'dispose',
  recall: 'recall',
  transfer_out: 'adjust',
};

async function loadMovementItem(db, tenantId, inventoryItemId) {
  const id = Number(inventoryItemId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT id, schedule_class, is_narcotic, unit_label
       FROM pharmacy_inventory_items
      WHERE id = $1::int AND tenant_id = $2::uuid`,
    id,
    tenantId,
  );
  return rows[0] || null;
}

function tenantOf(req) {
  return req?.user?.tenantId || req?.tenant?.id ||
    '00000000-0000-4000-8000-000000000001';
}

// ── Drug master / items ───────────────────────────────────────────────

export async function listItems({
  tenantId,
  search,
  schedule,
  status = 'active',
  catalogId,
  limit = 100,
}) {
  const params = [tenantId];
  const where = [`tenant_id = $1::uuid`];
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (schedule) { params.push(schedule); where.push(`schedule_class = $${params.length}`); }
  if (catalogId != null && String(catalogId).trim() !== '') {
    const exactCatalogId = Number(catalogId);
    if (!Number.isSafeInteger(exactCatalogId) || exactCatalogId <= 0) {
      throw AppError.badRequest('catalog_id must be a positive integer');
    }
    params.push(exactCatalogId);
    where.push(`catalog_id = $${params.length}::int`);
  }
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
    `SELECT id, catalog_id, composition_id,
            sku_code, display_name, generic_name, brand_name, manufacturer,
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
  return setTenantTx(params.tenantId, async (tx) => {
    // Controlled stock can never move without its statutory register row. This
    // public single-movement path spreads req.body straight through, so the
    // schedule/narcotic status is resolved from the item row here rather than
    // trusted from the caller. A controlled decrement off this generic endpoint
    // was the last remaining register-bypass door (2026-08-25 reaudit BC-H1);
    // receipts and other custody events additionally need a register row so the
    // register can reconcile chain-of-custody on its own (BC-M1). Trusted in-tx
    // composers (dispenseControlledTx, counterSale finalize/void) call
    // recordMovementTx directly and write the register themselves, so this
    // controlled branch rides only recordMovement().
    const item = await loadMovementItem(tx, params.tenantId, params.inventory_item_id);
    if (item && isControlledItem(item)) {
      return recordControlledMovementTx(tx, params, item);
    }
    return recordMovementTx(tx, { ...params, controlled_batch_policy: null });
  });
}

/**
 * Controlled-stock movement through the generic movements endpoint: performs
 * the stock movement AND appends a same-tx pharmacy_schedule_register row for
 * every custody event. Enforces the dispense/witness discipline the statutory
 * register demands — a controlled 'issue' is refused (it is a patient dispense
 * and must use /controlled-dispense), every decrement is tied to an exact
 * server-validated batch, and Schedule X / narcotic decrements consume an
 * independently authenticated witness approval. Never called for
 * non-controlled items.
 */
async function recordControlledMovementTx(tx, params, item) {
  const { tenantId, movement_kind, quantity, performed_by } = params;
  if (!VALID_MOVEMENTS.includes(movement_kind)) {
    throw AppError.badRequest(`Invalid movement_kind. Allowed: ${VALID_MOVEMENTS.join(', ')}`);
  }

  // A controlled issue is a patient dispense: it needs the witness ceremony and
  // the patient/prescriber identity the register demands, none of which this
  // endpoint carries. Steer it to the sanctioned path rather than silently
  // decrementing narcotic stock off the shelf.
  if (movement_kind === 'issue') {
    throw AppError.conflict(
      'Controlled substances cannot be issued through the generic movements endpoint; use POST /api/v1/pharmacy/inventory/v2/controlled-dispense',
      'CONTROLLED_MOVEMENT_REQUIRES_DISPENSE_PATH',
    );
  }

  const registerKind = REGISTER_KIND_BY_MOVEMENT[movement_kind];
  if (!registerKind) {
    throw AppError.conflict(
      `Movement kind '${movement_kind}' is not permitted on controlled stock through this endpoint`,
      'CONTROLLED_MOVEMENT_KIND_UNSUPPORTED',
    );
  }

  if (!performed_by) {
    throw AppError.badRequest(
      'performed_by is required for controlled stock movements',
      'CONTROLLED_MOVEMENT_PERFORMER_REQUIRED',
    );
  }

  const decreasing = CONTROLLED_DECREASING_MOVEMENTS.has(movement_kind);
  let patient = null;
  if (params.patient_uid != null && params.patient_uid !== '') {
    if (!UUID_RE.test(String(params.patient_uid))) {
      throw AppError.badRequest(
        'patient_uid must be a UUID',
        'CONTROLLED_MOVEMENT_PATIENT_UID_INVALID',
      );
    }
    const patients = await tx.$queryRawUnsafe(
      `SELECT uid, name, phone
         FROM users
        WHERE tenant_id = $1::uuid
          AND uid = $2::uuid
          AND role = 'PATIENT'
        LIMIT 1`,
      tenantId,
      String(params.patient_uid),
    );
    patient = patients[0] ?? null;
    if (!patient) {
      throw AppError.notFound(
        'Controlled-movement patient was not found in this tenant',
        'CONTROLLED_MOVEMENT_PATIENT_NOT_FOUND',
      );
    }
  }
  const controlledBatchId = decreasing
    ? requireControlledMovementBatchId(params.inventory_batch_id)
    : null;
  const movementPayload = decreasing
    ? controlledMovementWitnessPayload({
      ...params,
      inventory_batch_id: controlledBatchId,
    })
    : null;
  // Schedule X / narcotic decrements (disposal, recall, downward adjustment,
  // expiry write-off, transfer out) consume the same independently
  // authenticated, one-time approval lifecycle as a controlled dispense.
  const needsWitness = decreasing && (item.schedule_class === 'X' || item.is_narcotic === true);
  let witness = null;
  if (needsWitness) {
    witness = await consumeControlledDispenseWitnessApproval({
      tx,
      tenantId,
      approvalId: params.witness_approval_id,
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventoryMovement,
      payload: movementPayload,
      requestedBy: performed_by,
    });
  }

  const { movement, increasing, decreasing: didDecrease } = await recordMovementTx(tx, {
    ...params,
    inventory_batch_id: controlledBatchId || params.inventory_batch_id,
    reference_type: movementPayload ? movementPayload.reference_type : params.reference_type,
    reference_id: movementPayload ? movementPayload.reference_id : params.reference_id,
    notes: movementPayload ? movementPayload.notes : params.notes,
    expected_batch_number: movementPayload
      ? movementPayload.expected_batch_number
      : params.expected_batch_number,
    expected_lot_number: movementPayload
      ? movementPayload.expected_lot_number
      : params.expected_lot_number,
    expected_expiry_date: movementPayload
      ? movementPayload.expected_expiry_date
      : params.expected_expiry_date,
    require_usable_batch: false,
    controlled_batch_policy: decreasing
      ? CONTROLLED_BATCH_POLICY_BY_MOVEMENT[movement_kind]
      : null,
  });

  // Running balance read inside the same tx so it reflects the movement above
  // (no stale-balance race), mirroring dispenseControlledTx.
  const balance = await tx.$queryRawUnsafe(
    `SELECT COALESCE(SUM(remaining_quantity), 0)::numeric AS bal
       FROM pharmacy_inventory_batches
      WHERE inventory_item_id = $1::int AND tenant_id = $2::uuid AND status = 'in_stock'`,
    Number(params.inventory_item_id),
    tenantId,
  );

  const reg = await tx.$queryRawUnsafe(
    `INSERT INTO pharmacy_schedule_register
       (tenant_id, inventory_item_id, inventory_batch_id, schedule_class,
        movement_kind, quantity, unit_label, running_balance,
        patient_uid, patient_name, patient_phone,
        performed_by, performed_by_name, witness_uid, witness_name,
        reference_movement_id, notes)
     VALUES ($1::uuid, $2::int, $3, $4, $5, $6::numeric, $7, $8::numeric,
             $9::uuid, $10, $11,
             $12::uuid, $13, $14::uuid, $15, $16::int, $17)
     RETURNING *`,
    tenantId,
    Number(params.inventory_item_id),
    controlledBatchId || (params.inventory_batch_id ? Number(params.inventory_batch_id) : null),
    item.schedule_class || (item.is_narcotic ? 'X' : 'H1'),
    registerKind,
    Math.abs(Number(quantity)),
    item.unit_label,
    Number(balance[0].bal),
    patient?.uid || null,
    patient?.name || null,
    patient?.phone || null,
    String(performed_by),
    params.performed_by_name || null,
    witness?.uid || null,
    witness?.name || null,
    movement.id,
    movementPayload?.notes || params.notes || null,
  );

  return { movement, increasing, decreasing: didDecrease, register_entry: reg[0] };
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
  controlled_batch_policy = null,
  expected_batch_number = null,
  expected_lot_number = null,
  expected_expiry_date = null,
}) {
  if (!VALID_MOVEMENTS.includes(movement_kind)) {
    throw AppError.badRequest(`Invalid movement_kind. Allowed: ${VALID_MOVEMENTS.join(', ')}`);
  }
  if (!inventory_item_id) throw AppError.badRequest('inventory_item_id is required');
  if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
    throw AppError.badRequest('quantity must be > 0');
  }

  const decreasing = ['issue', 'transfer_out', 'dispose', 'expire', 'recall', 'adjust_decrease'].includes(movement_kind);
  const increasing = ['receive', 'transfer_in', 'return', 'adjust_increase'].includes(movement_kind);
  const delta = decreasing ? -Math.abs(Number(quantity)) : Math.abs(Number(quantity));
  const inventoryItemId = Number(inventory_item_id);
  const inventoryBatchId = inventory_batch_id ? Number(inventory_batch_id) : null;
  if (controlled_batch_policy && !inventoryBatchId) {
    throw AppError.badRequest(
      'inventory_batch_id is required for controlled stock decrements',
      'INVENTORY_BATCH_REQUIRED',
    );
  }
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
      if (controlled_batch_policy && decreasing) {
        assertControlledMovementBatchState(batch, controlled_batch_policy);
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

const CONTROLLED_BATCH_SAFETY_CONTRACT =
  'usable_in_stock_nonexpired_sufficient_stock_v1';

function requireControlledBatchId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw AppError.badRequest(
      'inventory_batch_id is required for controlled dispensing',
      'INVENTORY_BATCH_REQUIRED',
    );
  }
  return id;
}

function requireControlledMovementBatchId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw AppError.badRequest(
      'inventory_batch_id is required for controlled stock decrements',
      'INVENTORY_BATCH_REQUIRED',
    );
  }
  return id;
}

function assertControlledMovementBatchState(batch, policy) {
  const status = String(batch.status || '');
  if (policy === 'usable') {
    if (status !== 'in_stock') {
      throw AppError.badRequest(
        `Inventory batch is not available for movement (status: ${status})`,
        'INVENTORY_BATCH_UNAVAILABLE',
      );
    }
    if (batch.is_expired) {
      throw AppError.badRequest(
        'Inventory batch is expired and cannot be transferred or adjusted as usable stock',
        'INVENTORY_BATCH_EXPIRED',
      );
    }
    return;
  }
  if (policy === 'expired') {
    if (!['in_stock', 'expired'].includes(status)) {
      throw AppError.badRequest(
        `Inventory batch is not available for expiry write-off (status: ${status})`,
        'INVENTORY_BATCH_UNAVAILABLE',
      );
    }
    if (!batch.is_expired) {
      throw AppError.badRequest(
        'Inventory batch has not expired and cannot be written off as expired',
        'INVENTORY_BATCH_NOT_EXPIRED',
      );
    }
    return;
  }
  if (policy === 'recallable') {
    if (!['in_stock', 'recalled'].includes(status)) {
      throw AppError.badRequest(
        `Inventory batch is not available for recall (status: ${status})`,
        'INVENTORY_BATCH_UNAVAILABLE',
      );
    }
    return;
  }
  if (policy === 'disposable') {
    if (!['in_stock', 'expired', 'recalled', 'quarantined'].includes(status)) {
      throw AppError.badRequest(
        `Inventory batch is not available for disposal (status: ${status})`,
        'INVENTORY_BATCH_UNAVAILABLE',
      );
    }
    return;
  }
  throw AppError.internal(
    'Unsupported controlled movement batch policy',
    'CONTROLLED_MOVEMENT_BATCH_POLICY_INVALID',
  );
}

function controlledMovementQuantity(value) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw AppError.badRequest('quantity must be > 0');
  }
  return quantity;
}

function controlledMovementItemId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw AppError.badRequest('inventory_item_id is required');
  }
  return id;
}

function exactTextOrNull(value) {
  return value == null || value === '' ? null : String(value);
}

function normalizedDateOrNull(value) {
  if (!value) return null;
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

export function controlledMovementWitnessPayload(params = {}) {
  const movementKind = String(params.movement_kind || '');
  if (!CONTROLLED_DECREASING_MOVEMENTS.has(movementKind)) {
    throw AppError.badRequest(
      'A witness approval is only available for controlled stock decrements',
      'CONTROLLED_MOVEMENT_WITNESS_NOT_REQUIRED',
    );
  }
  return {
    inventory_item_id: controlledMovementItemId(params.inventory_item_id),
    inventory_batch_id: requireControlledMovementBatchId(params.inventory_batch_id),
    movement_kind: movementKind,
    quantity: controlledMovementQuantity(params.quantity),
    batch_safety_contract: CONTROLLED_MOVEMENT_BATCH_CONTRACT,
    batch_policy: CONTROLLED_BATCH_POLICY_BY_MOVEMENT[movementKind],
    reference_type: exactTextOrNull(params.reference_type),
    reference_id: exactTextOrNull(params.reference_id),
    notes: exactTextOrNull(params.notes),
    expected_batch_number: exactTextOrNull(params.expected_batch_number)?.trim() || null,
    expected_lot_number: exactTextOrNull(params.expected_lot_number)?.trim() || null,
    expected_expiry_date: normalizedDateOrNull(params.expected_expiry_date),
  };
}

async function requireControlledMovementBatch(db, params) {
  const payload = controlledMovementWitnessPayload(params);
  const rows = await db.$queryRawUnsafe(
    `SELECT id, status, remaining_quantity,
            (expiry_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS is_expired
       FROM pharmacy_inventory_batches
      WHERE tenant_id = $1::uuid
        AND inventory_item_id = $2::int
        AND id = $3::int`,
    params.tenantId,
    payload.inventory_item_id,
    payload.inventory_batch_id,
  );
  if (!rows[0]) throw AppError.notFound('Batch not found');
  assertControlledMovementBatchState(rows[0], payload.batch_policy);
  if (Number(rows[0].remaining_quantity) < payload.quantity) {
    throw AppError.badRequest(
      `Insufficient stock. Available: ${rows[0].remaining_quantity}`,
      'INVENTORY_INSUFFICIENT_STOCK',
    );
  }
  return rows[0];
}

async function requireUsableControlledBatch(db, {
  tenantId, inventoryItemId, inventoryBatchId, quantity,
}) {
  const batchId = requireControlledBatchId(inventoryBatchId);
  const requestedQuantity = Number(quantity);
  if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
    throw AppError.badRequest('quantity must be > 0');
  }
  const rows = await db.$queryRawUnsafe(
    `SELECT id, status, remaining_quantity,
            (expiry_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS is_expired
       FROM pharmacy_inventory_batches
      WHERE tenant_id = $1::uuid
        AND inventory_item_id = $2::int
        AND id = $3::int`,
    tenantId,
    Number(inventoryItemId),
    batchId,
  );
  if (!rows[0]) throw AppError.notFound('Batch not found');
  if (rows[0].status !== 'in_stock') {
    throw AppError.badRequest(
      `Inventory batch is not available for issue (status: ${rows[0].status})`,
      'INVENTORY_BATCH_UNAVAILABLE',
    );
  }
  if (rows[0].is_expired) {
    throw AppError.badRequest(
      'Inventory batch is expired and cannot be issued',
      'INVENTORY_BATCH_EXPIRED',
    );
  }
  if (Number(rows[0].remaining_quantity) < requestedQuantity) {
    throw AppError.badRequest(
      `Insufficient stock. Available: ${rows[0].remaining_quantity}`,
      'INVENTORY_INSUFFICIENT_STOCK',
    );
  }
  return rows[0];
}

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
 * evidence row. Controlled dispensing always requires and revalidates one
 * concrete usable batch under the stock lock.
 */
export function controlledDispenseWitnessPayload(params = {}) {
  return {
    inventory_item_id: Number(params.inventory_item_id),
    inventory_batch_id: requireControlledBatchId(params.inventory_batch_id),
    batch_safety_contract: CONTROLLED_BATCH_SAFETY_CONTRACT,
    quantity: Number(params.quantity),
    patient_uid: params.patient_uid ? String(params.patient_uid) : null,
    patient_name: params.patient_name ? String(params.patient_name).trim() : null,
    patient_phone: params.patient_phone ? String(params.patient_phone).trim() : null,
    prescription_id: params.prescription_id == null ? null : Number(params.prescription_id),
    prescription_number: params.prescription_number || null,
    prescriber_uid: params.prescriber_uid ? String(params.prescriber_uid) : null,
    prescriber_name: params.prescriber_name || null,
    prescriber_registration: params.prescriber_registration || null,
    patient_id_proof_type: params.patient_id_proof_type || null,
    patient_id_proof_last4: params.patient_id_proof_last4
      ? String(params.patient_id_proof_last4).slice(-4)
      : null,
  };
}

async function requireWitnessedInventoryItem(db, { tenantId, inventoryItemId }) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, schedule_class, is_narcotic
       FROM pharmacy_inventory_items
      WHERE tenant_id = $1::uuid
        AND id = $2::int`,
    tenantId,
    Number(inventoryItemId),
  );
  if (!rows[0]) throw AppError.notFound('Inventory item not found');
  if (rows[0].schedule_class !== 'X' && rows[0].is_narcotic !== true) {
    throw AppError.badRequest(
      'A witness approval is only available for Schedule X / narcotic dispensing',
      'CONTROLLED_DISPENSE_WITNESS_NOT_REQUIRED',
    );
  }
}

export async function requestControlledDispenseWitnessApproval(params) {
  await requireWitnessedInventoryItem(prisma, {
    tenantId: params.tenantId,
    inventoryItemId: params.inventory_item_id,
  });
  await requireUsableControlledBatch(prisma, {
    tenantId: params.tenantId,
    inventoryItemId: params.inventory_item_id,
    inventoryBatchId: params.inventory_batch_id,
    quantity: params.quantity,
  });
  return createControlledDispenseWitnessApproval({
    tenantId: params.tenantId,
    scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
    payload: controlledDispenseWitnessPayload(params),
    requestedBy: params.requested_by,
  });
}

export async function approveInventoryDispenseWitnessApproval(params) {
  return approveControlledDispenseWitnessApproval({
    tenantId: params.tenantId,
    approvalId: params.approvalId,
    actorUid: params.actorUid,
    payload: controlledDispenseWitnessPayload(params.dispense),
    requesterUid: params.requesterUid,
  });
}

export async function requestControlledMovementWitnessApproval(params) {
  controlledMovementWitnessPayload(params);
  const item = await loadMovementItem(
    prisma,
    params.tenantId,
    params.inventory_item_id,
  );
  if (!item) throw AppError.notFound('Inventory item not found');
  if (item.schedule_class !== 'X' && item.is_narcotic !== true) {
    throw AppError.badRequest(
      'A witness approval is only available for Schedule X / narcotic stock decrements',
      'CONTROLLED_MOVEMENT_WITNESS_NOT_REQUIRED',
    );
  }
  await requireControlledMovementBatch(prisma, params);
  return createControlledDispenseWitnessApproval({
    tenantId: params.tenantId,
    scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventoryMovement,
    payload: controlledMovementWitnessPayload(params),
    requestedBy: params.requested_by,
  });
}

export async function approveInventoryMovementWitnessApproval(params) {
  return approveControlledDispenseWitnessApproval({
    tenantId: params.tenantId,
    approvalId: params.approvalId,
    actorUid: params.actorUid,
    payload: controlledMovementWitnessPayload(params.movement),
    requesterUid: params.requesterUid,
  });
}

export async function dispenseControlledTx(tx, {
  tenantId,
  inventory_item_id, inventory_batch_id,
  quantity, patient_uid, patient_name, patient_phone,
  prescription_id, prescription_number,
  prescriber_uid, prescriber_name, prescriber_registration,
  patient_id_proof_type, patient_id_proof_last4,
  performed_by, performed_by_name,
  witness_approval_id, witness_evidence = null, notes,
  reference_id = null,
}) {
  const controlledBatchId = requireControlledBatchId(inventory_batch_id);
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
  if (!performed_by || !performed_by_name) {
    throw AppError.badRequest('performed_by + performed_by_name are required');
  }

  const needsWitness = item.schedule_class === 'X' || item.is_narcotic;
  let witness = isControlledDispenseWitnessEvidence(witness_evidence)
    ? witness_evidence
    : null;
  if (needsWitness && !witness) {
    witness = await consumeControlledDispenseWitnessApproval({
      tx,
      tenantId,
      approvalId: witness_approval_id,
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
      payload: controlledDispenseWitnessPayload({
        inventory_item_id,
        inventory_batch_id,
        quantity,
        patient_uid,
        patient_name,
        patient_phone,
        prescription_id,
        prescription_number,
        prescriber_uid,
        prescriber_name,
        prescriber_registration,
        patient_id_proof_type,
        patient_id_proof_last4,
      }),
      requestedBy: performed_by,
    });
  }

  {
    // Record the underlying stock movement (decrements batch) inside the tx.
    const { movement } = await recordMovementTx(tx, {
      tenantId,
      inventory_item_id,
      inventory_batch_id: controlledBatchId,
      movement_kind: 'issue',
      quantity,
      reference_type: 'controlled_dispense',
      reference_id: reference_id || prescription_number || `pres-${prescription_id || ''}`,
      performed_by,
      notes: `Schedule ${item.schedule_class} dispense; witness ${witness?.name || 'n/a'}`,
      require_usable_batch: true,
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
      controlledBatchId,
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
      witness?.uid || null,
      witness?.name || null,
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
