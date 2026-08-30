import { createHash } from 'node:crypto';
import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { DOCTOR_TIERS, ROLES } from '../../utils/roleHelpers.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { assertPharmacyFacilityGrant } from '../pharmacy/pharmacyFacilityAuthorityService.js';
import {
  dispenseWardControlledAllocationTx,
  wardControlledHandoffWitnessPayload,
  WARD_CONTROLLED_HANDOFF_AUTHORITY,
} from '../pharmacy/inventoryV2Service.js';
import {
  approveControlledDispenseWitnessApproval,
  CONTROLLED_DISPENSE_WITNESS_ROLES,
  CONTROLLED_DISPENSE_APPROVAL_SCOPES,
  createControlledDispenseWitnessApproval,
} from '../pharmacy/controlledDispenseWitnessService.js';
import { pharmacyCommandRequestSha256 } from '../pharmacy/pharmacyOrderCommandReceiptService.js';
import {
  cancelWorkflowSla,
  completeWorkflowSla,
  recordCanonicalClinicalEvent,
  startWorkflowSla,
} from '../clinical/canonicalClinicalPlatformService.js';
import {
  appendWardIndentChargeEventsTx,
  appendWardIndentCreditEventsTx,
  assertNoOpenWardAllocationAuthorityRecoveryTx,
  issueWardIndentInventoryTx,
  linkControlledWardIndentMovementTx,
  loadWardIndentMedicationClosureTx,
  receiveWardIndentInventoryTx,
  releaseWardIndentReservationsTx,
  releaseUnissuedWardIndentReservationsTx,
  reserveWardIndentInventoryTx,
  returnWardIndentInventoryTx,
} from './wardIndentMedicationClosureService.js';
import {
  completeWardIndentStateObligationTx,
  materializeWardIndentStateObligationTx,
  reconcileWardIndentNotificationCoverageTx,
} from './wardIndentObligationService.js';
import { assertMedicationOrdersExecutionReadyTx } from '../clinical/marSupplyService.js';
import {
  canonicalMedicationRoute,
  comparableMedicationRoute
} from '../clinical/medicationRoute.js';

