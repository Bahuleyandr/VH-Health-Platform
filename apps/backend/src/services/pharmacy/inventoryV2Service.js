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
//   - governed transaction-scoped stock composers for typed workflows
//   - typed batch disposal with controlled-stock witness/register evidence
//   - daily expiry scan that caches into pharmacy_expiry_scan_cache
//   - regulatory Schedule H / H1 / X register query
//
// All raw queries use $queryRawUnsafe with spread params (Phase 0.5
// convention). All money is stored in *_minor (paise) so quantities
// and money never lose precision.

import { createHash } from 'node:crypto';
import { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { boundedInteger } from '../../utils/pagination.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { isDoctor } from '../../utils/roleHelpers.js';
import {
  CONTROLLED_DISPENSE_APPROVAL_SCOPES,
  CONTROLLED_DISPENSE_WITNESS_ROLES,
  FACILITY_BOUND_CONTROLLED_DISPENSE_WITNESS_ROLES,
  approveControlledDispenseWitnessApproval,
  consumeControlledDispenseWitnessApproval,
  createControlledDispenseWitnessApproval,
  isControlledDispenseWitnessEvidence,
  preflightControlledDispenseWitnessApproval,
} from './controlledDispenseWitnessService.js';
import { assertPharmacyFacilityGrant } from './pharmacyFacilityAuthorityService.js';
import {
  assertNoLivePharmacyOrderFundingAuthorityTx,
  compensateTerminalPharmacyFundingAuthorityTx,
} from '../billing/billingV2Service.js';

export {
  CONTROLLED_DISPENSE_WITNESS_ROLES,
  FACILITY_BOUND_CONTROLLED_DISPENSE_WITNESS_ROLES,
};
export const CONTROLLED_SUBSTITUTION_AUTHORITY = Symbol('controlled-substitution-authority');
export const WARD_INVENTORY_RETURN_AUTHORITY = Symbol('ward-inventory-return-authority');
export const WARD_CONTROLLED_HANDOFF_AUTHORITY = Symbol('ward-controlled-handoff-authority');

const ALLOWED_SCHEDULES = ['H', 'H1', 'X', 'OTC', null];
const VALID_MOVEMENTS = [
  'receive', 'issue', 'transfer_out', 'transfer_in', 'return',
  'adjust_increase', 'adjust_decrease', 'dispose', 'expire',
];
const CONTROLLED_DECREASING_MOVEMENTS = new Set([
  'transfer_out', 'adjust_decrease', 'dispose', 'expire',
]);
const CONTROLLED_MOVEMENT_AUTHORITY = Symbol('CONTROLLED_MOVEMENT_AUTHORITY');
const CONTROLLED_BATCH_POLICY_BY_MOVEMENT = Object.freeze({
  transfer_out: 'usable',
  adjust_decrease: 'usable',
  dispose: 'disposable',
  expire: 'expired',
});
const CONTROLLED_MOVEMENT_BATCH_CONTRACT =
  'controlled_movement_exact_batch_policy_v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PG_INT4_MAX = 2147483647;
const INVENTORY_DISPOSAL_MAX_SCALED_QUANTITY = 99_999_999_999_999n;
const INVENTORY_DISPOSAL_CONTRACT = 'pharmacy_inventory_disposal_v1';
const INVENTORY_DISPOSAL_REFERENCE = 'inventory_batch_disposal';
const INVENTORY_DISPOSAL_STATES = new Set([
  'in_stock', 'expired', 'recalled', 'quarantined',
]);
const INVENTORY_DISPOSAL_PERFORMER_ROLES = new Set([
  'PHARMACY_STAFF', 'PHARMACY_INCHARGE',
]);
const INVENTORY_DISPOSAL_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_\-:.]{1,200}$/;
const INVENTORY_DISPOSAL_FORBIDDEN_FIELDS = Object.freeze([
  'movement_kind',
  'reference_type',
  'reference_id',
  'performed_by_name',
  'performer_role',
  'facility_grant_id',
  'witness_uid',
  'witness_name',
  'witness_role',
  'witness_facility_grant_id',
  'schedule_class',
  'is_narcotic',
  'catalog_id',
  'supplier_id',
  'storage_location_id',
  'authoritative_catalog_id',
  'authoritative_batch_id',
  'authoritative_supplier_id',
  'authoritative_storage_location_id',
  'batch_number',
  'lot_number',
  'expiry_date',
  'batch_status',
  'item_status',
  'remaining_quantity',
  'unit_label',
  'source_batch_status',
  'resulting_batch_status',
  'remaining_quantity_before',
  'remaining_quantity_after',
  'controlled_item',
  'register_required',
  'witness_required',
  'controlled_authority',
  'facility_authority',
  'batch_policy',
  'batch_safety_contract',
  'contract',
  'metadata',
  'receipt',
]);
const INVENTORY_DISPOSAL_RECEIPT_INTENT_FIELDS = Object.freeze([
  'authority_reference',
  'disposition_method',
  'expected_batch_number',
  'expected_expiry_date',
  'expected_lot_number',
  'facility_id',
  'inventory_batch_id',
  'inventory_item_id',
  'notes',
  'quantity',
  'reason_code',
  'witness_approval_id',
]);

// Schedule H / H1 / X are the register-tracked controlled classes (migration
// 150); Schedule X and any narcotic-flagged item additionally demand a witness
// on every decrement. Kept in lockstep with counterSaleService's SCHEDULED_CLASSES.
const CONTROLLED_SCHEDULES = ['H', 'H1', 'X'];
const CONTROLLED_CUSTODY_BATCH_STATUSES = Object.freeze([
  'in_stock', 'reserved', 'expired', 'recalled', 'quarantined',
]);
const CONTROLLED_DISPENSE_ROLES = new Set([
  'PHARMACY_STAFF', 'PHARMACY_INCHARGE',
]);

function isControlledItem(item) {
  return CONTROLLED_SCHEDULES.includes(item?.schedule_class) || item?.is_narcotic === true;
}

function canonicalControlledSchedule(item) {
  if (item?.is_narcotic === true) return 'X';
  const scheduleClass = String(item?.schedule_class || '').trim().toUpperCase();
  if (!CONTROLLED_SCHEDULES.includes(scheduleClass)) {
    throw AppError.conflict(
      'Controlled inventory has no canonical statutory schedule class',
      'CONTROLLED_INVENTORY_SCHEDULE_INVALID',
    );
  }
  return scheduleClass;
}

async function controlledCustodyBalanceTx(tx, {
  tenantId,
  facilityId,
  inventoryItemId,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT COALESCE(SUM(remaining_quantity), 0)::text AS balance
       FROM pharmacy_inventory_batches
      WHERE tenant_id=$1::uuid
        AND facility_id=$2::int
        AND inventory_item_id=$3::int
        AND status = ANY($4::text[])`,
    tenantId,
    Number(facilityId),
    Number(inventoryItemId),
    [...CONTROLLED_CUSTODY_BATCH_STATUSES],
  );
  return rows[0]?.balance || '0';
}

function refuseGenericRecallMovement(movementKind) {
  if (movementKind !== 'recall') return;
  throw AppError.conflict(
    'Batch recall is a status-only quarantine action; use PATCH /api/v1/admin/pharmacy-supply/batches/:id/recall, then record witnessed disposal separately',
    'INVENTORY_RECALL_REQUIRES_BATCH_RECALL_PATH',
  );
}

export async function lockControlledRegisterItemTx(tx, tenantId, inventoryItemId) {
  await tx.$queryRawUnsafe(
    `SELECT pg_advisory_xact_lock(
              hashtextextended($1::text, 0)
            )::text AS lock_acquired`,
    `pharmacy-controlled-register:${tenantId}:${Number(inventoryItemId)}`,
  );
}

async function resolveControlledPerformerTx(db, tenantId, actorUid, { lock = true } = {}) {
  if (!actorUid || !UUID_RE.test(String(actorUid))) {
    throw AppError.forbidden(
      'Controlled inventory requires an authenticated active pharmacy staff performer',
      'CONTROLLED_DISPENSE_PERFORMER_IDENTITY_REQUIRED',
    );
  }
  const rows = await db.$queryRawUnsafe(
    `SELECT u.uid, UPPER(u.role) AS role, NULLIF(BTRIM(staff.name), '') AS name
       FROM users u
       JOIN staff
         ON staff.tenant_id=u.tenant_id
        AND staff.user_id=u.uid
        AND staff.is_active=TRUE
        AND COALESCE(staff.archived, FALSE)=FALSE
        AND staff.archived_at IS NULL
      WHERE u.tenant_id=$1::uuid
        AND u.uid=$2::uuid
        AND u.is_active=TRUE
        AND u.status='active'
        AND COALESCE(u.is_deleted, FALSE)=FALSE
      LIMIT 1
      ${lock ? 'FOR KEY SHARE OF u, staff' : ''}`,
    tenantId,
    String(actorUid),
  );
  const performer = rows[0];
  if (!performer?.name || !CONTROLLED_DISPENSE_ROLES.has(String(performer.role))) {
    throw AppError.forbidden(
      'Controlled inventory requires an authenticated active pharmacy staff performer',
      'CONTROLLED_DISPENSE_PERFORMER_IDENTITY_REQUIRED',
      { allowed_roles: [...CONTROLLED_DISPENSE_ROLES] },
    );
  }
  return performer;
}

function tenantOf(req) {
  return requireTenantId(req?.tenantId || req?.user?.tenantId || req?.tenant?.id);
}

// The catalog label is VARCHAR while the legacy inventory duplicate is INT4;
// copy it only when the representation is lossless and keep catalog_id authoritative.
function inventoryPackSizeFromCatalog(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!/^[1-9][0-9]*$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed <= PG_INT4_MAX ? parsed : null;
}

// ── Drug master / items ───────────────────────────────────────────────

export async function listItems({
  tenantId,
  actorUid,
  actorRole,
  search,
  schedule,
  status = 'active',
  catalogId,
  facilityId,
  limit = 100,
}) {
  const tid = requireTenantId(tenantId);
  const exactFacilityId = Number(facilityId);
  if (!Number.isSafeInteger(exactFacilityId) || exactFacilityId <= 0) {
    throw AppError.badRequest(
      'facility_id must be a positive integer',
      'PHARMACY_FACILITY_REQUIRED',
    );
  }
  const params = [tid, exactFacilityId];
  const where = [`tenant_id = $1::uuid`];
  where.push('facility_id = $2::int');
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
  return setTenantTx(tid, async (tx) => {
    await assertPharmacyFacilityGrant(tx, {
      tenantId: tid,
      facilityId: exactFacilityId,
      actorUid,
      actorRole,
    });
    return tx.$queryRawUnsafe(
      `SELECT id, facility_id, catalog_id, composition_id,
              sku_code, display_name, generic_name, brand_name, manufacturer,
              form, strength, unit_label, schedule_class, is_narcotic,
              is_cold_chain, reorder_level, reorder_quantity, status
         FROM pharmacy_inventory_items
        WHERE ${where.join(' AND ')}
        ORDER BY display_name
        LIMIT $${params.length}::int`,
      ...params,
    );
  });
}

export async function createItem({ tenantId, item, actorUid, actorRole }) {
  if (!item?.sku_code) {
    throw AppError.badRequest('sku_code is required');
  }
  if (item.schedule_class && !ALLOWED_SCHEDULES.includes(item.schedule_class)) {
    throw AppError.badRequest(`Invalid schedule_class. Allowed: ${ALLOWED_SCHEDULES.filter(Boolean).join(', ')}`);
  }
  // Schedule X is always narcotic; auto-flag.
  const isNarcotic = item.schedule_class === 'X' || Boolean(item.is_narcotic);
  const facilityId = Number(item.facility_id);
  const catalogId = Number(item.catalog_id);
  if (!Number.isSafeInteger(facilityId) || facilityId <= 0) {
    throw AppError.badRequest('facility_id must be a positive integer');
  }
  if (!Number.isSafeInteger(catalogId) || catalogId <= 0) {
    throw AppError.badRequest('catalog_id must be a positive integer');
  }
  return setTenantTx(tenantId, async (tx) => {
    await assertPharmacyFacilityGrant(tx, {
      tenantId,
      facilityId,
      actorUid,
      actorRole,
      forUpdate: true,
    });
    const authority = await tx.$queryRawUnsafe(
      `SELECT f.id AS facility_id, pc.id AS catalog_id,
              pc.composition_id, pc.composition_confidence,
              pc.name AS display_name,
              pc.generic_name,
              pc.manufacturer,
              pc.form,
              pc.strength,
              pc.pack_size AS catalog_pack_size
         FROM facilities f
         JOIN pharmacy_catalog pc
           ON pc.tenant_id=f.tenant_id
          AND pc.id=$3::int
          AND pc.is_active=TRUE
        WHERE f.tenant_id=$1::uuid
          AND f.id=$2::int
          AND f.status='active'
        FOR UPDATE OF f, pc`,
      tenantId,
      facilityId,
      catalogId,
    );
    if (!authority[0]) {
      throw AppError.badRequest(
        'facility_id and catalog_id must identify active records in this tenant',
        'PHARMACY_INVENTORY_AUTHORITY_INVALID',
      );
    }
    const catalog = authority[0];
    const compositionId = Number(catalog.composition_id);
    if (!Number.isSafeInteger(compositionId)
      || compositionId <= 0
      || catalog.composition_confidence !== 'high') {
      throw AppError.conflict(
        'The selected catalog item has no high-confidence authoritative composition identity',
        'PHARMACY_CATALOG_COMPOSITION_REQUIRED',
        {
          catalog_id: catalogId,
          composition_confidence: catalog.composition_confidence ?? null,
          next_action: 'REVIEW_CATALOG_COMPOSITION',
        },
      );
    }
    const catalogPackSizeLabel = catalog.catalog_pack_size == null
      ? null
      : String(catalog.catalog_pack_size).trim() || null;
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
       (tenant_id, facility_id, catalog_id, composition_id,
        sku_code, display_name, generic_name, brand_name,
        manufacturer, form, strength, unit_label, pack_size,
        schedule_class, is_narcotic, is_cold_chain, reorder_level,
        reorder_quantity)
     VALUES ($1::uuid, $2::int, $3::int, $4::int, $5, $6, $7, $8, $9,
             $10, $11, $12, $13::int, $14, $15, $16, $17, $18)
     RETURNING *`,
    tenantId,
    facilityId,
    catalogId,
    compositionId,
    item.sku_code,
    catalog.display_name,
    catalog.generic_name ?? null,
    catalog.display_name,
    catalog.manufacturer ?? null,
    catalog.form ?? null,
    catalog.strength ?? null,
    item.unit_label || 'each',
    inventoryPackSizeFromCatalog(catalogPackSizeLabel),
    item.schedule_class || null,
    isNarcotic,
    Boolean(item.is_cold_chain),
    item.reorder_level ?? null,
    item.reorder_quantity ?? null,
    );
    return {
      ...rows[0],
      pack_size_label: catalogPackSizeLabel,
    };
  });
}

// ── Batches ───────────────────────────────────────────────────────────

