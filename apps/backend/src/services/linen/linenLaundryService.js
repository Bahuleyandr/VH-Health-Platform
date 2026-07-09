import { setTenant, setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const ITEM_CATEGORIES = new Set([
  'bed_linen',
  'patient_linen',
  'staff_linen',
  'ot_linen',
  'housekeeping',
  'other',
]);

const CYCLE_TRANSITIONS = {
  collection_requested: ['collected', 'cancelled'],
  collected: ['in_laundry', 'cancelled'],
  in_laundry: ['returned', 'cancelled'],
  returned: ['reconciled', 'cancelled'],
  reconciled: [],
  cancelled: [],
};

function tenantOr(value) {
  return requireTenantId(String(value || '').trim());
}

function unwrap(rows) {
  return Array.isArray(rows) ? rows[0] || null : rows || null;
}

function intId(value, field = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${field} must be a positive integer`, 'LINEN_BAD_ID');
  }
  return parsed;
}

function optionalIntId(value, field = 'id') {
  if (value === undefined || value === null || value === '') return null;
  return intId(value, field);
}

function quantity(value, field, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return 0;
    throw AppError.badRequest(`${field} is required`, 'LINEN_QUANTITY_REQUIRED');
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw AppError.badRequest(`${field} must be a non-negative integer`, 'LINEN_BAD_QUANTITY');
  }
  return parsed;
}

function cleanText(value, max = 255) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function cleanJson(value, fallback = {}) {
  if (value === undefined || value === null) return fallback;
  return value;
}

function boolValue(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  throw AppError.badRequest('active must be a boolean', 'LINEN_BAD_BOOLEAN');
}

function actorUid(context = {}) {
  return cleanText(context.actorUid || context.actor_uid || context.uid, 80);
}

function actorRole(context = {}) {
  return cleanText(context.actorRole || context.actor_role || context.role, 60);
}

function normalizeValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value?.toNumber === 'function') return value.toNumber();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, normalizeValue(val)]));
  }
  return value;
}

function normalizeRows(rows) {
  return normalizeValue(rows);
}

function cycleCode() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-8);
  return `LDR-${stamp}-${suffix}`;
}

function ensureTransition(current, next) {
  const allowed = CYCLE_TRANSITIONS[current] || [];
  if (!allowed.includes(next)) {
    throw AppError.invalidTransition(current, next, allowed);
  }
}

export function deriveCycleItemReconciliation({
  soiledCollectedQuantity = 0,
  cleanReturnedQuantity = 0,
  damagedQuantity = 0,
} = {}) {
  const collected = quantity(soiledCollectedQuantity, 'soiled_collected_quantity', { required: false });
  const returned = quantity(cleanReturnedQuantity, 'clean_returned_quantity', { required: false });
  const damaged = quantity(damagedQuantity, 'damaged_quantity', { required: false });
  const accounted = returned + damaged;
  const discrepancyQuantity = accounted - collected;
  return {
    soiled_collected_quantity: collected,
    clean_returned_quantity: returned,
    damaged_quantity: damaged,
    missing_quantity: Math.max(collected - accounted, 0),
    discrepancy_quantity: discrepancyQuantity,
    discrepancy_flag: discrepancyQuantity !== 0,
  };
}

export function applyParReconciliation({
  actualQuantity = 0,
  soiledCollectedQuantity = 0,
  cleanReturnedQuantity = 0,
} = {}) {
  const actual = quantity(actualQuantity, 'actual_quantity', { required: false });
  const collected = quantity(soiledCollectedQuantity, 'soiled_collected_quantity', { required: false });
  const returned = quantity(cleanReturnedQuantity, 'clean_returned_quantity', { required: false });
  return Math.max(actual - collected + returned, 0);
}

async function recordAudit(db, {
  tenantId,
  action,
  resource,
  resourceId,
  context = {},
  metadata = {},
}) {
  await db.$executeRawUnsafe(
    `INSERT INTO audit_logs
       (tenant_id, uid, role, action, resource, resource_id, metadata, actor_uid, created_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $2::uuid, NOW())`,
    tenantId,
    actorUid(context),
    actorRole(context),
    action,
    resource,
    String(resourceId),
    JSON.stringify(metadata),
  );
}

async function loadWard(db, wardId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, name
       FROM wards
      WHERE id = $1::int
      LIMIT 1`,
    intId(wardId, 'ward_id'),
  );
  const ward = unwrap(rows);
  if (!ward) throw AppError.notFound('Ward not found', 'LINEN_WARD_NOT_FOUND');
  return ward;
}