const PHARMACY_OWNERS = [
  ROLES.PHARMACY_STAFF,
  ROLES.PHARMACY_INCHARGE,
  'PHARMACIST',
];
const CONTROLLED_HANDOFF_OWNERS = [
  ROLES.PHARMACY_STAFF,
  ROLES.PHARMACY_INCHARGE,
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
    ownerRoles: CONTROLLED_HANDOFF_OWNERS,
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

const RECONCILIATION_DISPOSITIONS = new Set([
  'transit_shortage',
  'ward_count_variance',
  'damaged_in_transit',
  'documented_exception',
]);
const TERMINAL_WARD_INDENT_STATUSES = ['rejected', 'cancelled', 'closed'];
const WARD_INDENT_WORKLISTS = new Set(['open', 'terminal', 'owned', 'overdue']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const PG_INT4_MAX = 2147483647;
const WARD_CONTROLLED_RECOVERY_CONTRACT = 'ward_controlled_handoff_recovery_v1';
const WARD_CONTROLLED_RECOVERY_ROLE = ROLES.PHARMACY_INCHARGE;
const WARD_CONTROLLED_RECOVERY_REASON_MAX_LENGTH = 2000;
const ACTIVE_WARD_ALLOCATION_STATUSES = new Set(['reserved', 'partially_issued']);

function tenantOf(value) {
  return requireTenantId(value);
}

function positiveInt(value, fieldName) {
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value > 0 && value <= PG_INT4_MAX) return value;
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  const text = String(value ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed > PG_INT4_MAX) {
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
    `SELECT indent.id, indent.tenant_id, indent.indent_number, indent.status,
            indent.state_version, indent.patient_uid, indent.encounter_id,
            indent.admission_id, indent.ward_id, indent.ward_name,
            indent.indent_type, indent.requested_by, indent.approved_by,
            indent.issued_by, indent.received_by, indent.owner_role_codes,
            indent.facility_id
       FROM ward_indents indent
      WHERE indent.id = $1::int
        AND indent.tenant_id = $2::uuid
      FOR UPDATE OF indent`,
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
  indent.facility_id = rows[0].facility_id == null ? null : Number(rows[0].facility_id);
  return indent;
}

async function loadPendingControlledHandoffEvidence(tx, indent) {
  if (indent.status !== 'controlled_handoff_required') return [];

  const controlled = indent.items.filter((item) => item.controlled_reference_id);
  if (!controlled.length) return [];
  const withPendingPrelinkCorruption = (item, classification) => {
    if (item.controlled_movement_id == null && item.controlled_register_id == null) {
      return classification;
    }
    const issue = 'WARD_ITEM_PRELINKED_IN_PENDING_STATE';
    const linkedIdentity = {
      controlled_movement_id: item.controlled_movement_id == null
        ? null
        : Number(item.controlled_movement_id),
      controlled_register_id: item.controlled_register_id == null
        ? null
        : Number(item.controlled_register_id),
    };
    const evidence = classification.evidence?.length
      ? classification.evidence.map((candidate) => ({
        ...candidate,
        ...linkedIdentity,
        issues: [...new Set([...(candidate.issues || []), issue])].sort(),
      }))
      : [{ ...linkedIdentity, issues: [issue] }];
    return {
      ...classification,
      ...linkedIdentity,
      status: 'corrupt',
      evidence,
      issues: [...new Set([...(classification.issues || []), issue])].sort(),
    };
  };
  const pending = controlled;

  const references = pending.map((item) => item.controlled_reference_id);
  const referenceCounts = new Map();
  for (const item of controlled) {
    const reference = item.controlled_reference_id;
    referenceCounts.set(reference, Number(referenceCounts.get(reference) || 0) + 1);
  }
  const movements = await tx.$queryRawUnsafe(
    `SELECT movement.reference_id, movement.id AS movement_id,
            movement.inventory_item_id, movement.inventory_batch_id,
            movement.movement_kind, movement.quantity_delta,
            movement.reference_type, movement.performed_by,
            inventory.catalog_id, inventory.facility_id AS inventory_facility_id,
            inventory.schedule_class, inventory.is_narcotic,
            UPPER(performer.role) AS performer_role,
            (
              performer.uid IS NOT NULL
              AND performer.is_active = TRUE
              AND performer.status = 'active'
              AND COALESCE(performer.is_deleted, FALSE) = FALSE
              AND performer_staff.id IS NOT NULL
              AND performer_staff.is_active = TRUE
              AND COALESCE(performer_staff.archived, FALSE) = FALSE
              AND performer_staff.archived_at IS NULL
              AND NULLIF(BTRIM(performer_staff.name), '') IS NOT NULL
            ) AS performer_active
       FROM pharmacy_stock_movements movement
       LEFT JOIN pharmacy_inventory_items inventory
         ON inventory.tenant_id = movement.tenant_id
        AND inventory.id = movement.inventory_item_id
       LEFT JOIN users performer
         ON performer.tenant_id = movement.tenant_id
        AND performer.uid = movement.performed_by
       LEFT JOIN staff performer_staff
         ON performer_staff.tenant_id = performer.tenant_id
        AND performer_staff.user_id = performer.uid
      WHERE movement.tenant_id = $1::uuid
        AND movement.reference_id = ANY($2::text[])
      ORDER BY movement.id`,
    indent.tenant_id,
    references,
  );

  if (!movements.length) {
    return pending.map((item) => {
      if (Number(referenceCounts.get(item.controlled_reference_id)) > 1) {
        return withPendingPrelinkCorruption(item, {
          item_id: Number(item.id),
          reference_id: item.controlled_reference_id,
          status: 'corrupt',
          candidate_count: 0,
          same_reference_movement_count: 0,
          evidence: [],
          issues: ['WARD_ITEM_REFERENCE_COLLISION'],
        });
      }
      return withPendingPrelinkCorruption(item, {
        item_id: Number(item.id),
        reference_id: item.controlled_reference_id,
        status: 'missing',
        candidate_count: 0,
        same_reference_movement_count: 0,
      });
    });
  }

  const movementIds = movements.map((row) => Number(row.movement_id));
  const registers = await tx.$queryRawUnsafe(
    `SELECT register_entry.id AS register_id,
            register_entry.reference_movement_id AS movement_id,
            register_entry.facility_id, register_entry.inventory_item_id,
            register_entry.inventory_batch_id,
            register_entry.schedule_class, register_entry.movement_kind,
            register_entry.quantity, register_entry.patient_uid,
            register_entry.performed_by, register_entry.witness_uid,
            register_entry.witness_name, UPPER(witness.role) AS witness_role,
            (
              witness.uid IS NOT NULL
              AND witness.is_active = TRUE
              AND witness.status = 'active'
              AND COALESCE(witness.is_deleted, FALSE) = FALSE
              AND witness_staff.id IS NOT NULL
              AND witness_staff.is_active = TRUE
              AND COALESCE(witness_staff.archived, FALSE) = FALSE
            ) AS witness_active
       FROM pharmacy_schedule_register register_entry
       LEFT JOIN users witness
         ON witness.tenant_id = register_entry.tenant_id
        AND witness.uid = register_entry.witness_uid
       LEFT JOIN staff witness_staff
         ON witness_staff.tenant_id = witness.tenant_id
        AND witness_staff.user_id = witness.uid
      WHERE register_entry.tenant_id = $1::uuid
        AND register_entry.reference_movement_id = ANY($2::int[])
      ORDER BY register_entry.reference_movement_id, register_entry.id`,
    indent.tenant_id,
    movementIds,
  );
  const registerIds = registers.map((row) => Number(row.register_id));
  const claims = await tx.$queryRawUnsafe(
    `SELECT claimed.id AS ward_indent_item_id, claimed.ward_indent_id,
            claimed.controlled_movement_id, claimed.controlled_register_id,
            claimed.controlled_return_movement_id, claimed.controlled_return_register_id
       FROM ward_indent_items claimed
      WHERE claimed.tenant_id = $1::uuid
        AND (
          claimed.controlled_movement_id = ANY($2::int[])
          OR claimed.controlled_return_movement_id = ANY($2::int[])
          OR ($3::int[] <> '{}'::int[] AND claimed.controlled_register_id = ANY($3::int[]))
          OR ($3::int[] <> '{}'::int[] AND claimed.controlled_return_register_id = ANY($3::int[]))
        )
      ORDER BY claimed.id`,
    indent.tenant_id,
    movementIds,
    registerIds,
  );
  const links = await tx.$queryRawUnsafe(
    `SELECT movement_link.id::text AS movement_link_id,
            movement_link.ward_indent_id, movement_link.allocation_id::text AS allocation_id,
            movement_link.stock_movement_id, movement_link.controlled_register_id,
            movement_link.movement_purpose
       FROM ward_indent_inventory_movement_links movement_link
      WHERE movement_link.tenant_id = $1::uuid
        AND (
          movement_link.stock_movement_id = ANY($2::int[])
          OR ($3::int[] <> '{}'::int[] AND movement_link.controlled_register_id = ANY($3::int[]))
        )
      ORDER BY movement_link.id`,
    indent.tenant_id,
    movementIds,
    registerIds,
  );
  const allocations = await tx.$queryRawUnsafe(
    `SELECT allocation.id::text AS allocation_id,
            allocation.ward_indent_item_id, allocation.inventory_item_id,
            allocation.inventory_batch_id, allocation.reserved_quantity,
            allocation.issued_quantity, allocation.authority_released_quantity,
            allocation.status
       FROM ward_indent_inventory_allocations allocation
      WHERE allocation.tenant_id = $1::uuid
        AND allocation.ward_indent_id = $2::int
        AND allocation.ward_indent_item_id = ANY($3::int[])
      ORDER BY allocation.ward_indent_item_id, allocation.id`,
    indent.tenant_id,
    Number(indent.id),
    pending.map((item) => Number(item.id)),
  );

  const registersByMovement = new Map();
  for (const register of registers) {
    const movementId = Number(register.movement_id);
    if (!registersByMovement.has(movementId)) registersByMovement.set(movementId, []);
    registersByMovement.get(movementId).push(register);
  }
  const classifiedEvidence = pending.map((item) => {
    const approvedQuantity = Number(item.quantity_approved || 0);
    const sameReference = movements.filter(
      (row) => row.reference_id === item.controlled_reference_id,
    );
    if (!sameReference.length) {
      return {
        item_id: Number(item.id),
        reference_id: item.controlled_reference_id,
        status: Number(referenceCounts.get(item.controlled_reference_id)) > 1
          ? 'corrupt'
          : 'missing',
        candidate_count: 0,
        same_reference_movement_count: 0,
        ...(Number(referenceCounts.get(item.controlled_reference_id)) > 1
          ? { evidence: [], issues: ['WARD_ITEM_REFERENCE_COLLISION'] }
          : {}),
      };
    }

    const evidence = sameReference.map((movement) => {
      const movementId = Number(movement.movement_id);
      const movementRegisters = registersByMovement.get(movementId) || [];
      const register = movementRegisters.length === 1 ? movementRegisters[0] : null;
      const movementRegisterIds = movementRegisters.map((row) => Number(row.register_id));
      const movementClaims = claims.filter((claim) => (
        Number(claim.controlled_movement_id) === movementId
        || Number(claim.controlled_return_movement_id) === movementId
        || movementRegisterIds.includes(Number(claim.controlled_register_id))
        || movementRegisterIds.includes(Number(claim.controlled_return_register_id))
      ));
      const movementLinks = links.filter((link) => (
        Number(link.stock_movement_id) === movementId
        || movementRegisterIds.includes(Number(link.controlled_register_id))
      ));
      const exactAllocations = allocations.filter((allocation) => {
        const outstanding = Number(allocation.reserved_quantity)
          - Number(allocation.issued_quantity || 0)
          - Number(allocation.authority_released_quantity || 0);
        return Number(allocation.ward_indent_item_id) === Number(item.id)
          && Number(allocation.inventory_item_id) === Number(movement.inventory_item_id)
          && Number(allocation.inventory_batch_id) === Number(movement.inventory_batch_id)
          && ACTIVE_WARD_ALLOCATION_STATUSES.has(String(allocation.status))
          && outstanding > 0
          && Math.abs(outstanding - approvedQuantity) < 1e-9;
      });
      const issues = new Set();
      if (movement.reference_type !== 'controlled_dispense') {
        issues.add('MOVEMENT_REFERENCE_TYPE_MISMATCH');
      }
      if (movement.movement_kind !== 'issue' || Number(movement.quantity_delta) >= 0) {
        issues.add('MOVEMENT_KIND_MISMATCH');
      }
      if (Number(movement.quantity_delta) !== -Math.abs(approvedQuantity)) {
        issues.add('MOVEMENT_QUANTITY_MISMATCH');
      }
      if (movement.catalog_id == null || item.pharmacy_catalog_id == null
        || Number(movement.catalog_id) !== Number(item.pharmacy_catalog_id)) {
        issues.add('MOVEMENT_CATALOG_MISMATCH');
      }
      if (movement.inventory_facility_id == null
        || Number(movement.inventory_facility_id) !== Number(indent.facility_id)) {
        issues.add('MOVEMENT_FACILITY_MISMATCH');
      }
      if (movement.inventory_batch_id == null || exactAllocations.length !== 1) {
        issues.add('MOVEMENT_ALLOCATION_LINEAGE_MISMATCH');
      }
      if (!movement.performed_by) {
        issues.add('MOVEMENT_PERFORMER_MISSING');
      } else if (movement.performer_active !== true
        || !['PHARMACY_STAFF', 'PHARMACY_INCHARGE'].includes(movement.performer_role)) {
        issues.add('MOVEMENT_PERFORMER_AUTHORITY_MISMATCH');
      }
      if (!['H', 'H1', 'X'].includes(movement.schedule_class)
        && movement.is_narcotic !== true) {
        issues.add('MOVEMENT_CONTROLLED_CLASSIFICATION_MISMATCH');
      }
      if (movementRegisters.length !== 1) issues.add('REGISTER_CARDINALITY_MISMATCH');
      if (register) {
        if (register.facility_id == null
          || Number(register.facility_id) !== Number(indent.facility_id)) {
          issues.add('REGISTER_FACILITY_MISMATCH');
        }
        if (Number(register.inventory_item_id) !== Number(movement.inventory_item_id)
          || Number(register.inventory_batch_id) !== Number(movement.inventory_batch_id)) {
          issues.add('REGISTER_BATCH_LINEAGE_MISMATCH');
        }
        if (register.movement_kind !== 'dispense') issues.add('REGISTER_KIND_MISMATCH');
        if (Number(register.quantity) !== Math.abs(approvedQuantity)) {
          issues.add('REGISTER_QUANTITY_MISMATCH');
        }
        if (String(register.patient_uid || '') !== String(indent.patient_uid || '')) {
          issues.add('REGISTER_PATIENT_MISMATCH');
        }
        if (String(register.performed_by || '') !== String(movement.performed_by || '')) {
          issues.add('REGISTER_PERFORMER_MISMATCH');
        }
        const expectedSchedule = movement.schedule_class
          || (movement.is_narcotic === true ? 'X' : 'H1');
        if (String(register.schedule_class || '') !== String(expectedSchedule || '')) {
          issues.add('REGISTER_SCHEDULE_MISMATCH');
        }
        const needsWitness = movement.schedule_class === 'X' || movement.is_narcotic === true;
        if (needsWitness && (
          !register.witness_uid
          || !String(register.witness_name || '').trim()
          || String(register.witness_uid) === String(register.performed_by)
          || register.witness_active !== true
          || !CONTROLLED_DISPENSE_WITNESS_ROLES.includes(register.witness_role)
        )) {
          issues.add('REGISTER_WITNESS_MISMATCH');
        }
      }
      if (movementClaims.length) issues.add('EVIDENCE_ALREADY_CLAIMED');
      if (movementLinks.length) issues.add('EVIDENCE_MOVEMENT_LINK_COLLISION');
      if (sameReference.length > 1) issues.add('SAME_REFERENCE_MOVEMENT_COLLISION');
      if (Number(referenceCounts.get(item.controlled_reference_id)) > 1) {
        issues.add('WARD_ITEM_REFERENCE_COLLISION');
      }
      return {
        movement_id: movementId,
        register_ids: movementRegisterIds,
        inventory_item_id: Number(movement.inventory_item_id),
        inventory_batch_id: movement.inventory_batch_id == null
          ? null
          : Number(movement.inventory_batch_id),
        catalog_id: movement.catalog_id == null ? null : Number(movement.catalog_id),
        facility_id: movement.inventory_facility_id == null
          ? null
          : Number(movement.inventory_facility_id),
        reference_type: movement.reference_type,
        reference_id: movement.reference_id,
        movement_kind: movement.movement_kind,
        quantity_delta: Number(movement.quantity_delta),
        performed_by: movement.performed_by || null,
        performer_role: movement.performer_role || null,
        performer_active: movement.performer_active === true,
        schedule_class: movement.schedule_class || null,
        is_narcotic: movement.is_narcotic === true,
        allocation_ids: exactAllocations.map((allocation) => allocation.allocation_id),
        claimed_ward_indent_items: movementClaims.map((claim) => ({
          ward_indent_id: Number(claim.ward_indent_id),
          ward_indent_item_id: Number(claim.ward_indent_item_id),
        })),
        movement_links: movementLinks.map((link) => ({
          movement_link_id: link.movement_link_id,
          ward_indent_id: Number(link.ward_indent_id),
          allocation_id: link.allocation_id,
          controlled_register_id: link.controlled_register_id == null
            ? null
            : Number(link.controlled_register_id),
          movement_purpose: link.movement_purpose,
        })),
        registers: movementRegisters.map((row) => ({
          register_id: Number(row.register_id),
          facility_id: row.facility_id == null ? null : Number(row.facility_id),
          inventory_item_id: Number(row.inventory_item_id),
          inventory_batch_id: row.inventory_batch_id == null
            ? null
            : Number(row.inventory_batch_id),
          schedule_class: row.schedule_class,
          movement_kind: row.movement_kind,
          quantity: Number(row.quantity),
          patient_uid: row.patient_uid || null,
          performed_by: row.performed_by || null,
          witness_uid: row.witness_uid || null,
          witness_name: row.witness_name || null,
          witness_role: row.witness_role || null,
          witness_active: row.witness_active === true,
        })),
        issues: [...issues].sort(),
      };
    });
    const collisionIssues = new Set([
      'SAME_REFERENCE_MOVEMENT_COLLISION',
      'WARD_ITEM_REFERENCE_COLLISION',
    ]);
    const individuallyValid = evidence.filter((candidate) => (
      candidate.issues.every((issue) => collisionIssues.has(issue))
    ));
    const valid = evidence.filter((candidate) => candidate.issues.length === 0);
    if (sameReference.length !== 1 || valid.length !== 1) {
      return {
        item_id: Number(item.id),
        reference_id: item.controlled_reference_id,
        status: 'corrupt',
        candidate_count: individuallyValid.length,
        same_reference_movement_count: sameReference.length,
        evidence,
      };
    }
    const selected = valid[0];
    return {
      item_id: Number(item.id),
      reference_id: item.controlled_reference_id,
      status: 'available',
      candidate_count: 1,
      same_reference_movement_count: 1,
      movement_id: selected.movement_id,
      register_id: selected.register_ids[0],
      allocation_id: selected.allocation_ids[0],
      evidence,
    };
  });
  return classifiedEvidence.map((classification, index) => (
    withPendingPrelinkCorruption(pending[index], classification)
  ));
}

function historicalControlledRecoverySelection(entry) {
  const suppliedLegacyIdentity = ['movement_id', 'register_id'].some((field) => (
    Object.prototype.hasOwnProperty.call(entry || {}, field)
  ));
  if (suppliedLegacyIdentity) {
    throw AppError.badRequest(
      'Historical controlled custody must use the explicit historical_recovery selection',
      'WARD_INDENT_CONTROLLED_RECOVERY_SELECTION_INVALID',
    );
  }
  if (entry?.historical_recovery == null) return null;
  if (typeof entry.historical_recovery !== 'object'
    || Array.isArray(entry.historical_recovery)) {
    throw AppError.badRequest(
      'historical_recovery must bind one movement, one register, and a reason',
      'WARD_INDENT_CONTROLLED_RECOVERY_SELECTION_INVALID',
    );
  }
  const recovery = entry.historical_recovery;
  const extraFields = Object.keys(recovery).filter(
    (field) => !['movement_id', 'register_id', 'reason'].includes(field),
  );
  if (extraFields.length) {
    throw AppError.badRequest(
      'historical_recovery contains unsupported authority fields',
      'WARD_INDENT_CONTROLLED_RECOVERY_SELECTION_INVALID',
      { unsupported_fields: extraFields.sort() },
    );
  }
  const reason = String(recovery.reason || '').trim();
  if (!reason) {
    throw AppError.badRequest('historical_recovery.reason is required');
  }
  if (reason.length > WARD_CONTROLLED_RECOVERY_REASON_MAX_LENGTH) {
    throw AppError.badRequest(
      `historical_recovery.reason must not exceed ${WARD_CONTROLLED_RECOVERY_REASON_MAX_LENGTH} characters`,
      'WARD_INDENT_CONTROLLED_RECOVERY_REASON_TOO_LONG',
      {
        field: 'historical_recovery.reason',
        max_length: WARD_CONTROLLED_RECOVERY_REASON_MAX_LENGTH,
      },
    );
  }
  return {
    movement_id: positiveInt(recovery.movement_id, 'historical_recovery.movement_id'),
    register_id: positiveInt(recovery.register_id, 'historical_recovery.register_id'),
    reason,
  };
}

async function assertWardControlledRecoverySupervisorTx(tx, {
  indent,
  actorUid,
  actorRole,
}) {
  const grant = await assertPharmacyFacilityGrant(tx, {
    tenantId: indent.tenant_id,
    facilityId: Number(indent.facility_id),
    actorUid,
    actorRole,
    forUpdate: true,
  });
  if (grant.actor_role !== WARD_CONTROLLED_RECOVERY_ROLE) {
    throw AppError.forbidden(
      'Historical controlled custody recovery requires the pharmacy in-charge',
      'WARD_INDENT_CONTROLLED_RECOVERY_SUPERVISOR_REQUIRED',
      { required_role: WARD_CONTROLLED_RECOVERY_ROLE },
    );
  }
  return grant;
}

function controlledRecoveryReceipt({
  indent,
  item,
  allocation,
  candidate,
  selection,
  supervisor,
  commandKey,
}) {
  const register = candidate.evidence[0].registers[0];
  const receipt = {
    contract: WARD_CONTROLLED_RECOVERY_CONTRACT,
    disposition: 'historical_exact_pair_linked',
    ward_indent_id: Number(indent.id),
    ward_indent_item_id: Number(item.id),
    allocation_id: String(allocation.id),
    movement_id: selection.movement_id,
    register_id: selection.register_id,
    reference_id: item.controlled_reference_id,
    facility_id: Number(indent.facility_id),
    inventory_item_id: Number(allocation.inventory_item_id),
    inventory_batch_id: Number(allocation.inventory_batch_id),
    catalog_id: Number(item.pharmacy_catalog_id),
    clinical_order_id: Number(item.clinical_order_id),
    quantity: Number(item.quantity_approved),
    patient_uid: String(indent.patient_uid),
    movement_performed_by: candidate.evidence[0].performed_by,
    movement_performer_role: candidate.evidence[0].performer_role,
    register_performed_by: register.performed_by,
    schedule_class: candidate.evidence[0].schedule_class,
    is_narcotic: candidate.evidence[0].is_narcotic,
    register_schedule_class: register.schedule_class,
    witness_uid: register.witness_uid,
    witness_name: register.witness_name,
    recovered_by: supervisor.actor_uid,
    recovered_by_role: supervisor.actor_role,
    recovered_by_name: supervisor.actor_name,
    facility_grant_id: supervisor.grant_id,
    recovery_reason: selection.reason,
    recovery_command_key: wardIndentCommandKey(
      indent.id,
      'controlled_handoff_recorded',
      commandKey,
    ),
  };
  return {
    ...receipt,
    receipt_sha256: pharmacyCommandRequestSha256(receipt),
  };
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
  const pendingControlledHandoffEvidence = await loadPendingControlledHandoffEvidence(
    tx,
    indent,
  );
  const medicationClosure = await loadWardIndentMedicationClosureTx(tx, tenantId, indentId);
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
      pending_controlled_handoff_evidence: pendingControlledHandoffEvidence,
      medication_closure: medicationClosure,
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
  const event = await tx.ward_indent_events.create({
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

  if (!after.patient_uid) return event;
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
  return event;
}

async function applyTransitionTx(
  tx,
  {
    indentId,
    tenantId,
    actorUid,
    expectedVersion = null,
    action,
    allowedStatuses,
    reason = null,
    commandKey = null,
    facilityGrantRequired = false,
    facilityGrantRoles = null,
    actorRole = null,
    mutate,
    lockedCurrent = null
  }
) {
  const cleanActorUid = uuid(actorUid, 'actorUid');
  const tid = tenantOf(tenantId);
  const current = lockedCurrent || (await lockWardIndent(tx, indentId, tid));
  if (
    Number(current.id) !== positiveInt(indentId, 'indentId') ||
    String(current.tenant_id) !== tid
  ) {
    throw AppError.conflict(
      'Locked ward indent does not match the requested transition',
      'WARD_INDENT_LOCK_CONTEXT_MISMATCH'
    );
  }
  if (facilityGrantRequired) {
    if (current.facility_id == null) {
      throw AppError.conflict(
        'Ward indent facility custody is unresolved',
        'WARD_INDENT_FACILITY_REQUIRED'
      );
    }
    const grant = await assertPharmacyFacilityGrant(tx, {
      tenantId: tid,
      facilityId: Number(current.facility_id),
      actorUid: cleanActorUid,
      actorRole,
      forUpdate: true
    });
    if (Array.isArray(facilityGrantRoles)
      && !facilityGrantRoles.includes(grant.actor_role)) {
      throw AppError.forbidden(
        'Ward indent transition requires an exact pharmacy custody role',
        'WARD_INDENT_PHARMACY_CUSTODY_ROLE_REQUIRED',
        { required_roles: [...facilityGrantRoles] },
      );
    }
  }
  const replay = await loadCommandReplay(tx, {
    tenantId: tid,
    indentId: current.id,
    action,
    commandKey,
    actorUid: cleanActorUid
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
      'WARD_INDENT_STATE_CONTRACT_MISSING'
    );
  }
  const previousRule = WARD_INDENT_STATE_CONTRACT[current.status]?.slaRuleCode || null;
  const nextRule = contract.slaRuleCode || null;
  const nextVersion = Number(current.state_version) + 1;
  const nextSlaSourceId =
    nextRule == null
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
      updated_at: new Date()
    },
    include: { items: { orderBy: { id: 'asc' } } }
  });
  const event = await appendTransitionEvidence(tx, {
    before: current,
    after: updated,
    action,
    actorUid: cleanActorUid,
    reason,
    commandKey,
    details: outcome.details || {}
  });
  if (typeof outcome.afterEvidence === 'function') {
    await outcome.afterEvidence({ tx, before: current, after: updated, event });
  }
  await completeWardIndentStateObligationTx(tx, {
    before: current,
    after: updated,
    event,
    actorUid: cleanActorUid
  });
  await rotateSla(tx, current, updated, action);
  await reconcileWardIndentNotificationCoverageTx(tx, {
    tenantId: tid,
    indent: updated,
    actorUid: cleanActorUid
  });
  await materializeWardIndentStateObligationTx(tx, {
    indent: updated,
    event,
    actorUid: cleanActorUid
  });
  return loadWardIndentWorkflow(tx, current.id, tid);
}

async function applyTransition(options) {
  const tid = tenantOf(options.tenantId);
  return setTenantTx(tid, tx =>
    applyTransitionTx(tx, {
      ...options,
      tenantId: tid
    })
  );
}

export async function lockMedicationOrderWardIndentTx(tx, { tenantId, clinicalOrderId }) {
  const tid = tenantOf(tenantId);
  const orderId = positiveInt(clinicalOrderId, 'clinicalOrderId');
  const rows = await tx.$queryRawUnsafe(
    `SELECT indent.id
       FROM ward_indents indent
      WHERE indent.tenant_id = $1::uuid
        AND indent.id IN (
          SELECT item.ward_indent_id
            FROM ward_indent_items item
           WHERE item.tenant_id = $1::uuid
             AND item.clinical_order_id = $2::int
        )
      ORDER BY indent.id
      LIMIT 2
      FOR UPDATE OF indent`,
    tid,
    orderId
  );
  if (rows.length > 1) {
    throw AppError.conflict(
      'Medication order is linked to multiple ward indents',
      'CLINICAL_ORDER_WARD_INDENT_LINK_AMBIGUOUS',
      { clinical_order_id: orderId, ward_indent_ids: rows.map(row => Number(row.id)) }
    );
  }
  return rows[0] ? lockWardIndent(tx, Number(rows[0].id), tid) : null;
}

function terminalWardIndentProjection(current, disposition, remainingActiveOrderIds = []) {
  return {
    disposition,
    ward_indent_id: current == null ? null : Number(current.id),
    ward_indent_status: current?.status || null,
    ward_indent_state_version: current == null ? null : Number(current.state_version),
    remaining_active_clinical_order_ids: remainingActiveOrderIds
  };
}

export async function terminallyProjectMedicationOrderWardIndentTx(
  tx,
  { tenantId, order, actorUid, terminalStatus, reason, lockedIndent = null }
) {
  const tid = tenantOf(tenantId);
  const orderId = positiveInt(order?.id, 'clinicalOrderId');
  const cleanActorUid = uuid(actorUid, 'actorUid');
  const cleanReason = reasonText(reason, 'terminal reason');
  const normalizedTerminalStatus = String(terminalStatus || '')
    .trim()
    .toLowerCase();
  if (!['completed', 'cancelled', 'discontinued'].includes(normalizedTerminalStatus)) {
    throw AppError.badRequest(
      'Medication-order ward-indent projection status is invalid',
      'CLINICAL_ORDER_WARD_INDENT_TERMINAL_STATUS_INVALID'
    );
  }
  const current =
    lockedIndent ||
    (await lockMedicationOrderWardIndentTx(tx, {
      tenantId: tid,
      clinicalOrderId: orderId
    }));
  if (!current) return terminalWardIndentProjection(null, 'not_materialized');

  const linkedOrderIds = [
    ...new Set(
      current.items
        .map(item => Number(item.clinical_order_id))
        .filter(id => Number.isSafeInteger(id) && id > 0)
    )
  ];
  const terminalOrderItemIds = current.items
    .filter(item => Number(item.clinical_order_id) === orderId)
    .map(item => Number(item.id));
  if (terminalOrderItemIds.length === 0) {
    throw AppError.conflict(
      'Medication order ward-indent linkage disappeared while locked',
      'CLINICAL_ORDER_WARD_INDENT_LINK_MISSING',
      { clinical_order_id: orderId, ward_indent_id: Number(current.id) }
    );
  }
  const orderRows =
    linkedOrderIds.length === 0
      ? []
      : await tx.$queryRawUnsafe(
          `SELECT id, status
         FROM clinical_orders
        WHERE tenant_id = $1::uuid
          AND id = ANY($2::int[])
        ORDER BY id
        FOR SHARE`,
          tid,
          linkedOrderIds
        );
  const remainingActiveOrderIds = orderRows
    .filter(
      row =>
        Number(row.id) !== orderId &&
        ['ordered', 'verified', 'in_progress'].includes(
          String(row.status || '')
            .trim()
            .toLowerCase()
        )
    )
    .map(row => Number(row.id));

  if (TERMINAL_WARD_INDENT_STATUSES.includes(current.status)) {
    return terminalWardIndentProjection(current, 'already_terminal', remainingActiveOrderIds);
  }

  const hasIssuedCustody = current.items.some(
    item =>
      item.controlled_movement_id != null ||
      Number(item.quantity_issued || 0) > 0 ||
      Number(item.quantity_received || 0) > 0
  );
  const safelyCancellable = !hasIssuedCustody && remainingActiveOrderIds.length === 0;
  const commandKey = `clinical-order-terminal:${orderId}:${normalizedTerminalStatus}`;

  if (safelyCancellable) {
    const projected = await applyTransitionTx(tx, {
      indentId: current.id,
      tenantId: tid,
      actorUid: cleanActorUid,
      commandKey,
      reason: cleanReason,
      action: 'cancelled',
      allowedStatuses: [current.status],
      lockedCurrent: current,
      mutate: async (db, indent) => {
        await releaseWardIndentReservationsTx(db, {
          indent,
          releasedBy: cleanActorUid,
          reason: cleanReason
        });
        await db.ward_indent_items.updateMany({
          where: { ward_indent_id: indent.id, tenant_id: indent.tenant_id },
          data: {
            quantity_reserved: 0,
            quantity_approved: 0,
            fulfilment_status: 'cancelled',
            updated_at: new Date()
          }
        });
        return {
          toStatus: 'cancelled',
          indentData: {
            cancelled_by: cleanActorUid,
            cancelled_at: new Date(),
            cancellation_reason: cleanReason
          },
          details: {
            clinical_order_id: orderId,
            clinical_order_terminal_status: normalizedTerminalStatus,
            terminal_projection: true
          }
        };
      }
    });
    return terminalWardIndentProjection(projected, 'cancelled', remainingActiveOrderIds);
  }

  const projected = await applyTransitionTx(tx, {
    indentId: current.id,
    tenantId: tid,
    actorUid: cleanActorUid,
    commandKey,
    reason: cleanReason,
    action: 'reconciliation_required',
    allowedStatuses: [current.status],
    lockedCurrent: current,
    mutate: async (db, indent) => {
      const releasedReservationCount = await releaseUnissuedWardIndentReservationsTx(db, {
        indent,
        releasedBy: cleanActorUid,
        reason: cleanReason,
        wardIndentItemIds: terminalOrderItemIds
      });
      await db.ward_indent_items.updateMany({
        where: {
          id: { in: terminalOrderItemIds },
          ward_indent_id: indent.id,
          tenant_id: indent.tenant_id
        },
        data: { fulfilment_status: 'reconciliation_required', updated_at: new Date() }
      });
      return {
        toStatus: 'reconciliation_required',
        indentData: { reconciliation_reason: cleanReason },
        details: {
          clinical_order_id: orderId,
          clinical_order_terminal_status: normalizedTerminalStatus,
          terminal_projection: true,
          released_unissued_reservation_count: releasedReservationCount,
          remaining_active_clinical_order_ids: remainingActiveOrderIds
        }
      };
    }
  });
  return terminalWardIndentProjection(
    projected,
    'reconciliation_required',
    remainingActiveOrderIds
  );
}

async function assertCatalogInventoryMappings(tx, tenantId, facilityId, catalogIds) {
  const ids = [...new Set(catalogIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return;
  const rows = await tx.$queryRawUnsafe(
    `SELECT pc.id AS catalog_id,
            COUNT(item.id)::int AS linked_item_count
       FROM pharmacy_catalog pc
       LEFT JOIN pharmacy_inventory_items item
         ON item.tenant_id = pc.tenant_id
         AND item.catalog_id = pc.id
         AND item.status = 'active'
         AND (
           ($3::int IS NULL AND item.facility_id IS NULL)
           OR
           ($3::int IS NOT NULL AND (item.facility_id IS NULL OR item.facility_id = $3::int))
         )
      WHERE pc.tenant_id = $1::uuid
        AND pc.id = ANY($2::int[])
      GROUP BY pc.id`,
    tenantId,
    ids,
    facilityId == null ? null : Number(facilityId),
  );
  const linked = new Map(rows.map((row) => [
    Number(row.catalog_id),
    Number(row.linked_item_count),
  ]));
  for (const id of ids) {
    if (!linked.get(id)) {
      throw AppError.conflict(
        `Catalog item ${id} has no same-facility inventory classification`,
        'WARD_INDENT_INVENTORY_MAPPING_REQUIRED',
        { catalog_id: id },
      );
    }
  }
}

async function loadAllocationControlByItem(tx, indent) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT allocation.ward_indent_item_id,
            BOOL_OR(
              inventory.is_narcotic = TRUE
              OR COALESCE(inventory.schedule_class IN ('H', 'H1', 'X'), FALSE)
            ) AS is_controlled,
            COUNT(DISTINCT (
              inventory.is_narcotic = TRUE
              OR COALESCE(inventory.schedule_class IN ('H', 'H1', 'X'), FALSE)
            ))::int AS classification_count
       FROM ward_indent_inventory_allocations allocation
       JOIN pharmacy_inventory_items inventory
         ON inventory.tenant_id = allocation.tenant_id
        AND inventory.id = allocation.inventory_item_id
      WHERE allocation.tenant_id = $1::uuid
        AND allocation.ward_indent_id = $2::int
        AND allocation.status <> 'released'
      GROUP BY allocation.ward_indent_item_id
      ORDER BY allocation.ward_indent_item_id`,
    indent.tenant_id,
    Number(indent.id),
  );
  const controlByItem = new Map();
  for (const row of rows) {
    if (Number(row.classification_count) !== 1) {
      throw AppError.conflict(
        `Ward indent item ${row.ward_indent_item_id} has mixed controlled classifications`,
        'WARD_INDENT_CONTROLLED_CLASSIFICATION_AMBIGUOUS',
      );
    }
    controlByItem.set(Number(row.ward_indent_item_id), row.is_controlled === true);
  }
  return controlByItem;
}

function assertControlledWardIndentPatient(indent) {
  if (indent.patient_uid != null) return;
  throw AppError.conflict(
    'Controlled medication cannot use a patientless ward-stock indent; use a patient-linked dispense workflow',
    'WARD_INDENT_CONTROLLED_PATIENT_REQUIRED',
    { ward_indent_id: Number(indent.id) },
  );
}

async function assertControlledWardIndentAdmissionOpenTx(tx, indent) {
  if (indent.admission_id == null) return;
  const rows = await tx.$queryRawUnsafe(
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
  if (!rows[0]) throw AppError.notFound('Admission not found');
  if (rows[0].billing_closed_at) {
    throw AppError.conflict(
      `Billing is closed for admission ${Number(indent.admission_id)}`,
      'BILLING_CLOSED',
    );
  }
}

const NON_MEDICATION_CATALOG_CATEGORIES = [
  'consumable',
  'consumables',
  'linen',
  'medical_supply',
  'medical_supplies',
  'sterile_supply',
  'sterile_supplies',
  'ward_supply',
  'ward_supplies',
];

export async function loadWardIndentCatalogClassificationsTx(tx, {
  tenantId,
  catalogIds,
  lock = false,
  unavailableCode = 'WARD_INDENT_CATALOG_UNAVAILABLE',
}) {
  const ids = [...new Set((catalogIds || []).map(Number))]
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .sort((a, b) => a - b);
  if (!ids.length) return new Map();
  const catalogRows = await tx.$queryRawUnsafe(
    `SELECT catalog.id, catalog.name, catalog.generic_name,
            catalog.unit_price, catalog.price,
            catalog.is_active, catalog.category, catalog.requires_prescription,
            catalog.composition_id, catalog.composition_source,
            catalog.composition_confidence,
            catalog.strength, catalog.strength_key, catalog.strength_components,
            catalog.form, catalog.form_key, catalog.release_key, catalog.route
       FROM pharmacy_catalog catalog
      WHERE catalog.tenant_id = $1::uuid
        AND catalog.id = ANY($2::int[])
      ORDER BY catalog.id
      ${lock ? 'FOR SHARE OF catalog' : ''}`,
    tenantId,
    ids,
  );
  const inventoryRows = await tx.$queryRawUnsafe(
    `SELECT inventory.id, inventory.catalog_id, inventory.composition_id,
            inventory.strength, inventory.form, inventory.schedule_class,
            inventory.is_narcotic, inventory.metadata
       FROM pharmacy_inventory_items inventory
      WHERE inventory.tenant_id = $1::uuid
        AND inventory.catalog_id = ANY($2::int[])
      ORDER BY inventory.catalog_id, inventory.id
      ${lock ? 'FOR SHARE OF inventory' : ''}`,
    tenantId,
    ids,
  );
  const inventoryMedicationCatalogs = new Set(inventoryRows
    .filter((inventory) => (
      inventory.composition_id != null
      || String(inventory.strength || '').trim() !== ''
      || String(inventory.form || '').trim() !== ''
      || ['OTC', 'H', 'H1', 'X'].includes(
        String(inventory.schedule_class || '').trim().toUpperCase(),
      )
      || inventory.is_narcotic === true
      || String(inventory.metadata?.product_type || '').trim().toLowerCase() === 'medication'
    ))
    .map((inventory) => Number(inventory.catalog_id)));
  const byId = new Map(catalogRows.map((catalog) => {
    const explicitNonMedication = NON_MEDICATION_CATALOG_CATEGORIES.includes(
      String(catalog.category || '').trim().toLowerCase(),
    ) && catalog.requires_prescription === false;
    const catalogMedicationIdentity = (
      catalog.composition_id != null
      || String(catalog.strength || '').trim() !== ''
      || String(catalog.form || '').trim() !== ''
      || String(catalog.route || '').trim() !== ''
    );
    return [Number(catalog.id), {
      ...catalog,
      is_medication_identity: catalogMedicationIdentity
        || inventoryMedicationCatalogs.has(Number(catalog.id))
        || !explicitNonMedication,
    }];
  }));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || row.is_active !== true) {
      throw AppError.conflict(
        `Active catalog item ${id} is unavailable`,
        unavailableCode,
        { catalog_id: id, exists: Boolean(row), is_active: row?.is_active ?? null },
      );
    }
  }
  return byId;
}

const WARD_MEDICATION_SUBSTITUTION_COMPATIBILITY_RULE =
  'same_high_confidence_composition_exact_strength_components_form_route_release_v2';

function normalizedClinicalProductText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function canonicalCatalogMedicationName(catalog) {
  return String(catalog?.name ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ');
}

function exactCatalogDimensionMatches(original, substitute, keyField, fallbackField) {
  const originalKey = normalizedClinicalProductText(original?.[keyField]);
  const substituteKey = normalizedClinicalProductText(substitute?.[keyField]);
  const originalValue = normalizedClinicalProductText(original?.[fallbackField]);
  const substituteValue = normalizedClinicalProductText(substitute?.[fallbackField]);
  if (!originalValue || !substituteValue || originalValue !== substituteValue) return false;
  if (!originalKey && !substituteKey) return true;
  return Boolean(originalKey && substituteKey && originalKey === substituteKey);
}

function catalogStrengthComponents(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function strengthComponentSignature(component) {
  const dimensions = [
    normalizedClinicalProductText(component?.ingredient),
    normalizedClinicalProductText(component?.amount ?? component?.value),
    normalizedClinicalProductText(component?.unit),
  ];
  if (dimensions.some((dimension) => !dimension)) return null;
  return dimensions.join('|');
}

function exactStrengthComponentsMatch(original, substitute) {
  const originalValue = original?.strength_components;
  const substituteValue = substitute?.strength_components;
  const originalComponents = catalogStrengthComponents(originalValue);
  const substituteComponents = catalogStrengthComponents(substituteValue);
  if (
    !originalComponents
    || !substituteComponents
    || originalComponents.length === 0
    || substituteComponents.length === 0
  ) return false;
  if (originalComponents.length !== substituteComponents.length) return false;
  const originalSignatures = originalComponents.map(strengthComponentSignature).sort();
  const substituteSignatures = substituteComponents.map(strengthComponentSignature).sort();
  if (originalSignatures.some((signature) => signature == null)) return false;
  if (substituteSignatures.some((signature) => signature == null)) return false;
  return originalSignatures.every((signature, index) => (
    signature === substituteSignatures[index]
  ));
}

function medicationSubstitutionMismatches(original, substitute) {
  const mismatches = [];
  const originalCompositionId = Number(original?.composition_id);
  const substituteCompositionId = Number(substitute?.composition_id);
  const originalHasComposition = Number.isSafeInteger(originalCompositionId)
    && originalCompositionId > 0;
  const substituteHasComposition = Number.isSafeInteger(substituteCompositionId)
    && substituteCompositionId > 0;
  if (!originalHasComposition || !substituteHasComposition) {
    mismatches.push('composition_id_missing');
  } else if (originalCompositionId !== substituteCompositionId) {
    mismatches.push('composition_id');
  }
  if (
    normalizedClinicalProductText(original?.composition_confidence) !== 'high'
    || normalizedClinicalProductText(substitute?.composition_confidence) !== 'high'
  ) {
    mismatches.push('composition_confidence');
  }
  if (
    !normalizedClinicalProductText(original?.composition_source)
    || !normalizedClinicalProductText(substitute?.composition_source)
  ) {
    mismatches.push('composition_source_missing');
  }
  if (!exactCatalogDimensionMatches(original, substitute, 'strength_key', 'strength')) {
    mismatches.push('strength');
  }
  if (!exactStrengthComponentsMatch(original, substitute)) {
    mismatches.push('strength_components');
  }
  if (!exactCatalogDimensionMatches(original, substitute, 'form_key', 'form')) {
    mismatches.push('dosage_form');
  }
  const originalRoute = comparableMedicationRoute(original?.route);
  const substituteRoute = comparableMedicationRoute(substitute?.route);
  if (!originalRoute || !substituteRoute || originalRoute !== substituteRoute) {
    mismatches.push('route');
  }
  const originalRelease = normalizedClinicalProductText(original?.release_key);
  const substituteRelease = normalizedClinicalProductText(substitute?.release_key);
  if (!originalRelease || !substituteRelease || originalRelease !== substituteRelease) {
    mismatches.push('release');
  }
  return mismatches;
}

function substitutionCatalogSnapshot(catalog) {
  const components = catalogStrengthComponents(catalog?.strength_components) || [];
  return {
    catalog_id: Number(catalog?.id),
    name: normalizedClinicalProductText(catalog?.name) || null,
    generic_name: normalizedClinicalProductText(catalog?.generic_name) || null,
    composition_id: Number(catalog?.composition_id),
    composition_confidence: normalizedClinicalProductText(catalog?.composition_confidence),
    composition_source: normalizedClinicalProductText(
      catalog?.composition_source ?? catalog?.metadata?.composition_source,
    ) || null,
    strength: normalizedClinicalProductText(catalog?.strength) || null,
    strength_key: normalizedClinicalProductText(catalog?.strength_key) || null,
    strength_components: components
      .map((component) => ({
        ingredient: normalizedClinicalProductText(component?.ingredient),
        value: normalizedClinicalProductText(component?.amount ?? component?.value),
        unit: normalizedClinicalProductText(component?.unit),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    form: normalizedClinicalProductText(catalog?.form) || null,
    form_key: normalizedClinicalProductText(catalog?.form_key) || null,
    route: normalizedClinicalProductText(catalog?.route) || null,
    release_key: normalizedClinicalProductText(catalog?.release_key) || null,
  };
}

export function bindMedicationOrderCatalogAuthority(details, catalog, {
  phase = 'create',
} = {}) {
  if (!details || typeof details !== 'object' || Array.isArray(details) || !catalog?.id) {
    throw AppError.conflict(
      'Medication catalog authority context is invalid',
      'CLINICAL_ORDER_MEDICATION_CATALOG_AUTHORITY_INVALID',
      { phase },
    );
  }
  const catalogSnapshot = substitutionCatalogSnapshot(catalog);
  const canonicalMedicationName = canonicalCatalogMedicationName(catalog);
  const components = catalogSnapshot.strength_components;
  const incompleteDimensions = [
    !canonicalMedicationName ? 'medication_name' : null,
    !Number.isSafeInteger(catalogSnapshot.composition_id)
      || catalogSnapshot.composition_id <= 0 ? 'composition_id' : null,
    catalogSnapshot.composition_confidence !== 'high' ? 'composition_confidence' : null,
    !catalogSnapshot.composition_source ? 'composition_source' : null,
    !Array.isArray(components)
      || components.length === 0
      || components.some((component) => (
        !component.ingredient || !component.value || !component.unit
      )) ? 'strength_components' : null,
    !catalogSnapshot.strength ? 'strength' : null,
    !catalogSnapshot.form ? 'form' : null,
    !catalogSnapshot.route ? 'route' : null,
    !catalogSnapshot.release_key ? 'release' : null,
  ].filter(Boolean);
  if (incompleteDimensions.length) {
    throw AppError.conflict(
      'Medication catalog lacks complete high-confidence clinical product authority',
      'CLINICAL_ORDER_MEDICATION_CATALOG_CLINICAL_IDENTITY_INCOMPLETE',
      {
        catalog_id: Number(catalog.id),
        incomplete_dimensions: incompleteDimensions,
        phase,
      },
    );
  }
  const prescribedDose = String(details.dose ?? details.dosage ?? '').trim();
  if (!prescribedDose) {
    throw AppError.badRequest(
      'Medication dose is required and must be bound to the selected catalog product',
      'CLINICAL_ORDER_MEDICATION_DOSE_REQUIRED',
    );
  }
  const prescribedRoute = comparableMedicationRoute(details.route);
  const catalogRoute = comparableMedicationRoute(catalogSnapshot.route);
  const suppliedStrength = normalizedClinicalProductText(details.strength);
  const suppliedStrengthKey = normalizedClinicalProductText(details.strength_key);
  const suppliedForm = normalizedClinicalProductText(details.form);
  const suppliedFormKey = normalizedClinicalProductText(details.form_key);
  const suppliedRelease = normalizedClinicalProductText(details.release_key);
  const suppliedMedicationName = normalizedClinicalProductText(
    details.medication_name ?? details.drug_name ?? details.name ?? details.medication,
  );
  const mismatches = [];
  if (
    suppliedMedicationName
    && suppliedMedicationName !== normalizedClinicalProductText(canonicalMedicationName)
  ) {
    mismatches.push('medication_name');
  }
  if (!prescribedRoute || prescribedRoute !== catalogRoute) mismatches.push('route');
  if (suppliedStrength && suppliedStrength !== catalogSnapshot.strength)
    mismatches.push('strength');
  if (suppliedStrengthKey && suppliedStrengthKey !== catalogSnapshot.strength_key) {
    mismatches.push('strength_key');
  }
  if (suppliedForm && suppliedForm !== catalogSnapshot.form) mismatches.push('form');
  if (suppliedFormKey && suppliedFormKey !== catalogSnapshot.form_key) mismatches.push('form_key');
  if (suppliedRelease && suppliedRelease !== catalogSnapshot.release_key) mismatches.push('release');
  const suppliedCompositionId = Number(details.composition_id);
  if (
    details.composition_id != null
    && (!Number.isSafeInteger(suppliedCompositionId)
      || suppliedCompositionId !== catalogSnapshot.composition_id)
  ) {
    mismatches.push('composition_id');
  }
  if (mismatches.length) {
    throw AppError.conflict(
      'Medication order clinical identity conflicts with the selected catalog product',
      'CLINICAL_ORDER_MEDICATION_CATALOG_CLINICAL_IDENTITY_MISMATCH',
      { catalog_id: Number(catalog.id), mismatched_dimensions: mismatches, phase },
    );
  }
  const authority = {
    version: 'medication_catalog_authority_v1',
    catalog: catalogSnapshot,
    prescribed: {
      medication_name: canonicalMedicationName,
      dose: prescribedDose,
      route: canonicalMedicationRoute(catalogSnapshot.route),
      quantity_requested:
        details.quantity_requested == null
          ? null
          : Number.isFinite(Number(details.quantity_requested))
            ? Number(details.quantity_requested)
            : null,
      unit: String(details.unit || '').trim() || null
    }
  };
  const authoritySha256 = createHash('sha256')
    .update(JSON.stringify(authority), 'utf8')
    .digest('hex');
  if (phase !== 'create') {
    if (
      details.catalog_authority?.version !== authority.version
      || details.catalog_authority_sha256 !== authoritySha256
    ) {
      throw AppError.conflict(
        'Medication order catalog authority changed after prescribing',
        'CLINICAL_ORDER_MEDICATION_CATALOG_AUTHORITY_MISMATCH',
        {
          catalog_id: Number(catalog.id),
          expected_sha256: details.catalog_authority_sha256 || null,
          actual_sha256: authoritySha256,
          phase,
        },
      );
    }
  }
  return {
    ...details,
    medication_name: canonicalMedicationName,
    composition_id: catalogSnapshot.composition_id,
    composition_source: catalogSnapshot.composition_source,
    composition_confidence: catalogSnapshot.composition_confidence,
    strength: catalogSnapshot.strength,
    strength_key: catalogSnapshot.strength_key,
    strength_components: catalogSnapshot.strength_components,
    form: catalogSnapshot.form,
    form_key: catalogSnapshot.form_key,
    route: canonicalMedicationRoute(catalogSnapshot.route),
    release_key: catalogSnapshot.release_key,
    generic_name: catalogSnapshot.generic_name,
    catalog_authority: authority,
    catalog_authority_sha256: authoritySha256,
  };
}

function substitutionCompatibilityEvidence({ item, originalCatalog, substituteCatalog }) {
  const provenance = {
    rule: WARD_MEDICATION_SUBSTITUTION_COMPATIBILITY_RULE,
    original: substitutionCatalogSnapshot(originalCatalog),
    substitute: substitutionCatalogSnapshot(substituteCatalog),
  };
  return {
    item_id: Number(item.id),
    original_catalog_id: Number(originalCatalog.id),
    substitute_catalog_id: Number(substituteCatalog.id),
    compatibility_rule: WARD_MEDICATION_SUBSTITUTION_COMPATIBILITY_RULE,
    provenance,
    provenance_sha256: createHash('sha256')
      .update(JSON.stringify(provenance), 'utf8')
      .digest('hex'),
  };
}

function assertWardMedicationSubstitutionCompatibility({
  item,
  originalCatalog,
  substituteCatalog,
  phase,
}) {
  const medicationLine = item.clinical_order_id != null
    || originalCatalog?.is_medication_identity === true
    || substituteCatalog?.is_medication_identity === true;
  if (!medicationLine) return null;
  if (item.clinical_order_id == null) {
    throw AppError.conflict(
      `Medication ward-indent item ${Number(item.id)} requires a clinical order before substitution`,
      'WARD_INDENT_CLINICAL_ORDER_REQUIRED',
      { item_id: Number(item.id), phase },
    );
  }
  if (
    originalCatalog?.is_medication_identity !== true
    || substituteCatalog?.is_medication_identity !== true
  ) {
    throw AppError.conflict(
      `Medication ward-indent item ${Number(item.id)} requires medication-classified products`,
      'WARD_INDENT_MEDICATION_SUBSTITUTION_CLASSIFICATION_MISMATCH',
      {
        item_id: Number(item.id),
        original_catalog_id: Number(originalCatalog?.id) || null,
        substitute_catalog_id: Number(substituteCatalog?.id) || null,
        phase,
      },
    );
  }
  const mismatchedDimensions = medicationSubstitutionMismatches(
    originalCatalog,
    substituteCatalog,
  );
  if (mismatchedDimensions.length) {
    throw AppError.conflict(
      `Medication substitute for ward-indent item ${Number(item.id)} is not clinically compatible`,
      'WARD_INDENT_MEDICATION_SUBSTITUTION_INCOMPATIBLE',
      {
        item_id: Number(item.id),
        original_catalog_id: Number(originalCatalog.id),
        substitute_catalog_id: Number(substituteCatalog.id),
        compatibility_rule: WARD_MEDICATION_SUBSTITUTION_COMPATIBILITY_RULE,
        mismatched_dimensions: mismatchedDimensions,
        phase,
      },
    );
  }
  return substitutionCompatibilityEvidence({ item, originalCatalog, substituteCatalog });
}

async function assertActiveWardIndentPrescriberTx(tx, tenantId, actorUid) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT role
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND is_active = TRUE
        AND COALESCE(is_deleted, FALSE) = FALSE
        AND deleted_at IS NULL
        AND LOWER(COALESCE(status, 'active')) = 'active'
      LIMIT 1
      FOR SHARE`,
    tenantId,
    actorUid,
  );
  if (!DOCTOR_TIERS.includes(String(rows[0]?.role || '').trim().toUpperCase())) {
    throw AppError.forbidden(
      'Only an active same-tenant prescriber may approve a medication substitution',
      'WARD_INDENT_SUBSTITUTION_ACTIVE_PRESCRIBER_REQUIRED',
    );
  }
  return rows[0];
}

export async function loadMedicationCatalogAuthorityTx(tx, {
  tenantId,
  catalogIds,
  lock = false,
  unavailableCode = 'WARD_INDENT_CATALOG_UNAVAILABLE',
  classificationCode = 'WARD_INDENT_MEDICATION_CATALOG_CLASSIFICATION_MISMATCH',
}) {
  const byId = await loadWardIndentCatalogClassificationsTx(tx, {
    tenantId,
    catalogIds,
    lock,
    unavailableCode,
  });
  for (const [catalogId, catalog] of byId) {
    if (catalog.is_medication_identity !== true) {
      throw AppError.conflict(
        `Catalog item ${catalogId} is not classified as medication`,
        classificationCode,
        { catalog_id: catalogId, category: catalog.category || null },
      );
    }
  }
  return byId;
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
  const event = await appendTransitionEvidence(tx, {
    before: null,
    after: initialized,
    action: 'requested',
    actorUid: cleanActorUid,
    commandKey,
    details: { source },
  });
  await requireSlaStart(tx, initialized, 'requested', { source });
  await materializeWardIndentStateObligationTx(tx, {
    indent: initialized,
    event,
    actorUid: cleanActorUid,
  });
  return loadWardIndentWorkflow(tx, initialized.id, initialized.tenant_id);
}

export async function reserveWardIndent({
  indentId,
  reservedBy,
  itemQuantitiesReserved = null,
  inventorySelections = null,
  expectedVersion = null,
  commandKey = null,
  tenantId,
  actorRole = null,
}) {
  return applyTransition({
    indentId,
    tenantId,
    actorUid: reservedBy,
    actorRole,
    facilityGrantRequired: true,
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
      const targetQuantities = new Map();
      for (const item of current.items) {
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
        targetQuantities.set(Number(item.id), desired);
      }
      const exact = await reserveWardIndentInventoryTx(tx, {
        indent: current,
        reservedBy,
        targetQuantities,
        inventorySelections,
        commandKey,
        allowShortSupply: false,
      });
      for (const item of current.items) {
        const controlled = exact.controlledByItem.get(Number(item.id)) === true;
        await tx.ward_indent_items.update({
          where: { id: item.id },
          data: {
            quantity_reserved: exact.actualByItem.get(Number(item.id)),
            fulfilment_status: 'reserved',
            controlled_reference_id: controlled
              ? `ward-indent:${current.id}:item:${item.id}`
              : null,
            updated_at: new Date(),
          },
        });
      }
      return {
        toStatus: 'reserved',
        indentData: { short_supply_reason: null },
        details: { reserved_item_count: current.items.length, exact_batch_reservation: true },
      };
    },
  });
}

