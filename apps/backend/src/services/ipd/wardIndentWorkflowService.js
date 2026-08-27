import { createHash } from 'node:crypto';
import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { DOCTOR_TIERS, ROLES } from '../../utils/roleHelpers.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  cancelWorkflowSla,
  completeWorkflowSla,
  recordCanonicalClinicalEvent,
  startWorkflowSla,
} from '../clinical/canonicalClinicalPlatformService.js';
import { createTask } from '../workflow/taskService.js';

const PHARMACY_OWNERS = [
  ROLES.PHARMACY_STAFF,
  ROLES.PHARMACY_INCHARGE,
  'PHARMACIST',
];
const SUBSTITUTION_OWNERS = [...DOCTOR_TIERS];
const WARD_OWNERS = [
  ROLES.NURSING_STAFF,
  ROLES.NURSING_INCHARGE,
  ROLES.IP_STAFF_NURSE,
  ROLES.IP_INCHARGE,
  'ICU_NURSE',
  'ICU_INCHARGE',
  'ICU_STAFF',
  'ER_STAFF',
];
const RECONCILIATION_OWNERS = [
  ROLES.PHARMACY_INCHARGE,
  ROLES.NURSING_INCHARGE,
  ROLES.IP_INCHARGE,
  'ICU_INCHARGE',
];

export const WARD_INDENT_STATE_CONTRACT = Object.freeze({
  requested: {
    ownerRoles: PHARMACY_OWNERS,
    slaRuleCode: 'ward_indent_pharmacy_response',
  },
  reserved: {
    ownerRoles: PHARMACY_OWNERS,
    slaRuleCode: 'ward_indent_pharmacy_response',
  },
  short_supply: {
    ownerRoles: PHARMACY_OWNERS,
    slaRuleCode: 'ward_indent_pharmacy_response',
  },
  substitution_pending: {
    ownerRoles: SUBSTITUTION_OWNERS,
    slaRuleCode: 'ward_indent_substitution_authorization',
  },
  controlled_handoff_required: {
    ownerRoles: PHARMACY_OWNERS,
    slaRuleCode: 'ward_indent_controlled_handoff',
  },
  approved: {
    ownerRoles: PHARMACY_OWNERS,
    slaRuleCode: 'ward_indent_pharmacy_issue',
  },
  issued: {
    ownerRoles: WARD_OWNERS,
    slaRuleCode: 'ward_indent_ward_receipt',
  },
  partially_received: {
    ownerRoles: WARD_OWNERS,
    slaRuleCode: 'ward_indent_ward_receipt',
  },
  received: {
    ownerRoles: RECONCILIATION_OWNERS,
    slaRuleCode: 'ward_indent_reconciliation',
  },
  return_pending: {
    ownerRoles: RECONCILIATION_OWNERS,
    slaRuleCode: 'ward_indent_reconciliation',
  },
  reconciliation_required: {
    ownerRoles: RECONCILIATION_OWNERS,
    slaRuleCode: 'ward_indent_reconciliation',
  },
  reconciled: {
    ownerRoles: RECONCILIATION_OWNERS,
    slaRuleCode: 'ward_indent_reconciliation',
  },
  rejected: { ownerRoles: [], slaRuleCode: null, terminal: true },
  cancelled: { ownerRoles: [], slaRuleCode: null, terminal: true },
  closed: { ownerRoles: [], slaRuleCode: null, terminal: true },
});