export async function listBatches({
  tenantId, actorUid, actorRole, item_id, facility_id,
  expiring_in_days, status = 'in_stock', limit = 200,
}) {
  const tid = requireTenantId(tenantId);
  const facilityId = Number(facility_id);
  if (!Number.isSafeInteger(facilityId) || facilityId <= 0) {
    throw AppError.badRequest(
      'facility_id must be a positive integer',
      'PHARMACY_FACILITY_REQUIRED',
    );
  }
  const params = [tid, facilityId];
  const where = [`b.tenant_id = $1::uuid`];
  where.push('b.facility_id = $2::int');
  if (item_id) { params.push(Number(item_id)); where.push(`b.inventory_item_id = $${params.length}::int`); }
  if (status) { params.push(status); where.push(`b.status = $${params.length}`); }
  if (status === 'in_stock') {
    where.push(`b.expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date`);
  }
  if (expiring_in_days) {
    params.push(Number(expiring_in_days));
    where.push(`b.expiry_date <= CURRENT_DATE + ($${params.length}::int || ' days')::interval`);
  }
  params.push(boundedInteger(limit, { fallback: 200, min: 1, max: 500 }));
  return setTenantTx(tid, async (tx) => {
    await assertPharmacyFacilityGrant(tx, {
      tenantId: tid,
      facilityId,
      actorUid,
      actorRole,
    });
    return tx.$queryRawUnsafe(
      `SELECT b.id, b.inventory_item_id, b.facility_id, b.batch_number, b.lot_number,
              b.manufacture_date, b.expiry_date, b.received_quantity,
              b.remaining_quantity, b.unit_cost_minor, b.mrp_minor,
              b.supplier_id, b.status,
              i.sku_code, i.display_name, i.generic_name, i.unit_label,
              i.schedule_class, i.is_narcotic
         FROM pharmacy_inventory_batches b
         JOIN pharmacy_inventory_items i
           ON i.id = b.inventory_item_id
          AND i.tenant_id = b.tenant_id
          AND i.facility_id = b.facility_id
        WHERE ${where.join(' AND ')}
        ORDER BY b.expiry_date ASC, b.id
        LIMIT $${params.length}::int`,
      ...params,
    );
  });
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

export async function recordMovement() {
  throw new AppError(
    'Generic inventory movements are retired; use a governed receipt, return, dispense, or disposal workflow',
    410,
    'INVENTORY_GENERIC_MOVEMENT_RETIRED',
  );
}

/**
 * Transaction-scoped core of recordMovement. Runs every validation, the
 * FOR UPDATE batch lock, the insufficient-stock guard, the movement INSERT
 * and the batch decrement against a caller-supplied `tx` — it does NOT open
 * its own setTenantTx. Callers that must commit the movement atomically with
 * other writes in the same unit (e.g. dispenseControlled's statutory register
 * INSERT) open one setTenantTx themselves and call this directly. The public
 * recordMovement() wrapper above is deliberately tombstoned; only governed
 * typed composers may invoke this transaction-scoped primitive.
 *
 * Exported for same-transaction composers (counterSaleService's walk-in POS
 * finalize/void) that must commit several movements atomically with their own
 * evidence rows.
 */
export async function recordMovementTx(tx, {
  tenantId, inventory_item_id, inventory_batch_id, movement_kind,
  quantity, reference_type, reference_id, notes, performed_by,
  expected_facility_id = null,
  facility_authority = null,
  metadata = null,
  require_usable_batch = false,
  controlled_batch_policy = null,
  expected_batch_number = null,
  expected_lot_number = null,
  expected_expiry_date = null,
  controlled_authority = null,
}) {
  refuseGenericRecallMovement(movement_kind);
  if (!VALID_MOVEMENTS.includes(movement_kind)) {
    throw AppError.badRequest(`Invalid movement_kind. Allowed: ${VALID_MOVEMENTS.join(', ')}`);
  }
  if (!inventory_item_id) throw AppError.badRequest('inventory_item_id is required');
  if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
    throw AppError.badRequest('quantity must be > 0');
  }

  const decreasing = ['issue', 'transfer_out', 'dispose', 'expire', 'adjust_decrease'].includes(movement_kind);
  const increasing = ['receive', 'transfer_in', 'return', 'adjust_increase'].includes(movement_kind);
  const delta = decreasing ? -Math.abs(Number(quantity)) : Math.abs(Number(quantity));
  const inventoryItemId = Number(inventory_item_id);
  const inventoryBatchId = inventory_batch_id ? Number(inventory_batch_id) : null;
  const expectedFacilityId = expected_facility_id == null
    ? null
    : Number(expected_facility_id);
  if (!Number.isSafeInteger(expectedFacilityId) || expectedFacilityId <= 0) {
    throw AppError.conflict(
      'A server-authoritative facility is required for every inventory movement',
      'INVENTORY_EXPECTED_FACILITY_REQUIRED',
    );
  }
  if (facility_authority !== WARD_INVENTORY_RETURN_AUTHORITY) {
    await assertPharmacyFacilityGrant(tx, {
      tenantId,
      facilityId: expectedFacilityId,
      actorUid: performed_by,
      forUpdate: true,
    });
  } else if (
    movement_kind !== 'return'
    || !['ward_indent_return_allocation', 'ward_indent_return'].includes(reference_type)
  ) {
    throw AppError.forbidden(
      'Ward return authority is valid only for the governed ward allocation return workflow',
      'INVENTORY_FACILITY_AUTHORITY_INVALID',
    );
  }
  if (!inventoryBatchId) {
    throw AppError.badRequest(
      'inventory_batch_id is required so the stock ledger and batch balance stay atomic',
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
        `SELECT batch.id, batch.inventory_item_id, batch.facility_id,
                batch.batch_number, batch.lot_number, batch.expiry_date,
                batch.remaining_quantity, batch.status,
                item.schedule_class, item.is_narcotic,
                (batch.expiry_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS is_expired
           FROM pharmacy_inventory_batches batch
           JOIN pharmacy_inventory_items item
             ON item.tenant_id=batch.tenant_id
            AND item.id=batch.inventory_item_id
            AND item.facility_id=batch.facility_id
            AND item.status='active'
           JOIN facilities facility
             ON facility.tenant_id=item.tenant_id
            AND facility.id=item.facility_id
            AND facility.status='active'
          WHERE batch.id = $1::int
            AND batch.tenant_id = $2::uuid
            AND batch.inventory_item_id = $3::int
            AND ($4::int IS NULL OR batch.facility_id=$4::int)
          FOR UPDATE OF batch, item, facility`,
        inventoryBatchId,
        tenantId,
        inventoryItemId,
        expectedFacilityId,
      );
      if (!batches.length) throw AppError.notFound('Batch not found');
      const batch = batches[0];
      if (decreasing && isControlledItem(batch)
        && controlled_authority !== CONTROLLED_MOVEMENT_AUTHORITY) {
        throw AppError.conflict(
          'Controlled stock may decrease only through the statutory controlled-dispense workflow',
          'CONTROLLED_INVENTORY_WORKFLOW_REQUIRED',
        );
      }
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
         quantity_delta, reference_type, reference_id, performed_by, notes, metadata)
        VALUES ($1::uuid, $2::int, $3, $4, $5::numeric, $6, $7, $8::uuid, $9, $10::jsonb)
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
      JSON.stringify(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
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
                status = CASE
                  WHEN remaining_quantity + $1::numeric <= 0 THEN 'depleted'
                  WHEN $5::text = 'return'
                    AND status = 'depleted'
                    AND expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                    THEN 'in_stock'
                  ELSE status
                END,
                updated_at = NOW()
          WHERE id = $2::int
            AND tenant_id = $3::uuid
            AND inventory_item_id = $4::int
            AND ($6::int IS NULL OR facility_id=$6::int)`,
        delta,
        inventoryBatchId,
        tenantId,
        inventoryItemId,
        movement_kind,
        expectedFacilityId,
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
  refuseGenericRecallMovement(movementKind);
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

async function resolveControlledDispenseAuthority(db, params, {
  forUpdate = false,
  requirePrescription = false,
} = {}) {
  const patientUid = String(params.patient_uid || '').trim();
  if (!UUID_RE.test(patientUid)) {
    throw AppError.badRequest(
      'patient_uid must identify an active tenant patient',
      'CONTROLLED_DISPENSE_PATIENT_REQUIRED',
    );
  }
  const prescriptionId = params.prescription_id == null
    ? null
    : Number(params.prescription_id);
  const prescriptionLineIndex = params.prescription_line_index == null
    ? null
    : Number(params.prescription_line_index);
  if (requirePrescription && (!Number.isSafeInteger(prescriptionId) || prescriptionId <= 0)) {
    throw AppError.badRequest(
      'prescription_id is required for public controlled dispensing',
      'CONTROLLED_DISPENSE_PRESCRIPTION_REQUIRED',
    );
  }
  if (prescriptionId != null
    && (!Number.isSafeInteger(prescriptionLineIndex) || prescriptionLineIndex < 0)) {
    throw AppError.badRequest(
      'prescription_line_index is required for controlled dispensing',
      'CONTROLLED_DISPENSE_PRESCRIPTION_LINE_REQUIRED',
    );
  }
  if (prescriptionId == null) {
    const patients = await db.$queryRawUnsafe(
      `SELECT id, uid, name, phone
         FROM users
        WHERE tenant_id=$1::uuid
          AND uid=$2::uuid
          AND role='PATIENT'
          AND is_active=TRUE
          AND status='active'
          AND is_deleted=FALSE
          AND merged_into_uid IS NULL
        LIMIT 1
        ${forUpdate ? 'FOR UPDATE' : ''}`,
      params.tenantId,
      patientUid,
    );
    if (!patients[0]) {
      throw AppError.notFound(
        'Controlled-dispense patient was not found or is inactive',
        'CONTROLLED_DISPENSE_PATIENT_NOT_FOUND',
      );
    }
    return {
      patient_uid: patients[0].uid,
      patient_name: patients[0].name || null,
      patient_phone: patients[0].phone || null,
    };
  }
  const rows = await db.$queryRawUnsafe(
    `SELECT ep.id AS prescription_id, ep.prescription_number, ep.medications,
            COALESCE(ep.revision, 1) AS prescription_revision,
            patient.uid AS patient_uid, patient.name AS patient_name,
            patient.phone AS patient_phone,
            doctor.uid AS prescriber_uid, doctor.name AS prescriber_name,
            practitioner.registration_number AS prescriber_registration
       FROM e_prescriptions ep
       JOIN users patient
         ON patient.tenant_id=ep.tenant_id
        AND patient.id=ep.patient_id
        AND patient.uid=ep.patient_uid
        AND patient.role='PATIENT'
        AND patient.is_active=TRUE
        AND patient.status='active'
        AND patient.is_deleted=FALSE
        AND patient.merged_into_uid IS NULL
       JOIN users doctor
         ON doctor.tenant_id=ep.tenant_id
        AND doctor.uid=ep.doctor_uid
        AND doctor.role='DOCTOR'
        AND doctor.is_active=TRUE
        AND doctor.status='active'
        AND doctor.is_deleted=FALSE
       LEFT JOIN LATERAL (
         SELECT mapping.registration_number
           FROM abdm_practitioner_mappings mapping
          WHERE mapping.tenant_id=ep.tenant_id
            AND mapping.staff_uid=doctor.uid
            AND mapping.status='verified'
          ORDER BY mapping.updated_at DESC, mapping.id DESC
          LIMIT 1
       ) practitioner ON TRUE
      WHERE ep.tenant_id=$1::uuid
        AND ep.id=$2::int
        AND ep.patient_uid=$3::uuid
        AND COALESCE(LOWER(ep.status), 'active') IN ('active', 'pharmacy_linked')
        AND (
          LOWER(COALESCE(ep.lifecycle_status, 'draft'))='signed'
          OR ep.signed_at IS NOT NULL
          OR ep.locked_at IS NOT NULL
        )
      LIMIT 1
      ${forUpdate ? 'FOR UPDATE OF ep, patient, doctor' : ''}`,
    params.tenantId,
    prescriptionId,
    patientUid,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Controlled dispensing requires an active signed prescription for the exact tenant patient and prescriber',
      'CONTROLLED_DISPENSE_PRESCRIPTION_AUTHORITY_INVALID',
    );
  }
  const medications = Array.isArray(rows[0].medications) ? rows[0].medications : [];
  const prescriptionLine = medications[prescriptionLineIndex];
  const catalogId = Number(prescriptionLine?.catalog_id);
  if (!prescriptionLine || !Number.isSafeInteger(catalogId) || catalogId <= 0) {
    throw AppError.conflict(
      'The exact prescription line has no authoritative catalog identity',
      'CONTROLLED_DISPENSE_PRESCRIPTION_LINE_INVALID',
    );
  }
  const orderedQuantity = Number(
    prescriptionLine.ordered_quantity ?? prescriptionLine.quantity ?? prescriptionLine.qty,
  );
  const dispensedQuantity = Math.max(0, Number(prescriptionLine.dispensed_quantity || 0));
  const remainingQuantity = Number.isFinite(Number(prescriptionLine.remaining_quantity))
    ? Number(prescriptionLine.remaining_quantity)
    : orderedQuantity - dispensedQuantity;
  const requestedQuantity = Number(params.quantity);
  if (!Number.isFinite(orderedQuantity) || orderedQuantity <= 0
    || !Number.isFinite(remainingQuantity) || remainingQuantity < 0) {
    throw AppError.conflict(
      'Prescription fulfilment evidence is inconsistent',
      'CONTROLLED_DISPENSE_PRESCRIPTION_FULFILMENT_CONFLICT',
    );
  }
  if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
    throw AppError.badRequest('quantity must be > 0');
  }
  if (requestedQuantity - remainingQuantity > 0.000001) {
    throw AppError.conflict(
      `Controlled dispense quantity exceeds the prescription remainder (${remainingQuantity})`,
      'CONTROLLED_DISPENSE_QUANTITY_EXCEEDS_REMAINDER',
      { remaining_quantity: remainingQuantity },
    );
  }
  return {
    ...rows[0],
    prescription_line_index: prescriptionLineIndex,
    prescription_catalog_id: catalogId,
    prescription_ordered_quantity: orderedQuantity,
    prescription_dispensed_quantity: dispensedQuantity,
    prescription_remaining_quantity: remainingQuantity,
    prescription_medications: medications,
  };
}

/**
 * Transaction-scoped core of dispenseControlled. Runs the controlled-substance
 * pre-conditions, the stock decrement (recordMovementTx) and the statutory
 * pharmacy_schedule_register INSERT against a caller-supplied `tx`. Callers
 * that must commit a controlled dispense atomically with other writes in the
 * same unit (the walk-in POS finalize, which pairs it with sale evidence and
 * the invoice payment) open one setTenantTx themselves and call this directly
 * — there is deliberately no second controlled-dispense mechanism. The public
 * standalone dispenseControlled() wrapper remains a 410 tombstone.
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
    prescription_line_index: params.prescription_line_index == null
      ? null
      : Number(params.prescription_line_index),
    prescription_catalog_id: params.prescription_catalog_id == null
      ? null
      : Number(params.prescription_catalog_id),
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

export async function requestControlledDispenseWitnessApproval(params) {
  void params;
  throw new AppError(
    'Standalone controlled dispensing is retired; dispense through the verified pharmacy-order or governed counter-sale workflow',
    410,
    'INVENTORY_STANDALONE_CONTROLLED_DISPENSE_RETIRED',
  );
}

export async function approveInventoryDispenseWitnessApproval() {
  throw new AppError(
    'Standalone controlled dispensing is retired; dispense through the verified pharmacy-order or governed counter-sale workflow',
    410,
    'INVENTORY_STANDALONE_CONTROLLED_DISPENSE_RETIRED',
  );
}

export async function requestControlledMovementWitnessApproval(params) {
  void params;
  throw new AppError(
    'Generic movement witness approvals are retired with the generic inventory movement endpoint',
    410,
    'INVENTORY_GENERIC_MOVEMENT_RETIRED',
  );
}

export async function approveInventoryMovementWitnessApproval() {
  throw new AppError(
    'Generic movement witness approvals are retired with the generic inventory movement endpoint',
    410,
    'INVENTORY_GENERIC_MOVEMENT_RETIRED',
  );
}

function assertNoInventoryDisposalCallerAuthority(params = {}) {
  const forbidden = INVENTORY_DISPOSAL_FORBIDDEN_FIELDS.filter((field) => (
    Object.prototype.hasOwnProperty.call(params, field)
    && params[field] !== undefined
    && params[field] !== null
    && params[field] !== ''
  ));
  if (forbidden.length) {
    throw AppError.badRequest(
      'Inventory disposal identity, authority, movement, and lineage are server-derived',
      'INVENTORY_DISPOSAL_CALLER_AUTHORITY_REJECTED',
      { forbidden_fields: forbidden },
    );
  }
}

function inventoryDisposalId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || id > PG_INT4_MAX) {
    throw AppError.badRequest(
      `${label} must be a positive integer`,
      'INVENTORY_DISPOSAL_INPUT_INVALID',
      { field: label },
    );
  }
  return id;
}

function inventoryDisposalBigintId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const id = String(value ?? '').trim();
  if (!/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
    return null;
  }
  return id;
}

function inventoryDisposalUuid(value, label) {
  const uid = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(uid)) {
    throw AppError.badRequest(
      `${label} must be a UUID`,
      'INVENTORY_DISPOSAL_INPUT_INVALID',
      { field: label },
    );
  }
  return uid;
}

function inventoryDisposalScaledDecimal(value, {
  allowNegative = false,
  allowZero = false,
} = {}) {
  if (value == null || ['boolean', 'symbol', 'function'].includes(typeof value)) return null;
  let raw;
  try {
    raw = String(value);
  } catch {
    return null;
  }
  if (raw !== raw.trim()) return null;
  const match = raw.match(
    allowNegative
      ? /^(-?)(0|[1-9][0-9]{0,9})(?:\.([0-9]{1,4}))?$/
      : /^(0|[1-9][0-9]{0,9})(?:\.([0-9]{1,4}))?$/,
  );
  if (!match) return null;
  const negative = allowNegative && match[1] === '-';
  const integerPart = allowNegative ? match[2] : match[1];
  const fractionalPart = (allowNegative ? match[3] : match[2]) || '';
  const absoluteScaled = BigInt(integerPart) * 10_000n
    + BigInt(fractionalPart.padEnd(4, '0') || '0');
  if (absoluteScaled > INVENTORY_DISPOSAL_MAX_SCALED_QUANTITY
      || (!allowZero && absoluteScaled === 0n)) {
    return null;
  }
  return {
    number: Number(raw),
    scaled: negative ? -absoluteScaled : absoluteScaled,
  };
}

function inventoryDisposalQuantity(value) {
  const quantity = inventoryDisposalScaledDecimal(value);
  if (!quantity) {
    throw AppError.badRequest(
      'quantity must be positive, fit NUMERIC(14,4), and have at most four decimal places',
      'INVENTORY_DISPOSAL_INPUT_INVALID',
      { field: 'quantity' },
    );
  }
  return quantity.number;
}

function inventoryDisposalText(value, label, max, { required = false } = {}) {
  const text = value == null ? '' : String(value).trim();
  if ((!text && required) || text.length > max || text.includes('\u0000')) {
    throw AppError.badRequest(
      `${label} must be ${required ? `1-${max}` : `at most ${max}`} characters`,
      'INVENTORY_DISPOSAL_INPUT_INVALID',
      { field: label },
    );
  }
  return text || null;
}

function inventoryDisposalDate(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw AppError.badRequest(
      'expected_expiry_date must use YYYY-MM-DD',
      'INVENTORY_DISPOSAL_INPUT_INVALID',
      { field: 'expected_expiry_date' },
    );
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw AppError.badRequest(
      'expected_expiry_date must be a valid calendar date',
      'INVENTORY_DISPOSAL_INPUT_INVALID',
      { field: 'expected_expiry_date' },
    );
  }
  return date;
}

function normalizeInventoryDisposalIntent(params = {}) {
  assertNoInventoryDisposalCallerAuthority(params);
  return {
    facilityId: inventoryDisposalId(params.facility_id, 'facility_id'),
    inventoryItemId: inventoryDisposalId(params.inventory_item_id, 'inventory_item_id'),
    inventoryBatchId: inventoryDisposalId(params.inventory_batch_id, 'inventory_batch_id'),
    quantity: inventoryDisposalQuantity(params.quantity),
    reasonCode: inventoryDisposalText(params.reason_code, 'reason_code', 80, { required: true }),
    dispositionMethod: inventoryDisposalText(
      params.disposition_method,
      'disposition_method',
      80,
      { required: true },
    ),
    authorityReference: inventoryDisposalText(
      params.authority_reference,
      'authority_reference',
      255,
    ),
    expectedBatchNumber: inventoryDisposalText(
      params.expected_batch_number,
      'expected_batch_number',
      120,
    ),
    expectedLotNumber: inventoryDisposalText(
      params.expected_lot_number,
      'expected_lot_number',
      120,
    ),
    expectedExpiryDate: inventoryDisposalDate(params.expected_expiry_date),
    notes: inventoryDisposalText(params.notes, 'notes', 2000),
    witnessApprovalId: params.witness_approval_id == null
      ? null
      : String(params.witness_approval_id).trim(),
  };
}

function inventoryDisposalRequestIntent(intent) {
  return {
    facility_id: intent.facilityId,
    inventory_item_id: intent.inventoryItemId,
    inventory_batch_id: intent.inventoryBatchId,
    quantity: intent.quantity,
    reason_code: intent.reasonCode,
    disposition_method: intent.dispositionMethod,
    authority_reference: intent.authorityReference,
    expected_batch_number: intent.expectedBatchNumber,
    expected_lot_number: intent.expectedLotNumber,
    expected_expiry_date: intent.expectedExpiryDate,
    notes: intent.notes,
    witness_approval_id: intent.witnessApprovalId,
  };
}

function stableInventoryDisposalJson(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map(stableInventoryDisposalJson).join(',')}]`;
  }
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
    .map((key) => (
      `${JSON.stringify(key)}:${stableInventoryDisposalJson(value[key])}`
    )).join(',')}}`;
}

function inventoryDisposalSha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function inventoryDisposalCommand(commandKey, requestFingerprint) {
  const key = String(commandKey || '').trim();
  const requestSha256 = String(requestFingerprint || '').trim().toLowerCase();
  if (!INVENTORY_DISPOSAL_IDEMPOTENCY_KEY_RE.test(key)
    || !/^[0-9a-f]{64}$/.test(requestSha256)) {
    throw AppError.conflict(
      'Inventory disposal requires durable idempotency authority',
      'INVENTORY_DISPOSAL_IDEMPOTENCY_REQUIRED',
    );
  }
  return {
    keySha256: inventoryDisposalSha256(key),
    requestSha256,
  };
}

function inventoryDisposalIntentSha256(tenantId, intent, performedBy) {
  return inventoryDisposalSha256(stableInventoryDisposalJson({
    contract: INVENTORY_DISPOSAL_CONTRACT,
    tenant_id: tenantId,
    performed_by: performedBy,
    intent: inventoryDisposalRequestIntent(intent),
  }));
}

function inventoryDisposalBatchExpiry(batch) {
  return batch.expiry_date instanceof Date
    ? batch.expiry_date.toISOString().slice(0, 10)
    : String(batch.expiry_date || '').slice(0, 10);
}

function assertInventoryDisposalLineage(intent, batch) {
  const expiryDate = inventoryDisposalBatchExpiry(batch);
  if ((intent.expectedBatchNumber
      && intent.expectedBatchNumber !== String(batch.batch_number || '').trim())
    || (intent.expectedLotNumber
      && intent.expectedLotNumber !== String(batch.lot_number || '').trim())
    || (intent.expectedExpiryDate && intent.expectedExpiryDate !== expiryDate)) {
    throw AppError.badRequest(
      'Inventory batch lineage does not match the documented batch, lot, or expiry',
      'INVENTORY_BATCH_LINEAGE_MISMATCH',
    );
  }
}

async function loadInventoryDisposalChainTx(tx, tenantId, intent, { lock = false } = {}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT item.id, item.catalog_id, item.facility_id, item.schedule_class,
            item.is_narcotic, item.unit_label, item.status AS item_status,
            catalog.id AS authoritative_catalog_id,
            batch.id AS authoritative_batch_id, batch.batch_number, batch.lot_number,
            batch.expiry_date, batch.remaining_quantity::text AS remaining_quantity,
            batch.status AS batch_status, batch.supplier_id, batch.storage_location_id,
            supplier.id AS authoritative_supplier_id,
            location.id AS authoritative_storage_location_id
       FROM pharmacy_inventory_items item
       JOIN tenants tenant
         ON tenant.id=item.tenant_id
        AND LOWER(COALESCE(tenant.status, ''))='active'
       JOIN pharmacy_catalog catalog
         ON catalog.tenant_id=item.tenant_id
        AND catalog.id=item.catalog_id
        AND catalog.is_active=TRUE
       JOIN facilities facility
         ON facility.tenant_id=item.tenant_id
        AND facility.id=item.facility_id
        AND facility.status='active'
       JOIN pharmacy_inventory_batches batch
         ON batch.tenant_id=item.tenant_id
        AND batch.id=$4::int
        AND batch.inventory_item_id=item.id
        AND batch.facility_id=item.facility_id
        AND batch.status IN ('in_stock', 'expired', 'recalled', 'quarantined')
       JOIN pharmacy_suppliers supplier
         ON supplier.tenant_id=batch.tenant_id
        AND supplier.id=batch.supplier_id
        AND supplier.facility_id=batch.facility_id
       JOIN facility_locations location
         ON location.tenant_id=batch.tenant_id
        AND location.facility_id=batch.facility_id
        AND location.id=batch.storage_location_id
        AND location.status='active'
      WHERE item.tenant_id=$1::uuid
        AND item.facility_id=$2::int
        AND item.id=$3::int
        AND item.status='active'
      ${lock
    ? 'FOR UPDATE OF item, catalog, facility, batch, supplier, location FOR SHARE OF tenant'
    : ''}`,
    tenantId,
    intent.facilityId,
    intent.inventoryItemId,
    intent.inventoryBatchId,
  );
  const chain = rows[0];
  if (!chain || !INVENTORY_DISPOSAL_STATES.has(String(chain.batch_status))) {
    throw AppError.conflict(
      'The active tenant, facility, catalog, item, batch, and storage location must retain one exact supplier lineage for disposal',
      'INVENTORY_DISPOSAL_AUTHORITY_INVALID',
    );
  }
  assertInventoryDisposalLineage(intent, chain);
  const remainingQuantity = inventoryDisposalScaledDecimal(
    chain.remaining_quantity,
    { allowZero: true },
  );
  const requestedQuantity = inventoryDisposalScaledDecimal(intent.quantity);
  if (!remainingQuantity
    || !requestedQuantity
    || remainingQuantity.scaled < requestedQuantity.scaled) {
    throw AppError.badRequest(
      `Insufficient stock. Available: ${chain.remaining_quantity}`,
      'INVENTORY_INSUFFICIENT_STOCK',
    );
  }
  return chain;
}

function inventoryDisposalPerformerFromGrant(grant) {
  const canonicalName = String(grant?.actor_name || '').trim();
  const canonicalRole = String(grant?.actor_role || '').trim().toUpperCase();
  const canonicalUid = String(grant?.actor_uid || '').trim().toLowerCase();
  const grantId = inventoryDisposalBigintId(grant?.grant_id);
  if (!canonicalName
      || !UUID_RE.test(canonicalUid)
      || !grantId
      || !INVENTORY_DISPOSAL_PERFORMER_ROLES.has(canonicalRole)) {
    throw AppError.forbidden(
      'Inventory disposal requires an active pharmacy staff or pharmacy-incharge performer',
      'INVENTORY_DISPOSAL_PERFORMER_IDENTITY_REQUIRED',
    );
  }
  return {
    uid: canonicalUid,
    name: canonicalName,
    role: canonicalRole,
    grant_id: grantId,
  };
}

async function canonicalInventoryDisposalPerformerTx(
  tx,
  tenantId,
  chain,
  grant,
  { lockIdentity = true } = {},
) {
  const grantedPerformer = inventoryDisposalPerformerFromGrant(grant);
  if (!isControlledItem(chain)) return grantedPerformer;
  const performer = await resolveControlledPerformerTx(
    tx,
    tenantId,
    grant.actor_uid,
    { lock: lockIdentity },
  );
  return {
    uid: String(performer.uid).toLowerCase(),
    name: String(performer.name).trim(),
    role: String(performer.role).trim().toUpperCase(),
    grant_id: grantedPerformer.grant_id,
  };
}

function inventoryDisposalNeedsWitness(chain) {
  return chain.schedule_class === 'X' || chain.is_narcotic === true;
}

function inventoryDisposalWitnessPayload(intent, chain, performer) {
  return {
    contract: INVENTORY_DISPOSAL_CONTRACT,
    facility_id: intent.facilityId,
    facility_grant_id: performer.grant_id,
    performer_role: performer.role,
    inventory_item_id: intent.inventoryItemId,
    inventory_batch_id: intent.inventoryBatchId,
    catalog_id: Number(chain.catalog_id),
    supplier_id: Number(chain.supplier_id),
    storage_location_id: Number(chain.storage_location_id),
    batch_number: String(chain.batch_number || '').trim(),
    lot_number: chain.lot_number == null ? null : String(chain.lot_number).trim(),
    expiry_date: inventoryDisposalBatchExpiry(chain),
    source_batch_status: String(chain.batch_status),
    quantity: intent.quantity,
    reason_code: intent.reasonCode,
    disposition_method: intent.dispositionMethod,
    authority_reference: intent.authorityReference,
    notes: intent.notes,
  };
}

function inventoryDisposalLedgerNotes(intent) {
  const evidence = [
    `reason=${intent.reasonCode}`,
    `method=${intent.dispositionMethod}`,
  ];
  if (intent.authorityReference) evidence.push(`authority_reference=${intent.authorityReference}`);
  if (intent.notes) evidence.push(intent.notes);
  return `Inventory batch disposal: ${evidence.join('; ')}`;
}

function inventoryDisposalNumbersMatch(left, right) {
  const normalizedLeft = inventoryDisposalScaledDecimal(left, {
    allowNegative: true,
    allowZero: true,
  });
  const normalizedRight = inventoryDisposalScaledDecimal(right, {
    allowNegative: true,
    allowZero: true,
  });
  return normalizedLeft != null
    && normalizedRight != null
    && normalizedLeft.scaled === normalizedRight.scaled;
}

function inventoryDisposalReceiptTextIsValid(value, max, { required = false } = {}) {
  if (value === null) return !required;
  return typeof value === 'string'
    && value === value.trim()
    && (!required || value.length > 0)
    && value.length <= max
    && !value.includes('\u0000');
}

function inventoryDisposalReceiptDateIsValid(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function inventoryDisposalReceiptQuantityIsValid(value, { allowZero = false } = {}) {
  return typeof value === 'number'
    && inventoryDisposalScaledDecimal(value, { allowZero }) != null;
}

function inventoryDisposalReceiptInt4IsValid(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= PG_INT4_MAX;
}

function inventoryDisposalReceiptIntentIsComplete(metadata, receipt, movement) {
  const intent = metadata.intent;
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
      || Object.keys(intent).sort().join('|')
        !== INVENTORY_DISPOSAL_RECEIPT_INTENT_FIELDS.join('|')) {
    return false;
  }
  const tenantId = String(movement.tenant_id || '').trim().toLowerCase();
  const performerUid = String(receipt.performed_by || '').trim().toLowerCase();
  const intentSha256 = inventoryDisposalSha256(stableInventoryDisposalJson({
    contract: INVENTORY_DISPOSAL_CONTRACT,
    tenant_id: tenantId,
    performed_by: performerUid,
    intent,
  }));
  return UUID_RE.test(tenantId)
    && intentSha256 === metadata.intent_sha256
    && metadata.facility_id === receipt.facility_id
    && metadata.witness_approval_id === receipt.witness_approval_id
    && intent.facility_id === receipt.facility_id
    && intent.inventory_item_id === receipt.inventory_item_id
    && intent.inventory_batch_id === receipt.inventory_batch_id
    && inventoryDisposalNumbersMatch(intent.quantity, receipt.quantity)
    && intent.reason_code === receipt.reason_code
    && intent.disposition_method === receipt.disposition_method
    && intent.authority_reference === receipt.authority_reference
    && intent.witness_approval_id === receipt.witness_approval_id
    && inventoryDisposalReceiptTextIsValid(intent.expected_batch_number, 120)
    && inventoryDisposalReceiptTextIsValid(intent.expected_lot_number, 120)
    && inventoryDisposalReceiptTextIsValid(intent.notes, 2000)
    && (intent.expected_expiry_date === null
      || inventoryDisposalReceiptDateIsValid(intent.expected_expiry_date))
    && (intent.expected_batch_number === null
      || intent.expected_batch_number === receipt.batch_number)
    && (intent.expected_lot_number === null
      || intent.expected_lot_number === receipt.lot_number)
    && (intent.expected_expiry_date === null
      || intent.expected_expiry_date === receipt.expiry_date);
}

function inventoryDisposalReceiptIsSemanticallyComplete(receipt, metadata, movement) {
  const sourceStatus = String(receipt.source_batch_status || '');
  const remainingBefore = receipt.remaining_quantity_before;
  const remainingAfter = receipt.remaining_quantity_after;
  const quantityEvidence = inventoryDisposalScaledDecimal(receipt.quantity);
  const beforeEvidence = inventoryDisposalScaledDecimal(remainingBefore);
  const afterEvidence = inventoryDisposalScaledDecimal(remainingAfter, { allowZero: true });
  const scheduleClass = receipt.schedule_class;
  const scheduleIsValid = ALLOWED_SCHEDULES.includes(scheduleClass);
  const controlledItem = scheduleIsValid
    && (CONTROLLED_SCHEDULES.includes(scheduleClass) || receipt.is_narcotic === true);
  const witnessRequired = scheduleIsValid
    && (scheduleClass === 'X' || receipt.is_narcotic === true);
  const witnessComplete = witnessRequired
    ? inventoryDisposalBigintId(receipt.witness_approval_id)
        === receipt.witness_approval_id
      && UUID_RE.test(String(receipt.witness_uid || ''))
      && inventoryDisposalReceiptTextIsValid(receipt.witness_name, 255, { required: true })
      && FACILITY_BOUND_CONTROLLED_DISPENSE_WITNESS_ROLES.includes(receipt.witness_role)
      && inventoryDisposalBigintId(receipt.witness_facility_grant_id)
        === receipt.witness_facility_grant_id
    : receipt.witness_approval_id === null
      && receipt.witness_uid === null
      && receipt.witness_name === null
      && receipt.witness_role === null
      && receipt.witness_facility_grant_id === null;
  const expectedResultStatus = afterEvidence?.scaled === 0n
    ? 'disposed'
    : sourceStatus;
  return inventoryDisposalReceiptInt4IsValid(receipt.facility_id)
    && inventoryDisposalReceiptInt4IsValid(receipt.inventory_item_id)
    && inventoryDisposalReceiptInt4IsValid(receipt.inventory_batch_id)
    && inventoryDisposalReceiptInt4IsValid(receipt.catalog_id)
    && inventoryDisposalReceiptInt4IsValid(receipt.supplier_id)
    && inventoryDisposalReceiptInt4IsValid(receipt.storage_location_id)
    && inventoryDisposalBigintId(receipt.facility_grant_id) === receipt.facility_grant_id
    && UUID_RE.test(String(receipt.performed_by || ''))
    && inventoryDisposalReceiptTextIsValid(receipt.performed_by_name, 255, { required: true })
    && INVENTORY_DISPOSAL_PERFORMER_ROLES.has(receipt.performer_role)
    && inventoryDisposalReceiptTextIsValid(receipt.batch_number, 120, { required: true })
    && inventoryDisposalReceiptTextIsValid(receipt.lot_number, 120)
    && inventoryDisposalReceiptDateIsValid(receipt.expiry_date)
    && inventoryDisposalReceiptQuantityIsValid(receipt.quantity)
    && inventoryDisposalReceiptQuantityIsValid(remainingBefore)
    && inventoryDisposalReceiptQuantityIsValid(remainingAfter, { allowZero: true })
    && quantityEvidence != null
    && beforeEvidence != null
    && afterEvidence != null
    && beforeEvidence.scaled >= quantityEvidence.scaled
    && beforeEvidence.scaled - quantityEvidence.scaled === afterEvidence.scaled
    && INVENTORY_DISPOSAL_STATES.has(sourceStatus)
    && receipt.resulting_batch_status === expectedResultStatus
    && inventoryDisposalReceiptTextIsValid(receipt.reason_code, 80, { required: true })
    && inventoryDisposalReceiptTextIsValid(
      receipt.disposition_method,
      80,
      { required: true },
    )
    && inventoryDisposalReceiptTextIsValid(receipt.authority_reference, 255)
    && scheduleIsValid
    && typeof receipt.is_narcotic === 'boolean'
    && typeof receipt.controlled_item === 'boolean'
    && receipt.controlled_item === controlledItem
    && typeof receipt.register_required === 'boolean'
    && receipt.register_required === controlledItem
    && typeof receipt.witness_required === 'boolean'
    && receipt.witness_required === witnessRequired
    && witnessComplete
    && inventoryDisposalReceiptIntentIsComplete(metadata, receipt, movement);
}

