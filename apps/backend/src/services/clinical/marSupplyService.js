import { createHash } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { normalizeRole } from '../../utils/roles.js';
import { CONTROLLED_DISPENSE_WITNESS_ROLES } from '../pharmacy/controlledDispenseWitnessService.js';
import {
  completeMarSupplyReconciliationObligationTx,
  materializeMarSupplyReconciliationObligationTx,
} from '../ipd/wardIndentObligationService.js';
import { requireTenantId } from '../tenant/tenantService.js';

const MAX_QUANTITY = 9999999999.9999;
const POSTGRES_INTEGER_MAX = 2147483647;
const POSTGRES_BIGINT_MAX = 9223372036854775807n;
const CONTROLLED_WITNESS_ROLE_SET = new Set(CONTROLLED_DISPENSE_WITNESS_ROLES);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMAND_KEY_PATTERN = /^[A-Za-z0-9_:.-]+$/;

function normalizedIdentity(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function canonicalDoseOrStrength(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text ? text.replace(/\s+/g, '') : null;
}

function parsedOrderDetails(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function positiveCatalogId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function positiveId(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > POSTGRES_INTEGER_MAX) {
    throw AppError.badRequest(
      `${fieldName} must be a positive PostgreSQL INTEGER (1..2147483647)`,
    );
  }
  return parsed;
}

function positiveBigIntWireString(value, fieldName) {
  if (typeof value === 'bigint') {
    if (value > 0n && value <= POSTGRES_BIGINT_MAX) return value;
  } else if (typeof value === 'string'
      && /^[1-9][0-9]{0,18}$/.test(value)
      && BigInt(value) <= POSTGRES_BIGINT_MAX) {
    return BigInt(value);
  }
  {
    throw AppError.badRequest(
      `${fieldName} must be a canonical positive signed-64 decimal string`,
    );
  }
}

function positiveQuantity(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${fieldName} must be positive`);
  }
  const normalized = Math.round(parsed * 10000) / 10000;
  if (Math.abs(parsed - normalized) > 1e-9 || normalized > MAX_QUANTITY) {
    throw AppError.badRequest(`${fieldName} must have at most four decimal places`);
  }
  return normalized;
}

function optionalQuantity(value, fieldName) {
  return value == null || value === '' ? null : positiveQuantity(value, fieldName);
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
  const digest = createHash('sha256').update(candidate).digest('hex');
  return `${prefix}:${parts.join(':')}:${digest}`.slice(0, 200);
}

function normalizeWireValue(value) {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value && typeof value.toNumber === 'function') return value.toNumber();
  if (Array.isArray(value)) return value.map(normalizeWireValue);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalizeWireValue(child)]),
    );
  }
  return value;
}

function requiredUuid(value, fieldName) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!UUID_PATTERN.test(text)) throw AppError.badRequest(`${fieldName} must be a UUID`);
  return text;
}

function reconciliationCommandKey(value) {
  const key = String(value ?? '');
  if (
    key.length < 1
    || key.length > 200
    || key !== key.trim()
    || !COMMAND_KEY_PATTERN.test(key)
  ) {
    throw AppError.badRequest('Idempotency-Key must be 1-200 chars [A-Za-z0-9_-:.]');
  }
  return key;
}

async function loadWardContextTx(tx, tenantId, administration, { lock = true } = {}) {
  if (!administration.clinical_order_id) {
    throw AppError.conflict(
      'MAR administration is not directly linked to a medication order',
      'MAR_SUPPLY_ORDER_REQUIRED',
      { medication_administration_id: Number(administration.id) },
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT item.id, item.ward_indent_id, item.clinical_order_id,
            item.item_name, item.pharmacy_catalog_id,
            item.original_pharmacy_catalog_id,
            item.substitution_status,
            item.substitution_acknowledged_by::text,
            item.substitution_acknowledged_at,
            item.substitution_acknowledged_event_version,
            indent.indent_number, indent.status AS ward_indent_status,
            indent.state_version AS ward_indent_state_version,
            indent.patient_uid::text, indent.encounter_id::text,
            indent.admission_id, indent.tenant_id::text,
            clinical_order.details AS clinical_order_details,
            clinical_order.route AS clinical_order_route,
            clinical_order.status AS clinical_order_status,
            catalog_item.id AS current_catalog_id,
            catalog_item.strength AS current_catalog_strength,
            catalog_item.strength_key AS current_catalog_strength_key,
            catalog_item.form AS current_catalog_form,
            catalog_item.form_key AS current_catalog_form_key,
            catalog_item.route AS current_catalog_route
       FROM ward_indent_items item
       JOIN ward_indents indent
         ON indent.tenant_id = item.tenant_id
        AND indent.id = item.ward_indent_id
       JOIN clinical_orders clinical_order
         ON clinical_order.tenant_id = item.tenant_id
        AND clinical_order.id = item.clinical_order_id
        AND clinical_order.order_type = 'medication'
       JOIN pharmacy_catalog catalog_item
         ON catalog_item.tenant_id = item.tenant_id
        AND catalog_item.id = item.pharmacy_catalog_id
      WHERE item.tenant_id = $1::uuid
        AND item.clinical_order_id = $2::int
        AND indent.patient_uid = $3::uuid
      ORDER BY item.id
      LIMIT 2
      ${lock ? 'FOR SHARE OF item, indent, clinical_order, catalog_item' : ''}`,
    tenantId,
    Number(administration.clinical_order_id),
    String(administration.patient_uid),
  );
  if (rows.length === 0) {
    throw AppError.conflict(
      'MAR medication order has no tenant-bound ward-indent item',
      'MAR_SUPPLY_WARD_ITEM_REQUIRED',
      {
        medication_administration_id: Number(administration.id),
        clinical_order_id: Number(administration.clinical_order_id),
      },
    );
  }
  if (rows.length !== 1) {
    throw AppError.conflict(
      'MAR medication order resolves to more than one ward-indent item',
      'MAR_SUPPLY_WARD_ITEM_AMBIGUOUS',
      {
        medication_administration_id: Number(administration.id),
        clinical_order_id: Number(administration.clinical_order_id),
      },
    );
  }
  const wardItem = rows[0];
  return {
    wardItem,
    indent: {
      id: Number(wardItem.ward_indent_id),
      indent_number: wardItem.indent_number,
      status: wardItem.ward_indent_status,
      state_version: Number(wardItem.ward_indent_state_version),
      patient_uid: wardItem.patient_uid,
      encounter_id: wardItem.encounter_id,
      admission_id: wardItem.admission_id == null ? null : Number(wardItem.admission_id),
      tenant_id: wardItem.tenant_id,
    },
  };
}

