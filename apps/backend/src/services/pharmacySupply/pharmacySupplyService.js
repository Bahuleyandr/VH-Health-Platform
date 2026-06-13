/**
 * Pharmacy supply chain service (Phase C4).
 *
 * Manages the ten tables added in migration 123: suppliers, inventory
 * items + batches, POs + items, GRNs + items, stock movements, expiry
 * alerts, and substitution graph.
 *
 * Key business rules enforced here:
 *   - FEFO (First-Expiry-First-Out) batch consumption via reserveStock()
 *   - Stock movements ledger: every receive / issue / dispose appends a
 *     row + delta to the matching batch's remaining_quantity in one txn
 *   - Expiry alert generation (computeExpiryAlerts) with severity bands
 *     by days_remaining
 *   - Self-substitute prevention via DB CHECK + service-side guard
 *
 * Decision-support only: the substitution graph is informational; the
 * dispense flow uses it as a hint, not a hard auto-swap.
 */

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const TEXT_MAX = 8000;
const SHORT_MAX = 255;

export const SUPPLIER_STATUSES = ['active', 'paused', 'blacklisted', 'archived'];
export const ITEM_STATUSES = ['active', 'paused', 'discontinued', 'archived'];
export const BATCH_STATUSES = ['in_stock', 'reserved', 'depleted', 'expired', 'recalled', 'quarantined', 'disposed'];
export const PO_STATUSES = ['draft', 'submitted', 'approved', 'partially_received', 'fully_received', 'cancelled', 'closed'];
export const GRN_STATUSES = ['received', 'qc_pending', 'qc_failed', 'qc_passed', 'partial', 'rejected', 'archived'];
export const QC_STATUSES = ['pending', 'passed', 'failed', 'partial'];
export const MOVEMENT_KINDS = [
  'receive', 'issue', 'transfer_out', 'transfer_in', 'return',
  'adjust_increase', 'adjust_decrease', 'dispose', 'expire', 'recall',
];
export const EXPIRY_SEVERITIES = ['low', 'medium', 'high', 'critical'];
export const EXPIRY_STATUSES = ['open', 'acknowledged', 'returned', 'disposed', 'expired_used', 'cancelled'];
export const SUBSTITUTE_KINDS = [
  'generic_equivalent', 'brand_equivalent', 'therapeutic_class',
  'manufacturer_alt', 'dose_strength_alt',
];

// Severity bands (in days remaining): >90 -> low, 60-90 -> medium, 30-60 -> high, <30 or expired -> critical
function severityForDaysRemaining(days) {
  if (days <= 30) return 'critical';
  if (days <= 60) return 'high';
  if (days <= 90) return 'medium';
  return 'low';
}

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isUniqueViolation(err) {
  return /duplicate key value/i.test(String(err?.message || ''));
}

function isFkViolation(err) {
  return /foreign key constraint/i.test(String(err?.message || ''));
}