async function loadInventoryDisposalMovementsByCommandTx(tx, tenantId, commandKeySha256) {
  return tx.$queryRawUnsafe(
    `SELECT movement.id, movement.tenant_id, movement.inventory_item_id,
            movement.inventory_batch_id, movement.movement_kind,
            movement.quantity_delta, movement.reference_type,
            movement.reference_id, movement.performed_by, movement.notes,
            movement.metadata, movement.created_at
       FROM pharmacy_stock_movements movement
      WHERE movement.tenant_id=$1::uuid
        AND movement.metadata->>'contract'=$2
        AND movement.metadata->>'command_key_sha256'=$3
      ORDER BY movement.id
      LIMIT 2`,
    tenantId,
    INVENTORY_DISPOSAL_CONTRACT,
    commandKeySha256,
  );
}

function inventoryDisposalReceiptFromMovement(movement, {
  command,
  intentSha256,
  performedBy,
}) {
  const metadata = movement?.metadata && typeof movement.metadata === 'object'
    && !Array.isArray(movement.metadata)
    ? movement.metadata
    : {};
  const receipt = metadata.receipt && typeof metadata.receipt === 'object'
    && !Array.isArray(metadata.receipt)
    ? metadata.receipt
    : null;
  const structurallyComplete = receipt
    && receipt.contract === INVENTORY_DISPOSAL_CONTRACT
    && metadata.contract === INVENTORY_DISPOSAL_CONTRACT
    && metadata.command_key_sha256 === command.keySha256
    && receipt.command_key_sha256 === command.keySha256
    && /^[0-9a-f]{64}$/.test(String(metadata.request_sha256 || ''))
    && /^[0-9a-f]{64}$/.test(String(metadata.intent_sha256 || ''))
    && metadata.request_sha256 === receipt.request_sha256
    && metadata.intent_sha256 === receipt.intent_sha256
    && inventoryDisposalReceiptIsSemanticallyComplete(receipt, metadata, movement)
    && Number.isSafeInteger(Number(receipt.facility_id))
    && Number(receipt.facility_id) > 0
    && Number(receipt.inventory_item_id) === Number(movement.inventory_item_id)
    && Number(receipt.inventory_batch_id) === Number(movement.inventory_batch_id)
    && movement.movement_kind === 'dispose'
    && movement.reference_type === INVENTORY_DISPOSAL_REFERENCE
    && String(movement.reference_id) === String(receipt.inventory_batch_id)
    && inventoryDisposalNumbersMatch(
      movement.quantity_delta,
      -Number(receipt.quantity),
    )
    && String(movement.performed_by || '').toLowerCase()
      === String(receipt.performed_by || '').toLowerCase()
    && metadata.witness_approval_id === receipt.witness_approval_id;
  if (!structurallyComplete) {
    throw AppError.conflict(
      'Inventory disposal committed without one complete immutable replay receipt',
      'INVENTORY_DISPOSAL_RECEIPT_CONFLICT',
    );
  }
  if (metadata.request_sha256 !== command.requestSha256
    || metadata.intent_sha256 !== intentSha256
    || String(receipt.performed_by || '').toLowerCase() !== performedBy) {
    throw AppError.conflict(
      'Idempotency-Key was already used for a different inventory disposal intent',
      'INVENTORY_DISPOSAL_IDEMPOTENCY_MISMATCH',
    );
  }
  return receipt;
}

async function loadInventoryDisposalRegisterTx(tx, tenantId, movementId) {
  return tx.$queryRawUnsafe(
    `SELECT id, tenant_id, facility_id, inventory_item_id,
            inventory_batch_id, schedule_class, movement_kind, quantity,
            unit_label, running_balance, patient_uid, patient_name,
            patient_phone, prescription_id, prescription_number,
            prescriber_uid, prescriber_name, prescriber_registration,
            patient_id_proof_type, patient_id_proof_last4, performed_by,
            performed_by_name, witness_uid, witness_name,
            reference_movement_id, notes, created_at
       FROM pharmacy_schedule_register
      WHERE tenant_id=$1::uuid
        AND reference_movement_id=$2::int
      ORDER BY id
      LIMIT 2`,
    tenantId,
    Number(movementId),
  );
}

function assertInventoryDisposalRegisterReceipt(receipt, movement, registers) {
  const registerRequired = receipt.register_required === true;
  if ((registerRequired && registers.length !== 1)
    || (!registerRequired && registers.length !== 0)) {
    throw AppError.conflict(
      'Inventory disposal statutory-register evidence conflicts with its immutable receipt',
      'INVENTORY_DISPOSAL_RECEIPT_CONFLICT',
    );
  }
  const register = registers[0] || null;
  const expectedScheduleClass = receipt.schedule_class
    || (receipt.is_narcotic === true ? 'X' : 'H1');
  if (register && (
    Number(register.facility_id) !== Number(receipt.facility_id)
    || Number(register.inventory_item_id) !== Number(receipt.inventory_item_id)
    || Number(register.inventory_batch_id) !== Number(receipt.inventory_batch_id)
    || register.movement_kind !== 'dispose'
    || register.schedule_class !== expectedScheduleClass
    || !inventoryDisposalNumbersMatch(register.quantity, receipt.quantity)
    || String(register.performed_by || '').toLowerCase()
      !== String(receipt.performed_by || '').toLowerCase()
    || String(register.performed_by_name || '') !== String(receipt.performed_by_name || '')
    || String(register.witness_uid || '').toLowerCase()
      !== String(receipt.witness_uid || '').toLowerCase()
    || String(register.witness_name || '') !== String(receipt.witness_name || '')
    || Number(register.reference_movement_id) !== Number(movement.id)
  )) {
    throw AppError.conflict(
      'Inventory disposal statutory-register evidence does not match its stock movement',
      'INVENTORY_DISPOSAL_RECEIPT_CONFLICT',
    );
  }
  return register;
}

function inventoryDisposalPublicTimestamp(value, field) {
  if (!(value instanceof Date) && typeof value !== 'string') {
    throw AppError.conflict(
      `Inventory disposal ${field} is not a valid timestamp`,
      'INVENTORY_DISPOSAL_RECEIPT_CONFLICT',
    );
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw AppError.conflict(
      `Inventory disposal ${field} is not a valid timestamp`,
      'INVENTORY_DISPOSAL_RECEIPT_CONFLICT',
    );
  }
  return parsed.toISOString();
}

function serializeInventoryDisposalMovement(movement, facilityId) {
  return {
    id: Number(movement.id),
    facility_id: Number(facilityId),
    inventory_item_id: Number(movement.inventory_item_id),
    inventory_batch_id: movement.inventory_batch_id == null
      ? null
      : Number(movement.inventory_batch_id),
    movement_kind: movement.movement_kind,
    quantity_delta: Number(movement.quantity_delta),
    reference_type: movement.reference_type ?? null,
    reference_id: movement.reference_id ?? null,
    performed_by: movement.performed_by ?? null,
    notes: movement.notes ?? null,
    created_at: inventoryDisposalPublicTimestamp(movement.created_at, 'movement created_at'),
  };
}

function serializeInventoryDisposalRegister(register) {
  if (!register) return null;
  return {
    id: Number(register.id),
    facility_id: Number(register.facility_id),
    inventory_item_id: Number(register.inventory_item_id),
    inventory_batch_id: register.inventory_batch_id == null
      ? null
      : Number(register.inventory_batch_id),
    schedule_class: register.schedule_class,
    movement_kind: register.movement_kind,
    quantity: Number(register.quantity),
    unit_label: register.unit_label ?? null,
    running_balance: Number(register.running_balance),
    patient_uid: register.patient_uid ?? null,
    patient_name: register.patient_name ?? null,
    patient_phone: register.patient_phone ?? null,
    prescription_id: register.prescription_id == null ? null : Number(register.prescription_id),
    prescription_number: register.prescription_number ?? null,
    prescriber_uid: register.prescriber_uid ?? null,
    prescriber_name: register.prescriber_name ?? null,
    prescriber_registration: register.prescriber_registration ?? null,
    patient_id_proof_type: register.patient_id_proof_type ?? null,
    patient_id_proof_last4: register.patient_id_proof_last4 ?? null,
    performed_by: register.performed_by,
    performed_by_name: register.performed_by_name ?? null,
    witness_uid: register.witness_uid ?? null,
    witness_name: register.witness_name ?? null,
    reference_movement_id: register.reference_movement_id == null
      ? null
      : Number(register.reference_movement_id),
    notes: register.notes ?? null,
    created_at: inventoryDisposalPublicTimestamp(register.created_at, 'register created_at'),
  };
}

function inventoryDisposalResult(movement, register, receipt, { replay }) {
  return {
    disposal: {
      contract: INVENTORY_DISPOSAL_CONTRACT,
      facility_id: Number(receipt.facility_id),
      inventory_item_id: Number(receipt.inventory_item_id),
      inventory_batch_id: Number(receipt.inventory_batch_id),
      quantity: Number(receipt.quantity),
      reason_code: receipt.reason_code,
      disposition_method: receipt.disposition_method,
      authority_reference: receipt.authority_reference ?? null,
      source_batch_status: receipt.source_batch_status,
      resulting_batch_status: receipt.resulting_batch_status,
      movement_id: Number(movement.id),
      schedule_register_id: register ? Number(register.id) : null,
      witness_approval_id: receipt.witness_approval_id ?? null,
      performed_by: receipt.performed_by,
      facility_grant_id: receipt.facility_grant_id,
      witness_uid: receipt.witness_uid ?? null,
      witness_facility_grant_id: receipt.witness_facility_grant_id ?? null,
      command_key_sha256: receipt.command_key_sha256,
      request_sha256: receipt.request_sha256,
      completed_at: inventoryDisposalPublicTimestamp(movement.created_at, 'completed_at'),
    },
    movement: serializeInventoryDisposalMovement(movement, receipt.facility_id),
    register_entry: serializeInventoryDisposalRegister(register),
    idempotent_replay: replay,
  };
}

async function appendInventoryDisposalRegisterTx(tx, {
  tenantId,
  intent,
  chain,
  performer,
  witness,
  movement,
}) {
  const balance = await controlledCustodyBalanceTx(tx, {
    tenantId,
    facilityId: intent.facilityId,
    inventoryItemId: intent.inventoryItemId,
  });
  const scheduleClass = canonicalControlledSchedule(chain);
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO pharmacy_schedule_register
       (tenant_id, facility_id, inventory_item_id, inventory_batch_id,
        schedule_class, movement_kind, quantity, unit_label, running_balance,
        performed_by, performed_by_name, witness_uid, witness_name,
        reference_movement_id, notes)
     VALUES ($1::uuid, $2::int, $3::int, $4::int,
             $5, 'dispose', $6::numeric, $7, $8::numeric,
             $9::uuid, $10, $11::uuid, $12, $13::int, $14)
     RETURNING id, tenant_id, facility_id, inventory_item_id,
               inventory_batch_id, schedule_class, movement_kind, quantity,
               unit_label, running_balance, patient_uid, patient_name,
               patient_phone, prescription_id, prescription_number,
               prescriber_uid, prescriber_name, prescriber_registration,
               patient_id_proof_type, patient_id_proof_last4, performed_by,
               performed_by_name, witness_uid, witness_name,
               reference_movement_id, notes, created_at`,
    tenantId,
    intent.facilityId,
    intent.inventoryItemId,
    intent.inventoryBatchId,
    scheduleClass,
    intent.quantity,
    chain.unit_label || null,
    balance,
    performer.uid,
    performer.name,
    witness?.uid || null,
    witness?.name || null,
    Number(movement.id),
    inventoryDisposalLedgerNotes(intent),
  );
  if (!rows[0]) {
    throw AppError.internal(
      'Inventory disposal statutory register could not be written',
      'INVENTORY_DISPOSAL_REGISTER_WRITE_FAILED',
    );
  }
  return rows[0];
}

async function appendInventoryDisposalAuditTx(tx, {
  tenantId,
  performer,
  movement,
  register,
  receipt,
}) {
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs
       (uid, role, action, resource, resource_id, metadata, tenant_id)
     VALUES ($1::uuid, $2, 'PHARMACY_INVENTORY_DISPOSED',
             'pharmacy_stock_movements', $3, $4::jsonb, $5::uuid)`,
    performer.uid,
    performer.role,
    String(movement.id),
    JSON.stringify({
      ...receipt,
      movement_id: Number(movement.id),
      schedule_register_id: register ? Number(register.id) : null,
    }),
    tenantId,
  );
}