const RESERVATION_STATUSES = [
  'reserved',
  'short_supply',
  'substitution_pending',
  'controlled_handoff_required',
  'approved',
];
const CONTROLLED_SCHEDULES = new Set(['H', 'H1', 'X']);
const RECONCILIATION_DISPOSITIONS = new Set([
  'transit_shortage',
  'ward_count_variance',
  'damaged_in_transit',
  'documented_exception',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function tenantOf(value) {
  return requireTenantId(value);
}

function positiveInt(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function uuid(value, fieldName) {
  const text = String(value || '').trim();
  if (!UUID_RE.test(text)) throw AppError.badRequest(`${fieldName} must be a UUID`);
  return text;
}

function quantity(value, fieldName, { allowZero = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw AppError.badRequest(`${fieldName} must be ${allowZero ? 'non-negative' : 'positive'}`);
  }
  const normalized = Math.round(parsed * 100) / 100;
  if (Math.abs(parsed - normalized) > Number.EPSILON || normalized > 99999999.99) {
    throw AppError.badRequest(`${fieldName} must fit a non-negative decimal with at most 2 places`);
  }
  return normalized;
}

function reasonText(value, fieldName = 'reason') {
  const text = String(value || '').trim();
  if (!text) throw AppError.badRequest(`${fieldName} is required`);
  return text.slice(0, 2000);
}

export function wardIndentCommandKey(indentId, action, commandKey) {
  const value = String(commandKey || '').trim();
  if (!value) return null;
  const prefix = action === 'requested'
    ? 'ward-indent:create'
    : `ward-indent:${positiveInt(indentId, 'indentId')}:${action}`;
  const candidate = `${prefix}:${value}`;
  if (candidate.length <= 200) return candidate;
  const digest = createHash('sha256').update(candidate).digest('hex');
  return `${prefix}:${digest}`;
}

function defaultSlaSourceId(indent) {
  return `ward-indent:${indent.id}:v${Number(indent.state_version)}`;
}

function activeSlaSourceId(indent) {
  return indent.active_sla_source_id || defaultSlaSourceId(indent);
}

function itemEntryMap(entries, valueField, currentItems, {
  required = false,
  allowZero = false,
} = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    if (required) throw AppError.badRequest(`${valueField} entries are required`);
    return new Map();
  }
  const known = new Set(currentItems.map((item) => Number(item.id)));
  const out = new Map();
  for (const entry of entries) {
    const itemId = positiveInt(entry?.item_id ?? entry?.id, 'item_id');
    if (!known.has(itemId)) {
      throw AppError.badRequest(`Ward indent item ${itemId} does not belong to this indent`);
    }
    if (out.has(itemId)) throw AppError.badRequest(`Duplicate ward indent item ${itemId}`);
    out.set(itemId, quantity(entry?.[valueField], valueField, { allowZero }));
  }
  return out;
}

async function lockWardIndent(tx, indentId, tenantId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id, indent_number, status, state_version,
            patient_uid, encounter_id, admission_id, ward_id, ward_name,
            indent_type, requested_by, approved_by, issued_by, received_by,
            owner_role_codes
       FROM ward_indents
      WHERE id = $1::int
        AND tenant_id = $2::uuid
      FOR UPDATE`,
    positiveInt(indentId, 'indentId'),
    tenantId,
  );
  if (!rows[0]) throw AppError.notFound('Ward indent not found');
  const indent = await tx.ward_indents.findUnique({
    where: { id: Number(rows[0].id) },
    include: { items: { orderBy: { id: 'asc' } } },
  });
  if (!indent || String(indent.tenant_id) !== String(tenantId)) {
    throw AppError.notFound('Ward indent not found');
  }
  return indent;
}

function assertState(current, allowed, action) {
  if (!allowed.includes(current.status)) {
    throw AppError.conflict(
      `Ward indent cannot ${action} from '${current.status}'`,
      'WARD_INDENT_INVALID_TRANSITION',
      { action, from: current.status, allowed },
    );
  }
}

function assertExpectedVersion(current, expectedVersion) {
  if (expectedVersion == null) return;
  const expected = positiveInt(expectedVersion, 'expected_version');
  if (Number(current.state_version) !== expected) {
    throw AppError.conflict(
      'Ward indent changed after it was loaded; refresh before retrying',
      'WARD_INDENT_VERSION_CONFLICT',
      { expected_version: expected, actual_version: Number(current.state_version) },
    );
  }
}

async function loadWardIndentWorkflow(tx, indentId, tenantId, { eventLimit = 100 } = {}) {
  const indent = await tx.ward_indents.findFirst({
    where: { id: Number(indentId), tenant_id: tenantId },
    include: { items: { orderBy: { id: 'asc' } } },
  });
  if (!indent) return null;
  const events = await tx.ward_indent_events.findMany({
    where: { tenant_id: tenantId, ward_indent_id: Number(indentId) },
    orderBy: { state_version: 'desc' },
    take: Math.max(1, Math.min(200, Number(eventLimit) || 100)),
  });
  const activeSlas = await tx.workflow_sla_instances.findMany({
    where: {
      tenant_id: tenantId,
      source_table: 'ward_indents',
      source_id: indent.active_sla_source_id || '__terminal__',
      status: { in: ['active', 'breached', 'escalated'] },
      completed_at: null,
    },
    orderBy: { started_at: 'desc' },
  });
  return {
    ...indent,
    workflow: {
      owner_role_codes: indent.owner_role_codes || [],
      active_slas: activeSlas,
      events,
      controlled_handoff_references: indent.items
        .filter((item) => item.controlled_reference_id)
        .map((item) => ({
          item_id: item.id,
          reference_id: item.controlled_reference_id,
        })),
    },
  };
}

async function loadCommandReplay(tx, {
  tenantId,
  indentId,
  action,
  commandKey,
  actorUid = null,
}) {
  const encoded = wardIndentCommandKey(indentId, action, commandKey);
  if (!encoded) return null;
  const event = await tx.ward_indent_events.findFirst({
    where: { tenant_id: tenantId, command_key: encoded },
    select: { ward_indent_id: true, actor_uid: true },
  });
  if (!event) return null;
  if (indentId != null && Number(event.ward_indent_id) !== Number(indentId)) {
    throw AppError.conflict(
      'Idempotency key is already bound to another ward indent',
      'WARD_INDENT_IDEMPOTENCY_SCOPE_CONFLICT',
    );
  }
  if (actorUid && String(event.actor_uid) !== String(actorUid)) {
    throw AppError.conflict(
      'Idempotency key was already used by another actor',
      'WARD_INDENT_IDEMPOTENCY_ACTOR_CONFLICT',
    );
  }
  return loadWardIndentWorkflow(tx, event.ward_indent_id, tenantId);
}

export async function findWardIndentCreateReplayTx(tx, {
  tenantId,
  commandKey,
  actorUid,
}) {
  const tid = tenantOf(tenantId);
  const cleanActorUid = uuid(actorUid, 'actorUid');
  const encoded = wardIndentCommandKey(null, 'requested', commandKey);
  if (!encoded) return null;
  await tx.$queryRawUnsafe(
    `SELECT 1::int AS locked
       FROM (SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))) AS guard`,
    `${tid}:${encoded}`,
  );
  return loadCommandReplay(tx, {
    tenantId: tid,
    indentId: null,
    action: 'requested',
    commandKey,
    actorUid: cleanActorUid,
  });
}

async function requireSlaStart(tx, indent, status, metadata = {}) {
  const contract = WARD_INDENT_STATE_CONTRACT[status];
  if (!contract?.slaRuleCode) return null;
  const instance = await startWorkflowSla({
    tenantId: indent.tenant_id,
    ruleCode: contract.slaRuleCode,
    patientUid: indent.patient_uid,
    encounterId: indent.encounter_id,
    sourceTable: 'ward_indents',
    sourceId: activeSlaSourceId(indent),
    priority: status === 'controlled_handoff_required' ? 'critical' : 'high',
    assignedRoleCodes: contract.ownerRoles,
    metadata: {
      med_01: true,
      ward_indent_id: indent.id,
      indent_number: indent.indent_number,
      state: status,
      state_version: Number(indent.state_version),
      ...metadata,
    },
  }, { db: tx, strict: true });
  if (!instance) {
    throw AppError.internal(
      `Workflow SLA rule '${contract.slaRuleCode}' is unavailable`,
      'WARD_INDENT_SLA_RULE_UNAVAILABLE',
    );
  }
  return instance;
}

async function rotateSla(tx, before, after, action) {
  const previous = WARD_INDENT_STATE_CONTRACT[before.status]?.slaRuleCode || null;
  const next = WARD_INDENT_STATE_CONTRACT[after.status]?.slaRuleCode || null;

  if (previous === next) {
    if (next) await requireSlaStart(tx, after, after.status, { last_action: action });
    return;
  }

  if (previous) {
    await requireSlaStart(tx, before, before.status, { legacy_clock_bootstrap: true });
    if (after.status === 'rejected' || after.status === 'cancelled') {
      const cancelled = await cancelWorkflowSla({
        tenantId: before.tenant_id,
        ruleCode: previous,
        sourceTable: 'ward_indents',
        sourceId: activeSlaSourceId(before),
        metadata: { med_01: true, terminal_action: action },
      }, { db: tx });
      if (!Array.isArray(cancelled) || cancelled.length === 0) {
        throw AppError.internal(
          'Ward indent SLA cancellation was not persisted',
          'WARD_INDENT_SLA_CANCEL_FAILED',
        );
      }
    } else {
      const completed = await completeWorkflowSla({
        tenantId: before.tenant_id,
        ruleCode: previous,
        sourceTable: 'ward_indents',
        sourceId: activeSlaSourceId(before),
        metadata: { med_01: true, completed_by_action: action },
      }, { db: tx });
      if (!completed) {
        throw AppError.internal(
          'Ward indent SLA completion was not persisted',
          'WARD_INDENT_SLA_COMPLETE_FAILED',
        );
      }
    }
  }

  if (next) await requireSlaStart(tx, after, after.status, { started_by_action: action });
}

async function appendTransitionEvidence(tx, {
  before,
  after,
  action,
  actorUid,
  reason = null,
  commandKey = null,
  details = {},
}) {
  await tx.ward_indent_events.create({
    data: {
      tenant_id: after.tenant_id,
      ward_indent_id: after.id,
      state_version: Number(after.state_version),
      action,
      from_status: before?.status || null,
      to_status: after.status,
      actor_uid: actorUid,
      owner_role_codes: after.owner_role_codes || [],
      reason,
      command_key: wardIndentCommandKey(after.id, action, commandKey),
      details,
    },
  });

  if (!after.patient_uid) return;
  await recordCanonicalClinicalEvent({
    tenantId: after.tenant_id,
    patientUid: String(after.patient_uid),
    encounterId: after.encounter_id || null,
    eventType: `ward_indent.${action}`,
    eventStatus: after.status,
    sourceTable: 'ward_indents',
    sourceId: String(after.id),
    resourceType: 'ward_indent',
    resourceId: String(after.id),
    actorUid,
    occurredAt: after.last_transition_at,
    visibleToPatient: false,
    summary: `Ward indent ${after.indent_number} ${action.replaceAll('_', ' ')}`,
    payload: {
      med_01: true,
      ward_indent_id: after.id,
      indent_number: after.indent_number,
      indent_type: after.indent_type,
      ward_id: after.ward_id,
      ward_name: after.ward_name,
      admission_id: after.admission_id,
      state_version: Number(after.state_version),
      owner_role_codes: after.owner_role_codes || [],
      item_count: after.items?.length ?? 0,
      ...details,
    },
    beforeState: before ? {
      status: before.status,
      state_version: Number(before.state_version),
    } : null,
    afterState: {
      status: after.status,
      state_version: Number(after.state_version),
      owner_role_codes: after.owner_role_codes || [],
    },
    timelineIdempotencyKey: `ward_indents:${after.id}:transition:${after.state_version}`,
    auditIdempotencyKey: `ward_indents:${after.id}:audit:transition:${after.state_version}`,
  }, { db: tx, strict: true });
}

async function applyTransition({
  indentId,
  tenantId,
  actorUid,
  expectedVersion = null,
  action,
  allowedStatuses,
  reason = null,
  commandKey = null,
  mutate,
}) {
  const cleanActorUid = uuid(actorUid, 'actorUid');
  const tid = tenantOf(tenantId);
  return setTenantTx(tid, async (tx) => {
    const current = await lockWardIndent(tx, indentId, tid);
    const replay = await loadCommandReplay(tx, {
      tenantId: tid,
      indentId: current.id,
      action,
      commandKey,
      actorUid: cleanActorUid,
    });
    if (replay) return replay;
    assertState(current, allowedStatuses, action);
    assertExpectedVersion(current, expectedVersion);
    const outcome = await mutate(tx, current);
    const toStatus = outcome.toStatus;
    const contract = WARD_INDENT_STATE_CONTRACT[toStatus];
    if (!contract) {
      throw AppError.internal(
        `Ward indent state contract is missing '${toStatus}'`,
        'WARD_INDENT_STATE_CONTRACT_MISSING',
      );
    }
    const previousRule = WARD_INDENT_STATE_CONTRACT[current.status]?.slaRuleCode || null;
    const nextRule = contract.slaRuleCode || null;
    const nextVersion = Number(current.state_version) + 1;
    const nextSlaSourceId = nextRule == null
      ? null
      : previousRule === nextRule
        ? activeSlaSourceId(current)
        : `ward-indent:${current.id}:v${nextVersion}`;
    const updated = await tx.ward_indents.update({
      where: { id: current.id },
      data: {
        ...outcome.indentData,
        status: toStatus,
        state_version: { increment: 1 },
        owner_role_codes: contract.ownerRoles,
        active_sla_source_id: nextSlaSourceId,
        last_transition_at: new Date(),
        updated_at: new Date(),
      },
      include: { items: { orderBy: { id: 'asc' } } },
    });
    await appendTransitionEvidence(tx, {
      before: current,
      after: updated,
      action,
      actorUid: cleanActorUid,
      reason,
      commandKey,
      details: outcome.details || {},
    });
    await rotateSla(tx, current, updated, action);
    return loadWardIndentWorkflow(tx, current.id, tid);
  });
}

async function classifyCatalogControl(tx, tenantId, catalogIds) {
  const ids = [...new Set(catalogIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return new Map();
  const rows = await tx.$queryRawUnsafe(
    `SELECT pc.id AS catalog_id,
            COUNT(item.id)::int AS linked_item_count,
            COALESCE(
              BOOL_OR(item.schedule_class IN ('H', 'H1', 'X') OR item.is_narcotic = TRUE),
              FALSE
            ) AS is_controlled
       FROM pharmacy_catalog pc
       LEFT JOIN pharmacy_inventory_items item
         ON item.tenant_id = pc.tenant_id
        AND item.catalog_id = pc.id
      WHERE pc.tenant_id = $1::uuid
        AND pc.id = ANY($2::int[])
      GROUP BY pc.id`,
    tenantId,
    ids,
  );
  const out = new Map(rows.map((row) => [Number(row.catalog_id), {
    controlled: row.is_controlled === true,
    linked: Number(row.linked_item_count) > 0,
  }]));
  for (const id of ids) {
    if (!out.get(id)?.linked) {
      throw AppError.conflict(
        `Catalog item ${id} has no same-facility inventory classification`,
        'WARD_INDENT_CONTROLLED_CLASSIFICATION_UNRESOLVED',
        { catalog_id: id },
      );
    }
  }
  return out;
}

/**
 * Resolve each catalog id to its linked pharmacy_inventory_items row (lowest
 * id when several link) so ward traffic can be written into the
 * pharmacy_stock_movements audit ledger. classifyCatalogControl has already
 * guaranteed every ward-indent catalog item carries at least one linked
 * inventory classification.
 */
async function resolveLinkedInventoryItems(tx, tenantId, catalogIds) {
  const ids = [...new Set(catalogIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return new Map();
  const rows = await tx.$queryRawUnsafe(
    `SELECT catalog_id, MIN(id)::int AS inventory_item_id
       FROM pharmacy_inventory_items
      WHERE tenant_id = $1::uuid
        AND catalog_id = ANY($2::int[])
      GROUP BY catalog_id`,
    tenantId,
    ids,
  );
  return new Map(rows.map((row) => [Number(row.catalog_id), Number(row.inventory_item_id)]));
}

/**
 * Ward issue/return traffic previously mutated only the pharmacy_catalog
 * counter, leaving the pharmacy_stock_movements audit ledger blind to ward
 * consumption (Sol-verification finding N4). Non-controlled ward movements now
 * append a ledger row per item in the same transaction. inventory_batch_id
 * stays NULL by design: ward stock is tracked on the catalog counter, not the
 * batch/FEFO plane — this restores the movement audit trail without changing
 * availability semantics. (Controlled lines never reach here; they carry
 * witnessed inventory-v2 movement + register evidence.)
 */
async function appendWardMovementLedgerTx(tx, {
  tenantId, indentId, inventoryItemId, movementKind, quantityDelta, performedBy, note,
}) {
  if (!inventoryItemId) return;
  await tx.$queryRawUnsafe(
    `INSERT INTO pharmacy_stock_movements
       (tenant_id, inventory_item_id, inventory_batch_id, movement_kind,
        quantity_delta, reference_type, reference_id, performed_by, notes)
     VALUES ($1::uuid, $2::int, NULL, $3, $4::numeric, 'ward_indent', $5, $6::uuid, $7)`,
    tenantId,
    Number(inventoryItemId),
    movementKind,
    quantityDelta,
    String(indentId),
    performedBy ? String(performedBy) : null,
    note || null,
  );
}

async function lockCatalogRows(tx, tenantId, catalogIds) {
  const ids = [...new Set(catalogIds.map(Number))].sort((a, b) => a - b);
  if (!ids.length) return new Map();
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, name, generic_name, unit_price, price, stock_quantity, is_active
       FROM pharmacy_catalog
      WHERE tenant_id = $1::uuid
        AND id = ANY($2::int[])
      ORDER BY id
      FOR UPDATE`,
    tenantId,
    ids,
  );
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || row.is_active === false) {
      throw AppError.notFound(`Active catalog item ${id} not found`);
    }
  }
  return byId;
}