function assertWardProductIdentity(wardItem, administration) {
  const details = parsedOrderDetails(wardItem.clinical_order_details);
  const orderedCatalogId = positiveCatalogId(details.catalog_id ?? details.catalogId);
  const currentCatalogId = positiveCatalogId(wardItem.pharmacy_catalog_id);
  const originalCatalogId = positiveCatalogId(wardItem.original_pharmacy_catalog_id);
  const substitutionApproved = String(wardItem.substitution_status || '').toLowerCase() === 'approved';

  if (!['ordered', 'verified', 'in_progress'].includes(
    String(wardItem.clinical_order_status || '').toLowerCase(),
  )) {
    throw AppError.conflict(
      'Medication order is no longer active for bedside administration',
      'MAR_CLINICAL_ORDER_INACTIVE',
    );
  }

  if (!orderedCatalogId || !currentCatalogId || !positiveCatalogId(wardItem.current_catalog_id)) {
    throw AppError.conflict(
      'Medication product identity is incomplete; a tenant catalog identity is required before administration',
      'MAR_PRODUCT_IDENTITY_REQUIRED',
      { medication_administration_id: Number(administration.id) },
    );
  }
  if (substitutionApproved) {
    if (
      originalCatalogId !== orderedCatalogId
      || !wardItem.substitution_acknowledged_at
      || !wardItem.substitution_acknowledged_by
    ) {
      throw AppError.conflict(
        'Approved substitution is missing prescriber-order lineage or ward acknowledgement',
        'MAR_PRODUCT_SUBSTITUTION_EVIDENCE_REQUIRED',
      );
    }
  } else if (currentCatalogId !== orderedCatalogId) {
    throw AppError.conflict(
      'Ward product identity does not match the prescribed catalog product',
      'MAR_PRODUCT_IDENTITY_MISMATCH',
    );
  }

  return {
    details,
    orderedCatalogId,
    administeredCatalogId: currentCatalogId,
    substitutionApproved,
  };
}

async function loadAvailableAllocationsTx(tx, tenantId, wardIndentItemId, { lock = false } = {}) {
  return tx.$queryRawUnsafe(
    `SELECT allocation.id, allocation.ward_indent_id,
            allocation.ward_indent_item_id, allocation.inventory_item_id,
            allocation.inventory_batch_id, allocation.status,
            allocation.received_quantity, allocation.consumed_quantity,
            allocation.returned_quantity,
            (allocation.received_quantity - allocation.consumed_quantity
              - allocation.returned_quantity)::numeric AS available_quantity,
            batch.batch_number, batch.lot_number, batch.expiry_date,
            batch.status AS batch_status, batch.metadata AS batch_metadata,
            mar_supply_batch_unavailable_reason(
              item.status,
              batch.status,
              batch.expiry_date,
              allocation.received_quantity - allocation.consumed_quantity
                - allocation.returned_quantity
            ) AS batch_unavailable_reason,
            mar_supply_batch_unavailable_reason(
              item.status,
              batch.status,
              batch.expiry_date,
              allocation.received_quantity - allocation.consumed_quantity
                - allocation.returned_quantity
            ) IS NULL AS batch_eligible,
            item.display_name, item.sku_code, item.catalog_id,
            item.form AS inventory_form, item.strength AS inventory_strength,
            item.schedule_class, item.is_narcotic,
            item.status AS inventory_item_status,
            item.metadata AS inventory_item_metadata
       FROM ward_indent_inventory_allocations allocation
       JOIN pharmacy_inventory_batches batch
         ON batch.tenant_id = allocation.tenant_id
        AND batch.id = allocation.inventory_batch_id
       JOIN pharmacy_inventory_items item
         ON item.tenant_id = allocation.tenant_id
        AND item.id = allocation.inventory_item_id
      WHERE allocation.tenant_id = $1::uuid
        AND allocation.ward_indent_item_id = $2::int
        AND allocation.status <> 'released'
        AND allocation.received_quantity - allocation.consumed_quantity
              - allocation.returned_quantity > 0
      ORDER BY batch.expiry_date, allocation.id
      ${lock ? 'FOR UPDATE OF allocation, batch FOR SHARE OF item' : ''}`,
    tenantId,
    wardIndentItemId,
  );
}

const ROUTE_ALIASES = Object.freeze({
  po: 'oral',
  intravenous: 'iv',
  intramuscular: 'im',
  subcutaneous: 'sc',
  subq: 'sc',
  sq: 'sc',
  sl: 'sublingual',
  pr: 'rectal',
  td: 'transdermal',
  inh: 'inhaled',
});

const FORM_ALIASES = Object.freeze({
  tab: 'tablet',
  tabs: 'tablet',
  cap: 'capsule',
  caps: 'capsule',
  inj: 'injection',
  syrup: 'liquid',
  solution: 'liquid',
});

function canonicalClinicalText(value, aliases = {}) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  const compact = normalizedIdentity(raw);
  return aliases[raw] || aliases[compact] || compact || null;
}

function metadataObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function batchBarcodeCandidates(allocation) {
  const metadata = metadataObject(allocation.batch_metadata);
  return [
    ['inventory_batch_barcode', metadata.barcode],
    ['inventory_batch_gtin', metadata.gtin],
    ['inventory_batch_qr', metadata.qr_code ?? metadata.qrCode],
    ['inventory_batch_number', allocation.batch_number],
    ['inventory_lot_number', allocation.lot_number],
  ].filter(([, value]) => String(value ?? '').trim());
}

function batchUnavailableReason(allocation) {
  if (Object.hasOwn(allocation, 'batch_unavailable_reason')) {
    const reason = String(allocation.batch_unavailable_reason || '').trim();
    return reason || null;
  }
  if (String(allocation.inventory_item_status || '').toLowerCase() !== 'active') {
    return 'inventory_item_inactive';
  }
  const status = String(allocation.batch_status || '').toLowerCase();
  const hasWardCustody = Number(allocation.available_quantity || 0) > 0;
  if (status !== 'in_stock' && !(status === 'depleted' && hasWardCustody)) {
    return `batch_${status || 'status_missing'}`;
  }
  if (!allocation.expiry_date) return 'batch_expiry_missing';
  if (allocation.batch_eligible !== true) return 'batch_expired';
  return null;
}

/**
 * Resolve one bedside scan to the exact tenant/order/ward allocation identity.
 * Free-text medication names and substring matching are deliberately excluded.
 */