async function assertActiveInventoryDisposalTenantTx(tx, tenantId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id
       FROM tenants
      WHERE id=$1::uuid
        AND LOWER(COALESCE(status, ''))='active'
      FOR SHARE`,
    tenantId,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Inventory disposal requires an active tenant',
      'INVENTORY_DISPOSAL_AUTHORITY_INVALID',
    );
  }
}

function assertInventoryDisposalWitnessRequest(intent) {
  if (intent.witnessApprovalId != null) {
    throw AppError.badRequest(
      'A witness approval request cannot supply its own approval identity',
      'INVENTORY_DISPOSAL_CALLER_AUTHORITY_REJECTED',
      { forbidden_fields: ['witness_approval_id'] },
    );
  }
}

async function resolveInventoryDisposalWitnessPayloadTx(tx, {
  tenantId,
  intent,
  requestedBy,
  requestedByRole = null,
  scope,
  lockAuthority = false,
}) {
  if (scope !== CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventoryDisposal) {
    throw AppError.conflict(
      'Witness approval does not match an inventory disposal',
      'CONTROLLED_DISPENSE_WITNESS_APPROVAL_MISMATCH',
    );
  }
  const canonicalRequester = inventoryDisposalUuid(requestedBy, 'requested_by');
  await assertActiveInventoryDisposalTenantTx(tx, tenantId);
  const grant = await assertPharmacyFacilityGrant(tx, {
    tenantId,
    facilityId: intent.facilityId,
    actorUid: canonicalRequester,
    actorRole: requestedByRole,
    forUpdate: lockAuthority,
  });
  const chain = await loadInventoryDisposalChainTx(
    tx,
    tenantId,
    intent,
    { lock: lockAuthority },
  );
  const performer = await canonicalInventoryDisposalPerformerTx(
    tx,
    tenantId,
    chain,
    grant,
    { lockIdentity: lockAuthority },
  );
  if (!inventoryDisposalNeedsWitness(chain)) {
    throw AppError.badRequest(
      'An independent witness approval is only available for Schedule X or narcotic disposal',
      'INVENTORY_DISPOSAL_WITNESS_NOT_REQUIRED',
    );
  }
  return inventoryDisposalWitnessPayload(intent, chain, performer);
}

export async function requestInventoryDisposalWitnessApproval(params = {}) {
  const tenantId = inventoryDisposalUuid(requireTenantId(params.tenantId), 'tenantId');
  const requestedBy = inventoryDisposalUuid(params.requested_by, 'requested_by');
  const intent = normalizeInventoryDisposalIntent(params);
  assertInventoryDisposalWitnessRequest(intent);
  const payload = await setTenantTx(tenantId, (tx) => (
    resolveInventoryDisposalWitnessPayloadTx(tx, {
      tenantId,
      intent,
      requestedBy,
      requestedByRole: params.actorRole || null,
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventoryDisposal,
      lockAuthority: false,
    })
  ));
  return createControlledDispenseWitnessApproval({
    tenantId,
    scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventoryDisposal,
    payload,
    requestedBy,
  });
}

export async function preflightInventoryDisposalWitnessApproval(params = {}) {
  const tenantId = inventoryDisposalUuid(requireTenantId(params.tenantId), 'tenantId');
  const intent = normalizeInventoryDisposalIntent(params.disposal || {});
  assertInventoryDisposalWitnessRequest(intent);
  const requesterUid = params.requesterUid == null
    ? null
    : inventoryDisposalUuid(params.requesterUid, 'requesterUid');
  return preflightControlledDispenseWitnessApproval({
    tenantId,
    approvalId: params.approvalId,
    scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventoryDisposal,
    requesterUid,
    resolvePayload: ({ tx, requestedBy, scope }) => (
      resolveInventoryDisposalWitnessPayloadTx(tx, {
        tenantId,
        intent,
        requestedBy,
        scope,
        lockAuthority: false,
      })
    ),
  });
}

export async function approveInventoryDisposalWitnessApproval(params = {}) {
  const tenantId = inventoryDisposalUuid(requireTenantId(params.tenantId), 'tenantId');
  const intent = normalizeInventoryDisposalIntent(params.disposal || {});
  assertInventoryDisposalWitnessRequest(intent);
  const requesterUid = params.requesterUid == null
    ? null
    : inventoryDisposalUuid(params.requesterUid, 'requesterUid');
  return approveControlledDispenseWitnessApproval({
    tenantId,
    approvalId: params.approvalId,
    actorUid: params.actorUid,
    scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventoryDisposal,
    requesterUid,
    resolvePayload: ({ tx, requestedBy, scope }) => (
      resolveInventoryDisposalWitnessPayloadTx(tx, {
        tenantId,
        intent,
        requestedBy,
        scope,
        lockAuthority: true,
      })
    ),
  });
}

export async function disposeInventoryBatch(params = {}) {
  const tenantId = inventoryDisposalUuid(requireTenantId(params.tenantId), 'tenantId');
  const performedBy = inventoryDisposalUuid(params.performed_by, 'performed_by');
  const intent = normalizeInventoryDisposalIntent(params);
  const command = inventoryDisposalCommand(params.commandKey, params.requestFingerprint);
  const intentSha256 = inventoryDisposalIntentSha256(tenantId, intent, performedBy);
  const requireExistingReceipt = params.requireExistingReceipt === true;

  return setTenantTx(tenantId, async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))::text AS lock_acquired`,
      `${INVENTORY_DISPOSAL_CONTRACT}:${tenantId}:${command.keySha256}`,
    );
    await assertActiveInventoryDisposalTenantTx(tx, tenantId);
    const priorMovements = await loadInventoryDisposalMovementsByCommandTx(
      tx,
      tenantId,
      command.keySha256,
    );
    if (priorMovements.length > 1) {
      throw AppError.conflict(
        'Multiple inventory disposal movements carry one command identity',
        'INVENTORY_DISPOSAL_RECEIPT_CONFLICT',
      );
    }
    if (!priorMovements[0] && requireExistingReceipt) {
      throw AppError.conflict(
        'Completed inventory disposal replay has no immutable domain receipt',
        'INVENTORY_DISPOSAL_COMPLETED_REPLAY_RECEIPT_REQUIRED',
      );
    }
    if (priorMovements[0]) {
      const movement = priorMovements[0];
      const receipt = inventoryDisposalReceiptFromMovement(movement, {
        command,
        intentSha256,
        performedBy,
      });
      const grant = await assertPharmacyFacilityGrant(tx, {
        tenantId,
        facilityId: Number(receipt.facility_id),
        actorUid: performedBy,
        actorRole: params.actorRole || null,
        forUpdate: true,
      });
      inventoryDisposalPerformerFromGrant(grant);
      if (receipt.controlled_item === true) {
        await resolveControlledPerformerTx(tx, tenantId, performedBy);
      }
      const registers = await loadInventoryDisposalRegisterTx(tx, tenantId, movement.id);
      const register = assertInventoryDisposalRegisterReceipt(receipt, movement, registers);
      return inventoryDisposalResult(movement, register, receipt, { replay: true });
    }

    const grant = await assertPharmacyFacilityGrant(tx, {
      tenantId,
      facilityId: intent.facilityId,
      actorUid: performedBy,
      actorRole: params.actorRole || null,
      forUpdate: true,
    });
    const chain = await loadInventoryDisposalChainTx(tx, tenantId, intent, { lock: true });
    const performer = await canonicalInventoryDisposalPerformerTx(
      tx,
      tenantId,
      chain,
      grant,
    );
    const controlledItem = isControlledItem(chain);
    const statutorySchedule = controlledItem
      ? canonicalControlledSchedule(chain)
      : chain.schedule_class || null;
    const witnessRequired = inventoryDisposalNeedsWitness(chain);
    if (!witnessRequired && intent.witnessApprovalId != null) {
      throw AppError.badRequest(
        'This inventory disposal does not require witness approval evidence',
        'INVENTORY_DISPOSAL_WITNESS_NOT_REQUIRED',
      );
    }
    const witnessPayload = inventoryDisposalWitnessPayload(intent, chain, performer);
    const witness = witnessRequired
      ? await consumeControlledDispenseWitnessApproval({
        tx,
        tenantId,
        approvalId: intent.witnessApprovalId,
        scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventoryDisposal,
        payload: witnessPayload,
        requestedBy: performer.uid,
      })
      : null;

    const remainingEvidence = inventoryDisposalScaledDecimal(
      chain.remaining_quantity,
      { allowZero: true },
    );
    const quantityEvidence = inventoryDisposalScaledDecimal(intent.quantity);
    if (!remainingEvidence
      || !quantityEvidence
      || remainingEvidence.scaled < quantityEvidence.scaled) {
      throw AppError.badRequest(
        `Insufficient stock. Available: ${chain.remaining_quantity}`,
        'INVENTORY_INSUFFICIENT_STOCK',
      );
    }
    const remainingBefore = remainingEvidence.number;
    const remainingAfterScaled = remainingEvidence.scaled - quantityEvidence.scaled;
    const remainingAfter = Number(remainingAfterScaled) / 10_000;
    const sourceBatchStatus = String(chain.batch_status);
    const resultingBatchStatus = remainingAfterScaled === 0n ? 'disposed' : sourceBatchStatus;
    const receipt = {
      contract: INVENTORY_DISPOSAL_CONTRACT,
      command_key_sha256: command.keySha256,
      request_sha256: command.requestSha256,
      intent_sha256: intentSha256,
      facility_id: intent.facilityId,
      inventory_item_id: intent.inventoryItemId,
      inventory_batch_id: intent.inventoryBatchId,
      catalog_id: Number(chain.catalog_id),
      supplier_id: Number(chain.supplier_id),
      storage_location_id: Number(chain.storage_location_id),
      batch_number: String(chain.batch_number || '').trim(),
      lot_number: chain.lot_number == null ? null : String(chain.lot_number).trim(),
      expiry_date: inventoryDisposalBatchExpiry(chain),
      quantity: intent.quantity,
      reason_code: intent.reasonCode,
      disposition_method: intent.dispositionMethod,
      authority_reference: intent.authorityReference,
      source_batch_status: sourceBatchStatus,
      resulting_batch_status: resultingBatchStatus,
      remaining_quantity_before: remainingBefore,
      remaining_quantity_after: remainingAfter,
      schedule_class: statutorySchedule,
      is_narcotic: chain.is_narcotic === true,
      controlled_item: controlledItem,
      register_required: controlledItem,
      witness_required: witnessRequired,
      witness_approval_id: witnessRequired ? intent.witnessApprovalId : null,
      performed_by: performer.uid,
      performed_by_name: performer.name,
      performer_role: performer.role,
      facility_grant_id: performer.grant_id,
      witness_uid: witness?.uid || null,
      witness_name: witness?.name || null,
      witness_role: witness?.role || null,
      witness_facility_grant_id: witness?.facility_grant_id || null,
    };
    await lockControlledRegisterItemTx(tx, tenantId, intent.inventoryItemId);
    const { movement } = await recordMovementTx(tx, {
      tenantId,
      inventory_item_id: intent.inventoryItemId,
      inventory_batch_id: intent.inventoryBatchId,
      movement_kind: 'dispose',
      quantity: intent.quantity,
      reference_type: INVENTORY_DISPOSAL_REFERENCE,
      reference_id: String(intent.inventoryBatchId),
      notes: inventoryDisposalLedgerNotes(intent),
      performed_by: performer.uid,
      expected_facility_id: intent.facilityId,
      expected_batch_number: String(chain.batch_number || '').trim(),
      expected_lot_number: chain.lot_number == null ? null : String(chain.lot_number).trim(),
      expected_expiry_date: inventoryDisposalBatchExpiry(chain),
      controlled_batch_policy: 'disposable',
      controlled_authority: CONTROLLED_MOVEMENT_AUTHORITY,
      metadata: {
        contract: INVENTORY_DISPOSAL_CONTRACT,
        command_key_sha256: command.keySha256,
        request_sha256: command.requestSha256,
        intent_sha256: intentSha256,
        facility_id: intent.facilityId,
        witness_approval_id: receipt.witness_approval_id,
        intent: inventoryDisposalRequestIntent(intent),
        receipt,
      },
    });
    const batchRows = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_inventory_batches
          SET status=CASE WHEN remaining_quantity=0 THEN 'disposed' ELSE status END,
              updated_at=NOW()
        WHERE tenant_id=$1::uuid
          AND facility_id=$2::int
          AND inventory_item_id=$3::int
          AND id=$4::int
        RETURNING remaining_quantity::text AS remaining_quantity, status`,
      tenantId,
      intent.facilityId,
      intent.inventoryItemId,
      intent.inventoryBatchId,
    );
    if (batchRows.length !== 1
      || !inventoryDisposalNumbersMatch(batchRows[0].remaining_quantity, remainingAfter)
      || batchRows[0].status !== resultingBatchStatus) {
      throw AppError.conflict(
        'Inventory disposal batch projection does not match its immutable movement receipt',
        'INVENTORY_DISPOSAL_RECEIPT_CONFLICT',
      );
    }
    const register = controlledItem
      ? await appendInventoryDisposalRegisterTx(tx, {
        tenantId,
        intent,
        chain,
        performer,
        witness,
        movement,
      })
      : null;
    await appendInventoryDisposalAuditTx(tx, {
      tenantId,
      performer,
      movement,
      register,
      receipt,
    });
    return inventoryDisposalResult(movement, register, receipt, { replay: false });
  });
}

export async function dispenseControlledTx(tx, {
  tenantId,
  inventory_item_id, inventory_batch_id,
  quantity, patient_uid, patient_name, patient_phone,
  prescription_id, prescription_line_index, prescription_number,
  prescriber_uid, prescriber_name, prescriber_registration,
  patient_id_proof_type, patient_id_proof_last4,
  performed_by, performed_by_name,
  witness_approval_id, witness_evidence = null, notes,
  reference_id = null,
  movement_metadata = null,
  consume_prescription_line_authority = true,
  validated_substitution_authority = null,
}) {
  const authority = await resolveControlledDispenseAuthority(tx, {
    tenantId,
    patient_uid,
    prescription_id,
    prescription_line_index,
    inventory_item_id,
    quantity,
  }, {
    forUpdate: true,
    requirePrescription: true,
  });
  patient_uid = authority.patient_uid;
  patient_name = authority.patient_name;
  patient_phone = authority.patient_phone;
  prescription_id = authority.prescription_id ?? prescription_id;
  prescription_line_index = authority.prescription_line_index ?? prescription_line_index;
  prescription_number = authority.prescription_number ?? prescription_number;
  prescriber_uid = authority.prescriber_uid ?? prescriber_uid;
  prescriber_name = authority.prescriber_name ?? prescriber_name;
  prescriber_registration = authority.prescriber_registration ?? prescriber_registration;
  const performer = await resolveControlledPerformerTx(tx, tenantId, performed_by);
  performed_by = performer.uid;
  performed_by_name = performer.name;
  const controlledBatchId = requireControlledBatchId(inventory_batch_id);
  // Pre-conditions: item must be Schedule H/H1/X (or marked narcotic).
  const items = await tx.$queryRawUnsafe(
    `SELECT item.id, item.catalog_id, item.schedule_class, item.is_narcotic, item.unit_label,
            item.facility_id
       FROM pharmacy_inventory_items item
       JOIN facilities facility
         ON facility.tenant_id=item.tenant_id
        AND facility.id=item.facility_id
        AND facility.status='active'
      WHERE item.id = $1::int
        AND item.tenant_id = $2::uuid
        AND item.status='active'`,
    Number(inventory_item_id), tenantId,
  );
  if (!items.length) throw AppError.notFound('Inventory item not found');
  const item = items[0];
  if (!['H', 'H1', 'X'].includes(item.schedule_class) && !item.is_narcotic) {
    throw AppError.badRequest('Item is not a controlled substance — use the regular issue path');
  }
  if (Number(item.catalog_id) !== Number(authority.prescription_catalog_id)
    && validated_substitution_authority !== CONTROLLED_SUBSTITUTION_AUTHORITY) {
    throw AppError.conflict(
      'Inventory item does not match the exact prescribed catalog line',
      'CONTROLLED_DISPENSE_PRESCRIPTION_CATALOG_MISMATCH',
    );
  }
  // Witness required for Schedule X / narcotic.
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
        prescription_line_index,
        prescription_catalog_id: authority.prescription_catalog_id,
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
    await lockControlledRegisterItemTx(tx, tenantId, inventory_item_id);
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
      metadata: {
        ...(movement_metadata && typeof movement_metadata === 'object'
          && !Array.isArray(movement_metadata) ? movement_metadata : {}),
        prescription_id: Number(prescription_id),
        prescription_line_index: Number(prescription_line_index),
        prescription_catalog_id: Number(authority.prescription_catalog_id),
      },
      require_usable_batch: true,
      expected_facility_id: Number(item.facility_id),
      controlled_authority: CONTROLLED_MOVEMENT_AUTHORITY,
    });

    const balance = await controlledCustodyBalanceTx(tx, {
      tenantId,
      facilityId: Number(item.facility_id),
      inventoryItemId: Number(inventory_item_id),
    });

    const reg = await tx.$queryRawUnsafe(
      `INSERT INTO pharmacy_schedule_register
         (tenant_id, facility_id, inventory_item_id, inventory_batch_id, schedule_class,
          movement_kind, quantity, unit_label, running_balance,
          patient_uid, patient_name, patient_phone,
          prescription_id, prescription_number,
          prescriber_uid, prescriber_name, prescriber_registration,
          patient_id_proof_type, patient_id_proof_last4,
          performed_by, performed_by_name, witness_uid, witness_name,
          reference_movement_id, notes)
       VALUES ($1::uuid, $2::int, $3::int, $4, $5, 'dispense', $6::numeric, $7,
               $8::numeric, $9::uuid, $10, $11, $12, $13, $14::uuid, $15, $16,
               $17, $18, $19::uuid, $20, $21::uuid, $22, $23::int, $24)
       RETURNING *`,
      tenantId,
      Number(item.facility_id),
      Number(inventory_item_id),
      controlledBatchId,
      canonicalControlledSchedule(item),
      Number(quantity),
      item.unit_label,
      balance,
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

    if (consume_prescription_line_authority) {
      const medications = authority.prescription_medications.map((medication) => ({ ...medication }));
      const line = medications[prescription_line_index];
      const dispensedQuantity = authority.prescription_dispensed_quantity + Number(quantity);
      const remainingQuantity = Math.max(
        0,
        authority.prescription_remaining_quantity - Number(quantity),
      );
      line.dispensed_quantity = dispensedQuantity;
      line.remaining_quantity = remainingQuantity;
      line.fulfilment_status = remainingQuantity <= 0.000001 ? 'fulfilled' : 'partial';
      const fulfilled = medications.every((medication) => {
        const ordered = Number(
          medication?.ordered_quantity ?? medication?.quantity ?? medication?.qty,
        );
        const dispensed = Math.max(0, Number(medication?.dispensed_quantity || 0));
        const remaining = Number.isFinite(Number(medication?.remaining_quantity))
          ? Number(medication.remaining_quantity)
          : ordered - dispensed;
        return Number.isFinite(remaining) && remaining <= 0.000001;
      });
      const updated = await tx.$queryRawUnsafe(
        `UPDATE e_prescriptions
            SET medications=$4::jsonb,
                status=CASE WHEN $5::boolean THEN 'fulfilled' ELSE status END,
                revision=COALESCE(revision, 1)+1,
                updated_at=NOW()
          WHERE tenant_id=$1::uuid
            AND id=$2::int
            AND COALESCE(revision, 1)=$3::int
          RETURNING id`,
        tenantId,
        Number(prescription_id),
        Number(authority.prescription_revision),
        JSON.stringify(medications),
        fulfilled,
      );
      if (!updated[0]) {
        throw AppError.conflict(
          'Prescription authority changed before the controlled dispense could be committed',
          'CONTROLLED_DISPENSE_PRESCRIPTION_STATE_CHANGED',
        );
      }
    }

    return { register_entry: reg[0], movement };
  }
}

function wardClinicalCatalogId(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const candidates = [
    details.catalog_id,
    details.pharmacy_catalog_id,
    details.medication?.catalog_id,
    details.medication?.pharmacy_catalog_id,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

export function wardControlledHandoffWitnessPayload({
  ward_indent_id,
  ward_indent_item_id,
  allocation_id,
  inventory_item_id,
  inventory_batch_id,
  quantity,
  patient_uid,
  clinical_order_id,
  catalog_id,
  reference_id,
}) {
  return {
    ward_indent_id: Number(ward_indent_id),
    ward_indent_item_id: Number(ward_indent_item_id),
    allocation_id: String(allocation_id),
    inventory_item_id: Number(inventory_item_id),
    inventory_batch_id: Number(inventory_batch_id),
    quantity: Number(quantity),
    patient_uid: String(patient_uid),
    clinical_order_id: Number(clinical_order_id),
    catalog_id: Number(catalog_id),
    reference_id: String(reference_id),
  };
}

export async function dispenseWardControlledAllocationTx(tx, {
  tenantId,
  facilityId,
  indentId,
  wardItemId,
  allocationId,
  inventoryItemId,
  inventoryBatchId,
  quantity,
  patientUid,
  clinicalOrderId,
  catalogId,
  referenceId,
  performedBy,
  witnessApprovalId = null,
  commandKey = null,
  wardAuthority,
}) {
  if (wardAuthority !== WARD_CONTROLLED_HANDOFF_AUTHORITY) {
    throw AppError.forbidden(
      'Controlled ward stock may move only through the governed ward-indent handoff',
      'WARD_INDENT_CONTROLLED_HANDOFF_AUTHORITY_REQUIRED',
    );
  }
  const exactClinicalOrderId = Number(clinicalOrderId);
  if (!Number.isSafeInteger(exactClinicalOrderId) || exactClinicalOrderId <= 0) {
    throw AppError.conflict(
      'Controlled ward dispensing requires an authoritative medication clinical order',
      'WARD_INDENT_CONTROLLED_CLINICAL_ORDER_REQUIRED',
    );
  }
  const clinicalRows = await tx.$queryRawUnsafe(
    `SELECT clinical_order.id, clinical_order.order_number, clinical_order.details,
            clinical_order.status, clinical_order.start_date, clinical_order.end_date,
            patient.uid AS patient_uid, patient.name AS patient_name, patient.phone AS patient_phone,
            prescriber.uid AS prescriber_uid, prescriber.role AS prescriber_role,
            COALESCE(NULLIF(BTRIM(prescriber_staff.name), ''), prescriber.name) AS prescriber_name,
            practitioner.registration_number AS prescriber_registration
       FROM clinical_orders clinical_order
       JOIN users patient
         ON patient.tenant_id=clinical_order.tenant_id
        AND patient.uid=clinical_order.patient_uid
        AND patient.role='PATIENT'
        AND patient.is_active=TRUE
        AND patient.status='active'
        AND patient.is_deleted=FALSE
        AND patient.merged_into_uid IS NULL
       JOIN users prescriber
         ON prescriber.tenant_id=clinical_order.tenant_id
        AND prescriber.uid=clinical_order.ordered_by
        AND prescriber.is_active=TRUE
        AND prescriber.status='active'
        AND prescriber.is_deleted=FALSE
       JOIN staff prescriber_staff
         ON prescriber_staff.tenant_id=prescriber.tenant_id
        AND prescriber_staff.user_id=prescriber.uid
        AND prescriber_staff.is_active=TRUE
        AND COALESCE(prescriber_staff.archived, FALSE)=FALSE
       LEFT JOIN LATERAL (
         SELECT mapping.registration_number
           FROM abdm_practitioner_mappings mapping
          WHERE mapping.tenant_id=clinical_order.tenant_id
            AND mapping.staff_uid=prescriber.uid
            AND mapping.status='verified'
          ORDER BY mapping.updated_at DESC, mapping.id DESC
          LIMIT 1
       ) practitioner ON TRUE
      WHERE clinical_order.tenant_id=$1::uuid
        AND clinical_order.id=$2::int
        AND clinical_order.patient_uid=$3::uuid
        AND clinical_order.order_type='medication'
        AND clinical_order.status IN ('ordered', 'verified', 'in_progress')
        AND (clinical_order.start_date IS NULL OR clinical_order.start_date<=NOW())
        AND (clinical_order.end_date IS NULL OR clinical_order.end_date>=NOW())
      FOR UPDATE OF clinical_order, patient, prescriber, prescriber_staff`,
    tenantId,
    exactClinicalOrderId,
    String(patientUid),
  );
  const clinical = clinicalRows[0];
  if (!clinical || !isDoctor(String(clinical.prescriber_role || '').toUpperCase())) {
    throw AppError.conflict(
      'Controlled ward dispensing requires an active authorized prescriber and clinical order',
      'WARD_INDENT_CONTROLLED_PRESCRIBER_AUTHORITY_INVALID',
    );
  }
  const signedCatalogId = wardClinicalCatalogId(clinical.details);
  if (signedCatalogId !== Number(catalogId)) {
    throw AppError.conflict(
      'Controlled ward catalog identity does not match the prescriber order',
      'WARD_INDENT_CONTROLLED_CATALOG_AUTHORITY_MISMATCH',
    );
  }
  const performer = await resolveControlledPerformerTx(tx, tenantId, performedBy);
  const items = await tx.$queryRawUnsafe(
    `SELECT item.id, item.catalog_id, item.schedule_class, item.is_narcotic, item.unit_label,
            item.facility_id
       FROM pharmacy_inventory_items item
       JOIN facilities facility
         ON facility.tenant_id=item.tenant_id
        AND facility.id=item.facility_id
        AND facility.status='active'
      WHERE item.tenant_id=$1::uuid
        AND item.id=$2::int
        AND item.catalog_id=$3::int
        AND item.facility_id=$4::int
        AND item.status='active'
      FOR UPDATE OF item, facility`,
    tenantId,
    Number(inventoryItemId),
    Number(catalogId),
    Number(facilityId),
  );
  const item = items[0];
  if (!item || (!['H', 'H1', 'X'].includes(item.schedule_class) && item.is_narcotic !== true)) {
    throw AppError.conflict(
      'Ward allocation is not an active controlled item in the pinned facility',
      'WARD_INDENT_CONTROLLED_INVENTORY_AUTHORITY_INVALID',
    );
  }
  const witnessPayload = wardControlledHandoffWitnessPayload({
    ward_indent_id: indentId,
    ward_indent_item_id: wardItemId,
    allocation_id: allocationId,
    inventory_item_id: inventoryItemId,
    inventory_batch_id: inventoryBatchId,
    quantity,
    patient_uid: patientUid,
    clinical_order_id: exactClinicalOrderId,
    catalog_id: catalogId,
    reference_id: referenceId,
  });
  const needsWitness = item.schedule_class === 'X' || item.is_narcotic === true;
  const witness = needsWitness
    ? await consumeControlledDispenseWitnessApproval({
      tx,
      tenantId,
      approvalId: witnessApprovalId,
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.wardIndent,
      payload: witnessPayload,
      requestedBy: performer.uid,
    })
    : null;
  await lockControlledRegisterItemTx(tx, tenantId, Number(inventoryItemId));
  const { movement } = await recordMovementTx(tx, {
    tenantId,
    inventory_item_id: Number(inventoryItemId),
    inventory_batch_id: Number(inventoryBatchId),
    movement_kind: 'issue',
    quantity: Number(quantity),
    reference_type: 'controlled_dispense',
    reference_id: String(referenceId),
    notes: `Controlled ward indent ${indentId} item ${wardItemId}`,
    performed_by: performer.uid,
    expected_facility_id: Number(facilityId),
    require_usable_batch: true,
    controlled_authority: CONTROLLED_MOVEMENT_AUTHORITY,
    metadata: {
      ward_indent_id: Number(indentId),
      ward_indent_item_id: Number(wardItemId),
      allocation_id: String(allocationId),
      clinical_order_id: exactClinicalOrderId,
      command_key: commandKey || null,
    },
  });
  const balance = await controlledCustodyBalanceTx(tx, {
    tenantId,
    facilityId: Number(facilityId),
    inventoryItemId: Number(inventoryItemId),
  });
  const registerRows = await tx.$queryRawUnsafe(
    `INSERT INTO pharmacy_schedule_register
       (tenant_id, facility_id, inventory_item_id, inventory_batch_id, schedule_class,
        movement_kind, quantity, unit_label, running_balance,
        patient_uid, patient_name, patient_phone,
        prescription_id, prescription_number,
        prescriber_uid, prescriber_name, prescriber_registration,
        performed_by, performed_by_name, witness_uid, witness_name,
        reference_movement_id, notes)
     VALUES ($1::uuid, $2::int, $3::int, $4::int, $5, 'dispense', $6::numeric,
             $7, $8::numeric, $9::uuid, $10, $11, NULL, $12, $13::uuid, $14,
             $15, $16::uuid, $17, $18::uuid, $19, $20::int, $21)
     RETURNING *`,
    tenantId,
    Number(facilityId),
    Number(inventoryItemId),
    Number(inventoryBatchId),
    canonicalControlledSchedule(item),
    Number(quantity),
    item.unit_label,
    balance,
    String(clinical.patient_uid),
    clinical.patient_name || null,
    clinical.patient_phone || null,
    clinical.order_number,
    String(clinical.prescriber_uid),
    clinical.prescriber_name || null,
    clinical.prescriber_registration || null,
    performer.uid,
    performer.name,
    witness?.uid || null,
    witness?.name || null,
    Number(movement.id),
    `Ward indent ${indentId}; clinical order ${exactClinicalOrderId}`,
  );
  return { movement, register_entry: registerRows[0], clinical_order: clinical };
}

export async function returnWardControlledAllocationTx(tx, {
  tenantId,
  facilityId,
  indentId,
  wardItemId,
  allocationId,
  inventoryItemId,
  inventoryBatchId,
  quantity,
  sourceRegisterId,
  returnedBy,
  commandKey = null,
  wardAuthority,
}) {
  if (wardAuthority !== WARD_INVENTORY_RETURN_AUTHORITY) {
    throw AppError.forbidden(
      'Controlled ward stock may return only through governed ward reconciliation',
      'WARD_INDENT_CONTROLLED_RETURN_AUTHORITY_REQUIRED',
    );
  }
  const authorityRows = await tx.$queryRawUnsafe(
    `SELECT source.id, source.schedule_class, source.unit_label,
            source.patient_uid, source.patient_name, source.patient_phone,
            source.prescription_id, source.prescription_number,
            source.prescriber_uid, source.prescriber_name, source.prescriber_registration,
            item.is_narcotic AS item_is_narcotic,
            actor.uid AS actor_uid,
            COALESCE(NULLIF(BTRIM(actor_staff.name), ''), actor.name) AS actor_name
       FROM pharmacy_schedule_register source
       JOIN pharmacy_inventory_items item
         ON item.tenant_id=source.tenant_id
        AND item.id=source.inventory_item_id
        AND item.facility_id=$5::int
        AND item.status='active'
       JOIN facilities facility
         ON facility.tenant_id=item.tenant_id
        AND facility.id=item.facility_id
        AND facility.status='active'
       JOIN users actor
         ON actor.tenant_id=source.tenant_id
        AND actor.uid=$6::uuid
        AND actor.is_active=TRUE
        AND actor.status='active'
        AND actor.is_deleted=FALSE
       JOIN staff actor_staff
         ON actor_staff.tenant_id=actor.tenant_id
        AND actor_staff.user_id=actor.uid
        AND actor_staff.is_active=TRUE
        AND COALESCE(actor_staff.archived, FALSE)=FALSE
      WHERE source.tenant_id=$1::uuid
        AND source.id=$2::int
        AND source.inventory_item_id=$3::int
        AND source.inventory_batch_id=$4::int
        AND source.facility_id=$5::int
        AND source.movement_kind='dispense'
      FOR UPDATE OF source, item, facility, actor, actor_staff`,
    tenantId,
    Number(sourceRegisterId),
    Number(inventoryItemId),
    Number(inventoryBatchId),
    Number(facilityId),
    String(returnedBy),
  );
  const authority = authorityRows[0];
  if (!authority) {
    throw AppError.conflict(
      'Controlled ward return is not bound to its original issue register and active actor',
      'WARD_INDENT_CONTROLLED_RETURN_LINEAGE_INVALID',
    );
  }
  await lockControlledRegisterItemTx(tx, tenantId, Number(inventoryItemId));
  const { movement } = await recordMovementTx(tx, {
    tenantId,
    inventory_item_id: Number(inventoryItemId),
    inventory_batch_id: Number(inventoryBatchId),
    movement_kind: 'return',
    quantity: Number(quantity),
    reference_type: 'ward_indent_return',
    reference_id: `ward-indent-return:${indentId}:item:${wardItemId}`,
    notes: `Controlled ward return indent ${indentId} item ${wardItemId}`,
    performed_by: String(authority.actor_uid),
    expected_facility_id: Number(facilityId),
    facility_authority: WARD_INVENTORY_RETURN_AUTHORITY,
    metadata: {
      ward_indent_id: Number(indentId),
      ward_indent_item_id: Number(wardItemId),
      allocation_id: String(allocationId),
      source_register_id: Number(sourceRegisterId),
      command_key: commandKey || null,
    },
  });
  const balance = await controlledCustodyBalanceTx(tx, {
    tenantId,
    facilityId: Number(facilityId),
    inventoryItemId: Number(inventoryItemId),
  });
  const registerRows = await tx.$queryRawUnsafe(
    `INSERT INTO pharmacy_schedule_register
       (tenant_id, facility_id, inventory_item_id, inventory_batch_id, schedule_class,
        movement_kind, quantity, unit_label, running_balance,
        patient_uid, patient_name, patient_phone,
        prescription_id, prescription_number,
        prescriber_uid, prescriber_name, prescriber_registration,
        performed_by, performed_by_name, reference_movement_id, notes)
     VALUES ($1::uuid, $2::int, $3::int, $4::int, $5, 'return', $6::numeric,
             $7, $8::numeric, $9::uuid, $10, $11, $12::int, $13, $14::uuid,
             $15, $16, $17::uuid, $18, $19::int, $20)
     RETURNING *`,
    tenantId,
    Number(facilityId),
    Number(inventoryItemId),
    Number(inventoryBatchId),
    canonicalControlledSchedule({
      schedule_class: authority.schedule_class,
      is_narcotic: authority.item_is_narcotic === true,
    }),
    Number(quantity),
    authority.unit_label,
    balance,
    authority.patient_uid || null,
    authority.patient_name || null,
    authority.patient_phone || null,
    authority.prescription_id == null ? null : Number(authority.prescription_id),
    authority.prescription_number || null,
    authority.prescriber_uid || null,
    authority.prescriber_name || null,
    authority.prescriber_registration || null,
    String(authority.actor_uid),
    authority.actor_name,
    Number(movement.id),
    `Ward indent ${indentId}; allocation ${allocationId}; source register ${sourceRegisterId}`,
  );
  return { movement, register_entry: registerRows[0] };
}

export async function dispenseControlled(params) {
  void params;
  throw new AppError(
    'Standalone controlled dispensing is retired; dispense through the verified pharmacy-order or governed counter-sale workflow',
    410,
    'INVENTORY_STANDALONE_CONTROLLED_DISPENSE_RETIRED',
  );
}

function normalizeScheduleRegisterClass(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !CONTROLLED_SCHEDULES.includes(value)) {
    throw AppError.badRequest(
      `schedule_class must be one of: ${CONTROLLED_SCHEDULES.join(', ')}`,
      'PHARMACY_SCHEDULE_REGISTER_FILTER_INVALID',
      { field: 'schedule_class' },
    );
  }
  return value;
}

function normalizeScheduleRegisterTimestamp(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || value.startsWith('0000-')) {
    throw AppError.badRequest(
      `${field} must be a canonical ISO-8601 UTC timestamp`,
      'PHARMACY_SCHEDULE_REGISTER_FILTER_INVALID',
      { field },
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw AppError.badRequest(
      `${field} must be a canonical ISO-8601 UTC timestamp`,
      'PHARMACY_SCHEDULE_REGISTER_FILTER_INVALID',
      { field },
    );
  }
  return value;
}

function scheduleRegisterRowConflict(field) {
  throw AppError.conflict(
    'Statutory schedule-register evidence is not safely serializable',
    'PHARMACY_SCHEDULE_REGISTER_ROW_INVALID',
    { field },
  );
}

function scheduleRegisterPublicId(value, field, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > PG_INT4_MAX) {
    scheduleRegisterRowConflict(field);
  }
  return normalized;
}

function scheduleRegisterPublicDecimal(value, field) {
  const normalized = Number(value);
  if (value == null || (typeof value === 'string' && value.trim() === '')
      || !Number.isFinite(normalized)) {
    scheduleRegisterRowConflict(field);
  }
  return normalized;
}

function scheduleRegisterPublicTimestamp(value, field) {
  if (!(value instanceof Date) && typeof value !== 'string') {
    scheduleRegisterRowConflict(field);
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) scheduleRegisterRowConflict(field);
  return parsed.toISOString();
}

function scheduleRegisterPublicDate(value, field) {
  if (value == null) return null;
  const date = value instanceof Date
    ? (Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10))
    : value;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    scheduleRegisterRowConflict(field);
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    scheduleRegisterRowConflict(field);
  }
  return date;
}

function scheduleRegisterTenantMatches(value, expected) {
  return typeof value === 'string'
    && value.toLowerCase() === String(expected).toLowerCase();
}

function assertScheduleRegisterItemEvidence(entry, {
  tenantId,
  facilityId,
  inventoryItemId,
}) {
  const currentItemId = scheduleRegisterPublicId(entry.current_item_id, 'current_item_id');
  const currentItemFacilityId = scheduleRegisterPublicId(
    entry.current_item_facility_id,
    'current_item_facility_id',
  );
  if (!scheduleRegisterTenantMatches(entry.current_item_tenant_id, tenantId)
      || currentItemId !== inventoryItemId
      || currentItemFacilityId !== facilityId) {
    scheduleRegisterRowConflict('inventory_item_authority');
  }
}

function assertScheduleRegisterBatchEvidence(entry, {
  tenantId,
  facilityId,
  inventoryItemId,
  inventoryBatchId,
}) {
  if (inventoryBatchId == null) return;
  const currentBatchId = scheduleRegisterPublicId(entry.current_batch_id, 'current_batch_id');
  const currentBatchItemId = scheduleRegisterPublicId(
    entry.current_batch_inventory_item_id,
    'current_batch_inventory_item_id',
  );
  const currentBatchFacilityId = scheduleRegisterPublicId(
    entry.current_batch_facility_id,
    'current_batch_facility_id',
  );
  if (!scheduleRegisterTenantMatches(entry.current_batch_tenant_id, tenantId)
      || currentBatchId !== inventoryBatchId
      || currentBatchItemId !== inventoryItemId
      || currentBatchFacilityId !== facilityId) {
    scheduleRegisterRowConflict('inventory_batch_authority');
  }
}

function serializeScheduleRegisterEntry(entry, { tenantId, facilityId: expectedFacilityId }) {
  if (!scheduleRegisterTenantMatches(entry.tenant_id, tenantId)) {
    scheduleRegisterRowConflict('tenant_id');
  }
  const facilityId = scheduleRegisterPublicId(entry.facility_id, 'facility_id');
  if (facilityId !== expectedFacilityId) scheduleRegisterRowConflict('facility_id');
  const inventoryItemId = scheduleRegisterPublicId(
    entry.inventory_item_id,
    'inventory_item_id',
  );
  const inventoryBatchId = scheduleRegisterPublicId(
    entry.inventory_batch_id,
    'inventory_batch_id',
    { nullable: true },
  );
  assertScheduleRegisterItemEvidence(entry, {
    tenantId,
    facilityId,
    inventoryItemId,
  });
  assertScheduleRegisterBatchEvidence(entry, {
    tenantId,
    facilityId,
    inventoryItemId,
    inventoryBatchId,
  });
  return {
    id: scheduleRegisterPublicId(entry.id, 'id'),
    facility_id: facilityId,
    inventory_item_id: inventoryItemId,
    inventory_batch_id: inventoryBatchId,
    created_at: scheduleRegisterPublicTimestamp(entry.created_at, 'created_at'),
    schedule_class: entry.schedule_class,
    movement_kind: entry.movement_kind,
    sku_code: entry.sku_code,
    display_name: entry.display_name,
    generic_name: entry.generic_name ?? null,
    brand_name: entry.brand_name ?? null,
    strength: entry.strength ?? null,
    form: entry.form ?? null,
    batch_number: entry.batch_number ?? null,
    expiry_date: scheduleRegisterPublicDate(entry.expiry_date, 'expiry_date'),
    quantity: scheduleRegisterPublicDecimal(entry.quantity, 'quantity'),
    unit_label: entry.unit_label ?? null,
    running_balance: scheduleRegisterPublicDecimal(entry.running_balance, 'running_balance'),
    patient_uid: entry.patient_uid ?? null,
    patient_name: entry.patient_name ?? null,
    patient_phone: entry.patient_phone ?? null,
    prescription_id: scheduleRegisterPublicId(
      entry.prescription_id,
      'prescription_id',
      { nullable: true },
    ),
    prescription_number: entry.prescription_number ?? null,
    prescriber_uid: entry.prescriber_uid ?? null,
    prescriber_name: entry.prescriber_name ?? null,
    prescriber_registration: entry.prescriber_registration ?? null,
    patient_id_proof_type: entry.patient_id_proof_type ?? null,
    patient_id_proof_last4: entry.patient_id_proof_last4 ?? null,
    performed_by: entry.performed_by,
    performed_by_name: entry.performed_by_name ?? null,
    witness_uid: entry.witness_uid ?? null,
    witness_name: entry.witness_name ?? null,
    reference_movement_id: scheduleRegisterPublicId(
      entry.reference_movement_id,
      'reference_movement_id',
      { nullable: true },
    ),
    notes: entry.notes ?? null,
  };
}

export async function listScheduleRegister({
  tenantId, actorUid, actorRole, facility_id,
  schedule_class, item_id, date_from, date_to, limit = 200,
}) {
  const tid = requireTenantId(tenantId);
  const facilityId = Number(facility_id);
  if (!Number.isSafeInteger(facilityId) || facilityId <= 0 || facilityId > PG_INT4_MAX) {
    throw AppError.badRequest(
      'facility_id must be a positive PostgreSQL integer',
      'PHARMACY_FACILITY_REQUIRED',
    );
  }
  const scheduleClass = normalizeScheduleRegisterClass(schedule_class);
  const dateFrom = normalizeScheduleRegisterTimestamp(date_from, 'date_from');
  const dateTo = normalizeScheduleRegisterTimestamp(date_to, 'date_to');
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw AppError.badRequest(
      'date_from must be earlier than or equal to date_to',
      'PHARMACY_SCHEDULE_REGISTER_FILTER_INVALID',
      { field: 'date_range' },
    );
  }
  const params = [tid, facilityId];
  const where = [
    'register.tenant_id = $1::uuid',
    'register.facility_id = $2::int',
  ];
  if (scheduleClass) {
    params.push(scheduleClass);
    where.push(`register.schedule_class = $${params.length}`);
  }
  if (item_id != null) {
    const itemId = Number(item_id);
    if (!Number.isSafeInteger(itemId) || itemId <= 0 || itemId > PG_INT4_MAX) {
      throw AppError.badRequest(
        'item_id must be a positive PostgreSQL integer',
        'PHARMACY_SCHEDULE_REGISTER_FILTER_INVALID',
        { field: 'item_id' },
      );
    }
    params.push(itemId);
    where.push(`register.inventory_item_id = $${params.length}::int`);
  }
  if (dateFrom) { params.push(dateFrom); where.push(`register.created_at >= $${params.length}::timestamptz`); }
  if (dateTo) { params.push(dateTo); where.push(`register.created_at <= $${params.length}::timestamptz`); }
  params.push(boundedInteger(limit, { fallback: 200, min: 1, max: 500 }));
  return setTenantTx(tid, async (tx) => {
    await assertPharmacyFacilityGrant(tx, {
      tenantId: tid,
      facilityId,
      actorUid,
      actorRole,
    });
    const rows = await tx.$queryRawUnsafe(
      `SELECT register.id,
              register.tenant_id,
              register.facility_id,
              register.inventory_item_id,
              register.inventory_batch_id,
              register.created_at,
              register.schedule_class,
              register.movement_kind,
              item.id AS current_item_id,
              item.tenant_id AS current_item_tenant_id,
              item.facility_id AS current_item_facility_id,
              item.sku_code,
              item.display_name,
              item.generic_name,
              item.brand_name,
              item.strength,
              item.form,
              batch.id AS current_batch_id,
              batch.tenant_id AS current_batch_tenant_id,
              batch.inventory_item_id AS current_batch_inventory_item_id,
              batch.facility_id AS current_batch_facility_id,
              batch.batch_number,
              batch.expiry_date,
              register.quantity,
              register.unit_label,
              register.running_balance,
              register.patient_uid,
              register.patient_name,
              register.patient_phone,
              register.prescription_id,
              register.prescription_number,
              register.prescriber_uid,
              register.prescriber_name,
              register.prescriber_registration,
              register.patient_id_proof_type,
              register.patient_id_proof_last4,
              register.performed_by,
              register.performed_by_name,
              register.witness_uid,
              register.witness_name,
              register.reference_movement_id,
              register.notes
         FROM pharmacy_schedule_register register
         LEFT JOIN pharmacy_inventory_items item
           ON item.tenant_id=register.tenant_id
          AND item.id=register.inventory_item_id
          AND item.facility_id=register.facility_id
         LEFT JOIN pharmacy_inventory_batches batch
           ON batch.tenant_id=register.tenant_id
          AND batch.id=register.inventory_batch_id
          AND batch.inventory_item_id=register.inventory_item_id
          AND batch.facility_id=register.facility_id
        WHERE ${where.join(' AND ')}
        ORDER BY register.created_at DESC, register.id DESC
        LIMIT $${params.length}::int`,
      ...params,
    );
    return rows.map((row) => serializeScheduleRegisterEntry(row, {
      tenantId: tid,
      facilityId,
    }));
  });
}

export async function listAuthorityRecovery({
  tenantId,
  status = 'OPEN',
  entityType = null,
  facilityId = null,
  actorUid,
  actorRole,
  limit = 100,
}) {
  const tid = requireTenantId(tenantId);
  const normalizedStatus = String(status || 'OPEN').trim().toUpperCase();
  if (!['OPEN', 'RESOLVED'].includes(normalizedStatus)) {
    throw AppError.badRequest('status must be OPEN or RESOLVED', 'PHARMACY_RECOVERY_STATUS_INVALID');
  }
  const fid = facilityId == null || facilityId === ''
    ? null
    : recoveryPositiveId(facilityId, 'facility_id');
  const params = [tid, normalizedStatus];
  const where = ['tenant_id=$1::uuid', 'status=$2'];
  if (entityType) {
    params.push(String(entityType).trim());
    where.push(`entity_type=$${params.length}`);
  }
  if (fid != null) {
    params.push(fid);
    where.push(`facility_id=$${params.length}::int`);
  } else {
    where.push('facility_id IS NULL');
  }
  params.push(boundedInteger(limit, { fallback: 100, min: 1, max: 200 }));
  return setTenantTx(tid, async (tx) => {
    if (fid != null) {
      await assertPharmacyFacilityGrant(tx, {
        tenantId: tid,
        facilityId: fid,
        actorUid,
        actorRole,
      });
    } else {
      await lockRecoveryTenantAdminTx(tx, tid, actorUid, actorRole);
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT recovery.id, recovery.entity_type, recovery.entity_id,
              recovery.inventory_item_id, recovery.facility_id, recovery.catalog_id,
              recovery.reason_code, recovery.authority_snapshot, recovery.status,
              recovery.resolved_by, recovery.resolved_at, recovery.resolution_note,
              recovery.created_at, recovery.updated_at,
              COALESCE((
                SELECT jsonb_agg(to_jsonb(event) ORDER BY event.id)
                  FROM pharmacy_inventory_authority_recovery_events event
                 WHERE event.tenant_id=recovery.tenant_id
                   AND event.recovery_id=recovery.id
              ), '[]'::jsonb) AS events
         FROM pharmacy_inventory_authority_recovery_worklist recovery
        WHERE ${where.join(' AND ')}
        ORDER BY recovery.created_at, recovery.id
        LIMIT $${params.length}::int`,
      ...params,
    );
    return { recovery_items: rows, count: rows.length };
  });
}