async function loadItemTypes(db, tenantId, itemTypeIds) {
  if (!itemTypeIds.length) return [];
  const rows = await db.$queryRawUnsafe(
    `SELECT id, item_code, display_name, active
       FROM linen_item_types
      WHERE tenant_id = $1::uuid
        AND id = ANY($2::bigint[])`,
    tenantId,
    itemTypeIds,
  );
  if (rows.length !== itemTypeIds.length) {
    throw AppError.notFound('One or more linen item types were not found', 'LINEN_ITEM_NOT_FOUND');
  }
  return rows;
}

function normalizePlannedItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest('items must contain at least one item', 'LINEN_ITEMS_REQUIRED');
  }
  const seen = new Set();
  return items.map((item, index) => {
    const itemTypeId = intId(item.item_type_id || item.itemTypeId, `items[${index}].item_type_id`);
    if (seen.has(itemTypeId)) {
      throw AppError.badRequest('Duplicate item_type_id in cycle items', 'LINEN_DUPLICATE_ITEM');
    }
    seen.add(itemTypeId);
    const planned = quantity(
      item.soiled_planned_quantity ?? item.soiledPlannedQuantity ?? item.quantity,
      `items[${index}].soiled_planned_quantity`,
    );
    return {
      item_type_id: itemTypeId,
      soiled_planned_quantity: planned,
      notes: cleanText(item.notes, 2000),
      metadata: cleanJson(item.metadata, {}),
    };
  });
}

function normalizeCollectionItems(items = []) {
  if (!Array.isArray(items)) {
    throw AppError.badRequest('items must be an array', 'LINEN_ITEMS_ARRAY_REQUIRED');
  }
  return items.map((item, index) => ({
    item_type_id: intId(item.item_type_id || item.itemTypeId, `items[${index}].item_type_id`),
    soiled_collected_quantity: quantity(
      item.soiled_collected_quantity ?? item.soiledCollectedQuantity ?? item.quantity,
      `items[${index}].soiled_collected_quantity`,
    ),
    notes: cleanText(item.notes, 2000),
  }));
}

function normalizeReturnItems(items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest('items must contain returned counts', 'LINEN_RETURN_ITEMS_REQUIRED');
  }
  return items.map((item, index) => ({
    item_type_id: intId(item.item_type_id || item.itemTypeId, `items[${index}].item_type_id`),
    ...deriveCycleItemReconciliation({
      soiledCollectedQuantity: item.soiled_collected_quantity ?? item.soiledCollectedQuantity ?? 0,
      cleanReturnedQuantity: item.clean_returned_quantity ?? item.cleanReturnedQuantity ?? item.quantity,
      damagedQuantity: item.damaged_quantity ?? item.damagedQuantity ?? 0,
    }),
    notes: cleanText(item.notes, 2000),
  }));
}