async function assertReservationAvailability(tx, {
  tenantId,
  indentId,
  items,
  catalogById,
  controlByCatalog,
}) {
  const nonControlledIds = [...new Set(items
    .filter((item) => !controlByCatalog.get(Number(item.catalogId))?.controlled)
    .map((item) => Number(item.catalogId)))];
  if (!nonControlledIds.length) return;
  const rows = await tx.$queryRawUnsafe(
    `SELECT item.pharmacy_catalog_id AS catalog_id,
            COALESCE(SUM(item.quantity_reserved), 0)::numeric AS reserved_quantity
       FROM ward_indent_items item
       JOIN ward_indents indent ON indent.id = item.ward_indent_id
      WHERE indent.tenant_id = $1::uuid
        AND indent.id <> $2::int
        AND indent.status = ANY($3::text[])
        AND item.pharmacy_catalog_id = ANY($4::int[])
        AND item.controlled_reference_id IS NULL
      GROUP BY item.pharmacy_catalog_id`,
    tenantId,
    indentId,
    RESERVATION_STATUSES,
    nonControlledIds,
  );
  const otherReservations = new Map(rows.map((row) => [
    Number(row.catalog_id),
    Number(row.reserved_quantity),
  ]));
  const requestedByCatalog = new Map();
  for (const item of items) {
    const catalogId = Number(item.catalogId);
    if (controlByCatalog.get(catalogId)?.controlled) continue;
    requestedByCatalog.set(
      catalogId,
      (requestedByCatalog.get(catalogId) || 0) + Number(item.quantity),
    );
  }
  const shortfalls = [];
  for (const [catalogId, requested] of requestedByCatalog) {
    const row = catalogById.get(catalogId);
    const available = Math.max(0, Number(row?.stock_quantity || 0) - (otherReservations.get(catalogId) || 0));
    if (requested > available) {
      shortfalls.push({ catalog_id: catalogId, requested, available });
    }
  }
  if (shortfalls.length) {
    throw AppError.conflict(
      'Ward indent stock cannot be fully reserved',
      'WARD_INDENT_INSUFFICIENT_RESERVABLE_STOCK',
      { shortfalls },
    );
  }
}

export async function initializeWardIndentWorkflowTx(tx, {
  indent,
  actorUid,
  commandKey = null,
  source = 'manual_request',
}) {
  const cleanActorUid = uuid(actorUid, 'actorUid');
  const contract = WARD_INDENT_STATE_CONTRACT.requested;
  await tx.ward_indent_items.updateMany({
    where: { ward_indent_id: indent.id, tenant_id: indent.tenant_id },
    data: {
      fulfilment_status: 'requested',
      quantity_reserved: 0,
      quantity_approved: 0,
      quantity_received: 0,
      quantity_variance_resolved: 0,
      quantity_return_requested: 0,
      quantity_returned: 0,
    },
  });
  const initialized = await tx.ward_indents.update({
    where: { id: indent.id },
    data: {
      status: 'requested',
      state_version: 1,
      owner_role_codes: contract.ownerRoles,
      active_sla_source_id: `ward-indent:${indent.id}:v1`,
      last_transition_at: indent.requested_at || new Date(),
      updated_at: new Date(),
    },
    include: { items: { orderBy: { id: 'asc' } } },
  });
  await appendTransitionEvidence(tx, {
    before: null,
    after: initialized,
    action: 'requested',
    actorUid: cleanActorUid,
    commandKey,
    details: { source },
  });
  await requireSlaStart(tx, initialized, 'requested', { source });
  return loadWardIndentWorkflow(tx, initialized.id, initialized.tenant_id);
}

export async function reserveWardIndent({
  indentId,
  reservedBy,
  itemQuantitiesReserved = null,
  expectedVersion = null,
  commandKey = null,
  tenantId,
}) {
  return applyTransition({
    indentId,
    tenantId,
    actorUid: reservedBy,
    expectedVersion,
    commandKey,
    action: 'reserved',
    allowedStatuses: ['requested', 'short_supply'],
    mutate: async (tx, current) => {
      const map = itemEntryMap(
        itemQuantitiesReserved,
        'quantity_reserved',
        current.items,
      );
      const reservations = current.items.map((item) => {
        if (!item.pharmacy_catalog_id) {
          throw AppError.conflict(
            `Ward indent item ${item.id} must be linked to a catalog item before reservation`,
            'WARD_INDENT_CATALOG_LINK_REQUIRED',
            { item_id: item.id },
          );
        }
        const desired = map.has(item.id)
          ? map.get(item.id)
          : Number(item.quantity_requested);
        if (desired !== Number(item.quantity_requested)) {
          throw AppError.badRequest(
            `Item ${item.id} is not fully available; record short supply instead`,
            'WARD_INDENT_SHORT_SUPPLY_REQUIRED',
          );
        }
        return {
          item,
          catalogId: Number(item.pharmacy_catalog_id),
          quantity: desired,
        };
      });
      const catalogIds = reservations.map((entry) => entry.catalogId);
      const catalogById = await lockCatalogRows(tx, current.tenant_id, catalogIds);
      const controlByCatalog = await classifyCatalogControl(tx, current.tenant_id, catalogIds);
      await assertReservationAvailability(tx, {
        tenantId: current.tenant_id,
        indentId: current.id,
        items: reservations,
        catalogById,
        controlByCatalog,
      });
      for (const entry of reservations) {
        const controlled = controlByCatalog.get(entry.catalogId)?.controlled === true;
        await tx.ward_indent_items.update({
          where: { id: entry.item.id },
          data: {
            quantity_reserved: entry.quantity,
            fulfilment_status: 'reserved',
            controlled_reference_id: controlled
              ? `ward-indent:${current.id}:item:${entry.item.id}`
              : null,
            updated_at: new Date(),
          },
        });
      }
      return {
        toStatus: 'reserved',
        indentData: { short_supply_reason: null },
        details: { reserved_item_count: reservations.length },
      };
    },
  });
}