export async function listWardAllocationAuthorityRecovery({
  tenantId,
  facilityId = null,
  actorUid,
  actorRole,
  status = 'OPEN',
  limit = 100,
}) {
  const tid = requireTenantId(tenantId);
  const fid = facilityId == null || facilityId === ''
    ? null
    : recoveryPositiveId(facilityId, 'facility_id');
  const normalizedStatus = String(status || 'OPEN').trim().toUpperCase();
  if (!['OPEN', 'RESOLVED'].includes(normalizedStatus)) {
    throw AppError.badRequest(
      'status must be OPEN or RESOLVED',
      'PHARMACY_RECOVERY_STATUS_INVALID',
    );
  }
  return setTenantTx(tid, async (tx) => {
    if (fid == null) {
      await lockRecoveryTenantAdminTx(tx, tid, actorUid, actorRole);
    } else {
      await assertPharmacyFacilityGrant(tx, {
        tenantId: tid,
        facilityId: fid,
        actorUid,
        actorRole,
      });
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT recovery.id, recovery.allocation_id, recovery.ward_indent_id,
              recovery.ward_indent_item_id, recovery.inventory_item_id,
              recovery.inventory_batch_id, recovery.facility_id, recovery.catalog_id,
              recovery.reason_code, recovery.authority_snapshot, recovery.status,
              recovery.resolved_by, recovery.resolved_at, recovery.resolution_note,
              recovery.created_at, recovery.updated_at,
              COALESCE((
                SELECT jsonb_agg(to_jsonb(event) ORDER BY event.id)
                  FROM pharmacy_ward_allocation_authority_recovery_events event
                 WHERE event.tenant_id=recovery.tenant_id
                   AND event.recovery_id=recovery.id
              ), '[]'::jsonb) AS events
         FROM pharmacy_ward_allocation_authority_recovery recovery
        WHERE recovery.tenant_id=$1::uuid
          AND ($2::int IS NULL OR recovery.facility_id=$2::int)
          AND recovery.status=$3
        ORDER BY recovery.created_at, recovery.id
        LIMIT $4::int`,
      tid,
      fid,
      normalizedStatus,
      boundedInteger(limit, { fallback: 100, min: 1, max: 200 }),
    );
    return { recovery_items: rows, count: rows.length };
  });
}

async function lockRecoveryActorTx(tx, tenantId, actorUid) {
  const uid = String(actorUid || '').trim();
  if (!UUID_RE.test(uid)) {
    throw AppError.forbidden(
      'An authenticated tenant recovery actor is required',
      'PHARMACY_RECOVERY_ACTOR_REQUIRED',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid
       FROM users
      WHERE tenant_id=$1::uuid AND uid=$2::uuid
        AND is_active=TRUE AND status='active'
        AND is_deleted=FALSE AND merged_into_uid IS NULL
      FOR KEY SHARE`,
    tenantId,
    uid,
  );
  if (!rows.length) {
    throw AppError.forbidden(
      'The recovery actor is not an active tenant identity',
      'PHARMACY_RECOVERY_ACTOR_REQUIRED',
    );
  }
  return uid;
}

async function lockRecoveryTenantAdminTx(tx, tenantId, actorUid, actorRole) {
  const uid = String(actorUid || '').trim();
  if (!UUID_RE.test(uid)) {
    throw AppError.forbidden(
      'An authenticated tenant administrator is required',
      'PHARMACY_RECOVERY_TENANT_ADMIN_REQUIRED',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid, role
       FROM users
      WHERE tenant_id=$1::uuid AND uid=$2::uuid
        AND is_active=TRUE AND status='active'
        AND is_deleted=FALSE AND merged_into_uid IS NULL
      FOR KEY SHARE`,
    tenantId,
    uid,
  );
  const role = String(rows[0]?.role || '').trim().toUpperCase();
  if (!rows.length || !['ADMIN', 'SUPER_ADMIN'].includes(role)
      || role !== String(actorRole || '').trim().toUpperCase()) {
    throw AppError.forbidden(
      'Current tenant administrator authority is required for unassigned recovery',
      'PHARMACY_RECOVERY_TENANT_ADMIN_REQUIRED',
    );
  }
  return uid;
}

function recoveryPositiveId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw AppError.badRequest(`${field} must be a positive integer`, 'PHARMACY_RECOVERY_INPUT_INVALID');
  }
  return id;
}

function recoveryBigIntId(value, field) {
  const normalized = String(value ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw AppError.badRequest(
      `${field} must be a positive integer`,
      'PHARMACY_RECOVERY_INPUT_INVALID',
    );
  }
  return normalized;
}

function normalizeRecoveryJson(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeRecoveryJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => (
      [key, normalizeRecoveryJson(value[key])]
    )));
  }
  return value;
}

function recoveryCommandEvidence({ commandKey, requestFingerprint, resolution, note }) {
  const key = String(commandKey || '').trim();
  const requestSha256 = String(requestFingerprint || '').trim().toLowerCase();
  if (!key || !/^[0-9a-f]{64}$/.test(requestSha256)) {
    throw AppError.badRequest(
      'A durable Idempotency-Key and request fingerprint are required for recovery',
      'PHARMACY_RECOVERY_COMMAND_EVIDENCE_REQUIRED',
    );
  }
  const normalizedResolution = normalizeRecoveryJson(resolution || {});
  return {
    commandKeySha256: createHash('sha256').update(key).digest('hex'),
    requestSha256,
    requestPayload: normalizeRecoveryJson({
      resolution: normalizedResolution,
      resolution_note: String(note || '').trim(),
    }),
    resolutionPayload: normalizedResolution,
  };
}

const RECOVERY_TARGET_TABLES = Object.freeze({
  inventory_item: 'pharmacy_inventory_items',
  inventory_batch: 'pharmacy_inventory_batches',
  purchase_order: 'pharmacy_purchase_orders',
  purchase_order_item: 'pharmacy_purchase_order_items',
  goods_receipt: 'pharmacy_goods_receipts',
  goods_receipt_item: 'pharmacy_goods_receipt_items',
  pharmacy_order: 'pharmacy_orders',
  e_prescription: 'e_prescriptions',
  ward_indent: 'ward_indents',
  // Migration 753 paused every facility-less supplier and filed a
  // SUPPLIER_FACILITY_AUTHORITY_UNRESOLVED worklist row for it. Without this
  // registration lockRecoveryTargetSnapshotTx refuses the class outright and the
  // rows can never be closed by any resolver.
  supplier: 'pharmacy_suppliers',
});

async function lockRecoveryTargetSnapshotTx(tx, tenantId, recovery) {
  const table = RECOVERY_TARGET_TABLES[recovery.entity_type];
  if (!table) {
    throw AppError.conflict(
      'This authority class requires its dedicated governed recovery operation',
      'PHARMACY_RECOVERY_DEDICATED_WORKFLOW_REQUIRED',
      { entity_type: recovery.entity_type, reason_code: recovery.reason_code },
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT to_jsonb(target) AS snapshot
       FROM ${table} target
      WHERE target.tenant_id=$1::uuid AND target.id=$2::bigint
      FOR UPDATE`,
    tenantId,
    String(recovery.entity_id),
  );
  if (!rows[0]?.snapshot) {
    throw AppError.conflict(
      'The recovery target no longer exists',
      'PHARMACY_RECOVERY_TARGET_MISSING',
    );
  }
  return normalizeRecoveryJson(rows[0].snapshot);
}

async function setRecoveryEventEvidenceTx(tx, {
  actorUid,
  requestId,
  command,
  targetIdentity,
  targetBefore,
  targetAfter,
}) {
  await tx.$queryRawUnsafe(
    `SELECT
       set_config('app.pharmacy_recovery_actor_uid', $1, TRUE) AS actor_uid,
       set_config('app.pharmacy_recovery_request_id', $2, TRUE) AS request_id,
       set_config('app.pharmacy_recovery_command_key_sha256', $3, TRUE) AS command_sha,
       set_config('app.pharmacy_recovery_request_sha256', $4, TRUE) AS request_sha,
       set_config('app.pharmacy_recovery_request_payload', $5, TRUE) AS request_payload,
       set_config('app.pharmacy_recovery_resolution_payload', $6, TRUE) AS resolution_payload,
       set_config('app.pharmacy_recovery_target_identity', $7, TRUE) AS target_identity,
       set_config('app.pharmacy_recovery_target_before', $8, TRUE) AS target_before,
       set_config('app.pharmacy_recovery_target_after', $9, TRUE) AS target_after`,
    actorUid,
    String(requestId || '').slice(0, 200),
    command.commandKeySha256,
    command.requestSha256,
    JSON.stringify(command.requestPayload),
    JSON.stringify(command.resolutionPayload),
    JSON.stringify(normalizeRecoveryJson(targetIdentity)),
    JSON.stringify(normalizeRecoveryJson(targetBefore)),
    JSON.stringify(normalizeRecoveryJson(targetAfter)),
  );
}

async function lockFacilityCatalogTx(tx, tenantId, facilityId, catalogId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT facility.id AS facility_id, catalog.id AS catalog_id
       FROM facilities facility
       JOIN pharmacy_catalog catalog
         ON catalog.tenant_id=facility.tenant_id
        AND catalog.id=$3::int
        AND catalog.is_active=TRUE
      WHERE facility.tenant_id=$1::uuid
        AND facility.id=$2::int
        AND facility.status='active'
      FOR UPDATE OF facility, catalog`,
    tenantId,
    facilityId,
    catalogId,
  );
  if (!rows.length) {
    throw AppError.conflict(
      'Recovery requires an active same-tenant facility and catalog identity',
      'PHARMACY_RECOVERY_AUTHORITY_INVALID',
    );
  }
}

async function resolveInventoryRecoveryTx(tx, { tenantId, recovery, resolution }) {
  if (recovery.reason_code === 'DEFAULT_SUPPLIER_TENANT_MISMATCH') {
    if (recovery.entity_type !== 'inventory_item') {
      throw AppError.conflict('Supplier recovery target is invalid', 'PHARMACY_RECOVERY_AUTHORITY_INVALID');
    }
    const supplierId = recoveryPositiveId(resolution.default_supplier_id, 'default_supplier_id');
    const authority = await tx.$queryRawUnsafe(
      `SELECT item.id
         FROM pharmacy_inventory_items item
         JOIN pharmacy_suppliers supplier
           ON supplier.tenant_id=item.tenant_id AND supplier.id=$3::int
          AND supplier.status='active'
          AND supplier.facility_id=item.facility_id
        WHERE item.tenant_id=$1::uuid AND item.id=$2::int
        FOR UPDATE OF item, supplier`,
      tenantId,
      Number(recovery.entity_id),
      supplierId,
    );
    if (!authority.length) {
      throw AppError.conflict('Default supplier recovery authority is invalid', 'PHARMACY_RECOVERY_AUTHORITY_INVALID');
    }
    const updated = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_inventory_items
          SET default_supplier_id=$3::int,
              metadata=COALESCE(metadata, '{}'::jsonb)-'supplier_authority_recovery_required',
              updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int
        RETURNING id`,
      tenantId,
      Number(recovery.entity_id),
      supplierId,
    );
    if (!updated.length) throw AppError.conflict('Supplier recovery target changed', 'PHARMACY_RECOVERY_TARGET_MISSING');
    return;
  }
  if (recovery.reason_code === 'BATCH_SUPPLIER_TENANT_MISMATCH') {
    if (recovery.entity_type !== 'inventory_batch') {
      throw AppError.conflict('Batch supplier recovery target is invalid', 'PHARMACY_RECOVERY_AUTHORITY_INVALID');
    }
    const supplierId = recoveryPositiveId(resolution.supplier_id, 'supplier_id');
    const authority = await tx.$queryRawUnsafe(
      `SELECT batch.id
         FROM pharmacy_inventory_batches batch
         JOIN pharmacy_suppliers supplier
           ON supplier.tenant_id=batch.tenant_id AND supplier.id=$3::int
          AND supplier.status='active'
          AND supplier.facility_id=batch.facility_id
         LEFT JOIN pharmacy_goods_receipts grn
           ON grn.tenant_id=batch.tenant_id AND grn.id=batch.goods_receipt_id
        WHERE batch.tenant_id=$1::uuid AND batch.id=$2::int
          AND (batch.goods_receipt_id IS NULL OR grn.supplier_id=$3::int)
        FOR UPDATE OF batch, supplier, grn`,
      tenantId,
      Number(recovery.entity_id),
      supplierId,
    );
    if (!authority.length) {
      throw AppError.conflict('Batch supplier must match its active tenant supplier and linked GRN', 'PHARMACY_RECOVERY_AUTHORITY_INVALID');
    }
    const updated = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_inventory_batches
          SET supplier_id=$3::int,
              metadata=COALESCE(metadata, '{}'::jsonb)-'supplier_authority_recovery_required',
              updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int
        RETURNING id`,
      tenantId,
      Number(recovery.entity_id),
      supplierId,
    );
    if (!updated.length) throw AppError.conflict('Batch supplier recovery target changed', 'PHARMACY_RECOVERY_TARGET_MISSING');
    return;
  }
  if (recovery.reason_code === 'BATCH_ITEM_AUTHORITY_MISMATCH') {
    if (recovery.entity_type !== 'inventory_batch') {
      throw AppError.conflict('Batch item recovery target is invalid', 'PHARMACY_RECOVERY_AUTHORITY_INVALID');
    }
    const inventoryItemId = recoveryPositiveId(resolution.inventory_item_id, 'inventory_item_id');
    const authority = await tx.$queryRawUnsafe(
      `SELECT batch.id, item.facility_id, item.catalog_id, batch.status, batch.metadata,
              batch.remaining_quantity, batch.expiry_date
         FROM pharmacy_inventory_batches batch
         JOIN pharmacy_inventory_items item
           ON item.tenant_id=batch.tenant_id AND item.id=$3::int AND item.status='active'
         JOIN facilities facility
           ON facility.tenant_id=item.tenant_id AND facility.id=item.facility_id
          AND facility.status='active'
         JOIN pharmacy_catalog catalog
           ON catalog.tenant_id=item.tenant_id AND catalog.id=item.catalog_id
          AND catalog.is_active=TRUE
         LEFT JOIN pharmacy_goods_receipts grn
           ON grn.tenant_id=batch.tenant_id AND grn.id=batch.goods_receipt_id
        WHERE batch.tenant_id=$1::uuid AND batch.id=$2::int
          AND (batch.goods_receipt_id IS NULL OR grn.facility_id=item.facility_id)
          AND NOT EXISTS (
            SELECT 1 FROM pharmacy_goods_receipt_items line
             WHERE line.tenant_id=batch.tenant_id
               AND line.inventory_batch_id=batch.id
               AND line.inventory_item_id IS DISTINCT FROM item.id
          )
        FOR UPDATE OF batch, item, facility, catalog, grn`,
      tenantId,
      Number(recovery.entity_id),
      inventoryItemId,
    );
    if (!authority.length) {
      throw AppError.conflict('Batch item recovery requires an exact active item, facility, catalog, and GRN lineage', 'PHARMACY_RECOVERY_AUTHORITY_INVALID');
    }
    const canUnquarantine = authority[0].status === 'quarantined'
      && authority[0].metadata?.inventory_authority_quarantined_by === 'migration_753';
    const updated = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_inventory_batches
          SET inventory_item_id=$3::int, facility_id=$4::int,
              status=CASE
                WHEN status<>'quarantined' OR $5::boolean=FALSE THEN status
                WHEN remaining_quantity<=0 THEN 'depleted'
                WHEN expiry_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date THEN 'expired'
                ELSE 'in_stock'
              END,
              metadata=COALESCE(metadata, '{}'::jsonb)
                -'inventory_authority_recovery_required'
                -'inventory_authority_quarantined_by',
              updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int
        RETURNING id, status`,
      tenantId,
      Number(recovery.entity_id),
      inventoryItemId,
      Number(authority[0].facility_id),
      canUnquarantine,
    );
    if (!updated.length || (canUnquarantine && updated[0].status === 'quarantined')) {
      throw AppError.conflict('Batch item recovery did not restore usable authority', 'PHARMACY_RECOVERY_AUTHORITY_INVALID');
    }
    return;
  }
  const facilityId = recoveryPositiveId(resolution.facility_id, 'facility_id');
  const catalogId = recoveryPositiveId(resolution.catalog_id, 'catalog_id');
  await lockFacilityCatalogTx(tx, tenantId, facilityId, catalogId);
  const itemId = recovery.entity_type === 'inventory_item'
    ? Number(recovery.entity_id)
    : Number(recovery.inventory_item_id);
  const items = await tx.$queryRawUnsafe(
    `SELECT id, facility_id, catalog_id, status, metadata
       FROM pharmacy_inventory_items
      WHERE tenant_id=$1::uuid AND id=$2::int
      FOR UPDATE`,
    tenantId,
    itemId,
  );
  if (!items.length) throw AppError.notFound('Recovery inventory item not found');
  if (recovery.entity_type === 'inventory_batch'
    && (Number(items[0].facility_id) !== facilityId
      || Number(items[0].catalog_id) !== catalogId)) {
    throw AppError.conflict(
      'Batch recovery must use the inventory item current facility and catalog authority',
      'PHARMACY_RECOVERY_AUTHORITY_INVALID',
    );
  }
  if (recovery.entity_type === 'inventory_item') {
    const recoveryMarker = items[0].metadata?.inventory_authority_quarantined_by;
    if (items[0].status === 'paused'
      && !['migration_753', 'catalog_deactivation'].includes(recoveryMarker)) {
      throw AppError.conflict(
        'Only an inventory-authority pause can be cleared by this resolver',
        'PHARMACY_RECOVERY_AUTHORITY_INVALID',
      );
    }
    await tx.$executeRawUnsafe(
      `UPDATE pharmacy_inventory_items
          SET facility_id=$3::int, catalog_id=$4::int,
              status=CASE
                WHEN status='paused'
                  AND metadata->>'inventory_authority_quarantined_by'
                    IN ('migration_753', 'catalog_deactivation')
                  THEN 'active'
                ELSE status
              END,
              metadata=(COALESCE(metadata, '{}'::jsonb)
                - 'inventory_authority_recovery_required'
                - 'inventory_authority_quarantined_by'),
              updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int`,
      tenantId,
      itemId,
      facilityId,
      catalogId,
    );
  } else {
    const batches = await tx.$queryRawUnsafe(
      `SELECT batch.id, batch.status, batch.supplier_id, batch.goods_receipt_id,
              batch.metadata, grn.id AS grn_id, grn.facility_id AS grn_facility_id,
              grn.supplier_id AS grn_supplier_id
         FROM pharmacy_inventory_batches batch
         LEFT JOIN pharmacy_goods_receipts grn
           ON grn.tenant_id=batch.tenant_id AND grn.id=batch.goods_receipt_id
        WHERE batch.tenant_id=$1::uuid AND batch.id=$2::int
          AND batch.inventory_item_id=$3::int
        FOR UPDATE OF batch`,
      tenantId,
      Number(recovery.entity_id),
      itemId,
    );
    if (!batches.length
      || (batches[0].goods_receipt_id != null && (
        !batches[0].grn_id
        || Number(batches[0].grn_facility_id) !== facilityId
        || (batches[0].supplier_id != null
          && Number(batches[0].grn_supplier_id) !== Number(batches[0].supplier_id))
      ))) {
      throw AppError.conflict(
        'Batch recovery requires exact item, GRN, facility, and supplier lineage',
        'PHARMACY_RECOVERY_AUTHORITY_INVALID',
      );
    }
    const canUnquarantine = batches[0].status === 'quarantined'
      && ['migration_753', 'catalog_deactivation'].includes(
        batches[0].metadata?.inventory_authority_quarantined_by,
      );
    if (batches[0].status === 'quarantined' && !canUnquarantine) {
      throw AppError.conflict(
        'Only migration-753 authority quarantine can be cleared by this resolver',
        'PHARMACY_RECOVERY_AUTHORITY_INVALID',
      );
    }
    const updated = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_inventory_batches
          SET facility_id=$3::int,
              status=CASE
                WHEN status<>'quarantined' THEN status
                WHEN $5::boolean=FALSE THEN status
                WHEN remaining_quantity<=0 THEN 'depleted'
                WHEN expiry_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date THEN 'expired'
                ELSE 'in_stock'
              END,
              metadata=(COALESCE(metadata, '{}'::jsonb)
                - 'inventory_authority_recovery_required'
                - 'inventory_authority_quarantined_by'),
              updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int AND inventory_item_id=$4::int
        RETURNING id, status`,
      tenantId,
      Number(recovery.entity_id),
      facilityId,
      itemId,
      canUnquarantine,
    );
    if (!updated.length || (updated[0].status === 'quarantined' && canUnquarantine)) {
      throw AppError.conflict(
        'Batch quarantine cannot be cleared by this authority recovery',
        'PHARMACY_RECOVERY_AUTHORITY_INVALID',
      );
    }
  }
  const unresolved = await tx.$queryRawUnsafe(
    `SELECT item.id
       FROM pharmacy_inventory_items item
      WHERE item.tenant_id=$1::uuid AND item.id=$2::int
        AND (item.facility_id IS DISTINCT FROM $3::int
          OR item.catalog_id IS DISTINCT FROM $4::int)
      LIMIT 1`,
    tenantId,
    itemId,
    facilityId,
    catalogId,
  );
  if (unresolved.length) {
    throw AppError.conflict(
      'Inventory authority remains inconsistent after the proposed repair',
      'PHARMACY_RECOVERY_AUTHORITY_INVALID',
    );
  }
}

// Every table migration 753 derived supplier facility candidates from. The
// resolver validates the operator's chosen facility against exactly this set so
// a resolution can never invent a facility the supplier has no lineage in.
const SUPPLIER_FACILITY_LINEAGE_SOURCES = Object.freeze([
  { table: 'pharmacy_inventory_items', column: 'default_supplier_id' },
  { table: 'pharmacy_inventory_batches', column: 'supplier_id' },
  { table: 'pharmacy_purchase_orders', column: 'supplier_id' },
  { table: 'pharmacy_goods_receipts', column: 'supplier_id' },
]);

// SUPPLIER_FACILITY_AUTHORITY_UNRESOLVED (migration 753): the supplier is paused
// and carries no facility authority. The operator names one facility; this
// resolver proves it against the tenant's active facilities AND against the
// supplier's own supply lineage before writing it. It is the only writer the
// trg_pharmacy_supplier_rehome_supply_753 trigger will admit, which is why the
// worklist snapshot must carry target_facility_id and the recovery id must be
// published on app.pharmacy_authority_recovery_id before the UPDATE.
async function resolveSupplierFacilityRecoveryTx(tx, { tenantId, recovery, resolution }) {
  if (recovery.reason_code !== 'SUPPLIER_FACILITY_AUTHORITY_UNRESOLVED') {
    throw AppError.conflict(
      'The supplier recovery class is unsupported',
      'PHARMACY_RECOVERY_DEDICATED_WORKFLOW_REQUIRED',
      { entity_type: recovery.entity_type, reason_code: recovery.reason_code },
    );
  }
  if (String(resolution.action || '').trim().toUpperCase() !== 'ASSIGN_EXACT_FACILITY') {
    throw AppError.badRequest(
      'Supplier facility recovery requires action ASSIGN_EXACT_FACILITY',
      'PHARMACY_RECOVERY_INPUT_INVALID',
    );
  }
  const facilityId = recoveryPositiveId(resolution.facility_id, 'facility_id');
  const suppliers = await tx.$queryRawUnsafe(
    `SELECT id, facility_id, status, metadata
       FROM pharmacy_suppliers
      WHERE tenant_id=$1::uuid AND id=$2::int
      FOR UPDATE`,
    tenantId,
    Number(recovery.entity_id),
  );
  if (!suppliers[0] || suppliers[0].facility_id != null) {
    throw AppError.conflict(
      'Supplier facility authority changed before recovery',
      'PHARMACY_RECOVERY_STATE_CHANGED',
    );
  }
  const facilities = await tx.$queryRawUnsafe(
    `SELECT id FROM facilities
      WHERE tenant_id=$1::uuid AND id=$2::int AND status='active'
      FOR UPDATE`,
    tenantId,
    facilityId,
  );
  if (!facilities[0]) {
    throw AppError.conflict(
      'Selected supplier facility is not an active tenant facility',
      'PHARMACY_RECOVERY_AUTHORITY_INVALID',
    );
  }
  const lineageFacilities = new Set();
  for (const source of SUPPLIER_FACILITY_LINEAGE_SOURCES) {
    const rows = await tx.$queryRawUnsafe(
      // No DISTINCT: Postgres rejects SELECT DISTINCT under FOR KEY SHARE, and the
      // lock over every lineage row is the point — it is what keeps a concurrent
      // insert from widening the supplier scope after this check passes.
      `SELECT lineage.id, lineage.facility_id
         FROM ${source.table} lineage
        WHERE lineage.tenant_id=$1::uuid AND lineage.${source.column}=$2::int
        ORDER BY lineage.id
        FOR KEY SHARE`,
      tenantId,
      Number(recovery.entity_id),
    );
    for (const row of rows) {
      // A lineage row with no facility of its own is itself unresolved authority;
      // it cannot vouch for the operator's choice, so it fails the class closed
      // and must be repaired through its own worklist row first.
      if (row.facility_id == null) {
        throw AppError.conflict(
          'Supplier lineage still spans unresolved facility authority and must be repaired first',
          'PHARMACY_RECOVERY_DEPENDENCY_OPEN',
          { lineage_table: source.table },
        );
      }
      lineageFacilities.add(Number(row.facility_id));
    }
  }
  // A supplier with lineage may only be homed where that lineage already sits;
  // a supplier with none (migration 753 filed it with empty candidate_facility_ids)
  // has no data to contradict, so the governed operator choice stands on the
  // active-facility check alone.
  //
  // SCOPE — do not read this resolver as closing the whole
  // SUPPLIER_FACILITY_AUTHORITY_UNRESOLVED worklist. Migration 753 already
  // auto-assigned facility_id to every supplier whose lineage resolved to
  // exactly one facility (753: `resolved.facility_count=1`), so the rows that
  // survive into the worklist are precisely the ones with ZERO lineage
  // facilities or TWO OR MORE. This resolver closes:
  //   * zero lineage rows                      -> operator names any active facility;
  //   * lineage rows whose facility is NULL    -> refused PHARMACY_RECOVERY_DEPENDENCY_OPEN,
  //     but closable once those rows are repaired through their own worklist
  //     entries and the set collapses to one facility.
  // It does NOT close a supplier whose lineage genuinely spans two or more
  // facilities. That population stays fail-closed here on purpose: homing it
  // to one facility would silently re-scope real supply history, and
  // trg_pharmacy_supplier_rehome_supply_753 admits only this writer. The
  // governed answer is a per-facility supplier split, which is a separate
  // lane — it needs supplier cloning and lineage re-pointing that this
  // recovery command deliberately does not own. Tracked as an open finding.
  if (lineageFacilities.size > 1) {
    throw AppError.conflict(
      'The supplier supply lineage spans more than one facility and cannot be homed to a single facility',
      'PHARMACY_RECOVERY_AUTHORITY_INVALID',
      {
        authoritative_facility_ids: [...lineageFacilities].sort((a, b) => a - b),
        next_action: 'split_supplier_per_facility_then_retire_multi_facility_supplier',
      },
    );
  }
  if (lineageFacilities.size === 1 && !lineageFacilities.has(facilityId)) {
    throw AppError.conflict(
      'Selected facility does not match the exact supplier supply lineage',
      'PHARMACY_RECOVERY_AUTHORITY_INVALID',
      { authoritative_facility_ids: [...lineageFacilities].sort((a, b) => a - b) },
    );
  }
  const snapshot = await tx.$queryRawUnsafe(
    `UPDATE pharmacy_inventory_authority_recovery_worklist
        SET authority_snapshot=COALESCE(authority_snapshot, '{}'::jsonb)
              || jsonb_build_object('target_facility_id', $3::int),
            updated_at=NOW()
      WHERE tenant_id=$1::uuid AND id=$2::bigint AND status='OPEN'
      RETURNING id`,
    tenantId,
    String(recovery.id),
    facilityId,
  );
  if (!snapshot.length) {
    throw AppError.conflict(
      'Authority recovery state changed before supplier facility recovery',
      'PHARMACY_RECOVERY_STATE_CHANGED',
    );
  }
  await tx.$queryRawUnsafe(
    `SELECT set_config('app.pharmacy_authority_recovery_id', $1, TRUE) AS recovery_id`,
    String(recovery.id),
  );
  const updated = await tx.$queryRawUnsafe(
    `UPDATE pharmacy_suppliers
        SET facility_id=$3::int,
            status=CASE
              WHEN status='paused'
                AND COALESCE(metadata->>'facility_authority_recovery_required', '')='true'
                THEN 'active'
              ELSE status
            END,
            metadata=COALESCE(metadata, '{}'::jsonb)
              -'facility_authority_recovery_required',
            updated_at=NOW()
      WHERE tenant_id=$1::uuid AND id=$2::int AND facility_id IS NULL
      RETURNING id, facility_id`,
    tenantId,
    Number(recovery.entity_id),
    facilityId,
  );
  if (!updated.length || Number(updated[0].facility_id) !== facilityId) {
    throw AppError.conflict(
      'Supplier facility changed before recovery committed',
      'PHARMACY_RECOVERY_STATE_CHANGED',
    );
  }
}

async function resolveSupplyRecoveryTx(tx, { tenantId, recovery, resolution }) {
  if (recovery.entity_type === 'supplier') {
    await resolveSupplierFacilityRecoveryTx(tx, { tenantId, recovery, resolution });
    return;
  }
  if (recovery.entity_type === 'purchase_order') {
    const priorStatus = String(recovery.authority_snapshot?.status || '').trim().toLowerCase();
    if (!['draft', 'submitted', 'approved', 'partially_received', 'fully_received', 'cancelled', 'closed'].includes(priorStatus)) {
      throw AppError.conflict('Purchase-order recovery has no valid prior lifecycle state', 'PHARMACY_RECOVERY_AUTHORITY_INVALID');
    }
    const currentRows = await tx.$queryRawUnsafe(
      `SELECT id, status, facility_id, supplier_id
         FROM pharmacy_purchase_orders
        WHERE tenant_id=$1::uuid AND id=$2::int
        FOR UPDATE`,
      tenantId,
      Number(recovery.entity_id),
    );
    if (!currentRows.length) {
      throw AppError.conflict('Purchase-order recovery target is missing', 'PHARMACY_RECOVERY_TARGET_MISSING');
    }
    if (['cancelled', 'closed'].includes(priorStatus)) {
      if (String(resolution.action || '').trim().toUpperCase() !== 'PRESERVE_TERMINAL_HISTORY'
        || String(currentRows[0].status || '').toLowerCase() !== priorStatus) {
        throw AppError.conflict(
          'Terminal purchase-order history may only be acknowledged without rewriting it',
          'PHARMACY_RECOVERY_TERMINAL_HISTORY_IMMUTABLE',
        );
      }
      return;
    }
    const facilityId = recoveryPositiveId(resolution.facility_id, 'facility_id');
    const supplierId = recoveryPositiveId(resolution.supplier_id, 'supplier_id');
    const authority = await tx.$queryRawUnsafe(
      `SELECT facility.id, supplier.id AS supplier_id
         FROM facilities facility
         JOIN pharmacy_suppliers supplier
           ON supplier.tenant_id=facility.tenant_id
          AND supplier.id=$3::int
          AND supplier.status='active'
          AND supplier.facility_id=facility.id
        WHERE facility.tenant_id=$1::uuid
          AND facility.id=$2::int
          AND facility.status='active'
        FOR UPDATE OF facility, supplier`,
      tenantId,
      facilityId,
      supplierId,
    );
    if (!authority.length) {
      throw AppError.conflict('Purchase-order recovery authority is invalid', 'PHARMACY_RECOVERY_AUTHORITY_INVALID');
    }
    const openChildren = await tx.$queryRawUnsafe(
      `SELECT recovery.id
         FROM pharmacy_inventory_authority_recovery_worklist recovery
         JOIN pharmacy_purchase_order_items line
           ON line.tenant_id=recovery.tenant_id AND line.id=recovery.entity_id
        WHERE recovery.tenant_id=$1::uuid AND recovery.entity_type='purchase_order_item'
          AND recovery.status='OPEN' AND line.purchase_order_id=$2::int
        LIMIT 1
        FOR UPDATE OF recovery, line`,
      tenantId,
      Number(recovery.entity_id),
    );
    if (openChildren.length) {
      throw AppError.conflict('Repair every purchase-order line before resolving the parent', 'PHARMACY_RECOVERY_DEPENDENCY_OPEN');
    }
    const allLines = await tx.$queryRawUnsafe(
        `SELECT id FROM pharmacy_purchase_order_items
          WHERE tenant_id=$1::uuid AND purchase_order_id=$2::int
          ORDER BY id FOR UPDATE`,
        tenantId,
        Number(recovery.entity_id),
      );
    const validLines = await tx.$queryRawUnsafe(
        `SELECT line.id
           FROM pharmacy_purchase_order_items line
           JOIN pharmacy_inventory_items item
             ON item.tenant_id=line.tenant_id AND item.id=line.inventory_item_id
            AND item.facility_id=$3::int AND item.status='active'
           JOIN pharmacy_catalog catalog
             ON catalog.tenant_id=item.tenant_id AND catalog.id=item.catalog_id
            AND catalog.is_active=TRUE
          WHERE line.tenant_id=$1::uuid AND line.purchase_order_id=$2::int
            AND line.ordered_quantity>0
          ORDER BY line.id
          FOR KEY SHARE OF item, catalog`,
        tenantId,
        Number(recovery.entity_id),
        facilityId,
      );
    if ((priorStatus !== 'draft' && !allLines.length) || allLines.length !== validLines.length) {
      throw AppError.conflict('Purchase-order lines remain inconsistent', 'PHARMACY_RECOVERY_AUTHORITY_INVALID');
    }
    const updated = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_purchase_orders
          SET facility_id=$3::int, supplier_id=$4::int, status=$5,
              metadata=(COALESCE(metadata, '{}'::jsonb)-'authority_recovery_required'),
              updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int
        RETURNING id`,
      tenantId,
      Number(recovery.entity_id),
      facilityId,
      supplierId,
      priorStatus,
    );
    if (!updated.length) throw AppError.conflict('Purchase-order recovery target changed', 'PHARMACY_RECOVERY_TARGET_MISSING');
    return;
  }
  if (recovery.entity_type === 'purchase_order_item') {
    const inventoryItemId = recoveryPositiveId(resolution.inventory_item_id, 'inventory_item_id');
    const authority = await tx.$queryRawUnsafe(
      `SELECT poi.id
         FROM pharmacy_purchase_order_items poi
         JOIN pharmacy_purchase_orders po
           ON po.tenant_id=poi.tenant_id AND po.id=poi.purchase_order_id
         JOIN pharmacy_inventory_items item
           ON item.tenant_id=po.tenant_id
          AND item.id=$3::int
          AND item.facility_id=po.facility_id
          AND item.status='active'
         JOIN pharmacy_catalog catalog
           ON catalog.tenant_id=item.tenant_id
          AND catalog.id=item.catalog_id
          AND catalog.is_active=TRUE
        WHERE poi.tenant_id=$1::uuid AND poi.id=$2::int
          AND po.status='draft'
        FOR UPDATE OF poi, po, item, catalog`,
      tenantId,
      Number(recovery.entity_id),
      inventoryItemId,
    );
    if (!authority.length) {
      throw AppError.conflict('PO-line recovery authority is invalid', 'PHARMACY_RECOVERY_AUTHORITY_INVALID');
    }
    await tx.$executeRawUnsafe(
      `UPDATE pharmacy_purchase_order_items
          SET inventory_item_id=$3::int, updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int`,
      tenantId,
      Number(recovery.entity_id),
      inventoryItemId,
    );
    return;
  }
  if (recovery.entity_type === 'goods_receipt') {
    const priorStatus = String(recovery.authority_snapshot?.status || '').trim().toLowerCase();
    if (!['received', 'qc_pending', 'qc_failed', 'qc_passed', 'partial', 'rejected', 'archived'].includes(priorStatus)) {
      throw AppError.conflict('Goods-receipt recovery has no valid prior lifecycle state', 'PHARMACY_RECOVERY_AUTHORITY_INVALID');
    }
    const currentRows = await tx.$queryRawUnsafe(
      `SELECT id, status, purchase_order_id, facility_id, supplier_id
         FROM pharmacy_goods_receipts
        WHERE tenant_id=$1::uuid AND id=$2::int
        FOR UPDATE`,
      tenantId,
      Number(recovery.entity_id),
    );
    if (!currentRows.length) {
      throw AppError.conflict('Goods-receipt recovery target is missing', 'PHARMACY_RECOVERY_TARGET_MISSING');
    }
    if (['rejected', 'archived'].includes(priorStatus)) {
      if (String(resolution.action || '').trim().toUpperCase() !== 'PRESERVE_TERMINAL_HISTORY'
        || String(currentRows[0].status || '').toLowerCase() !== priorStatus) {
        throw AppError.conflict(
          'Terminal goods-receipt history may only be acknowledged without rewriting it',
          'PHARMACY_RECOVERY_TERMINAL_HISTORY_IMMUTABLE',
        );
      }
      return;
    }
    const purchaseOrderId = recoveryPositiveId(resolution.purchase_order_id, 'purchase_order_id');
    const authority = await tx.$queryRawUnsafe(
      `SELECT po.facility_id, po.supplier_id
         FROM pharmacy_purchase_orders po
         JOIN facilities facility
           ON facility.tenant_id=po.tenant_id
          AND facility.id=po.facility_id
          AND facility.status='active'
         JOIN pharmacy_suppliers supplier
           ON supplier.tenant_id=po.tenant_id
          AND supplier.id=po.supplier_id
          AND supplier.status='active'
          AND supplier.facility_id=po.facility_id
        WHERE po.tenant_id=$1::uuid AND po.id=$2::int
          AND po.status IN ('approved', 'partially_received')
        FOR UPDATE OF po, facility, supplier`,
      tenantId,
      purchaseOrderId,
    );
    if (!authority.length) {
      throw AppError.conflict('Goods-receipt recovery authority is invalid', 'PHARMACY_RECOVERY_AUTHORITY_INVALID');
    }
    const openChildren = await tx.$queryRawUnsafe(
      `SELECT recovery.id
         FROM pharmacy_inventory_authority_recovery_worklist recovery
         JOIN pharmacy_goods_receipt_items line
           ON line.tenant_id=recovery.tenant_id AND line.id=recovery.entity_id
        WHERE recovery.tenant_id=$1::uuid AND recovery.entity_type='goods_receipt_item'
          AND recovery.status='OPEN' AND line.goods_receipt_id=$2::int
        LIMIT 1
        FOR UPDATE OF recovery, line`,
      tenantId,
      Number(recovery.entity_id),
    );
    if (openChildren.length) {
      throw AppError.conflict('Repair every goods-receipt line before resolving the parent', 'PHARMACY_RECOVERY_DEPENDENCY_OPEN');
    }
    const allLines = await tx.$queryRawUnsafe(
        `SELECT id FROM pharmacy_goods_receipt_items
          WHERE tenant_id=$1::uuid AND goods_receipt_id=$2::int
          ORDER BY id FOR UPDATE`,
        tenantId,
        Number(recovery.entity_id),
      );
    const validLines = await tx.$queryRawUnsafe(
        `SELECT line.id
           FROM pharmacy_goods_receipt_items line
           JOIN pharmacy_goods_receipts grn
             ON grn.tenant_id=line.tenant_id AND grn.id=line.goods_receipt_id
           JOIN pharmacy_purchase_order_items po_line
             ON po_line.tenant_id=line.tenant_id
            AND po_line.id=line.purchase_order_item_id
            AND po_line.purchase_order_id=$3::int
            AND po_line.inventory_item_id=line.inventory_item_id
           JOIN pharmacy_inventory_batches batch
             ON batch.tenant_id=line.tenant_id AND batch.id=line.inventory_batch_id
            AND batch.inventory_item_id=line.inventory_item_id
            AND batch.goods_receipt_id=grn.id
            AND batch.facility_id=$4::int
          WHERE line.tenant_id=$1::uuid AND line.goods_receipt_id=$2::int
          ORDER BY line.id
          FOR KEY SHARE OF po_line, batch`,
        tenantId,
        Number(recovery.entity_id),
        purchaseOrderId,
        Number(authority[0].facility_id),
      );
    if (!allLines.length || allLines.length !== validLines.length) {
      throw AppError.conflict('Goods-receipt lines and batches remain inconsistent', 'PHARMACY_RECOVERY_AUTHORITY_INVALID');
    }
    const updated = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_goods_receipts
          SET purchase_order_id=$3::int, facility_id=$4::int, supplier_id=$5::int,
              status=$6,
              metadata=(COALESCE(metadata, '{}'::jsonb)-'authority_recovery_required'),
              updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int
        RETURNING id`,
      tenantId,
      Number(recovery.entity_id),
      purchaseOrderId,
      Number(authority[0].facility_id),
      Number(authority[0].supplier_id),
      priorStatus,
    );
    if (!updated.length) throw AppError.conflict('Goods-receipt recovery target changed', 'PHARMACY_RECOVERY_TARGET_MISSING');
    return;
  }
  if (recovery.entity_type === 'goods_receipt_item') {
    const purchaseOrderItemId = recoveryPositiveId(
      resolution.purchase_order_item_id,
      'purchase_order_item_id',
    );
    const batchId = recoveryPositiveId(resolution.inventory_batch_id, 'inventory_batch_id');
    const authority = await tx.$queryRawUnsafe(
      `SELECT gri.id, poi.inventory_item_id, batch.id AS batch_id
         FROM pharmacy_goods_receipt_items gri
         JOIN pharmacy_goods_receipts grn
           ON grn.tenant_id=gri.tenant_id AND grn.id=gri.goods_receipt_id
         JOIN pharmacy_purchase_order_items poi
           ON poi.tenant_id=grn.tenant_id
          AND poi.id=$3::int
          AND poi.purchase_order_id=grn.purchase_order_id
         JOIN pharmacy_purchase_orders po
           ON po.tenant_id=poi.tenant_id
          AND po.id=poi.purchase_order_id
          AND po.facility_id=grn.facility_id
          AND po.supplier_id=grn.supplier_id
         JOIN pharmacy_inventory_batches batch
           ON batch.tenant_id=poi.tenant_id
          AND batch.id=$4::int
          AND batch.inventory_item_id=poi.inventory_item_id
          AND batch.facility_id=po.facility_id
          AND batch.goods_receipt_id=grn.id
        WHERE gri.tenant_id=$1::uuid AND gri.id=$2::int
        FOR UPDATE OF gri, grn, poi, po, batch`,
      tenantId,
      Number(recovery.entity_id),
      purchaseOrderItemId,
      batchId,
    );
    if (!authority.length) {
      throw AppError.conflict('GRN-line recovery authority is invalid', 'PHARMACY_RECOVERY_AUTHORITY_INVALID');
    }
    await tx.$executeRawUnsafe(
      `UPDATE pharmacy_goods_receipt_items
          SET purchase_order_item_id=$3::int,
              inventory_item_id=$4::int,
              inventory_batch_id=$5::int,
              updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int`,
      tenantId,
      Number(recovery.entity_id),
      purchaseOrderItemId,
      Number(authority[0].inventory_item_id),
      batchId,
    );
    return;
  }
  throw AppError.conflict(
    'The requested supply recovery class is unsupported',
    'PHARMACY_RECOVERY_DEDICATED_WORKFLOW_REQUIRED',
  );
}

async function resolveClinicalLinkRecoveryTx(tx, {
  tenantId,
  recovery,
  resolution,
  actorUid,
  actorRole,
}) {
  if (recovery.entity_type === 'pharmacy_order') {
    const orderRows = await tx.$queryRawUnsafe(
      `SELECT id, patient_id, authority_origin
         FROM pharmacy_orders
        WHERE tenant_id=$1::uuid AND id=$2::int
        FOR UPDATE`,
      tenantId,
      Number(recovery.entity_id),
    );
    if (!orderRows[0]) {
      throw AppError.conflict(
        'The pharmacy order no longer exists and cannot be falsely resolved',
        'PHARMACY_RECOVERY_TARGET_MISSING',
      );
    }
    if (recovery.reason_code === 'ORDER_STATUS_NONCANONICAL') {
      const status = String(resolution.status || '').trim().toUpperCase();
      if (status !== 'CANCELLED') {
        throw AppError.badRequest(
          'Noncanonical legacy orders may recover only to CANCELLED',
          'PHARMACY_RECOVERY_INPUT_INVALID',
        );
      }
      await tx.$queryRawUnsafe(
        `SELECT set_config('app.pharmacy_authority_recovery_id', $1, TRUE) AS recovery_id`,
        String(recovery.id),
      );
      await tx.$executeRawUnsafe(
        `UPDATE pharmacy_orders
            SET status=$3, inventory_authority_version=inventory_authority_version+1,
                clinical_verification_status='pending', clinically_verified_by=NULL,
                clinically_verified_at=NULL, clinically_verified_order_version=NULL,
                clinical_verification_items_sha256=NULL,
                clinical_verification_catalog_sha256=NULL,
                clinical_verification_safety_version=NULL,
                clinical_verification_kb_version=NULL,
                clinical_verification_ruleset_version=NULL,
                updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=$2::int`,
        tenantId,
        Number(recovery.entity_id),
        status,
      );
      return;
    }
    if (recovery.reason_code === 'ORDER_PATIENT_TENANT_MISMATCH') {
      const patientId = recoveryPositiveId(resolution.patient_id, 'patient_id');
      const patientUid = String(resolution.patient_uid || '').trim();
      if (!UUID_RE.test(patientUid)) {
        throw AppError.badRequest(
          'patient_uid is required for order patient recovery',
          'PHARMACY_RECOVERY_INPUT_INVALID',
        );
      }
      const patients = await tx.$queryRawUnsafe(
        `SELECT id, uid, name, phone
           FROM users
          WHERE tenant_id=$1::uuid AND id=$2::int AND uid=$3::uuid
            AND role='PATIENT' AND is_active=TRUE AND status='active'
            AND is_deleted=FALSE AND merged_into_uid IS NULL
          FOR UPDATE`,
        tenantId,
        patientId,
        patientUid,
      );
      if (!patients[0]) {
        throw AppError.conflict(
          'The selected order patient is not an active exact tenant patient',
          'PHARMACY_RECOVERY_AUTHORITY_INVALID',
        );
      }
      const linkedPrescriptions = await tx.$queryRawUnsafe(
        `SELECT id, patient_id, patient_uid
           FROM e_prescriptions
          WHERE tenant_id=$1::uuid AND pharmacy_order_id=$2::int
          ORDER BY id
          FOR UPDATE`,
        tenantId,
        Number(recovery.entity_id),
      );
      if (orderRows[0].authority_origin === 'e_prescription'
        && (linkedPrescriptions.length !== 1
          || Number(linkedPrescriptions[0].patient_id) !== patientId
          || String(linkedPrescriptions[0].patient_uid) !== patientUid)) {
        throw AppError.conflict(
          'The linked prescription must be repaired to the same exact patient first',
          'PHARMACY_RECOVERY_AUTHORITY_INVALID',
        );
      }
      const updated = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_orders
            SET patient_id=$3::int, patient_name=$4, patient_phone=$5,
                inventory_authority_version=inventory_authority_version+1,
                clinical_verification_status='pending', clinically_verified_by=NULL,
                clinically_verified_at=NULL, clinically_verified_order_version=NULL,
                clinical_verification_items_sha256=NULL,
                clinical_verification_catalog_sha256=NULL,
                clinical_verification_safety_version=NULL,
                clinical_verification_kb_version=NULL,
                clinical_verification_ruleset_version=NULL,
                updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=$2::int
          RETURNING id`,
        tenantId,
        Number(recovery.entity_id),
        patientId,
        patients[0].name || null,
        patients[0].phone || null,
      );
      if (!updated[0]) {
        throw AppError.conflict(
          'Order patient recovery did not update its exact target',
          'PHARMACY_RECOVERY_TARGET_MISSING',
        );
      }
      const repaired = await tx.$queryRawUnsafe(
        `SELECT po.id
           FROM pharmacy_orders po
           JOIN users patient
             ON patient.tenant_id=po.tenant_id AND patient.id=po.patient_id
            AND patient.role='PATIENT' AND patient.is_active=TRUE
            AND patient.status='active' AND patient.is_deleted=FALSE
            AND patient.merged_into_uid IS NULL
          WHERE po.tenant_id=$1::uuid AND po.id=$2::int
            AND po.patient_id IS NOT NULL
          FOR UPDATE OF po, patient`,
        tenantId,
        Number(recovery.entity_id),
      );
      if (!repaired.length) {
        throw AppError.conflict('Order patient authority remains invalid', 'PHARMACY_RECOVERY_AUTHORITY_INVALID');
      }
      return;
    }
    throw AppError.conflict(
      'The pharmacy-order recovery reason requires a dedicated governed action',
      'PHARMACY_RECOVERY_DEDICATED_WORKFLOW_REQUIRED',
      { reason_code: recovery.reason_code },
    );
  }
  if (recovery.entity_type === 'e_prescription') {
    const targets = await tx.$queryRawUnsafe(
      `SELECT id, patient_id, patient_uid, pharmacy_order_id, pharmacy_opted,
              status, lifecycle_status, medications, revision
         FROM e_prescriptions
        WHERE tenant_id=$1::uuid AND id=$2::int
        FOR UPDATE`,
      tenantId,
      Number(recovery.entity_id),
    );
    if (!targets[0]) {
      throw AppError.conflict(
        'The prescription no longer exists and cannot be falsely resolved',
        'PHARMACY_RECOVERY_TARGET_MISSING',
      );
    }
    const action = String(resolution.action || '').trim().toUpperCase();
    if (recovery.reason_code === 'PRESCRIPTION_ORDER_DUPLICATE_LINK'
      || recovery.reason_code === 'PRESCRIPTION_ORDER_PATIENT_MISMATCH') {
      const allowedActions = recovery.reason_code === 'PRESCRIPTION_ORDER_PATIENT_MISMATCH'
        ? ['AMEND_PATIENT', 'RETAIN_UNLINKED', 'TERMINATE']
        : ['RETAIN_UNLINKED', 'TERMINATE', 'RELINK'];
      if (!allowedActions.includes(action)) {
        throw AppError.badRequest(
          `Prescription-link recovery requires action ${allowedActions.join(', ')}`,
          'PHARMACY_RECOVERY_INPUT_INVALID',
        );
      }
      if (action === 'AMEND_PATIENT') {
        const patientId = recoveryPositiveId(resolution.patient_id, 'patient_id');
        const patientUid = String(resolution.patient_uid || '').trim();
        if (!UUID_RE.test(patientUid)) {
          throw AppError.badRequest(
            'patient_uid is required for prescription patient recovery',
            'PHARMACY_RECOVERY_INPUT_INVALID',
          );
        }
        const orderId = recoveryPositiveId(targets[0].pharmacy_order_id, 'pharmacy_order_id');
        const authority = await tx.$queryRawUnsafe(
          `SELECT po.id, patient.name, patient.phone
             FROM pharmacy_orders po
             JOIN users patient
               ON patient.tenant_id=po.tenant_id
              AND patient.id=$3::int AND patient.uid=$4::uuid
              AND patient.role='PATIENT' AND patient.is_active=TRUE
              AND patient.status='active' AND patient.is_deleted=FALSE
              AND patient.merged_into_uid IS NULL
            WHERE po.tenant_id=$1::uuid AND po.id=$2::int
              AND po.status IN ('PENDING','CONFIRMED','PREPARING','ON_HOLD')
              AND po.authority_origin='e_prescription'
              AND NOT EXISTS (
                SELECT 1 FROM e_prescriptions linked
                 WHERE linked.tenant_id=po.tenant_id
                   AND linked.pharmacy_order_id=po.id AND linked.id<>$5::int
              )
            FOR UPDATE OF po, patient`,
          tenantId,
          orderId,
          patientId,
          patientUid,
          Number(recovery.entity_id),
        );
        if (!authority.length) {
          throw AppError.conflict(
            'Patient amendment requires one unclaimed active e-prescription order and an exact active tenant patient',
            'PHARMACY_RECOVERY_AUTHORITY_INVALID',
          );
        }
        const prescriptionUpdated = await tx.$queryRawUnsafe(
          `UPDATE e_prescriptions
              SET patient_id=$3::int, patient_uid=$4::uuid,
                  revision=COALESCE(revision,1)+1, updated_at=NOW()
            WHERE tenant_id=$1::uuid AND id=$2::int AND pharmacy_order_id=$5::int
            RETURNING id`,
          tenantId,
          Number(recovery.entity_id),
          patientId,
          patientUid,
          orderId,
        );
        const orderUpdated = await tx.$queryRawUnsafe(
          `UPDATE pharmacy_orders
              SET patient_id=$3::int, patient_name=$4, patient_phone=$5,
                  inventory_authority_version=inventory_authority_version+1,
                  clinical_verification_status='pending', clinically_verified_by=NULL,
                  clinically_verified_at=NULL, clinically_verified_order_version=NULL,
                  clinical_verification_items_sha256=NULL,
                  clinical_verification_catalog_sha256=NULL,
                  clinical_verification_active_therapy_sha256=NULL,
                  clinical_verification_safety_version=NULL,
                  clinical_verification_kb_version=NULL,
                  clinical_verification_ruleset_version=NULL,
                  updated_at=NOW()
            WHERE tenant_id=$1::uuid AND id=$2::int
            RETURNING id`,
          tenantId,
          orderId,
          patientId,
          authority[0].name || null,
          authority[0].phone || null,
        );
        if (!prescriptionUpdated.length || !orderUpdated.length) {
          throw AppError.conflict(
            'Prescription patient amendment target changed before recovery completed',
            'PHARMACY_RECOVERY_TARGET_MISSING',
          );
        }
        return;
      }
      if (action === 'RELINK') {
        const orderId = recoveryPositiveId(resolution.pharmacy_order_id, 'pharmacy_order_id');
        const authority = await tx.$queryRawUnsafe(
          `SELECT po.id
             FROM pharmacy_orders po
             JOIN users patient
               ON patient.tenant_id=po.tenant_id AND patient.id=po.patient_id
              AND patient.id=$4::int AND patient.uid=$5::uuid
              AND patient.role='PATIENT' AND patient.is_active=TRUE
              AND patient.status='active' AND patient.is_deleted=FALSE
              AND patient.merged_into_uid IS NULL
            WHERE po.tenant_id=$1::uuid AND po.id=$2::int
              AND po.status IN ('PENDING','CONFIRMED','PREPARING','ON_HOLD')
              AND NOT EXISTS (
                SELECT 1 FROM e_prescriptions linked
                 WHERE linked.tenant_id=po.tenant_id
                   AND linked.pharmacy_order_id=po.id AND linked.id<>$3::int
              )
            FOR UPDATE OF po, patient`,
          tenantId,
          orderId,
          Number(recovery.entity_id),
          Number(targets[0].patient_id),
          String(targets[0].patient_uid),
        );
        if (!authority.length) {
          throw AppError.conflict(
            'Relink requires one unclaimed order for the prescription exact active patient',
            'PHARMACY_RECOVERY_AUTHORITY_INVALID',
          );
        }
        const updated = await tx.$queryRawUnsafe(
          `UPDATE e_prescriptions
              SET pharmacy_order_id=$3::int, pharmacy_opted=TRUE,
                  status='pharmacy_linked', revision=COALESCE(revision,1)+1,
                  updated_at=NOW()
            WHERE tenant_id=$1::uuid AND id=$2::int
            RETURNING id`,
          tenantId,
          Number(recovery.entity_id),
          orderId,
        );
        if (!updated.length) throw AppError.conflict('Prescription relink target changed', 'PHARMACY_RECOVERY_TARGET_MISSING');
        await tx.$executeRawUnsafe(
          `UPDATE pharmacy_orders
              SET inventory_authority_version=inventory_authority_version+1,
                  clinical_verification_status='pending', clinically_verified_by=NULL,
                  clinically_verified_at=NULL, clinically_verified_order_version=NULL,
                  clinical_verification_items_sha256=NULL,
                  clinical_verification_catalog_sha256=NULL,
                  clinical_verification_active_therapy_sha256=NULL,
                  clinical_verification_safety_version=NULL,
                  clinical_verification_kb_version=NULL,
                  clinical_verification_ruleset_version=NULL,
                  updated_at=NOW()
            WHERE tenant_id=$1::uuid AND id=$2::int`,
          tenantId,
          orderId,
        );
        return;
      }
      const medications = Array.isArray(targets[0].medications)
        ? targets[0].medications.map((medication) => {
          const ordered = Number(
            medication?.ordered_quantity ?? medication?.quantity ?? medication?.qty ?? 0,
          );
          const dispensed = Number(medication?.dispensed_quantity || 0);
          const remaining = Math.max(0, Number.isFinite(ordered) ? ordered - dispensed : 0);
          return {
            ...medication,
            remaining_quantity: remaining,
            reorderable_after_pharmacy_termination: action === 'RETAIN_UNLINKED' && remaining > 0,
            pharmacy_link_recovery_action: action.toLowerCase(),
          };
        })
        : [];
      const nextStatus = action === 'TERMINATE'
        ? 'cancelled'
        : (medications.some((medication) => medication.remaining_quantity > 0)
          ? 'active'
          : 'fulfilled');
      const updated = await tx.$queryRawUnsafe(
        `UPDATE e_prescriptions
            SET pharmacy_order_id=NULL, pharmacy_opted=FALSE, status=$3,
                medications=$4::jsonb, revision=COALESCE(revision,1)+1,
                updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=$2::int
          RETURNING id`,
        tenantId,
        Number(recovery.entity_id),
        nextStatus,
        JSON.stringify(medications),
      );
      if (!updated.length) throw AppError.conflict('Prescription unlink target changed', 'PHARMACY_RECOVERY_TARGET_MISSING');
      if (recovery.reason_code === 'PRESCRIPTION_ORDER_PATIENT_MISMATCH'
        && Number.isSafeInteger(Number(targets[0].pharmacy_order_id))
        && Number(targets[0].pharmacy_order_id) > 0) {
        const cancelledOrderId = Number(targets[0].pharmacy_order_id);
        // The terminal status lands FIRST and without an authority-version bump:
        // compensateTerminalPharmacyFundingAuthorityTx requires the order to be in a
        // cancellative terminal state, and it balances the active billing line against
        // the order's CURRENT inventory_authority_version. Bumping before compensation
        // would make the line permanently unbalanceable (the funding lane would only
        // ever raise PHARMACY_TERMINAL_FUNDING_LINE_AUTHORITY_STALE), stranding real
        // money on a cancelled order. Mirrors the terminal-order lane in
        // pharmacyOrderController (markUnavailable / cancel), which likewise sets the
        // terminal status, compensates, and never bumps the version itself.
        const cancelled = await tx.$queryRawUnsafe(
          `UPDATE pharmacy_orders po
              SET status='CANCELLED',
                  clinical_verification_status='pending', clinically_verified_by=NULL,
                  clinically_verified_at=NULL, clinically_verified_order_version=NULL,
                  clinical_verification_items_sha256=NULL,
                  clinical_verification_catalog_sha256=NULL,
                  clinical_verification_active_therapy_sha256=NULL,
                  clinical_verification_safety_version=NULL,
                  clinical_verification_kb_version=NULL,
                  clinical_verification_ruleset_version=NULL,
                  updated_at=NOW()
            WHERE po.tenant_id=$1::uuid AND po.id=$2::int
              AND po.authority_origin='e_prescription'
              AND po.status IN ('PENDING','CONFIRMED','PREPARING','ON_HOLD')
              AND NOT EXISTS (
                SELECT 1 FROM e_prescriptions linked
                 WHERE linked.tenant_id=po.tenant_id
                   AND linked.pharmacy_order_id=po.id
              )
            RETURNING po.id`,
          tenantId,
          cancelledOrderId,
        );
        if (cancelled.length) {
          // Compensation is CONDITIONAL on the order resolving one active
          // funding patient, because without one it is structurally
          // unreachable: compensateTerminalPharmacyFundingAuthorityTx begins
          // with resolvePharmacyFundingPatientUidTx, which THROWS when the
          // order has no active resolvable patient, and its own order lookup
          // JOINs users on pharmacy_orders.patient_id. Migration 753
          // manufactures exactly that state — an order filed
          // ORDER_PATIENT_TENANT_MISMATCH has patient_id set to NULL
          // (753:1610-1631) — and 'po.patient_id IS NULL' is itself one of the
          // PRESCRIPTION_ORDER_PATIENT_MISMATCH filing conditions
          // (753:1216-1220). Calling compensation unconditionally therefore
          // made every such migration-filed row permanently unresolvable: the
          // cancel succeeded, the compensation threw, and the whole recovery
          // transaction rolled back.
          const fundingPatients = await tx.$queryRawUnsafe(
            `SELECT po.id
               FROM pharmacy_orders po
               JOIN users patient
                 ON patient.tenant_id=po.tenant_id AND patient.id=po.patient_id
                AND patient.role='PATIENT' AND patient.is_active=TRUE
                AND patient.status='active' AND patient.is_deleted=FALSE
                AND patient.merged_into_uid IS NULL
              WHERE po.tenant_id=$1::uuid AND po.id=$2::int
                AND po.patient_id IS NOT NULL
              FOR UPDATE OF po`,
            tenantId,
            cancelledOrderId,
          );
          // The no-patient branch is fail-CLOSED, not fail-open: it proves the
          // money plane is already empty (no active pharmacy invoice line, no
          // ACTIVE cap reservation, no unreversed allocation) and otherwise
          // refuses, naming the order's own ORDER_PATIENT_TENANT_MISMATCH
          // recovery as the governed next action. An order that DOES resolve a
          // patient keeps the unchanged behaviour — the full compensation
          // command runs and its conflicts (stock evidence, finalized/paid
          // invoice, ambiguous or stale line) still abort this recovery rather
          // than leave live billing authority behind a cancelled order.
          const compensationOutcome = fundingPatients.length
            ? 'compensated'
            : 'skipped_no_resolvable_funding_patient';
          if (fundingPatients.length) {
            await compensateTerminalPharmacyFundingAuthorityTx(tx, {
              tenantId,
              orderId: cancelledOrderId,
              actorUid,
              actorRole,
            });
          } else {
            await assertNoLivePharmacyOrderFundingAuthorityTx(tx, {
              tenantId,
              orderId: cancelledOrderId,
            });
          }
          // Governed evidence for either outcome, stamped on the recovery row
          // the same way resolveSupplierFacilityRecoveryTx stamps its
          // target_facility_id, so the money-plane decision is durable and
          // greppable rather than implied by the absence of a compensation.
          const stamped = await tx.$queryRawUnsafe(
            `UPDATE pharmacy_inventory_authority_recovery_worklist
                SET authority_snapshot=COALESCE(authority_snapshot,'{}'::jsonb)
                      || jsonb_build_object(
                           'terminal_funding_compensation',
                           jsonb_build_object(
                             'contract','pharmacy_recovery_terminal_funding_compensation_v1',
                             'pharmacy_order_id',$3::int,
                             'terminal_order_status','CANCELLED',
                             'outcome',$4::text
                           )
                         ),
                    updated_at=NOW()
              WHERE tenant_id=$1::uuid AND id=$2::bigint AND status='OPEN'
              RETURNING id`,
            tenantId,
            String(recovery.id),
            cancelledOrderId,
            compensationOutcome,
          );
          if (!stamped.length) {
            throw AppError.conflict(
              'Authority recovery state changed before terminal funding compensation evidence',
              'PHARMACY_RECOVERY_STATE_CHANGED',
            );
          }
          await tx.$executeRawUnsafe(
            `UPDATE pharmacy_orders
                SET inventory_authority_version=inventory_authority_version+1,
                    updated_at=NOW()
              WHERE tenant_id=$1::uuid AND id=$2::int AND status='CANCELLED'`,
            tenantId,
            cancelledOrderId,
          );
        }
      }
      return;
    }
    throw AppError.conflict(
      'The prescription recovery reason requires a dedicated governed action',
      'PHARMACY_RECOVERY_DEDICATED_WORKFLOW_REQUIRED',
      { reason_code: recovery.reason_code },
    );
  }
  throw AppError.conflict(
    'The requested clinical-link recovery class is unsupported',
    'PHARMACY_RECOVERY_DEDICATED_WORKFLOW_REQUIRED',
  );
}