async function loadCycleForUpdate(db, tenantId, cycleId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT *
       FROM linen_laundry_cycles
      WHERE id = $1::bigint
        AND tenant_id = $2::uuid
      FOR UPDATE`,
    intId(cycleId, 'cycle_id'),
    tenantId,
  );
  const cycle = unwrap(rows);
  if (!cycle) throw AppError.notFound('Laundry cycle not found', 'LINEN_CYCLE_NOT_FOUND');
  return cycle;
}

async function selectCycleWithItems(db, tenantId, cycleId) {
  const cycleRows = await db.$queryRawUnsafe(
    `SELECT *
       FROM linen_laundry_cycles
      WHERE id = $1::bigint
        AND tenant_id = $2::uuid
      LIMIT 1`,
    intId(cycleId, 'cycle_id'),
    tenantId,
  );
  const cycle = unwrap(cycleRows);
  if (!cycle) return null;
  const items = await db.$queryRawUnsafe(
    `SELECT ci.*, it.item_code, it.display_name, it.category, it.unit
       FROM linen_laundry_cycle_items ci
       JOIN linen_item_types it ON it.id = ci.item_type_id AND it.tenant_id = ci.tenant_id
      WHERE ci.tenant_id = $1::uuid
        AND ci.cycle_id = $2::bigint
      ORDER BY it.display_name`,
    tenantId,
    cycle.id,
  );
  return normalizeValue({ ...cycle, items });
}

async function assertCycleItemsBelong(db, tenantId, cycleId, itemTypeIds) {
  if (!itemTypeIds.length) return;
  const rows = await db.$queryRawUnsafe(
    `SELECT item_type_id
       FROM linen_laundry_cycle_items
      WHERE tenant_id = $1::uuid
        AND cycle_id = $2::bigint
        AND item_type_id = ANY($3::bigint[])`,
    tenantId,
    intId(cycleId, 'cycle_id'),
    itemTypeIds,
  );
  if (rows.length !== itemTypeIds.length) {
    throw AppError.badRequest('One or more items are not part of this cycle', 'LINEN_ITEM_NOT_IN_CYCLE');
  }
}

async function updateCycleDiscrepancy(db, tenantId, cycleId) {
  const rows = await db.$queryRawUnsafe(
    `UPDATE linen_laundry_cycles c
        SET discrepancy_flag = EXISTS (
              SELECT 1
                FROM linen_laundry_cycle_items ci
               WHERE ci.cycle_id = c.id
                 AND ci.tenant_id = c.tenant_id
                 AND ci.discrepancy_flag = TRUE
            ),
            updated_at = NOW()
      WHERE c.id = $1::bigint
        AND c.tenant_id = $2::uuid
      RETURNING discrepancy_flag`,
    intId(cycleId, 'cycle_id'),
    tenantId,
  );
  return Boolean(unwrap(rows)?.discrepancy_flag);
}

export async function listItemTypes({ tenantId, active = null } = {}) {
  const safeTenant = tenantOr(tenantId);
  const rows = await setTenant(safeTenant, (tx) =>
    tx.$queryRawUnsafe(
      `SELECT *
         FROM linen_item_types
        WHERE tenant_id = $1::uuid
          AND ($2::boolean IS NULL OR active = $2::boolean)
        ORDER BY display_name`,
      safeTenant,
      boolValue(active, null),
    ));
  return normalizeRows(rows);
}

export async function upsertItemType(data = {}, context = {}) {
  const tenantId = tenantOr(data.tenantId || data.tenant_id || context.tenantId);
  const itemCode = cleanText(data.item_code || data.itemCode, 80);
  const displayName = cleanText(data.display_name || data.displayName || data.name, 160);
  if (!itemCode) throw AppError.badRequest('item_code is required', 'LINEN_ITEM_CODE_REQUIRED');
  if (!displayName) throw AppError.badRequest('display_name is required', 'LINEN_ITEM_NAME_REQUIRED');
  const category = cleanText(data.category, 60) || 'bed_linen';
  if (!ITEM_CATEGORIES.has(category)) {
    throw AppError.badRequest(`category must be one of: ${[...ITEM_CATEGORIES].join(', ')}`, 'LINEN_BAD_CATEGORY');
  }

  return normalizeValue(await setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO linen_item_types
         (tenant_id, item_code, display_name, category, unit, active, metadata, created_by, updated_by)
       VALUES
         ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::uuid, $8::uuid)
       ON CONFLICT (tenant_id, item_code)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         category = EXCLUDED.category,
         unit = EXCLUDED.unit,
         active = EXCLUDED.active,
         metadata = EXCLUDED.metadata,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING *`,
      tenantId,
      itemCode.toUpperCase(),
      displayName,
      category,
      cleanText(data.unit, 30) || 'piece',
      boolValue(data.active, true),
      JSON.stringify(cleanJson(data.metadata, {})),
      actorUid(context),
    );
    const item = unwrap(rows);
    await recordAudit(tx, {
      tenantId,
      action: 'linen.item_type.upserted',
      resource: 'linen_item_types',
      resourceId: item.id,
      context,
      metadata: { item_code: item.item_code },
    });
    return item;
  }));
}