export async function markWardIndentShortSupply({
  indentId,
  markedBy,
  reason,
  itemQuantitiesAvailable,
  inventorySelections = null,
  expectedVersion = null,
  commandKey = null,
  tenantId,
  actorRole = null,
}) {
  const cleanReason = reasonText(reason, 'short_supply_reason');
  return applyTransition({
    indentId,
    tenantId,
    actorUid: markedBy,
    actorRole,
    facilityGrantRequired: true,
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
      const targetQuantities = new Map();
      for (const item of current.items) {
        if (!item.pharmacy_catalog_id) {
          throw AppError.conflict(
            `Ward indent item ${item.id} must be linked to a catalog item before short supply can be recorded`,
            'WARD_INDENT_CATALOG_LINK_REQUIRED',
            { item_id: item.id },
          );
        }
        targetQuantities.set(
          Number(item.id),
          available.has(item.id)
            ? available.get(item.id)
            : Number(item.quantity_reserved || 0),
        );
      }
      const exact = await reserveWardIndentInventoryTx(tx, {
        indent: current,
        reservedBy: markedBy,
        targetQuantities,
        inventorySelections,
        commandKey,
        allowShortSupply: true,
      });
      let hasShortfall = false;
      for (const item of current.items) {
        const qty = exact.actualByItem.get(Number(item.id)) || 0;
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
            controlled_reference_id: exact.controlledByItem.get(Number(item.id)) === true
              ? `ward-indent:${current.id}:item:${item.id}`
              : null,
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
        details: { short_supply_reason: cleanReason, shortfalls: exact.shortfalls },
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
  actorRole = null,
}) {
  return applyTransition({
    indentId,
    tenantId,
    actorUid: proposedBy,
    actorRole,
    facilityGrantRequired: true,
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
          originalCatalogId: Number(
            item.original_pharmacy_catalog_id || item.pharmacy_catalog_id,
          ),
          catalogId,
          quantity: quantity(
            entry?.quantity ?? item.quantity_requested,
            'substitution quantity',
          ),
          reason: reasonText(entry?.reason, 'substitution reason'),
        });
      }
      const catalogById = await loadWardIndentCatalogClassificationsTx(tx, {
        tenantId: current.tenant_id,
        catalogIds: proposals.flatMap((entry) => [
          entry.originalCatalogId,
          entry.catalogId,
        ]),
        lock: true,
      });
      await assertCatalogInventoryMappings(
        tx,
        current.tenant_id,
        current.facility_id,
        proposals.map((entry) => entry.catalogId),
      );
      for (const proposal of proposals) {
        if (proposal.quantity > Number(proposal.item.quantity_requested)) {
          throw AppError.badRequest(`Item ${proposal.item.id} substitution quantity exceeds requested quantity`);
        }
        const catalog = catalogById.get(proposal.catalogId);
        proposal.compatibilityEvidence = assertWardMedicationSubstitutionCompatibility({
          item: proposal.item,
          originalCatalog: catalogById.get(proposal.originalCatalogId),
          substituteCatalog: catalog,
          phase: 'proposal',
        });
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
          medication_substitution_compatibility: proposals
            .map((entry) => entry.compatibilityEvidence)
            .filter(Boolean),
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
      await assertActiveWardIndentPrescriberTx(tx, current.tenant_id, decidedBy);
      const pending = current.items.filter((item) => item.substitution_status === 'pending');
      if (!pending.length) throw AppError.conflict('Ward indent has no pending substitutions');
      const pendingIds = new Set(pending.map((item) => Number(item.id)));
      const catalogIds = current.items.flatMap((item) => (
        pendingIds.has(Number(item.id))
          ? [
            Number(item.original_pharmacy_catalog_id || item.pharmacy_catalog_id),
            Number(item.proposed_pharmacy_catalog_id),
          ]
          : [Number(item.pharmacy_catalog_id)]
      ));
      const catalogById = await loadWardIndentCatalogClassificationsTx(tx, {
        tenantId: current.tenant_id,
        catalogIds,
        lock: true,
        unavailableCode: 'WARD_INDENT_SUBSTITUTION_CATALOG_CHANGED',
      });
      await assertCatalogInventoryMappings(
        tx,
        current.tenant_id,
        current.facility_id,
        catalogIds,
      );
      const compatibilityEvidence = [];
      for (const item of pending) {
        const catalogId = Number(item.proposed_pharmacy_catalog_id);
        const catalog = catalogById.get(catalogId);
        if (!catalog) {
          throw AppError.conflict(
            `Proposed catalog item for ward indent item ${item.id} is no longer active`,
            'WARD_INDENT_SUBSTITUTION_CATALOG_CHANGED',
          );
        }
        const originalCatalogId = Number(
          item.original_pharmacy_catalog_id || item.pharmacy_catalog_id,
        );
        const compatibility = assertWardMedicationSubstitutionCompatibility({
          item,
          originalCatalog: catalogById.get(originalCatalogId),
          substituteCatalog: catalog,
          phase: 'approval',
        });
        if (compatibility) compatibilityEvidence.push(compatibility);
        await tx.ward_indent_items.update({
          where: { id: item.id },
          data: {
            substitution_status: 'approved',
            substitution_decided_by: decidedBy,
            substitution_decided_at: new Date(),
            fulfilment_status: 'substitution_pending',
            updated_at: new Date(),
          },
        });
      }
      return {
        toStatus: 'substitution_pending',
        details: {
          substitution_item_ids: pending.map((item) => item.id),
          medication_substitution_compatibility: compatibilityEvidence,
          inventory_action_required: 'apply_approved_substitution',
        },
      };
    },
  });
}