async function resolveWardIndentFacilityRecoveryTx(tx, {
  tenantId,
  recovery,
  resolution,
}) {
  if (recovery.entity_type !== 'ward_indent'
      || recovery.reason_code !== 'WARD_INDENT_FACILITY_UNRESOLVED') {
    throw AppError.conflict(
      'The ward-indent recovery class is unsupported',
      'PHARMACY_RECOVERY_DEDICATED_WORKFLOW_REQUIRED',
    );
  }
  if (String(resolution.action || '').trim().toUpperCase() !== 'ASSIGN_EXACT_FACILITY') {
    throw AppError.badRequest(
      'Ward-indent recovery requires action ASSIGN_EXACT_FACILITY',
      'PHARMACY_RECOVERY_INPUT_INVALID',
    );
  }
  const facilityId = recoveryPositiveId(resolution.facility_id, 'facility_id');
  const custodyReason = String(resolution.custody_reason || '').trim();
  const custodyEvidence = resolution.custody_evidence;
  if (custodyReason.length < 10 || custodyReason.length > 500
      || !custodyEvidence || typeof custodyEvidence !== 'object'
      || Array.isArray(custodyEvidence) || Object.keys(custodyEvidence).length === 0) {
    throw AppError.badRequest(
      'Ward-indent facility recovery requires a custody reason and structured evidence',
      'PHARMACY_WARD_FACILITY_CUSTODY_EVIDENCE_REQUIRED',
    );
  }
  const indents = await tx.$queryRawUnsafe(
    `SELECT indent.id, indent.facility_id, indent.status, indent.ward_id,
            ward.facility_id AS ward_facility_id,
            facility.status AS ward_facility_status
       FROM ward_indents indent
       LEFT JOIN wards ward
         ON ward.tenant_id=indent.tenant_id AND ward.id=indent.ward_id
       LEFT JOIN facilities facility
         ON facility.tenant_id=ward.tenant_id AND facility.id=ward.facility_id
      WHERE indent.tenant_id=$1::uuid AND indent.id=$2::int
        AND indent.indent_type='pharmacy'
        AND indent.status NOT IN ('rejected','cancelled','closed')
      FOR UPDATE OF indent, ward`,
    tenantId,
    Number(recovery.entity_id),
  );
  if (!indents[0] || indents[0].facility_id != null) {
    throw AppError.conflict(
      'Ward-indent facility authority changed before recovery',
      'PHARMACY_RECOVERY_STATE_CHANGED',
    );
  }
  const allocations = await tx.$queryRawUnsafe(
    `SELECT allocation.id, allocation.status, allocation.issued_quantity,
            item.facility_id AS item_facility_id,
            batch.facility_id AS batch_facility_id,
            item.status AS item_status, batch.status AS batch_status
       FROM ward_indent_inventory_allocations allocation
       LEFT JOIN pharmacy_inventory_items item
         ON item.tenant_id=allocation.tenant_id
        AND item.id=allocation.inventory_item_id
       LEFT JOIN pharmacy_inventory_batches batch
         ON batch.tenant_id=allocation.tenant_id
        AND batch.id=allocation.inventory_batch_id
        AND batch.inventory_item_id=allocation.inventory_item_id
      WHERE allocation.tenant_id=$1::uuid AND allocation.ward_indent_id=$2::int
      ORDER BY allocation.id
      FOR UPDATE OF allocation`,
    tenantId,
    Number(recovery.entity_id),
  );
  let authoritativeFacilityId;
  if (allocations.length === 0) {
    if (indents[0].ward_facility_status !== 'active') {
      throw AppError.conflict(
        'The ward has no active facility authority for a pre-custody indent',
        'PHARMACY_WARD_FACILITY_AUTHORITY_INVALID',
      );
    }
    authoritativeFacilityId = Number(indents[0].ward_facility_id);
  } else {
    const allocationFacilities = new Set();
    for (const allocation of allocations) {
      const itemFacilityId = Number(allocation.item_facility_id);
      const batchFacilityId = Number(allocation.batch_facility_id);
      if (!Number.isSafeInteger(itemFacilityId) || itemFacilityId <= 0
          || itemFacilityId !== batchFacilityId) {
        throw AppError.conflict(
          'Existing ward custody spans unresolved inventory authority and requires allocation recovery first',
          'PHARMACY_WARD_FACILITY_CUSTODY_RECONCILIATION_REQUIRED',
          { allocation_id: String(allocation.id) },
        );
      }
      allocationFacilities.add(itemFacilityId);
    }
    if (allocationFacilities.size !== 1) {
      throw AppError.conflict(
        'Existing ward custody spans multiple facilities and cannot be reassigned',
        'PHARMACY_WARD_FACILITY_CUSTODY_RECONCILIATION_REQUIRED',
      );
    }
    authoritativeFacilityId = [...allocationFacilities][0];
  }
  if (facilityId !== authoritativeFacilityId) {
    throw AppError.conflict(
      'Selected facility does not match the exact ward or inventory custody authority',
      'PHARMACY_WARD_FACILITY_SELECTION_MISMATCH',
      { authoritative_facility_id: authoritativeFacilityId },
    );
  }
  const facilities = await tx.$queryRawUnsafe(
    `SELECT id FROM facilities
      WHERE tenant_id=$1::uuid AND id=$2::int AND status='active'
      FOR UPDATE`,
    tenantId,
    facilityId,
  );
  if (!facilities[0]) {
    throw AppError.conflict(
      'Selected ward-indent facility is not active',
      'PHARMACY_WARD_FACILITY_AUTHORITY_INVALID',
    );
  }
  await tx.$queryRawUnsafe(
    `SELECT set_config(
       'app.pharmacy_ward_indent_facility_recovery_id', $1, TRUE
     ) AS recovery_id`,
    String(recovery.id),
  );
  const updated = await tx.$queryRawUnsafe(
    `UPDATE ward_indents
        SET facility_id=$3::int,
            facility_authority_version=facility_authority_version+1,
            notes=CONCAT_WS(
              E'\n', NULLIF(notes, ''),
              'Facility custody recovered: ' || $4
            ),
            updated_at=NOW()
      WHERE tenant_id=$1::uuid AND id=$2::int AND facility_id IS NULL
      RETURNING id`,
    tenantId,
    Number(recovery.entity_id),
    facilityId,
    custodyReason,
  );
  if (!updated[0]) {
    throw AppError.conflict(
      'Ward-indent facility changed before recovery committed',
      'PHARMACY_RECOVERY_STATE_CHANGED',
    );
  }
}