export async function evaluateMarScanIdentityTx(tx, {
  tenantId,
  administration,
  scannedBarcode,
  lock = false,
}) {
  const tid = requireTenantId(tenantId);
  const barcode = String(scannedBarcode || '').trim();
  if (!barcode) throw AppError.badRequest('scanned_barcode is required');
  const { wardItem, indent } = await loadWardContextTx(tx, tid, administration, { lock });
  const identity = assertWardProductIdentity(wardItem, administration);
  const allocations = await loadAvailableAllocationsTx(
    tx,
    tid,
    Number(wardItem.id),
    { lock },
  );
  const currentCatalogId = identity.administeredCatalogId;
  const catalogAligned = allocations.length > 0 && allocations.every(
    (allocation) => positiveCatalogId(allocation.catalog_id) === currentCatalogId,
  );

  const exactMatches = [];
  for (const allocation of allocations) {
    for (const [mode, value] of batchBarcodeCandidates(allocation)) {
      if (String(value).trim().toLowerCase() === barcode.toLowerCase()) {
        exactMatches.push({ allocation, mode });
      }
    }
  }
  const distinctBatchIds = new Set(
    exactMatches.map(({ allocation }) => Number(allocation.inventory_batch_id)),
  );
  const exact = distinctBatchIds.size === 1 ? exactMatches[0] : null;
  const allocation = exact?.allocation || null;
  const details = identity.details;

  const orderDose = canonicalDoseOrStrength(details.dose ?? details.dosage);
  const marDose = canonicalDoseOrStrength(administration.dose ?? administration.dosage);
  const doseMatches = Boolean(orderDose && marDose && orderDose === marDose);

  const orderRoute = canonicalClinicalText(
    wardItem.clinical_order_route ?? details.route,
    ROUTE_ALIASES,
  );
  const marRoute = canonicalClinicalText(administration.route, ROUTE_ALIASES);
  const catalogRoute = canonicalClinicalText(wardItem.current_catalog_route, ROUTE_ALIASES);
  const routeMatches = Boolean(
    orderRoute
      && marRoute
      && catalogRoute
      && orderRoute === marRoute
      && catalogRoute === orderRoute,
  );

  const orderStrength = canonicalDoseOrStrength(details.strength_key ?? details.strength);
  const catalogStrength = canonicalDoseOrStrength(
    wardItem.current_catalog_strength_key ?? wardItem.current_catalog_strength,
  );
  const inventoryStrength = canonicalDoseOrStrength(allocation?.inventory_strength);
  const strengthMatches = Boolean(
    orderStrength
      && catalogStrength
      && inventoryStrength
      && orderStrength === catalogStrength
      && inventoryStrength === catalogStrength,
  );

  const orderForm = canonicalClinicalText(details.form_key ?? details.form, FORM_ALIASES);
  const catalogForm = canonicalClinicalText(
    wardItem.current_catalog_form_key ?? wardItem.current_catalog_form,
    FORM_ALIASES,
  );
  const inventoryForm = canonicalClinicalText(allocation?.inventory_form, FORM_ALIASES);
  const formMatches = Boolean(
    orderForm
      && catalogForm
      && inventoryForm
      && orderForm === catalogForm
      && inventoryForm === catalogForm,
  );

  const batchReason = allocation ? batchUnavailableReason(allocation) : null;
  const barcodeMatches = Boolean(exact && distinctBatchIds.size === 1);
  const drugMatches = Boolean(
    catalogAligned
      && barcodeMatches
      && !batchReason
      && strengthMatches
      && formMatches,
  );
  let identityFailure = null;
  if (!catalogAligned) identityFailure = 'catalog_allocation_mismatch';
  else if (distinctBatchIds.size > 1) identityFailure = 'barcode_batch_ambiguous';
  else if (!barcodeMatches) identityFailure = 'authoritative_batch_barcode_mismatch';
  else if (batchReason) identityFailure = batchReason;
  else if (!strengthMatches) identityFailure = 'strength_evidence_mismatch_or_missing';
  else if (!formMatches) identityFailure = 'form_evidence_mismatch_or_missing';

  return {
    rightDrug: drugMatches,
    rightDose: doseMatches,
    rightRoute: routeMatches,
    scannedInventoryBatchId: drugMatches ? Number(allocation.inventory_batch_id) : null,
    controlled: drugMatches
      ? allocation.is_narcotic === true || String(allocation.schedule_class || '').toUpperCase() === 'X'
      : null,
    context: {
      drugMatchMode: drugMatches ? exact.mode : null,
      identityFailure,
      orderedCatalogId: identity.orderedCatalogId,
      administeredCatalogId: identity.administeredCatalogId,
      inventoryItemId: allocation ? Number(allocation.inventory_item_id) : null,
      inventoryBatchId: allocation ? Number(allocation.inventory_batch_id) : null,
      batchNumber: allocation?.batch_number || null,
      lotNumber: allocation?.lot_number || null,
      batchStatus: allocation?.batch_status || null,
      batchExpiryDate: allocation?.expiry_date || null,
      strengthMatched: strengthMatches,
      formMatched: formMatches,
      doseMatched: doseMatches,
      routeMatched: routeMatches,
      substitutionApproved: identity.substitutionApproved,
      wardIndentId: Number(indent.id),
      wardIndentItemId: Number(wardItem.id),
    },
  };
}