export async function applyApprovedWardIndentSubstitution({
  indentId,
  appliedBy,
  actorRole = null,
  inventorySelections = null,
  expectedVersion = null,
  commandKey = null,
  tenantId,
}) {
  return applyTransition({
    indentId,
    tenantId,
    actorUid: appliedBy,
    actorRole,
    facilityGrantRequired: true,
    expectedVersion,
    commandKey,
    action: 'substitution_applied',
    allowedStatuses: ['substitution_pending'],
    mutate: async (tx, current) => {
      const approved = current.items.filter((item) => item.substitution_status === 'approved');
      if (!approved.length) {
        throw AppError.conflict(
          'Ward indent has no clinician-approved substitutions to apply',
          'WARD_INDENT_SUBSTITUTION_APPROVAL_REQUIRED',
        );
      }
      if (current.items.some((item) => item.substitution_status === 'pending')) {
        throw AppError.conflict(
          'Every pending substitution requires a clinician decision before inventory can change',
          'WARD_INDENT_SUBSTITUTION_DECISION_INCOMPLETE',
        );
      }
      const approvedIds = new Set(approved.map((item) => Number(item.id)));
      const catalogIds = current.items.map((item) => (
        approvedIds.has(Number(item.id))
          ? Number(item.proposed_pharmacy_catalog_id)
          : Number(item.pharmacy_catalog_id)
      ));
      const catalogById = await loadWardIndentCatalogClassificationsTx(tx, {
        tenantId: current.tenant_id,
        catalogIds,
        lock: true,
      });
      await assertCatalogInventoryMappings(
        tx,
        current.tenant_id,
        current.facility_id,
        catalogIds,
      );
      const compatibilityEvidence = [];
      for (const item of approved) {
        const catalogId = Number(item.proposed_pharmacy_catalog_id);
        const catalog = catalogById.get(catalogId);
        const originalCatalogId = Number(
          item.original_pharmacy_catalog_id || item.pharmacy_catalog_id,
        );
        const compatibility = assertWardMedicationSubstitutionCompatibility({
          item,
          originalCatalog: catalogById.get(originalCatalogId),
          substituteCatalog: catalog,
          phase: 'application',
        });
        if (compatibility) compatibilityEvidence.push(compatibility);
        await tx.ward_indent_items.update({
          where: { id: item.id },
          data: {
            original_pharmacy_catalog_id: item.original_pharmacy_catalog_id
              || item.pharmacy_catalog_id,
            original_item_name: item.original_item_name || item.item_name,
            pharmacy_catalog_id: catalogId,
            item_name: catalog.name,
            unit_price: catalog.unit_price ?? catalog.price ?? item.unit_price,
            fulfilment_status: 'substitution_pending',
            updated_at: new Date(),
          },
        });
      }
      const updatedItems = await tx.ward_indent_items.findMany({
        where: { ward_indent_id: current.id, tenant_id: current.tenant_id },
        orderBy: { id: 'asc' },
      });
      const targetQuantities = new Map(updatedItems.map((item) => [
        Number(item.id),
        approvedIds.has(Number(item.id))
          ? Number(item.proposed_quantity)
          : Number(item.quantity_reserved),
      ]));
      const exact = await reserveWardIndentInventoryTx(tx, {
        indent: { ...current, items: updatedItems },
        reservedBy: appliedBy,
        targetQuantities,
        inventorySelections,
        commandKey,
        allowShortSupply: true,
      });
      for (const item of updatedItems) {
        const reserved = exact.actualByItem.get(Number(item.id)) || 0;
        await tx.ward_indent_items.update({
          where: { id: item.id },
          data: {
            quantity_reserved: reserved,
            fulfilment_status: reserved < Number(item.quantity_requested)
              ? 'short_supply'
              : 'reserved',
            controlled_reference_id: exact.controlledByItem.get(Number(item.id)) === true
              ? `ward-indent:${current.id}:item:${item.id}`
              : null,
            updated_at: new Date(),
          },
        });
      }
      const fullyReserved = updatedItems.every((item) => (
        Number(exact.actualByItem.get(Number(item.id)) || 0) === Number(item.quantity_requested)
      ));
      return {
        toStatus: fullyReserved ? 'reserved' : 'short_supply',
        indentData: fullyReserved ? { short_supply_reason: null } : {},
        details: {
          substitution_item_ids: approved.map((item) => item.id),
          medication_substitution_compatibility: compatibilityEvidence,
          fully_reserved: fullyReserved,
          shortfalls: exact.shortfalls,
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
  actorRole = null,
}) {
  return applyTransition({
    indentId,
    tenantId,
    actorUid: approvedBy,
    actorRole,
    facilityGrantRequired: true,
    expectedVersion,
    commandKey,
    action: 'approved',
    allowedStatuses: ['reserved'],
    mutate: async (tx, current) => {
      for (const item of current.items) {
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
      }
      const controlByItem = await loadAllocationControlByItem(tx, current);
      const controlledItemIds = current.items
        .filter((item) => controlByItem.get(Number(item.id)) === true)
        .map((item) => Number(item.id));
      if (controlledItemIds.length) {
        assertControlledWardIndentPatient(current);
        await assertControlledWardIndentAdmissionOpenTx(tx, current);
      }
      let controlledCount = 0;
      for (const item of current.items) {
        const controlled = controlByItem.get(Number(item.id)) === true;
        if (!controlByItem.has(Number(item.id))) {
          throw AppError.conflict(
            `Ward indent item ${item.id} has no exact inventory allocation`,
            'WARD_INDENT_EXACT_RESERVATION_MISMATCH',
          );
        }
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
  actorRole = null,
}) {
  const cleanReason = reasonText(reason, 'rejection reason');
  return applyTransition({
    indentId,
    tenantId,
    actorUid: rejectedBy,
    actorRole,
    facilityGrantRequired: true,
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
      await releaseWardIndentReservationsTx(tx, {
        indent: current,
        releasedBy: rejectedBy,
        reason: cleanReason,
      });
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

async function loadWardControlledWitnessPayloadTx(tx, {
  tenantId,
  indentId,
  itemId,
  allocationId,
  requestedBy,
  actorRole,
}) {
  const current = await lockWardIndent(tx, indentId, tenantId);
  if (!current.facility_id) {
    throw AppError.conflict(
      'Ward indent has no pinned facility authority',
      'WARD_INDENT_FACILITY_REQUIRED',
    );
  }
  await assertPharmacyFacilityGrant(tx, {
    tenantId,
    facilityId: Number(current.facility_id),
    actorUid: requestedBy,
    actorRole,
    forUpdate: true,
  });
  assertControlledWardIndentPatient(current);
  await assertControlledWardIndentAdmissionOpenTx(tx, current);
  if (String(current.status) !== 'controlled_handoff_required') {
    throw AppError.conflict(
      'Ward indent is not awaiting a controlled handoff',
      'WARD_INDENT_CONTROLLED_HANDOFF_STATE_INVALID',
    );
  }
  const item = current.items.find((candidate) => Number(candidate.id) === Number(itemId));
  if (!item || !item.controlled_reference_id) {
    throw AppError.badRequest(
      'item_id must identify a controlled line on this ward indent',
      'WARD_INDENT_CONTROLLED_ITEM_REQUIRED',
    );
  }
  if (!item.clinical_order_id) {
    throw AppError.conflict(
      'Controlled ward dispensing requires a linked medication clinical order',
      'WARD_INDENT_CONTROLLED_CLINICAL_ORDER_REQUIRED',
    );
  }
  const closure = await loadWardIndentMedicationClosureTx(tx, tenantId, current.id);
  const allocations = closure.allocations.filter((allocation) => (
    Number(allocation.ward_indent_item_id) === Number(item.id)
    && String(allocation.id) === String(allocationId)
    && ['reserved', 'partially_issued'].includes(String(allocation.status))
  ));
  if (allocations.length !== 1) {
    throw AppError.conflict(
      'Witness request must identify one active controlled allocation',
      'WARD_INDENT_CONTROLLED_ALLOCATION_MISMATCH',
    );
  }
  const allocation = allocations[0];
  const quantity = Number(allocation.reserved_quantity)
    - Number(allocation.issued_quantity || 0)
    - Number(allocation.authority_released_quantity || 0);
  if (quantity <= 0 || Math.abs(quantity - Number(item.quantity_approved)) > 1e-9) {
    throw AppError.conflict(
      'Controlled ward allocation quantity changed',
      'WARD_INDENT_EXACT_RESERVATION_MISMATCH',
    );
  }
  return wardControlledHandoffWitnessPayload({
    ward_indent_id: current.id,
    ward_indent_item_id: item.id,
    allocation_id: allocation.id,
    inventory_item_id: allocation.inventory_item_id,
    inventory_batch_id: allocation.inventory_batch_id,
    quantity,
    patient_uid: current.patient_uid,
    clinical_order_id: item.clinical_order_id,
    catalog_id: item.pharmacy_catalog_id,
    reference_id: item.controlled_reference_id,
  });
}

export async function requestWardIndentControlledWitnessApproval({
  tenantId,
  indentId,
  itemId,
  allocationId,
  requestedBy,
  actorRole,
}) {
  const tid = tenantOf(tenantId);
  const payload = await setTenantTx(tid, (tx) => loadWardControlledWitnessPayloadTx(tx, {
    tenantId: tid,
    indentId,
    itemId,
    allocationId,
    requestedBy,
    actorRole,
  }));
  const approval = await createControlledDispenseWitnessApproval({
    tenantId: tid,
    scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.wardIndent,
    payload,
    requestedBy,
  });
  return approval;
}

export async function approveWardIndentControlledWitnessApproval({
  tenantId,
  indentId,
  itemId,
  allocationId,
  requesterUid,
  requesterRole,
  witnessUid,
  approvalId,
}) {
  const tid = tenantOf(tenantId);
  const payload = await setTenantTx(tid, (tx) => loadWardControlledWitnessPayloadTx(tx, {
    tenantId: tid,
    indentId,
    itemId,
    allocationId,
    requestedBy: requesterUid,
    actorRole: requesterRole,
  }));
  const approval = await approveControlledDispenseWitnessApproval({
    tenantId: tid,
    approvalId,
    actorUid: witnessUid,
    payload,
    requesterUid,
  });
  return approval;
}

export async function recordWardIndentControlledHandoff({
  indentId,
  recordedBy,
  itemEvidence,
  expectedVersion = null,
  commandKey = null,
  tenantId,
  actorRole = null,
}) {
  return applyTransition({
    indentId,
    tenantId,
    actorUid: recordedBy,
    actorRole,
    facilityGrantRequired: true,
    facilityGrantRoles: CONTROLLED_HANDOFF_OWNERS,
    expectedVersion,
    commandKey,
    action: 'controlled_handoff_recorded',
    allowedStatuses: ['controlled_handoff_required'],
    mutate: async (tx, current) => {
      assertControlledWardIndentPatient(current);
      await assertControlledWardIndentAdmissionOpenTx(tx, current);
      if (!Array.isArray(itemEvidence) || itemEvidence.length === 0) {
        throw AppError.badRequest('item_evidence must be a non-empty array');
      }
      const evidenceByItem = new Map();
      const recoveryByItem = new Map();
      for (const entry of itemEvidence) {
        const itemId = positiveInt(entry?.item_id, 'item_id');
        if (evidenceByItem.has(itemId)) throw AppError.badRequest(`Duplicate item evidence ${itemId}`);
        evidenceByItem.set(itemId, entry);
        const recovery = historicalControlledRecoverySelection(entry);
        if (recovery && entry.witness_approval_id != null) {
          throw AppError.badRequest(
            'Historical recovery cannot consume a new witness approval',
            'WARD_INDENT_CONTROLLED_RECOVERY_SELECTION_INVALID',
          );
        }
        if (recovery) recoveryByItem.set(itemId, recovery);
      }
      if (recoveryByItem.size && !String(commandKey || '').trim()) {
        throw AppError.badRequest(
          'Historical controlled custody recovery requires an idempotent command key',
          'WARD_INDENT_CONTROLLED_RECOVERY_COMMAND_REQUIRED',
        );
      }
      const controlled = current.items.filter((item) => item.controlled_reference_id);
      if (!controlled.length) throw AppError.conflict('Ward indent has no controlled lines');
      const controlledIds = new Set(controlled.map((item) => Number(item.id)));
      for (const itemId of evidenceByItem.keys()) {
        if (!controlledIds.has(itemId)) {
          throw AppError.badRequest(`Item evidence ${itemId} is not a controlled line on this indent`);
        }
      }
      const pendingEvidence = await loadPendingControlledHandoffEvidence(tx, current);
      const pendingEvidenceByItem = new Map(
        pendingEvidence.map((candidate) => [Number(candidate.item_id), candidate]),
      );
      const corruptEvidence = pendingEvidence.filter(
        (candidate) => candidate.status === 'corrupt',
      );
      if (corruptEvidence.length) {
        throw AppError.conflict(
          'Controlled custody evidence conflicts with the ward allocation; external reconciliation is required',
          'WARD_INDENT_CONTROLLED_CUSTODY_RECONCILIATION_REQUIRED',
          {
            reconciliation_gate: 'external_controlled_custody_reconciliation_required',
            items: corruptEvidence,
          },
        );
      }
      const unselectedRecovery = pendingEvidence.filter((candidate) => (
        candidate.status === 'available'
        && !recoveryByItem.has(Number(candidate.item_id))
      ));
      if (unselectedRecovery.length) {
        throw AppError.conflict(
          'Historical controlled custody requires an explicit pharmacy in-charge selection',
          'WARD_INDENT_CONTROLLED_RECOVERY_SELECTION_REQUIRED',
          { items: unselectedRecovery },
        );
      }
      for (const [itemId, selection] of recoveryByItem) {
        const candidate = pendingEvidenceByItem.get(itemId);
        if (candidate?.status !== 'available'
          || candidate.movement_id !== selection.movement_id
          || candidate.register_id !== selection.register_id) {
          throw AppError.conflict(
            'Historical controlled custody selection does not identify the one recoverable pair',
            'WARD_INDENT_CONTROLLED_RECOVERY_SELECTION_INVALID',
            {
              item_id: itemId,
              selected_movement_id: selection.movement_id,
              selected_register_id: selection.register_id,
              evidence: candidate || null,
            },
          );
        }
      }
      const closure = await loadWardIndentMedicationClosureTx(
        tx,
        current.tenant_id,
        current.id,
      );
      let recoverySupervisor = null;
      if (recoveryByItem.size) {
        recoverySupervisor = await assertWardControlledRecoverySupervisorTx(tx, {
          indent: current,
          actorUid: recordedBy,
          actorRole,
        });
        await assertWardIndentMedicationBindingAtIssueTx(tx, current);
      }
      let recoveredControlledItemCount = 0;
      let createdControlledItemCount = 0;
      const recoveryReceipts = [];
      for (const item of controlled) {
        const evidence = evidenceByItem.get(Number(item.id));
        if (!evidence) throw AppError.badRequest(`Controlled evidence is required for item ${item.id}`);
        const allocations = closure.allocations.filter((allocation) => (
          Number(allocation.ward_indent_item_id) === Number(item.id)
          && ['reserved', 'partially_issued'].includes(String(allocation.status))
          && Number(allocation.reserved_quantity)
            - Number(allocation.issued_quantity || 0)
            - Number(allocation.authority_released_quantity || 0) > 0
        ));
        if (allocations.length !== 1) {
          throw AppError.conflict(
            `Controlled ward indent item ${item.id} must have one exact active allocation`,
            'WARD_INDENT_CONTROLLED_ALLOCATION_MISMATCH',
            { item_id: Number(item.id), allocation_count: allocations.length },
          );
        }
        const allocation = allocations[0];
        const outstanding = Number(allocation.reserved_quantity)
          - Number(allocation.issued_quantity || 0)
          - Number(allocation.authority_released_quantity || 0);
        if (Math.abs(outstanding - Number(item.quantity_approved)) > 1e-9) {
          throw AppError.conflict(
            `Controlled ward indent item ${item.id} allocation quantity changed`,
            'WARD_INDENT_EXACT_RESERVATION_MISMATCH',
          );
        }
        const pendingCandidate = pendingEvidenceByItem.get(Number(item.id));
        const recoverySelection = recoveryByItem.get(Number(item.id));
        let movementId;
        let registerId;
        if (pendingCandidate?.status === 'available') {
          if (String(pendingCandidate.allocation_id) !== String(allocation.id)) {
            throw AppError.conflict(
              'Historical controlled custody no longer matches the locked allocation',
              'WARD_INDENT_CONTROLLED_RECOVERY_SELECTION_INVALID',
              {
                item_id: Number(item.id),
                selected_allocation_id: pendingCandidate.allocation_id,
                locked_allocation_id: String(allocation.id),
              },
            );
          }
          movementId = Number(pendingCandidate.movement_id);
          registerId = Number(pendingCandidate.register_id);
          recoveredControlledItemCount += 1;
        } else {
          const controlledResult = await dispenseWardControlledAllocationTx(tx, {
            tenantId: current.tenant_id,
            facilityId: Number(current.facility_id),
            indentId: Number(current.id),
            wardItemId: Number(item.id),
            allocationId: allocation.id,
            inventoryItemId: Number(allocation.inventory_item_id),
            inventoryBatchId: Number(allocation.inventory_batch_id),
            quantity: outstanding,
            patientUid: current.patient_uid,
            clinicalOrderId: item.clinical_order_id,
            catalogId: item.pharmacy_catalog_id,
            referenceId: item.controlled_reference_id,
            performedBy: recordedBy,
            witnessApprovalId: evidence.witness_approval_id || null,
            commandKey,
            wardAuthority: WARD_CONTROLLED_HANDOFF_AUTHORITY,
          });
          movementId = Number(controlledResult.movement.id);
          registerId = Number(controlledResult.register_entry.id);
          createdControlledItemCount += 1;
        }
        await linkControlledWardIndentMovementTx(tx, {
          indent: current,
          wardItem: item,
          movementId,
          controlledRegisterId: registerId,
          purpose: 'issue',
          actor: recordedBy,
          commandKey,
          stateVersion: Number(current.state_version) + 1,
        });
        if (recoverySelection) {
          recoveryReceipts.push(controlledRecoveryReceipt({
            indent: current,
            item,
            allocation,
            candidate: pendingCandidate,
            selection: recoverySelection,
            supervisor: recoverySupervisor,
            commandKey,
          }));
        }
        await tx.ward_indent_items.update({
          where: { id: item.id },
          data: {
            controlled_movement_id: movementId,
            controlled_register_id: registerId,
            quantity_issued: Number(item.quantity_approved),
            fulfilment_status: 'controlled_handoff_recorded',
            updated_at: new Date(),
          },
        });
      }
      return {
        toStatus: 'approved',
        details: {
          controlled_item_count: controlled.length,
          recovered_controlled_item_count: recoveredControlledItemCount,
          created_controlled_item_count: createdControlledItemCount,
          controlled_recovery_receipts: recoveryReceipts,
        },
      };
    },
  });
}

function linkedClinicalOrderIds(items) {
  return [...new Set(items
    .map((item) => Number(item.clinical_order_id))
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
}

function wardMedicationOrderDetails(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function wardMedicationOrderCatalogId(details) {
  const value = details.catalog_id ?? details.catalogId;
  const id = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())
      ? Number(value.trim())
      : null;
  return Number.isSafeInteger(id) && id > 0 && id <= PG_INT4_MAX ? id : null;
}

function wardMedicationOrderQuantity(details) {
  const value = String(details.quantity_requested ?? '').trim();
  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(value)) return null;
  const quantityValue = Number(value);
  return Number.isFinite(quantityValue)
    && quantityValue > 0
    && quantityValue <= 99999999.99
    ? quantityValue
    : null;
}

function wardMedicationOrderUnit(details) {
  const value = details.unit;
  const unitValue = String(value ?? '').trim();
  return unitValue || null;
}

function normalizedWardMedicationUnit(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function assertWardIndentMedicationBindingAtIssueTx(tx, current) {
  const catalogIds = current.items
    .flatMap((item) => [
      Number(item.pharmacy_catalog_id),
      Number(item.original_pharmacy_catalog_id),
    ])
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  const catalogById = await loadWardIndentCatalogClassificationsTx(tx, {
    tenantId: current.tenant_id,
    catalogIds,
    lock: true,
  });
  const medicationItems = current.items.filter((item) => (
    current.indent_type === 'pharmacy'
    || item.clinical_order_id != null
    || catalogById.get(Number(item.pharmacy_catalog_id))?.is_medication_identity === true
  ));
  if (!medicationItems.length) {
    return { clinicalOrderIds: [], substitutionCompatibilityEvidence: [] };
  }
  if (medicationItems.length !== current.items.length) {
    throw AppError.conflict(
      'Medication and non-medication ward-stock lines cannot share one indent',
      'WARD_INDENT_MIXED_CLINICAL_CLASSIFICATION',
    );
  }
  for (const item of medicationItems) {
    const catalogId = Number(item.pharmacy_catalog_id);
    if (catalogById.get(catalogId)?.is_medication_identity !== true) {
      throw AppError.conflict(
        `Ward-indent catalog ${catalogId} is no longer classified as medication`,
        'WARD_INDENT_MEDICATION_CATALOG_CLASSIFICATION_MISMATCH',
        { ward_indent_item_id: Number(item.id), catalog_id: catalogId },
      );
    }
  }
  if (current.indent_type !== 'pharmacy') {
    throw AppError.conflict(
      'Medication catalog lines must be persisted as a pharmacy ward indent',
      'WARD_INDENT_MEDICATION_TYPE_MISMATCH',
    );
  }
  const clinicalOrderIds = linkedClinicalOrderIds(medicationItems);
  if (clinicalOrderIds.length !== medicationItems.length) {
    throw AppError.conflict(
      'Every medication ward-indent line must remain bound to a clinical order',
      'WARD_INDENT_CLINICAL_ORDER_REQUIRED',
    );
  }
  if (current.admission_id == null) {
    throw AppError.conflict(
      'Medication ward indents require an active inpatient admission',
      'WARD_INDENT_ADMISSION_REQUIRED',
    );
  }
  const admissions = await tx.$queryRawUnsafe(
    `SELECT admission.id, admission.status, admission.patient_uid::text,
            admission.encounter_id::text, bed.ward_id
       FROM admissions admission
       LEFT JOIN beds bed
         ON bed.tenant_id = admission.tenant_id
        AND bed.id = admission.bed_id
      WHERE admission.tenant_id = $1::uuid
        AND admission.id = $2::int
      FOR SHARE OF admission`,
    current.tenant_id,
    Number(current.admission_id),
  );
  const admission = admissions[0];
  if (!admission) {
    throw AppError.conflict(
      'Medication ward-indent admission is unavailable',
      'WARD_INDENT_ADMISSION_NOT_FOUND',
    );
  }
  if (!['admitted', 'transferred'].includes(
    String(admission.status || '').trim().toLowerCase(),
  )) {
    throw AppError.conflict(
      'Medication ward-indent admission is no longer active',
      'WARD_INDENT_ADMISSION_INACTIVE',
      { admission_id: Number(admission.id), status: admission.status || null },
    );
  }
  if (
    !admission.patient_uid
    || !admission.encounter_id
    || admission.ward_id == null
    || String(admission.patient_uid) !== String(current.patient_uid)
    || String(admission.encounter_id) !== String(current.encounter_id)
    || Number(admission.ward_id) !== Number(current.ward_id)
  ) {
    throw AppError.conflict(
      'Medication ward-indent context no longer matches its active admission',
      'WARD_INDENT_ADMISSION_CONTEXT_MISMATCH',
    );
  }
  const orders = await tx.$queryRawUnsafe(
    `SELECT clinical_order.id, clinical_order.patient_uid::text,
             clinical_order.encounter_id::text, clinical_order.order_type,
             clinical_order.status, clinical_order.verified_by::text,
             clinical_order.verified_at, clinical_order.details
       FROM clinical_orders clinical_order
      WHERE clinical_order.tenant_id = $1::uuid
        AND clinical_order.id = ANY($2::int[])
       ORDER BY clinical_order.id
       FOR UPDATE OF clinical_order`,
    current.tenant_id,
    clinicalOrderIds,
  );
  const orderById = new Map(orders.map((order) => [Number(order.id), order]));
  const substitutionCompatibilityEvidence = [];
  const approvedSubstitutionRows = await tx.$queryRawUnsafe(
    `SELECT details
       FROM ward_indent_events
      WHERE tenant_id = $1::uuid
        AND ward_indent_id = $2::int
        AND action = 'substitution_approved'
      ORDER BY state_version DESC
      LIMIT 1
      FOR SHARE`,
    current.tenant_id,
    Number(current.id),
  );
  const approvedSubstitutionEvidence = new Map(
    (Array.isArray(approvedSubstitutionRows[0]?.details?.medication_substitution_compatibility)
      ? approvedSubstitutionRows[0].details.medication_substitution_compatibility
      : [])
      .map((evidence) => [Number(evidence?.item_id), evidence]),
  );
  for (const item of medicationItems) {
    const clinicalOrderId = Number(item.clinical_order_id);
    const order = orderById.get(clinicalOrderId);
    if (!order || order.order_type !== 'medication') {
      throw AppError.conflict(
        `Medication clinical order ${clinicalOrderId} is unavailable at issue`,
        'MEDICATION_ORDER_EXECUTION_ORDER_NOT_FOUND',
        { clinical_order_id: clinicalOrderId },
      );
    }
    const orderStatus = String(order.status || '').trim().toLowerCase();
    if (!['verified', 'in_progress'].includes(orderStatus)) {
      throw AppError.conflict(
        `Medication clinical order ${clinicalOrderId} is not verified and active at issue`,
        'MEDICATION_ORDER_VERIFICATION_REQUIRED',
        { clinical_order_id: clinicalOrderId, status: order.status || null },
      );
    }
    if (!order.verified_by || !order.verified_at) {
      throw AppError.conflict(
        `Medication clinical order ${clinicalOrderId} lacks dedicated verification evidence`,
        'MEDICATION_ORDER_VERIFICATION_EVIDENCE_REQUIRED',
        { clinical_order_id: clinicalOrderId, status: order.status || null },
      );
    }
    if (String(order.patient_uid) !== String(admission.patient_uid)) {
      throw AppError.conflict(
        `Clinical order ${clinicalOrderId} no longer matches the admission patient`,
        'WARD_INDENT_CLINICAL_ORDER_PATIENT_MISMATCH',
      );
    }
    if (
      !order.encounter_id
      || String(order.encounter_id) !== String(admission.encounter_id)
    ) {
      throw AppError.conflict(
        `Clinical order ${clinicalOrderId} no longer matches the admission encounter`,
        'WARD_INDENT_CLINICAL_ORDER_ENCOUNTER_MISMATCH',
      );
    }
    const details = wardMedicationOrderDetails(order.details);
    const expectedCatalogId = wardMedicationOrderCatalogId(details);
    if (expectedCatalogId == null) {
      throw AppError.conflict(
        `Clinical order ${clinicalOrderId} has no authoritative formulary catalog`,
        'WARD_INDENT_CLINICAL_ORDER_CATALOG_REQUIRED',
      );
    }
    bindMedicationOrderCatalogAuthority(
      details,
      catalogById.get(expectedCatalogId),
      { phase: 'issue' },
    );
    const currentCatalogId = Number(item.pharmacy_catalog_id);
    const originalCatalogId = Number(item.original_pharmacy_catalog_id);
    const substitutionApproved = String(item.substitution_status || '').trim().toLowerCase()
      === 'approved';
    const approvedSubstitutionEvidenceComplete = substitutionApproved
      && originalCatalogId === expectedCatalogId
      && Number(item.proposed_pharmacy_catalog_id) === currentCatalogId
      && item.substitution_proposed_by != null
      && item.substitution_proposed_at != null
      && String(item.substitution_reason || '').trim() !== ''
      && item.substitution_decided_by != null
      && item.substitution_decided_at != null
      && catalogById.get(currentCatalogId)?.is_medication_identity === true;
    if (currentCatalogId !== expectedCatalogId && approvedSubstitutionEvidenceComplete) {
      const compatibility = assertWardMedicationSubstitutionCompatibility({
        item,
        originalCatalog: catalogById.get(originalCatalogId),
        substituteCatalog: catalogById.get(currentCatalogId),
        phase: 'issue',
      });
      const approvedEvidence = approvedSubstitutionEvidence.get(Number(item.id));
      if (
        !compatibility
        || !approvedEvidence
        || !approvedEvidence.provenance_sha256
        || approvedEvidence.provenance_sha256 !== compatibility.provenance_sha256
      ) {
        throw AppError.conflict(
          `Approved medication substitution evidence changed before issue for item ${Number(item.id)}`,
          'WARD_INDENT_MEDICATION_SUBSTITUTION_PROVENANCE_MISMATCH',
          {
            item_id: Number(item.id),
            approved_provenance_sha256: approvedEvidence?.provenance_sha256 || null,
            issue_provenance_sha256: compatibility?.provenance_sha256 || null,
          },
        );
      }
      substitutionCompatibilityEvidence.push(compatibility);
    }
    if (currentCatalogId !== expectedCatalogId && !approvedSubstitutionEvidenceComplete) {
      throw AppError.conflict(
        `Ward-indent catalog no longer matches clinical order ${clinicalOrderId}`,
        'WARD_INDENT_CLINICAL_ORDER_CATALOG_MISMATCH',
        {
          clinical_order_id: clinicalOrderId,
          ordered_catalog_id: expectedCatalogId,
          ward_catalog_id: currentCatalogId,
          substitution_status: item.substitution_status || null,
        },
      );
    }
    const expectedQuantity = wardMedicationOrderQuantity(details);
    if (expectedQuantity == null) {
      throw AppError.conflict(
        `Clinical order ${clinicalOrderId} has no authoritative ward-supply quantity`,
        'WARD_INDENT_CLINICAL_ORDER_QUANTITY_REQUIRED',
      );
    }
    if (Math.abs(Number(item.quantity_requested) - expectedQuantity) > Number.EPSILON) {
      throw AppError.conflict(
        `Ward-indent quantity no longer matches clinical order ${clinicalOrderId}`,
        'WARD_INDENT_CLINICAL_ORDER_QUANTITY_MISMATCH',
      );
    }
    const expectedUnit = wardMedicationOrderUnit(details);
    if (!expectedUnit) {
      throw AppError.conflict(
        `Clinical order ${clinicalOrderId} has no authoritative ward-supply unit`,
        'WARD_INDENT_CLINICAL_ORDER_UNIT_REQUIRED',
      );
    }
    if (normalizedWardMedicationUnit(item.unit) !== normalizedWardMedicationUnit(expectedUnit)) {
      throw AppError.conflict(
        `Ward-indent unit no longer matches clinical order ${clinicalOrderId}`,
        'WARD_INDENT_CLINICAL_ORDER_UNIT_MISMATCH',
      );
    }
    const progressedRows = await tx.$queryRawUnsafe(
      `UPDATE clinical_orders
          SET status = status
        WHERE tenant_id = $1::uuid
          AND id = $2::int
          AND order_type = 'medication'
          AND lower(status) IN ('verified', 'in_progress')
          AND verified_by IS NOT NULL
          AND verified_at IS NOT NULL
        RETURNING id, status`,
      current.tenant_id,
      clinicalOrderId,
    );
    if (progressedRows.length !== 1) {
      throw AppError.conflict(
        `Medication clinical order ${clinicalOrderId} changed before issue`,
        'MEDICATION_ORDER_EXECUTION_STATE_CONFLICT',
        { clinical_order_id: clinicalOrderId },
      );
    }
  }
  await assertMedicationOrdersExecutionReadyTx(tx, {
    tenantId: current.tenant_id,
    clinicalOrderIds,
  });
  return { clinicalOrderIds, substitutionCompatibilityEvidence };
}

export async function issueWardIndent({
  indentId,
  issuedBy,
  itemQuantitiesIssued = null,
  expectedVersion = null,
  commandKey = null,
  tenantId,
  actorRole = null,
}) {
  return applyTransition({
    indentId,
    tenantId,
    actorUid: issuedBy,
    actorRole,
    facilityGrantRequired: true,
    expectedVersion,
    commandKey,
    action: 'issued',
    allowedStatuses: ['approved'],
    mutate: async (tx, current) => {
      const {
        clinicalOrderIds,
        substitutionCompatibilityEvidence,
      } = await assertWardIndentMedicationBindingAtIssueTx(tx, current);
      const issuedMap = itemEntryMap(
        itemQuantitiesIssued,
        'quantity_issued',
        current.items,
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
      }
      const inventoryClosure = await issueWardIndentInventoryTx(tx, {
        indent: current,
        issuedBy,
        commandKey,
        nextStateVersion: Number(current.state_version) + 1,
      });
      for (const item of current.items) {
        const issuedQuantity = Number(item.quantity_approved);
        await tx.ward_indent_items.update({
          where: { id: item.id },
          data: {
            quantity_issued: issuedQuantity,
            fulfilment_status: 'issued',
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
        details: {
          verified_clinical_order_ids: clinicalOrderIds,
          medication_substitution_compatibility: substitutionCompatibilityEvidence,
          inventory_movement_ids: inventoryClosure.movementIds,
          billing_invoice_id: inventoryClosure.invoice == null
            ? null
            : Number(inventoryClosure.invoice.id),
        },
        afterEvidence: async ({ event }) => {
          await appendWardIndentChargeEventsTx(tx, {
            indent: current,
            wardEvent: event,
            issuedBy,
            commandKey,
            chargePlans: inventoryClosure.chargePlans,
          });
        },
      };
    },
  });
}

export async function receiveWardIndent({
  indentId,
  receivedBy,
  itemQuantitiesReceived = null,
  substitutionAcknowledgements = null,
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
      const desiredReceivedByItem = new Map();
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
        desiredReceivedByItem.set(Number(item.id), desired);
      }
      if (!progressed) throw AppError.conflict('Receipt command made no quantity progress');
      await receiveWardIndentInventoryTx(tx, {
        indent: current,
        receivedBy,
        commandKey,
        desiredReceivedByItem,
        substitutionAcknowledgements,
        nextStateVersion: Number(current.state_version) + 1,
      });
      for (const item of current.items) {
        const issuedQuantity = Number(item.quantity_issued || 0);
        const desired = desiredReceivedByItem.get(Number(item.id));
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
      await assertNoOpenWardAllocationAuthorityRecoveryTx(tx, {
        tenantId: current.tenant_id,
        wardIndentId: current.id,
      });
      const returnMap = itemEntryMap(
        itemQuantitiesReturned,
        'quantity_returned',
        current.items,
        { required: true, allowZero: true },
      );
      const medicationClosure = await loadWardIndentMedicationClosureTx(
        tx,
        current.tenant_id,
        current.id,
      );
      const consumedByItem = new Map();
      for (const allocation of medicationClosure.allocations) {
        const itemId = Number(allocation.ward_indent_item_id);
        consumedByItem.set(
          itemId,
          (consumedByItem.get(itemId) || 0) + Number(allocation.consumed_quantity || 0),
        );
      }
      let requestedCount = 0;
      for (const item of current.items) {
        const desired = returnMap.has(item.id)
          ? returnMap.get(item.id)
          : Number(item.quantity_return_requested || 0);
        const receivedQuantity = Number(item.quantity_received || 0);
        const returnedQuantity = Number(item.quantity_returned || 0);
        const returnCeiling = receivedQuantity - (consumedByItem.get(Number(item.id)) || 0);
        if (desired < returnedQuantity || desired > returnCeiling) {
          throw AppError.badRequest(
            `Item ${item.id} return quantity must be between ${returnedQuantity} and ${returnCeiling}`,
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
  itemReconciliations = null,
  allocationReturns = null,
  expectedVersion = null,
  commandKey = null,
  tenantId,
  actorRole = null,
}) {
  const cleanReason = reasonText(reason, 'reconciliation reason');
  return applyTransition({
    indentId,
    tenantId,
    actorUid: reconciledBy,
    actorRole,
    facilityGrantRequired: String(actorRole || '').toUpperCase() === 'PHARMACY_INCHARGE',
    expectedVersion,
    commandKey,
    reason: cleanReason,
    action: 'reconciled',
    allowedStatuses: ['return_pending', 'reconciliation_required'],
    mutate: async (tx, current) => {
      await assertNoOpenWardAllocationAuthorityRecoveryTx(tx, {
        tenantId: current.tenant_id,
        wardIndentId: current.id,
      });
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
      const inventoryReturn = await returnWardIndentInventoryTx(tx, {
        indent: current,
        returnedBy: reconciledBy,
        commandKey,
        nextStateVersion: Number(current.state_version) + 1,
        allocationReturns,
      });
      const controlledReturnReferences = [...inventoryReturn.controlledByItem.entries()]
        .map(([itemId, evidence]) => ({
          item_id: Number(itemId),
          movement_id: evidence.movementId,
          register_id: evidence.registerId,
        }));
      const returnedItemCount = inventoryReturn.returnPlans.length;
      let varianceItemCount = 0;
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
        const controlledReturn = inventoryReturn.controlledByItem.get(Number(item.id)) || null;
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
      }
      await tx.ward_indent_items.updateMany({
        where: { ward_indent_id: current.id, tenant_id: current.tenant_id },
        data: { fulfilment_status: 'reconciled', updated_at: new Date() },
      });
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
          inventory_movement_ids: inventoryReturn.movementIds,
        },
        afterEvidence: async ({ event }) => {
          await appendWardIndentCreditEventsTx(tx, {
            indent: current,
            wardEvent: event,
            returnedBy: reconciledBy,
            commandKey,
            returnPlans: inventoryReturn.returnPlans,
            reason: cleanReason,
          });
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
      await releaseWardIndentReservationsTx(tx, {
        indent: current,
        releasedBy: cancelledBy,
        reason: cleanReason,
      });
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

const TERMINAL_CREDIT_NOTE_STATUSES = new Set(['applied', 'rejected']);
const TERMINAL_SLA_STATUSES = new Set(['completed', 'breached', 'escalated']);

function reconciliationFailure({ financialEvent, creditNote = null, reason }) {
  return {
    financial_event_id: String(financialEvent.id),
    credit_note_id: creditNote?.id == null ? null : String(creditNote.id),
    refund_id: creditNote?.refund_id == null ? null : Number(creditNote.refund_id),
    reason,
  };
}

async function assertWardIndentFinancialReconciliationCompleteTx(tx, indent) {
  const financialEvents = await tx.$queryRawUnsafe(
    `SELECT id, invoice_id
       FROM ward_indent_financial_events
      WHERE tenant_id = $1::uuid
        AND ward_indent_id = $2::int
        AND event_kind = 'credit'
      ORDER BY id
      FOR UPDATE`,
    String(indent.tenant_id),
    Number(indent.id),
  );
  const outstanding = [];

  for (const financialEvent of financialEvents) {
    const initialCreditNotes = await tx.$queryRawUnsafe(
      `SELECT id, status, task_id, refund_obligation_minor, refund_id
         FROM billing_credit_notes
        WHERE tenant_id = $1::uuid
          AND source_financial_event_id = $2::bigint
        LIMIT 1`,
      String(indent.tenant_id),
      BigInt(financialEvent.id),
    );
    const initialCreditNote = initialCreditNotes[0] || null;
    const refunds = initialCreditNote?.refund_id == null
      ? []
      : await tx.$queryRawUnsafe(
        `SELECT id, approval_status, paid_at, payout_rail
           FROM billing_refunds
          WHERE tenant_id = $1::uuid
            AND id = $2::int
          LIMIT 1
          FOR UPDATE`,
        String(indent.tenant_id),
        Number(initialCreditNote.refund_id),
      );
    const lockedRefund = refunds[0] || null;
    const creditNotes = await tx.$queryRawUnsafe(
      `SELECT id, status, task_id, refund_obligation_minor, refund_id
         FROM billing_credit_notes
        WHERE tenant_id = $1::uuid
          AND source_financial_event_id = $2::bigint
        LIMIT 1
        FOR UPDATE`,
      String(indent.tenant_id),
      BigInt(financialEvent.id),
    );
    const creditNote = creditNotes[0] || null;
    if (!creditNote) {
      if (financialEvent.invoice_id != null) {
        outstanding.push(reconciliationFailure({
          financialEvent,
          reason: 'credit_note_missing',
        }));
      }
      continue;
    }
    if (String(initialCreditNote?.refund_id || '') !== String(creditNote.refund_id || '')) {
      outstanding.push(reconciliationFailure({
        financialEvent,
        creditNote,
        reason: 'financial_reconciliation_state_changed',
      }));
      continue;
    }
    if (!TERMINAL_CREDIT_NOTE_STATUSES.has(creditNote.status)) {
      outstanding.push(reconciliationFailure({
        financialEvent,
        creditNote,
        reason: `credit_note_${creditNote.status}`,
      }));
      continue;
    }
    if (creditNote.task_id == null) {
      outstanding.push(reconciliationFailure({
        financialEvent,
        creditNote,
        reason: 'credit_note_task_missing',
      }));
      continue;
    }

    const tasks = await tx.$queryRawUnsafe(
      `SELECT id, status, completed_at, workflow_sla_instance_id,
              sla_completion_semantics, related_resource_type,
              related_resource_id, metadata
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND id = $2::int
        LIMIT 1
        FOR UPDATE`,
      String(indent.tenant_id),
      Number(creditNote.task_id),
    );
    const task = tasks[0] || null;
    if (
      !task
      || task.status !== 'completed'
      || !task.completed_at
      || !task.workflow_sla_instance_id
      || task.sla_completion_semantics !== 'domain_evidence'
      || task.related_resource_type !== 'billing_credit_notes'
      || String(task.related_resource_id || '') !== String(creditNote.id)
      || task.metadata?.task_contract !== 'ward_medication_obligation_v1'
      || task.metadata?.obligation_kind !== 'credit_note_review'
      || String(task.metadata?.credit_note_id || '') !== String(creditNote.id)
    ) {
      outstanding.push(reconciliationFailure({
        financialEvent,
        creditNote,
        reason: 'credit_note_task_nonterminal',
      }));
      continue;
    }

    const slas = await tx.$queryRawUnsafe(
      `SELECT id, status, completed_at, rule_code, source_table, source_id, metadata
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
        LIMIT 1
        FOR UPDATE`,
      String(indent.tenant_id),
      String(task.workflow_sla_instance_id),
    );
    const sla = slas[0] || null;
    if (
      !sla
      || !sla.completed_at
      || !TERMINAL_SLA_STATUSES.has(sla.status)
      || sla.rule_code !== 'ward_indent_credit_note_review'
      || sla.source_table !== 'billing_credit_notes'
      || String(sla.source_id || '') !== String(creditNote.id)
      || sla.metadata?.completed_via !== 'domain_evidence'
    ) {
      outstanding.push(reconciliationFailure({
        financialEvent,
        creditNote,
        reason: 'credit_note_sla_nonterminal',
      }));
      continue;
    }

    let evidenceKind;
    let evidenceResourceType;
    let evidenceResourceId;
    if (creditNote.status === 'rejected') {
      const events = await tx.$queryRawUnsafe(
        `SELECT id
           FROM billing_credit_note_events
          WHERE tenant_id = $1::uuid
            AND credit_note_id = $2::bigint
            AND event_type = 'rejected'
          LIMIT 1`,
        String(indent.tenant_id),
        BigInt(creditNote.id),
      );
      evidenceKind = 'billing_credit_note_decision';
      evidenceResourceType = 'billing_credit_note_event';
      evidenceResourceId = events[0]?.id == null ? null : String(events[0].id);
    } else if (Number(creditNote.refund_obligation_minor || 0) > 0) {
      if (
        !lockedRefund
        || lockedRefund.approval_status !== 'PAID'
        || !lockedRefund.paid_at
        || !lockedRefund.payout_rail
      ) {
        outstanding.push(reconciliationFailure({
          financialEvent,
          creditNote,
          reason: 'refund_nonterminal',
        }));
        continue;
      }
      evidenceKind = 'billing_credit_note_refund_paid';
      evidenceResourceType = 'billing_refund';
      evidenceResourceId = String(lockedRefund.id);
    } else {
      const events = await tx.$queryRawUnsafe(
        `SELECT id
           FROM billing_credit_note_events
          WHERE tenant_id = $1::uuid
            AND credit_note_id = $2::bigint
            AND event_type = 'applied'
          LIMIT 1`,
        String(indent.tenant_id),
        BigInt(creditNote.id),
      );
      evidenceKind = 'billing_credit_note_application';
      evidenceResourceType = 'billing_credit_note_event';
      evidenceResourceId = events[0]?.id == null ? null : String(events[0].id);
    }
    const completionEvidence = sla.metadata?.completion_evidence;
    if (
      !evidenceResourceId
      || completionEvidence?.kind !== evidenceKind
      || completionEvidence?.resource_type !== evidenceResourceType
      || String(completionEvidence?.resource_id || '') !== evidenceResourceId
    ) {
      outstanding.push(reconciliationFailure({
        financialEvent,
        creditNote,
        reason: 'financial_reconciliation_evidence_incomplete',
      }));
    }
  }

  if (outstanding.length > 0) {
    throw AppError.conflict(
      'Ward indent cannot close until linked credits, refunds, tasks, and SLAs are terminal',
      'WARD_INDENT_FINANCIAL_RECONCILIATION_REQUIRED',
      { outstanding },
    );
  }
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
      await assertNoOpenWardAllocationAuthorityRecoveryTx(tx, {
        tenantId: current.tenant_id,
        wardIndentId: current.id,
      });
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
      await assertWardIndentFinancialReconciliationCompleteTx(tx, current);
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
  worklist = null,
  beforeRequestedAt = null,
  beforeId = null,
  actorRoleCodes = [],
  limit = 50,
  tenantId,
} = {}) {
  const page = await listWardIndentPage({
    wardId,
    status,
    admissionId,
    patientUid,
    overdueOnly,
    worklist,
    beforeRequestedAt,
    beforeId,
    actorRoleCodes,
    limit,
    tenantId,
  });
  return page.items;
}

function wardIndentCursor(beforeRequestedAt, beforeId) {
  const hasTimestamp = beforeRequestedAt != null && String(beforeRequestedAt).trim() !== '';
  const hasId = beforeId != null && String(beforeId).trim() !== '';
  if (hasTimestamp !== hasId) {
    throw AppError.badRequest(
      'before_requested_at and before_id must be supplied together',
      'WARD_INDENT_CURSOR_INCOMPLETE',
    );
  }
  if (!hasTimestamp) return null;
  const timestamp = String(beforeRequestedAt).trim();
  const requestedAt = new Date(timestamp);
  if (!ISO_INSTANT_RE.test(timestamp) || Number.isNaN(requestedAt.getTime())) {
    throw AppError.badRequest(
      'before_requested_at must be an ISO-8601 timestamp',
      'WARD_INDENT_CURSOR_INVALID',
    );
  }
  return {
    requestedAt,
    id: positiveInt(beforeId, 'before_id'),
  };
}

function wardIndentOwnerWhere(worklist, actorRoleCodes) {
  if (worklist !== 'owned') return {};
  const roles = [...new Set(
    (Array.isArray(actorRoleCodes) ? actorRoleCodes : [actorRoleCodes])
      .map((role) => String(role || '').trim().toUpperCase())
      .filter(Boolean),
  )];
  if (!roles.length) {
    throw AppError.forbidden(
      'Authenticated role required for owned ward indent worklist',
      'WARD_INDENT_OWNER_ROLE_REQUIRED',
    );
  }
  return { owner_role_codes: { hasSome: roles } };
}

function wardIndentCursorWhere(cursor) {
  if (!cursor) return {};
  return {
    OR: [
      { requested_at: { lt: cursor.requestedAt } },
      { requested_at: cursor.requestedAt, id: { lt: cursor.id } },
    ],
  };
}

function wardIndentStateWhere({ status, worklist, overdueOnly }) {
  if (status && worklist) {
    throw AppError.badRequest(
      'status and worklist cannot be combined',
      'WARD_INDENT_FILTER_CONFLICT',
    );
  }
  if (overdueOnly && worklist && worklist !== 'overdue') {
    throw AppError.badRequest(
      'overdue_only cannot be combined with another worklist',
      'WARD_INDENT_FILTER_CONFLICT',
    );
  }
  if (worklist && !WARD_INDENT_WORKLISTS.has(worklist)) {
    throw AppError.badRequest(
      `Unknown ward indent worklist '${worklist}'`,
      'WARD_INDENT_WORKLIST_INVALID',
    );
  }
  if (status) return { status };
  if (worklist === 'terminal') {
    return { status: { in: TERMINAL_WARD_INDENT_STATUSES } };
  }
  if (overdueOnly || ['open', 'owned', 'overdue'].includes(worklist)) {
    return { status: { notIn: TERMINAL_WARD_INDENT_STATUSES } };
  }
  return {};
}

async function enrichWardIndentRows(tx, rows, { overdueOnly }) {
  if (!rows.length) return [];
  const sourceIds = rows
    .map((row) => row.active_sla_source_id)
    .filter(Boolean);
  const slas = sourceIds.length
    ? await tx.workflow_sla_instances.findMany({
        where: {
          tenant_id: rows[0].tenant_id,
          source_table: 'ward_indents',
          source_id: { in: sourceIds },
          status: {
            in: overdueOnly ? ['breached', 'escalated'] : ['active', 'breached', 'escalated'],
          },
          completed_at: null,
        },
        orderBy: { started_at: 'desc' },
      })
    : [];
  const slaByIndent = new Map();
  for (const sla of slas) {
    if (!slaByIndent.has(sla.source_id)) slaByIndent.set(sla.source_id, []);
    slaByIndent.get(sla.source_id).push(sla);
  }
  return rows.map((row) => ({
    ...row,
    workflow: {
      owner_role_codes: row.owner_role_codes || [],
      active_slas: slaByIndent.get(row.active_sla_source_id) || [],
    },
  }));
}

async function findOverdueWardIndentRows(tx, {
  tenantId,
  wardId,
  stateWhere,
  admissionId,
  patientUid,
  cursor,
  take,
}) {
  const params = [tenantId];
  const clauses = [
    'indent.tenant_id = $1::uuid',
    `EXISTS (
      SELECT 1
        FROM workflow_sla_instances sla
       WHERE sla.tenant_id = indent.tenant_id
         AND sla.source_table = 'ward_indents'
         AND sla.source_id = indent.active_sla_source_id
         AND sla.status IN ('breached', 'escalated')
         AND sla.completed_at IS NULL
    )`,
  ];
  const addParam = (value, cast) => {
    params.push(value);
    return `$${params.length}${cast}`;
  };
  if (wardId) clauses.push(`indent.ward_id = ${addParam(Number(wardId), '::int')}`);
  const state = stateWhere.status;
  if (typeof state === 'string') {
    clauses.push(`indent.status = ${addParam(state, '::text')}`);
  } else if (state?.in) {
    clauses.push(`indent.status = ANY(${addParam(state.in, '::text[]')})`);
  } else if (state?.notIn) {
    clauses.push(`NOT (indent.status = ANY(${addParam(state.notIn, '::text[]')}))`);
  }
  if (admissionId) {
    clauses.push(`indent.admission_id = ${addParam(Number(admissionId), '::int')}`);
  }
  if (patientUid) {
    clauses.push(`indent.patient_uid = ${addParam(patientUid, '::uuid')}`);
  }
  if (cursor) {
    const timestampParam = addParam(cursor.requestedAt, '::timestamptz');
    const idParam = addParam(cursor.id, '::int');
    clauses.push(`(indent.requested_at, indent.id) < (${timestampParam}, ${idParam})`);
  }
  const limitParam = addParam(take, '::int');
  const ids = await tx.$queryRawUnsafe(
    `SELECT indent.id
       FROM ward_indents indent
      WHERE ${clauses.join('\n        AND ')}
      ORDER BY indent.requested_at DESC, indent.id DESC
      LIMIT ${limitParam}`,
    ...params,
  );
  if (!ids.length) return [];
  return tx.ward_indents.findMany({
    where: {
      tenant_id: tenantId,
      id: { in: ids.map((row) => Number(row.id)) },
    },
    orderBy: [{ requested_at: 'desc' }, { id: 'desc' }],
    include: { items: { orderBy: { id: 'asc' } } },
  });
}

function wardIndentNextCursor(items, hasMore) {
  if (!hasMore || items.length === 0) return null;
  const last = items.at(-1);
  return {
    before_requested_at: last.requested_at.toISOString(),
    before_id: last.id,
  };
}

export async function listWardIndentPage({
  wardId = null,
  status = null,
  admissionId = null,
  patientUid = null,
  overdueOnly = false,
  worklist = null,
  beforeRequestedAt = null,
  beforeId = null,
  actorRoleCodes = [],
  limit = 50,
  tenantId,
} = {}) {
  const tid = tenantOf(tenantId);
  const cleanPatientUid = patientUid ? uuid(patientUid, 'patient_uid') : null;
  if (status && !WARD_INDENT_STATE_CONTRACT[status]) {
    throw AppError.badRequest(`Unknown ward indent status '${status}'`);
  }
  const cleanWorklist = worklist ? String(worklist).trim().toLowerCase() : null;
  const effectiveOverdueOnly = overdueOnly || cleanWorklist === 'overdue';
  const initialCursor = wardIndentCursor(beforeRequestedAt, beforeId);
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  return setTenantTx(tid, async (tx) => {
    const stateWhere = wardIndentStateWhere({
      status,
      worklist: cleanWorklist,
      overdueOnly: effectiveOverdueOnly,
    });
    const baseWhere = {
      tenant_id: tid,
      ...(wardId ? { ward_id: Number(wardId) } : {}),
      ...stateWhere,
      ...wardIndentOwnerWhere(cleanWorklist, actorRoleCodes),
      ...(admissionId ? { admission_id: Number(admissionId) } : {}),
      ...(cleanPatientUid ? { patient_uid: cleanPatientUid } : {}),
    };
    const findRows = (cursor, take) => tx.ward_indents.findMany({
      where: {
        ...baseWhere,
        ...wardIndentCursorWhere(cursor),
      },
      orderBy: [{ requested_at: 'desc' }, { id: 'desc' }],
      take,
      include: { items: { orderBy: { id: 'asc' } } },
    });

    let enriched;
    if (!effectiveOverdueOnly) {
      const rows = await findRows(initialCursor, safeLimit + 1);
      enriched = await enrichWardIndentRows(tx, rows, { overdueOnly: false });
    } else {
      const rows = await findOverdueWardIndentRows(tx, {
        tenantId: tid,
        wardId,
        stateWhere,
        admissionId,
        patientUid: cleanPatientUid,
        cursor: initialCursor,
        take: safeLimit + 1,
      });
      enriched = await enrichWardIndentRows(tx, rows, { overdueOnly: true });
    }

    const hasMore = enriched.length > safeLimit;
    const items = enriched.slice(0, safeLimit);
    return {
      items,
      pagination: {
        has_more: hasMore,
        limit: safeLimit,
        ...wardIndentNextCursor(items, hasMore),
      },
    };
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
  applyApprovedWardIndentSubstitution,
  requestWardIndentControlledWitnessApproval,
  approveWardIndentControlledWitnessApproval,
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
  listWardIndentPage,
  getWardIndent,
};