export async function resolveAuthorityRecovery({
  tenantId,
  recoveryId,
  resolution = {},
  actorUid,
  actorRole,
  requestId = null,
  commandKey,
  requestFingerprint,
  note,
}) {
  const tid = requireTenantId(tenantId);
  const id = recoveryBigIntId(recoveryId, 'recovery_id');
  const resolutionNote = String(note || '').trim();
  if (resolutionNote.length < 3 || resolutionNote.length > 500) {
    throw AppError.badRequest(
      'resolution_note must contain 3 to 500 characters',
      'PHARMACY_RECOVERY_NOTE_REQUIRED',
    );
  }
  const command = recoveryCommandEvidence({
    commandKey,
    requestFingerprint,
    resolution,
    note: resolutionNote,
  });
  return setTenantTx(tid, async (tx) => {
    const resolverUid = await lockRecoveryActorTx(tx, tid, actorUid);
    const initial = await tx.$queryRawUnsafe(
      `SELECT entity_type, facility_id
         FROM pharmacy_inventory_authority_recovery_worklist
        WHERE tenant_id=$1::uuid AND id=$2::bigint`,
      tid,
      id,
    );
    if (!initial.length) throw AppError.notFound('Authority recovery item not found');
    if (initial[0].entity_type === 'staff_facility_grant') {
      throw AppError.conflict(
        'Staff facility authority must be resolved through the governed grant command',
        'PHARMACY_RECOVERY_DEDICATED_WORKFLOW_REQUIRED',
        { recovery_endpoint: '/api/v1/pharmacy-orders/inventory/v2/facility-grants' },
      );
    }
    const sourceFacilityId = initial[0].facility_id == null
      ? null
      : recoveryPositiveId(initial[0].facility_id, 'facility_id');
    if (sourceFacilityId == null) {
      await lockRecoveryTenantAdminTx(tx, tid, resolverUid, actorRole);
    } else {
      await assertPharmacyFacilityGrant(tx, {
        tenantId: tid,
        facilityId: sourceFacilityId,
        actorUid: resolverUid,
        actorRole,
        forUpdate: true,
      });
    }
    const destinationFacilityId = resolution?.facility_id == null
      ? null
      : recoveryPositiveId(resolution.facility_id, 'resolution.facility_id');
    if (destinationFacilityId != null && destinationFacilityId !== sourceFacilityId) {
      await assertPharmacyFacilityGrant(tx, {
        tenantId: tid,
        facilityId: destinationFacilityId,
        actorUid: resolverUid,
        actorRole,
        forUpdate: true,
      });
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, entity_type, entity_id, inventory_item_id, facility_id, catalog_id,
              reason_code, authority_snapshot, status, resolved_by, resolved_at, resolution_note
         FROM pharmacy_inventory_authority_recovery_worklist
        WHERE tenant_id=$1::uuid AND id=$2::bigint
        FOR UPDATE`,
      tid,
      id,
    );
    if (!rows.length) throw AppError.notFound('Authority recovery item not found');
    const recovery = rows[0];
    if ((recovery.facility_id == null ? null : Number(recovery.facility_id))
        !== sourceFacilityId) {
      throw AppError.conflict(
        'Authority recovery facility changed before resolution',
        'PHARMACY_RECOVERY_STATE_CHANGED',
      );
    }
    const commandRows = await tx.$queryRawUnsafe(
      `SELECT recovery_id, request_sha256
         FROM pharmacy_inventory_authority_recovery_events
        WHERE tenant_id=$1::uuid AND command_key_sha256=$2
        LIMIT 1`,
      tid,
      command.commandKeySha256,
    );
    if (commandRows[0]
        && (String(commandRows[0].recovery_id) !== String(id)
          || commandRows[0].request_sha256 !== command.requestSha256)) {
      throw AppError.conflict(
        'Idempotency-Key was already used for a different recovery command',
        'PHARMACY_RECOVERY_COMMAND_REPLAY_CONFLICT',
      );
    }
    if (recovery.status === 'RESOLVED') return recovery;
    const targetIdentity = {
      entity_type: recovery.entity_type,
      entity_id: String(recovery.entity_id),
      recovery_id: String(recovery.id),
      reason_code: recovery.reason_code,
    };
    const targetBefore = await lockRecoveryTargetSnapshotTx(tx, tid, recovery);
    if (['inventory_item', 'inventory_batch'].includes(recovery.entity_type)) {
      await resolveInventoryRecoveryTx(tx, { tenantId: tid, recovery, resolution });
    } else if ([
      'supplier', 'purchase_order', 'purchase_order_item',
      'goods_receipt', 'goods_receipt_item',
    ].includes(recovery.entity_type)) {
      await resolveSupplyRecoveryTx(tx, { tenantId: tid, recovery, resolution });
    } else if (['pharmacy_order', 'e_prescription'].includes(recovery.entity_type)) {
      await resolveClinicalLinkRecoveryTx(tx, {
        tenantId: tid,
        recovery,
        resolution,
        actorUid: resolverUid,
        actorRole,
      });
    } else if (recovery.entity_type === 'ward_indent') {
      await resolveWardIndentFacilityRecoveryTx(tx, {
        tenantId: tid,
        recovery,
        resolution,
      });
    } else {
      throw AppError.conflict(
        'This authority class requires its dedicated governed recovery operation',
        'PHARMACY_RECOVERY_DEDICATED_WORKFLOW_REQUIRED',
        { entity_type: recovery.entity_type, reason_code: recovery.reason_code },
      );
    }
    const targetAfter = await lockRecoveryTargetSnapshotTx(tx, tid, recovery);
    await setRecoveryEventEvidenceTx(tx, {
      actorUid: resolverUid,
      requestId,
      command,
      targetIdentity,
      targetBefore,
      targetAfter,
    });
    const resolved = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_inventory_authority_recovery_worklist
          SET status='RESOLVED', resolved_by=$3::uuid, resolved_at=NOW(),
              resolution_note=$4, updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::bigint AND status='OPEN'
        RETURNING id, entity_type, entity_id, inventory_item_id, facility_id, catalog_id,
                  reason_code, authority_snapshot, status, resolved_by, resolved_at,
                  resolution_note, created_at, updated_at`,
      tid,
      id,
      resolverUid,
      resolutionNote,
    );
    if (!resolved.length) {
      throw AppError.conflict(
        'Authority recovery state changed before resolution',
        'PHARMACY_RECOVERY_STATE_CHANGED',
      );
    }
    return resolved[0];
  });
}