async function productControlClassificationTx(tx, tenantId, wardItem, allocations) {
  const itemRows = new Map();
  for (const allocation of allocations) {
    itemRows.set(Number(allocation.inventory_item_id), allocation);
  }
  if (itemRows.size === 0) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, catalog_id, status AS inventory_item_status,
              schedule_class, is_narcotic
         FROM pharmacy_inventory_items
        WHERE tenant_id = $1::uuid
          AND catalog_id = $2::int
          AND status = 'active'
        ORDER BY id
        LIMIT 2
        FOR SHARE`,
      tenantId,
      positiveCatalogId(wardItem.pharmacy_catalog_id),
    );
    for (const row of rows) itemRows.set(Number(row.id), row);
  }
  if (itemRows.size !== 1) {
    throw AppError.conflict(
      'Controlled-drug classification cannot be resolved to one inventory product',
      'MAR_CONTROL_CLASSIFICATION_UNAVAILABLE',
    );
  }
  const item = [...itemRows.values()][0];
  return {
    inventoryItemId: Number(item.inventory_item_id ?? item.id),
    scheduleClass: item.schedule_class || null,
    controlled: item.is_narcotic === true || String(item.schedule_class || '').toUpperCase() === 'X',
  };
}

async function assertControlledMarWitnessTx(tx, {
  tenantId,
  administeredBy,
  witnessUid,
  control,
}) {
  if (!control.controlled) return null;
  const witness = String(witnessUid || '').trim().toLowerCase();
  const actor = String(administeredBy || '').trim().toLowerCase();
  if (!witness) {
    throw AppError.conflict(
      'An independent authorized witness is required for controlled bedside administration',
      'MAR_CONTROLLED_WITNESS_REQUIRED',
    );
  }
  if (witness === actor) {
    throw AppError.conflict(
      'The administering clinician cannot witness their own controlled dose',
      'MAR_CONTROLLED_WITNESS_SEPARATION_REQUIRED',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT user_row.uid::text, user_row.role,
            COALESCE(NULLIF(BTRIM(staff_row.name), ''), user_row.name) AS name
       FROM users user_row
       JOIN staff staff_row
         ON staff_row.tenant_id = user_row.tenant_id
        AND staff_row.user_id = user_row.uid
      WHERE user_row.tenant_id = $1::uuid
        AND user_row.uid = $2::uuid
        AND user_row.is_active = TRUE
        AND user_row.status = 'active'
        AND COALESCE(user_row.is_deleted, FALSE) = FALSE
        AND staff_row.is_active = TRUE
        AND COALESCE(staff_row.archived, FALSE) = FALSE
      LIMIT 1
      FOR SHARE OF user_row, staff_row`,
    tenantId,
    witness,
  );
  const row = rows[0];
  const role = normalizeRole(row?.role);
  if (!row || !role || !CONTROLLED_WITNESS_ROLE_SET.has(role)) {
    throw AppError.conflict(
      'Controlled-dose witness is not an active authorized clinical staff member in this tenant',
      'MAR_CONTROLLED_WITNESS_NOT_AUTHORIZED',
    );
  }
  return {
    uid: row.uid,
    role,
    name: row.name,
    inventory_item_id: control.inventoryItemId,
    schedule_class: control.scheduleClass,
  };
}

async function insertConsumptionTx(tx, values) {
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO mar_supply_consumptions
       (tenant_id, medication_administration_id, clinical_order_id,
        ward_indent_item_id, inventory_allocation_id, inventory_batch_id,
        quantity, evidence_status, administration_mode, command_key,
        recorded_by, override_reason, override_recorded_at,
        reconciliation_task_id)
     VALUES ($1::uuid, $2::int, $3::int, $4::int, $5::bigint, $6::int,
             $7::numeric, $8::text, $9::text, $10::text, $11::uuid,
             $12::text,
             CASE WHEN $8::text = 'unmatched_override' THEN NOW() ELSE NULL END,
             $13::int)
     ON CONFLICT (tenant_id, command_key) DO NOTHING
     RETURNING id, tenant_id::text, medication_administration_id,
               clinical_order_id, ward_indent_item_id, inventory_allocation_id,
               inventory_batch_id, quantity, evidence_status,
               administration_mode, command_key, recorded_by::text,
               override_reason, override_recorded_at, reconciliation_task_id,
               created_at`,
    values.tenantId,
    values.medicationAdministrationId,
    values.clinicalOrderId,
    values.wardIndentItemId,
    values.inventoryAllocationId,
    values.inventoryBatchId,
    values.quantity,
    values.evidenceStatus,
    values.administrationMode,
    values.commandKey,
    values.recordedBy,
    values.overrideReason,
    values.reconciliationTaskId,
  );
  if (rows[0]) return rows[0];
  const replay = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id::text, medication_administration_id,
            clinical_order_id, ward_indent_item_id, inventory_allocation_id,
            inventory_batch_id, quantity, evidence_status,
            administration_mode, command_key, recorded_by::text,
            override_reason, override_recorded_at, reconciliation_task_id,
            created_at
       FROM mar_supply_consumptions
      WHERE tenant_id = $1::uuid
        AND command_key = $2::text
      LIMIT 1`,
    values.tenantId,
    values.commandKey,
  );
  const existing = replay[0];
  if (
    !existing
    || Number(existing.medication_administration_id) !== values.medicationAdministrationId
    || Number(existing.clinical_order_id) !== values.clinicalOrderId
    || Number(existing.ward_indent_item_id) !== values.wardIndentItemId
    || String(existing.inventory_allocation_id ?? '')
      !== String(values.inventoryAllocationId ?? '')
    || Math.abs(Number(existing.quantity) - values.quantity) > 1e-9
    || existing.evidence_status !== values.evidenceStatus
    || existing.recorded_by !== values.recordedBy
  ) {
    throw AppError.conflict(
      'Idempotency-Key is already bound to different MAR supply evidence',
      'MAR_SUPPLY_IDEMPOTENCY_CONFLICT',
    );
  }
  return existing;
}

