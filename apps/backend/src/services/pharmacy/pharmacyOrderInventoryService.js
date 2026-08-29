import { createHash } from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { lockTenantPatientMergeStability } from '../../utils/patientMergeStabilityLock.js';
import {
  assertPharmacyCapForDispenseTx,
  lockPharmacyFundingAuthorityTx,
  resolveAuthoritativeCounterFundingTx,
  resolvePharmacyFundingPatientUidTx,
} from './pharmacyCapService.js';
import {
  CONTROLLED_SUBSTITUTION_AUTHORITY,
  dispenseControlledTx,
  recordMovementTx,
} from './inventoryV2Service.js';
import {
  assertPharmacyFacilityGrant,
  requireOrderFacility,
} from './pharmacyFacilityAuthorityService.js';
import {
  assertVerificationClearedTx,
  clinicalCatalogAuthoritySha256Tx,
  clinicalOrderItemsSha256,
} from './pharmacistVerificationService.js';
import { emitPharmacyOrderEvent } from '../clinical/canonicalOperationalBridgeService.js';

function requireSubstitutionFundingReauthorisation({
  orderId,
  currentOrderVersion,
  proposedAmount,
}) {
  throw AppError.conflict(
    'Dispense substitution requires a two-phase funding reauthorisation before stock can move',
    'SUBSTITUTION_FUNDING_REAUTHORISATION_REQUIRED',
    {
      pharmacy_order_id: Number(orderId),
      current_order_version: Number(currentOrderVersion),
      proposed_authoritative_amount: Number(proposedAmount),
      next_action: 'create_governed_substitution_funding_proposal',
    },
  );
}

const CONTROLLED_INVENTORY_SCHEDULES = new Set(['H', 'H1', 'X']);
const MEDICATION_ISSUE_ROLES = new Set(['PHARMACY_STAFF', 'PHARMACY_INCHARGE']);
const COMMAND_KEY_RE = /^[A-Za-z0-9_\-:.]{1,200}$/;
const DISPENSABLE_ORDER_STATUSES = [
  'PENDING', 'CONFIRMED', 'PREPARING', 'PARTIALLY_DISPENSED',
];
const DISPENSABLE_PRESCRIPTION_STATUSES = ['active', 'pharmacy_linked'];
const DELIVERY_ALLOCATION_ITEM_KEYS = new Set([
  'order_line_index',
  'catalog_id',
  'inventory_item_id',
  'inventory_allocations',
]);
const DELIVERY_ALLOCATION_KEYS = new Set([
  'inventory_batch_id',
  'batch_id',
  'quantity',
  'witness_approval_id',
]);

function positiveQuantity(value, label = 'quantity') {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw AppError.badRequest(`${label} must be greater than 0`, 'PHARMACY_DISPENSE_QUANTITY_INVALID');
  }
  return quantity;
}

function numericId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function controlledInventoryItem(item) {
  return CONTROLLED_INVENTORY_SCHEDULES.has(item?.schedule_class) || item?.is_narcotic === true;
}

function priorInventoryBillableTotal(line, alreadyDispensed) {
  if (alreadyDispensed <= 0.000001) return 0;
  for (const candidate of [line?.inventory_billable_total, line?.substitution_billable_total]) {
    if (candidate == null || candidate === '') continue;
    const amount = Number(candidate);
    if (Number.isFinite(amount) && amount >= 0) return amount;
  }
  const history = Array.isArray(line?.substitution_history) ? line.substitution_history : [];
  const pricedHistory = history.map((entry) => {
    const amount = Number(entry?.line_total ?? entry?.billable_subtotal);
    return Number.isFinite(amount) && amount >= 0 ? amount : null;
  });
  if (pricedHistory.length && pricedHistory.every((amount) => amount != null)) {
    return Number(pricedHistory.reduce((sum, amount) => sum + amount, 0).toFixed(2));
  }
  throw AppError.conflict(
    'Prior inventory dispense quantity has no immutable billing evidence',
    'PHARMACY_ORDER_BILLING_EVIDENCE_CONFLICT',
  );
}

export function applyAuthoritativeDeliveryAllocations(orderLines, requestedItems) {
  if (!Array.isArray(orderLines) || !orderLines.length) {
    throw AppError.unprocessable(
      'Order has no structured medication lines to deliver',
      'PHARMACY_ORDER_ITEMS_REQUIRED',
    );
  }
  const authoritative = orderLines.map((line) => ({ ...line }));
  if (!Array.isArray(requestedItems) || !requestedItems.length) return authoritative;

  const selectedLines = new Set();
  for (let requestIndex = 0; requestIndex < requestedItems.length; requestIndex += 1) {
    const requested = requestedItems[requestIndex];
    if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
      throw AppError.badRequest(
        `dispensed_items[${requestIndex}] must be an allocation object`,
        'PHARMACY_ORDER_DELIVERY_ALLOCATION_INVALID',
      );
    }
    const forbiddenKeys = Object.keys(requested)
      .filter((key) => !DELIVERY_ALLOCATION_ITEM_KEYS.has(key));
    if (forbiddenKeys.length) {
      throw AppError.badRequest(
        'Delivery line identity and quantity are server-authoritative',
        'PHARMACY_ORDER_DELIVERY_LINE_MUTATION_FORBIDDEN',
        { forbidden_fields: forbiddenKeys },
      );
    }
    const catalogId = numericId(requested.catalog_id);
    const inventoryItemId = numericId(requested.inventory_item_id);
    if (!catalogId || !inventoryItemId) {
      throw AppError.badRequest(
        'Delivery inventory selection requires catalog_id and inventory_item_id',
        'PHARMACY_ORDER_DELIVERY_ALLOCATION_INVALID',
      );
    }
    if (Object.hasOwn(requested, 'inventory_allocations')
      && (!Array.isArray(requested.inventory_allocations)
        || requested.inventory_allocations.length === 0)) {
      throw AppError.badRequest(
        'inventory_allocations must contain exact batch evidence when supplied',
        'PHARMACY_ORDER_DELIVERY_ALLOCATION_INVALID',
      );
    }
    const requestedLineIndex = Number(requested.order_line_index);
    const hasLineIndex = Number.isSafeInteger(requestedLineIndex)
      && requestedLineIndex >= 0;
    if (!hasLineIndex) {
      throw AppError.badRequest(
        'order_line_index must identify an authoritative order line',
        'PHARMACY_ORDER_DELIVERY_ALLOCATION_INVALID',
      );
    }
    const matches = authoritative
      .map((line, lineIndex) => ({ line, lineIndex }))
      .filter(({ line, lineIndex }) => Number(line?.catalog_id) === catalogId
        && lineIndex === requestedLineIndex);
    if (matches.length !== 1) {
      throw AppError.conflict(
        'Delivery allocation does not resolve to one authoritative order line',
        'PHARMACY_ORDER_DELIVERY_LINE_UNRESOLVED',
        { catalog_id: catalogId },
      );
    }
    const { line, lineIndex } = matches[0];
    if (selectedLines.has(lineIndex)) {
      throw AppError.badRequest(
        'An authoritative order line may be allocated only once',
        'PHARMACY_ORDER_DELIVERY_LINE_DUPLICATE',
      );
    }
    const authoritativeInventoryItemId = numericId(line.inventory_item_id);
    if (authoritativeInventoryItemId && authoritativeInventoryItemId !== inventoryItemId) {
      throw AppError.conflict(
        'Delivery allocation inventory item does not match the authoritative order line',
        'PHARMACY_ORDER_DELIVERY_INVENTORY_ITEM_MISMATCH',
      );
    }
    const requestedAllocations = Array.isArray(requested.inventory_allocations)
      ? requested.inventory_allocations
      : [];
    for (let allocationIndex = 0;
      allocationIndex < requestedAllocations.length;
      allocationIndex += 1) {
      const allocation = requestedAllocations[allocationIndex];
      if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation)) {
        throw AppError.badRequest(
          `inventory_allocations[${allocationIndex}] must be an object`,
          'PHARMACY_ORDER_DELIVERY_ALLOCATION_INVALID',
        );
      }
      const forbiddenAllocationKeys = Object.keys(allocation)
        .filter((key) => !DELIVERY_ALLOCATION_KEYS.has(key));
      if (forbiddenAllocationKeys.length) {
        throw AppError.badRequest(
          'Delivery allocations accept only exact batch, quantity, and witness evidence',
          'PHARMACY_ORDER_DELIVERY_ALLOCATION_INVALID',
          { forbidden_fields: forbiddenAllocationKeys },
        );
      }
    }
    authoritative[lineIndex] = {
      ...line,
      inventory_item_id: inventoryItemId,
      ...(requestedAllocations.length ? {
        inventory_allocations: requestedAllocations.map((allocation) => ({
          ...allocation,
        })),
      } : {}),
    };
    selectedLines.add(lineIndex);
  }
  return authoritative;
}

function normalizeReleaseKey(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === '' ? 'ir' : text;
}