export async function upsertWardParLevel(data = {}, context = {}) {
  const tenantId = tenantOr(data.tenantId || data.tenant_id || context.tenantId);
  const wardId = intId(data.ward_id || data.wardId, 'ward_id');
  const itemTypeId = intId(data.item_type_id || data.itemTypeId, 'item_type_id');
  const parQuantity = quantity(data.par_quantity ?? data.parQuantity, 'par_quantity');
  const actualQuantity = quantity(data.actual_quantity ?? data.actualQuantity ?? 0, 'actual_quantity', { required: false });
  const reorderThreshold = quantity(data.reorder_threshold ?? data.reorderThreshold ?? 0, 'reorder_threshold', { required: false });

  return normalizeValue(await setTenantTx(tenantId, async (tx) => {
    const ward = await loadWard(tx, wardId);
    await loadItemTypes(tx, tenantId, [itemTypeId]);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO linen_ward_par_levels
         (tenant_id, ward_id, ward_name, item_type_id, par_quantity, actual_quantity,
          reorder_threshold, last_counted_at, notes, metadata, created_by, updated_by)
       VALUES
         ($1::uuid, $2::int, $3, $4::bigint, $5::int, $6::int, $7::int,
          CASE WHEN $8::boolean THEN NOW() ELSE NULL END,
          $9, $10::jsonb, $11::uuid, $11::uuid)
       ON CONFLICT (tenant_id, ward_id, item_type_id)
       DO UPDATE SET
         ward_name = EXCLUDED.ward_name,
         par_quantity = EXCLUDED.par_quantity,
         actual_quantity = EXCLUDED.actual_quantity,
         reorder_threshold = EXCLUDED.reorder_threshold,
         last_counted_at = CASE WHEN $8::boolean THEN NOW() ELSE linen_ward_par_levels.last_counted_at END,
         notes = EXCLUDED.notes,
         metadata = EXCLUDED.metadata,
         active = TRUE,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING *`,
      tenantId,
      wardId,
      ward.name,
      itemTypeId,
      parQuantity,
      actualQuantity,
      reorderThreshold,
      actualQuantity > 0,
      cleanText(data.notes, 2000),
      JSON.stringify(cleanJson(data.metadata, {})),
      actorUid(context),
    );
    const par = unwrap(rows);
    await recordAudit(tx, {
      tenantId,
      action: 'linen.par_level.upserted',
      resource: 'linen_ward_par_levels',
      resourceId: par.id,
      context,
      metadata: { ward_id: wardId, item_type_id: itemTypeId, par_quantity: parQuantity, actual_quantity: actualQuantity },
    });
    return par;
  }));
}

export async function getLinenBoard({ tenantId, wardId = null, limit = 20 } = {}) {
  const safeTenant = tenantOr(tenantId);
  const safeWard = optionalIntId(wardId, 'ward_id');
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
  const [parLevels, cycles] = await setTenant(safeTenant, async (tx) => Promise.all([
    tx.$queryRawUnsafe(
      `SELECT p.*, it.item_code, it.display_name, it.category, it.unit,
              (p.actual_quantity - p.par_quantity)::int AS par_delta,
              (p.actual_quantity < p.par_quantity) AS below_par
         FROM linen_ward_par_levels p
         JOIN linen_item_types it ON it.id = p.item_type_id AND it.tenant_id = p.tenant_id
        WHERE p.tenant_id = $1::uuid
          AND p.active = TRUE
          AND ($2::int IS NULL OR p.ward_id = $2::int)
        ORDER BY below_par DESC, p.ward_name, it.display_name`,
      safeTenant,
      safeWard,
    ),
    tx.$queryRawUnsafe(
      `SELECT c.*,
              COUNT(ci.id)::int AS item_count,
              COALESCE(SUM(ci.soiled_collected_quantity), 0)::int AS soiled_collected_quantity,
              COALESCE(SUM(ci.clean_returned_quantity), 0)::int AS clean_returned_quantity
         FROM linen_laundry_cycles c
         LEFT JOIN linen_laundry_cycle_items ci ON ci.cycle_id = c.id AND ci.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1::uuid
          AND ($2::int IS NULL OR c.ward_id = $2::int)
        GROUP BY c.id
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT $3::int`,
      safeTenant,
      safeWard,
      safeLimit,
    ),
  ]));

  const normalizedPar = normalizeRows(parLevels);
  const normalizedCycles = normalizeRows(cycles);
  return {
    summary: {
      par_level_count: normalizedPar.length,
      below_par_count: normalizedPar.filter((row) => row.below_par).length,
      open_cycle_count: normalizedCycles.filter((row) => !['reconciled', 'cancelled'].includes(row.status)).length,
      discrepancy_cycle_count: normalizedCycles.filter((row) => row.discrepancy_flag).length,
      shortage_quantity: normalizedPar.reduce((sum, row) => sum + Math.max(row.par_quantity - row.actual_quantity, 0), 0),
    },
    par_levels: normalizedPar,
    cycles: normalizedCycles,
  };
}

export async function getLaundryCycle(id, { tenantId } = {}) {
  const safeTenant = tenantOr(tenantId);
  const cycle = await setTenant(safeTenant, (tx) => selectCycleWithItems(tx, safeTenant, id));
  if (!cycle) throw AppError.notFound('Laundry cycle not found', 'LINEN_CYCLE_NOT_FOUND');
  return cycle;
}

export async function createLaundryCycle(data = {}, context = {}) {
  const tenantId = tenantOr(data.tenantId || data.tenant_id || context.tenantId);
  const wardId = intId(data.ward_id || data.wardId, 'ward_id');
  const plannedItems = normalizePlannedItems(data.items);
  const itemTypeIds = plannedItems.map((item) => item.item_type_id);

  return normalizeValue(await setTenantTx(tenantId, async (tx) => {
    const ward = await loadWard(tx, wardId);
    await loadItemTypes(tx, tenantId, itemTypeIds);
    const cycleRows = await tx.$queryRawUnsafe(
      `INSERT INTO linen_laundry_cycles
         (tenant_id, cycle_code, ward_id, ward_name, housekeeping_request_id,
          requested_by, notes, metadata, created_by, updated_by)
       VALUES
         ($1::uuid, $2, $3::int, $4, $5::int, $6::uuid, $7, $8::jsonb, $6::uuid, $6::uuid)
       RETURNING *`,
      tenantId,
      cleanText(data.cycle_code || data.cycleCode, 80) || cycleCode(),
      wardId,
      ward.name,
      optionalIntId(data.housekeeping_request_id || data.housekeepingRequestId, 'housekeeping_request_id'),
      actorUid(context),
      cleanText(data.notes, 2000),
      JSON.stringify(cleanJson(data.metadata, {})),
    );
    const cycle = unwrap(cycleRows);
    for (const item of plannedItems) {
      await tx.$queryRawUnsafe(
        `INSERT INTO linen_laundry_cycle_items
           (tenant_id, cycle_id, item_type_id, soiled_planned_quantity, notes, metadata)
         VALUES ($1::uuid, $2::bigint, $3::bigint, $4::int, $5, $6::jsonb)`,
        tenantId,
        cycle.id,
        item.item_type_id,
        item.soiled_planned_quantity,
        item.notes,
        JSON.stringify(item.metadata),
      );
    }
    await recordAudit(tx, {
      tenantId,
      action: 'linen.cycle.created',
      resource: 'linen_laundry_cycles',
      resourceId: cycle.id,
      context,
      metadata: { cycle_code: cycle.cycle_code, ward_id: wardId, item_count: plannedItems.length },
    });
    return selectCycleWithItems(tx, tenantId, cycle.id);
  }));
}

export async function collectLaundryCycle(id, data = {}, context = {}) {
  const tenantId = tenantOr(data.tenantId || data.tenant_id || context.tenantId);
  const patches = normalizeCollectionItems(data.items || []);
  return normalizeValue(await setTenantTx(tenantId, async (tx) => {
    const cycle = await loadCycleForUpdate(tx, tenantId, id);
    ensureTransition(cycle.status, 'collected');
    if (patches.length) {
      await assertCycleItemsBelong(tx, tenantId, cycle.id, patches.map((item) => item.item_type_id));
      for (const item of patches) {
        await tx.$executeRawUnsafe(
          `UPDATE linen_laundry_cycle_items
              SET soiled_collected_quantity = $4::int,
                  notes = COALESCE($5, notes),
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid
              AND cycle_id = $2::bigint
              AND item_type_id = $3::bigint`,
          tenantId,
          cycle.id,
          item.item_type_id,
          item.soiled_collected_quantity,
          item.notes,
        );
      }
    } else {
      await tx.$executeRawUnsafe(
        `UPDATE linen_laundry_cycle_items
            SET soiled_collected_quantity = soiled_planned_quantity,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND cycle_id = $2::bigint`,
        tenantId,
        cycle.id,
      );
    }
    await tx.$executeRawUnsafe(
      `UPDATE linen_laundry_cycles
          SET status = 'collected',
              collected_by = $3::uuid,
              collected_at = COALESCE($4::timestamptz, NOW()),
              updated_by = $3::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      tenantId,
      cycle.id,
      actorUid(context),
      cleanText(data.collected_at || data.collectedAt, 80),
    );
    await recordAudit(tx, {
      tenantId,
      action: 'linen.cycle.collected',
      resource: 'linen_laundry_cycles',
      resourceId: cycle.id,
      context,
      metadata: { cycle_code: cycle.cycle_code, patched_items: patches.length },
    });
    return selectCycleWithItems(tx, tenantId, cycle.id);
  }));
}