export async function consumeMarSupplyTx(tx, {
  tenantId,
  administration,
  recordedBy,
  witnessUid = null,
  administrationMode,
  commandKey,
  supplyQuantity = null,
  supplyOverrideReason = null,
  scannedInventoryBatchId = null,
}) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal(
      'MAR supply consumption requires the caller transaction',
      'MAR_SUPPLY_TRANSACTION_REQUIRED',
    );
  }
  const tid = requireTenantId(tenantId);
  if (!administration?.id || administration.tenant_id !== tid) {
    throw AppError.conflict(
      'MAR supply administration context changed',
      'MAR_SUPPLY_ADMINISTRATION_CONTEXT_MISMATCH',
    );
  }
  const actorUid = requiredText(recordedBy, 'recordedBy', 100);
  const mode = requiredText(administrationMode, 'administrationMode', 50);
  const explicitQuantity = optionalQuantity(supplyQuantity, 'supply_quantity');
  const scheduledQuantity = optionalQuantity(
    administration.supply_quantity_per_dose,
    'supply_quantity_per_dose',
  );
  if (
    explicitQuantity != null
    && scheduledQuantity != null
    && Math.abs(explicitQuantity - scheduledQuantity) > 1e-9
  ) {
    throw AppError.conflict(
      'Supplied MAR custody quantity does not match the scheduled dose quantity',
      'MAR_SUPPLY_QUANTITY_MISMATCH',
      { scheduled_quantity: scheduledQuantity, supplied_quantity: explicitQuantity },
    );
  }
  const quantity = scheduledQuantity ?? explicitQuantity;
  if (quantity == null) {
    throw AppError.conflict(
      'A structured ward-supply quantity is required before administration',
      'MAR_SUPPLY_QUANTITY_REQUIRED',
      { medication_administration_id: Number(administration.id) },
    );
  }
  if (scheduledQuantity == null) {
    const updated = await tx.$queryRawUnsafe(
      `UPDATE medication_administrations
          SET supply_quantity_per_dose = $3::numeric,
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid
          AND id = $2::int
          AND supply_quantity_per_dose IS NULL
        RETURNING id`,
      tid,
      Number(administration.id),
      quantity,
    );
    if (updated.length !== 1) {
      throw AppError.conflict(
        'MAR structured supply quantity changed',
        'MAR_SUPPLY_QUANTITY_STATE_CONFLICT',
      );
    }
    administration.supply_quantity_per_dose = quantity;
  }

  const { wardItem, indent } = await loadWardContextTx(tx, tid, administration);
  assertWardProductIdentity(wardItem, administration);
  const substitutionAcknowledged = String(wardItem.substitution_status || '').toLowerCase() !== 'approved'
    || Boolean(wardItem.substitution_acknowledged_at);
  const custodyAllocations = await loadAvailableAllocationsTx(
    tx,
    tid,
    Number(wardItem.id),
    { lock: true },
  );
  if (custodyAllocations.some(
    (allocation) => positiveCatalogId(allocation.catalog_id)
      !== positiveCatalogId(wardItem.pharmacy_catalog_id),
  )) {
    throw AppError.conflict(
      'Ward custody allocation does not match the administered catalog product',
      'MAR_PRODUCT_ALLOCATION_MISMATCH',
    );
  }
  const requestedBatchId = scannedInventoryBatchId == null
    ? null
    : positiveId(scannedInventoryBatchId, 'scannedInventoryBatchId');
  const scannedAllocations = requestedBatchId == null
    ? custodyAllocations
    : custodyAllocations.filter(
      (allocation) => Number(allocation.inventory_batch_id) === requestedBatchId,
    );
  if (requestedBatchId != null && scannedAllocations.length === 0) {
    throw AppError.conflict(
      'Scanned medication batch is not present in received ward custody for this order',
      'MAR_SCANNED_BATCH_NOT_IN_WARD_CUSTODY',
    );
  }
  const unavailableScannedBatch = requestedBatchId == null
    ? null
    : scannedAllocations.find((allocation) => batchUnavailableReason(allocation));
  if (unavailableScannedBatch) {
    throw AppError.conflict(
      'Scanned medication batch is expired, recalled, quarantined, inactive, or otherwise unavailable',
      'MAR_BATCH_UNAVAILABLE',
      {
        inventory_batch_id: requestedBatchId,
        reason: batchUnavailableReason(unavailableScannedBatch),
      },
    );
  }
  const allocations = scannedAllocations.filter(
    (allocation) => batchUnavailableReason(allocation) === null,
  );
  const availableQuantity = allocations.reduce(
    (sum, allocation) => sum + Number(allocation.available_quantity || 0),
    0,
  );
  const totalCustodyQuantity = scannedAllocations.reduce(
    (sum, allocation) => sum + Number(allocation.available_quantity || 0),
    0,
  );
  if (totalCustodyQuantity + 1e-9 >= quantity && availableQuantity + 1e-9 < quantity) {
    const unavailable = scannedAllocations.find((allocation) => batchUnavailableReason(allocation));
    throw AppError.conflict(
      'Available ward custody belongs to an expired, recalled, quarantined, inactive, or otherwise unavailable batch',
      'MAR_BATCH_UNAVAILABLE',
      { reason: unavailable ? batchUnavailableReason(unavailable) : 'batch_unavailable' },
    );
  }
  const control = await productControlClassificationTx(
    tx,
    tid,
    wardItem,
    allocations.length > 0 ? allocations : custodyAllocations,
  );
  const witness = await assertControlledMarWitnessTx(tx, {
    tenantId: tid,
    administeredBy: actorUid,
    witnessUid,
    control,
  });
  const exactCustodyAvailable = substitutionAcknowledged
    && availableQuantity + 1e-9 >= quantity;
  const baseCommand = commandKey
    ? requiredText(commandKey, 'Idempotency-Key', 1000)
    : `mar-administration:${administration.id}:${mode}`;

  if (!exactCustodyAvailable) {
    const reason = supplyOverrideReason
      ? requiredText(supplyOverrideReason, 'supply_override_reason', 500)
      : null;
    if (!reason) {
      const code = !substitutionAcknowledged
        ? 'MAR_SUPPLY_SUBSTITUTION_ACK_REQUIRED'
        : 'MAR_SUPPLY_CUSTODY_UNAVAILABLE';
      throw AppError.conflict(
        !substitutionAcknowledged
          ? 'Approved substitution must be acknowledged at ward receipt before administration'
          : 'Received unconsumed ward custody is insufficient for this administration',
        code,
        {
          medication_administration_id: Number(administration.id),
          ward_indent_id: Number(indent.id),
          ward_indent_item_id: Number(wardItem.id),
          required_quantity: quantity,
          available_quantity: availableQuantity,
        },
      );
    }
    const task = await materializeMarSupplyReconciliationObligationTx(tx, {
      administration,
      wardItem,
      indent,
      actorUid,
      overrideReason: reason,
    });
    const consumption = await insertConsumptionTx(tx, {
      tenantId: tid,
      medicationAdministrationId: Number(administration.id),
      clinicalOrderId: Number(administration.clinical_order_id),
      wardIndentItemId: Number(wardItem.id),
      inventoryAllocationId: null,
      inventoryBatchId: null,
      quantity,
      evidenceStatus: 'unmatched_override',
      administrationMode: mode,
      commandKey: durableKey('mar-supply-override', baseCommand, administration.id),
      recordedBy: actorUid,
      overrideReason: reason,
      reconciliationTaskId: Number(task.id),
    });
    return normalizeWireValue({
      status: 'unmatched_override',
      quantity,
      available_quantity: availableQuantity,
      ward_indent: indent,
      ward_indent_item: wardItem,
      consumptions: [consumption],
      reconciliation_task_id: Number(task.id),
      controlled_witness: witness,
    });
  }

  const consumptions = [];
  let remaining = quantity;
  for (const allocation of allocations) {
    if (remaining <= 1e-9) break;
    const used = Math.min(remaining, Number(allocation.available_quantity));
    if (used <= 0) continue;
    const normalizedUsed = Math.round(used * 10000) / 10000;
    consumptions.push(await insertConsumptionTx(tx, {
      tenantId: tid,
      medicationAdministrationId: Number(administration.id),
      clinicalOrderId: Number(administration.clinical_order_id),
      wardIndentItemId: Number(wardItem.id),
      inventoryAllocationId: BigInt(allocation.id),
      inventoryBatchId: Number(allocation.inventory_batch_id),
      quantity: normalizedUsed,
      evidenceStatus: 'matched',
      administrationMode: mode,
      commandKey: durableKey(
        'mar-supply-match',
        baseCommand,
        administration.id,
        allocation.id,
      ),
      recordedBy: actorUid,
      overrideReason: null,
      reconciliationTaskId: null,
    }));
    remaining = Math.round((remaining - normalizedUsed) * 10000) / 10000;
  }
  if (remaining > 1e-9) {
    throw AppError.conflict(
      'Ward custody changed during MAR consumption',
      'MAR_SUPPLY_CUSTODY_STATE_CONFLICT',
    );
  }
  return normalizeWireValue({
    status: 'matched',
    quantity,
    available_quantity_before: availableQuantity,
    ward_indent: indent,
    ward_indent_item: wardItem,
    consumptions,
    reconciliation_task_id: null,
    controlled_witness: witness,
  });
}

