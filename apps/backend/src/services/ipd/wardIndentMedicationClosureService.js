import { createHash } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { recomputeInvoiceTotals } from '../billing/billingV2Service.js';
import { createBillingCreditNoteFromFinancialEventTx } from '../billing/billingCreditNoteService.js';
import { recordMovementTx } from '../pharmacy/inventoryV2Service.js';
import { requireTenantId } from '../tenant/tenantService.js';

const ACTIVE_ALLOCATION_STATUSES = ['reserved', 'partially_issued', 'issued'];

function positiveId(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function positiveBigInt(value, fieldName) {
  const text = typeof value === 'bigint' ? value.toString() : String(value ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return BigInt(text);
}

function positiveQuantity(value, fieldName, { allowZero = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw AppError.badRequest(`${fieldName} must be ${allowZero ? 'non-negative' : 'positive'}`);
  }
  const normalized = Math.round(parsed * 10000) / 10000;
  if (Math.abs(parsed - normalized) > 1e-9 || normalized > 9999999999.9999) {
    throw AppError.badRequest(`${fieldName} must have at most four decimal places`);
  }
  return normalized;
}

function requiredText(value, fieldName, max = 2000) {
  const text = String(value || '').trim();
  if (!text) throw AppError.badRequest(`${fieldName} is required`);
  return text.slice(0, max);
}

function durableKey(prefix, commandKey, ...parts) {
  const command = requiredText(commandKey, 'Idempotency-Key', 1000);
  const candidate = [prefix, ...parts, command].join(':');
  if (candidate.length <= 200) return candidate;
  return `${prefix}:${parts.join(':')}:${createHash('sha256').update(candidate).digest('hex')}`.slice(0, 200);
}

function selectionMap(entries) {
  const result = new Map();
  for (const entry of (Array.isArray(entries) ? entries : [])) {
    const itemId = positiveId(entry?.item_id ?? entry?.id, 'item_id');
    if (result.has(itemId)) throw AppError.badRequest(`Duplicate inventory selection for item ${itemId}`);
    result.set(itemId, positiveId(entry?.inventory_item_id, 'inventory_item_id'));
  }
  return result;
}

function normalizeBigInts(value) {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (Array.isArray(value)) return value.map(normalizeBigInts);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeBigInts(child)]));
  }
  return value;
}

async function inventoryItemsForCatalogTx(tx, tenantId, catalogId, {
  facilityId = null,
  lock = false,
} = {}) {
  return tx.$queryRawUnsafe(
    `SELECT item.id, item.catalog_id, item.sku_code, item.display_name,
             item.generic_name, item.brand_name, item.form, item.strength,
             item.unit_label, item.schedule_class, item.is_narcotic, item.status,
             item.facility_id
        FROM pharmacy_inventory_items item
       WHERE item.tenant_id = $1::uuid
         AND item.catalog_id = $2::int
         AND item.status = 'active'
         AND (
           ($3::int IS NULL AND item.facility_id IS NULL)
           OR
           ($3::int IS NOT NULL AND (item.facility_id IS NULL OR item.facility_id = $3::int))
         )
       ORDER BY item.id
       ${lock ? 'FOR KEY SHARE' : ''}`,
    tenantId,
    catalogId,
    facilityId,
  );
}

async function candidateBatchesTx(tx, tenantId, inventoryItemId, { lock = false } = {}) {
  if (lock) {
    // The reservation total must be read in a new READ COMMITTED statement after
    // every candidate batch is locked; otherwise a waiter can retain a stale
    // lateral-subquery snapshot after the lock holder commits its allocation.
    await tx.$queryRawUnsafe(
      `SELECT batch.id
         FROM pharmacy_inventory_batches batch
        WHERE batch.tenant_id = $1::uuid
          AND batch.inventory_item_id = $2::int
          AND batch.status = 'in_stock'
          AND batch.expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
          AND batch.remaining_quantity > 0
        ORDER BY batch.expiry_date, batch.id
        FOR UPDATE`,
      tenantId,
      inventoryItemId,
    );
  }
  return tx.$queryRawUnsafe(
    `SELECT batch.id, batch.inventory_item_id, batch.batch_number, batch.lot_number,
            batch.expiry_date, batch.remaining_quantity, batch.status,
            GREATEST(
              batch.remaining_quantity - COALESCE(reservation.reserved_outstanding, 0),
              0
            )::numeric AS unreserved_quantity
       FROM pharmacy_inventory_batches batch
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(allocation.reserved_quantity - allocation.issued_quantity), 0)::numeric
                  AS reserved_outstanding
           FROM ward_indent_inventory_allocations allocation
          WHERE allocation.tenant_id = batch.tenant_id
            AND allocation.inventory_batch_id = batch.id
            AND allocation.status = ANY($3::text[])
       ) reservation ON TRUE
      WHERE batch.tenant_id = $1::uuid
        AND batch.inventory_item_id = $2::int
        AND batch.status = 'in_stock'
        AND batch.expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        AND batch.remaining_quantity > 0
      ORDER BY batch.expiry_date, batch.id`,
    tenantId,
    inventoryItemId,
    ACTIVE_ALLOCATION_STATUSES,
  );
}

async function resolveInventoryItemTx(tx, {
  tenantId,
  facilityId,
  wardItem,
  selectedInventoryItemId = null,
}) {
  if (!wardItem.pharmacy_catalog_id) {
    throw AppError.conflict(
      `Ward indent item ${wardItem.id} has no pharmacy catalog identity`,
      'WARD_INDENT_CATALOG_LINK_REQUIRED',
    );
  }
  const candidates = await inventoryItemsForCatalogTx(
    tx,
    tenantId,
    Number(wardItem.pharmacy_catalog_id),
    { facilityId, lock: true },
  );
  if (!candidates.length) {
    throw AppError.conflict(
      `Ward indent item ${wardItem.id} has no active Inventory V2 mapping`,
      'WARD_INDENT_INVENTORY_MAPPING_REQUIRED',
      { item_id: Number(wardItem.id), catalog_id: Number(wardItem.pharmacy_catalog_id) },
    );
  }
  if (selectedInventoryItemId) {
    const selected = candidates.find((candidate) => Number(candidate.id) === selectedInventoryItemId);
    if (!selected) {
      throw AppError.conflict(
        `Inventory item ${selectedInventoryItemId} is not an active mapping for ward item ${wardItem.id}`,
        'WARD_INDENT_INVENTORY_SELECTION_INVALID',
      );
    }
    return selected;
  }
  if (candidates.length !== 1) {
    throw AppError.conflict(
      `Ward indent item ${wardItem.id} has multiple Inventory V2 mappings; select one explicitly`,
      'WARD_INDENT_INVENTORY_SELECTION_REQUIRED',
      {
        item_id: Number(wardItem.id),
        candidates: candidates.map((candidate) => ({
          inventory_item_id: Number(candidate.id),
          sku_code: candidate.sku_code,
          display_name: candidate.display_name,
        })),
      },
    );
  }
  return candidates[0];
}