export async function markWardIndentShortSupply({
  indentId,
  markedBy,
  reason,
  itemQuantitiesAvailable,
  expectedVersion = null,
  commandKey = null,
  tenantId,
}) {
  const cleanReason = reasonText(reason, 'short_supply_reason');
  return applyTransition({
    indentId,
    tenantId,
    actorUid: markedBy,
    expectedVersion,
    commandKey,
    reason: cleanReason,
    action: 'short_supply_recorded',
    allowedStatuses: ['requested', 'reserved', 'short_supply'],
    mutate: async (tx, current) => {
      const available = itemEntryMap(
        itemQuantitiesAvailable,
        'quantity_available',
        current.items,
        { required: true, allowZero: true },
      );
      const reservations = current.items.map((item) => {
        if (!item.pharmacy_catalog_id) {
          throw AppError.conflict(
            `Ward indent item ${item.id} must be linked to a catalog item before short supply can be recorded`,
            'WARD_INDENT_CATALOG_LINK_REQUIRED',
            { item_id: item.id },
          );
        }
        return {
          item,
          catalogId: Number(item.pharmacy_catalog_id),
          quantity: available.has(item.id)
            ? available.get(item.id)
            : Number(item.quantity_reserved || 0),
        };
      });
      const catalogIds = reservations.map((entry) => entry.catalogId);
      const catalogById = await lockCatalogRows(tx, current.tenant_id, catalogIds);
      const controlByCatalog = await classifyCatalogControl(tx, current.tenant_id, catalogIds);
      await assertReservationAvailability(tx, {
        tenantId: current.tenant_id,
        indentId: current.id,
        items: reservations,
        catalogById,
        controlByCatalog,
      });
      let hasShortfall = false;
      for (const item of current.items) {
        const qty = available.has(item.id)
          ? available.get(item.id)
          : Number(item.quantity_reserved || 0);
        if (qty > Number(item.quantity_requested)) {
          throw AppError.badRequest(`Item ${item.id} available quantity exceeds requested quantity`);
        }
        if (qty < Number(item.quantity_requested)) hasShortfall = true;
        await tx.ward_indent_items.update({
          where: { id: item.id },
          data: {
            quantity_reserved: qty,
            fulfilment_status: qty < Number(item.quantity_requested)
              ? 'short_supply'
              : 'reserved',
            updated_at: new Date(),
          },
        });
      }
      if (!hasShortfall) {
        throw AppError.badRequest('At least one item must be short supplied');
      }
      return {
        toStatus: 'short_supply',
        indentData: { short_supply_reason: cleanReason },
        details: { short_supply_reason: cleanReason },
      };
    },
  });
}

export async function proposeWardIndentSubstitution({
  indentId,
  proposedBy,
  substitutions,
  expectedVersion = null,
  commandKey = null,
  tenantId,
}) {
  return applyTransition({
    indentId,
    tenantId,
    actorUid: proposedBy,
    expectedVersion,
    commandKey,
    action: 'substitution_proposed',
    allowedStatuses: ['short_supply'],
    mutate: async (tx, current) => {
      if (!Array.isArray(substitutions) || substitutions.length === 0) {
        throw AppError.badRequest('substitutions must be a non-empty array');
      }
      const known = new Map(current.items.map((item) => [Number(item.id), item]));
      const seen = new Set();
      const proposals = [];
      for (const entry of substitutions) {
        const itemId = positiveInt(entry?.item_id, 'item_id');
        const item = known.get(itemId);
        if (!item) throw AppError.badRequest(`Ward indent item ${itemId} does not belong to this indent`);
        if (seen.has(itemId)) throw AppError.badRequest(`Duplicate ward indent item ${itemId}`);
        if (Number(item.quantity_reserved) >= Number(item.quantity_requested)) {
          throw AppError.conflict(
            `Ward indent item ${itemId} is fully reserved and cannot be substituted`,
            'WARD_INDENT_SUBSTITUTION_NOT_SHORT_SUPPLIED',
            { item_id: itemId },
          );
        }
        seen.add(itemId);
        const catalogId = positiveInt(entry?.substitute_catalog_id, 'substitute_catalog_id');
        if (catalogId === Number(item.pharmacy_catalog_id)) {
          throw AppError.badRequest(`Item ${itemId} substitute must differ from the current catalog item`);
        }
        proposals.push({
          item,
          catalogId,
          quantity: quantity(
            entry?.quantity ?? item.quantity_requested,
            'substitution quantity',
          ),
          reason: reasonText(entry?.reason, 'substitution reason'),
        });
      }
      const catalogById = await lockCatalogRows(
        tx,
        current.tenant_id,
        proposals.map((entry) => entry.catalogId),
      );
      await classifyCatalogControl(
        tx,
        current.tenant_id,
        proposals.map((entry) => entry.catalogId),
      );
      for (const proposal of proposals) {
        if (proposal.quantity > Number(proposal.item.quantity_requested)) {
          throw AppError.badRequest(`Item ${proposal.item.id} substitution quantity exceeds requested quantity`);
        }
        const catalog = catalogById.get(proposal.catalogId);
        await tx.ward_indent_items.update({
          where: { id: proposal.item.id },
          data: {
            proposed_pharmacy_catalog_id: proposal.catalogId,
            proposed_item_name: catalog.name,
            proposed_quantity: proposal.quantity,
            substitution_status: 'pending',
            substitution_reason: proposal.reason,
            substitution_proposed_by: proposedBy,
            substitution_proposed_at: new Date(),
            fulfilment_status: 'substitution_pending',
            updated_at: new Date(),
          },
        });
      }
      return {
        toStatus: 'substitution_pending',
        details: {
          substitution_item_ids: proposals.map((entry) => entry.item.id),
        },
      };
    },
  });
}

export async function approveWardIndentSubstitution({
  indentId,
  decidedBy,
  expectedVersion = null,
  commandKey = null,
  tenantId,
}) {
  return applyTransition({
    indentId,
    tenantId,
    actorUid: decidedBy,
    expectedVersion,
    commandKey,
    action: 'substitution_approved',
    allowedStatuses: ['substitution_pending'],
    mutate: async (tx, current) => {
      const pending = current.items.filter((item) => item.substitution_status === 'pending');
      if (!pending.length) throw AppError.conflict('Ward indent has no pending substitutions');
      const pendingIds = new Set(pending.map((item) => Number(item.id)));
      const reservations = current.items.map((item) => ({
        item,
        catalogId: pendingIds.has(Number(item.id))
          ? Number(item.proposed_pharmacy_catalog_id)
          : Number(item.pharmacy_catalog_id),
        quantity: pendingIds.has(Number(item.id))
          ? Number(item.proposed_quantity)
          : Number(item.quantity_reserved),
      }));
      const catalogIds = reservations.map((entry) => entry.catalogId);
      const catalogById = await lockCatalogRows(tx, current.tenant_id, catalogIds);
      const controlByCatalog = await classifyCatalogControl(tx, current.tenant_id, catalogIds);
      await assertReservationAvailability(tx, {
        tenantId: current.tenant_id,
        indentId: current.id,
        items: reservations,
        catalogById,
        controlByCatalog,
      });
      for (const entry of reservations.filter(({ item }) => pendingIds.has(Number(item.id)))) {
        const catalog = catalogById.get(entry.catalogId);
        const controlled = controlByCatalog.get(entry.catalogId)?.controlled === true;
        await tx.ward_indent_items.update({
          where: { id: entry.item.id },
          data: {
            original_pharmacy_catalog_id: entry.item.original_pharmacy_catalog_id
              || entry.item.pharmacy_catalog_id,
            original_item_name: entry.item.original_item_name || entry.item.item_name,
            pharmacy_catalog_id: entry.catalogId,
            item_name: catalog.name,
            unit_price: catalog.unit_price ?? catalog.price ?? entry.item.unit_price,
            quantity_reserved: entry.quantity,
            substitution_status: 'approved',
            substitution_decided_by: decidedBy,
            substitution_decided_at: new Date(),
            fulfilment_status: entry.quantity < Number(entry.item.quantity_requested)
              ? 'short_supply'
              : 'reserved',
            controlled_reference_id: controlled
              ? `ward-indent:${current.id}:item:${entry.item.id}`
              : null,
            updated_at: new Date(),
          },
        });
      }
      const rows = await tx.ward_indent_items.findMany({
        where: { ward_indent_id: current.id, tenant_id: current.tenant_id },
        select: { quantity_requested: true, quantity_reserved: true },
      });
      const fullyReserved = rows.every(
        (item) => Number(item.quantity_reserved) === Number(item.quantity_requested),
      );
      return {
        toStatus: fullyReserved ? 'reserved' : 'short_supply',
        indentData: fullyReserved ? { short_supply_reason: null } : {},
        details: {
          substitution_item_ids: pending.map((item) => item.id),
          fully_reserved: fullyReserved,
        },
      };
    },
  });
}