export async function resolveWardAllocationAuthorityRecovery({
  tenantId,
  recoveryId,
  resolution = {},
  actorUid,
  actorRole,
  requestId = null,
  commandKey,
  requestFingerprint,
  note,
}) {
  const tid = requireTenantId(tenantId);
  const id = recoveryBigIntId(recoveryId, 'recovery_id');
  const resolutionNote = String(note || '').trim();
  if (resolutionNote.length < 3 || resolutionNote.length > 500) {
    throw AppError.badRequest(
      'resolution_note must contain 3 to 500 characters',
      'PHARMACY_RECOVERY_NOTE_REQUIRED',
    );
  }
  if (String(resolution?.action || '').trim().toUpperCase()
      !== 'ACKNOWLEDGE_PRESERVED_ISSUED_LINEAGE') {
    throw AppError.badRequest(
      'resolution.action must be ACKNOWLEDGE_PRESERVED_ISSUED_LINEAGE',
      'PHARMACY_WARD_RECOVERY_ACTION_REQUIRED',
    );
  }
  const command = recoveryCommandEvidence({
    commandKey,
    requestFingerprint,
    resolution,
    note: resolutionNote,
  });
  return setTenantTx(tid, async (tx) => {
    const resolverUid = await lockRecoveryActorTx(tx, tid, actorUid);
    const initial = await tx.$queryRawUnsafe(
      `SELECT recovery.facility_id, recovery.catalog_id,
              recovery.inventory_item_id, recovery.inventory_batch_id,
              facility.status AS facility_status
         FROM pharmacy_ward_allocation_authority_recovery recovery
         LEFT JOIN facilities facility
           ON facility.tenant_id=recovery.tenant_id
          AND facility.id=recovery.facility_id
        WHERE recovery.tenant_id=$1::uuid AND recovery.id=$2::bigint`,
      tid,
      id,
    );
    if (!initial.length) throw AppError.notFound('Ward allocation recovery item not found');
    if (initial[0].facility_id != null && initial[0].facility_status === 'active') {
      await assertPharmacyFacilityGrant(tx, {
        tenantId: tid,
        facilityId: Number(initial[0].facility_id),
        actorUid: resolverUid,
        actorRole,
        forUpdate: true,
      });
    } else {
      await lockRecoveryTenantAdminTx(tx, tid, resolverUid, actorRole);
    }
    await tx.$queryRawUnsafe(
      `SELECT id FROM pharmacy_inventory_items
        WHERE tenant_id=$1::uuid AND id=$2::int FOR UPDATE`,
      tid,
      Number(initial[0].inventory_item_id),
    );
    await tx.$queryRawUnsafe(
      `SELECT id FROM pharmacy_inventory_batches
        WHERE tenant_id=$1::uuid AND id=$2::int FOR UPDATE`,
      tid,
      Number(initial[0].inventory_batch_id),
    );
    if (initial[0].catalog_id != null) {
      await tx.$queryRawUnsafe(
        `SELECT id FROM pharmacy_catalog
          WHERE tenant_id=$1::uuid AND id=$2::int FOR UPDATE`,
        tid,
        Number(initial[0].catalog_id),
      );
    }
    if (initial[0].facility_id != null) {
      await tx.$queryRawUnsafe(
        `SELECT id FROM facilities
          WHERE tenant_id=$1::uuid AND id=$2::int FOR UPDATE`,
        tid,
        Number(initial[0].facility_id),
      );
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT recovery.id, recovery.allocation_id, recovery.ward_indent_id,
              recovery.ward_indent_item_id, recovery.inventory_item_id,
              recovery.inventory_batch_id, recovery.facility_id, recovery.catalog_id,
              recovery.reason_code, recovery.authority_snapshot, recovery.status,
              allocation.status AS allocation_status,
              allocation.reserved_quantity, allocation.authority_released_quantity,
              allocation.issued_quantity, allocation.received_quantity,
              allocation.consumed_quantity, allocation.returned_quantity,
              item.id AS current_item_id,
              item.catalog_id AS current_catalog_id, item.status AS item_status,
              batch.id AS current_batch_id,
              batch.facility_id AS batch_facility_id,
              batch.status AS batch_status,
              catalog.id AS current_catalog_row_id,
              catalog.is_active AS catalog_is_active,
              facility.status AS facility_status,
              ward_item.pharmacy_catalog_id AS ward_catalog_id,
              indent.facility_id AS indent_facility_id
         FROM pharmacy_ward_allocation_authority_recovery recovery
         JOIN ward_indent_inventory_allocations allocation
           ON allocation.tenant_id=recovery.tenant_id
          AND allocation.id=recovery.allocation_id
          AND allocation.ward_indent_id=recovery.ward_indent_id
          AND allocation.ward_indent_item_id=recovery.ward_indent_item_id
          AND allocation.inventory_item_id=recovery.inventory_item_id
          AND allocation.inventory_batch_id=recovery.inventory_batch_id
         LEFT JOIN pharmacy_inventory_items item
           ON item.tenant_id=recovery.tenant_id
          AND item.id=recovery.inventory_item_id
         LEFT JOIN pharmacy_inventory_batches batch
           ON batch.tenant_id=recovery.tenant_id
          AND batch.id=recovery.inventory_batch_id
          AND batch.inventory_item_id=recovery.inventory_item_id
         LEFT JOIN pharmacy_catalog catalog
           ON catalog.tenant_id=recovery.tenant_id
          AND catalog.id=recovery.catalog_id
         LEFT JOIN facilities facility
           ON facility.tenant_id=recovery.tenant_id
          AND facility.id=recovery.facility_id
         JOIN ward_indent_items ward_item
           ON ward_item.tenant_id=recovery.tenant_id
          AND ward_item.id=recovery.ward_indent_item_id
          AND ward_item.ward_indent_id=recovery.ward_indent_id
         JOIN ward_indents indent
           ON indent.tenant_id=recovery.tenant_id
          AND indent.id=recovery.ward_indent_id
        WHERE recovery.tenant_id=$1::uuid AND recovery.id=$2::bigint
        FOR UPDATE OF recovery, allocation, ward_item, indent`,
      tid,
      id,
    );
    if (!rows.length) {
      throw AppError.conflict(
        'Ward allocation recovery lineage no longer matches its authoritative source',
        'PHARMACY_WARD_RECOVERY_LINEAGE_CHANGED',
      );
    }
    const recovery = rows[0];
    const facilityChanged = (recovery.facility_id == null ? null : Number(recovery.facility_id))
      !== (initial[0].facility_id == null ? null : Number(initial[0].facility_id));
    const exactFacility = recovery.facility_id != null
      && Number(recovery.batch_facility_id) === Number(recovery.facility_id)
      && Number(recovery.indent_facility_id) === Number(recovery.facility_id)
      && recovery.facility_status === 'active';
    const exactCatalog = recovery.catalog_id != null
      && Number(recovery.current_catalog_id) === Number(recovery.catalog_id)
      && Number(recovery.ward_catalog_id) === Number(recovery.catalog_id)
      && recovery.current_catalog_row_id != null;
    const reasonStillPresent = (() => {
      switch (recovery.reason_code) {
        case 'CATALOG_DEACTIVATED_ISSUED_WARD_ALLOCATION':
          return exactFacility
            && exactCatalog
            && recovery.catalog_is_active === false
            && String(recovery.item_status) === 'paused'
            && ['quarantined', 'depleted'].includes(String(recovery.batch_status));
        case 'WARD_ALLOCATION_ITEM_AUTHORITY_MISSING':
          return recovery.current_item_id == null;
        case 'WARD_ALLOCATION_BATCH_AUTHORITY_MISSING':
          return recovery.current_batch_id == null;
        case 'WARD_ALLOCATION_FACILITY_AUTHORITY_INVALID':
          return !exactFacility;
        case 'WARD_ALLOCATION_CATALOG_AUTHORITY_INVALID':
          return !exactCatalog || recovery.catalog_is_active !== true;
        case 'WARD_ALLOCATION_LINEAGE_AUTHORITY_MISMATCH':
          return !exactFacility || !exactCatalog;
        default:
          return false;
      }
    })();
    if (facilityChanged || !reasonStillPresent) {
      throw AppError.conflict(
        'Ward allocation recovery authority changed during resolution',
        'PHARMACY_WARD_RECOVERY_AUTHORITY_CHANGED',
      );
    }
    const commandRows = await tx.$queryRawUnsafe(
      `SELECT recovery_id, request_sha256
         FROM pharmacy_ward_allocation_authority_recovery_events
        WHERE tenant_id=$1::uuid AND command_key_sha256=$2
        LIMIT 1`,
      tid,
      command.commandKeySha256,
    );
    if (commandRows[0]
        && (String(commandRows[0].recovery_id) !== String(id)
          || commandRows[0].request_sha256 !== command.requestSha256)) {
      throw AppError.conflict(
        'Idempotency-Key was already used for a different ward recovery command',
        'PHARMACY_RECOVERY_COMMAND_REPLAY_CONFLICT',
      );
    }
    if (recovery.status === 'RESOLVED') return recovery;
    const targetIdentity = {
      recovery_id: String(recovery.id),
      allocation_id: String(recovery.allocation_id),
      ward_indent_id: Number(recovery.ward_indent_id),
      ward_indent_item_id: Number(recovery.ward_indent_item_id),
      inventory_item_id: Number(recovery.inventory_item_id),
      inventory_batch_id: Number(recovery.inventory_batch_id),
      reason_code: recovery.reason_code,
    };
    const targetBefore = normalizeRecoveryJson(recovery);
    if (!['issued', 'partially_issued'].includes(String(recovery.allocation_status))
        || Number(recovery.issued_quantity) <= 0
        || Number(recovery.authority_released_quantity || 0) !== 0) {
      throw AppError.conflict(
        'Ward allocation no longer matches the issued lineage awaiting acknowledgement',
        'PHARMACY_WARD_RECOVERY_ISSUED_LINEAGE_CHANGED',
        {
          allocation_id: String(recovery.allocation_id),
          allocation_status: recovery.allocation_status,
        },
      );
    }
    const releasedRemainder = Math.max(
      0,
      Number(recovery.reserved_quantity) - Number(recovery.issued_quantity),
    );
    if (releasedRemainder > 0) {
      const releasedCount = await tx.$executeRawUnsafe(
        `UPDATE ward_indent_inventory_allocations
            SET authority_released_quantity=$3::numeric,
                authority_released_by=$4::uuid,
                authority_released_at=NOW(),
                authority_release_reason='Catalog deactivation released the unissued reservation remainder',
                updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=$2::bigint
            AND status='partially_issued'
            AND authority_released_quantity=0
            AND reserved_quantity-issued_quantity=$3::numeric`,
        tid,
        recovery.allocation_id,
        releasedRemainder,
        resolverUid,
      );
      if (releasedCount !== 1) {
        throw AppError.conflict(
          'Ward allocation remainder changed before authority release',
          'PHARMACY_WARD_RECOVERY_STATE_CHANGED',
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE ward_indent_items
            SET quantity_reserved=GREATEST(
                  COALESCE(quantity_issued, 0), quantity_reserved-$3::numeric
                ),
                quantity_approved=GREATEST(
                  COALESCE(quantity_issued, 0), quantity_approved-$3::numeric
                ),
                fulfilment_status='reconciliation_required',
                reconciliation_note=CONCAT_WS(
                  E'\n', NULLIF(reconciliation_note, ''),
                  'Unissued reservation released after catalog deactivation; create a new governed indent for the remaining therapy.'
                ),
                updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=$2::int`,
        tid,
        Number(recovery.ward_indent_item_id),
        releasedRemainder,
      );
    }
    const afterRows = await tx.$queryRawUnsafe(
      `SELECT recovery.id, recovery.allocation_id, recovery.ward_indent_id,
              recovery.ward_indent_item_id, recovery.inventory_item_id,
              recovery.inventory_batch_id, recovery.facility_id, recovery.catalog_id,
              recovery.reason_code, recovery.authority_snapshot, recovery.status,
              allocation.status AS allocation_status,
              allocation.reserved_quantity, allocation.authority_released_quantity,
              allocation.issued_quantity, allocation.received_quantity,
              allocation.consumed_quantity, allocation.returned_quantity,
              ward_item.quantity_reserved, ward_item.quantity_approved,
              ward_item.fulfilment_status, ward_item.reconciliation_note
         FROM pharmacy_ward_allocation_authority_recovery recovery
         JOIN ward_indent_inventory_allocations allocation
           ON allocation.tenant_id=recovery.tenant_id
          AND allocation.id=recovery.allocation_id
         JOIN ward_indent_items ward_item
           ON ward_item.tenant_id=recovery.tenant_id
          AND ward_item.id=recovery.ward_indent_item_id
        WHERE recovery.tenant_id=$1::uuid AND recovery.id=$2::bigint
        FOR UPDATE OF recovery, allocation, ward_item`,
      tid,
      id,
    );
    if (!afterRows[0]) {
      throw AppError.conflict(
        'Ward allocation recovery target changed before receipt capture',
        'PHARMACY_WARD_RECOVERY_LINEAGE_CHANGED',
      );
    }
    await setRecoveryEventEvidenceTx(tx, {
      actorUid: resolverUid,
      requestId,
      command,
      targetIdentity,
      targetBefore,
      targetAfter: afterRows[0],
    });
    const resolved = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_ward_allocation_authority_recovery
          SET status='RESOLVED', resolved_by=$3::uuid, resolved_at=NOW(),
              resolution_note=$4, updated_at=NOW(),
              authority_snapshot=authority_snapshot || jsonb_build_object(
                'resolved_allocation_status', $5::text,
                'issued_quantity', $6::text,
                'received_quantity', $7::text,
                'consumed_quantity', $8::text,
                'returned_quantity', $9::text,
                'authority_released_remainder', $10::text,
                'replacement_action', CASE
                  WHEN $10::numeric>0
                    THEN 'create_new_governed_ward_indent_for_remainder'
                  ELSE 'none'
                END
              )
        WHERE tenant_id=$1::uuid AND id=$2::bigint AND status='OPEN'
        RETURNING id, allocation_id, ward_indent_id, ward_indent_item_id,
                  inventory_item_id, inventory_batch_id, facility_id, catalog_id,
                  reason_code, authority_snapshot, status, resolved_by, resolved_at,
                  resolution_note, created_at, updated_at`,
      tid,
      id,
      resolverUid,
      resolutionNote,
      recovery.allocation_status,
      recovery.issued_quantity,
      recovery.received_quantity,
      recovery.consumed_quantity,
      recovery.returned_quantity,
      releasedRemainder,
    );
    if (!resolved.length) {
      throw AppError.conflict(
        'Ward allocation recovery state changed before resolution',
        'PHARMACY_RECOVERY_STATE_CHANGED',
      );
    }
    return resolved[0];
  });
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
export async function runExpiryScan({ tenantId, facilityId, actorUid, actorRole }) {
  const tid = requireTenantId(tenantId);
  const fid = recoveryPositiveId(facilityId, 'facility_id');
  return setTenantTx(tid, async (tx) => {
    await assertPharmacyFacilityGrant(tx, {
      tenantId: tid,
      facilityId: fid,
      actorUid,
      actorRole,
      forUpdate: true,
    });
    // Mark batches with expiry_date < today as 'expired' (only for those
    // still in_stock — depleted/disposed/recalled stays terminal).
    const expired = await tx.$executeRawUnsafe(
      `UPDATE pharmacy_inventory_batches
          SET status = 'expired', updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND facility_id = $2::int
          AND status = 'in_stock'
          AND expiry_date < CURRENT_DATE`,
      tid,
      fid,
    );

    await tx.$executeRawUnsafe(
      `DELETE FROM pharmacy_expiry_scan_cache cache
        USING pharmacy_inventory_batches batch
        WHERE cache.tenant_id=$1::uuid
          AND batch.tenant_id=cache.tenant_id
          AND batch.id=cache.inventory_batch_id
          AND batch.facility_id=$2::int`,
      tid,
      fid,
    );

    await tx.$executeRawUnsafe(
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
          AND facility_id = $2::int
          AND status IN ('in_stock', 'expired')
          AND remaining_quantity > 0`,
      tid,
      fid,
    );

    const counts = await tx.$queryRawUnsafe(
      `SELECT cache.bucket, COUNT(*)::int AS batch_count,
              SUM(cache.remaining_quantity)::numeric AS units
         FROM pharmacy_expiry_scan_cache cache
         JOIN pharmacy_inventory_batches batch
           ON batch.tenant_id=cache.tenant_id AND batch.id=cache.inventory_batch_id
        WHERE cache.tenant_id = $1::uuid AND batch.facility_id=$2::int
          AND cache.bucket != 'beyond-90'
        GROUP BY cache.bucket
        ORDER BY cache.bucket`,
      tid,
      fid,
    );
    logger.info(`Pharmacy expiry scan completed for tenant=${tid} facility=${fid}: ${expired} newly-expired, ${counts.length} buckets`);
    return { newly_expired: expired, buckets: counts };
  });
}

export async function listExpiryAlerts({
  tenantId, facilityId, actorUid, actorRole, bucket, limit = 100,
}) {
  const tid = requireTenantId(tenantId);
  const fid = recoveryPositiveId(facilityId, 'facility_id');
  const params = [tid, fid];
  const where = [`c.tenant_id = $1::uuid`];
  where.push('b.facility_id=$2::int');
  if (bucket) { params.push(bucket); where.push(`c.bucket = $${params.length}`); }
  // Default: anything not "beyond-90"
  if (!bucket) where.push(`c.bucket != 'beyond-90'`);
  params.push(boundedInteger(limit, { fallback: 100, min: 1, max: 200 }));
  return setTenantTx(tid, async (tx) => {
    await assertPharmacyFacilityGrant(tx, {
      tenantId: tid,
      facilityId: fid,
      actorUid,
      actorRole,
    });
    return tx.$queryRawUnsafe(
      `SELECT c.*, i.sku_code, i.display_name, i.generic_name, i.unit_label, i.schedule_class,
              b.batch_number, b.lot_number, b.supplier_id
         FROM pharmacy_expiry_scan_cache c
         JOIN pharmacy_inventory_items i
           ON i.tenant_id=c.tenant_id AND i.id=c.inventory_item_id
          AND i.facility_id=$2::int
         JOIN pharmacy_inventory_batches b
           ON b.tenant_id=c.tenant_id AND b.id=c.inventory_batch_id
          AND b.inventory_item_id=i.id AND b.facility_id=i.facility_id
        WHERE ${where.join(' AND ')}
        ORDER BY c.days_to_expiry ASC
        LIMIT $${params.length}::int`,
      ...params,
    );
  });
}

export { tenantOf, ALLOWED_SCHEDULES, VALID_MOVEMENTS };