export async function listWardIndentInventoryCandidates(wardIndentItemId, {
  tenantId,
  wardIndentId = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const itemId = positiveId(wardIndentItemId, 'wardIndentItemId');
  const indentId = wardIndentId == null ? null : positiveId(wardIndentId, 'wardIndentId');
  return setTenantTx(tid, async (tx) => {
    const wardRows = await tx.$queryRawUnsafe(
      `SELECT item.id, item.ward_indent_id, item.pharmacy_catalog_id,
              item.item_name, item.quantity_requested, item.quantity_reserved,
              ward.facility_id
         FROM ward_indent_items item
         JOIN ward_indents indent
           ON indent.tenant_id = item.tenant_id
          AND indent.id = item.ward_indent_id
         LEFT JOIN wards ward
           ON ward.tenant_id = indent.tenant_id
          AND ward.id = indent.ward_id
        WHERE item.tenant_id = $1::uuid
          AND item.id = $2::int
          AND ($3::int IS NULL OR item.ward_indent_id = $3::int)
        LIMIT 1`,
      tid,
      itemId,
      indentId,
    );
    const wardItem = wardRows[0];
    if (!wardItem) throw AppError.notFound('Ward indent item not found');
    if (!wardItem.pharmacy_catalog_id) return { item: wardItem, candidates: [] };
    const items = await inventoryItemsForCatalogTx(
      tx,
      tid,
      Number(wardItem.pharmacy_catalog_id),
      { facilityId: wardItem.facility_id == null ? null : Number(wardItem.facility_id) },
    );
    const candidates = [];
    for (const item of items) {
      const batches = await candidateBatchesTx(tx, tid, Number(item.id));
      candidates.push({
        ...item,
        unreserved_quantity: batches.reduce(
          (sum, batch) => sum + Number(batch.unreserved_quantity || 0),
          0,
        ),
        batches,
      });
    }
    return normalizeBigInts({ item: wardItem, candidates });
  }, { readOnly: true });
}

export async function releaseWardIndentReservationsTx(tx, {
  indent,
  releasedBy,
  reason,
}) {
  const cleanReason = requiredText(reason, 'reservation release reason');
  const rows = await tx.$queryRawUnsafe(
    `UPDATE ward_indent_inventory_allocations
        SET status = 'released', released_by = $1::uuid, released_at = NOW(),
            release_reason = $2::text, updated_at = NOW()
      WHERE tenant_id = $3::uuid
        AND ward_indent_id = $4::int
        AND status = ANY($5::text[])
        AND issued_quantity = 0
      RETURNING id`,
    releasedBy,
    cleanReason,
    indent.tenant_id,
    Number(indent.id),
    ACTIVE_ALLOCATION_STATUSES,
  );
  const issued = await tx.$queryRawUnsafe(
    `SELECT id
       FROM ward_indent_inventory_allocations
      WHERE tenant_id = $1::uuid
        AND ward_indent_id = $2::int
        AND status = ANY($3::text[])
        AND issued_quantity > 0
      LIMIT 1`,
    indent.tenant_id,
    Number(indent.id),
    ACTIVE_ALLOCATION_STATUSES,
  );
  if (issued[0]) {
    throw AppError.conflict(
      'Issued Inventory V2 allocations cannot be released; use return and reconciliation',
      'WARD_INDENT_ALLOCATION_RELEASE_REQUIRES_RECONCILIATION',
    );
  }
  return rows.length;
}

export async function reserveWardIndentInventoryTx(tx, {
  indent,
  reservedBy,
  targetQuantities,
  inventorySelections = null,
  commandKey,
  allowShortSupply = false,
}) {
  const selectedByItem = selectionMap(inventorySelections);
  const knownItemIds = new Set(indent.items.map((item) => Number(item.id)));
  for (const itemId of selectedByItem.keys()) {
    if (!knownItemIds.has(itemId)) {
      throw AppError.badRequest(`Ward indent item ${itemId} does not belong to this indent`);
    }
  }
  await releaseWardIndentReservationsTx(tx, {
    indent,
    releasedBy: reservedBy,
    reason: `Superseded by reservation command ${requiredText(commandKey, 'Idempotency-Key', 160)}`,
  });
  const actualByItem = new Map();
  const controlledByItem = new Map();
  const shortfalls = [];

  for (const wardItem of [...indent.items].sort((a, b) => Number(a.id) - Number(b.id))) {
    const itemId = Number(wardItem.id);
    const target = positiveQuantity(targetQuantities.get(itemId) ?? 0, 'target quantity', {
      allowZero: true,
    });
    if (target === 0) {
      actualByItem.set(itemId, 0);
      controlledByItem.set(itemId, false);
      continue;
    }
    const inventoryItem = await resolveInventoryItemTx(tx, {
      tenantId: indent.tenant_id,
      facilityId: indent.facility_id == null ? null : Number(indent.facility_id),
      wardItem,
      selectedInventoryItemId: selectedByItem.get(itemId) || null,
    });
    const batches = await candidateBatchesTx(tx, indent.tenant_id, Number(inventoryItem.id), {
      lock: true,
    });
    const controlled = inventoryItem.is_narcotic === true
      || ['H', 'H1', 'X'].includes(String(inventoryItem.schedule_class || '').toUpperCase());
    controlledByItem.set(itemId, controlled);
    const selectedBatches = controlled
      ? batches.filter((batch) => Number(batch.unreserved_quantity) >= target).slice(0, 1)
      : batches;
    let remaining = target;
    let reserved = 0;
    for (const batch of selectedBatches) {
      if (remaining <= 0) break;
      const quantity = Math.min(remaining, Number(batch.unreserved_quantity || 0));
      if (quantity <= 0) continue;
      await tx.$executeRawUnsafe(
        `INSERT INTO ward_indent_inventory_allocations
           (tenant_id, ward_indent_id, ward_indent_item_id,
            inventory_item_id, inventory_batch_id, reserved_quantity,
            reservation_key, reserved_by)
         VALUES ($1::uuid, $2::int, $3::int, $4::int, $5::int,
                 $6::numeric, $7::text, $8::uuid)`,
        indent.tenant_id,
        Number(indent.id),
        itemId,
        Number(inventoryItem.id),
        Number(batch.id),
        quantity,
        durableKey('ward-indent-allocation', commandKey, indent.id, itemId, batch.id),
        reservedBy,
      );
      reserved = Math.round((reserved + quantity) * 10000) / 10000;
      remaining = Math.round((remaining - quantity) * 10000) / 10000;
    }
    actualByItem.set(itemId, reserved);
    if (remaining > 0) {
      shortfalls.push({
        item_id: itemId,
        inventory_item_id: Number(inventoryItem.id),
        requested: target,
        reserved,
        shortfall: remaining,
        ...(controlled ? { controlled_single_batch_required: true } : {}),
      });
    }
  }

  if (shortfalls.length && !allowShortSupply) {
    throw AppError.conflict(
      'Ward indent exact-batch stock cannot be fully reserved',
      'WARD_INDENT_INSUFFICIENT_EXACT_BATCH_STOCK',
      { shortfalls },
    );
  }
  return { actualByItem, controlledByItem, shortfalls };
}

export async function projectLegacyCatalogBalancesTx(tx, tenantId, catalogIds) {
  const ids = [...new Set(catalogIds.map(Number).filter(Number.isSafeInteger))];
  if (!ids.length) return;
  await tx.$executeRawUnsafe(
    `UPDATE pharmacy_catalog catalog
        SET stock_quantity = canonical.usable_quantity,
            stock = canonical.usable_quantity,
            in_stock = canonical.usable_quantity > 0,
            updated_at = NOW()
       FROM (
         SELECT item.catalog_id,
                FLOOR(COALESCE(SUM(
                  CASE
                    WHEN batch.status = 'in_stock'
                     AND batch.expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                      THEN batch.remaining_quantity
                    ELSE 0
                  END
                ), 0))::int AS usable_quantity
           FROM pharmacy_inventory_items item
           LEFT JOIN pharmacy_inventory_batches batch
             ON batch.tenant_id = item.tenant_id
            AND batch.inventory_item_id = item.id
          WHERE item.tenant_id = $1::uuid
            AND item.catalog_id = ANY($2::int[])
          GROUP BY item.catalog_id
       ) canonical
      WHERE catalog.tenant_id = $1::uuid
        AND catalog.id = canonical.catalog_id`,
    tenantId,
    ids,
  );
}

export async function loadWardIndentMedicationClosureTx(tx, tenantId, indentId) {
  const allocations = await tx.$queryRawUnsafe(
    `SELECT allocation.*,
            item.display_name AS inventory_item_name,
            item.sku_code,
            batch.batch_number,
            batch.lot_number,
            batch.expiry_date,
            batch.status AS batch_status,
            batch.remaining_quantity,
            (allocation.received_quantity - allocation.consumed_quantity
              - allocation.returned_quantity)::numeric AS custody_available_quantity
       FROM ward_indent_inventory_allocations allocation
       JOIN pharmacy_inventory_items item
         ON item.tenant_id = allocation.tenant_id
        AND item.id = allocation.inventory_item_id
       JOIN pharmacy_inventory_batches batch
         ON batch.tenant_id = allocation.tenant_id
        AND batch.id = allocation.inventory_batch_id
      WHERE allocation.tenant_id = $1::uuid
        AND allocation.ward_indent_id = $2::int
      ORDER BY allocation.ward_indent_item_id, batch.expiry_date, allocation.id`,
    tenantId,
    Number(indentId),
  );
  const movements = await tx.$queryRawUnsafe(
    `SELECT link.*, movement.movement_kind, movement.quantity_delta,
            movement.reference_type, movement.reference_id,
            movement.created_at AS movement_created_at
       FROM ward_indent_inventory_movement_links link
       JOIN ward_indent_inventory_allocations allocation
         ON allocation.tenant_id = link.tenant_id
        AND allocation.id = link.allocation_id
       JOIN pharmacy_stock_movements movement
         ON movement.tenant_id = link.tenant_id
        AND movement.id = link.stock_movement_id
      WHERE link.tenant_id = $1::uuid
        AND allocation.ward_indent_id = $2::int
      ORDER BY link.created_at, link.id`,
    tenantId,
    Number(indentId),
  );
  const financialEvents = await tx.$queryRawUnsafe(
    `SELECT financial.*, note.status AS credit_note_status,
            note.credit_note_number, note.task_id AS credit_note_task_id
       FROM ward_indent_financial_events financial
       LEFT JOIN billing_credit_notes note
         ON note.tenant_id = financial.tenant_id
        AND note.source_financial_event_id = financial.id
      WHERE financial.tenant_id = $1::uuid
        AND financial.ward_indent_id = $2::int
      ORDER BY financial.occurred_at, financial.id`,
    tenantId,
    Number(indentId),
  );
  return normalizeBigInts({
    allocations,
    movement_lineage: movements,
    financial_events: financialEvents,
  });
}

async function insertMovementLinkTx(tx, {
  tenantId,
  allocationId,
  movementId,
  controlledRegisterId = null,
  purpose,
  quantity,
  stateVersion,
  commandKey,
  actor,
}) {
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO ward_indent_inventory_movement_links
       (tenant_id, allocation_id, stock_movement_id, controlled_register_id,
        movement_purpose, quantity, ward_indent_state_version, command_key, linked_by)
     VALUES ($1::uuid, $2::bigint, $3::int, $4::int, $5::text, $6::numeric,
             $7::int, $8::text, $9::uuid)
     RETURNING *`,
    tenantId,
    BigInt(allocationId),
    Number(movementId),
    controlledRegisterId == null ? null : Number(controlledRegisterId),
    purpose,
    quantity,
    Number(stateVersion),
    commandKey,
    actor,
  );
  return rows[0];
}

export async function linkControlledWardIndentMovementTx(tx, {
  indent,
  wardItem,
  movementId,
  controlledRegisterId,
  purpose,
  actor,
  commandKey,
  stateVersion,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT movement.id, movement.inventory_item_id, movement.inventory_batch_id,
            ABS(movement.quantity_delta)::numeric AS quantity
       FROM pharmacy_stock_movements movement
      WHERE movement.tenant_id = $1::uuid
        AND movement.id = $2::int
        AND movement.inventory_batch_id IS NOT NULL`,
    indent.tenant_id,
    Number(movementId),
  );
  const movement = rows[0];
  if (!movement) {
    throw AppError.conflict(
      `Controlled movement ${movementId} has no exact Inventory V2 batch`,
      'WARD_INDENT_CONTROLLED_BATCH_REQUIRED',
    );
  }
  const allocations = await tx.$queryRawUnsafe(
    `SELECT *
       FROM ward_indent_inventory_allocations
      WHERE tenant_id = $1::uuid
        AND ward_indent_id = $2::int
        AND ward_indent_item_id = $3::int
        AND inventory_item_id = $4::int
        AND inventory_batch_id = $5::int
        AND status = ANY($6::text[])
      ORDER BY id
      FOR UPDATE`,
    indent.tenant_id,
    Number(indent.id),
    Number(wardItem.id),
    Number(movement.inventory_item_id),
    Number(movement.inventory_batch_id),
    ACTIVE_ALLOCATION_STATUSES,
  );
  const matchingAllocations = allocations.filter((candidate) => {
    const available = purpose === 'issue'
      ? Number(candidate.reserved_quantity) - Number(candidate.issued_quantity)
      : Number(candidate.received_quantity)
        - Number(candidate.consumed_quantity)
        - Number(candidate.returned_quantity);
    return purpose === 'issue'
      ? Math.abs(available - Number(movement.quantity)) < 1e-9
      : available + 1e-9 >= Number(movement.quantity);
  });
  if (matchingAllocations.length !== 1) {
    throw AppError.conflict(
      `Controlled movement ${movementId} does not match one exact ward allocation`,
      'WARD_INDENT_CONTROLLED_ALLOCATION_MISMATCH',
      {
        item_id: Number(wardItem.id),
        movement_id: Number(movementId),
        candidate_allocation_count: matchingAllocations.length,
      },
    );
  }
  const allocation = matchingAllocations[0];
  return insertMovementLinkTx(tx, {
    tenantId: indent.tenant_id,
    allocationId: allocation.id,
    movementId,
    controlledRegisterId,
    purpose,
    quantity: Number(movement.quantity),
    stateVersion,
    commandKey: durableKey(
      `ward-indent-${purpose}-link`,
      commandKey,
      indent.id,
      wardItem.id,
      allocation.id,
    ),
    actor,
  });
}