export async function rejectWardIndentSubstitution({
  indentId,
  decidedBy,
  reason,
  expectedVersion = null,
  commandKey = null,
  tenantId,
}) {
  const cleanReason = reasonText(reason, 'substitution rejection reason');
  return applyTransition({
    indentId,
    tenantId,
    actorUid: decidedBy,
    expectedVersion,
    commandKey,
    reason: cleanReason,
    action: 'substitution_rejected',
    allowedStatuses: ['substitution_pending'],
    mutate: async (tx, current) => {
      const result = await tx.ward_indent_items.updateMany({
        where: {
          ward_indent_id: current.id,
          tenant_id: current.tenant_id,
          substitution_status: 'pending',
        },
        data: {
          substitution_status: 'rejected',
          substitution_reason: cleanReason,
          substitution_decided_by: decidedBy,
          substitution_decided_at: new Date(),
          fulfilment_status: 'short_supply',
          updated_at: new Date(),
        },
      });
      if (result.count === 0) throw AppError.conflict('Ward indent has no pending substitutions');
      return {
        toStatus: 'short_supply',
        indentData: { short_supply_reason: cleanReason },
        details: { rejected_substitution_count: result.count },
      };
    },
  });
}

export async function approveWardIndent({
  indentId,
  approvedBy,
  expectedVersion = null,
  commandKey = null,
  tenantId,
}) {
  return applyTransition({
    indentId,
    tenantId,
    actorUid: approvedBy,
    expectedVersion,
    commandKey,
    action: 'approved',
    allowedStatuses: ['reserved'],
    mutate: async (tx, current) => {
      const catalogIds = current.items.map((item) => {
        if (!item.pharmacy_catalog_id) {
          throw AppError.conflict(
            `Ward indent item ${item.id} has no catalog link`,
            'WARD_INDENT_CATALOG_LINK_REQUIRED',
          );
        }
        if (Number(item.quantity_reserved) !== Number(item.quantity_requested)) {
          throw AppError.conflict(
            `Ward indent item ${item.id} is not fully reserved`,
            'WARD_INDENT_NOT_FULLY_RESERVED',
          );
        }
        return Number(item.pharmacy_catalog_id);
      });
      const controlByCatalog = await classifyCatalogControl(tx, current.tenant_id, catalogIds);
      let controlledCount = 0;
      for (const item of current.items) {
        const controlled = controlByCatalog.get(Number(item.pharmacy_catalog_id))?.controlled === true;
        if (controlled) controlledCount += 1;
        await tx.ward_indent_items.update({
          where: { id: item.id },
          data: {
            quantity_approved: Number(item.quantity_reserved),
            fulfilment_status: controlled ? 'controlled_handoff_required' : 'approved',
            controlled_reference_id: controlled
              ? `ward-indent:${current.id}:item:${item.id}`
              : null,
            updated_at: new Date(),
          },
        });
      }
      return {
        toStatus: controlledCount > 0 ? 'controlled_handoff_required' : 'approved',
        indentData: {
          approved_by: approvedBy,
          approved_at: new Date(),
          rejection_reason: null,
        },
        details: { controlled_item_count: controlledCount },
      };
    },
  });
}

export async function rejectWardIndent({
  indentId,
  rejectedBy,
  reason,
  expectedVersion = null,
  commandKey = null,
  tenantId,
}) {
  const cleanReason = reasonText(reason, 'rejection reason');
  return applyTransition({
    indentId,
    tenantId,
    actorUid: rejectedBy,
    expectedVersion,
    commandKey,
    reason: cleanReason,
    action: 'rejected',
    allowedStatuses: [
      'requested',
      'reserved',
      'short_supply',
      'substitution_pending',
      'controlled_handoff_required',
      'approved',
    ],
    mutate: async (tx, current) => {
      const alreadyDispensed = current.items.some(
        (item) => item.controlled_movement_id || Number(item.quantity_issued || 0) > 0,
      );
      if (alreadyDispensed) {
        throw AppError.conflict(
          'Issued or controlled-dispensed stock cannot be rejected; use return and reconciliation',
          'WARD_INDENT_REJECTION_REQUIRES_RECONCILIATION',
        );
      }
      await tx.ward_indent_items.updateMany({
        where: { ward_indent_id: current.id, tenant_id: current.tenant_id },
        data: {
          quantity_reserved: 0,
          quantity_approved: 0,
          fulfilment_status: 'rejected',
          updated_at: new Date(),
        },
      });
      return {
        toStatus: 'rejected',
        indentData: {
          rejection_reason: cleanReason,
          approved_by: rejectedBy,
          approved_at: new Date(),
        },
      };
    },
  });
}

async function validateControlledEvidence(tx, {
  tenantId,
  indent,
  item,
  evidence,
  movementKind,
  registerKind,
  expectedReference,
  expectedQuantity,
}) {
  const movementId = positiveInt(evidence?.movement_id, 'movement_id');
  const registerId = positiveInt(evidence?.register_id, 'register_id');
  const rows = await tx.$queryRawUnsafe(
    `SELECT movement.id AS movement_id,
            movement.inventory_item_id,
            movement.movement_kind,
            movement.quantity_delta,
            movement.reference_type,
            movement.reference_id,
            register_entry.id AS register_id,
            register_entry.movement_kind AS register_movement_kind,
            register_entry.quantity AS register_quantity,
            register_entry.patient_uid,
            inventory.catalog_id,
            inventory.schedule_class,
            inventory.is_narcotic
       FROM pharmacy_stock_movements movement
       JOIN pharmacy_schedule_register register_entry
         ON register_entry.tenant_id = movement.tenant_id
        AND register_entry.reference_movement_id = movement.id
       JOIN pharmacy_inventory_items inventory
         ON inventory.tenant_id = movement.tenant_id
        AND inventory.id = movement.inventory_item_id
      WHERE movement.tenant_id = $1::uuid
        AND movement.id = $2::int
        AND register_entry.id = $3::int`,
    tenantId,
    movementId,
    registerId,
  );
  const row = rows[0];
  const signedQuantity = movementKind === 'issue'
    ? -Math.abs(Number(expectedQuantity))
    : Math.abs(Number(expectedQuantity));
  if (
    !row
    || row.movement_kind !== movementKind
    || Number(row.quantity_delta) !== signedQuantity
    || row.register_movement_kind !== registerKind
    || Number(row.register_quantity) !== Math.abs(Number(expectedQuantity))
    || String(row.reference_id || '') !== expectedReference
    || Number(row.catalog_id) !== Number(item.pharmacy_catalog_id)
    || (!CONTROLLED_SCHEDULES.has(row.schedule_class) && row.is_narcotic !== true)
    || (indent.patient_uid && String(row.patient_uid || '') !== String(indent.patient_uid))
  ) {
    throw AppError.conflict(
      `Controlled-drug evidence does not match ward indent item ${item.id}`,
      'WARD_INDENT_CONTROLLED_EVIDENCE_MISMATCH',
      { item_id: item.id, movement_id: movementId, register_id: registerId },
    );
  }
  if (movementKind === 'issue' && row.reference_type !== 'controlled_dispense') {
    throw AppError.conflict(
      `Controlled-drug issue evidence for item ${item.id} is not a sanctioned dispense`,
      'WARD_INDENT_CONTROLLED_EVIDENCE_PATH_MISMATCH',
    );
  }
  if (movementKind === 'return' && row.reference_type !== 'ward_indent_return') {
    throw AppError.conflict(
      `Controlled-drug return evidence for item ${item.id} is not a sanctioned ward-indent return`,
      'WARD_INDENT_CONTROLLED_RETURN_PATH_MISMATCH',
    );
  }
  return { movementId, registerId };
}

export async function recordWardIndentControlledHandoff({
  indentId,
  recordedBy,
  itemEvidence,
  expectedVersion = null,
  commandKey = null,
  tenantId,
}) {
  return applyTransition({
    indentId,
    tenantId,
    actorUid: recordedBy,
    expectedVersion,
    commandKey,
    action: 'controlled_handoff_recorded',
    allowedStatuses: ['controlled_handoff_required'],
    mutate: async (tx, current) => {
      if (!Array.isArray(itemEvidence) || itemEvidence.length === 0) {
        throw AppError.badRequest('item_evidence must be a non-empty array');
      }
      const evidenceByItem = new Map();
      for (const entry of itemEvidence) {
        const itemId = positiveInt(entry?.item_id, 'item_id');
        if (evidenceByItem.has(itemId)) throw AppError.badRequest(`Duplicate item evidence ${itemId}`);
        evidenceByItem.set(itemId, entry);
      }
      const controlled = current.items.filter((item) => item.controlled_reference_id);
      if (!controlled.length) throw AppError.conflict('Ward indent has no controlled lines');
      const controlledIds = new Set(controlled.map((item) => Number(item.id)));
      for (const itemId of evidenceByItem.keys()) {
        if (!controlledIds.has(itemId)) {
          throw AppError.badRequest(`Item evidence ${itemId} is not a controlled line on this indent`);
        }
      }
      for (const item of controlled) {
        const evidence = evidenceByItem.get(Number(item.id));
        if (!evidence) throw AppError.badRequest(`Controlled evidence is required for item ${item.id}`);
        const validated = await validateControlledEvidence(tx, {
          tenantId: current.tenant_id,
          indent: current,
          item,
          evidence,
          movementKind: 'issue',
          registerKind: 'dispense',
          expectedReference: item.controlled_reference_id,
          expectedQuantity: Number(item.quantity_approved),
        });
        await tx.ward_indent_items.update({
          where: { id: item.id },
          data: {
            controlled_movement_id: validated.movementId,
            controlled_register_id: validated.registerId,
            quantity_issued: Number(item.quantity_approved),
            fulfilment_status: 'controlled_handoff_recorded',
            updated_at: new Date(),
          },
        });
      }
      return {
        toStatus: 'approved',
        details: { controlled_item_count: controlled.length },
      };
    },
  });
}

