import { createHash } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import {
  completeMarSupplyReconciliationObligationTx,
  materializeMarSupplyReconciliationObligationTx,
} from '../ipd/wardIndentObligationService.js';
import { requireTenantId } from '../tenant/tenantService.js';

const MAX_QUANTITY = 9999999999.9999;

function positiveId(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function positiveBigInt(value, fieldName) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  const text = String(value ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return BigInt(text);
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
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalizeWireValue(child)]),
    );
  }
  return value;
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
            item.item_name, item.substitution_status,
            item.substitution_acknowledged_by::text,
            item.substitution_acknowledged_at,
            item.substitution_acknowledged_event_version,
            indent.indent_number, indent.status AS ward_indent_status,
            indent.state_version AS ward_indent_state_version,
            indent.patient_uid::text, indent.encounter_id::text,
            indent.admission_id, indent.tenant_id::text
       FROM ward_indent_items item
       JOIN ward_indents indent
         ON indent.tenant_id = item.tenant_id
        AND indent.id = item.ward_indent_id
      WHERE item.tenant_id = $1::uuid
        AND item.clinical_order_id = $2::int
        AND indent.patient_uid = $3::uuid
      ORDER BY item.id
      LIMIT 2
      ${lock ? 'FOR KEY SHARE OF item, indent' : ''}`,
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
            item.display_name, item.sku_code
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
      ${lock ? 'FOR UPDATE OF allocation' : ''}`,
    tenantId,
    wardIndentItemId,
  );
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
      LIMIT 1
      FOR SHARE`,
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
  administrationMode,
  commandKey,
  supplyQuantity = null,
  supplyOverrideReason = null,
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
  const substitutionAcknowledged = String(wardItem.substitution_status || '').toLowerCase() !== 'approved'
    || Boolean(wardItem.substitution_acknowledged_at);
  const allocations = await loadAvailableAllocationsTx(
    tx,
    tid,
    Number(wardItem.id),
    { lock: true },
  );
  const availableQuantity = allocations.reduce(
    (sum, allocation) => sum + Number(allocation.available_quantity || 0),
    0,
  );
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
  const availableQuantity = allocations.reduce(
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
    allocations,
    consumptions,
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
    const allocationId = positiveBigInt(
      entry?.inventory_allocation_id ?? entry?.allocation_id,
      'inventory_allocation_id',
    );
    const quantity = positiveQuantity(entry?.quantity, 'quantity');
    const key = allocationId.toString();
    const current = byId.get(key) || { inventoryAllocationId: allocationId, quantity: 0 };
    current.quantity = Math.round((current.quantity + quantity) * 10000) / 10000;
    byId.set(key, current);
  }
  return [...byId.values()]
    .sort((left, right) => (
      left.inventoryAllocationId < right.inventoryAllocationId ? -1
        : left.inventoryAllocationId > right.inventoryAllocationId ? 1 : 0
    ));
}

export async function reconcileMarSupplyOverride(consumptionId, allocations, {
  tenantId,
  reconciledBy,
  commandKey,
  expectedMedicationAdministrationId = null,
}) {
  const tid = requireTenantId(tenantId);
  const unmatchedConsumptionId = positiveBigInt(consumptionId, 'consumptionId');
  const actorUid = requiredText(reconciledBy, 'reconciledBy', 100);
  const entries = allocationEntries(allocations);
  const baseCommand = requiredText(commandKey, 'Idempotency-Key', 1000);
  return setTenantTx(tid, async (tx) => {
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
        LIMIT 1
        FOR UPDATE`,
      tid,
      unmatchedConsumptionId,
    );
    const consumption = rows[0];
    if (!consumption) throw AppError.notFound('MAR supply override consumption not found');
    if (
      expectedMedicationAdministrationId != null
      && Number(consumption.medication_administration_id)
        !== positiveId(expectedMedicationAdministrationId, 'medicationAdministrationId')
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
        `SELECT inventory_batch_id
           FROM ward_indent_inventory_allocations
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint
          LIMIT 1
          FOR KEY SHARE`,
        tid,
        entry.inventoryAllocationId,
      );
      if (!allocationRows[0]) throw AppError.notFound('Ward inventory allocation not found');
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
        Number(allocationRows[0].inventory_batch_id),
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
          LIMIT 1
          FOR SHARE`,
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
    return normalizeWireValue({
      consumption,
      links,
      reconciled_quantity: reconciledQuantity,
      outstanding_quantity: Math.max(0, requiredQuantity - reconciledQuantity),
      state,
    });
  });
}

export default {
  consumeMarSupplyTx,
  getMarSupplyState,
  getMarSupplyStateTx,
  reconcileMarSupplyOverride,
};