async function ensureDraftInvoiceTx(tx, indent, actor) {
  if (indent.admission_id != null) {
    const admissions = await tx.$queryRawUnsafe(
      `SELECT id, billing_closed_at
         FROM admissions
        WHERE tenant_id = $1::uuid
          AND id = $2::int
          AND patient_uid = $3::uuid
        FOR SHARE`,
      indent.tenant_id,
      Number(indent.admission_id),
      String(indent.patient_uid),
    );
    if (!admissions[0]) throw AppError.notFound('Admission not found');
    if (admissions[0].billing_closed_at) {
      throw AppError.conflict(
        `Billing is closed for admission ${Number(indent.admission_id)}`,
        'BILLING_CLOSED',
      );
    }
  }
  const invoiceLockKey = [
    'ward-indent-draft-invoice',
    indent.tenant_id,
    String(indent.patient_uid),
    indent.admission_id == null ? 'no-admission' : Number(indent.admission_id),
  ].join(':');
  await tx.$queryRawUnsafe(
    `SELECT 1::int AS locked
       FROM (SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))) AS guard`,
    invoiceLockKey,
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM billing_invoices
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND status = 'DRAFT'
        AND invoice_type = 'IP'
        AND department IS NULL
        AND (
          ($3::int IS NOT NULL AND admission_id = $3::int)
          OR ($3::int IS NULL AND admission_id IS NULL)
        )
      ORDER BY created_at DESC NULLS LAST, id DESC
      LIMIT 1
      FOR UPDATE`,
    indent.tenant_id,
    String(indent.patient_uid),
    indent.admission_id == null ? null : Number(indent.admission_id),
  );
  if (rows[0]) return rows[0];
  const created = await tx.$queryRawUnsafe(
    `INSERT INTO billing_invoices
       (patient_uid, admission_id, invoice_type, status, created_by, tenant_id,
        department, notes)
     VALUES ($1::uuid, $2::int, 'IP', 'DRAFT', $3::uuid, $4::uuid, NULL,
             'Medication charge projection from authoritative ward indent')
     RETURNING *`,
    String(indent.patient_uid),
    indent.admission_id == null ? null : Number(indent.admission_id),
    actor,
    indent.tenant_id,
  );
  return created[0];
}

async function catalogPricingTx(tx, tenantId, catalogIds) {
  const ids = [...new Set(catalogIds.map(Number))];
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, name, generic_name, category, unit_price, price, form, strength
       FROM pharmacy_catalog
      WHERE tenant_id = $1::uuid
        AND id = ANY($2::int[])
      ORDER BY id
      FOR KEY SHARE`,
    tenantId,
    ids,
  );
  return new Map(rows.map((row) => [Number(row.id), row]));
}