function routesMatch(a, b) {
  const aHas = a !== null && a !== undefined && String(a).trim() !== '';
  const bHas = b !== null && b !== undefined && String(b).trim() !== '';
  if (!aHas && !bHas) return true;
  if (!aHas || !bHas) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function componentArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function strengthComponentsEqual(a, b) {
  const left = componentArray(a);
  const right = componentArray(b);
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const normalize = (component) =>
    `${String(component?.ingredient ?? '').trim().toLowerCase()}|`
    + `${String(component?.amount ?? '').trim()}|`
    + `${String(component?.unit ?? '').trim().toLowerCase()}`;
  const counts = new Map();
  for (const component of left) {
    const key = normalize(component);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const component of right) {
    const key = normalize(component);
    const count = counts.get(key);
    if (!count) return false;
    counts.set(key, count - 1);
  }
  return [...counts.values()].every((count) => count === 0);
}

export function authoritativeSubstitutionAllowed(orig, sub) {
  if (!orig || !sub) return false;
  if (orig.composition_id == null || orig.composition_id !== sub.composition_id) return false;
  if (orig.composition_confidence !== 'high' || sub.composition_confidence !== 'high') return false;
  if (!orig.strength_key || orig.strength_key !== sub.strength_key) return false;
  if (!orig.form_key || orig.form_key !== sub.form_key) return false;
  if (normalizeReleaseKey(orig.release_key) !== normalizeReleaseKey(sub.release_key)) return false;
  if (!routesMatch(orig.route, sub.route)) return false;
  const originalComponents = componentArray(orig.strength_components);
  const substituteComponents = componentArray(sub.strength_components);
  const isCombination = (Array.isArray(orig.active_ingredients) && orig.active_ingredients.length >= 2)
    || (Array.isArray(originalComponents) && originalComponents.length >= 2);
  return !isCombination || strengthComponentsEqual(originalComponents, substituteComponents);
}

function identityFingerprint(identity) {
  if (!identity) return null;
  return JSON.stringify({
    catalog_id: Number(identity.catalog_id),
    composition_id: identity.composition_id == null ? null : Number(identity.composition_id),
    active_ingredients: identity.active_ingredients ?? null,
    strength_key: identity.strength_key ?? null,
    strength_components: componentArray(identity.strength_components) ?? null,
    form_key: identity.form_key ?? null,
    release_key: normalizeReleaseKey(identity.release_key),
    route: identity.route == null ? null : String(identity.route).trim().toLowerCase(),
    composition_confidence: identity.composition_confidence ?? null,
    name: identity.name ?? null,
  });
}

async function resolveAuthenticatedPerformerNameTx(tx, { tenantId, actorUid, codePrefix }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT NULLIF(BTRIM(s.name), '') AS name, UPPER(u.role) AS role
       FROM users u
       JOIN staff s
         ON s.tenant_id = u.tenant_id
        AND s.user_id = u.uid
      WHERE u.tenant_id = $1::uuid
        AND u.uid = $2::uuid
        AND u.is_active = true
        AND u.status = 'active'
        AND COALESCE(u.is_deleted, false) = false
        AND s.is_active = true
        AND COALESCE(s.archived, false) = false
        AND s.archived_at IS NULL
      LIMIT 1
      FOR KEY SHARE OF u, s`,
    tenantId,
    String(actorUid),
  );
  const name = String(rows[0]?.name || '').trim();
  if (!name || !MEDICATION_ISSUE_ROLES.has(String(rows[0]?.role || '').toUpperCase())) {
    throw AppError.forbidden(
      'The authenticated stock performer has no active same-tenant pharmacist authority',
      `${codePrefix}_PERFORMER_IDENTITY_REQUIRED`,
      { allowed_roles: [...MEDICATION_ISSUE_ROLES] },
    );
  }
  return name;
}

export function createDispenseCommandIdentity({ tenantId, actorUid, scope, idempotencyKey }) {
  const key = String(idempotencyKey || '').trim();
  if (!COMMAND_KEY_RE.test(key)) {
    throw AppError.badRequest(
      'Idempotency-Key header is required for inventory-affecting dispense actions',
      'PHARMACY_DISPENSE_IDEMPOTENCY_KEY_REQUIRED',
    );
  }
  return createHash('sha256')
    .update(`${tenantId}:${actorUid || 'unknown'}:${scope}:${key}`)
    .digest('hex');
}

export function substitutionWitnessPayload(body = {}) {
  return {
    order_id: Number(body.order_id),
    prescription_id: Number(body.prescription_id),
    patient_uid: body.patient_uid ? String(body.patient_uid) : null,
    encounter_id: body.encounter_id == null ? null : String(body.encounter_id),
    inventory_item_id: Number(body.inventory_item_id),
    inventory_batch_id: Number(body.inventory_batch_id),
    quantity: Number(body.quantity),
    original_catalog_id: Number(body.original_catalog_id),
    final_catalog_id: Number(body.final_catalog_id),
    order_line_index: Number(body.order_line_index),
    prescription_line_index: Number(body.prescription_line_index),
    reason: body.reason ? String(body.reason).trim() : null,
    payment_mode: body.payment_mode ? String(body.payment_mode).trim().toLowerCase() : null,
    amount_collected: body.amount_collected == null ? null : Number(body.amount_collected),
    tpa_reference: body.tpa_reference ? String(body.tpa_reference).trim() : null,
  };
}

async function resolveOrderInventoryItemsTx(tx, {
  tenantId,
  facilityId,
  lines,
  preserveIntendedQuantity = false,
  skipZeroIntended = false,
}) {
  const lineReferences = lines.map((line, lineIndex) => {
    const catalogId = numericId(line?.catalog_id);
    if (!catalogId) {
      throw AppError.unprocessable(
        `Order item ${lineIndex + 1} is not linked to the pharmacy catalog`,
        'PHARMACY_ORDER_ITEM_UNRESOLVED',
      );
    }
    return {
      catalogId,
      inventoryItemId: numericId(line?.inventory_item_id),
      lineIndex,
      skipInventory: skipZeroIntended
        && Number.isFinite(Number(line?.dispensed_qty))
        && Number(line.dispensed_qty)
          <= Math.max(0, Number(line?.inventory_dispensed_quantity || 0)) + 0.000001,
    };
  });
  const catalogIds = [...new Set(lineReferences.map(({ catalogId }) => catalogId))]
    .sort((left, right) => left - right);
  const catalogs = await tx.$queryRawUnsafe(
    `SELECT id, unit_price
       FROM pharmacy_catalog
      WHERE tenant_id = $1::uuid
        AND id = ANY($2::int[])
        AND is_active = TRUE
      ORDER BY id
      FOR UPDATE`,
    tenantId,
    catalogIds,
  );
  const catalogById = new Map(catalogs.map((catalog) => [Number(catalog.id), catalog]));
  const missingCatalogId = catalogIds.find((catalogId) => !catalogById.has(catalogId));
  if (missingCatalogId) {
    throw AppError.conflict(
      'An authoritative pharmacy catalog line is no longer active',
      'PHARMACY_ORDER_CATALOG_INACTIVE',
      { catalog_id: missingCatalogId },
    );
  }

  const inventory = await tx.$queryRawUnsafe(
    `SELECT id, catalog_id, facility_id, display_name, unit_label,
            schedule_class, is_narcotic, status
       FROM pharmacy_inventory_items
      WHERE tenant_id = $1::uuid
        AND facility_id = $2::int
        AND catalog_id = ANY($3::int[])
      ORDER BY id
      FOR UPDATE`,
    tenantId,
    facilityId,
    catalogIds,
  );
  return lineReferences.map(({ catalogId, inventoryItemId, lineIndex, skipInventory }) => {
    if (skipInventory) {
      if (!inventoryItemId) {
        throw AppError.conflict(
          `Order item ${lineIndex + 1} has dispense evidence without an Inventory V2 item identity`,
          'PHARMACY_ORDER_INVENTORY_EVIDENCE_CONFLICT',
          { order_line_index: lineIndex, catalog_id: catalogId },
        );
      }
      const historicalItem = inventory.find((item) => Number(item.id) === inventoryItemId
        && Number(item.catalog_id) === catalogId);
      if (!historicalItem) {
        throw AppError.conflict(
          `Order item ${lineIndex + 1} has stale or cross-authority Inventory V2 evidence`,
          'PHARMACY_ORDER_INVENTORY_EVIDENCE_CONFLICT',
          {
            order_line_index: lineIndex,
            catalog_id: catalogId,
            inventory_item_id: inventoryItemId,
          },
        );
      }
      return {
        ...historicalItem,
        id: inventoryItemId,
        catalog_id: catalogId,
        facility_id: facilityId,
        unit_price: catalogById.get(catalogId).unit_price,
        skipped: true,
      };
    }
    const matches = inventory.filter((item) => Number(item.catalog_id) === catalogId
      && item.status === 'active'
      && (!inventoryItemId || Number(item.id) === inventoryItemId));
    if (!matches.length) {
      throw AppError.unprocessable(
        `Order item ${lineIndex + 1} has no active Inventory V2 item`,
        'PHARMACY_ORDER_INVENTORY_ITEM_UNRESOLVED',
        { catalog_id: catalogId },
      );
    }
    if (matches.length > 1) {
      throw AppError.conflict(
        `Order item ${lineIndex + 1} maps to multiple Inventory V2 items; select inventory_item_id`,
        'PHARMACY_ORDER_INVENTORY_ITEM_AMBIGUOUS',
        {
          order_line_index: lineIndex,
          catalog_id: catalogId,
          facility_id: facilityId,
          inventory_item_candidates: matches.map((item) => ({
            inventory_item_id: Number(item.id),
            display_name: item.display_name || null,
            unit_label: item.unit_label || null,
            schedule_class: item.schedule_class || null,
            is_narcotic: item.is_narcotic === true,
          })),
          recovery_action: {
            action: 'select_inventory_item',
            request_shape: {
              dispensed_items: [{
                order_line_index: lineIndex,
                catalog_id: catalogId,
                inventory_item_id: 'selected_inventory_item_id',
                ...(preserveIntendedQuantity ? {
                  dispensed_quantity: Number(
                    lines[lineIndex]?.dispensed_qty
                      ?? lines[lineIndex]?.quantity
                      ?? lines[lineIndex]?.qty,
                  ),
                } : {}),
              }],
            },
          },
        },
      );
    }
    return {
      ...matches[0],
      catalog_id: catalogId,
      unit_price: catalogById.get(catalogId).unit_price,
    };
  });
}

export async function resolveCounterDispenseAuthorityTx(tx, {
  tenantId,
  facilityId,
  lines,
  completeRemainder = false,
}) {
  if (!Array.isArray(lines) || !lines.length) {
    throw AppError.unprocessable(
      'Order has no structured medication lines to dispense',
      'PHARMACY_ORDER_ITEMS_REQUIRED',
    );
  }

  const inventoryItems = await resolveOrderInventoryItemsTx(tx, {
    tenantId,
    facilityId,
    lines,
    preserveIntendedQuantity: !completeRemainder,
    skipZeroIntended: !completeRemainder,
  });
  const resolved = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = { ...lines[index] };
    const orderedQuantity = positiveQuantity(
      line.ordered_qty ?? line.quantity ?? line.qty,
      `items_list[${index}].quantity`,
    );
    const intendedQuantity = completeRemainder
      ? orderedQuantity
      : Number(line.dispensed_qty ?? line.qty ?? line.quantity);
    if (!Number.isFinite(intendedQuantity) || intendedQuantity < 0) {
      throw AppError.badRequest(
        `items_list[${index}].dispensed_quantity must be non-negative`,
        'PHARMACY_DISPENSE_QUANTITY_INVALID',
      );
    }
    if (intendedQuantity - orderedQuantity > 0.000001) {
      throw AppError.conflict(
        `Order item ${index + 1} exceeds its authoritative ordered quantity`,
        'PHARMACY_ORDER_DISPENSE_EXCEEDS_ORDERED_QUANTITY',
        { ordered_quantity: orderedQuantity, intended_quantity: intendedQuantity },
      );
    }
    const inventoryItem = inventoryItems[index];
    const unitPrice = Number(inventoryItem.unit_price);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw AppError.conflict(
        `Order item ${index + 1} has no positive authoritative catalog price`,
        'PHARMACY_ORDER_CATALOG_PRICE_REQUIRED',
        { catalog_id: Number(inventoryItem.catalog_id) },
      );
    }
    const alreadyDispensed = Math.max(0, Number(line.inventory_dispensed_quantity || 0));
    if (!Number.isFinite(alreadyDispensed) || alreadyDispensed - intendedQuantity > 0.000001) {
      throw AppError.conflict(
        `Order item ${index + 1} has inconsistent inventory fulfilment evidence`,
        'PHARMACY_ORDER_INVENTORY_EVIDENCE_CONFLICT',
      );
    }
    const priorBillableTotal = priorInventoryBillableTotal(line, alreadyDispensed);
    const currentBillableTotal = Number(
      (unitPrice * (intendedQuantity - alreadyDispensed)).toFixed(2),
    );
    const cumulativeBillableTotal = Number(
      (priorBillableTotal + currentBillableTotal).toFixed(2),
    );
    resolved.push({
      ...line,
      order_line_index: index,
      catalog_id: Number(inventoryItem.catalog_id),
      inventory_item_id: Number(inventoryItem.id),
      ordered_qty: orderedQuantity,
      dispensed_qty: intendedQuantity,
      price: unitPrice,
      inventory_billable_total: cumulativeBillableTotal,
      line_total: cumulativeBillableTotal,
    });
  }
  const incrementalQuantity = resolved.reduce((sum, line) => sum + Math.max(
    0,
    Number(line.dispensed_qty) - Number(line.inventory_dispensed_quantity || 0),
  ), 0);
  if (incrementalQuantity <= 0.000001) {
    throw AppError.conflict(
      'A dispense command must issue a positive incremental medication quantity',
      'PHARMACY_ORDER_DISPENSE_NO_EFFECT',
    );
  }
  return resolved;
}

function prescriptionCatalogCandidates(line) {
  return new Set([
    Number(line?.catalog_id),
    Number(line?.original_catalog_id),
    Number(line?.substitution?.original_catalog_id),
    Number(line?.substitution?.requested_catalog_id),
    ...((Array.isArray(line?.substitution_history) ? line.substitution_history : [])
      .flatMap((entry) => [Number(entry?.original_catalog_id), Number(entry?.final_catalog_id)])),
  ].filter((catalogId) => Number.isSafeInteger(catalogId) && catalogId > 0));
}

export function resolvePrescriptionLineIndexes(lines, prescriptionMedications) {
  const selectedPrescriptionLines = new Set();
  return lines.map((line, orderLineIndex) => {
    if (!line || typeof line !== 'object' || Array.isArray(line)) {
      throw AppError.unprocessable(
        `Order item ${orderLineIndex + 1} has no structured line identity`,
        'PHARMACY_ORDER_ITEM_UNRESOLVED',
      );
    }
    if (Object.hasOwn(line, 'order_line_index')
      && Number(line.order_line_index) !== orderLineIndex) {
      throw AppError.conflict(
        `Order item ${orderLineIndex + 1} carries an invalid stable line identity`,
        'PHARMACY_ORDER_LINE_IDENTITY_CONFLICT',
      );
    }
    const catalogIds = prescriptionCatalogCandidates(line);
    const rawPrescriptionLineIndex = line?.prescription_line_index;
    const explicitPrescriptionLineIndex = Number(rawPrescriptionLineIndex);
    const medication = Number.isSafeInteger(explicitPrescriptionLineIndex)
      && explicitPrescriptionLineIndex >= 0
      ? prescriptionMedications[explicitPrescriptionLineIndex]
      : null;
    if (!medication || !catalogIds.has(Number(medication.catalog_id))) {
      throw AppError.conflict(
        `Order item ${orderLineIndex + 1} has no exact linked prescription line identity`,
        'PHARMACY_ORDER_PRESCRIPTION_LINE_UNRESOLVED',
        {
          order_line_index: orderLineIndex,
          prescription_line_index: Number.isSafeInteger(explicitPrescriptionLineIndex)
            ? explicitPrescriptionLineIndex
            : null,
        },
      );
    }
    const prescriptionLineIndex = explicitPrescriptionLineIndex;
    if (selectedPrescriptionLines.has(prescriptionLineIndex)) {
      throw AppError.conflict(
        'Multiple order lines resolve to the same linked prescription line',
        'PHARMACY_ORDER_PRESCRIPTION_LINE_AMBIGUOUS',
        {
          order_line_index: orderLineIndex,
          prescription_line_index: prescriptionLineIndex,
        },
      );
    }
    selectedPrescriptionLines.add(prescriptionLineIndex);
    return prescriptionLineIndex;
  });
}

function exactRequestedAllocations(line, requiredQuantity) {
  const raw = Array.isArray(line?.inventory_allocations) ? line.inventory_allocations : [];
  if (!raw.length) return null;
  const allocations = raw.map((allocation, index) => ({
    inventory_batch_id: numericId(allocation?.inventory_batch_id ?? allocation?.batch_id),
    quantity: positiveQuantity(allocation?.quantity, `inventory_allocations[${index}].quantity`),
    witness_approval_id: allocation?.witness_approval_id ?? null,
  }));
  if (allocations.some((allocation) => !allocation.inventory_batch_id)) {
    throw AppError.badRequest(
      'Every inventory allocation requires inventory_batch_id',
      'PHARMACY_ORDER_BATCH_ALLOCATION_INVALID',
    );
  }
  if (new Set(allocations.map((allocation) => allocation.inventory_batch_id)).size !== allocations.length) {
    throw AppError.badRequest(
      'An inventory batch may appear only once per order line',
      'PHARMACY_ORDER_BATCH_ALLOCATION_DUPLICATE',
    );
  }
  const total = allocations.reduce((sum, allocation) => sum + allocation.quantity, 0);
  if (Math.abs(total - requiredQuantity) > 0.000001) {
    throw AppError.badRequest(
      'Inventory allocation quantities must exactly equal the quantity being dispensed',
      'PHARMACY_ORDER_BATCH_ALLOCATION_MISMATCH',
      { required_quantity: requiredQuantity, allocated_quantity: total },
    );
  }
  return allocations;
}

function fefoAllocationsFromLockedBatches(batches, availableByBatch, {
  inventoryItemId,
  quantity,
}) {
  const candidates = batches
    .filter((batch) => Number(batch.inventory_item_id) === inventoryItemId
      && batch.status === 'in_stock'
      && Number(availableByBatch.get(Number(batch.id)) || 0) > 0)
    .sort((left, right) => {
      const expiry = String(left.expiry_date).localeCompare(String(right.expiry_date));
      return expiry || Number(left.id) - Number(right.id);
    });
  let remaining = quantity;
  const allocations = [];
  for (const batch of candidates) {
    if (remaining <= 0.000001) break;
    const batchId = Number(batch.id);
    const available = Number(availableByBatch.get(batchId) || 0);
    const take = Math.min(available, remaining);
    if (take <= 0) continue;
    allocations.push({
      inventory_batch_id: Number(batch.id),
      batch_number: batch.batch_number,
      lot_number: batch.lot_number,
      expiry_date: batch.expiry_date,
      quantity: take,
    });
    availableByBatch.set(batchId, available - take);
    remaining -= take;
  }
  if (remaining > 0.000001) {
    throw AppError.badRequest(
      `Insufficient usable Inventory V2 stock; short by ${remaining}`,
      'INVENTORY_INSUFFICIENT_STOCK',
      { inventory_item_id: inventoryItemId, short_by: remaining },
    );
  }
  return allocations;
}

export async function allocateOrderInventoryTx(tx, {
  tenantId,
  order,
  lines,
  actorUid,
  commandKeySha256,
  operation,
  completeRemainder = false,
}) {
  if (!Array.isArray(lines) || !lines.length) {
    throw AppError.unprocessable(
      'Order has no structured medication lines to dispense',
      'PHARMACY_ORDER_ITEMS_REQUIRED',
    );
  }
  if (!actorUid) {
    throw AppError.forbidden(
      'An authenticated stock performer is required',
      'PHARMACY_DISPENSE_ACTOR_REQUIRED',
    );
  }
  const facilityId = requireOrderFacility(order);
  let resolvedActorName = await resolveAuthenticatedPerformerNameTx(tx, {
    tenantId,
    actorUid,
    codePrefix: 'PHARMACY_ORDER',
  });
  const patientRows = order.patient_id
    ? await tx.$queryRawUnsafe(
      `SELECT uid, name, phone
         FROM users
        WHERE id = $1::int AND tenant_id = $2::uuid AND role = 'PATIENT'
          AND is_active=TRUE AND status='active'
          AND is_deleted=FALSE AND merged_into_uid IS NULL
        LIMIT 1`,
      Number(order.patient_id),
      tenantId,
    )
    : [];
  const patient = patientRows[0] || null;
  const prescriptions = await tx.$queryRawUnsafe(
    `SELECT id, prescription_number, doctor_uid, status, medications,
            patient_id, patient_uid,
            COALESCE(revision, 1)::int AS revision
       FROM e_prescriptions
      WHERE tenant_id = $1::uuid AND pharmacy_order_id = $2::int
      ORDER BY id ASC
      FOR UPDATE`,
    tenantId,
    Number(order.id),
  );
  if (prescriptions.length > 1) {
    throw AppError.conflict(
      'Pharmacy order is linked to more than one prescription',
      'PHARMACY_ORDER_PRESCRIPTION_LINK_AMBIGUOUS',
    );
  }
  const prescription = prescriptions[0] || null;
  if (prescription && (
    !patient
    || prescription.patient_id == null
    || Number(prescription.patient_id) !== Number(order.patient_id)
    || String(prescription.patient_uid || '') !== String(patient.uid)
  )) {
    throw AppError.conflict(
      'The linked prescription patient does not match the pharmacy order patient',
      'PHARMACY_ORDER_PRESCRIPTION_PATIENT_MISMATCH',
    );
  }
  const prescriptionStatus = String(prescription?.status || '').toLowerCase();
  if (prescription
    && !DISPENSABLE_PRESCRIPTION_STATUSES.includes(prescriptionStatus)
    && prescriptionStatus !== 'fulfilled') {
    throw AppError.conflict(
      `Linked prescription cannot be dispensed from status ${prescription.status || 'unknown'}`,
      'PHARMACY_ORDER_PRESCRIPTION_STATUS_INVALID',
    );
  }
  if (prescriptionStatus === 'fulfilled') {
    const orderEvidenceAlreadyComplete = lines.every((line) => {
      const ordered = Number(line?.ordered_qty ?? line?.quantity ?? line?.qty);
      const requested = operation === 'delivery' || completeRemainder
        ? ordered
        : Number(line?.dispensed_qty ?? line?.qty ?? line?.quantity);
      const dispensed = Number(line?.inventory_dispensed_quantity || 0);
      return Number.isFinite(ordered)
        && ordered > 0
        && Number.isFinite(requested)
        && requested > 0
        && Number.isFinite(dispensed)
        && dispensed + 0.000001 >= requested;
    });
    if (!orderEvidenceAlreadyComplete) {
      throw AppError.conflict(
        'The linked prescription is fulfilled but order inventory evidence is incomplete',
        'PHARMACY_ORDER_PRESCRIPTION_FULFILMENT_CONFLICT',
      );
    }
  }
  const prescriptionMedications = Array.isArray(prescription?.medications)
    ? prescription.medications.map((medication) => ({ ...medication }))
    : [];
  const prescriptionLineIndexes = prescription
    ? resolvePrescriptionLineIndexes(lines, prescriptionMedications)
    : lines.map(() => null);
  const inventoryItems = await resolveOrderInventoryItemsTx(tx, {
    tenantId,
    facilityId,
    lines,
    preserveIntendedQuantity: operation === 'counter' && !completeRemainder,
    skipZeroIntended: operation === 'counter' && !completeRemainder,
  });
  const lineContexts = lines.map((sourceLine, index) => {
    const line = { ...sourceLine };
    const orderedQuantity = positiveQuantity(
      line.ordered_qty ?? line.quantity ?? line.qty,
      `items_list[${index}].quantity`,
    );
    const intendedQuantity = operation === 'delivery' || completeRemainder
      ? orderedQuantity
      : Number(line.dispensed_qty ?? line.qty ?? line.quantity);
    if (!Number.isFinite(intendedQuantity) || intendedQuantity < 0) {
      throw AppError.badRequest(
        `items_list[${index}].dispensed_quantity must be non-negative`,
        'PHARMACY_DISPENSE_QUANTITY_INVALID',
      );
    }
    if (intendedQuantity - orderedQuantity > 0.000001) {
      throw AppError.conflict(
        `Order item ${index + 1} exceeds its authoritative ordered quantity`,
        'PHARMACY_ORDER_DISPENSE_EXCEEDS_ORDERED_QUANTITY',
        { ordered_quantity: orderedQuantity, intended_quantity: intendedQuantity },
      );
    }
    const alreadyDispensed = Math.max(0, Number(line.inventory_dispensed_quantity || 0));
    if (!Number.isFinite(alreadyDispensed) || alreadyDispensed - intendedQuantity > 0.000001) {
      throw AppError.conflict(
        `Order item ${index + 1} has inconsistent inventory fulfilment evidence`,
        'PHARMACY_ORDER_INVENTORY_EVIDENCE_CONFLICT',
      );
    }
    const quantity = intendedQuantity - alreadyDispensed;
    const inventoryItem = inventoryItems[index];
    const unitPrice = Number(inventoryItem.unit_price);
    if (quantity > 0.000001 && (!Number.isFinite(unitPrice) || unitPrice <= 0)) {
      throw AppError.conflict(
        `Order item ${index + 1} has no positive authoritative catalog price`,
        'PHARMACY_ORDER_CATALOG_PRICE_REQUIRED',
        { catalog_id: Number(inventoryItem.catalog_id) },
      );
    }
    const priorBillableTotal = priorInventoryBillableTotal(line, alreadyDispensed);
    const currentBillableTotal = quantity > 0.000001
      ? Number((unitPrice * quantity).toFixed(2))
      : 0;
    const cumulativeBillableTotal = Number(
      (priorBillableTotal + currentBillableTotal).toFixed(2),
    );
    const controlled = controlledInventoryItem(inventoryItem);
    const needsWitness = inventoryItem.schedule_class === 'X'
      || inventoryItem.is_narcotic === true;
    const allocations = quantity > 0.000001
      ? exactRequestedAllocations(line, quantity)
      : [];
    if (controlled && quantity > 0.000001 && !allocations) {
      throw AppError.conflict(
        `Controlled order item ${index + 1} requires exact batch allocation and statutory custody evidence`,
        'PHARMACY_ORDER_CONTROLLED_ALLOCATION_REQUIRED',
        {
          inventory_item_id: Number(inventoryItem.id),
          facility_id: facilityId,
          schedule_class: inventoryItem.schedule_class || null,
          is_narcotic: inventoryItem.is_narcotic === true,
          witness_required: needsWitness,
          required_quantity: quantity,
          recovery_action: {
            // The 'delivery' operation is raised by dispatchOrder, which is the
            // only delivery-lane endpoint that consumes the dispensed_items
            // request_shape below. markDelivered ('/delivered') rejects
            // dispensed_items outright with
            // PHARMACY_DELIVERY_CALLER_AUTHORITY_FORBIDDEN, so pointing the
            // recovery deep link there instructed the caller to send a payload
            // that endpoint can never accept.
            retry_endpoint: `/api/v1/pharmacy-orders/orders/${Number(order.id)}/${operation === 'delivery' ? 'dispatch' : 'dispense'}`,
            batch_lookup_endpoint: `/api/v1/pharmacy/inventory/v2/batches?item_id=${Number(inventoryItem.id)}&facility_id=${facilityId}&status=in_stock`,
            witness_required: needsWitness,
            witness_request_endpoint: '/api/v1/pharmacy/inventory/v2/controlled-dispense/witness-approvals',
            witness_approve_endpoint_template: '/api/v1/pharmacy/inventory/v2/controlled-dispense/witness-approvals/{approval_id}/approve',
            witness_payload_template: {
              inventory_item_id: Number(inventoryItem.id),
              inventory_batch_id: 'selected_inventory_batch_id',
              quantity,
              patient_uid: patient?.uid || null,
              patient_name: patient?.name || order.patient_name || null,
              patient_phone: patient?.phone || order.patient_phone || null,
              prescription_id: prescription?.id || null,
              prescription_number: prescription?.prescription_number || null,
              prescriber_uid: prescription?.doctor_uid || null,
            },
            request_shape: {
              dispensed_items: [{
                order_line_index: index,
                catalog_id: Number(inventoryItem.catalog_id),
                inventory_item_id: Number(inventoryItem.id),
                ...(operation === 'counter' && !completeRemainder ? {
                  dispensed_quantity: intendedQuantity,
                } : {}),
                inventory_allocations: [{
                  inventory_batch_id: 'required',
                  quantity,
                  witness_approval_id: needsWitness ? 'required' : null,
                }],
              }],
            },
          },
        },
      );
    }
    return {
      index,
      prescriptionLineIndex: prescriptionLineIndexes[index],
      line,
      orderedQuantity,
      intendedQuantity,
      alreadyDispensed,
      quantity,
      inventoryItem,
      unitPrice,
      cumulativeBillableTotal,
      controlled,
      allocations,
    };
  });
  const exactBatchIds = [...new Set(lineContexts
    .flatMap(({ allocations }) => (allocations || [])
      .map(({ inventory_batch_id: batchId }) => batchId)))]
    .sort((left, right) => left - right);
  const fefoItemIds = [...new Set(lineContexts
    .filter(({ quantity, allocations }) => quantity > 0.000001 && !allocations)
    .map(({ inventoryItem }) => Number(inventoryItem.id)))]
    .sort((left, right) => left - right);
  const lockedBatches = exactBatchIds.length || fefoItemIds.length
    ? await tx.$queryRawUnsafe(
      `SELECT id, inventory_item_id, batch_number, lot_number, expiry_date,
              remaining_quantity, status, facility_id
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid
          AND facility_id = $2::int
          AND (
            id = ANY($3::int[])
            OR (
              inventory_item_id = ANY($4::int[])
              AND status = 'in_stock'
              AND remaining_quantity > 0
              AND expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
            )
          )
        ORDER BY id
        FOR UPDATE`,
      tenantId,
      facilityId,
      exactBatchIds,
      fefoItemIds,
    )
    : [];
  const lockedBatchById = new Map(lockedBatches.map((batch) => [Number(batch.id), batch]));
  const availableByBatch = new Map(lockedBatches.map((batch) => [
    Number(batch.id),
    Number(batch.remaining_quantity),
  ]));
  for (const context of [...lineContexts].sort((left, right) => (
    Number(left.inventoryItem.id) - Number(right.inventoryItem.id) || left.index - right.index
  ))) {
    if (context.quantity <= 0.000001) continue;
    if (context.allocations) {
      for (const allocation of context.allocations) {
        const batchId = Number(allocation.inventory_batch_id);
        const batch = lockedBatchById.get(batchId);
        if (!batch || Number(batch.inventory_item_id) !== Number(context.inventoryItem.id)) {
          throw AppError.conflict(
            'Requested batch does not belong to the authoritative Inventory V2 item',
            'PHARMACY_ORDER_BATCH_ALLOCATION_INVALID',
            { inventory_batch_id: batchId, inventory_item_id: Number(context.inventoryItem.id) },
          );
        }
        const available = Number(availableByBatch.get(batchId) || 0);
        if (allocation.quantity - available > 0.000001) {
          throw AppError.badRequest(
            `Insufficient usable Inventory V2 stock; short by ${allocation.quantity - available}`,
            'INVENTORY_INSUFFICIENT_STOCK',
            {
              inventory_item_id: Number(context.inventoryItem.id),
              inventory_batch_id: batchId,
              short_by: allocation.quantity - available,
            },
          );
        }
        availableByBatch.set(batchId, available - allocation.quantity);
      }
    } else {
      context.allocations = fefoAllocationsFromLockedBatches(
        lockedBatches,
        availableByBatch,
        {
          inventoryItemId: Number(context.inventoryItem.id),
          quantity: context.quantity,
        },
      );
    }
  }
  const projectedLines = [];
  const movementEvidence = [];

  for (const context of lineContexts) {
    const {
      index,
      line,
      orderedQuantity,
      intendedQuantity,
      alreadyDispensed,
      quantity,
      inventoryItem,
      unitPrice,
      cumulativeBillableTotal,
      controlled,
    } = context;
    line.order_line_index = index;
    if (context.prescriptionLineIndex != null) {
      line.prescription_line_index = context.prescriptionLineIndex;
    }
    if (quantity <= 0.000001) {
      line.ordered_qty = orderedQuantity;
      line.dispensed_qty = alreadyDispensed;
      line.remaining_qty = Math.max(0, orderedQuantity - alreadyDispensed);
      line.inventory_dispensed_quantity = alreadyDispensed;
      line.inventory_remaining_quantity = Math.max(0, orderedQuantity - alreadyDispensed);
      if (alreadyDispensed > 0.000001) {
        line.inventory_billable_total = cumulativeBillableTotal;
        line.line_total = cumulativeBillableTotal;
      }
      projectedLines.push(line);
      continue;
    }

    const allocations = context.allocations;

    const lineEvidence = [];
    for (let allocationIndex = 0; allocationIndex < allocations.length; allocationIndex += 1) {
      const allocation = allocations[allocationIndex];
      const referenceId = `${order.id}:${index}:${commandKeySha256}:${allocationIndex}`;
      const metadata = {
        contract: 'pharmacy_order_inventory_allocation_v1',
        operation,
        order_id: Number(order.id),
        order_line_index: index,
        command_key_sha256: commandKeySha256,
        catalog_id: Number(inventoryItem.catalog_id),
        requested_quantity: quantity,
        allocation_quantity: allocation.quantity,
        unit_price: unitPrice,
        billable_subtotal: Number((unitPrice * allocation.quantity).toFixed(2)),
      };
      const result = controlled
        ? await dispenseControlledTx(tx, {
          tenantId,
          inventory_item_id: Number(inventoryItem.id),
          inventory_batch_id: allocation.inventory_batch_id,
          quantity: allocation.quantity,
          patient_uid: patient?.uid || null,
          patient_name: patient?.name || order.patient_name || null,
          patient_phone: patient?.phone || order.patient_phone || null,
          prescription_id: prescription?.id || null,
          prescription_line_index: context.prescriptionLineIndex,
          prescription_number: prescription?.prescription_number || null,
          prescriber_uid: prescription?.doctor_uid || null,
          performed_by: actorUid,
          performed_by_name: resolvedActorName,
          witness_approval_id: allocation.witness_approval_id,
          notes: `Pharmacy order ${order.order_number || order.id}`,
          reference_id: referenceId,
          movement_metadata: metadata,
          consume_prescription_line_authority: false,
        })
        : await recordMovementTx(tx, {
          tenantId,
          inventory_item_id: Number(inventoryItem.id),
          inventory_batch_id: allocation.inventory_batch_id,
          movement_kind: 'issue',
          quantity: allocation.quantity,
          reference_type: 'pharmacy_order_dispense',
          reference_id: referenceId,
          performed_by: actorUid,
          notes: `Pharmacy order ${order.order_number || order.id}`,
          metadata,
          require_usable_batch: true,
          expected_facility_id: facilityId,
        });
      const batch = lockedBatchById.get(Number(allocation.inventory_batch_id)) || allocation;
      const entry = {
        inventory_item_id: Number(inventoryItem.id),
        inventory_batch_id: Number(allocation.inventory_batch_id),
        batch_number: batch.batch_number || null,
        lot_number: batch.lot_number || null,
        expiry_date: batch.expiry_date || null,
        quantity: allocation.quantity,
        unit_price: unitPrice,
        line_total: Number((unitPrice * allocation.quantity).toFixed(2)),
        movement_id: Number(result.movement.id),
        register_entry_id: result.register_entry?.id != null
          ? Number(result.register_entry.id)
          : null,
      };
      lineEvidence.push(entry);
      movementEvidence.push(entry);
    }
    line.catalog_id = Number(inventoryItem.catalog_id);
    line.inventory_item_id = Number(inventoryItem.id);
    line.inventory_dispensed_quantity = intendedQuantity;
    line.ordered_qty = orderedQuantity;
    line.dispensed_qty = intendedQuantity;
    line.remaining_qty = Math.max(0, orderedQuantity - intendedQuantity);
    line.inventory_remaining_quantity = Math.max(0, orderedQuantity - intendedQuantity);
    line.price = unitPrice;
    line.inventory_billable_total = cumulativeBillableTotal;
    line.line_total = cumulativeBillableTotal;
    line.inventory_allocation_evidence = [
      ...(Array.isArray(line.inventory_allocation_evidence)
        ? line.inventory_allocation_evidence
        : []),
      ...lineEvidence,
    ];
    delete line.inventory_allocations;
    projectedLines.push(line);

    if (prescription) {
      const medicationIndex = context.prescriptionLineIndex;
      const medication = prescriptionMedications[medicationIndex];
      const prescribedQuantity = positiveQuantity(
        medication.ordered_quantity ?? medication.quantity ?? medication.qty,
        `prescription.medications[${medicationIndex}].quantity`,
      );
      const fulfilmentGeneration = Number(
        line.prescription_fulfilment_generation
        ?? medication.fulfilment_generation
        ?? 1,
      );
      const medicationGeneration = Number(medication.fulfilment_generation || 1);
      if (fulfilmentGeneration !== medicationGeneration) {
        throw AppError.conflict(
          'The prescription fulfilment generation changed before inventory allocation',
          'PHARMACY_ORDER_PRESCRIPTION_GENERATION_CHANGED',
        );
      }
      const baselineDispensed = Math.max(
        0,
        Number(line.prescription_dispensed_baseline || 0),
      );
      const expectedCurrentDispensed = baselineDispensed + alreadyDispensed;
      if (Math.abs(Number(medication.dispensed_quantity || 0) - expectedCurrentDispensed) > 0.000001) {
        throw AppError.conflict(
          'The prescription fulfilment baseline does not match durable order inventory evidence',
          'PHARMACY_ORDER_PRESCRIPTION_FULFILMENT_CONFLICT',
        );
      }
      const cumulativeDispensed = baselineDispensed + intendedQuantity;
      if (cumulativeDispensed - prescribedQuantity > 0.000001) {
        throw AppError.conflict(
          'Order inventory evidence exceeds the linked prescription quantity',
          'PHARMACY_ORDER_PRESCRIPTION_FULFILMENT_CONFLICT',
        );
      }
      const remaining = Math.max(0, prescribedQuantity - cumulativeDispensed);
      prescriptionMedications[medicationIndex] = {
        ...medication,
        fulfilment_generation: fulfilmentGeneration,
        ordered_quantity: prescribedQuantity,
        dispensed_quantity: cumulativeDispensed,
        remaining_quantity: remaining,
        fulfilment_status: remaining <= 0.000001 ? 'fulfilled' : 'partial',
      };
    }
  }

  const prescriptionProjection = prescription
    ? {
      id: Number(prescription.id),
      medications: prescriptionMedications,
      status: prescriptionStatus === 'fulfilled'
        || prescriptionMedications.every((medication) =>
          Number(medication?.remaining_quantity) <= 0.000001)
        ? 'fulfilled'
        : 'pharmacy_linked',
      expected_status: prescriptionStatus,
      expected_revision: Number(prescription.revision || 1),
    }
    : null;
  return {
    lines: projectedLines,
    allocations: movementEvidence,
    prescription: prescriptionProjection,
  };
}

export async function applyOrderPrescriptionProjectionTx(tx, {
  tenantId,
  prescription,
}) {
  if (!prescription) return null;
  const updated = await tx.$queryRawUnsafe(
    `UPDATE e_prescriptions
        SET medications = $3::jsonb,
            status = $4,
            pharmacy_opted = TRUE,
            revision = COALESCE(revision, 1) + 1,
            updated_at = NOW()
      WHERE id = $1::int
        AND tenant_id = $2::uuid
        AND LOWER(COALESCE(status, '')) = $5
        AND COALESCE(revision, 1) = $6::int
      RETURNING id, status, revision`,
    prescription.id,
    tenantId,
    JSON.stringify(prescription.medications),
    prescription.status,
    prescription.expected_status,
    prescription.expected_revision,
  );
  if (!updated.length) {
    throw AppError.conflict(
      'Linked prescription changed before dispense projection could be committed',
      'PHARMACY_ORDER_PRESCRIPTION_STATE_CHANGED',
    );
  }
  return updated[0];
}

function replayProjection(existingCommand, requestFingerprint) {
  const metadata = existingCommand.metadata || {};
  if (metadata.request_fingerprint !== requestFingerprint) {
    throw AppError.unprocessable(
      'Idempotency-Key was reused with a different substitution command',
      'SUBSTITUTION_COMMAND_MISMATCH',
    );
  }
  const payload = metadata.response_payload || {
    movement_id: Number(existingCommand.id),
    order_id: Number(metadata.order_id),
    prescription_id: Number(metadata.prescription_id),
    order_line_index: Number(metadata.order_line_index),
    prescription_line_index: Number(metadata.prescription_line_index),
    original_catalog_id: Number(metadata.original_catalog_id),
    final_catalog_id: Number(metadata.final_catalog_id),
    quantity: Number(metadata.quantity),
    remaining_quantity: Number(metadata.remaining_quantity),
    fulfilment_status: metadata.fulfilment_status,
    billable_subtotal: Number(metadata.billable_subtotal || 0),
    batch_evidence: metadata.batch_evidence || null,
    ...(existingCommand.register_entry_id != null
      ? { register_entry_id: Number(existingCommand.register_entry_id) }
      : {}),
  };
  Object.defineProperty(payload, '_replayed', { value: true, enumerable: false });
  return payload;
}

function substitutionRequestFingerprint(body) {
  return createHash('sha256')
    .update(JSON.stringify(substitutionWitnessPayload(body)))
    .digest('hex');
}

async function loadSubstitutionCommandEvidence(db, { tenantId, commandKeySha256 }) {
  return db.$queryRawUnsafe(
    `SELECT movement.id, movement.metadata, register_entry.id AS register_entry_id
       FROM pharmacy_stock_movements movement
       LEFT JOIN pharmacy_schedule_register register_entry
         ON register_entry.reference_movement_id = movement.id
        AND register_entry.tenant_id = movement.tenant_id
      WHERE movement.tenant_id = $1::uuid
        AND movement.metadata->>'contract' = 'pharmacy_dispense_substitution_v1'
        AND movement.metadata->>'command_key_sha256' = $2
      ORDER BY movement.id
      LIMIT 2`,
    tenantId,
    commandKeySha256,
  );
}

async function controlledRegisterContextTx(tx, { tenantId, patientUid, actorUid }) {
  const patients = await tx.$queryRawUnsafe(
    `SELECT uid, name, phone
       FROM users
      WHERE uid = $1::uuid AND tenant_id = $2::uuid
        AND COALESCE(is_deleted, false) = false
      LIMIT 1`,
    String(patientUid),
    tenantId,
  );
  if (!patients.length) {
    throw AppError.notFound(
      'Patient not found for the statutory register',
      'SUBSTITUTION_PATIENT_NOT_FOUND',
    );
  }
  const performedByName = await resolveAuthenticatedPerformerNameTx(tx, {
    tenantId,
    actorUid,
    codePrefix: 'SUBSTITUTION',
  });
  return { patient: patients[0], performedByName };
}

export async function dispenseSubstitutionCommand({
  tenantId,
  body,
  context = null,
  contextResolver = null,
  actorUid,
  actorRole,
  commandKeySha256,
  requestId,
}) {
  let effectiveContext = context;
  if (!actorUid) {
    throw AppError.forbidden(
      'An authenticated stock performer is required',
      'PHARMACY_DISPENSE_ACTOR_REQUIRED',
    );
  }
  const witnessPayload = substitutionWitnessPayload(body);
  const requestFingerprint = substitutionRequestFingerprint(body);
  const witnessApprovalId = body?.witness_approval_id;

  const { recordCanonicalClinicalEvent } = await import(
    '../clinical/canonicalClinicalPlatformService.js'
  );
  const result = await setTenantTx(tenantId, async (tx) => {
    await lockTenantPatientMergeStability(tx, tenantId);
    const fundingPatientUid = await resolvePharmacyFundingPatientUidTx(tx, {
      tenantId,
      orderId: body?.order_id,
      patientUid: body?.patient_uid,
    });
    await lockPharmacyFundingAuthorityTx(tx, {
      tenantId,
      patientUid: fundingPatientUid,
    });
    await assertPharmacyFacilityGrant(tx, {
      tenantId,
      facilityId: body?.facility_id,
      actorUid,
      actorRole,
      forUpdate: true,
    });
    await resolveAuthenticatedPerformerNameTx(tx, {
      tenantId,
      actorUid,
      codePrefix: 'SUBSTITUTION',
    });
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))::text AS lock_acquired`,
      `dispense-substitution:${tenantId}:${commandKeySha256}`,
    );
    const existingCommands = await loadSubstitutionCommandEvidence(tx, {
      tenantId,
      commandKeySha256,
    });
    if (existingCommands.length) {
      if (existingCommands.length !== 1) {
        throw AppError.conflict(
          'Substitution command has conflicting durable movement evidence',
          'SUBSTITUTION_COMMAND_EVIDENCE_CONFLICT',
        );
      }
      return replayProjection(existingCommands[0], requestFingerprint);
    }

    if (!effectiveContext) {
      if (typeof contextResolver !== 'function') {
        throw AppError.internal(
          'Substitution authority context resolver is required',
          'SUBSTITUTION_CONTEXT_RESOLVER_REQUIRED',
        );
      }
      effectiveContext = await contextResolver(tx);
    }
    const {
      patient_uid: patientUid,
      encounter_id: encounterId,
      reason,
      orderId,
      prescriptionId,
      orderLineIndex,
      prescriptionLineIndex,
      facilityId,
      qty,
      origId,
      finalId,
      itemId,
      batchId,
    } = effectiveContext;

    await assertVerificationClearedTx(tx, { orderId, tenantId });

    const origins = await tx.$queryRawUnsafe(
      `SELECT po.id AS order_id, po.uid, po.status AS order_status, po.items_list,
              po.patient_id,
              po.patient_name, po.dispense_label, po.total_amount, po.order_number, po.delivery_type,
              po.payment_mode, po.payment_status, po.amount_collected, po.payment_metadata,
              po.facility_id, po.inventory_authority_version,
              ep.id AS prescription_id, ep.status AS prescription_status,
              ep.medications, ep.prescription_number, ep.doctor_uid,
              ep.appointment_id, ep.admission_id,
              COALESCE(ep.revision, 1)::int AS prescription_revision
         FROM pharmacy_orders po
         JOIN e_prescriptions ep
           ON ep.pharmacy_order_id = po.id
          AND ep.tenant_id = po.tenant_id
          AND ep.patient_id = po.patient_id
         JOIN users patient
           ON patient.tenant_id=po.tenant_id
          AND patient.id=po.patient_id
          AND patient.uid=ep.patient_uid
          AND patient.role='PATIENT'
          AND patient.is_active=TRUE
          AND patient.status='active'
          AND patient.is_deleted=FALSE
          AND patient.merged_into_uid IS NULL
        WHERE po.id = $1::int
          AND ep.id = $2::int
          AND po.tenant_id = $3::uuid
          AND ep.patient_uid = $4::uuid
        FOR UPDATE OF po, ep, patient`,
      orderId,
      prescriptionId,
      tenantId,
      String(patientUid),
    );
    if (!origins.length) {
      throw AppError.notFound(
        'The originating pharmacy order and prescription linkage no longer exists',
        'SUBSTITUTION_ORIGIN_LINK_NOT_FOUND',
      );
    }
    const origin = origins[0];
    if (!Number(origin.facility_id) || Number(origin.facility_id) !== facilityId) {
      throw AppError.conflict(
        'The pharmacy order facility authority changed before substitution',
        'SUBSTITUTION_AUTHORITY_CHANGED',
      );
    }
    if (!DISPENSABLE_ORDER_STATUSES.includes(origin.order_status)) {
      throw AppError.conflict(
        `Order ${orderId} cannot accept a substitution from status ${origin.order_status}`,
        'SUBSTITUTION_ORDER_STATUS_INVALID',
      );
    }
    if (!DISPENSABLE_PRESCRIPTION_STATUSES.includes(String(origin.prescription_status || '').toLowerCase())) {
      throw AppError.conflict(
        `Prescription ${prescriptionId} cannot be dispensed from status ${origin.prescription_status || 'unknown'}`,
        'SUBSTITUTION_PRESCRIPTION_STATUS_INVALID',
      );
    }
    const encounterRows = (origin.appointment_id != null || origin.admission_id != null)
      ? await tx.$queryRawUnsafe(
        `SELECT id
           FROM patient_encounters
          WHERE tenant_id=$1::uuid
            AND patient_uid=$2::uuid
            AND (($3::int IS NOT NULL AND appointment_id=$3::int)
              OR ($4::int IS NOT NULL AND admission_id=$4::int))
          ORDER BY id
          LIMIT 2
          FOR KEY SHARE`,
        tenantId,
        String(patientUid),
        origin.appointment_id == null ? null : Number(origin.appointment_id),
        origin.admission_id == null ? null : Number(origin.admission_id),
      )
      : [];
    if (encounterRows.length > 1
      || String(encounterRows[0]?.id || '') !== String(encounterId || '')) {
      throw AppError.conflict(
        'The prescription encounter authority changed before substitution',
        'SUBSTITUTION_ENCOUNTER_AUTHORITY_CHANGED',
      );
    }
    const identityRows = await tx.$queryRawUnsafe(
      `SELECT pc.id AS catalog_id, pc.composition_id,
              pc.strength_key, pc.strength_components, pc.form_key, pc.release_key,
              pc.route, pc.composition_confidence, pc.unit_price, pc.name
         FROM pharmacy_catalog pc
        WHERE pc.tenant_id = $1::uuid
          AND pc.is_active = TRUE
          AND pc.id = ANY($2::int[])
        ORDER BY pc.id
        FOR UPDATE OF pc`,
      tenantId,
      [origId, finalId],
    );
    const inventoryItems = await tx.$queryRawUnsafe(
      `SELECT id, catalog_id, facility_id, schedule_class, is_narcotic, status
         FROM pharmacy_inventory_items
        WHERE id = $1::int AND tenant_id = $2::uuid AND facility_id = $3::int
        ORDER BY id
        FOR UPDATE`,
      itemId,
      tenantId,
      facilityId,
    );
    if (!inventoryItems.length || inventoryItems[0].status !== 'active') {
      throw AppError.conflict(
        'The substitution inventory item is no longer active',
        'SUBSTITUTION_AUTHORITY_CHANGED',
      );
    }
    const authoritativeItem = inventoryItems[0];
    if (Number(authoritativeItem.catalog_id) !== finalId) {
      throw AppError.conflict(
        'The substitution inventory/catalog linkage changed before dispense',
        'SUBSTITUTION_AUTHORITY_CHANGED',
      );
    }
    const compositionIds = [...new Set(identityRows
      .map((identity) => numericId(identity.composition_id))
      .filter(Boolean))];
    const compositionRows = compositionIds.length
      ? await tx.$queryRawUnsafe(
        `SELECT id, active_ingredients
         FROM drug_compositions
          WHERE id = ANY($1::int[])
          ORDER BY id
          FOR UPDATE`,
        compositionIds,
      )
      : [];
    const compositionById = new Map(compositionRows.map((composition) => [
      Number(composition.id),
      composition.active_ingredients,
    ]));
    const identityById = new Map(identityRows.map((identity) => [Number(identity.catalog_id), {
      ...identity,
      catalog_id: Number(identity.catalog_id),
      composition_id: identity.composition_id == null ? null : Number(identity.composition_id),
      active_ingredients: identity.composition_id == null
        ? null
        : compositionById.get(Number(identity.composition_id)) ?? null,
    }]));
    const authoritativeOrig = identityById.get(origId);
    const authoritativeSub = identityById.get(finalId);
    if (!authoritativeOrig || !authoritativeSub
      || !authoritativeSubstitutionAllowed(authoritativeOrig, authoritativeSub)) {
      throw AppError.conflict(
        'The authoritative catalog identities no longer permit this substitution',
        'SUBSTITUTION_AUTHORITY_CHANGED',
      );
    }
    const itemDrifted = Number(effectiveContext.item?.catalog_id)
        !== Number(authoritativeItem.catalog_id)
      || effectiveContext.item?.schedule_class !== authoritativeItem.schedule_class
      || Boolean(effectiveContext.item?.is_narcotic) !== Boolean(authoritativeItem.is_narcotic);
    if (
      itemDrifted
      || identityFingerprint(effectiveContext.orig) !== identityFingerprint(authoritativeOrig)
      || identityFingerprint(effectiveContext.sub) !== identityFingerprint(authoritativeSub)
    ) {
      throw AppError.conflict(
        'Substitution authority changed after preflight; refresh and retry with a new command',
        'SUBSTITUTION_AUTHORITY_CHANGED',
      );
    }
    const controlled = controlledInventoryItem(authoritativeItem);
    const needsWitness = authoritativeItem.schedule_class === 'X'
      || authoritativeItem.is_narcotic === true;
    if (needsWitness && witnessApprovalId == null) {
      throw AppError.badRequest(
        'Schedule X / narcotic substitution requires an independently approved witness (witness_approval_id)',
        'SUBSTITUTION_WITNESS_REQUIRED',
      );
    }
    const prescriptionMedications = Array.isArray(origin.medications)
      ? origin.medications.map((medication) => ({ ...medication }))
      : [];
    const prescriptionLine = prescriptionMedications[prescriptionLineIndex];
    if (!prescriptionLine || Number(prescriptionLine.catalog_id) !== origId) {
      throw AppError.conflict(
        'The linked prescription line changed before substitution could be committed',
        'SUBSTITUTION_PRESCRIPTION_LINE_CHANGED',
      );
    }
    const prescribedQuantity = positiveQuantity(
      prescriptionLine.quantity ?? prescriptionLine.qty,
      'prescription quantity',
    );
    const previouslyDispensed = Math.max(0, Number(prescriptionLine.dispensed_quantity || 0));
    const currentRemaining = Number.isFinite(Number(prescriptionLine.remaining_quantity))
      ? Number(prescriptionLine.remaining_quantity)
      : prescribedQuantity - previouslyDispensed;
    if (!Number.isFinite(currentRemaining) || currentRemaining < 0) {
      throw AppError.conflict(
        'Prescription fulfilment evidence is inconsistent',
        'SUBSTITUTION_PRESCRIPTION_FULFILMENT_CONFLICT',
      );
    }
    if (qty - currentRemaining > 0.000001) {
      throw AppError.conflict(
        `Substitution quantity exceeds the current prescription remainder (${currentRemaining})`,
        'SUBSTITUTION_QUANTITY_EXCEEDS_REMAINDER',
        { remaining_quantity: currentRemaining },
      );
    }

    const orderItems = Array.isArray(origin.items_list)
      ? origin.items_list.map((line) => ({ ...line }))
      : [];
    const orderLine = orderItems[orderLineIndex];
    if (!orderLine
      || Number(orderLine.order_line_index) !== orderLineIndex
      || Number(orderLine.prescription_line_index) !== prescriptionLineIndex
      || ![Number(orderLine.catalog_id), ...(Array.isArray(orderLine.substitution_history)
        ? orderLine.substitution_history.map((entry) => Number(entry?.original_catalog_id))
        : [])].includes(origId)) {
      throw AppError.conflict(
        'The exact originating pharmacy order line changed before substitution',
        'SUBSTITUTION_ORDER_LINE_MISMATCH',
      );
    }

    const finalUnitPrice = Number(authoritativeSub.unit_price || 0);
    if (!Number.isFinite(finalUnitPrice) || finalUnitPrice <= 0) {
      throw AppError.conflict(
        'The substitute has no positive authoritative catalog price',
        'SUBSTITUTION_CATALOG_PRICE_REQUIRED',
        { final_catalog_id: finalId },
      );
    }
    const billableSubtotal = Number((finalUnitPrice * qty).toFixed(2));
    const priorInventoryQuantity = Math.max(0, Number(orderLine.inventory_dispensed_quantity || 0));
    const priorBillableTotal = priorInventoryBillableTotal(orderLine, priorInventoryQuantity);
    const cumulativeBillableTotal = Number((priorBillableTotal + billableSubtotal).toFixed(2));
    const adjustedTotal = Number(orderItems.reduce((sum, line, index) => {
      if (index === orderLineIndex) return sum + cumulativeBillableTotal;
      const issued = Math.max(0, Number(line?.inventory_dispensed_quantity || 0));
      return sum + priorInventoryBillableTotal(line, issued);
    }, 0).toFixed(2));
    requireSubstitutionFundingReauthorisation({
      orderId,
      currentOrderVersion: origin.inventory_authority_version,
      proposedAmount: adjustedTotal,
    });
    const funding = await resolveAuthoritativeCounterFundingTx(tx, {
      tenantId,
      patientId: origin.patient_id,
      orderId,
      paymentMode: String(body.payment_mode || origin.payment_mode || '').toLowerCase(),
      totalAmount: adjustedTotal,
      orderVersion: Number(origin.inventory_authority_version),
      orderItemsSha256: clinicalOrderItemsSha256(origin.items_list),
    });
    const capProbe = await assertPharmacyCapForDispenseTx(tx, {
      tenantId,
      patientId: origin.patient_id,
      additionalAmount: billableSubtotal,
      orderId,
      facilityId,
      actorUid,
      actorRole,
      commandKeySha256,
      fundingSource: funding.fundingSource,
      fundingReference: funding.fundingReference,
      fundingTpaClaimId: funding.fundingTpaClaimId,
      authorisedFundingAmount: funding.fundedAmount,
    });
    if (capProbe.message) {
      logger.warn('Pharmacy cap probe', { order_id: orderId, ...capProbe });
    }
    const remainingAfter = Math.max(0, currentRemaining - qty);
    const fulfilmentStatus = remainingAfter <= 0.000001 ? 'fulfilled' : 'partial';
    const batchRows = await tx.$queryRawUnsafe(
      `SELECT batch_number, lot_number, expiry_date
         FROM pharmacy_inventory_batches
        WHERE id = $1::int AND tenant_id = $2::uuid AND inventory_item_id = $3::int
          AND facility_id = $4::int
        FOR UPDATE`,
      batchId,
      tenantId,
      itemId,
      facilityId,
    );
    if (!batchRows.length) throw AppError.notFound('Inventory batch not found');
    const batchEvidence = {
      inventory_item_id: itemId,
      inventory_batch_id: batchId,
      batch_number: batchRows[0].batch_number || null,
      lot_number: batchRows[0].lot_number || null,
      expiry_date: batchRows[0].expiry_date || null,
    };
    const movementMetadata = {
      contract: 'pharmacy_dispense_substitution_v1',
      command_key_sha256: commandKeySha256,
      request_fingerprint: requestFingerprint,
      order_id: orderId,
      prescription_id: prescriptionId,
      order_line_index: orderLineIndex,
      prescription_line_index: prescriptionLineIndex,
      facility_id: facilityId,
      original_catalog_id: origId,
      final_catalog_id: finalId,
      quantity: qty,
      remaining_quantity: remainingAfter,
      fulfilment_status: fulfilmentStatus,
      billable_subtotal: billableSubtotal,
      batch_evidence: batchEvidence,
    };
    let movement;
    let registerEntry = null;
    let registerContext = null;
    if (controlled) {
      registerContext = await controlledRegisterContextTx(tx, {
        tenantId,
        patientUid,
        actorUid,
      });
      let witnessEvidence = null;
      if (needsWitness) {
        const witnessService = await import('./controlledDispenseWitnessService.js');
        witnessEvidence = await witnessService.consumeControlledDispenseWitnessApproval({
          tx,
          tenantId,
          approvalId: witnessApprovalId,
          scope: witnessService.CONTROLLED_DISPENSE_APPROVAL_SCOPES.dispenseSubstitution,
          payload: witnessPayload,
          requestedBy: actorUid,
        });
      }
      const controlledResult = await dispenseControlledTx(tx, {
        tenantId,
        inventory_item_id: itemId,
        inventory_batch_id: batchId,
        quantity: qty,
        patient_uid: patientUid,
        patient_name: registerContext.patient.name || null,
        patient_phone: registerContext.patient.phone || null,
        prescription_id: prescriptionId,
        prescription_line_index: prescriptionLineIndex,
        prescription_number: origin.prescription_number || null,
        prescriber_uid: origin.doctor_uid || null,
        performed_by: actorUid,
        performed_by_name: registerContext.performedByName,
        witness_evidence: witnessEvidence,
        consume_prescription_line_authority: false,
        validated_substitution_authority: CONTROLLED_SUBSTITUTION_AUTHORITY,
        notes: `Substitute for catalog ${origId}${reason ? `: ${reason}` : ''}`,
        reference_id: `dispense-substitution:${commandKeySha256}`,
        movement_metadata: movementMetadata,
      });
      movement = controlledResult.movement;
      registerEntry = controlledResult.register_entry;
    } else {
      const movementResult = await recordMovementTx(tx, {
        tenantId,
        inventory_item_id: itemId,
        inventory_batch_id: batchId,
        movement_kind: 'issue',
        quantity: qty,
        reference_type: 'dispense_substitution',
        reference_id: `dispense-substitution:${commandKeySha256}`,
        performed_by: actorUid,
        notes: `Substitute for catalog ${origId}${reason ? `: ${reason}` : ''}`,
        metadata: movementMetadata,
        require_usable_batch: true,
        expected_facility_id: facilityId,
      });
      movement = movementResult.movement;
    }

    const substitutionEvidence = {
      movement_id: Number(movement.id),
      register_entry_id: registerEntry?.id != null ? Number(registerEntry.id) : null,
      original_catalog_id: origId,
      final_catalog_id: finalId,
      original_name: authoritativeOrig.name,
      final_name: authoritativeSub.name,
      quantity: qty,
      unit_price: finalUnitPrice,
      line_total: billableSubtotal,
      remaining_quantity: remainingAfter,
      reason: reason ?? null,
      ...batchEvidence,
    };
    prescriptionMedications[prescriptionLineIndex] = {
      ...prescriptionLine,
      ordered_quantity: prescribedQuantity,
      dispensed_quantity: previouslyDispensed + qty,
      remaining_quantity: remainingAfter,
      fulfilment_status: fulfilmentStatus,
      substitution_history: [
        ...(Array.isArray(prescriptionLine.substitution_history)
          ? prescriptionLine.substitution_history
          : []),
        substitutionEvidence,
      ],
    };
    const prescriptionFullyDispensed = prescriptionMedications.every((medication) => {
      const ordered = Number(medication?.ordered_quantity ?? medication?.quantity ?? medication?.qty);
      const dispensed = Number(medication?.dispensed_quantity || 0);
      const remaining = Number.isFinite(Number(medication?.remaining_quantity))
        ? Number(medication.remaining_quantity)
        : ordered - dispensed;
      return Number.isFinite(ordered) && ordered > 0 && remaining <= 0.000001;
    });
    const prescriptionUpdates = await tx.$queryRawUnsafe(
      `UPDATE e_prescriptions
          SET medications = $3::jsonb,
              status = $4,
              pharmacy_opted = TRUE,
              revision = COALESCE(revision, 1) + 1,
              updated_at = NOW()
        WHERE id = $1::int
          AND tenant_id = $2::uuid
          AND LOWER(COALESCE(status, '')) = LOWER($5)
          AND COALESCE(revision, 1) = $6::int
        RETURNING id, status, revision`,
      prescriptionId,
      tenantId,
      JSON.stringify(prescriptionMedications),
      prescriptionFullyDispensed ? 'fulfilled' : 'pharmacy_linked',
      origin.prescription_status,
      origin.prescription_revision,
    );
    if (!prescriptionUpdates.length) {
      throw AppError.conflict(
        'The linked prescription changed before substitution could be committed',
        'SUBSTITUTION_PRESCRIPTION_STATE_CHANGED',
      );
    }

    orderItems[orderLineIndex] = {
      ...orderLine,
      catalog_id: finalId,
      inventory_item_id: itemId,
      name: authoritativeSub.name,
      medication_name: authoritativeSub.name,
      ordered_qty: Number(orderLine.ordered_qty ?? orderLine.quantity ?? orderLine.qty ?? prescribedQuantity),
      dispensed_qty: Number(orderLine.dispensed_qty || 0) + qty,
      remaining_qty: remainingAfter,
      inventory_dispensed_quantity: priorInventoryQuantity + qty,
      inventory_remaining_quantity: remainingAfter,
      substitution_billable_total: cumulativeBillableTotal,
      inventory_billable_total: cumulativeBillableTotal,
      price: finalUnitPrice,
      line_total: cumulativeBillableTotal,
      substitution_history: [
        ...(Array.isArray(orderLine.substitution_history) ? orderLine.substitution_history : []),
        substitutionEvidence,
      ],
      inventory_allocation_evidence: [
        ...(Array.isArray(orderLine.inventory_allocation_evidence)
          ? orderLine.inventory_allocation_evidence
          : []),
        substitutionEvidence,
      ],
    };
    const existingLabel = origin.dispense_label
      && typeof origin.dispense_label === 'object'
      && !Array.isArray(origin.dispense_label)
      ? origin.dispense_label
      : {};
    const dispenseLabel = {
      ...existingLabel,
      order_number: origin.order_number,
      substitutions: [
        ...(Array.isArray(existingLabel.substitutions) ? existingLabel.substitutions : []),
        substitutionEvidence,
      ],
    };
    const paymentMetadata = origin.payment_metadata
      && typeof origin.payment_metadata === 'object'
      && !Array.isArray(origin.payment_metadata)
      ? { ...origin.payment_metadata }
      : {};
    delete paymentMetadata.funding_source;
    delete paymentMetadata.funding_reference;
    delete paymentMetadata.funding_tpa_claim_id;
    delete paymentMetadata.approval_reference;
    delete paymentMetadata.authorised_funded_amount;
    if (funding.fundedAmount > 0) {
      paymentMetadata.funding_source = funding.fundingSource;
      paymentMetadata.funding_reference = funding.fundingReference;
      paymentMetadata.funding_tpa_claim_id = funding.fundingTpaClaimId;
      paymentMetadata.approval_reference = funding.approvalReference || null;
      paymentMetadata.authorised_funded_amount = funding.fundedAmount;
    }
    const clinicalCatalogSha256 = await clinicalCatalogAuthoritySha256Tx(tx, {
      tenantId,
      itemsList: orderItems,
    });
    const clinicalItemsSha256 = clinicalOrderItemsSha256(orderItems);
    const nextOrderStatus = origin.delivery_type === 'counter'
      ? (prescriptionFullyDispensed ? 'DISPENSED' : 'PARTIALLY_DISPENSED')
      : (prescriptionFullyDispensed
        && ['PENDING', 'CONFIRMED', 'PREPARING'].includes(origin.order_status)
        ? 'READY'
        : origin.order_status);
    const updatedOrders = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_orders
          SET items_list = $3::jsonb,
              dispensed_medications = $3::jsonb,
              dispense_label = $4::jsonb,
              total_amount = $5,
              partial_dispense = $6,
              status = $7,
              payment_mode = $9,
              payment_status = 'paid',
              amount_collected = $10::numeric,
              payment_metadata = $11::jsonb,
              dispensed_by = $12::uuid,
              dispensed_at = NOW(),
              clinical_verification_catalog_sha256 = $13,
              clinical_verification_items_sha256 = $14,
              inventory_authority_version = inventory_authority_version + 1,
              clinically_verified_order_version = inventory_authority_version + 1,
              updated_at = NOW()
        WHERE id = $1::int AND tenant_id = $2::uuid AND facility_id = $8::int
        RETURNING id, uid, tenant_id, patient_id, patient_name, status, total_amount,
                  partial_dispense, order_number, updated_at, dispensed_at`,
      orderId,
      tenantId,
      JSON.stringify(orderItems),
      JSON.stringify(dispenseLabel),
      adjustedTotal,
      !prescriptionFullyDispensed,
      nextOrderStatus,
      facilityId,
      String(body.payment_mode || origin.payment_mode || '').toLowerCase(),
      Number(body.amount_collected ?? origin.amount_collected ?? 0),
      JSON.stringify(paymentMetadata),
      actorUid,
      clinicalCatalogSha256,
      clinicalItemsSha256,
    );
    if (!updatedOrders.length) {
      throw AppError.conflict(
        'The pharmacy order authority changed before substitution could be committed',
        'SUBSTITUTION_ORDER_STATE_CHANGED',
      );
    }
    await tx.$executeRawUnsafe(
      `UPDATE pharmacy_orders po
          SET clinical_verification_safety_version=safety.version,
              updated_at=NOW()
         FROM pharmacy_patient_safety_versions safety
        WHERE po.tenant_id=$1::uuid
          AND po.id=$2::int
          AND safety.tenant_id=po.tenant_id
          AND safety.patient_id=po.patient_id`,
      tenantId,
      orderId,
    );

    if (nextOrderStatus !== origin.order_status) {
      const actorRows = await tx.$queryRawUnsafe(
        `SELECT id
           FROM users
          WHERE tenant_id=$1::uuid AND uid=$2::uuid
          LIMIT 1`,
        tenantId,
        actorUid,
      );
      if (!actorRows.length) {
        throw AppError.forbidden(
          'The authenticated stock performer is not in the tenant roster',
          'PHARMACY_DISPENSE_ACTOR_REQUIRED',
        );
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO pharmacy_order_history
          (tenant_id, order_id, from_status, to_status, changed_by, changed_by_role, notes)
         VALUES ($1::uuid, $2::int, $3, $4, $5::int, $6, $7)`,
        tenantId,
        orderId,
        origin.order_status,
        nextOrderStatus,
        Number(actorRows[0].id),
        String(actorRole || 'PHARMACY_STAFF').toLowerCase(),
        `Substitution movement ${movement.id}`,
      );
      await emitPharmacyOrderEvent({
        db: tx,
        order: updatedOrders[0],
        actorUid,
        actorRole,
        eventType: origin.delivery_type === 'counter'
          ? 'pharmacy.order_dispensed'
          : 'pharmacy.order_ready',
        eventStatus: nextOrderStatus,
        previousStatus: origin.order_status,
        payload: {
          substitution_movement_id: Number(movement.id),
          original_catalog_id: origId,
          final_catalog_id: finalId,
          quantity: qty,
          prescription_id: prescriptionId,
        },
      });
    }

    await recordCanonicalClinicalEvent({
      tenantId,
      patientUid,
      encounterId,
      eventType: 'pharmacy.dispense_substitution',
      eventStatus: 'dispensed',
      sourceTable: 'pharmacy_stock_movements',
      sourceId: String(movement.id),
      resourceType: 'medication_brand_substitution',
      resourceId: String(movement.id),
      actorUid,
      actorRole,
      summary: `Dispensed ${authoritativeSub.name} as a substitute for ${authoritativeOrig.name}`,
      beforeState: { catalog_id: origId, brand_name: authoritativeOrig.name },
      afterState: { catalog_id: finalId, brand_name: authoritativeSub.name },
      payload: {
        order_id: orderId,
        prescription_id: prescriptionId,
        quantity: qty,
        remaining_quantity: remainingAfter,
        fulfilment_status: fulfilmentStatus,
        billable_subtotal: billableSubtotal,
        inventory_item_id: itemId,
        inventory_batch_id: batchId,
        reason: reason ?? null,
        ...(controlled ? {
          schedule_class: authoritativeItem.schedule_class ?? null,
          is_narcotic: authoritativeItem.is_narcotic === true,
          register_entry_id: registerEntry?.id != null ? Number(registerEntry.id) : null,
        } : {}),
      },
      timelineIdempotencyKey: `dispense_sub:${movement.id}`,
      auditIdempotencyKey: `dispense_sub_audit:${movement.id}`,
    }, { db: tx });

    const packRows = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_orders
          SET pack_barcode=COALESCE(pack_barcode, $3), updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int
        RETURNING pack_barcode`,
      tenantId,
      orderId,
      `VHMP-${orderId}-${commandKeySha256.slice(0, 8).toUpperCase()}`,
    );
    if (!packRows[0]?.pack_barcode) {
      throw AppError.conflict(
        'The substitution pack identity could not be persisted',
        'PHARMACY_PACK_BARCODE_PERSISTENCE_FAILED',
      );
    }
    const responsePayload = {
      movement_id: Number(movement.id),
      order_id: orderId,
      prescription_id: prescriptionId,
      order_line_index: orderLineIndex,
      prescription_line_index: prescriptionLineIndex,
      original_catalog_id: origId,
      final_catalog_id: finalId,
      quantity: qty,
      remaining_quantity: remainingAfter,
      fulfilment_status: fulfilmentStatus,
      billable_subtotal: billableSubtotal,
      batch_evidence: batchEvidence,
      pack_barcode: packRows[0].pack_barcode,
      pack_barcode_pending: false,
      ...(controlled ? {
        schedule_class: authoritativeItem.schedule_class ?? null,
        is_narcotic: authoritativeItem.is_narcotic === true,
        register_entry_id: registerEntry?.id != null ? Number(registerEntry.id) : null,
      } : {}),
    };
    await tx.$executeRawUnsafe(
      `UPDATE pharmacy_stock_movements
          SET metadata=COALESCE(metadata, '{}'::jsonb)
            || jsonb_build_object('response_payload', $3::jsonb)
        WHERE tenant_id=$1::uuid AND id=$2::int`,
      tenantId,
      Number(movement.id),
      JSON.stringify(responsePayload),
    );
    return responsePayload;
  });

  if (!result._replayed) {
    const {
      patient_uid: patientUid,
      encounter_id: encounterId,
      reason,
      origId,
      finalId,
    } = effectiveContext;
    const { recordBrandSubstitutionAudit } = await import('./compositionSubstitutionAudit.js');
    await recordBrandSubstitutionAudit({
      tenantId,
      patientUid,
      encounterId,
      actorUid,
      actorRole,
      surface: 'pharmacy_dispense',
      resourceTable: 'pharmacy_stock_movements',
      resourceId: result.movement_id,
      originalCatalogId: origId,
      finalCatalogId: finalId,
      reason: reason ?? null,
      requestId,
    }).catch((err) => logger.warn(`Brand-substitution audit failed: ${err.message}`));
  }
  return result;
}