export async function sendCycleToLaundry(id, data = {}, context = {}) {
  const tenantId = tenantOr(data.tenantId || data.tenant_id || context.tenantId);
  return normalizeValue(await setTenantTx(tenantId, async (tx) => {
    const cycle = await loadCycleForUpdate(tx, tenantId, id);
    ensureTransition(cycle.status, 'in_laundry');
    await tx.$executeRawUnsafe(
      `UPDATE linen_laundry_cycles
          SET status = 'in_laundry',
              sent_to_laundry_by = $3::uuid,
              sent_to_laundry_at = COALESCE($4::timestamptz, NOW()),
              updated_by = $3::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      tenantId,
      cycle.id,
      actorUid(context),
      cleanText(data.sent_to_laundry_at || data.sentToLaundryAt, 80),
    );
    await recordAudit(tx, {
      tenantId,
      action: 'linen.cycle.sent_to_laundry',
      resource: 'linen_laundry_cycles',
      resourceId: cycle.id,
      context,
      metadata: { cycle_code: cycle.cycle_code },
    });
    return selectCycleWithItems(tx, tenantId, cycle.id);
  }));
}

export async function returnLaundryCycle(id, data = {}, context = {}) {
  const tenantId = tenantOr(data.tenantId || data.tenant_id || context.tenantId);
  const patches = normalizeReturnItems(data.items);
  return normalizeValue(await setTenantTx(tenantId, async (tx) => {
    const cycle = await loadCycleForUpdate(tx, tenantId, id);
    ensureTransition(cycle.status, 'returned');
    await assertCycleItemsBelong(tx, tenantId, cycle.id, patches.map((item) => item.item_type_id));
    for (const item of patches) {
      await tx.$executeRawUnsafe(
        `UPDATE linen_laundry_cycle_items
            SET soiled_collected_quantity = CASE WHEN $4::int > 0 THEN $4::int ELSE soiled_collected_quantity END,
                clean_returned_quantity = $5::int,
                damaged_quantity = $6::int,
                missing_quantity = $7::int,
                discrepancy_quantity = $8::int,
                discrepancy_flag = $9::boolean,
                notes = COALESCE($10, notes),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND cycle_id = $2::bigint
            AND item_type_id = $3::bigint`,
        tenantId,
        cycle.id,
        item.item_type_id,
        item.soiled_collected_quantity,
        item.clean_returned_quantity,
        item.damaged_quantity,
        item.missing_quantity,
        item.discrepancy_quantity,
        item.discrepancy_flag,
        item.notes,
      );
    }
    const discrepancy = await updateCycleDiscrepancy(tx, tenantId, cycle.id);
    await tx.$executeRawUnsafe(
      `UPDATE linen_laundry_cycles
          SET status = 'returned',
              returned_by = $3::uuid,
              returned_at = COALESCE($4::timestamptz, NOW()),
              discrepancy_flag = $5::boolean,
              updated_by = $3::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      tenantId,
      cycle.id,
      actorUid(context),
      cleanText(data.returned_at || data.returnedAt, 80),
      discrepancy,
    );
    await recordAudit(tx, {
      tenantId,
      action: discrepancy ? 'linen.cycle.returned_with_discrepancy' : 'linen.cycle.returned',
      resource: 'linen_laundry_cycles',
      resourceId: cycle.id,
      context,
      metadata: { cycle_code: cycle.cycle_code, discrepancy },
    });
    return selectCycleWithItems(tx, tenantId, cycle.id);
  }));
}