export async function issueWardIndentInventoryTx(tx, {
  indent,
  issuedBy,
  commandKey,
  nextStateVersion,
}) {
  const allocations = await tx.$queryRawUnsafe(
    `SELECT allocation.*, item.schedule_class, item.is_narcotic,
            batch.batch_number, batch.lot_number, batch.expiry_date,
            batch.status AS batch_status
       FROM ward_indent_inventory_allocations allocation
       JOIN pharmacy_inventory_items item
         ON item.tenant_id = allocation.tenant_id
        AND item.id = allocation.inventory_item_id
       JOIN pharmacy_inventory_batches batch
         ON batch.tenant_id = allocation.tenant_id
        AND batch.id = allocation.inventory_batch_id
      WHERE allocation.tenant_id = $1::uuid
        AND allocation.ward_indent_id = $2::int
        AND allocation.status = ANY($3::text[])
      ORDER BY allocation.ward_indent_item_id, batch.expiry_date, allocation.id
      FOR UPDATE OF allocation, batch`,
    indent.tenant_id,
    Number(indent.id),
    ACTIVE_ALLOCATION_STATUSES,
  );
  const byWardItem = new Map();
  for (const allocation of allocations) {
    const itemId = Number(allocation.ward_indent_item_id);
    if (!byWardItem.has(itemId)) byWardItem.set(itemId, []);
    byWardItem.get(itemId).push(allocation);
  }
  const catalogIds = [];
  const movementIds = [];
  for (const wardItem of indent.items) {
    const itemAllocations = byWardItem.get(Number(wardItem.id)) || [];
    const reserved = itemAllocations.reduce(
      (sum, allocation) => sum + Number(allocation.reserved_quantity),
      0,
    );
    if (Math.abs(reserved - Number(wardItem.quantity_approved || 0)) > 1e-9) {
      throw AppError.conflict(
        `Ward indent item ${wardItem.id} is not backed by its exact approved reservation`,
        'WARD_INDENT_EXACT_RESERVATION_MISMATCH',
      );
    }
    for (const allocation of itemAllocations) {
      const outstanding = Number(allocation.reserved_quantity) - Number(allocation.issued_quantity);
      if (outstanding <= 0) continue;
      const controlled = allocation.is_narcotic === true
        || ['H', 'H1', 'X'].includes(String(allocation.schedule_class || '').toUpperCase());
      if (controlled) {
        throw AppError.conflict(
          `Controlled item ${wardItem.id} has not linked its witnessed exact-batch movement`,
          'WARD_INDENT_CONTROLLED_HANDOFF_REQUIRED',
        );
      }
      const { movement } = await recordMovementTx(tx, {
        tenantId: indent.tenant_id,
        inventory_item_id: Number(allocation.inventory_item_id),
        inventory_batch_id: Number(allocation.inventory_batch_id),
        movement_kind: 'issue',
        quantity: outstanding,
        reference_type: 'ward_indent_allocation',
        reference_id: String(allocation.id),
        notes: `Ward indent ${indent.indent_number} item ${wardItem.id}`,
        performed_by: issuedBy,
        require_usable_batch: true,
      });
      await insertMovementLinkTx(tx, {
        tenantId: indent.tenant_id,
        allocationId: allocation.id,
        movementId: movement.id,
        purpose: 'issue',
        quantity: outstanding,
        stateVersion: nextStateVersion,
        commandKey: durableKey(
          'ward-indent-issue-link',
          commandKey,
          indent.id,
          wardItem.id,
          allocation.id,
        ),
        actor: issuedBy,
      });
      movementIds.push(Number(movement.id));
    }
    catalogIds.push(Number(wardItem.pharmacy_catalog_id));
  }
  await projectLegacyCatalogBalancesTx(tx, indent.tenant_id, catalogIds);

  if (indent.patient_uid == null) {
    return { invoice: null, chargePlans: [], movementIds };
  }

  const invoice = await ensureDraftInvoiceTx(tx, indent, issuedBy);
  const pricingByCatalog = await catalogPricingTx(tx, indent.tenant_id, catalogIds);
  const chargePlans = [];
  for (const wardItem of indent.items) {
    const pricing = pricingByCatalog.get(Number(wardItem.pharmacy_catalog_id));
    const unitPrice = Number(wardItem.unit_price ?? pricing?.unit_price ?? pricing?.price ?? 0);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw AppError.conflict(
        `Ward indent item ${wardItem.id} has no valid frozen price`,
        'WARD_INDENT_PRICE_SNAPSHOT_REQUIRED',
      );
    }
    const unitPriceMinor = Math.round(unitPrice * 100);
    const quantity = Number(wardItem.quantity_approved);
    const subtotal = Math.round(quantity * unitPrice * 100) / 100;
    const lineRows = await tx.$queryRawUnsafe(
      `INSERT INTO billing_invoice_items
         (invoice_id, service_code, description, category, quantity, unit_price,
          gst_rate, line_subtotal, cgst_amount, sgst_amount, igst_amount,
          line_total, notes, source_ref_type, source_ref_id, tenant_id)
       VALUES ($1::int, $2::text, $3::text, 'pharmacy', $4::numeric, $5::numeric,
               0, $6::numeric, 0, 0, 0, $6::numeric, $7::text,
               'ward_indent_item', $8::bigint, $9::uuid)
       ON CONFLICT (tenant_id, source_ref_type, source_ref_id)
         WHERE source_ref_type = 'ward_indent_item'
           AND source_ref_id IS NOT NULL
           AND source_ref_active
       DO UPDATE SET
         quantity = EXCLUDED.quantity,
         unit_price = EXCLUDED.unit_price,
         line_subtotal = EXCLUDED.line_subtotal,
         line_total = EXCLUDED.line_total,
         notes = EXCLUDED.notes
       RETURNING *`,
      Number(invoice.id),
      `WARD-MED-${wardItem.id}`,
      String(wardItem.item_name).slice(0, 255),
      quantity,
      unitPrice,
      subtotal,
      `Ward indent ${indent.indent_number}`.slice(0, 255),
      BigInt(wardItem.id),
      indent.tenant_id,
    );
    const invoiceItem = lineRows[0];
    if (Number(invoiceItem.invoice_id) !== Number(invoice.id)) {
      throw AppError.conflict(
        `Ward indent item ${wardItem.id} is already projected onto another invoice`,
        'WARD_INDENT_INVOICE_PROJECTION_CONFLICT',
        {
          ward_indent_item_id: Number(wardItem.id),
          expected_invoice_id: Number(invoice.id),
          actual_invoice_id: Number(invoiceItem.invoice_id),
        },
      );
    }
    chargePlans.push({
      wardItem,
      invoice,
      invoiceItem,
      quantity,
      unitPriceMinor,
      pricingSnapshot: {
        source: 'ward_indent_approved_price',
        catalog_id: Number(wardItem.pharmacy_catalog_id),
        catalog_name: pricing?.name || wardItem.item_name,
        unit_price_minor: unitPriceMinor,
        currency: 'INR',
        gst_rate: 0,
      },
    });
  }
  await recomputeInvoiceTotals(Number(invoice.id), tx, { emitTpaAlert: false });
  return { invoice, chargePlans, movementIds };
}