function linkedClinicalOrderIds(items) {
  return [...new Set(items
    .map((item) => Number(item.clinical_order_id))
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
}

export async function issueWardIndent({
  indentId,
  issuedBy,
  itemQuantitiesIssued = null,
  expectedVersion = null,
  commandKey = null,
  tenantId,
}) {
  return applyTransition({
    indentId,
    tenantId,
    actorUid: issuedBy,
    expectedVersion,
    commandKey,
    action: 'issued',
    allowedStatuses: ['approved'],
    mutate: async (tx, current) => {
      const issuedMap = itemEntryMap(
        itemQuantitiesIssued,
        'quantity_issued',
        current.items,
      );
      const catalogIds = current.items.map((item) => Number(item.pharmacy_catalog_id));
      const controlByCatalog = await classifyCatalogControl(tx, current.tenant_id, catalogIds);
      const nonControlledCatalogIds = current.items
        .filter((item) => !controlByCatalog.get(Number(item.pharmacy_catalog_id))?.controlled)
        .map((item) => Number(item.pharmacy_catalog_id));
      await lockCatalogRows(tx, current.tenant_id, nonControlledCatalogIds);
      const inventoryItemByCatalog = await resolveLinkedInventoryItems(
        tx,
        current.tenant_id,
        nonControlledCatalogIds,
      );

      for (const item of current.items) {
        const approvedQuantity = Number(item.quantity_approved);
        const issuedQuantity = issuedMap.has(item.id)
          ? issuedMap.get(item.id)
          : approvedQuantity;
        if (issuedQuantity !== approvedQuantity) {
          throw AppError.conflict(
            `Item ${item.id} issue quantity must equal its approved quantity; record short supply before approval`,
            'WARD_INDENT_ISSUE_QUANTITY_MISMATCH',
          );
        }
        const controlled = controlByCatalog.get(Number(item.pharmacy_catalog_id))?.controlled === true;
        if (controlled) {
          if (!item.controlled_movement_id || !item.controlled_register_id) {
            throw AppError.conflict(
              `Controlled item ${item.id} has no witnessed handoff evidence`,
              'WARD_INDENT_CONTROLLED_HANDOFF_REQUIRED',
            );
          }
        } else {
          const rows = await tx.$queryRawUnsafe(
            `UPDATE pharmacy_catalog
                SET stock_quantity = stock_quantity - $1::numeric,
                    updated_at = NOW()
              WHERE id = $2::int
                AND tenant_id = $3::uuid
                AND COALESCE(stock_quantity, 0) >= $1::numeric
              RETURNING id, stock_quantity`,
            issuedQuantity,
            Number(item.pharmacy_catalog_id),
            current.tenant_id,
          );
          if (!rows[0]) {
            throw AppError.conflict(
              `Stock changed before item ${item.id} could be issued`,
              'WARD_INDENT_STOCK_CHANGED_BEFORE_ISSUE',
              { item_id: item.id },
            );
          }
          await appendWardMovementLedgerTx(tx, {
            tenantId: current.tenant_id,
            indentId: current.id,
            inventoryItemId: inventoryItemByCatalog.get(Number(item.pharmacy_catalog_id)),
            movementKind: 'issue',
            quantityDelta: -issuedQuantity,
            performedBy: issuedBy,
            note: `Ward indent ${current.indent_number || current.id} item ${item.id} issued to ${current.ward_name || 'ward'}`,
          });
        }
        await tx.ward_indent_items.update({
          where: { id: item.id },
          data: {
            quantity_issued: issuedQuantity,
            fulfilment_status: 'issued',
            updated_at: new Date(),
          },
        });
      }

      const clinicalOrderIds = linkedClinicalOrderIds(current.items);
      if (clinicalOrderIds.length) {
        await tx.clinical_orders.updateMany({
          where: {
            id: { in: clinicalOrderIds },
            tenant_id: current.tenant_id,
            order_type: 'medication',
            status: { in: ['ordered', 'verified', 'in_progress'] },
          },
          data: {
            status: 'verified',
            verified_by: issuedBy,
            verified_at: new Date(),
            updated_at: new Date(),
          },
        });
      }
      return {
        toStatus: 'issued',
        indentData: {
          issued_by: issuedBy,
          issued_at: new Date(),
        },
        details: { verified_clinical_order_ids: clinicalOrderIds },
      };
    },
  });
}

export async function receiveWardIndent({
  indentId,
  receivedBy,
  itemQuantitiesReceived = null,
  expectedVersion = null,
  commandKey = null,
  tenantId,
}) {
  return applyTransition({
    indentId,
    tenantId,
    actorUid: receivedBy,
    expectedVersion,
    commandKey,
    action: 'receipt_recorded',
    allowedStatuses: ['issued', 'partially_received'],
    mutate: async (tx, current) => {
      if (current.issued_by && String(current.issued_by) === String(receivedBy)) {
        throw AppError.conflict(
          'The issuing actor cannot also acknowledge ward receipt',
          'WARD_INDENT_RECEIPT_ACTOR_MUST_DIFFER',
        );
      }
      const receivedMap = itemEntryMap(
        itemQuantitiesReceived,
        'quantity_received',
        current.items,
        { allowZero: true },
      );
      const receiveAll = receivedMap.size === 0;
      let progressed = false;
      let fullyReceived = true;
      for (const item of current.items) {
        const issuedQuantity = Number(item.quantity_issued || 0);
        const currentReceived = Number(item.quantity_received || 0);
        const desired = receiveAll
          ? issuedQuantity
          : (receivedMap.has(item.id) ? receivedMap.get(item.id) : currentReceived);
        if (desired < currentReceived || desired > issuedQuantity) {
          throw AppError.badRequest(
            `Item ${item.id} cumulative received quantity must be between ${currentReceived} and ${issuedQuantity}`,
          );
        }
        if (desired > currentReceived) progressed = true;
        if (desired !== issuedQuantity) fullyReceived = false;
        await tx.ward_indent_items.update({
          where: { id: item.id },
          data: {
            quantity_received: desired,
            fulfilment_status: desired === issuedQuantity
              ? 'received'
              : 'partially_received',
            updated_at: new Date(),
          },
        });
      }
      if (!progressed) throw AppError.conflict('Receipt command made no quantity progress');
      return {
        toStatus: fullyReceived ? 'received' : 'partially_received',
        indentData: fullyReceived ? {
          received_by: receivedBy,
          received_at: new Date(),
        } : {},
        details: { fully_received: fullyReceived },
      };
    },
  });
}

export async function requestWardIndentReturn({
  indentId,
  requestedBy,
  itemQuantitiesReturned,
  reason,
  expectedVersion = null,
  commandKey = null,
  tenantId,
}) {
  const cleanReason = reasonText(reason, 'return reason');
  return applyTransition({
    indentId,
    tenantId,
    actorUid: requestedBy,
    expectedVersion,
    commandKey,
    reason: cleanReason,
    action: 'return_requested',
    allowedStatuses: ['partially_received', 'received'],
    mutate: async (tx, current) => {
      const returnMap = itemEntryMap(
        itemQuantitiesReturned,
        'quantity_returned',
        current.items,
        { required: true, allowZero: true },
      );
      let requestedCount = 0;
      for (const item of current.items) {
        const desired = returnMap.has(item.id)
          ? returnMap.get(item.id)
          : Number(item.quantity_return_requested || 0);
        const receivedQuantity = Number(item.quantity_received || 0);
        const returnedQuantity = Number(item.quantity_returned || 0);
        if (desired < returnedQuantity || desired > receivedQuantity) {
          throw AppError.badRequest(
            `Item ${item.id} return quantity must be between ${returnedQuantity} and ${receivedQuantity}`,
          );
        }
        if (desired > returnedQuantity) requestedCount += 1;
        await tx.ward_indent_items.update({
          where: { id: item.id },
          data: {
            quantity_return_requested: desired,
            fulfilment_status: desired > returnedQuantity
              ? 'return_pending'
              : item.fulfilment_status,
            updated_at: new Date(),
          },
        });
      }
      if (requestedCount === 0) throw AppError.badRequest('At least one return quantity must increase');
      return {
        toStatus: 'return_pending',
        indentData: {
          return_requested_by: requestedBy,
          return_requested_at: new Date(),
          reconciliation_reason: cleanReason,
        },
        details: { return_item_count: requestedCount },
      };
    },
  });
}

export async function reportWardIndentDiscrepancy({
  indentId,
  reportedBy,
  reason,
  expectedVersion = null,
  commandKey = null,
  tenantId,
}) {
  const cleanReason = reasonText(reason, 'reconciliation reason');
  return applyTransition({
    indentId,
    tenantId,
    actorUid: reportedBy,
    expectedVersion,
    commandKey,
    reason: cleanReason,
    action: 'reconciliation_required',
    allowedStatuses: ['issued', 'partially_received', 'received', 'return_pending'],
    mutate: async (tx, current) => {
      await tx.ward_indent_items.updateMany({
        where: { ward_indent_id: current.id, tenant_id: current.tenant_id },
        data: { fulfilment_status: 'reconciliation_required', updated_at: new Date() },
      });
      return {
        toStatus: 'reconciliation_required',
        indentData: { reconciliation_reason: cleanReason },
      };
    },
  });
}

export async function reconcileWardIndent({
  indentId,
  reconciledBy,
  reason,
  controlledReturnEvidence = null,
  itemReconciliations = null,
  expectedVersion = null,
  commandKey = null,
  tenantId,
}) {
  const cleanReason = reasonText(reason, 'reconciliation reason');
  return applyTransition({
    indentId,
    tenantId,
    actorUid: reconciledBy,
    expectedVersion,
    commandKey,
    reason: cleanReason,
    action: 'reconciled',
    allowedStatuses: ['return_pending', 'reconciliation_required'],
    mutate: async (tx, current) => {
      const evidenceByItem = new Map();
      for (const evidence of (Array.isArray(controlledReturnEvidence) ? controlledReturnEvidence : [])) {
        const itemId = positiveInt(evidence?.item_id, 'item_id');
        if (evidenceByItem.has(itemId)) throw AppError.badRequest(`Duplicate return evidence ${itemId}`);
        evidenceByItem.set(itemId, evidence);
      }
      const reconciliationByItem = new Map();
      for (const entry of (Array.isArray(itemReconciliations) ? itemReconciliations : [])) {
        const itemId = positiveInt(entry?.item_id, 'item_id');
        if (reconciliationByItem.has(itemId)) {
          throw AppError.badRequest(`Duplicate item reconciliation ${itemId}`);
        }
        const item = current.items.find((candidate) => Number(candidate.id) === itemId);
        if (!item) throw AppError.badRequest(`Ward indent item ${itemId} does not belong to this indent`);
        const disposition = String(entry?.disposition || '').trim().toLowerCase();
        if (!RECONCILIATION_DISPOSITIONS.has(disposition)) {
          throw AppError.badRequest(`Item ${itemId} has an invalid reconciliation disposition`);
        }
        reconciliationByItem.set(itemId, {
          quantity: quantity(
            entry?.quantity_variance_resolved,
            'quantity_variance_resolved',
          ),
          disposition,
          note: reasonText(entry?.note, 'reconciliation note'),
        });
      }
      const catalogIds = current.items
        .filter((item) => Number(item.quantity_return_requested) > Number(item.quantity_returned))
        .map((item) => Number(item.pharmacy_catalog_id));
      const controlByCatalog = catalogIds.length
        ? await classifyCatalogControl(tx, current.tenant_id, catalogIds)
        : new Map();
      const controlledReturnItemIds = new Set(current.items
        .filter((item) => (
          Number(item.quantity_return_requested) > Number(item.quantity_returned)
          && controlByCatalog.get(Number(item.pharmacy_catalog_id))?.controlled === true
        ))
        .map((item) => Number(item.id)));
      for (const itemId of evidenceByItem.keys()) {
        if (!controlledReturnItemIds.has(itemId)) {
          throw AppError.badRequest(`Return evidence ${itemId} is not required for this indent`);
        }
      }
      const returnCatalogIds = current.items
        .filter((item) => (
          Number(item.quantity_return_requested) > Number(item.quantity_returned)
          && !controlByCatalog.get(Number(item.pharmacy_catalog_id))?.controlled
        ))
        .map((item) => Number(item.pharmacy_catalog_id));
      await lockCatalogRows(tx, current.tenant_id, returnCatalogIds);
      const returnInventoryItemByCatalog = await resolveLinkedInventoryItems(
        tx,
        current.tenant_id,
        returnCatalogIds,
      );
      let returnedItemCount = 0;
      let varianceItemCount = 0;
      const controlledReturnReferences = [];
      for (const item of current.items) {
        const issued = Number(item.quantity_issued || 0);
        const received = Number(item.quantity_received || 0);
        const existingVariance = Number(item.quantity_variance_resolved || 0);
        const unresolvedVariance = Math.round(
          (issued - received - existingVariance) * 100,
        ) / 100;
        const reconciliation = reconciliationByItem.get(Number(item.id));
        if (unresolvedVariance > 0) {
          if (!reconciliation || reconciliation.quantity !== unresolvedVariance) {
            throw AppError.conflict(
              `Item ${item.id} requires an exact reconciliation for ${unresolvedVariance} unreceived units`,
              'WARD_INDENT_VARIANCE_RECONCILIATION_REQUIRED',
              { item_id: item.id, unresolved_quantity: unresolvedVariance },
            );
          }
          await tx.ward_indent_items.update({
            where: { id: item.id },
            data: {
              quantity_variance_resolved: existingVariance + reconciliation.quantity,
              reconciliation_disposition: reconciliation.disposition,
              reconciliation_note: reconciliation.note,
              updated_at: new Date(),
            },
          });
          varianceItemCount += 1;
        } else if (reconciliation) {
          throw AppError.badRequest(`Item ${item.id} has no unresolved receipt variance`);
        }
        const requested = Number(item.quantity_return_requested || 0);
        const alreadyReturned = Number(item.quantity_returned || 0);
        const outstanding = requested - alreadyReturned;
        if (outstanding <= 0) continue;
        const controlled = controlByCatalog.get(Number(item.pharmacy_catalog_id))?.controlled === true;
        let controlledReturn = null;
        if (controlled) {
          const evidence = evidenceByItem.get(Number(item.id));
          if (!evidence) throw AppError.badRequest(`Controlled return evidence is required for item ${item.id}`);
          controlledReturn = await validateControlledEvidence(tx, {
            tenantId: current.tenant_id,
            indent: current,
            item,
            evidence,
            movementKind: 'return',
            registerKind: 'return',
            expectedReference: `ward-indent-return:${current.id}:item:${item.id}`,
            expectedQuantity: outstanding,
          });
          controlledReturnReferences.push({
            item_id: Number(item.id),
            movement_id: controlledReturn.movementId,
            register_id: controlledReturn.registerId,
          });
        } else {
          const rows = await tx.$queryRawUnsafe(
            `UPDATE pharmacy_catalog
                SET stock_quantity = COALESCE(stock_quantity, 0) + $1::numeric,
                    updated_at = NOW()
              WHERE id = $2::int
                AND tenant_id = $3::uuid
              RETURNING id, stock_quantity`,
            outstanding,
            Number(item.pharmacy_catalog_id),
            current.tenant_id,
          );
          if (!rows[0]) throw AppError.notFound(`Catalog item ${item.pharmacy_catalog_id} not found`);
          await appendWardMovementLedgerTx(tx, {
            tenantId: current.tenant_id,
            indentId: current.id,
            inventoryItemId: returnInventoryItemByCatalog.get(Number(item.pharmacy_catalog_id)),
            movementKind: 'return',
            quantityDelta: outstanding,
            performedBy: reconciledBy,
            note: `Ward indent ${current.indent_number || current.id} item ${item.id} returned from ${current.ward_name || 'ward'}`,
          });
        }
        await tx.ward_indent_items.update({
          where: { id: item.id },
          data: {
            quantity_returned: requested,
            ...(controlledReturn ? {
              controlled_return_movement_id: controlledReturn.movementId,
              controlled_return_register_id: controlledReturn.registerId,
            } : {}),
            fulfilment_status: 'reconciled',
            updated_at: new Date(),
          },
        });
        returnedItemCount += 1;
      }
      await tx.ward_indent_items.updateMany({
        where: { ward_indent_id: current.id, tenant_id: current.tenant_id },
        data: { fulfilment_status: 'reconciled', updated_at: new Date() },
      });

      // Post-issue billing truth (Sol-verification finding N2): the itemizer
      // only re-synchronizes ward-indent charges while the admission invoice
      // is still DRAFT — a return reconciled after the invoice was ISSUED
      // leaves the patient charged for stock that came back, with nothing
      // flagging it. Issued invoices are immutable here (billingV2 refuses
      // post-issue line edits), so the delta is surfaced as an owned
      // high-priority billing review task in the same transaction instead of
      // being silently absorbed.
      const billingAdjustments = [];
      if (returnedItemCount > 0) {
        const billedLines = await tx.$queryRawUnsafe(
          `SELECT bii.id AS line_id, bii.line_total, bi.id AS invoice_id, bi.status
             FROM billing_invoice_items bii
             JOIN billing_invoices bi
               ON bi.id = bii.invoice_id
              AND bi.tenant_id = bii.tenant_id
            WHERE bii.tenant_id = $1::uuid
              AND bii.source_ref_type = 'ward_indent'
              AND bii.source_ref_id::text = $2::text
              AND bii.source_ref_active = TRUE`,
          current.tenant_id,
          String(current.id),
        );
        const staleBilledLines = billedLines.filter((line) => line.status !== 'DRAFT');
        if (staleBilledLines.length) {
          const expectedRows = await tx.$queryRawUnsafe(
            `SELECT COALESCE(SUM(
                      GREATEST(
                        COALESCE(wii.quantity_issued, wii.quantity_requested, 0)
                          - COALESCE(wii.quantity_returned, 0),
                        0
                      )
                      * COALESCE(wii.unit_price, pc.unit_price, pc.price, 0)
                    ), 0)::numeric AS expected_amount
               FROM ward_indent_items wii
               LEFT JOIN pharmacy_catalog pc
                 ON pc.tenant_id = wii.tenant_id
                AND pc.id = wii.pharmacy_catalog_id
              WHERE wii.tenant_id = $1::uuid
                AND wii.ward_indent_id = $2::int`,
            current.tenant_id,
            current.id,
          );
          const expectedAmount = Number(expectedRows[0]?.expected_amount || 0);
          for (const line of staleBilledLines) {
            const billedAmount = Number(line.line_total || 0);
            const overcharge = Math.round((billedAmount - expectedAmount) * 100) / 100;
            if (overcharge <= 0) continue;
            await createTask({
              tenantId: current.tenant_id,
              taskKind: 'review',
              title: `Ward indent ${current.indent_number || current.id}: post-issue return needs a billing credit`,
              description: `Invoice ${line.invoice_id} (${line.status}) charges ${billedAmount.toFixed(2)} for ward indent ${current.indent_number || current.id}, but reconciled returns reduce the net charge to ${expectedAmount.toFixed(2)}. Raise the ${overcharge.toFixed(2)} credit/refund for the patient — the issued invoice cannot be edited in place.`,
              patientUid: current.patient_uid || null,
              relatedResourceType: 'ward_indent_billing_adjustment',
              relatedResourceId: String(current.id),
              priority: 'high',
              assignedToRole: ROLES.BILLING_INCHARGE,
              createdBy: reconciledBy,
              metadata: {
                ward_indent_id: Number(current.id),
                invoice_id: Number(line.invoice_id),
                invoice_status: line.status,
                billing_line_id: Number(line.line_id),
                billed_amount: billedAmount,
                expected_amount: expectedAmount,
                overcharge_amount: overcharge,
              },
              tx,
              onConflictResourceDoNothing: true,
            });
            billingAdjustments.push({
              invoice_id: Number(line.invoice_id),
              invoice_status: line.status,
              billed_amount: billedAmount,
              expected_amount: expectedAmount,
              overcharge_amount: overcharge,
            });
          }
        }
      }

      return {
        toStatus: 'reconciled',
        indentData: {
          reconciliation_reason: cleanReason,
          reconciled_by: reconciledBy,
          reconciled_at: new Date(),
        },
        details: {
          returned_item_count: returnedItemCount,
          variance_item_count: varianceItemCount,
          controlled_return_references: controlledReturnReferences,
          billing_adjustments_flagged: billingAdjustments,
        },
      };
    },
  });
}

export async function cancelWardIndent({
  indentId,
  cancelledBy,
  reason,
  expectedVersion = null,
  commandKey = null,
  tenantId,
}) {
  const cleanReason = reasonText(reason, 'cancellation reason');
  return applyTransition({
    indentId,
    tenantId,
    actorUid: cancelledBy,
    expectedVersion,
    commandKey,
    reason: cleanReason,
    action: 'cancelled',
    allowedStatuses: [
      'requested',
      'reserved',
      'short_supply',
      'substitution_pending',
      'controlled_handoff_required',
      'approved',
    ],
    mutate: async (tx, current) => {
      if (current.items.some((item) => (
        item.controlled_movement_id || Number(item.quantity_issued || 0) > 0
      ))) {
        throw AppError.conflict(
          'Dispensed stock cannot be cancelled; return and reconcile it',
          'WARD_INDENT_CANCELLATION_REQUIRES_RECONCILIATION',
        );
      }
      await tx.ward_indent_items.updateMany({
        where: { ward_indent_id: current.id, tenant_id: current.tenant_id },
        data: {
          quantity_reserved: 0,
          quantity_approved: 0,
          fulfilment_status: 'cancelled',
          updated_at: new Date(),
        },
      });
      return {
        toStatus: 'cancelled',
        indentData: {
          cancelled_by: cancelledBy,
          cancelled_at: new Date(),
          cancellation_reason: cleanReason,
        },
      };
    },
  });
}

export async function closeWardIndent({
  indentId,
  closedBy,
  reason,
  expectedVersion = null,
  commandKey = null,
  tenantId,
}) {
  const cleanReason = reasonText(reason, 'closure reason');
  return applyTransition({
    indentId,
    tenantId,
    actorUid: closedBy,
    expectedVersion,
    commandKey,
    reason: cleanReason,
    action: 'closed',
    allowedStatuses: ['received', 'reconciled'],
    mutate: async (tx, current) => {
      if (current.status === 'received' && current.items.some(
        (item) => Number(item.quantity_received) !== Number(item.quantity_issued || 0),
      )) {
        throw AppError.conflict(
          'Ward indent cannot close until every issued quantity is received',
          'WARD_INDENT_RECEIPT_INCOMPLETE',
        );
      }
      if (current.status === 'reconciled' && current.items.some(
        (item) => Number(item.quantity_returned) !== Number(item.quantity_return_requested),
      )) {
        throw AppError.conflict(
          'Ward indent cannot close until every requested return is reconciled',
          'WARD_INDENT_RETURN_RECONCILIATION_INCOMPLETE',
        );
      }
      if (current.items.some((item) => (
        Number(item.quantity_received)
          + Number(item.quantity_variance_resolved || 0)
        !== Number(item.quantity_issued || 0)
      ))) {
        throw AppError.conflict(
          'Ward indent cannot close until every issued quantity is accounted for',
          'WARD_INDENT_ISSUE_RECONCILIATION_INCOMPLETE',
        );
      }
      const hasReturns = current.items.some((item) => Number(item.quantity_returned || 0) > 0);
      const hasVariance = current.items.some(
        (item) => Number(item.quantity_variance_resolved || 0) > 0,
      );
      await tx.ward_indent_items.updateMany({
        where: { ward_indent_id: current.id, tenant_id: current.tenant_id },
        data: { fulfilment_status: 'closed', updated_at: new Date() },
      });
      return {
        toStatus: 'closed',
        indentData: {
          closed_by: closedBy,
          closed_at: new Date(),
          closure_outcome: current.status === 'received'
            ? 'fulfilled'
            : hasVariance
              ? 'variance_reconciled'
              : hasReturns
                ? 'returned_reconciled'
                : 'reconciliation_completed',
          closure_reason: cleanReason,
        },
      };
    },
  });
}

export async function listWardIndents({
  wardId = null,
  status = null,
  admissionId = null,
  patientUid = null,
  overdueOnly = false,
  limit = 50,
  tenantId,
} = {}) {
  const tid = tenantOf(tenantId);
  const cleanPatientUid = patientUid ? uuid(patientUid, 'patient_uid') : null;
  if (status && !WARD_INDENT_STATE_CONTRACT[status]) {
    throw AppError.badRequest(`Unknown ward indent status '${status}'`);
  }
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.ward_indents.findMany({
      where: {
        tenant_id: tid,
        ...(wardId ? { ward_id: Number(wardId) } : {}),
        ...(status ? { status } : {}),
        ...(admissionId ? { admission_id: Number(admissionId) } : {}),
        ...(cleanPatientUid ? { patient_uid: cleanPatientUid } : {}),
        ...(overdueOnly && !status ? {
          status: { notIn: ['rejected', 'cancelled', 'closed'] },
        } : {}),
      },
      orderBy: { requested_at: 'desc' },
      take: safeLimit,
      include: { items: { orderBy: { id: 'asc' } } },
    });
    if (!rows.length) return [];
    const sourceIds = rows
      .map((row) => row.active_sla_source_id)
      .filter(Boolean);
    const slas = await tx.workflow_sla_instances.findMany({
      where: {
        tenant_id: tid,
        source_table: 'ward_indents',
        source_id: { in: sourceIds },
        status: { in: overdueOnly ? ['breached', 'escalated'] : ['active', 'breached', 'escalated'] },
        completed_at: null,
      },
      orderBy: { started_at: 'desc' },
    });
    const slaByIndent = new Map();
    for (const sla of slas) {
      if (!slaByIndent.has(sla.source_id)) slaByIndent.set(sla.source_id, []);
      slaByIndent.get(sla.source_id).push(sla);
    }
    const enriched = rows.map((row) => ({
      ...row,
      workflow: {
        owner_role_codes: row.owner_role_codes || [],
        active_slas: slaByIndent.get(row.active_sla_source_id) || [],
      },
    }));
    return overdueOnly
      ? enriched.filter((row) => row.workflow.active_slas.length > 0)
      : enriched;
  }, { readOnly: true });
}

export async function getWardIndent(indentId, { tenantId, eventLimit = 100 } = {}) {
  const tid = tenantOf(tenantId);
  return setTenantTx(
    tid,
    (tx) => loadWardIndentWorkflow(tx, positiveInt(indentId, 'indentId'), tid, { eventLimit }),
    { readOnly: true },
  );
}

export default {
  WARD_INDENT_STATE_CONTRACT,
  wardIndentCommandKey,
  findWardIndentCreateReplayTx,
  initializeWardIndentWorkflowTx,
  reserveWardIndent,
  markWardIndentShortSupply,
  proposeWardIndentSubstitution,
  approveWardIndentSubstitution,
  rejectWardIndentSubstitution,
  approveWardIndent,
  rejectWardIndent,
  recordWardIndentControlledHandoff,
  issueWardIndent,
  receiveWardIndent,
  requestWardIndentReturn,
  reportWardIndentDiscrepancy,
  reconcileWardIndent,
  cancelWardIndent,
  closeWardIndent,
  listWardIndents,
  getWardIndent,
};