export async function getMarSupplyStateTx(tx, {
  tenantId,
  medicationAdministrationId,
}) {
  const tid = requireTenantId(tenantId);
  const administrationId = positiveId(
    medicationAdministrationId,
    'medicationAdministrationId',
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id::text, patient_uid::text, clinical_order_id,
            supply_quantity_per_dose, status
       FROM medication_administrations
      WHERE tenant_id = $1::uuid
        AND id = $2::int
      LIMIT 1`,
    tid,
    administrationId,
  );
  const administration = rows[0];
  if (!administration) throw AppError.notFound('Medication administration record not found');
  if (!administration.clinical_order_id) {
    return {
      status: 'order_link_required',
      medication_administration_id: administrationId,
      clinical_order_id: null,
      supply_quantity_per_dose: administration.supply_quantity_per_dose,
      allocations: [],
      consumptions: [],
    };
  }

  let context;
  try {
    context = await loadWardContextTx(tx, tid, administration, { lock: false });
  } catch (err) {
    if (['MAR_SUPPLY_WARD_ITEM_REQUIRED', 'MAR_SUPPLY_WARD_ITEM_AMBIGUOUS'].includes(err?.code)) {
      return {
        status: err.code === 'MAR_SUPPLY_WARD_ITEM_AMBIGUOUS'
          ? 'ward_item_ambiguous'
          : 'ward_item_required',
        medication_administration_id: administrationId,
        clinical_order_id: Number(administration.clinical_order_id),
        supply_quantity_per_dose: administration.supply_quantity_per_dose,
        allocations: [],
        consumptions: [],
      };
    }
    throw err;
  }
  const allocations = await loadAvailableAllocationsTx(
    tx,
    tid,
    Number(context.wardItem.id),
  );
  const consumptions = await tx.$queryRawUnsafe(
    `SELECT consumption.id, consumption.tenant_id::text,
            consumption.medication_administration_id,
            consumption.clinical_order_id, consumption.ward_indent_item_id,
            consumption.inventory_allocation_id,
            consumption.inventory_batch_id, consumption.quantity,
            consumption.evidence_status, consumption.administration_mode,
            consumption.command_key, consumption.recorded_by::text,
            consumption.override_reason, consumption.override_recorded_at,
            consumption.reconciliation_task_id, consumption.created_at,
            COALESCE(reconciled.quantity, 0)::numeric AS reconciled_quantity
       FROM mar_supply_consumptions consumption
       LEFT JOIN LATERAL (
         SELECT SUM(link.quantity)::numeric AS quantity
           FROM mar_supply_reconciliation_links link
          WHERE link.tenant_id = consumption.tenant_id
            AND link.unmatched_consumption_id = consumption.id
       ) reconciled ON TRUE
      WHERE consumption.tenant_id = $1::uuid
        AND consumption.medication_administration_id = $2::int
      ORDER BY consumption.id`,
    tid,
    administrationId,
  );
  const eligibleAllocations = allocations.filter(
    (allocation) => batchUnavailableReason(allocation) === null,
  );
  const availableQuantity = eligibleAllocations.reduce(
    (sum, allocation) => sum + Number(allocation.available_quantity || 0),
    0,
  );
  const totalCustodyQuantity = allocations.reduce(
    (sum, allocation) => sum + Number(allocation.available_quantity || 0),
    0,
  );
  const openOverride = consumptions.some(
    (consumption) => consumption.evidence_status === 'unmatched_override'
      && Number(consumption.reconciled_quantity || 0) + 1e-9 < Number(consumption.quantity),
  );
  const substitutionAcknowledged = String(context.wardItem.substitution_status || '').toLowerCase()
    !== 'approved' || Boolean(context.wardItem.substitution_acknowledged_at);
  const scheduledQuantity = optionalQuantity(
    administration.supply_quantity_per_dose,
    'supply_quantity_per_dose',
  );
  const status = openOverride
    ? 'reconciliation_required'
    : !substitutionAcknowledged
      ? 'substitution_acknowledgement_required'
      : scheduledQuantity == null
        ? 'quantity_required'
        : totalCustodyQuantity + 1e-9 >= scheduledQuantity
            && availableQuantity + 1e-9 < scheduledQuantity
          ? 'batch_unavailable'
        : availableQuantity + 1e-9 >= scheduledQuantity
          ? 'available'
          : 'custody_unavailable';
  return normalizeWireValue({
    status,
    medication_administration_id: administrationId,
    clinical_order_id: Number(administration.clinical_order_id),
    supply_quantity_per_dose: administration.supply_quantity_per_dose,
    available_quantity: availableQuantity,
    ward_indent: context.indent,
    ward_indent_item: context.wardItem,
    allocations: allocations.map((allocation) => ({
      ...allocation,
      id: String(allocation.id),
      batch_eligible: batchUnavailableReason(allocation) === null,
      batch_unavailable_reason: batchUnavailableReason(allocation),
    })),
    consumptions: consumptions.map((consumption) => ({
      ...consumption,
      id: String(consumption.id),
      inventory_allocation_id: consumption.inventory_allocation_id == null
        ? null
        : String(consumption.inventory_allocation_id),
    })),
  });
}

export async function getMarSupplyState(medicationAdministrationId, { tenantId }) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, (tx) => getMarSupplyStateTx(tx, {
    tenantId: tid,
    medicationAdministrationId,
  }), { readOnly: true });
}

function allocationEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw AppError.badRequest('allocations must be a non-empty array');
  }
  const byId = new Map();
  for (const entry of entries) {
    const allocationId = positiveBigIntWireString(
      entry?.inventory_allocation_id ?? entry?.allocation_id,
      'inventory_allocation_id',
    );
    const quantity = positiveQuantity(entry?.quantity, 'quantity');
    const key = allocationId.toString();
    const current = byId.get(key) || { inventoryAllocationId: allocationId, quantity: 0 };
    current.quantity = positiveQuantity(current.quantity + quantity, 'quantity');
    byId.set(key, current);
  }
  return [...byId.values()]
    .sort((left, right) => (
      left.inventoryAllocationId < right.inventoryAllocationId ? -1
        : left.inventoryAllocationId > right.inventoryAllocationId ? 1 : 0
    ));
}

function marSupplyReconciliationFingerprint({
  consumptionId,
  expectedMedicationAdministrationId,
  entries,
}) {
  const normalized = {
    consumption_id: consumptionId.toString(),
    expected_medication_administration_id: expectedMedicationAdministrationId,
    allocations: entries.map((entry) => ({
      inventory_allocation_id: entry.inventoryAllocationId.toString(),
      quantity: entry.quantity.toFixed(4),
    })),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function assertReconciliationReceiptMatches(receipt, identity) {
  if (
    String(receipt.unmatched_consumption_id) !== identity.unmatchedConsumptionId.toString()
    || Number(receipt.medication_administration_id) !== identity.medicationAdministrationId
    || receipt.actor_uid !== identity.actorUid
    || receipt.command_key !== identity.commandKey
    || receipt.request_body_sha256 !== identity.requestBodySha256
  ) {
    throw AppError.unprocessable(
      'Idempotency-Key is already bound to a different MAR supply reconciliation request',
      'MAR_SUPPLY_RECONCILIATION_COMMAND_MISMATCH',
      {
        unmatched_consumption_id: identity.unmatchedConsumptionId.toString(),
        medication_administration_id: identity.medicationAdministrationId,
      },
    );
  }
  if (
    !receipt.response_data
    || typeof receipt.response_data !== 'object'
    || Array.isArray(receipt.response_data)
  ) {
    throw AppError.conflict(
      'MAR supply reconciliation command receipt is incomplete',
      'MAR_SUPPLY_RECONCILIATION_COMMAND_RECEIPT_INCOMPLETE',
    );
  }
  return normalizeWireValue(receipt.response_data);
}

async function findMarSupplyReconciliationReplayTx(tx, identity) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id::text, unmatched_consumption_id,
            medication_administration_id, actor_uid::text, command_key,
            request_body_sha256::text AS request_body_sha256,
            response_data, completed_at
       FROM mar_supply_reconciliation_command_receipts
      WHERE tenant_id = $1::uuid
        AND command_key = $2::text
      LIMIT 1`,
    identity.tenantId,
    identity.commandKey,
  );
  if (!rows[0]) return null;
  return assertReconciliationReceiptMatches(rows[0], identity);
}