export async function appendWardIndentChargeEventsTx(tx, {
  indent,
  wardEvent,
  issuedBy,
  commandKey,
  chargePlans,
}) {
  const events = [];
  for (const plan of chargePlans) {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO ward_indent_financial_events
         (tenant_id, ward_indent_id, ward_indent_item_id, clinical_order_id,
          ward_indent_event_id, ward_indent_state_version, event_kind,
          quantity, unit_price_minor, amount_minor, currency, pricing_snapshot,
          invoice_id, invoice_item_id, event_key, actor_uid)
       VALUES ($1::uuid, $2::int, $3::int, $4::int, $5::bigint, $6::int,
               'charge', $7::numeric, $8::bigint,
               ROUND($7::numeric * $8::bigint)::bigint,
               'INR', $9::jsonb, $10::int, $11::int, $12::text, $13::uuid)
       RETURNING *`,
      indent.tenant_id,
      Number(indent.id),
      Number(plan.wardItem.id),
      plan.wardItem.clinical_order_id == null ? null : Number(plan.wardItem.clinical_order_id),
      BigInt(wardEvent.id),
      Number(wardEvent.state_version),
      plan.quantity,
      BigInt(plan.unitPriceMinor),
      JSON.stringify(plan.pricingSnapshot),
      Number(plan.invoice.id),
      Number(plan.invoiceItem.id),
      durableKey('ward-indent-charge', commandKey, indent.id, plan.wardItem.id),
      issuedBy,
    );
    events.push(rows[0]);
  }
  return events;
}

function acknowledgedItemIds(entries) {
  const ids = new Set();
  for (const entry of (Array.isArray(entries) ? entries : [])) {
    const id = positiveId(entry?.item_id ?? entry, 'substitution acknowledgement item_id');
    if (ids.has(id)) throw AppError.badRequest(`Duplicate substitution acknowledgement ${id}`);
    ids.add(id);
  }
  return ids;
}

export async function receiveWardIndentInventoryTx(tx, {
  indent,
  receivedBy,
  commandKey,
  desiredReceivedByItem,
  substitutionAcknowledgements = null,
  nextStateVersion,
}) {
  const acknowledgements = acknowledgedItemIds(substitutionAcknowledgements);
  const allocations = await tx.$queryRawUnsafe(
    `SELECT allocation.*, batch.expiry_date
       FROM ward_indent_inventory_allocations allocation
       JOIN pharmacy_inventory_batches batch
         ON batch.tenant_id = allocation.tenant_id
        AND batch.id = allocation.inventory_batch_id
      WHERE allocation.tenant_id = $1::uuid
        AND allocation.ward_indent_id = $2::int
        AND allocation.status IN ('partially_issued', 'issued', 'reconciled')
      ORDER BY allocation.ward_indent_item_id, batch.expiry_date, allocation.id
      FOR UPDATE OF allocation`,
    indent.tenant_id,
    Number(indent.id),
  );
  const byItem = new Map();
  for (const allocation of allocations) {
    const itemId = Number(allocation.ward_indent_item_id);
    if (!byItem.has(itemId)) byItem.set(itemId, []);
    byItem.get(itemId).push(allocation);
  }

  for (const wardItem of indent.items) {
    const itemId = Number(wardItem.id);
    const desired = positiveQuantity(
      desiredReceivedByItem.get(itemId) ?? Number(wardItem.quantity_received || 0),
      'quantity_received',
      { allowZero: true },
    );
    if (
      wardItem.substitution_status === 'approved'
      && desired > Number(wardItem.quantity_received || 0)
      && !wardItem.substitution_acknowledged_at
      && !acknowledgements.has(itemId)
    ) {
      throw AppError.conflict(
        `Approved substitution for ward indent item ${itemId} requires ward acknowledgement`,
        'WARD_INDENT_SUBSTITUTION_ACKNOWLEDGEMENT_REQUIRED',
        { item_id: itemId },
      );
    }
    if (acknowledgements.has(itemId)) {
      if (wardItem.substitution_status !== 'approved') {
        throw AppError.badRequest(`Ward indent item ${itemId} has no approved substitution to acknowledge`);
      }
      await tx.$executeRawUnsafe(
        `UPDATE ward_indent_items
            SET substitution_acknowledged_by = $1::uuid,
                substitution_acknowledged_at = COALESCE(substitution_acknowledged_at, NOW()),
                substitution_acknowledged_event_version = COALESCE(
                  substitution_acknowledged_event_version,
                  $2::int
                ),
                updated_at = NOW()
          WHERE tenant_id = $3::uuid AND id = $4::int`,
        receivedBy,
        Number(nextStateVersion),
        indent.tenant_id,
        itemId,
      );
    }
    const itemAllocations = byItem.get(itemId) || [];
    const totalIssued = itemAllocations.reduce(
      (sum, allocation) => sum + Number(allocation.issued_quantity),
      0,
    );
    if (Math.abs(totalIssued - Number(wardItem.quantity_issued || 0)) > 1e-9) {
      throw AppError.conflict(
        `Ward indent item ${itemId} issue projection does not match exact allocations`,
        'WARD_INDENT_ALLOCATION_ISSUE_PROJECTION_MISMATCH',
      );
    }
    if (desired > totalIssued + 1e-9) {
      throw AppError.badRequest(`Ward indent item ${itemId} receipt exceeds exact issued stock`);
    }
    let remaining = desired;
    for (const allocation of itemAllocations) {
      const projected = Math.min(remaining, Number(allocation.issued_quantity));
      const currentReceived = Number(allocation.received_quantity);
      if (projected + 1e-9 < currentReceived) {
        throw AppError.conflict(
          `Ward indent item ${itemId} cannot reduce an exact-batch receipt`,
          'WARD_INDENT_ALLOCATION_RECEIPT_DECREASE_FORBIDDEN',
        );
      }
      const quantityDelta = Math.round((projected - currentReceived) * 10000) / 10000;
      if (quantityDelta > 0) {
        await tx.$executeRawUnsafe(
          `INSERT INTO ward_indent_inventory_receipt_events
             (tenant_id, inventory_allocation_id, ward_indent_id, ward_indent_item_id,
              inventory_batch_id, ward_indent_state_version, quantity_delta,
              command_key, received_by)
           VALUES ($1::uuid, $2::bigint, $3::int, $4::int, $5::int,
                   $6::int, $7::numeric, $8::text, $9::uuid)`,
          indent.tenant_id,
          allocation.id,
          Number(indent.id),
          itemId,
          Number(allocation.inventory_batch_id),
          Number(nextStateVersion),
          quantityDelta,
          durableKey(
            'ward-indent-receipt',
            commandKey,
            indent.id,
            itemId,
            allocation.id,
            nextStateVersion,
          ),
          receivedBy,
        );
      }
      remaining = Math.round((remaining - projected) * 10000) / 10000;
    }
    if (remaining > 1e-9) {
      throw AppError.conflict(
        `Ward indent item ${itemId} has no exact allocation for its receipt`,
        'WARD_INDENT_RECEIPT_ALLOCATION_MISSING',
      );
    }
  }
}

function allocationReturnMap(entries) {
  const result = new Map();
  for (const entry of (Array.isArray(entries) ? entries : [])) {
    const allocationId = positiveBigInt(entry?.allocation_id, 'allocation_id');
    const allocationKey = allocationId.toString();
    if (result.has(allocationKey)) {
      throw AppError.badRequest(`Duplicate allocation return ${allocationKey}`);
    }
    result.set(allocationKey, positiveQuantity(entry?.quantity, 'return quantity'));
  }
  return result;
}

async function originalChargeTx(tx, tenantId, wardItemId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM ward_indent_financial_events
      WHERE tenant_id = $1::uuid
        AND ward_indent_item_id = $2::int
        AND event_kind = 'charge'
      ORDER BY occurred_at, id
      LIMIT 1`,
    tenantId,
    Number(wardItemId),
  );
  if (!rows[0]) {
    throw AppError.conflict(
      `Ward indent item ${wardItemId} has no original charge evidence`,
      'WARD_INDENT_ORIGINAL_CHARGE_REQUIRED',
    );
  }
  return rows[0];
}

