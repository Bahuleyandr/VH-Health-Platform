function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function optionalQuantity(value) {
  return value == null || value === '' ? null : Number(value);
}

function normalizedReconciliationQuantity(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

const POSTGRES_BIGINT_MAX = 9223372036854775807n;

function canonicalSignedBigIntWireString(value, fieldName) {
  if (typeof value !== 'string'
      || !/^[1-9][0-9]{0,18}$/.test(value)
      || BigInt(value) > POSTGRES_BIGINT_MAX) {
    throw new TypeError(`${fieldName} must be a canonical positive signed-64 decimal string`);
  }
  return value;
}

function canonicalMedicationAdministrationId(value) {
  const text = String(value ?? '');
  if (!/^[1-9][0-9]{0,9}$/.test(text) || BigInt(text) > 2147483647n) {
    throw new TypeError('id must be a canonical positive PostgreSQL INTEGER');
  }
  return Number(text);
}

function normalizedReconciliationAllocations(entries) {
  const quantitiesByAllocation = new Map();
  for (const entry of entries || []) {
    const allocationId = canonicalSignedBigIntWireString(
      entry.inventory_allocation_id,
      'inventory_allocation_id',
    );
    const quantity = normalizedReconciliationQuantity(entry.quantity);
    const total = normalizedReconciliationQuantity(
      (quantitiesByAllocation.get(allocationId) || 0) + quantity,
    );
    quantitiesByAllocation.set(allocationId, total);
  }
  return [...quantitiesByAllocation.entries()]
    .sort(([left], [right]) => (BigInt(left) < BigInt(right) ? -1 : 1))
    .map(([inventoryAllocationId, quantity]) => ({
      inventory_allocation_id: inventoryAllocationId,
      quantity: quantity.toFixed(4),
    }));
}

// Project only fields consumed by the clinical command. Unknown client fields
// cannot change the effect and therefore do not become part of its identity.
export function marAdministerIdempotencyBody(req) {
  const body = req.body || {};
  return {
    notes: optionalText(body.notes),
    override_reason: optionalText(body.override_reason),
    supply_override_reason: optionalText(body.supply_override_reason),
    supply_quantity: optionalQuantity(body.supply_quantity),
    witness_uid: optionalText(body.witness_uid),
  };
}

export function marAdministerWithScanIdempotencyBody(req) {
  const body = req.body || {};
  return {
    override_reason: optionalText(body.override_reason),
    scanned_barcode: optionalText(body.scanned_barcode),
    scanned_patient_uid: optionalText(body.scanned_patient_uid),
    supply_override_reason: optionalText(body.supply_override_reason),
    supply_quantity: optionalQuantity(body.supply_quantity),
    witness_uid: optionalText(body.witness_uid),
  };
}

export function marTransitionIdempotencyBody(req) {
  return { reason: optionalText(req.body?.reason) };
}

export function marExceptionDispositionIdempotencyBody(req) {
  const replacementOrderId = req.body?.replacement_clinical_order_id;
  return {
    exception_case_id: String(req.params.caseId),
    disposition: optionalText(req.body?.disposition)?.toLowerCase() || null,
    reason: optionalText(req.body?.reason),
    replacement_clinical_order_id:
      replacementOrderId == null || replacementOrderId === ''
        ? null
        : Number(replacementOrderId),
  };
}

export function marExceptionClaimIdempotencyBody(req) {
  return { exception_case_id: String(req.params.caseId) };
}

export function marExceptionHandoffIdempotencyBody(req) {
  return {
    exception_case_id: String(req.params.caseId),
    expected_prescriber_uid: optionalText(req.body?.expected_prescriber_uid)?.toLowerCase()
      || null,
    target_prescriber_uid: optionalText(req.body?.target_prescriber_uid)?.toLowerCase()
      || null,
    reason: optionalText(req.body?.reason),
  };
}

export function marSupplyReconciliationIdempotencyBody(req) {
  return {
    consumption_id: canonicalSignedBigIntWireString(
      req.params.consumptionId,
      'consumptionId',
    ),
    expected_medication_administration_id: canonicalMedicationAdministrationId(req.params.id),
    allocations: normalizedReconciliationAllocations(req.body?.allocations),
  };
}