export async function reconcileLaundryCycle(id, data = {}, context = {}) {
  const tenantId = tenantOr(data.tenantId || data.tenant_id || context.tenantId);
  return normalizeValue(await setTenantTx(tenantId, async (tx) => {
    const cycle = await loadCycleForUpdate(tx, tenantId, id);
    ensureTransition(cycle.status, 'reconciled');
    const items = await tx.$queryRawUnsafe(
      `SELECT *
         FROM linen_laundry_cycle_items
        WHERE tenant_id = $1::uuid
          AND cycle_id = $2::bigint
        ORDER BY id`,
      tenantId,
      cycle.id,
    );
    for (const item of items) {
      const updated = await tx.$queryRawUnsafe(
        `UPDATE linen_ward_par_levels
            SET actual_quantity = GREATEST(actual_quantity - $4::int + $5::int, 0),
                last_counted_at = NOW(),
                last_cycle_id = $6::bigint,
                updated_by = $7::uuid,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND ward_id = $2::int
            AND item_type_id = $3::bigint
        RETURNING id`,
        tenantId,
        cycle.ward_id,
        item.item_type_id,
        item.soiled_collected_quantity,
        item.clean_returned_quantity,
        cycle.id,
        actorUid(context),
      );
      if (!updated.length) {
        await tx.$executeRawUnsafe(
          `INSERT INTO linen_ward_par_levels
             (tenant_id, ward_id, ward_name, item_type_id, par_quantity, actual_quantity,
              last_counted_at, last_cycle_id, created_by, updated_by)
           VALUES
             ($1::uuid, $2::int, $3, $4::bigint, 0, $5::int, NOW(), $6::bigint, $7::uuid, $7::uuid)`,
          tenantId,
          cycle.ward_id,
          cycle.ward_name,
          item.item_type_id,
          item.clean_returned_quantity,
          cycle.id,
          actorUid(context),
        );
      }
    }
    await tx.$executeRawUnsafe(
      `UPDATE linen_laundry_cycles
          SET status = 'reconciled',
              reconciled_by = $3::uuid,
              reconciled_at = COALESCE($4::timestamptz, NOW()),
              updated_by = $3::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      tenantId,
      cycle.id,
      actorUid(context),
      cleanText(data.reconciled_at || data.reconciledAt, 80),
    );
    await recordAudit(tx, {
      tenantId,
      action: 'linen.cycle.reconciled',
      resource: 'linen_laundry_cycles',
      resourceId: cycle.id,
      context,
      metadata: { cycle_code: cycle.cycle_code, item_count: items.length },
    });
    return selectCycleWithItems(tx, tenantId, cycle.id);
  }));
}

export async function cancelLaundryCycle(id, data = {}, context = {}) {
  const tenantId = tenantOr(data.tenantId || data.tenant_id || context.tenantId);
  return normalizeValue(await setTenantTx(tenantId, async (tx) => {
    const cycle = await loadCycleForUpdate(tx, tenantId, id);
    ensureTransition(cycle.status, 'cancelled');
    const rows = await tx.$queryRawUnsafe(
      `UPDATE linen_laundry_cycles
          SET status = 'cancelled',
              cancelled_by = $3::uuid,
              cancelled_at = NOW(),
              cancellation_reason = $4,
              updated_by = $3::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
      RETURNING *`,
      tenantId,
      cycle.id,
      actorUid(context),
      cleanText(data.reason || data.cancellation_reason || data.cancellationReason, 2000),
    );
    const cancelled = unwrap(rows);
    await recordAudit(tx, {
      tenantId,
      action: 'linen.cycle.cancelled',
      resource: 'linen_laundry_cycles',
      resourceId: cycle.id,
      context,
      metadata: { cycle_code: cycle.cycle_code, reason: cancelled.cancellation_reason },
    });
    return selectCycleWithItems(tx, tenantId, cycle.id);
  }));
}

export default {
  deriveCycleItemReconciliation,
  applyParReconciliation,
  listItemTypes,
  upsertItemType,
  upsertWardParLevel,
  getLinenBoard,
  getLaundryCycle,
  createLaundryCycle,
  collectLaundryCycle,
  sendCycleToLaundry,
  returnLaundryCycle,
  reconcileLaundryCycle,
  cancelLaundryCycle,
};