export async function returnWardIndentInventoryTx(tx, {
  indent,
  returnedBy,
  commandKey,
  nextStateVersion,
  controlledEvidenceByItem = new Map(),
  allocationReturns = null,
}) {
  const requestedByAllocation = allocationReturnMap(allocationReturns);
  const allocations = await tx.$queryRawUnsafe(
    `SELECT allocation.*, item.schedule_class, item.is_narcotic,
            batch.expiry_date, batch.batch_number, batch.lot_number
       FROM ward_indent_inventory_allocations allocation
       JOIN pharmacy_inventory_items item
         ON item.tenant_id = allocation.tenant_id
        AND item.id = allocation.inventory_item_id
       JOIN pharmacy_inventory_batches batch
         ON batch.tenant_id = allocation.tenant_id
        AND batch.id = allocation.inventory_batch_id
      WHERE allocation.tenant_id = $1::uuid
        AND allocation.ward_indent_id = $2::int
        AND allocation.status IN ('partially_issued', 'issued', 'reconciled')
      ORDER BY allocation.ward_indent_item_id, batch.expiry_date DESC, allocation.id DESC
      FOR UPDATE OF allocation, batch`,
    indent.tenant_id,
    Number(indent.id),
  );
  const byItem = new Map();
  for (const allocation of allocations) {
    const itemId = Number(allocation.ward_indent_item_id);
    if (!byItem.has(itemId)) byItem.set(itemId, []);
    byItem.get(itemId).push(allocation);
  }
  const returnPlans = [];
  const movementIds = [];
  const catalogIds = [];
  const usedAllocationKeys = new Set();

  for (const wardItem of indent.items) {
    const outstanding = Math.round((
      Number(wardItem.quantity_return_requested || 0)
      - Number(wardItem.quantity_returned || 0)
    ) * 10000) / 10000;
    if (outstanding <= 0) continue;
    const itemAllocations = byItem.get(Number(wardItem.id)) || [];
    const explicit = itemAllocations.filter((allocation) => (
      requestedByAllocation.has(String(allocation.id))
    ));
    let selected;
    if (explicit.length) {
      selected = explicit.map((allocation) => ({
        allocation,
        quantity: requestedByAllocation.get(String(allocation.id)),
      }));
    } else {
      const available = itemAllocations.filter((allocation) => (
        Number(allocation.received_quantity)
          - Number(allocation.consumed_quantity)
          - Number(allocation.returned_quantity)
      ) > 0);
      if (available.length !== 1) {
        throw AppError.conflict(
          `Ward indent item ${wardItem.id} spans multiple exact batches; allocation_returns is required`,
          'WARD_INDENT_ALLOCATION_RETURN_SELECTION_REQUIRED',
          {
            item_id: Number(wardItem.id),
            allocations: available.map((allocation) => ({
              allocation_id: normalizeBigInts(allocation.id),
              inventory_batch_id: Number(allocation.inventory_batch_id),
              return_ceiling: Number(allocation.received_quantity)
                - Number(allocation.consumed_quantity)
                - Number(allocation.returned_quantity),
            })),
          },
        );
      }
      selected = [{ allocation: available[0], quantity: outstanding }];
    }
    const selectedTotal = selected.reduce((sum, entry) => sum + entry.quantity, 0);
    if (Math.abs(selectedTotal - outstanding) > 1e-9) {
      throw AppError.badRequest(
        `Ward indent item ${wardItem.id} allocation returns must total ${outstanding}`,
      );
    }

    const controlled = selected.some(({ allocation }) => (
      allocation.is_narcotic === true
      || ['H', 'H1', 'X'].includes(String(allocation.schedule_class || '').toUpperCase())
    ));
    if (controlled && selected.length !== 1) {
      throw AppError.conflict(
        `Controlled ward indent item ${wardItem.id} requires one exact witnessed batch return`,
        'WARD_INDENT_CONTROLLED_ALLOCATION_MISMATCH',
      );
    }
    for (const entry of selected) {
      usedAllocationKeys.add(String(entry.allocation.id));
      const ceiling = Number(entry.allocation.received_quantity)
        - Number(entry.allocation.consumed_quantity)
        - Number(entry.allocation.returned_quantity);
      if (entry.quantity > ceiling + 1e-9) {
        throw AppError.conflict(
          `Ward indent allocation ${entry.allocation.id} return exceeds unconsumed ward custody`,
          'WARD_INDENT_RETURN_EXCEEDS_UNCONSUMED_CUSTODY',
          { allocation_id: normalizeBigInts(entry.allocation.id), return_ceiling: ceiling },
        );
      }
      if (controlled) {
        const evidence = controlledEvidenceByItem.get(Number(wardItem.id));
        if (!evidence) {
          throw AppError.badRequest(`Controlled return evidence is required for item ${wardItem.id}`);
        }
        await linkControlledWardIndentMovementTx(tx, {
          indent,
          wardItem,
          movementId: evidence.movementId,
          controlledRegisterId: evidence.registerId,
          purpose: 'return',
          actor: returnedBy,
          commandKey,
          stateVersion: nextStateVersion,
        });
        movementIds.push(Number(evidence.movementId));
      } else {
        const { movement } = await recordMovementTx(tx, {
          tenantId: indent.tenant_id,
          inventory_item_id: Number(entry.allocation.inventory_item_id),
          inventory_batch_id: Number(entry.allocation.inventory_batch_id),
          movement_kind: 'return',
          quantity: entry.quantity,
          reference_type: 'ward_indent_return_allocation',
          reference_id: String(entry.allocation.id),
          notes: `Ward indent ${indent.indent_number} return item ${wardItem.id}`,
          performed_by: returnedBy,
        });
        await insertMovementLinkTx(tx, {
          tenantId: indent.tenant_id,
          allocationId: entry.allocation.id,
          movementId: movement.id,
          purpose: 'return',
          quantity: entry.quantity,
          stateVersion: nextStateVersion,
          commandKey: durableKey(
            'ward-indent-return-link',
            commandKey,
            indent.id,
            wardItem.id,
            entry.allocation.id,
          ),
          actor: returnedBy,
        });
        movementIds.push(Number(movement.id));
      }
    }
    const charge = indent.patient_uid == null
      ? null
      : await originalChargeTx(tx, indent.tenant_id, wardItem.id);
    returnPlans.push({ wardItem, quantity: outstanding, originalCharge: charge });
    catalogIds.push(Number(wardItem.pharmacy_catalog_id));
  }
  for (const allocationKey of requestedByAllocation.keys()) {
    if (!allocations.some((allocation) => String(allocation.id) === allocationKey)) {
      throw AppError.badRequest(`Allocation return ${allocationKey} does not belong to this ward indent`);
    }
    if (!usedAllocationKeys.has(allocationKey)) {
      throw AppError.badRequest(
        `Allocation return ${allocationKey} is not part of an outstanding return request`,
      );
    }
  }
  await projectLegacyCatalogBalancesTx(tx, indent.tenant_id, catalogIds);
  return { returnPlans, movementIds };
}