async function recordMarSupplyReconciliationReceiptTx(tx, identity, responseData) {
  const normalizedResponse = normalizeWireValue(responseData);
  const inserted = await tx.$queryRawUnsafe(
    `INSERT INTO mar_supply_reconciliation_command_receipts
       (tenant_id, unmatched_consumption_id, medication_administration_id,
        actor_uid, command_key, request_body_sha256, response_data)
     VALUES ($1::uuid, $2::bigint, $3::int, $4::uuid, $5::text,
             $6::char(64), $7::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING id, tenant_id::text, unmatched_consumption_id,
               medication_administration_id, actor_uid::text, command_key,
               request_body_sha256::text AS request_body_sha256,
               response_data, completed_at`,
    identity.tenantId,
    identity.unmatchedConsumptionId,
    identity.medicationAdministrationId,
    identity.actorUid,
    identity.commandKey,
    identity.requestBodySha256,
    JSON.stringify(normalizedResponse),
  );
  if (inserted[0]) return assertReconciliationReceiptMatches(inserted[0], identity);

  const rows = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id::text, unmatched_consumption_id,
            medication_administration_id, actor_uid::text, command_key,
            request_body_sha256::text AS request_body_sha256,
            response_data, completed_at
       FROM mar_supply_reconciliation_command_receipts
      WHERE tenant_id = $1::uuid
        AND command_key = $2::text
      LIMIT 1`,
    identity.tenantId,
    identity.commandKey,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'MAR supply reconciliation command receipt changed concurrently',
      'MAR_SUPPLY_RECONCILIATION_COMMAND_CONCURRENT_CHANGE',
    );
  }
  return assertReconciliationReceiptMatches(rows[0], identity);
}

export async function reconcileMarSupplyOverride(consumptionId, allocations, {
  tenantId,
  reconciledBy,
  commandKey,
  expectedMedicationAdministrationId = null,
}) {
  const tid = requireTenantId(tenantId);
  const unmatchedConsumptionId = positiveBigIntWireString(consumptionId, 'consumptionId');
  const actorUid = requiredUuid(reconciledBy, 'reconciledBy');
  const entries = allocationEntries(allocations);
  const baseCommand = reconciliationCommandKey(commandKey);
  const expectedAdministrationId = expectedMedicationAdministrationId == null
    ? null
    : positiveId(expectedMedicationAdministrationId, 'medicationAdministrationId');
  const requestBodySha256 = marSupplyReconciliationFingerprint({
    consumptionId: unmatchedConsumptionId,
    expectedMedicationAdministrationId: expectedAdministrationId,
    entries,
  });
  if (!SHA256_PATTERN.test(requestBodySha256)) {
    throw AppError.internal(
      'MAR supply reconciliation request fingerprint is invalid',
      'MAR_SUPPLY_RECONCILIATION_COMMAND_INVALID',
    );
  }
  return setTenantTx(tid, async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(
         pg_catalog.hashtextextended(
           'mar-supply-reconciliation:' || $1::uuid::text || ':' || $2::bigint::text,
           0
         )
       )::text AS lock_result`,
      tid,
      unmatchedConsumptionId,
    );
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id::text, medication_administration_id,
              clinical_order_id, ward_indent_item_id, inventory_allocation_id,
              inventory_batch_id, quantity, evidence_status,
              administration_mode, command_key, recorded_by::text,
              override_reason, override_recorded_at, reconciliation_task_id,
              created_at
         FROM mar_supply_consumptions
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
        LIMIT 1`,
      tid,
      unmatchedConsumptionId,
    );
    const consumption = rows[0];
    if (!consumption) throw AppError.notFound('MAR supply override consumption not found');
    const identity = {
      tenantId: tid,
      unmatchedConsumptionId,
      medicationAdministrationId: Number(consumption.medication_administration_id),
      actorUid,
      commandKey: baseCommand,
      requestBodySha256,
    };
    const replay = await findMarSupplyReconciliationReplayTx(tx, identity);
    if (replay) return replay;
    if (
      expectedAdministrationId != null
      && Number(consumption.medication_administration_id)
        !== expectedAdministrationId
    ) {
      throw AppError.notFound('MAR supply override consumption not found');
    }
    if (consumption.evidence_status !== 'unmatched_override') {
      throw AppError.conflict(
        'Only unmatched MAR supply evidence can be reconciled',
        'MAR_SUPPLY_RECONCILIATION_NOT_REQUIRED',
      );
    }

    const links = [];
    for (const entry of entries) {
      const allocationRows = await tx.$queryRawUnsafe(
        `SELECT allocation.inventory_batch_id, allocation.status,
                allocation.received_quantity, allocation.consumed_quantity,
                allocation.returned_quantity,
                (allocation.received_quantity - allocation.consumed_quantity
                  - allocation.returned_quantity)::numeric AS available_quantity,
                batch.status AS batch_status, batch.expiry_date,
                item.status AS inventory_item_status,
                mar_supply_batch_unavailable_reason(
                  item.status,
                  batch.status,
                  batch.expiry_date,
                  allocation.received_quantity - allocation.consumed_quantity
                    - allocation.returned_quantity
                ) AS batch_unavailable_reason
           FROM ward_indent_inventory_allocations allocation
           JOIN pharmacy_inventory_batches batch
             ON batch.tenant_id = allocation.tenant_id
            AND batch.id = allocation.inventory_batch_id
            AND batch.inventory_item_id = allocation.inventory_item_id
           JOIN pharmacy_inventory_items item
             ON item.tenant_id = allocation.tenant_id
            AND item.id = allocation.inventory_item_id
          WHERE allocation.tenant_id = $1::uuid
            AND allocation.id = $2::bigint
          LIMIT 1
          FOR UPDATE OF allocation, batch FOR SHARE OF item`,
        tid,
        entry.inventoryAllocationId,
      );
      const allocation = allocationRows[0];
      if (!allocation) throw AppError.notFound('Ward inventory allocation not found');
      if (String(allocation.status || '').toLowerCase() === 'released') {
        throw AppError.conflict(
          'Ward inventory allocation is no longer available for MAR reconciliation',
          'MAR_SUPPLY_RECONCILIATION_ALLOCATION_UNAVAILABLE',
        );
      }
      const unavailableReason = batchUnavailableReason(allocation);
      if (unavailableReason) {
        throw AppError.conflict(
          'MAR reconciliation requires currently eligible ward batch custody',
          'MAR_SUPPLY_RECONCILIATION_BATCH_UNAVAILABLE',
          {
            inventory_allocation_id: entry.inventoryAllocationId.toString(),
            inventory_batch_id: Number(allocation.inventory_batch_id),
            reason: unavailableReason,
          },
        );
      }
      const linkCommandKey = durableKey(
        'mar-supply-reconcile',
        baseCommand,
        unmatchedConsumptionId,
        entry.inventoryAllocationId,
      );
      const inserted = await tx.$queryRawUnsafe(
        `INSERT INTO mar_supply_reconciliation_links
           (tenant_id, unmatched_consumption_id, clinical_order_id,
            ward_indent_item_id, inventory_allocation_id, inventory_batch_id,
            quantity, command_key, reconciled_by)
         VALUES ($1::uuid, $2::bigint, $3::int, $4::int, $5::bigint, $6::int,
                 $7::numeric, $8::text, $9::uuid)
         ON CONFLICT (tenant_id, command_key) DO NOTHING
         RETURNING id, tenant_id::text, unmatched_consumption_id,
                   clinical_order_id, ward_indent_item_id,
                   inventory_allocation_id, inventory_batch_id, quantity,
                   command_key, reconciled_by::text, created_at`,
        tid,
        unmatchedConsumptionId,
        Number(consumption.clinical_order_id),
        Number(consumption.ward_indent_item_id),
        entry.inventoryAllocationId,
        Number(allocation.inventory_batch_id),
        entry.quantity,
        linkCommandKey,
        actorUid,
      );
      if (inserted[0]) {
        links.push(inserted[0]);
        continue;
      }
      const replay = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id::text, unmatched_consumption_id,
                clinical_order_id, ward_indent_item_id,
                inventory_allocation_id, inventory_batch_id, quantity,
                command_key, reconciled_by::text, created_at
           FROM mar_supply_reconciliation_links
          WHERE tenant_id = $1::uuid
            AND command_key = $2::text
          LIMIT 1`,
        tid,
        linkCommandKey,
      );
      const existing = replay[0];
      if (
        !existing
        || String(existing.unmatched_consumption_id) !== unmatchedConsumptionId.toString()
        || String(existing.inventory_allocation_id) !== entry.inventoryAllocationId.toString()
        || Math.abs(Number(existing.quantity) - entry.quantity) > 1e-9
        || existing.reconciled_by !== actorUid
      ) {
        throw AppError.conflict(
          'Idempotency-Key is already bound to different MAR reconciliation evidence',
          'MAR_SUPPLY_RECONCILIATION_IDEMPOTENCY_CONFLICT',
        );
      }
      links.push(existing);
    }

    const totals = await tx.$queryRawUnsafe(
      `SELECT COALESCE(SUM(quantity), 0)::numeric AS reconciled_quantity
         FROM mar_supply_reconciliation_links
        WHERE tenant_id = $1::uuid
          AND unmatched_consumption_id = $2::bigint`,
      tid,
      unmatchedConsumptionId,
    );
    const reconciledQuantity = Number(totals[0]?.reconciled_quantity || 0);
    const requiredQuantity = Number(consumption.quantity);
    if (Math.abs(reconciledQuantity - requiredQuantity) <= 1e-9) {
      await completeMarSupplyReconciliationObligationTx(tx, {
        consumption,
        reconciliationLink: links[links.length - 1],
        actorUid,
      });
    }
    const state = await getMarSupplyStateTx(tx, {
      tenantId: tid,
      medicationAdministrationId: Number(consumption.medication_administration_id),
    });
    const response = normalizeWireValue({
      consumption: {
        ...consumption,
        id: String(consumption.id),
        inventory_allocation_id: consumption.inventory_allocation_id == null
          ? null
          : String(consumption.inventory_allocation_id),
      },
      links: links.map((link) => ({
        ...link,
        unmatched_consumption_id: String(link.unmatched_consumption_id),
        inventory_allocation_id: String(link.inventory_allocation_id),
      })),
      reconciled_quantity: reconciledQuantity,
      outstanding_quantity: Math.max(0, requiredQuantity - reconciledQuantity),
      state,
    });
    return recordMarSupplyReconciliationReceiptTx(tx, identity, response);
  });
}

export default {
  consumeMarSupplyTx,
  evaluateMarScanIdentityTx,
  getMarSupplyState,
  getMarSupplyStateTx,
  reconcileMarSupplyOverride,
};