function safeText(value, max = TEXT_MAX) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function normalizeLimit(value, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function normalizeEnum(value, allowed, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

function normalizeBoolean(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return Boolean(value);
}

function normalizeDate(value, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw AppError.badRequest(`${label} must be a YYYY-MM-DD date`);
  }
  return text;
}

function normalizeBigInt(value, label, { min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be numeric`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return Math.round(parsed);
}

function normalizeQuantity(value, label, { min = 0, max = 1_000_000_000, required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be numeric`);
  if (parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

function normalizeInt(value, label, { min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be an integer`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export async function upsertSupplier({
  tenantId = null, id = null,
  supplierCode, displayName, legalName = null,
  gstin = null, drugLicenseNumber = null, pan = null,
  contactEmail = null, contactPhone = null, address = null,
  paymentTerms = null, bankDetails = null,
  status = 'active', rating = null, metadata = null, createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanCode = safeText(supplierCode, 80);
  if (!cleanCode) throw AppError.badRequest('supplier_code is required');
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const ratingValue = rating !== null && rating !== undefined ? Number(rating) : null;
  if (ratingValue !== null && (!Number.isFinite(ratingValue) || ratingValue < 0 || ratingValue > 5)) {
    throw AppError.badRequest('rating must be 0..5');
  }
  const args = [
    cleanCode, cleanName, safeText(legalName, SHORT_MAX),
    safeText(gstin, 40), safeText(drugLicenseNumber, 120), safeText(pan, 20),
    safeText(contactEmail, 255), safeText(contactPhone, 40), safeText(address),
    safeText(paymentTerms, 60),
    JSON.stringify(normalizeJsonObject(bankDetails, 'bank_details')),
    normalizeEnum(status, SUPPLIER_STATUSES, 'status') || 'active',
    ratingValue,
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  ];
  try {
    if (id) {
      const supId = normalizeId(id, 'supplier id');
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE pharmacy_suppliers SET
           supplier_code = $1, display_name = $2, legal_name = $3,
           gstin = $4, drug_license_number = $5, pan = $6,
           contact_email = $7, contact_phone = $8, address = $9,
           payment_terms = $10, bank_details = $11::jsonb,
           status = $12, rating = $13, metadata = $14::jsonb, updated_at = NOW()
         WHERE id = $15 AND tenant_id = $16::uuid
         RETURNING id, tenant_id, supplier_code, display_name, legal_name,
                   gstin, drug_license_number, pan, contact_email, contact_phone,
                   address, payment_terms, bank_details, status, rating,
                   metadata, created_by, created_at, updated_at`,
        ...args, supId, tid,
      );
      if (!rows[0]) throw AppError.notFound('Supplier not found');
      return rows[0];
    }
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_suppliers
         (tenant_id, supplier_code, display_name, legal_name,
          gstin, drug_license_number, pan,
          contact_email, contact_phone, address,
          payment_terms, bank_details, status, rating, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15::jsonb, $16::uuid)
       RETURNING id, tenant_id, supplier_code, display_name, legal_name,
                 gstin, drug_license_number, pan, contact_email, contact_phone,
                 address, payment_terms, bank_details, status, rating,
                 metadata, created_by, created_at, updated_at`,
      tid, ...args, maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('supplier_code already exists');
    throw err;
  }
}

export async function listSuppliers({
  tenantId = null, status = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, SUPPLIER_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, supplier_code, display_name, legal_name,
              gstin, drug_license_number, pan, contact_email, contact_phone,
              address, payment_terms, bank_details, status, rating,
              metadata, created_at, updated_at
       FROM pharmacy_suppliers
       WHERE ${filters.join(' AND ')}
       ORDER BY display_name
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { suppliers: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { suppliers: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Inventory items
// ---------------------------------------------------------------------------

const ITEM_RETURNING = `id, tenant_id, facility_id, sku_code, display_name,
  generic_name, brand_name, manufacturer, form, strength, unit_label, pack_size,
  hsn_code, schedule_class, is_narcotic, is_cold_chain,
  reorder_level, reorder_quantity, default_supplier_id,
  status, metadata, created_at, updated_at`;

export async function upsertInventoryItem({
  tenantId = null, id = null, facilityId = null,
  skuCode, displayName, genericName = null, brandName = null,
  manufacturer = null, form = null, strength = null,
  unitLabel = 'each', packSize = null, hsnCode = null, scheduleClass = null,
  isNarcotic = false, isColdChain = false,
  reorderLevel = null, reorderQuantity = null,
  defaultSupplierId = null,
  status = 'active', metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanCode = safeText(skuCode, 120);
  if (!cleanCode) throw AppError.badRequest('sku_code is required');
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const args = [
    facilityId ? normalizeId(facilityId, 'facility_id') : null,
    cleanCode, cleanName,
    safeText(genericName, SHORT_MAX), safeText(brandName, SHORT_MAX),
    safeText(manufacturer, SHORT_MAX), safeText(form, 80), safeText(strength, 80),
    safeText(unitLabel, 40) || 'each',
    normalizeInt(packSize, 'pack_size', { min: 0, max: 1_000_000 }),
    safeText(hsnCode, 40), safeText(scheduleClass, 20),
    normalizeBoolean(isNarcotic, false), normalizeBoolean(isColdChain, false),
    normalizeInt(reorderLevel, 'reorder_level', { min: 0, max: 1_000_000 }),
    normalizeInt(reorderQuantity, 'reorder_quantity', { min: 0, max: 1_000_000 }),
    defaultSupplierId ? normalizeId(defaultSupplierId, 'default_supplier_id') : null,
    normalizeEnum(status, ITEM_STATUSES, 'status') || 'active',
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  ];
  try {
    if (id) {
      const itemId = normalizeId(id, 'inventory_item id');
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE pharmacy_inventory_items SET
           facility_id = $1, sku_code = $2, display_name = $3,
           generic_name = $4, brand_name = $5, manufacturer = $6,
           form = $7, strength = $8, unit_label = $9, pack_size = $10,
           hsn_code = $11, schedule_class = $12,
           is_narcotic = $13, is_cold_chain = $14,
           reorder_level = $15, reorder_quantity = $16, default_supplier_id = $17,
           status = $18, metadata = $19::jsonb, updated_at = NOW()
         WHERE id = $20 AND tenant_id = $21::uuid
         RETURNING ${ITEM_RETURNING}`,
        ...args, itemId, tid,
      );
      if (!rows[0]) throw AppError.notFound('Inventory item not found');
      return rows[0];
    }
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, facility_id, sku_code, display_name,
          generic_name, brand_name, manufacturer, form, strength, unit_label, pack_size,
          hsn_code, schedule_class, is_narcotic, is_cold_chain,
          reorder_level, reorder_quantity, default_supplier_id, status, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb)
       RETURNING ${ITEM_RETURNING}`,
      tid, ...args,
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('sku_code already exists');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid default_supplier_id or facility_id');
    throw err;
  }
}

export async function listInventoryItems({
  tenantId = null, facilityId = null, status = null,
  isNarcotic = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (facilityId) {
    params.push(normalizeId(facilityId, 'facility_id'));
    filters.push(`facility_id = $${params.length}`);
  }
  if (status) {
    params.push(normalizeEnum(status, ITEM_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (isNarcotic !== null) {
    params.push(normalizeBoolean(isNarcotic));
    filters.push(`is_narcotic = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${ITEM_RETURNING} FROM pharmacy_inventory_items
       WHERE ${filters.join(' AND ')}
       ORDER BY display_name
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { items: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { items: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Inventory batches + receive flow (with stock-movement ledger entry)
// ---------------------------------------------------------------------------

const BATCH_RETURNING = `id, tenant_id, inventory_item_id, facility_id,
  batch_number, lot_number, manufacture_date, expiry_date,
  received_quantity, remaining_quantity, unit_cost_minor, mrp_minor,
  supplier_id, goods_receipt_id, storage_location_id, status,
  recall_reference, metadata, created_at, updated_at`;

/**
 * Add a new batch (call from a GRN flow). Inserts the batch + writes
 * a 'receive' stock_movement row in one transaction.
 */
export async function addInventoryBatch({
  tenantId = null,
  inventoryItemId,
  facilityId = null,
  batchNumber,
  lotNumber = null,
  manufactureDate = null,
  expiryDate,
  receivedQuantity,
  unitCostMinor = null,
  mrpMinor = null,
  supplierId = null,
  goodsReceiptId = null,
  storageLocationId = null,
  performedBy = null,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const itemId = normalizeId(inventoryItemId, 'inventory_item_id');
  const cleanBatch = safeText(batchNumber, 120);
  if (!cleanBatch) throw AppError.badRequest('batch_number is required');
  const cleanExpiry = normalizeDate(expiryDate, 'expiry_date', { required: true });
  const qty = normalizeQuantity(receivedQuantity, 'received_quantity', { min: 0, required: true });

  try {
    const insertRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, facility_id,
          batch_number, lot_number, manufacture_date, expiry_date,
          received_quantity, remaining_quantity, unit_cost_minor, mrp_minor,
          supplier_id, goods_receipt_id, storage_location_id, status, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::date, $7::date,
               $8, $8, $9, $10,
               $11, $12, $13, 'in_stock', $14::jsonb)
       RETURNING ${BATCH_RETURNING}`,
      tid, itemId,
      facilityId ? normalizeId(facilityId, 'facility_id') : null,
      cleanBatch, safeText(lotNumber, 120),
      normalizeDate(manufactureDate, 'manufacture_date'),
      cleanExpiry, qty,
      normalizeBigInt(unitCostMinor, 'unit_cost_minor', { min: 0, max: 1_000_000_000_000 }),
      normalizeBigInt(mrpMinor, 'mrp_minor', { min: 0, max: 1_000_000_000_000 }),
      supplierId ? normalizeId(supplierId, 'supplier_id') : null,
      goodsReceiptId ? normalizeId(goodsReceiptId, 'goods_receipt_id') : null,
      storageLocationId ? normalizeId(storageLocationId, 'storage_location_id') : null,
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    const batch = insertRows[0];

    // Append the 'receive' stock movement.
    try {
      await prisma.$queryRawUnsafe(
        `INSERT INTO pharmacy_stock_movements
           (tenant_id, inventory_item_id, inventory_batch_id, movement_kind,
            quantity_delta, reference_type, reference_id, performed_by, notes)
         VALUES ($1::uuid, $2, $3, 'receive', $4, $5, $6, $7::uuid, $8)`,
        tid, itemId, batch.id, qty,
        goodsReceiptId ? 'goods_receipt' : null,
        goodsReceiptId ? String(goodsReceiptId) : null,
        maybeUuid(performedBy, 'performed_by'),
        `Batch ${batch.batch_number} received`,
      );
    } catch (err) {
      if (!isMissingSchemaError(err)) throw err;
    }
    return batch;
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('batch_number already exists for this item');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

/**
 * FEFO consumption helper. Decrements remaining_quantity in oldest-
 * expiry-first order, writing one stock_movement row per batch hit.
 * Returns the per-batch breakdown of what was consumed.
 *
 * Caller is expected to wrap this in a transaction if atomic
 * behaviour against external state matters.
 */
export async function reserveStock({
  tenantId = null,
  inventoryItemId,
  quantity,
  movementKind = 'issue',
  referenceType = null,
  referenceId = null,
  performedBy = null,
  notes = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const itemId = normalizeId(inventoryItemId, 'inventory_item_id');
  const want = normalizeQuantity(quantity, 'quantity', { min: 0.0001, required: true });
  const cleanKind = normalizeEnum(movementKind, MOVEMENT_KINDS, 'movement_kind') || 'issue';

  // Pull all in_stock batches FEFO. Caller can wrap in setTenant for RLS.
  const batches = await prisma.$queryRawUnsafe(
    `SELECT id, batch_number, expiry_date, remaining_quantity
     FROM pharmacy_inventory_batches
     WHERE tenant_id = $1::uuid AND inventory_item_id = $2 AND status = 'in_stock'
       AND remaining_quantity > 0
     ORDER BY expiry_date ASC, id ASC`,
    tid, itemId,
  );
  let remainingNeed = want;
  const consumed = [];
  for (const batch of batches) {
    if (remainingNeed <= 0) break;
    const take = Math.min(Number(batch.remaining_quantity), remainingNeed);
    if (take <= 0) continue;
    const newRemaining = Number(batch.remaining_quantity) - take;
    const updated = await prisma.$queryRawUnsafe(
      `UPDATE pharmacy_inventory_batches
       SET remaining_quantity = $1,
           status = CASE WHEN $1 = 0 THEN 'depleted' ELSE status END,
           updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3::uuid AND remaining_quantity = $4
       RETURNING ${BATCH_RETURNING}`,
      newRemaining, batch.id, tid, batch.remaining_quantity,
    );
    if (!updated[0]) {
      // Concurrent update — caller should retry the whole operation.
      throw AppError.conflict('Concurrent batch update; retry the reservation');
    }
    try {
      await prisma.$queryRawUnsafe(
        `INSERT INTO pharmacy_stock_movements
           (tenant_id, inventory_item_id, inventory_batch_id, movement_kind,
            quantity_delta, reference_type, reference_id, performed_by, notes)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::uuid, $9)`,
        tid, itemId, batch.id, cleanKind,
        -take, safeText(referenceType, 60), safeText(referenceId, 120),
        maybeUuid(performedBy, 'performed_by'), safeText(notes),
      );
    } catch (err) {
      if (!isMissingSchemaError(err)) throw err;
    }
    consumed.push({ batch_id: batch.id, batch_number: batch.batch_number, quantity_taken: take });
    remainingNeed -= take;
  }
  return {
    requested: want,
    fulfilled: want - remainingNeed,
    short_by: remainingNeed,
    consumed,
  };
}

export async function listBatches({
  tenantId = null, inventoryItemId = null, status = null,
  expiringWithinDays = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (inventoryItemId) {
    params.push(normalizeId(inventoryItemId, 'inventory_item_id'));
    filters.push(`inventory_item_id = $${params.length}`);
  }
  if (status) {
    params.push(normalizeEnum(status, BATCH_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (expiringWithinDays !== null && expiringWithinDays !== undefined) {
    const days = normalizeInt(expiringWithinDays, 'expiring_within_days', { min: 0, max: 3650 });
    params.push(days);
    filters.push(`expiry_date <= CURRENT_DATE + ($${params.length}::int * INTERVAL '1 day')`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${BATCH_RETURNING} FROM pharmacy_inventory_batches
       WHERE ${filters.join(' AND ')}
       ORDER BY expiry_date ASC, id ASC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { batches: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { batches: [], count: 0 };
    throw err;
  }
}

export async function recallBatch({
  tenantId = null, id, recallReference = null, performedBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const batchId = normalizeId(id, 'batch id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE pharmacy_inventory_batches
     SET status = 'recalled', recall_reference = $1, updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3::uuid AND status NOT IN ('disposed', 'expired', 'recalled')
     RETURNING ${BATCH_RETURNING}`,
    safeText(recallReference, 255), batchId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Batch not found or not in a recallable state');
  try {
    await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_stock_movements
         (tenant_id, inventory_item_id, inventory_batch_id, movement_kind,
          quantity_delta, performed_by, notes)
       VALUES ($1::uuid, $2, $3, 'recall', 0, $4::uuid, $5)`,
      tid, rows[0].inventory_item_id, batchId,
      maybeUuid(performedBy, 'performed_by'),
      safeText(recallReference, 255),
    );
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
  }
  return rows[0];
}

// ---------------------------------------------------------------------------
// Purchase orders + items
// ---------------------------------------------------------------------------

const PO_RETURNING = `id, tenant_id, facility_id, po_number, supplier_id, status,
  ordered_at, expected_at, received_at, total_amount_minor, currency,
  notes, approved_by, approved_at, cancellation_reason,
  metadata, created_by, created_at, updated_at`;

export async function createPurchaseOrder({
  tenantId = null, facilityId = null,
  poNumber, supplierId, status = 'draft',
  expectedAt = null, totalAmountMinor = null,
  currency = 'INR', notes = null, metadata = null, createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanNumber = safeText(poNumber, 80);
  if (!cleanNumber) throw AppError.badRequest('po_number is required');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_purchase_orders
         (tenant_id, facility_id, po_number, supplier_id, status,
          expected_at, total_amount_minor, currency, notes,
          metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10::jsonb, $11::uuid)
       RETURNING ${PO_RETURNING}`,
      tid, facilityId ? normalizeId(facilityId, 'facility_id') : null,
      cleanNumber, normalizeId(supplierId, 'supplier_id'),
      normalizeEnum(status, PO_STATUSES, 'status') || 'draft',
      expectedAt ? new Date(String(expectedAt)).toISOString() : null,
      normalizeBigInt(totalAmountMinor, 'total_amount_minor', { min: 0, max: 1_000_000_000_000 }),
      safeText(currency, 8) || 'INR',
      safeText(notes),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('po_number already exists');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid supplier_id or facility_id');
    throw err;
  }
}

export async function transitionPurchaseOrder({
  tenantId = null, id, nextStatus, cancellationReason = null, approvedBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const poId = normalizeId(id, 'purchase_order id');
  const cleanStatus = normalizeEnum(nextStatus, PO_STATUSES, 'next_status', { required: true });
  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [cleanStatus];
  if (cleanStatus === 'submitted') {
    params.push(new Date().toISOString());
    updates.push(`ordered_at = $${params.length}::timestamptz`);
  }
  if (cleanStatus === 'approved') {
    params.push(new Date().toISOString());
    updates.push(`approved_at = $${params.length}::timestamptz`);
    if (approvedBy) {
      params.push(maybeUuid(approvedBy, 'approved_by'));
      updates.push(`approved_by = $${params.length}::uuid`);
    }
  }
  if (cleanStatus === 'fully_received') {
    params.push(new Date().toISOString());
    updates.push(`received_at = $${params.length}::timestamptz`);
  }
  if (cleanStatus === 'cancelled' && cancellationReason) {
    params.push(safeText(cancellationReason));
    updates.push(`cancellation_reason = $${params.length}`);
  }
  params.push(poId);
  params.push(tid);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE pharmacy_purchase_orders SET ${updates.join(', ')}
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
     RETURNING ${PO_RETURNING}`,
    ...params,
  );
  if (!rows[0]) throw AppError.notFound('Purchase order not found');
  return rows[0];
}

export async function addPurchaseOrderItem({
  tenantId = null, purchaseOrderId, inventoryItemId,
  orderedQuantity, unitPriceMinor = null, taxRatePct = null, notes = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const poId = normalizeId(purchaseOrderId, 'purchase_order_id');
  const itemId = normalizeId(inventoryItemId, 'inventory_item_id');
  const qty = normalizeQuantity(orderedQuantity, 'ordered_quantity', { min: 0, required: true });
  let taxRate = null;
  if (taxRatePct !== null && taxRatePct !== undefined) {
    const v = Number(taxRatePct);
    if (!Number.isFinite(v) || v < 0 || v > 100) throw AppError.badRequest('tax_rate_pct must be 0..100');
    taxRate = v;
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_purchase_order_items
         (tenant_id, purchase_order_id, inventory_item_id,
          ordered_quantity, unit_price_minor, tax_rate_pct, notes)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
       RETURNING id, tenant_id, purchase_order_id, inventory_item_id,
                 ordered_quantity, received_quantity, unit_price_minor,
                 tax_rate_pct, notes, metadata, created_at, updated_at`,
      tid, poId, itemId, qty,
      normalizeBigInt(unitPriceMinor, 'unit_price_minor', { min: 0, max: 1_000_000_000_000 }),
      taxRate, safeText(notes),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('inventory_item already on this PO');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid purchase_order_id or inventory_item_id');
    throw err;
  }
}

export async function listPurchaseOrders({
  tenantId = null, supplierId = null, status = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (supplierId) {
    params.push(normalizeId(supplierId, 'supplier_id'));
    filters.push(`supplier_id = $${params.length}`);
  }
  if (status) {
    params.push(normalizeEnum(status, PO_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${PO_RETURNING} FROM pharmacy_purchase_orders
       WHERE ${filters.join(' AND ')}
       ORDER BY ordered_at DESC NULLS LAST, created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { purchase_orders: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { purchase_orders: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Goods receipts (GRN)
// ---------------------------------------------------------------------------

export async function createGoodsReceipt({
  tenantId = null, facilityId = null,
  grnNumber, purchaseOrderId = null, supplierId = null,
  invoiceNumber = null, invoiceDate = null, totalAmountMinor = null,
  notes = null, receivedBy = null, metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanNumber = safeText(grnNumber, 80);
  if (!cleanNumber) throw AppError.badRequest('grn_number is required');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_goods_receipts
         (tenant_id, facility_id, grn_number, purchase_order_id, supplier_id,
          invoice_number, invoice_date, status, total_amount_minor, notes,
          received_by, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::date, 'received', $8, $9, $10::uuid, $11::jsonb)
       RETURNING id, tenant_id, facility_id, grn_number, purchase_order_id, supplier_id,
                 invoice_number, invoice_date, received_at, status, total_amount_minor,
                 notes, received_by, metadata, created_at, updated_at`,
      tid, facilityId ? normalizeId(facilityId, 'facility_id') : null,
      cleanNumber,
      purchaseOrderId ? normalizeId(purchaseOrderId, 'purchase_order_id') : null,
      supplierId ? normalizeId(supplierId, 'supplier_id') : null,
      safeText(invoiceNumber, 120),
      normalizeDate(invoiceDate, 'invoice_date'),
      normalizeBigInt(totalAmountMinor, 'total_amount_minor', { min: 0, max: 1_000_000_000_000 }),
      safeText(notes),
      maybeUuid(receivedBy, 'received_by'),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('grn_number already exists');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid purchase_order_id or supplier_id');
    throw err;
  }
}

export async function listGoodsReceipts({
  tenantId = null, status = null, supplierId = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, GRN_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (supplierId) {
    params.push(normalizeId(supplierId, 'supplier_id'));
    filters.push(`supplier_id = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, facility_id, grn_number, purchase_order_id, supplier_id,
              invoice_number, invoice_date, received_at, status, total_amount_minor,
              notes, received_by, metadata, created_at, updated_at
       FROM pharmacy_goods_receipts
       WHERE ${filters.join(' AND ')}
       ORDER BY received_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { goods_receipts: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { goods_receipts: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Stock movements
// ---------------------------------------------------------------------------

export async function appendStockMovement({
  tenantId = null,
  inventoryItemId,
  inventoryBatchId = null,
  movementKind,
  quantityDelta,
  referenceType = null,
  referenceId = null,
  performedBy = null,
  notes = null,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const itemId = normalizeId(inventoryItemId, 'inventory_item_id');
  const cleanKind = normalizeEnum(movementKind, MOVEMENT_KINDS, 'movement_kind', { required: true });
  const delta = Number(quantityDelta);
  if (!Number.isFinite(delta)) throw AppError.badRequest('quantity_delta must be numeric');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_stock_movements
         (tenant_id, inventory_item_id, inventory_batch_id, movement_kind,
          quantity_delta, reference_type, reference_id, performed_by, notes, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::uuid, $9, $10::jsonb)
       RETURNING id, tenant_id, inventory_item_id, inventory_batch_id, movement_kind,
                 quantity_delta, reference_type, reference_id, performed_by,
                 notes, metadata, created_at`,
      tid, itemId,
      inventoryBatchId ? normalizeId(inventoryBatchId, 'inventory_batch_id') : null,
      cleanKind, delta,
      safeText(referenceType, 60), safeText(referenceId, 120),
      maybeUuid(performedBy, 'performed_by'),
      safeText(notes),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function listStockMovements({
  tenantId = null, inventoryItemId = null, inventoryBatchId = null,
  movementKind = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (inventoryItemId) {
    params.push(normalizeId(inventoryItemId, 'inventory_item_id'));
    filters.push(`inventory_item_id = $${params.length}`);
  }
  if (inventoryBatchId) {
    params.push(normalizeId(inventoryBatchId, 'inventory_batch_id'));
    filters.push(`inventory_batch_id = $${params.length}`);
  }
  if (movementKind) {
    params.push(normalizeEnum(movementKind, MOVEMENT_KINDS, 'movement_kind'));
    filters.push(`movement_kind = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, inventory_item_id, inventory_batch_id, movement_kind,
              quantity_delta, reference_type, reference_id, performed_by,
              notes, metadata, created_at
       FROM pharmacy_stock_movements
       WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { movements: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { movements: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Expiry alerts
// ---------------------------------------------------------------------------

/**
 * Scan in-stock batches expiring within `lookaheadDays` days and
 * create / refresh expiry_alerts. Idempotent — uses a per-(batch)
 * upsert via existing alert lookup.
 */
export async function computeExpiryAlerts({
  tenantId = null, lookaheadDays = 90,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const days = normalizeInt(lookaheadDays, 'lookahead_days', { min: 1, max: 3650 });
  let scanned = 0;
  let created = 0;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, inventory_item_id, expiry_date,
              (expiry_date - CURRENT_DATE)::int AS days_remaining
       FROM pharmacy_inventory_batches
       WHERE tenant_id = $1::uuid AND status IN ('in_stock', 'reserved')
         AND expiry_date <= CURRENT_DATE + ($2::int * INTERVAL '1 day')`,
      tid, days,
    );
    scanned = rows.length;
    for (const row of rows) {
      const severity = severityForDaysRemaining(row.days_remaining);
      try {
        const existing = await prisma.$queryRawUnsafe(
          `SELECT id FROM pharmacy_expiry_alerts
           WHERE tenant_id = $1::uuid AND inventory_batch_id = $2 AND status = 'open'
           LIMIT 1`,
          tid, row.id,
        );
        if (existing[0]) {
          await prisma.$queryRawUnsafe(
            `UPDATE pharmacy_expiry_alerts
             SET days_remaining = $1, severity = $2, updated_at = NOW()
             WHERE id = $3 AND tenant_id = $4::uuid`,
            row.days_remaining, severity, existing[0].id, tid,
          );
        } else {
          await prisma.$queryRawUnsafe(
            `INSERT INTO pharmacy_expiry_alerts
               (tenant_id, inventory_batch_id, inventory_item_id,
                expiry_date, days_remaining, severity, status)
             VALUES ($1::uuid, $2, $3, $4::date, $5, $6, 'open')`,
            tid, row.id, row.inventory_item_id, row.expiry_date,
            row.days_remaining, severity,
          );
          created += 1;
        }
      } catch (err) {
        if (!isMissingSchemaError(err)) throw err;
      }
    }
    return { scanned, created, lookahead_days: days };
  } catch (err) {
    if (isMissingSchemaError(err)) return { scanned: 0, created: 0, lookahead_days: days };
    throw err;
  }
}

export async function acknowledgeExpiryAlert({
  tenantId = null, id, acknowledgedBy, resolution = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const alertId = normalizeId(id, 'expiry_alert id');
  const ackedBy = maybeUuid(acknowledgedBy, 'acknowledged_by');
  if (!ackedBy) throw AppError.badRequest('acknowledged_by is required');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE pharmacy_expiry_alerts
     SET status = 'acknowledged', acknowledged_by = $1::uuid, acknowledged_at = NOW(),
         resolution = $2, updated_at = NOW()
     WHERE id = $3 AND tenant_id = $4::uuid AND status = 'open'
     RETURNING id, tenant_id, inventory_batch_id, inventory_item_id,
               expiry_date, days_remaining, severity, status,
               acknowledged_by, acknowledged_at, resolution, resolved_at,
               metadata, created_at, updated_at`,
    ackedBy, safeText(resolution, 40), alertId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Expiry alert not found or not open');
  return rows[0];
}

export async function listExpiryAlerts({
  tenantId = null, status = null, severity = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, EXPIRY_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (severity) {
    params.push(normalizeEnum(severity, EXPIRY_SEVERITIES, 'severity'));
    filters.push(`severity = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, inventory_batch_id, inventory_item_id,
              expiry_date, days_remaining, severity, status,
              acknowledged_by, acknowledged_at, resolution, resolved_at,
              metadata, created_at, updated_at
       FROM pharmacy_expiry_alerts
       WHERE ${filters.join(' AND ')}
       ORDER BY expiry_date, severity DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { alerts: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { alerts: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Substitutes
// ---------------------------------------------------------------------------

export async function addSubstitute({
  tenantId = null, primaryItemId, substituteItemId,
  substitutionKind = 'generic_equivalent', isBidirectional = true, notes = null,
  status = 'active', metadata = null, createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const primaryId = normalizeId(primaryItemId, 'primary_item_id');
  const substituteId = normalizeId(substituteItemId, 'substitute_item_id');
  if (primaryId === substituteId) {
    throw AppError.badRequest('primary_item_id and substitute_item_id must differ');
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_substitutes
         (tenant_id, primary_item_id, substitute_item_id, substitution_kind,
          is_bidirectional, notes, status, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::uuid)
       RETURNING id, tenant_id, primary_item_id, substitute_item_id,
                 substitution_kind, is_bidirectional, notes, status,
                 metadata, created_by, created_at, updated_at`,
      tid, primaryId, substituteId,
      normalizeEnum(substitutionKind, SUBSTITUTE_KINDS, 'substitution_kind') || 'generic_equivalent',
      normalizeBoolean(isBidirectional, true),
      safeText(notes),
      normalizeEnum(status, ['active', 'paused', 'archived'], 'status') || 'active',
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('Substitute pair already exists');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid item_id reference');
    throw err;
  }
}

export async function listSubstitutes({
  tenantId = null, primaryItemId = null, status = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (primaryItemId) {
    params.push(normalizeId(primaryItemId, 'primary_item_id'));
    if (filters.length === 1) {
      // Look up by either direction (primary or substitute) when bidirectional.
      filters.push(`(primary_item_id = $${params.length} OR (substitute_item_id = $${params.length} AND is_bidirectional = true))`);
    }
  }
  if (status) {
    params.push(normalizeEnum(status, ['active', 'paused', 'archived'], 'status'));
    filters.push(`status = $${params.length}`);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, primary_item_id, substitute_item_id, substitution_kind,
              is_bidirectional, notes, status, metadata, created_by, created_at, updated_at
       FROM pharmacy_substitutes
       WHERE ${filters.join(' AND ')}
       ORDER BY substitution_kind, primary_item_id`,
      ...params,
    );
    return { substitutes: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { substitutes: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// GRN line orchestration + forecast bridge (C4 follow-up)
// ---------------------------------------------------------------------------

/**
 * Atomic GRN-line orchestration. In one prisma.$transaction:
 *   1. INSERT pharmacy_inventory_batches (status='in_stock', remaining=received)
 *   2. UPDATE pharmacy_purchase_order_items.received_quantity by +received,
 *      conditional on (received + delta) <= ordered (refuses over-receive
 *      with 409; the chk_po_received_lte_ordered DB CHECK is the backstop)
 *   3. INSERT pharmacy_goods_receipt_items linking GRN + PO line + batch
 *   4. INSERT pharmacy_stock_movements (movement_kind='receive')
 *   5. Recompute parent PO progress and transition status to
 *      'fully_received' (sum_received >= sum_ordered) or 'partially_received'.
 *
 * Any failure rolls the whole receipt back.
 */
export async function receivePurchaseOrderLine({
  tenantId = null,
  purchaseOrderItemId,
  goodsReceiptId,
  batchNumber,
  expiryDate,
  receivedQuantity,
  lotNumber = null,
  manufactureDate = null,
  unitCostMinor = null,
  supplierId = null,
  performedBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const poiId = normalizeId(purchaseOrderItemId, 'purchase_order_item_id');
  const grnId = normalizeId(goodsReceiptId, 'goods_receipt_id');
  const cleanBatch = safeText(batchNumber, 120);
  if (!cleanBatch) throw AppError.badRequest('batch_number is required');
  const cleanExpiry = normalizeDate(expiryDate, 'expiry_date', { required: true });
  const cleanManufacture = normalizeDate(manufactureDate, 'manufacture_date');
  const qty = normalizeQuantity(receivedQuantity, 'received_quantity', { min: 0.0001, required: true });
  const cost = normalizeBigInt(unitCostMinor, 'unit_cost_minor', { min: 0, max: 1_000_000_000_000 });
  const supId = supplierId ? normalizeId(supplierId, 'supplier_id') : null;
  const cleanLot = safeText(lotNumber, 120);
  const performerUid = maybeUuid(performedBy, 'performed_by');

  return setTenantTx(tid || DEFAULT_TENANT_ID, async (tx) => {
    // 1. Resolve the PO line — gives us inventory_item_id + parent PO id.
    const lines = await tx.$queryRawUnsafe(
      `SELECT id, purchase_order_id, inventory_item_id, ordered_quantity, received_quantity
       FROM pharmacy_purchase_order_items
       WHERE id = $1 AND tenant_id = $2::uuid`,
      poiId, tid,
    );
    if (!lines[0]) throw AppError.notFound('Purchase order line not found');
    const itemId = Number(lines[0].inventory_item_id);
    const parentPoId = Number(lines[0].purchase_order_id);

    // 2. Insert the new batch.
    let batch;
    try {
      const inserted = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_inventory_batches
           (tenant_id, inventory_item_id, batch_number, lot_number, manufacture_date,
            expiry_date, received_quantity, remaining_quantity, unit_cost_minor,
            supplier_id, goods_receipt_id, status)
         VALUES ($1::uuid, $2, $3, $4, $5::date, $6::date, $7, $7, $8, $9, $10, 'in_stock')
         RETURNING ${BATCH_RETURNING}`,
        tid, itemId, cleanBatch, cleanLot, cleanManufacture, cleanExpiry,
        qty, cost, supId, grnId,
      );
      batch = inserted[0];
    } catch (err) {
      if (isUniqueViolation(err)) throw AppError.conflict('batch_number already exists for this item');
      if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
      throw err;
    }

    // 3. Bump received_quantity on the PO line — refuse on over-receive.
    const updated = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_purchase_order_items
       SET received_quantity = received_quantity + $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3::uuid
         AND received_quantity + $1 <= ordered_quantity
       RETURNING id, purchase_order_id, ordered_quantity, received_quantity`,
      qty, poiId, tid,
    );
    if (!updated[0]) {
      throw AppError.conflict('Receiving this quantity would exceed ordered_quantity for this PO line');
    }

    // 4. Insert the GRN line linking GRN + PO line + batch.
    const grnItemRows = await tx.$queryRawUnsafe(
      `INSERT INTO pharmacy_goods_receipt_items
         (tenant_id, goods_receipt_id, inventory_item_id, inventory_batch_id,
          purchase_order_item_id, received_quantity, unit_cost_minor)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
       RETURNING id, tenant_id, goods_receipt_id, inventory_item_id, inventory_batch_id,
                 purchase_order_item_id, received_quantity, unit_cost_minor,
                 qc_status, qc_notes, metadata, created_at, updated_at`,
      tid, grnId, itemId, batch.id, poiId, qty, cost,
    );

    // 5. Append the 'receive' stock-movement ledger entry.
    await tx.$queryRawUnsafe(
      `INSERT INTO pharmacy_stock_movements
         (tenant_id, inventory_item_id, inventory_batch_id, movement_kind,
          quantity_delta, reference_type, reference_id, performed_by, notes)
       VALUES ($1::uuid, $2, $3, 'receive', $4, 'goods_receipt', $5, $6::uuid, $7)`,
      tid, itemId, batch.id, qty, String(grnId), performerUid,
      `Received via GRN ${grnId}, batch ${cleanBatch}`,
    );

    // 6. Recompute PO progress and auto-transition the parent header.
    const aggRows = await tx.$queryRawUnsafe(
      `SELECT
         COALESCE(SUM(ordered_quantity), 0)::numeric AS total_ordered,
         COALESCE(SUM(received_quantity), 0)::numeric AS total_received,
         COUNT(*) FILTER (WHERE received_quantity > 0)::int AS partial_count
       FROM pharmacy_purchase_order_items
       WHERE purchase_order_id = $1 AND tenant_id = $2::uuid`,
      parentPoId, tid,
    );
    const totalOrdered = Number(aggRows[0]?.total_ordered || 0);
    const totalReceived = Number(aggRows[0]?.total_received || 0);
    const partialCount = Number(aggRows[0]?.partial_count || 0);

    let parentStatus = null;
    if (totalOrdered > 0 && totalReceived >= totalOrdered) {
      parentStatus = 'fully_received';
    } else if (partialCount > 0) {
      parentStatus = 'partially_received';
    }

    let parent = null;
    if (parentStatus) {
      const parentRows = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_purchase_orders
         SET status = $1,
             received_at = CASE WHEN $1 = 'fully_received' THEN NOW() ELSE received_at END,
             updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3::uuid
         RETURNING ${PO_RETURNING}`,
        parentStatus, parentPoId, tid,
      );
      parent = parentRows[0] || null;
    }

    return {
      batch,
      goods_receipt_item: grnItemRows[0],
      purchase_order_item: updated[0],
      purchase_order: parent,
      total_ordered: totalOrdered,
      total_received: totalReceived,
    };
  });
}

/**
 * Bridge the existing clinical_ai_inventory_alerts forecast surface to the
 * new pharmacy_inventory_batches data: walks every active inventory_item
 * with reorder_level set, computes on-hand from in_stock+reserved batches,
 * computes consumption_per_day from 'issue' stock movements over the
 * lookback window, then forecasts days_to_reorder. Best-effort writes a
 * clinical_ai_inventory_alerts row when days_to_reorder < 14. Degrades
 * silently on schema-missing.
 */
export async function bridgeForecastToBatches({
  tenantId = null, lookbackDays = 30,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const requestedDays = normalizeInt(lookbackDays, 'lookback_days', { min: 1, max: 365 });
  const days = requestedDays || 30;

  let items;
  try {
    items = await prisma.$queryRawUnsafe(
      `SELECT id, sku_code, display_name, reorder_level
       FROM pharmacy_inventory_items
       WHERE tenant_id = $1::uuid AND reorder_level IS NOT NULL AND status = 'active'`,
      tid,
    );
  } catch (err) {
    if (isMissingSchemaError(err)) return { items: [], count: 0, lookback_days: days };
    throw err;
  }

  const result = [];
  for (const item of items) {
    let onHand = 0;
    let consumptionPerDay = 0;

    try {
      const stockRows = await prisma.$queryRawUnsafe(
        `SELECT COALESCE(SUM(remaining_quantity), 0)::numeric AS on_hand
         FROM pharmacy_inventory_batches
         WHERE tenant_id = $1::uuid AND inventory_item_id = $2
           AND status IN ('in_stock', 'reserved')`,
        tid, item.id,
      );
      onHand = Number(stockRows[0]?.on_hand || 0);
    } catch (err) {
      if (!isMissingSchemaError(err)) throw err;
    }

    try {
      const issuedRows = await prisma.$queryRawUnsafe(
        `SELECT COALESCE(SUM(-quantity_delta), 0)::numeric AS total_issued
         FROM pharmacy_stock_movements
         WHERE tenant_id = $1::uuid AND inventory_item_id = $2
           AND movement_kind = 'issue'
           AND created_at >= NOW() - ($3::int * INTERVAL '1 day')`,
        tid, item.id, days,
      );
      consumptionPerDay = Number(issuedRows[0]?.total_issued || 0) / days;
    } catch (err) {
      if (!isMissingSchemaError(err)) throw err;
    }

    let daysToReorder = null;
    if (consumptionPerDay > 0) {
      daysToReorder = (onHand - Number(item.reorder_level)) / consumptionPerDay;
    }

    let alertWritten = false;
    if (daysToReorder !== null && daysToReorder < 14) {
      const alertCategory = daysToReorder <= 0 ? 'stockout_risk' : 'reorder_point_breach';
      const severity = daysToReorder <= 0 ? 'critical' : (daysToReorder < 7 ? 'high' : 'moderate');
      try {
        await prisma.$queryRawUnsafe(
          `INSERT INTO clinical_ai_inventory_alerts
             (tenant_id, item_sku, item_name, current_stock, reorder_point,
              avg_daily_usage, baseline_daily_usage, alert_category, severity,
              summary, signals)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
          tid,
          safeText(item.sku_code, 120) || 'unknown',
          safeText(item.display_name, 200) || 'unknown',
          onHand,
          Number(item.reorder_level),
          consumptionPerDay,
          consumptionPerDay,
          alertCategory,
          severity,
          `Forecast: ${daysToReorder.toFixed(1)} days to reorder threshold (consumption ${consumptionPerDay.toFixed(2)}/day, on-hand ${onHand})`,
          JSON.stringify([{
            kind: 'forecast_bridge',
            days_to_reorder: daysToReorder,
            lookback_days: days,
          }]),
        );
        alertWritten = true;
      } catch (err) {
        if (!isMissingSchemaError(err)) throw err;
      }
    }

    result.push({
      inventory_item_id: Number(item.id),
      on_hand: onHand,
      consumption_per_day: consumptionPerDay,
      days_to_reorder: daysToReorder,
      alert_written: alertWritten,
    });
  }

  return { items: result, count: result.length, lookback_days: days };
}

export const __testing__ = {
  severityForDaysRemaining,
  MOVEMENT_KINDS,
  BATCH_STATUSES,
  PO_STATUSES,
  EXPIRY_SEVERITIES,
};

export default {
  upsertSupplier,
  listSuppliers,
  upsertInventoryItem,
  listInventoryItems,
  addInventoryBatch,
  reserveStock,
  listBatches,
  recallBatch,
  createPurchaseOrder,
  transitionPurchaseOrder,
  addPurchaseOrderItem,
  listPurchaseOrders,
  createGoodsReceipt,
  listGoodsReceipts,
  appendStockMovement,
  listStockMovements,
  computeExpiryAlerts,
  acknowledgeExpiryAlert,
  listExpiryAlerts,
  addSubstitute,
  listSubstitutes,
  receivePurchaseOrderLine,
  bridgeForecastToBatches,
};