export async function appendWardIndentCreditEventsTx(tx, {
  indent,
  wardEvent,
  returnedBy,
  commandKey,
  returnPlans,
  reason,
}) {
  const financialEvents = [];
  const creditNotes = [];
  for (const plan of returnPlans) {
    if (indent.patient_uid == null) continue;
    const charge = plan.originalCharge;
    const eventRows = await tx.$queryRawUnsafe(
      `INSERT INTO ward_indent_financial_events
         (tenant_id, ward_indent_id, ward_indent_item_id, clinical_order_id,
          ward_indent_event_id, ward_indent_state_version, event_kind,
          quantity, unit_price_minor, amount_minor, currency, pricing_snapshot,
          original_event_id, invoice_id, invoice_item_id, event_key, actor_uid)
       VALUES ($1::uuid, $2::int, $3::int, $4::int, $5::bigint, $6::int,
               'credit', $7::numeric, $8::bigint,
               -ROUND($7::numeric * $8::bigint)::bigint,
               $9::text, $10::jsonb, $11::bigint, $12::int, $13::int,
               $14::text, $15::uuid)
       RETURNING *`,
      indent.tenant_id,
      Number(indent.id),
      Number(plan.wardItem.id),
      plan.wardItem.clinical_order_id == null ? null : Number(plan.wardItem.clinical_order_id),
      BigInt(wardEvent.id),
      Number(wardEvent.state_version),
      plan.quantity,
      BigInt(charge.unit_price_minor),
      String(charge.currency),
      JSON.stringify({
        ...charge.pricing_snapshot,
        credit_reason: reason,
        original_charge_event_id: String(charge.id),
      }),
      BigInt(charge.id),
      charge.invoice_id == null ? null : Number(charge.invoice_id),
      charge.invoice_item_id == null ? null : Number(charge.invoice_item_id),
      durableKey('ward-indent-credit', commandKey, indent.id, plan.wardItem.id),
      returnedBy,
    );
    const financialEvent = eventRows[0];
    financialEvents.push(financialEvent);
    if (financialEvent.invoice_id != null) {
      const note = await createBillingCreditNoteFromFinancialEventTx(tx, {
        tenantId: indent.tenant_id,
        sourceFinancialEventId: financialEvent.id,
        raisedBy: returnedBy,
        reason,
        eventKeyPrefix: durableKey(
          'ward-indent-credit-note',
          commandKey,
          indent.id,
          plan.wardItem.id,
        ),
      });
      creditNotes.push(note);
    }
  }
  return normalizeBigInts({ financialEvents, creditNotes });
}
