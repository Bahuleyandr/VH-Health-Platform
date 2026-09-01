/**
 * Pharmacy supply chain service (Phase C4).
 *
 * Manages the ten tables added in migration 123: suppliers, inventory
 * items + batches, POs + items, GRNs + items, stock movements, expiry
 * alerts, and substitution graph.
 *
 * Key business rules enforced here:
 *   - Stock movements ledger: every allowed receipt/increase appends a row
 *     and updates the matching batch balance in one transaction
 *   - Expiry alert generation (computeExpiryAlerts) with severity bands
 *     by days_remaining
 *   - Self-substitute prevention via DB CHECK + service-side guard
 *
 * Decision-support only: the substitution graph is informational; the
 * dispense flow uses it as a hint, not a hard auto-swap.
 */

import { createHash } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  lockControlledRegisterItemTx,
  recordMovementTx,
} from '../pharmacy/inventoryV2Service.js';
import { assertPharmacyFacilityGrant } from '../pharmacy/pharmacyFacilityAuthorityService.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const TEXT_MAX = 8000;
const SHORT_MAX = 255;

export const SUPPLIER_STATUSES = ['active', 'paused', 'blacklisted', 'archived'];
export const ITEM_STATUSES = ['active', 'paused', 'discontinued', 'archived'];
export const BATCH_STATUSES = ['in_stock', 'reserved', 'depleted', 'expired', 'recalled', 'quarantined', 'disposed'];
export const PO_STATUSES = ['draft', 'submitted', 'approved', 'partially_received', 'fully_received', 'cancelled', 'closed'];
export const GRN_STATUSES = [
  'received', 'qc_pending', 'qc_failed', 'qc_passed', 'partial',
  'closed', 'rejected', 'archived',
];
export const MOVEMENT_KINDS = [
  'receive', 'issue', 'transfer_out', 'transfer_in', 'return',
  'adjust_increase', 'adjust_decrease', 'dispose', 'expire', 'recall',
];
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_\-:.]{1,200}$/;
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
  return requireTenantId(options.tenantId);
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

// ---------------------------------------------------------------------------
// Controlled-substance discipline (Schedule H / H1 / X + narcotics)
//
// This service writes the SAME physical stock plane as inventoryV2Service
// (pharmacy_inventory_batches / pharmacy_stock_movements, migration 123), so
// it must honour the same statutory invariant (inventoryV2Service.js:640-649
// and the 2026-08-25 reaudit BC-H1 fix): a controlled substance never moves
// without its pharmacy_schedule_register row, controlled DECREMENTS only ever
// happen in a typed custody workflow, and a controlled issue belongs to a
// governed pharmacy-order, counter-sale, or ward medication flow. Until
// 2026-08-27 this router was the last register-bypass door (finding N1):
// /pharmacy-supply/stock-movements, the retired reserve-stock flow, and the
// GRN receive flow moved Schedule X stock with no schedule check, witness, or
// register row.
// ---------------------------------------------------------------------------

const CONTROLLED_SCHEDULES = ['H', 'H1', 'X'];
const CONTROLLED_CUSTODY_BATCH_STATUSES = Object.freeze([
  'in_stock', 'reserved', 'expired', 'recalled', 'quarantined',
]);
const SUPPLY_DECREASING_MOVEMENTS = new Set([
  'issue', 'transfer_out', 'adjust_decrease', 'dispose', 'expire', 'recall',
]);
const SUPPLY_INCREASING_MOVEMENTS = new Set([
  'receive', 'transfer_in', 'return', 'adjust_increase',
]);
// Custody events this router is allowed to record for controlled stock, mapped
// onto the register's own vocabulary (migration 150). Decrements are absent on
// purpose — typed issue and disposal workflows own their witness ceremony.
const SUPPLY_REGISTER_KIND_BY_MOVEMENT = Object.freeze({
  receive: 'receive',
  transfer_in: 'receive',
  return: 'return',
  adjust_increase: 'adjust',
});

function canonicalControlledScheduleClass(item) {
  if (item?.is_narcotic === true) return 'X';
  const scheduleClass = String(item?.schedule_class || '').trim().toUpperCase();
  return CONTROLLED_SCHEDULES.includes(scheduleClass) ? scheduleClass : null;
}

function isControlledSupplyItem(item) {
  return canonicalControlledScheduleClass(item) !== null;
}

async function loadSupplyMovementItem(db, tenantId, inventoryItemId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, facility_id, status, schedule_class, is_narcotic, unit_label
       FROM pharmacy_inventory_items
      WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(inventoryItemId),
    tenantId,
  );
  return rows[0] || null;
}

function refuseControlledSupplyDecrement(movementKind) {
  if (movementKind === 'issue') {
    throw AppError.conflict(
      'Controlled substances cannot be issued through pharmacy-supply; use the governed pharmacy-order, counter-sale, or ward medication workflow',
      'CONTROLLED_MOVEMENT_REQUIRES_DISPENSE_PATH',
    );
  }
  if (movementKind === 'dispose' || movementKind === 'expire') {
    throw AppError.conflict(
      'Controlled-substance disposal requires POST /api/v1/pharmacy/inventory/v2/disposals',
      'CONTROLLED_MOVEMENT_REQUIRES_REGISTER_PATH',
    );
  }
  if (movementKind === 'recall') {
    throw AppError.conflict(
      'A controlled batch recall is a status-only quarantine action; use the governed batch recall workflow',
      'CONTROLLED_MOVEMENT_REQUIRES_REGISTER_PATH',
    );
  }
  throw AppError.conflict(
    `No governed typed workflow is available for controlled-substance '${movementKind}' custody; stock remains unchanged`,
    'CONTROLLED_MOVEMENT_REQUIRES_REGISTER_PATH',
  );
}

function requireControlledPerformer(performerUid) {
  if (!performerUid) {
    throw AppError.badRequest(
      'performed_by is required for controlled stock movements',
      'CONTROLLED_MOVEMENT_PERFORMER_REQUIRED',
    );
  }
  return performerUid;
}

async function loadSupplyCustodyBalanceTx(tx, tenantId, facilityId, inventoryItemId, delta = 0) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT COALESCE(SUM(remaining_quantity), 0)::text AS current_balance,
            (COALESCE(SUM(remaining_quantity), 0) + $4::numeric)::text AS running_balance
       FROM pharmacy_inventory_batches
      WHERE tenant_id=$1::uuid
        AND facility_id=$2::int
        AND inventory_item_id=$3::int
        AND status = ANY($5::text[])`,
    tenantId,
    Number(facilityId),
    Number(inventoryItemId),
    Number(delta),
    [...CONTROLLED_CUSTODY_BATCH_STATUSES],
  );
  const currentBalance = Number(rows[0]?.current_balance);
  const runningBalance = Number(rows[0]?.running_balance);
  if (!Number.isFinite(currentBalance) || currentBalance < 0
    || !Number.isFinite(runningBalance) || runningBalance < 0) {
    throw AppError.conflict(
      'Controlled-substance custody balance could not be proven',
      'PHARMACY_CONTROLLED_REGISTER_EVIDENCE_INVALID',
    );
  }
  return {
    current_balance: String(rows[0].current_balance),
    running_balance: String(rows[0].running_balance),
  };
}

async function prepareControlledSupplyRegisterTx(tx, {
  tenantId,
  item,
  inventoryItemId,
  facilityId,
  movementKind,
  quantityDelta,
} = {}) {
  const scheduleClass = canonicalControlledScheduleClass(item);
  const registerKind = SUPPLY_REGISTER_KIND_BY_MOVEMENT[movementKind];
  const quantity = Math.abs(Number(quantityDelta));
  if (!scheduleClass || !registerKind || !Number.isFinite(quantity) || quantity <= 0) {
    throw AppError.conflict(
      'Controlled-substance register command evidence is invalid',
      'PHARMACY_CONTROLLED_REGISTER_EVIDENCE_INVALID',
    );
  }
  await lockControlledRegisterItemTx(tx, tenantId, inventoryItemId);
  const balance = await loadSupplyCustodyBalanceTx(
    tx,
    tenantId,
    facilityId,
    inventoryItemId,
    quantity,
  );
  return Object.freeze({
    facility_id: Number(facilityId),
    schedule_class: scheduleClass,
    movement_kind: registerKind,
    quantity,
    unit_label: item?.unit_label || null,
    running_balance: balance.running_balance,
  });
}

async function appendControlledSupplyRegisterTx(tx, {
  tenantId, item, inventoryItemId, inventoryBatchId, movementKind,
  quantity, performedBy, referenceMovementId = null, notes = null,
  registerEvidence,
}) {
  const registerKind = SUPPLY_REGISTER_KIND_BY_MOVEMENT[movementKind];
  if (!registerKind) refuseControlledSupplyDecrement(movementKind);
  const facilityId = Number(registerEvidence?.facility_id);
  const scheduleClass = canonicalControlledScheduleClass(item);
  const expectedBalance = Number(registerEvidence?.running_balance);
  const expectedQuantity = Math.abs(Number(quantity));
  const batchId = Number(inventoryBatchId);
  const movementId = Number(referenceMovementId);
  if (!Number.isSafeInteger(facilityId) || facilityId <= 0
    || !scheduleClass || registerEvidence?.schedule_class !== scheduleClass
    || registerEvidence?.movement_kind !== registerKind
    || Number(registerEvidence?.quantity) !== expectedQuantity
    || (registerEvidence?.unit_label ?? null) !== (item?.unit_label || null)
    || !Number.isFinite(expectedBalance) || expectedBalance < 0
    || !Number.isSafeInteger(batchId) || batchId <= 0
    || !Number.isSafeInteger(movementId) || movementId <= 0) {
    throw AppError.conflict(
      'Controlled-substance register command evidence is invalid',
      'PHARMACY_CONTROLLED_REGISTER_EVIDENCE_INVALID',
    );
  }
  const actualBalance = await loadSupplyCustodyBalanceTx(
    tx,
    tenantId,
    facilityId,
    inventoryItemId,
  );
  if (Number(actualBalance.current_balance) !== expectedBalance) {
    throw AppError.conflict(
      'Controlled-substance register balance does not match physical facility custody',
      'PHARMACY_CONTROLLED_REGISTER_EVIDENCE_INVALID',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO pharmacy_schedule_register
       (tenant_id, facility_id, inventory_item_id, inventory_batch_id, schedule_class,
         movement_kind, quantity, unit_label, running_balance,
         performed_by, reference_movement_id, notes)
     VALUES ($1::uuid, $2::int, $3::int, $4::int, $5, $6, $7::numeric, $8, $9::numeric,
             $10::uuid, $11::int, $12)
     RETURNING id, tenant_id, facility_id, inventory_item_id, inventory_batch_id,
               schedule_class, movement_kind, quantity::text AS quantity, unit_label,
               running_balance::text AS running_balance, performed_by,
               reference_movement_id, notes`,
    tenantId,
    facilityId,
    Number(inventoryItemId),
    batchId,
    scheduleClass,
    registerKind,
    expectedQuantity,
    item.unit_label || null,
    registerEvidence.running_balance,
    String(performedBy),
    movementId,
    notes,
  );
  const register = rows[0];
  if (!register
    || String(register.tenant_id) !== String(tenantId)
    || Number(register.facility_id) !== facilityId
    || Number(register.inventory_item_id) !== Number(inventoryItemId)
    || Number(register.inventory_batch_id) !== batchId
    || String(register.schedule_class) !== scheduleClass
    || String(register.movement_kind) !== registerKind
    || Number(register.quantity) !== expectedQuantity
    || (register.unit_label ?? null) !== (item.unit_label || null)
    || Number(register.running_balance) !== expectedBalance
    || String(register.performed_by) !== String(performedBy)
    || Number(register.reference_movement_id) !== movementId
    || (register.notes ?? null) !== (notes ?? null)) {
    throw AppError.conflict(
      'Controlled-substance register row does not match its command evidence',
      'PHARMACY_CONTROLLED_REGISTER_EVIDENCE_INVALID',
    );
  }
  return register;
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
  const text = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    throw AppError.badRequest(`${label} must be a YYYY-MM-DD date`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year
    || calendar.getUTCMonth() !== month - 1
    || calendar.getUTCDate() !== day) {
    throw AppError.badRequest(`${label} must be a valid calendar date`);
  }
  return text;
}

function normalizeTimestamp(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return `${normalizeDate(text, label, { required: true })}T00:00:00.000Z`;
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!match) {
    throw AppError.badRequest(
      `${label} must be a YYYY-MM-DD date or ISO-8601 timestamp with timezone`,
    );
  }
  normalizeDate(match[1], label, { required: true });
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] || 0);
  if (hour > 23 || minute > 59 || second > 59) {
    throw AppError.badRequest(`${label} must be a valid timestamp`);
  }
  if (match[6] !== 'Z') {
    const offsetHour = Number(match[6].slice(1, 3));
    const offsetMinute = Number(match[6].slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      throw AppError.badRequest(`${label} has an invalid timezone offset`);
    }
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw AppError.badRequest(`${label} must be a valid timestamp`);
  }
  return parsed.toISOString();
}

function normalizeBigInt(value, label, { min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  if ((typeof value === 'number' && !Number.isFinite(value))
    || !['number', 'string', 'bigint'].includes(typeof value)) {
    throw AppError.badRequest(`${label} must be numeric`);
  }
  const lexical = String(value);
  if (!/^-?\d+$/.test(lexical)) {
    throw AppError.badRequest(`${label} must be an integer number of minor units`);
  }
  const parsed = BigInt(lexical);
  if (min !== null && parsed < BigInt(min)) {
    throw AppError.badRequest(`${label} must be >= ${min}`);
  }
  if (max !== null && parsed > BigInt(max)) {
    throw AppError.badRequest(`${label} must be <= ${max}`);
  }
  const compatible = Number(parsed);
  if (!Number.isSafeInteger(compatible)) {
    throw AppError.badRequest(`${label} must be an integer number of minor units`);
  }
  return compatible;
}

function normalizeQuantity(value, label, { min = 0, max = 1_000_000_000, required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  if ((typeof value === 'number' && !Number.isFinite(value))
    || !['number', 'string', 'bigint'].includes(typeof value)) {
    throw AppError.badRequest(`${label} must be numeric`);
  }
  const scaled = decimal4ToScaled(value);
  if (scaled === null) {
    throw AppError.badRequest(`${label} must be a plain decimal with at most 4 decimal places`);
  }
  const minScaled = decimal4ToScaled(min);
  const maxScaled = decimal4ToScaled(max);
  if (minScaled === null || maxScaled === null) {
    throw new TypeError(`${label} has invalid validation bounds`);
  }
  if (scaled < minScaled) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (scaled > maxScaled) throw AppError.badRequest(`${label} must be <= ${max}`);
  const compatibleScaled = Number(scaled);
  if (!Number.isSafeInteger(compatibleScaled)) {
    throw AppError.badRequest(`${label} is outside the supported quantity range`);
  }
  return compatibleScaled / Number(NUMERIC_14_4_SCALE);
}

const NUMERIC_14_4_SCALE = 10_000n;
const NUMERIC_14_4_MAX_SCALED = 99_999_999_999_999n;

function decimal4ToScaled(value) {
  if (value === null || value === undefined || value === '') return null;
  const match = /^([+-]?)(\d+)(?:\.(\d{1,4}))?$/.exec(String(value));
  if (!match) return null;
  const whole = BigInt(match[2]);
  const fraction = BigInt((match[3] || '').padEnd(4, '0') || '0');
  const absolute = (whole * NUMERIC_14_4_SCALE) + fraction;
  return match[1] === '-' && absolute !== 0n ? -absolute : absolute;
}

function numeric14_4ToScaled(value) {
  const scaled = decimal4ToScaled(value);
  if (scaled === null || scaled < -NUMERIC_14_4_MAX_SCALED
    || scaled > NUMERIC_14_4_MAX_SCALED) return null;
  return scaled;
}

function scaledNumeric14_4ToCanonical(value) {
  if (typeof value !== 'bigint' || value < -NUMERIC_14_4_MAX_SCALED
    || value > NUMERIC_14_4_MAX_SCALED) return null;
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / NUMERIC_14_4_SCALE;
  const fraction = String(absolute % NUMERIC_14_4_SCALE).padStart(4, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

function canonicalNumeric14_4(value) {
  const scaled = numeric14_4ToScaled(value);
  return scaled === null ? null : scaledNumeric14_4ToCanonical(scaled);
}

function normalizeInt(value, label, { min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be an integer`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

function normalizeFacilityActor(actorUid, actorRole = null) {
  const uid = maybeUuid(actorUid, 'actor_uid');
  if (!uid) {
    throw AppError.forbidden(
      'An authenticated actor is required for pharmacy facility custody',
      'PHARMACY_FACILITY_GRANT_REQUIRED',
    );
  }
  return {
    actorUid: uid,
    actorRole: safeText(actorRole, 80),
  };
}

async function assertSupplyFacilityGrantTx(tx, {
  tenantId,
  facilityId,
  actorUid,
  actorRole = null,
} = {}) {
  const actor = normalizeFacilityActor(actorUid, actorRole);
  return assertPharmacyFacilityGrant(tx, {
    tenantId,
    facilityId: normalizeId(facilityId, 'facility_id'),
    actorUid: actor.actorUid,
    actorRole: actor.actorRole,
    forUpdate: true,
  });
}

function storedReceiptFacilityId(value, receiptCode) {
  const facilityId = Number(value);
  if (!Number.isSafeInteger(facilityId) || facilityId <= 0) {
    throw AppError.conflict(
      'The committed command receipt does not contain a valid facility authority and requires recovery',
      receiptCode,
    );
  }
  return facilityId;
}

function selectAliasedFields(tableAlias, resultPrefix, fields) {
  return fields
    .map((field) => `${tableAlias}.${field} AS ${resultPrefix}_${field}`)
    .join(', ');
}

const CONTROLLED_REGISTER_REPLAY_SELECT = `
  register_evidence.count AS controlled_register_count,
  register_evidence.id AS controlled_register_id,
  register_evidence.facility_id AS controlled_register_facility_id,
  register_evidence.inventory_item_id AS controlled_register_inventory_item_id,
  register_evidence.inventory_batch_id AS controlled_register_inventory_batch_id,
  register_evidence.schedule_class AS controlled_register_schedule_class,
  register_evidence.movement_kind AS controlled_register_movement_kind,
  register_evidence.quantity AS controlled_register_quantity,
  register_evidence.unit_label AS controlled_register_unit_label,
  register_evidence.running_balance AS controlled_register_running_balance,
  register_evidence.performed_by AS controlled_register_performed_by`;

const CONTROLLED_REGISTER_REPLAY_JOIN = `
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS count,
           MIN(register.id)::int AS id,
           MIN(register.facility_id)::int AS facility_id,
           MIN(register.inventory_item_id)::int AS inventory_item_id,
           MIN(register.inventory_batch_id)::int AS inventory_batch_id,
           MIN(register.schedule_class) AS schedule_class,
           MIN(register.movement_kind) AS movement_kind,
           MIN(register.quantity)::text AS quantity,
           MIN(register.unit_label) AS unit_label,
           MIN(register.running_balance)::text AS running_balance,
           MIN(register.performed_by::text) AS performed_by
      FROM pharmacy_schedule_register register
     WHERE register.tenant_id=movement.tenant_id
       AND register.reference_movement_id=movement.id
  ) register_evidence ON TRUE`;

function extractAliasedFields(row, resultPrefix, fields) {
  if (!row || row[`${resultPrefix}_id`] === null || row[`${resultPrefix}_id`] === undefined) {
    return null;
  }
  return Object.fromEntries(fields
    .filter((field) => Object.hasOwn(row, `${resultPrefix}_${field}`))
    .map((field) => [field, row[`${resultPrefix}_${field}`]]));
}

function dateOnly(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function intentValueMatches(stored, authoritative) {
  if (authoritative === null) return stored === null;
  if (authoritative === undefined) return false;
  if (typeof authoritative === 'number') {
    if (stored === null || stored === undefined || stored === '') return false;
    return Number.isFinite(Number(stored)) && Number(stored) === authoritative;
  }
  if (typeof authoritative === 'boolean') return stored === authoritative;
  return stored !== null
    && stored !== undefined
    && String(stored) === String(authoritative);
}

function intentMatches(intent, authoritative) {
  return intent && typeof intent === 'object' && !Array.isArray(intent)
    && Object.entries(authoritative)
      .every(([key, value]) => intentValueMatches(intent[key], value));
}

function requireReplayMetadata(row, {
  contract,
  commandKeySha256,
  requestField,
  requestFingerprint,
  conflictMessage,
  conflictCode,
  incompleteMessage,
  incompleteCode,
} = {}) {
  const metadata = row?.movement_metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || metadata[requestField] !== requestFingerprint) {
    throw AppError.conflict(conflictMessage, conflictCode);
  }
  if (metadata.contract !== contract
    || metadata.command_key_sha256 !== commandKeySha256
    || !metadata.intent
    || typeof metadata.intent !== 'object'
    || Array.isArray(metadata.intent)) {
    throw AppError.conflict(incompleteMessage, incompleteCode);
  }
  const facilityId = storedReceiptFacilityId(metadata.facility_id, incompleteCode);
  if (!intentValueMatches(metadata.intent.facility_id, facilityId)) {
    throw AppError.conflict(incompleteMessage, incompleteCode);
  }
  return { metadata, intent: metadata.intent, facilityId };
}

function requireControlledRegisterEvidence(row, intent, {
  facilityId,
  inventoryItemId,
  inventoryBatchId,
  movementKind,
  quantity,
  performedBy,
} = {}, incompleteMessage, incompleteCode) {
  const itemFacilityId = Number(row?.lineage_item_facility_id);
  const itemId = Number(row?.lineage_item_id);
  const item = {
    schedule_class: row?.lineage_item_schedule_class,
    is_narcotic: row?.lineage_item_is_narcotic === true,
  };
  const scheduleClass = canonicalControlledScheduleClass(item);
  const controlled = scheduleClass !== null;
  const evidence = intent?.register_evidence;
  const count = Number(row?.controlled_register_count);
  if (!Number.isSafeInteger(itemId) || itemId !== Number(inventoryItemId)
    || !Number.isSafeInteger(itemFacilityId) || itemFacilityId !== Number(facilityId)
    || intent?.controlled !== controlled) {
    throw AppError.conflict(incompleteMessage, incompleteCode);
  }
  if (!controlled) {
    if (count !== 0 || evidence !== null) {
      throw AppError.conflict(incompleteMessage, incompleteCode);
    }
    return false;
  }
  const registerKind = SUPPLY_REGISTER_KIND_BY_MOVEMENT[movementKind];
  const signedQuantityScaled = numeric14_4ToScaled(quantity);
  const expectedQuantityScaled = signedQuantityScaled === null
    ? null
    : (signedQuantityScaled < 0n ? -signedQuantityScaled : signedQuantityScaled);
  const evidenceQuantityScaled = numeric14_4ToScaled(evidence?.quantity);
  const registerQuantityScaled = numeric14_4ToScaled(row?.controlled_register_quantity);
  const runningBalance = Number(evidence?.running_balance);
  if (!registerKind
    || !evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || expectedQuantityScaled === null || expectedQuantityScaled <= 0n
    || evidenceQuantityScaled === null || evidenceQuantityScaled !== expectedQuantityScaled
    || registerQuantityScaled === null || registerQuantityScaled !== expectedQuantityScaled
    || !Number.isFinite(runningBalance) || runningBalance < 0
    || !intentMatches(evidence, {
      facility_id: Number(facilityId),
      schedule_class: scheduleClass,
      movement_kind: registerKind,
      unit_label: evidence.unit_label ?? null,
    })
    || count !== 1
    || !Number.isSafeInteger(Number(row?.controlled_register_id))
    || Number(row.controlled_register_id) <= 0
    || Number(row?.controlled_register_facility_id) !== Number(facilityId)
    || Number(row?.controlled_register_inventory_item_id) !== Number(inventoryItemId)
    || Number(row?.controlled_register_inventory_batch_id) !== Number(inventoryBatchId)
    || String(row?.controlled_register_schedule_class) !== scheduleClass
    || String(row?.controlled_register_movement_kind) !== registerKind
    || (row?.controlled_register_unit_label ?? null) !== (evidence.unit_label ?? null)
    || Number(row?.controlled_register_running_balance) !== runningBalance
    || String(row?.controlled_register_performed_by) !== String(performedBy)) {
    throw AppError.conflict(incompleteMessage, incompleteCode);
  }
  return true;
}

function immutableResponseSnapshot(value) {
  return JSON.parse(JSON.stringify(value, (_key, current) => (
    typeof current === 'bigint' ? current.toString() : current
  )));
}

function requireResponsePayload(metadata, incompleteMessage, incompleteCode) {
  const snapshot = metadata?.response_payload;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw AppError.conflict(incompleteMessage, incompleteCode);
  }
  return snapshot;
}

function requireMovementResponse(metadata, incompleteMessage, incompleteCode) {
  const response = metadata?.response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw AppError.conflict(incompleteMessage, incompleteCode);
  }
  return response;
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export async function upsertSupplier({
  tenantId = null, id = null,
  facilityId = null, actorUid = null, actorRole = null,
  supplierCode, displayName, legalName = null,
  gstin = null, drugLicenseNumber = null, pan = null,
  contactEmail = null, contactPhone = null, address = null,
  paymentTerms = null, bankDetails = null,
  status = 'active', rating = null, metadata = null, createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const exactFacilityId = normalizeId(facilityId, 'facility_id');
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
    return await setTenantTx(tid, async (tx) => {
      await assertSupplyFacilityGrantTx(tx, {
        tenantId: tid,
        facilityId: exactFacilityId,
        actorUid,
        actorRole,
      });
      if (id) {
        const supId = normalizeId(id, 'supplier id');
        const rows = await tx.$queryRawUnsafe(
          `UPDATE pharmacy_suppliers SET
             supplier_code = $1, display_name = $2, legal_name = $3,
             gstin = $4, drug_license_number = $5, pan = $6,
             contact_email = $7, contact_phone = $8, address = $9,
             payment_terms = $10, bank_details = $11::jsonb,
             status = $12, rating = $13, metadata = $14::jsonb, updated_at = NOW()
           WHERE id = $15 AND tenant_id = $16::uuid AND facility_id=$17::int
           RETURNING id, tenant_id, facility_id, supplier_code, display_name, legal_name,
                     gstin, drug_license_number, pan, contact_email, contact_phone,
                     address, payment_terms, bank_details, status, rating,
                     metadata, created_by, created_at, updated_at`,
          ...args, supId, tid, exactFacilityId,
        );
        if (!rows[0]) throw AppError.notFound('Supplier not found');
        return rows[0];
      }
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_suppliers
           (tenant_id, facility_id, supplier_code, display_name, legal_name,
            gstin, drug_license_number, pan,
            contact_email, contact_phone, address,
            payment_terms, bank_details, status, rating, metadata, created_by)
         VALUES ($1::uuid, $2::int, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16::jsonb, $17::uuid)
         RETURNING id, tenant_id, facility_id, supplier_code, display_name, legal_name,
                   gstin, drug_license_number, pan, contact_email, contact_phone,
                   address, payment_terms, bank_details, status, rating,
                   metadata, created_by, created_at, updated_at`,
        tid, exactFacilityId, ...args, maybeUuid(createdBy, 'created_by'),
      );
      return rows[0];
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('supplier_code already exists');
    throw err;
  }
}

export async function listSuppliers({
  tenantId = null, facilityId = null, status = null, limit = DEFAULT_LIST_LIMIT,
  actorUid = null, actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const exactFacilityId = normalizeId(facilityId, 'facility_id');
  const filters = ['tenant_id = $1::uuid', 'facility_id = $2::int'];
  const params = [tid, exactFacilityId];
  if (status) {
    params.push(normalizeEnum(status, SUPPLIER_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  const rows = await setTenantTx(tid, async (tx) => {
    await assertSupplyFacilityGrantTx(tx, {
      tenantId: tid,
      facilityId: exactFacilityId,
      actorUid,
      actorRole,
    });
    return tx.$queryRawUnsafe(
      `SELECT id, tenant_id, facility_id, supplier_code, display_name, legal_name,
              gstin, drug_license_number, pan, contact_email, contact_phone,
              address, payment_terms, bank_details, status, rating,
              metadata, created_at, updated_at
       FROM pharmacy_suppliers
       WHERE ${filters.join(' AND ')}
       ORDER BY display_name
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
  });
  return { suppliers: rows, count: rows.length };
}

// ---------------------------------------------------------------------------
// Inventory items
// ---------------------------------------------------------------------------

const ITEM_RETURNING = `id, tenant_id, facility_id, catalog_id, composition_id,
  sku_code, display_name,
  generic_name, brand_name, manufacturer, form, strength, unit_label, pack_size,
  hsn_code, schedule_class, is_narcotic, is_cold_chain,
  reorder_level, reorder_quantity, default_supplier_id,
  status, metadata, created_at, updated_at`;

export async function upsertInventoryItem({
  tenantId = null, id = null, facilityId = null, catalogId = null,
  skuCode, displayName, genericName = null, brandName = null,
  manufacturer = null, form = null, strength = null,
  unitLabel = 'each', packSize = null, hsnCode = null, scheduleClass = null,
  isNarcotic = false, isColdChain = false,
  reorderLevel = null, reorderQuantity = null,
  defaultSupplierId = null,
  status = 'active', metadata = null,
  actorUid = null, actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanCode = safeText(skuCode, 120);
  if (!cleanCode) throw AppError.badRequest('sku_code is required');
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const cleanStatus = normalizeEnum(status, ITEM_STATUSES, 'status') || 'active';
  const exactFacilityId = normalizeId(facilityId, 'facility_id');
  const exactCatalogId = normalizeId(catalogId, 'catalog_id');
  const exactSupplierId = defaultSupplierId
    ? normalizeId(defaultSupplierId, 'default_supplier_id')
    : null;
  if (!exactFacilityId || !exactCatalogId) {
    throw AppError.badRequest(
      'Inventory items require facility_id and catalog_id',
      'PHARMACY_INVENTORY_AUTHORITY_REQUIRED',
    );
  }
  const args = [
    exactFacilityId,
    exactCatalogId,
    cleanCode, cleanName,
    safeText(genericName, SHORT_MAX), safeText(brandName, SHORT_MAX),
    safeText(manufacturer, SHORT_MAX), safeText(form, 80), safeText(strength, 80),
    safeText(unitLabel, 40) || 'each',
    normalizeInt(packSize, 'pack_size', { min: 0, max: 1_000_000 }),
    safeText(hsnCode, 40), safeText(scheduleClass, 20),
    normalizeBoolean(isNarcotic, false), normalizeBoolean(isColdChain, false),
    normalizeInt(reorderLevel, 'reorder_level', { min: 0, max: 1_000_000 }),
    normalizeInt(reorderQuantity, 'reorder_quantity', { min: 0, max: 1_000_000 }),
    exactSupplierId,
    cleanStatus,
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  ];
  try {
    return await setTenantTx(tid, async (tx) => {
      await assertSupplyFacilityGrantTx(tx, {
        tenantId: tid,
        facilityId: exactFacilityId,
        actorUid,
        actorRole,
      });
      const authority = await tx.$queryRawUnsafe(
        `SELECT f.id AS facility_id, pc.id AS catalog_id
           FROM facilities f
           JOIN pharmacy_catalog pc
             ON pc.tenant_id=f.tenant_id
            AND pc.id=$3::int
            AND pc.is_active=TRUE
          WHERE f.tenant_id=$1::uuid
            AND f.id=$2::int
            AND f.status='active'
          FOR UPDATE OF f, pc`,
        tid,
        exactFacilityId,
        exactCatalogId,
      );
      if (!authority[0]) {
        throw AppError.badRequest(
          'facility_id, catalog_id, and default_supplier_id must identify active records in this tenant',
          'PHARMACY_INVENTORY_AUTHORITY_INVALID',
        );
      }
      if (exactSupplierId != null) {
        const supplierRows = await tx.$queryRawUnsafe(
          `SELECT id
             FROM pharmacy_suppliers
            WHERE tenant_id=$1::uuid AND id=$2::int
              AND facility_id=$3::int AND status='active'
            FOR UPDATE`,
          tid,
          exactSupplierId,
          exactFacilityId,
        );
        if (!supplierRows[0]) {
          throw AppError.badRequest(
            'default_supplier_id must identify an active supplier in this tenant',
            'PHARMACY_INVENTORY_AUTHORITY_INVALID',
          );
        }
      }
      if (id) {
        const itemId = normalizeId(id, 'inventory_item id');
        const existingRows = await tx.$queryRawUnsafe(
          `SELECT facility_id, catalog_id, default_supplier_id, status
             FROM pharmacy_inventory_items
            WHERE tenant_id=$1::uuid AND id=$2::int
            FOR UPDATE`,
          tid,
          itemId,
        );
        const existing = existingRows[0];
        if (!existing) throw AppError.notFound('Inventory item not found');
        if (Number(existing.facility_id) !== exactFacilityId) {
          await assertSupplyFacilityGrantTx(tx, {
            tenantId: tid,
            facilityId: Number(existing.facility_id),
            actorUid,
            actorRole,
          });
        }
        const authorityChanged = Number(existing.facility_id) !== exactFacilityId
          || Number(existing.catalog_id) !== exactCatalogId
          || (existing.default_supplier_id == null ? null : Number(existing.default_supplier_id)) !== exactSupplierId
          || String(existing.status) !== cleanStatus;
        if (authorityChanged) {
          const historyRows = await tx.$queryRawUnsafe(
            `SELECT (
                 EXISTS (SELECT 1 FROM pharmacy_inventory_batches
                          WHERE tenant_id=$1::uuid AND inventory_item_id=$2::int)
                 OR EXISTS (SELECT 1 FROM pharmacy_purchase_order_items
                              WHERE tenant_id=$1::uuid AND inventory_item_id=$2::int)
                 OR EXISTS (SELECT 1 FROM pharmacy_goods_receipt_items
                              WHERE tenant_id=$1::uuid AND inventory_item_id=$2::int)
                 OR EXISTS (SELECT 1 FROM pharmacy_stock_movements
                              WHERE tenant_id=$1::uuid AND inventory_item_id=$2::int)
                 OR EXISTS (SELECT 1 FROM pharmacy_substitutes
                              WHERE tenant_id=$1::uuid
                                AND (primary_item_id=$2::int OR substitute_item_id=$2::int))
               ) AS has_history`,
            tid,
            itemId,
          );
          if (historyRows[0]?.has_history === true) {
            throw AppError.conflict(
              'Inventory item facility, catalog, supplier, and status authority is immutable after descendants or ledger history exist; use governed recovery',
              'PHARMACY_INVENTORY_ITEM_REHOME_FORBIDDEN',
            );
          }
        }
        const rows = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_inventory_items SET
           facility_id = $1, catalog_id = $2, sku_code = $3, display_name = $4,
           generic_name = $5, brand_name = $6, manufacturer = $7,
           form = $8, strength = $9, unit_label = $10, pack_size = $11,
           hsn_code = $12, schedule_class = $13,
           is_narcotic = $14, is_cold_chain = $15,
           reorder_level = $16, reorder_quantity = $17, default_supplier_id = $18,
           status = $19, metadata = $20::jsonb, updated_at = NOW()
         WHERE id = $21 AND tenant_id = $22::uuid
         RETURNING ${ITEM_RETURNING}`,
        ...args, itemId, tid,
        );
        if (!rows[0]) throw AppError.notFound('Inventory item not found');
        return rows[0];
      }
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_inventory_items
         (tenant_id, facility_id, catalog_id, sku_code, display_name,
          generic_name, brand_name, manufacturer, form, strength, unit_label, pack_size,
          hsn_code, schedule_class, is_narcotic, is_cold_chain,
          reorder_level, reorder_quantity, default_supplier_id, status, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb)
       RETURNING ${ITEM_RETURNING}`,
      tid, ...args,
      );
      return rows[0];
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('sku_code already exists');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid default_supplier_id, facility_id, or catalog_id');
    throw err;
  }
}

export async function listInventoryItems({
  tenantId = null, facilityId = null, status = null,
  isNarcotic = null, q = null, limit = DEFAULT_LIST_LIMIT,
  actorUid = null, actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const exactFacilityId = normalizeId(facilityId, 'facility_id');
  const filters = ['tenant_id = $1::uuid', 'facility_id = $2::int'];
  const params = [tid, exactFacilityId];
  if (status) {
    params.push(normalizeEnum(status, ITEM_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (isNarcotic !== null) {
    params.push(normalizeBoolean(isNarcotic));
    filters.push(`is_narcotic = $${params.length}`);
  }
  const query = safeText(q, 160);
  if (query) {
    params.push(`%${query.toLowerCase()}%`);
    filters.push(`(
      LOWER(display_name) LIKE $${params.length}
      OR LOWER(sku_code) LIKE $${params.length}
      OR LOWER(COALESCE(generic_name, '')) LIKE $${params.length}
      OR LOWER(COALESCE(brand_name, '')) LIKE $${params.length}
      OR LOWER(COALESCE(manufacturer, '')) LIKE $${params.length}
    )`);
  }
  const safeLimit = normalizeLimit(limit);
  const rows = await setTenantTx(tid, async (tx) => {
    await assertSupplyFacilityGrantTx(tx, {
      tenantId: tid,
      facilityId: exactFacilityId,
      actorUid,
      actorRole,
    });
    return tx.$queryRawUnsafe(
      `SELECT ${ITEM_RETURNING} FROM pharmacy_inventory_items
       WHERE ${filters.join(' AND ')}
         AND EXISTS (
           SELECT 1 FROM facilities facility
            WHERE facility.tenant_id=pharmacy_inventory_items.tenant_id
              AND facility.id=pharmacy_inventory_items.facility_id
              AND facility.status='active'
         )
         AND EXISTS (
           SELECT 1 FROM pharmacy_catalog catalog
            WHERE catalog.tenant_id=pharmacy_inventory_items.tenant_id
              AND catalog.id=pharmacy_inventory_items.catalog_id
              AND catalog.is_active=TRUE
         )
         AND (
           default_supplier_id IS NULL
           OR EXISTS (
             SELECT 1 FROM pharmacy_suppliers supplier
              WHERE supplier.tenant_id=pharmacy_inventory_items.tenant_id
                AND supplier.id=pharmacy_inventory_items.default_supplier_id
                AND supplier.facility_id=pharmacy_inventory_items.facility_id
                AND supplier.status='active'
           )
         )
       ORDER BY display_name
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
  });
  return { items: rows, count: rows.length };
}

// ---------------------------------------------------------------------------
// Inventory batches + receive flow (with stock-movement ledger entry)
// ---------------------------------------------------------------------------

const BATCH_FIELDS = Object.freeze([
  'id', 'tenant_id', 'inventory_item_id', 'facility_id',
  'batch_number', 'lot_number', 'manufacture_date', 'expiry_date',
  'received_quantity', 'remaining_quantity', 'unit_cost_minor', 'mrp_minor',
  'supplier_id', 'goods_receipt_id', 'storage_location_id', 'status',
  'recall_reference', 'metadata', 'created_at', 'updated_at',
]);
const BATCH_RETURNING = BATCH_FIELDS.join(', ');

const MOVEMENT_FIELDS = Object.freeze([
  'id', 'tenant_id', 'inventory_item_id', 'inventory_batch_id',
  'movement_kind', 'quantity_delta', 'reference_type', 'reference_id',
  'performed_by', 'notes', 'metadata', 'created_at',
]);

/**
 * Add a new direct-supply batch. Inserts the batch + writes a 'receive'
 * stock_movement row in one transaction. GRN-linked receipts are rejected in
 * favour of receivePurchaseOrderLine(), which closes the PO/GRN lineage.
 */
export async function addInventoryBatch({
  tenantId = null,
  inventoryItemId,
  facilityId,
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
  actorRole = null,
  metadata = null,
  commandKey = null,
  requestFingerprint = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const itemId = normalizeId(inventoryItemId, 'inventory_item_id');
  const exactFacilityId = normalizeId(facilityId, 'facility_id');
  const exactSupplierId = normalizeId(supplierId, 'supplier_id');
  const exactStorageLocationId = normalizeId(storageLocationId, 'storage_location_id');
  const performerUid = normalizeFacilityActor(performedBy, actorRole).actorUid;
  const cleanBatch = safeText(batchNumber, 120);
  if (!cleanBatch) throw AppError.badRequest('batch_number is required');
  const cleanExpiry = normalizeDate(expiryDate, 'expiry_date', { required: true });
  const cleanManufacture = normalizeDate(manufactureDate, 'manufacture_date');
  if (cleanManufacture && cleanManufacture > cleanExpiry) {
    throw AppError.badRequest(
      'manufacture_date cannot be after expiry_date',
      'PHARMACY_BATCH_DATE_RANGE_INVALID',
    );
  }
  const qty = normalizeQuantity(receivedQuantity, 'received_quantity', { min: 0.0001, required: true });
  const cost = normalizeBigInt(unitCostMinor, 'unit_cost_minor', {
    min: 0,
    max: 1_000_000_000_000,
  });
  const mrp = normalizeBigInt(mrpMinor, 'mrp_minor', {
    min: 0,
    max: 1_000_000_000_000,
  });
  if (goodsReceiptId != null) {
    throw AppError.conflict(
      'GRN-linked stock must use the governed purchase-order receive-line workflow',
      'PHARMACY_GRN_RECEIVE_LINE_REQUIRED',
    );
  }
  if (!IDEMPOTENCY_KEY_RE.test(String(commandKey || ''))
    || !/^[0-9a-f]{64}$/i.test(String(requestFingerprint || ''))) {
    throw AppError.conflict(
      'Direct stock receipt requires durable idempotency authority',
      'PHARMACY_STOCK_RECEIPT_IDEMPOTENCY_REQUIRED',
    );
  }
  const commandKeySha256 = createHash('sha256').update(String(commandKey)).digest('hex');

  try {
    return await setTenantTx(tid, async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))::text AS lock_acquired`,
        `pharmacy-direct-receive:${tid}:${commandKeySha256}`,
      );
      const replays = await tx.$queryRawUnsafe(
        `SELECT ${selectAliasedFields('movement', 'movement', MOVEMENT_FIELDS)},
                ${selectAliasedFields('batch', 'batch', BATCH_FIELDS)},
                item.id AS lineage_item_id,
                item.facility_id AS lineage_item_facility_id,
                item.schedule_class AS lineage_item_schedule_class,
                item.is_narcotic AS lineage_item_is_narcotic,
                item.unit_label AS lineage_item_unit_label,
                ${CONTROLLED_REGISTER_REPLAY_SELECT}
           FROM pharmacy_stock_movements movement
           LEFT JOIN pharmacy_inventory_batches batch
             ON batch.tenant_id=movement.tenant_id
            AND batch.id=movement.inventory_batch_id
            AND batch.inventory_item_id=movement.inventory_item_id
           LEFT JOIN pharmacy_inventory_items item
             ON item.tenant_id=movement.tenant_id
            AND item.id=movement.inventory_item_id
            AND item.facility_id=batch.facility_id
           ${CONTROLLED_REGISTER_REPLAY_JOIN}
          WHERE movement.tenant_id=$1::uuid
            AND movement.metadata->>'contract'='pharmacy_inventory_direct_receive_v1'
            AND movement.metadata->>'command_key_sha256'=$2
          ORDER BY movement.id
          LIMIT 2`,
        tid,
        commandKeySha256,
      );
      if (replays.length) {
        if (replays.length !== 1) {
          throw AppError.conflict(
            'Direct stock receipt idempotency evidence conflicts with this request',
            'PHARMACY_STOCK_RECEIPT_IDEMPOTENCY_CONFLICT',
          );
        }
        const replayRow = replays[0];
        const incompleteMessage = 'The direct stock receipt committed without complete immutable lineage and requires recovery';
        const { metadata: replayMetadata, intent, facilityId: replayFacilityId } = requireReplayMetadata(replayRow, {
          contract: 'pharmacy_inventory_direct_receive_v1',
          commandKeySha256,
          requestField: 'request_fingerprint',
          requestFingerprint,
          conflictMessage: 'Direct stock receipt idempotency evidence conflicts with this request',
          conflictCode: 'PHARMACY_STOCK_RECEIPT_IDEMPOTENCY_CONFLICT',
          incompleteMessage,
          incompleteCode: 'PHARMACY_STOCK_RECEIPT_INCOMPLETE',
        });
        const movement = extractAliasedFields(replayRow, 'movement', MOVEMENT_FIELDS);
        const replayBatch = extractAliasedFields(replayRow, 'batch', BATCH_FIELDS);
        const responseSnapshot = requireResponsePayload(
          replayMetadata,
          incompleteMessage,
          'PHARMACY_STOCK_RECEIPT_INCOMPLETE',
        );
        const replayControlled = isControlledSupplyItem({
          schedule_class: replayRow.lineage_item_schedule_class,
          is_narcotic: replayRow.lineage_item_is_narcotic === true,
        });
        if (!movement || !replayBatch || !intentMatches(intent, {
          facility_id: replayFacilityId,
          inventory_item_id: Number(movement.inventory_item_id),
          inventory_batch_id: Number(movement.inventory_batch_id),
          movement_kind: String(movement.movement_kind),
          quantity_delta: Number(movement.quantity_delta),
          reference_type: movement.reference_type ?? null,
          reference_id: movement.reference_id ?? null,
          performed_by: movement.performed_by ?? null,
          supplier_id: Number(replayBatch.supplier_id),
          storage_location_id: Number(replayBatch.storage_location_id),
          goods_receipt_id: replayBatch.goods_receipt_id ?? null,
          batch_number: String(replayBatch.batch_number),
          lot_number: replayBatch.lot_number ?? null,
          manufacture_date: dateOnly(replayBatch.manufacture_date),
          expiry_date: dateOnly(replayBatch.expiry_date),
          received_quantity: Number(replayBatch.received_quantity),
          unit_cost_minor: replayBatch.unit_cost_minor == null
            ? null
            : Number(replayBatch.unit_cost_minor),
          mrp_minor: replayBatch.mrp_minor == null ? null : Number(replayBatch.mrp_minor),
          controlled: replayControlled,
        })
          || Number(replayBatch.facility_id) !== replayFacilityId
          || Number(replayBatch.inventory_item_id) !== Number(movement.inventory_item_id)
          || Number(replayBatch.id) !== Number(movement.inventory_batch_id)
          || String(movement.movement_kind) !== 'receive'
          || Number(movement.quantity_delta) <= 0
          || String(movement.reference_type) !== 'direct_supply_receipt'
          || String(movement.reference_id) !== String(replayBatch.id)
          || !intentMatches(responseSnapshot, {
            id: Number(replayBatch.id),
            tenant_id: String(replayBatch.tenant_id),
            inventory_item_id: Number(replayBatch.inventory_item_id),
            facility_id: replayFacilityId,
            batch_number: String(replayBatch.batch_number),
            lot_number: replayBatch.lot_number ?? null,
            received_quantity: Number(replayBatch.received_quantity),
            remaining_quantity: Number(replayBatch.received_quantity),
            unit_cost_minor: replayBatch.unit_cost_minor == null
              ? null
              : Number(replayBatch.unit_cost_minor),
            mrp_minor: replayBatch.mrp_minor == null ? null : Number(replayBatch.mrp_minor),
            supplier_id: Number(replayBatch.supplier_id),
            goods_receipt_id: null,
            storage_location_id: Number(replayBatch.storage_location_id),
            status: 'in_stock',
          })
          || dateOnly(responseSnapshot.manufacture_date) !== dateOnly(replayBatch.manufacture_date)
          || dateOnly(responseSnapshot.expiry_date) !== dateOnly(replayBatch.expiry_date)) {
          throw AppError.conflict(incompleteMessage, 'PHARMACY_STOCK_RECEIPT_INCOMPLETE');
        }
        requireControlledRegisterEvidence(
          replayRow,
          intent,
          {
            facilityId: replayFacilityId,
            inventoryItemId: Number(movement.inventory_item_id),
            inventoryBatchId: Number(movement.inventory_batch_id),
            movementKind: String(movement.movement_kind),
            quantity: Number(movement.quantity_delta),
            performedBy: movement.performed_by,
          },
          incompleteMessage,
          'PHARMACY_STOCK_RECEIPT_INCOMPLETE',
        );
        await assertSupplyFacilityGrantTx(tx, {
          tenantId: tid,
          facilityId: replayFacilityId,
          actorUid: performerUid,
          actorRole,
        });
        return responseSnapshot;
      }
      await assertSupplyFacilityGrantTx(tx, {
        tenantId: tid,
        facilityId: exactFacilityId,
        actorUid: performerUid,
        actorRole,
      });
      const itemRows = await tx.$queryRawUnsafe(
        `SELECT pii.id, pii.facility_id, pii.catalog_id, pii.schedule_class,
                pii.is_narcotic, pii.unit_label, supplier.id AS supplier_id
           FROM pharmacy_inventory_items pii
           JOIN facilities f
             ON f.tenant_id=pii.tenant_id
            AND f.id=pii.facility_id
            AND f.status='active'
           JOIN pharmacy_catalog pc
             ON pc.tenant_id=pii.tenant_id
            AND pc.id=pii.catalog_id
            AND pc.is_active=TRUE
           JOIN pharmacy_suppliers supplier
             ON supplier.tenant_id=pii.tenant_id
            AND supplier.id=$4::int
            AND supplier.facility_id=pii.facility_id
            AND supplier.status='active'
          WHERE pii.tenant_id=$1::uuid
            AND pii.id=$2::int
            AND pii.facility_id=$3::int
            AND pii.status='active'
            AND $5::date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
            AND EXISTS (
              SELECT 1
                FROM facility_locations location
               WHERE location.tenant_id=pii.tenant_id
                 AND location.facility_id=pii.facility_id
                 AND location.id=$6::int
                 AND location.status='active'
            )
          FOR UPDATE OF pii, f, pc, supplier`,
        tid,
        itemId,
        exactFacilityId,
        exactSupplierId,
        cleanExpiry,
        exactStorageLocationId,
      );
      const controlledItem = itemRows[0];
      if (!controlledItem) {
        throw AppError.badRequest(
          'inventory_item_id, facility_id, catalog_id, supplier_id, and storage_location_id must form one active receipt authority',
          'PHARMACY_INVENTORY_AUTHORITY_INVALID',
        );
      }
      const controlled = controlledItem && isControlledSupplyItem(controlledItem);
      if (controlled) requireControlledPerformer(performerUid);
      const insertRows = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_inventory_batches
           (tenant_id, inventory_item_id, facility_id,
            batch_number, lot_number, manufacture_date, expiry_date,
            received_quantity, remaining_quantity, unit_cost_minor, mrp_minor,
             supplier_id, goods_receipt_id, storage_location_id, status, metadata)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::date, $7::date,
                 $8, 0, $9, $10,
                 $11, $12, $13, 'in_stock', $14::jsonb)
         RETURNING ${BATCH_RETURNING}`,
        tid, itemId,
        exactFacilityId,
        cleanBatch, safeText(lotNumber, 120),
        cleanManufacture,
        cleanExpiry, qty,
        cost,
        mrp,
        exactSupplierId,
        goodsReceiptId ? normalizeId(goodsReceiptId, 'goods_receipt_id') : null,
        exactStorageLocationId,
        JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      );
      const insertedBatch = insertRows[0];
      const responseSnapshot = immutableResponseSnapshot({
        ...insertedBatch,
        remaining_quantity: insertedBatch.received_quantity,
      });
      const registerEvidence = controlled
        ? await prepareControlledSupplyRegisterTx(tx, {
          tenantId: tid,
          item: controlledItem,
          inventoryItemId: itemId,
          facilityId: exactFacilityId,
          movementKind: 'receive',
          quantityDelta: qty,
        })
        : null;
      const { movement } = await recordMovementTx(tx, {
        tenantId: tid,
        inventory_item_id: itemId,
        inventory_batch_id: insertedBatch.id,
        movement_kind: 'receive',
        quantity: qty,
        reference_type: 'direct_supply_receipt',
        reference_id: String(insertedBatch.id),
        performed_by: performerUid,
        notes: `Batch ${insertedBatch.batch_number} received`,
        expected_facility_id: exactFacilityId,
        metadata: {
          contract: 'pharmacy_inventory_direct_receive_v1',
          command_key_sha256: commandKeySha256,
          request_fingerprint: requestFingerprint,
          facility_id: exactFacilityId,
          intent: {
            facility_id: exactFacilityId,
            inventory_item_id: itemId,
            inventory_batch_id: Number(insertedBatch.id),
            movement_kind: 'receive',
            quantity_delta: qty,
            reference_type: 'direct_supply_receipt',
            reference_id: String(insertedBatch.id),
            performed_by: performerUid,
            supplier_id: exactSupplierId,
            storage_location_id: exactStorageLocationId,
            goods_receipt_id: null,
            batch_number: cleanBatch,
            lot_number: safeText(lotNumber, 120),
            manufacture_date: cleanManufacture,
            expiry_date: cleanExpiry,
            received_quantity: qty,
            unit_cost_minor: cost,
            mrp_minor: mrp,
            controlled,
            register_evidence: registerEvidence,
          },
          response_payload: responseSnapshot,
        },
      });
      const refreshedRows = await tx.$queryRawUnsafe(
        `SELECT ${BATCH_RETURNING}
           FROM pharmacy_inventory_batches
          WHERE tenant_id=$1::uuid AND id=$2::int
            AND inventory_item_id=$3::int AND facility_id=$4::int
          FOR UPDATE`,
        tid,
        Number(insertedBatch.id),
        itemId,
        exactFacilityId,
      );
      const batch = refreshedRows[0];
      if (!batch) {
        throw AppError.conflict(
          'Direct receipt batch could not be reloaded after the stock movement',
          'PHARMACY_STOCK_RECEIPT_INCOMPLETE',
        );
      }
      if (Number(batch.remaining_quantity) !== qty || batch.status !== 'in_stock') {
        throw AppError.conflict(
          'Direct receipt batch balance does not match its immutable command response',
          'PHARMACY_STOCK_RECEIPT_INCOMPLETE',
        );
      }
      if (controlled) {
        await appendControlledSupplyRegisterTx(tx, {
          tenantId: tid,
          item: controlledItem,
          inventoryItemId: itemId,
          inventoryBatchId: batch.id,
          movementKind: 'receive',
          quantity: qty,
          performedBy: performerUid,
          referenceMovementId: movement?.id || null,
          notes: `Batch ${batch.batch_number} received`,
          registerEvidence,
        });
      }
      return responseSnapshot;
    });
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
 * The FEFO locks, batch decrements, and movement rows commit atomically.
 */
export async function listBatches({
  tenantId = null, inventoryItemId = null, facilityId = null, status = null,
  expiringWithinDays = null, limit = DEFAULT_LIST_LIMIT,
  actorUid = null, actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const exactFacilityId = normalizeId(facilityId, 'facility_id');
  const filters = ['tenant_id = $1::uuid', 'facility_id = $2::int'];
  const params = [tid, exactFacilityId];
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
  const rows = await setTenantTx(tid, async (tx) => {
    await assertSupplyFacilityGrantTx(tx, {
      tenantId: tid,
      facilityId: exactFacilityId,
      actorUid,
      actorRole,
    });
    return tx.$queryRawUnsafe(
      `SELECT ${BATCH_RETURNING} FROM pharmacy_inventory_batches
       WHERE ${filters.join(' AND ')}
         AND EXISTS (
           SELECT 1
             FROM pharmacy_inventory_items item
             JOIN pharmacy_catalog catalog
               ON catalog.tenant_id=item.tenant_id
              AND catalog.id=item.catalog_id
              AND catalog.is_active=TRUE
             JOIN facilities facility
               ON facility.tenant_id=item.tenant_id
              AND facility.id=item.facility_id
              AND facility.status='active'
             JOIN pharmacy_suppliers supplier
               ON supplier.tenant_id=pharmacy_inventory_batches.tenant_id
              AND supplier.id=pharmacy_inventory_batches.supplier_id
              AND supplier.facility_id=pharmacy_inventory_batches.facility_id
            WHERE item.tenant_id=pharmacy_inventory_batches.tenant_id
              AND item.id=pharmacy_inventory_batches.inventory_item_id
              AND item.facility_id=pharmacy_inventory_batches.facility_id
              AND item.status='active'
         )
         AND EXISTS (
           SELECT 1 FROM facility_locations location
            WHERE location.tenant_id=pharmacy_inventory_batches.tenant_id
              AND location.facility_id=pharmacy_inventory_batches.facility_id
              AND location.id=pharmacy_inventory_batches.storage_location_id
              AND location.status='active'
         )
       ORDER BY expiry_date ASC, id ASC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
  });
  return { batches: rows, count: rows.length };
}

export async function recallBatch({
  tenantId = null, id, recallReference = null,
  performedBy = null, actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const batchId = normalizeId(id, 'batch id');
  const cleanRecallReference = safeText(recallReference, 255);
  return setTenantTx(tid, async (tx) => {
    const authorityRows = await tx.$queryRawUnsafe(
      `SELECT batch.facility_id
         FROM pharmacy_inventory_batches batch
         JOIN pharmacy_inventory_items item
           ON item.tenant_id=batch.tenant_id
          AND item.id=batch.inventory_item_id
          AND item.facility_id=batch.facility_id
          AND item.status='active'
         JOIN pharmacy_catalog catalog
           ON catalog.tenant_id=item.tenant_id
          AND catalog.id=item.catalog_id
          AND catalog.is_active=TRUE
         JOIN facilities facility
           ON facility.tenant_id=item.tenant_id
          AND facility.id=item.facility_id
          AND facility.status='active'
         JOIN pharmacy_suppliers supplier
           ON supplier.tenant_id=batch.tenant_id
          AND supplier.id=batch.supplier_id
          AND supplier.facility_id=batch.facility_id
        WHERE batch.tenant_id=$1::uuid AND batch.id=$2::int
          AND EXISTS (
            SELECT 1 FROM facility_locations location
             WHERE location.tenant_id=batch.tenant_id
               AND location.facility_id=batch.facility_id
               AND location.id=batch.storage_location_id
               AND location.status='active'
          )
        FOR UPDATE OF batch, item, catalog, facility, supplier`,
      tid,
      batchId,
    );
    if (!authorityRows[0]) {
      throw AppError.conflict(
        'Batch authority no longer forms one active item/catalog/facility/storage lineage with its exact supplier',
        'PHARMACY_BATCH_AUTHORITY_INVALID',
      );
    }
    await assertSupplyFacilityGrantTx(tx, {
      tenantId: tid,
      facilityId: Number(authorityRows[0].facility_id),
      actorUid: performedBy,
      actorRole,
    });
    const rows = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_inventory_batches
       SET status = 'recalled', recall_reference = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3::uuid AND status NOT IN ('disposed', 'expired', 'recalled')
       RETURNING ${BATCH_RETURNING}`,
      cleanRecallReference, batchId, tid,
    );
    if (rows[0]) return rows[0];

    const existingRows = await tx.$queryRawUnsafe(
      `SELECT ${BATCH_RETURNING}
         FROM pharmacy_inventory_batches
        WHERE id = $1 AND tenant_id = $2::uuid
        FOR UPDATE`,
      batchId,
      tid,
    );
    const existing = existingRows[0];
    if (existing?.status === 'recalled') {
      if ((existing.recall_reference || null) === cleanRecallReference) return existing;
      throw AppError.conflict(
        'Batch recall was already recorded with a different recall reference',
        'BATCH_RECALL_REPLAY_MISMATCH',
      );
    }
    throw AppError.notFound('Batch not found or not in a recallable state');
  });
}

// ---------------------------------------------------------------------------
// Purchase orders + items
// ---------------------------------------------------------------------------

const PO_FIELDS = Object.freeze([
  'id', 'tenant_id', 'facility_id', 'po_number', 'supplier_id', 'status',
  'ordered_at', 'expected_at', 'received_at', 'total_amount_minor', 'currency',
  'notes', 'approved_by', 'approved_at', 'cancellation_reason',
  'metadata', 'created_by', 'created_at', 'updated_at',
]);
const PO_RETURNING = PO_FIELDS.join(', ');

const GRN_ITEM_RESPONSE_FIELDS = Object.freeze([
  'id', 'tenant_id', 'goods_receipt_id', 'inventory_item_id',
  'inventory_batch_id', 'purchase_order_item_id', 'received_quantity',
  'unit_cost_minor', 'qc_status', 'qc_notes', 'metadata', 'created_at', 'updated_at',
]);
const GRN_RESPONSE_FIELDS = Object.freeze([
  'id', 'status', 'facility_id', 'supplier_id', 'purchase_order_id', 'updated_at',
]);
const PO_ITEM_RESPONSE_FIELDS = Object.freeze([
  'id', 'purchase_order_id', 'ordered_quantity', 'received_quantity',
]);

export async function createPurchaseOrder({
  tenantId = null, facilityId = null,
  poNumber, supplierId, status = 'draft',
  expectedAt = null, totalAmountMinor = null,
  currency = 'INR', notes = null, metadata = null, createdBy = null,
  actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const exactFacilityId = normalizeId(facilityId, 'facility_id');
  const exactSupplierId = normalizeId(supplierId, 'supplier_id');
  const cleanNumber = safeText(poNumber, 80);
  if (!cleanNumber) throw AppError.badRequest('po_number is required');
  const cleanExpectedAt = normalizeTimestamp(expectedAt, 'expected_at');
  if (status != null && String(status).toLowerCase() !== 'draft') {
    throw AppError.badRequest(
      'Purchase orders are created as draft and must use the governed transition workflow',
      'PHARMACY_PURCHASE_ORDER_INITIAL_STATUS_INVALID',
    );
  }
  try {
    return await setTenantTx(tid, async (tx) => {
      await assertSupplyFacilityGrantTx(tx, {
        tenantId: tid,
        facilityId: exactFacilityId,
        actorUid: createdBy,
        actorRole,
      });
      const authority = await tx.$queryRawUnsafe(
        `SELECT f.id AS facility_id, supplier.id AS supplier_id
           FROM facilities f
           JOIN pharmacy_suppliers supplier
             ON supplier.tenant_id=f.tenant_id
            AND supplier.id=$3::int
            AND supplier.facility_id=f.id
            AND supplier.status='active'
          WHERE f.tenant_id=$1::uuid
            AND f.id=$2::int
            AND f.status='active'
          FOR UPDATE OF f, supplier`,
        tid,
        exactFacilityId,
        exactSupplierId,
      );
      if (!authority[0]) {
        throw AppError.conflict(
          'Purchase orders require one active same-tenant facility and supplier',
          'PHARMACY_PURCHASE_ORDER_AUTHORITY_INVALID',
        );
      }
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_purchase_orders
         (tenant_id, facility_id, po_number, supplier_id, status,
          expected_at, total_amount_minor, currency, notes,
          metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10::jsonb, $11::uuid)
       RETURNING ${PO_RETURNING}`,
      tid, exactFacilityId,
      cleanNumber, exactSupplierId,
      'draft',
      cleanExpectedAt,
      normalizeBigInt(totalAmountMinor, 'total_amount_minor', { min: 0, max: 1_000_000_000_000 }),
      safeText(currency, 8) || 'INR',
      safeText(notes),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(createdBy, 'created_by'),
      );
      return rows[0];
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('po_number already exists');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid supplier_id or facility_id');
    throw err;
  }
}

export async function transitionPurchaseOrder({
  tenantId = null, id, nextStatus, cancellationReason = null, approvedBy = null,
  actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const poId = normalizeId(id, 'purchase_order id');
  const cleanStatus = normalizeEnum(nextStatus, PO_STATUSES, 'next_status', { required: true });
  if (cleanStatus === 'partially_received' || cleanStatus === 'fully_received') {
    throw AppError.conflict(
      'Receipt-derived purchase-order states can only be set by the governed GRN receive-line workflow',
      'PHARMACY_PURCHASE_ORDER_RECEIPT_STATE_DERIVED',
    );
  }
  if (cleanStatus === 'cancelled' && !safeText(cancellationReason)) {
    throw AppError.badRequest(
      'cancellation_reason is required when cancelling a purchase order',
      'PHARMACY_PURCHASE_ORDER_CANCELLATION_REASON_REQUIRED',
    );
  }
  if (cleanStatus === 'approved' && !approvedBy) {
    throw AppError.badRequest(
      'An authenticated approver is required',
      'PHARMACY_PURCHASE_ORDER_APPROVER_REQUIRED',
    );
  }
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
  if (cleanStatus === 'cancelled' && cancellationReason) {
    params.push(safeText(cancellationReason));
    updates.push(`cancellation_reason = $${params.length}`);
  }
  params.push(poId);
  params.push(tid);
  return setTenantTx(tid, async (tx) => {
    const authority = await tx.$queryRawUnsafe(
      `SELECT po.id, po.status, po.facility_id, po.supplier_id
         FROM pharmacy_purchase_orders po
         JOIN facilities facility
           ON facility.tenant_id=po.tenant_id
          AND facility.id=po.facility_id AND facility.status='active'
         JOIN pharmacy_suppliers supplier
           ON supplier.tenant_id=po.tenant_id
          AND supplier.id=po.supplier_id
          AND supplier.facility_id=po.facility_id
          AND supplier.status='active'
        WHERE po.tenant_id=$1::uuid AND po.id=$2::int
          AND COALESCE(po.metadata->>'authority_recovery_required', 'false') <> 'true'
          AND NOT EXISTS (
            SELECT 1
              FROM pharmacy_inventory_authority_recovery_worklist recovery
             WHERE recovery.tenant_id=po.tenant_id AND recovery.status='OPEN'
               AND (
                 (recovery.entity_type='purchase_order' AND recovery.entity_id=po.id)
                 OR (recovery.entity_type='purchase_order_item' AND EXISTS (
                   SELECT 1 FROM pharmacy_purchase_order_items child
                    WHERE child.tenant_id=po.tenant_id
                      AND child.purchase_order_id=po.id
                      AND child.id=recovery.entity_id
                 ))
               )
          )
        FOR UPDATE OF po, facility, supplier`,
      tid,
      poId,
    );
    if (!authority[0]) {
      throw AppError.conflict(
        'Purchase order authority is inactive or requires recovery',
        'PHARMACY_PURCHASE_ORDER_AUTHORITY_INVALID',
      );
    }
    await assertSupplyFacilityGrantTx(tx, {
      tenantId: tid,
      facilityId: Number(authority[0].facility_id),
      actorUid: approvedBy,
      actorRole,
    });
    if (cleanStatus === 'approved') {
      const approvers = await tx.$queryRawUnsafe(
        `SELECT u.uid
           FROM users u
           JOIN staff s ON s.tenant_id=u.tenant_id AND s.user_id=u.uid
          WHERE u.tenant_id=$1::uuid AND u.uid=$2::uuid
            AND UPPER(u.role) IN ('ADMIN','PHARMACY_INCHARGE','STORES_PURCHASE_INCHARGE')
            AND u.is_active=TRUE AND u.status='active' AND COALESCE(u.is_deleted,FALSE)=FALSE
            AND s.is_active=TRUE AND COALESCE(s.archived,FALSE)=FALSE AND s.archived_at IS NULL
          LIMIT 2
          FOR KEY SHARE OF u, s`,
        tid,
        String(approvedBy),
      );
      if (approvers.length !== 1) {
        throw AppError.forbidden(
          'Purchase-order approval requires active same-tenant supply-chain authority',
          'PHARMACY_PURCHASE_ORDER_APPROVER_AUTHORITY_REQUIRED',
        );
      }
    }
    if (cleanStatus === 'submitted' || cleanStatus === 'approved') {
      const allLines = await tx.$queryRawUnsafe(
        `SELECT id
           FROM pharmacy_purchase_order_items
          WHERE tenant_id=$1::uuid AND purchase_order_id=$2::int
          ORDER BY id
          FOR UPDATE`,
        tid,
        poId,
      );
      const validLines = await tx.$queryRawUnsafe(
        `SELECT poi.id
           FROM pharmacy_purchase_order_items poi
           JOIN pharmacy_inventory_items item
             ON item.tenant_id=poi.tenant_id AND item.id=poi.inventory_item_id
            AND item.facility_id=$3::int AND item.status='active'
           JOIN pharmacy_catalog catalog
             ON catalog.tenant_id=item.tenant_id AND catalog.id=item.catalog_id
            AND catalog.is_active=TRUE
          WHERE poi.tenant_id=$1::uuid AND poi.purchase_order_id=$2::int
            AND poi.ordered_quantity > 0
          ORDER BY poi.id
          FOR KEY SHARE OF item, catalog`,
        tid,
        poId,
        Number(authority[0].facility_id),
      );
      if (!allLines.length || validLines.length !== allLines.length) {
        throw AppError.conflict(
          'Every purchase-order line must reference one active catalog item in the order facility',
          'PHARMACY_PURCHASE_ORDER_LINE_AUTHORITY_INVALID',
        );
      }
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_purchase_orders SET ${updates.join(', ')}
       WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
         AND COALESCE(metadata->>'authority_recovery_required', 'false') <> 'true'
         AND (
           $1 <> 'cancelled'
           OR NOT EXISTS (
             SELECT 1
               FROM pharmacy_purchase_order_items received_line
              WHERE received_line.tenant_id=pharmacy_purchase_orders.tenant_id
                AND received_line.purchase_order_id=pharmacy_purchase_orders.id
                AND received_line.received_quantity > 0
           )
         )
         AND (
           $1 <> 'cancelled'
           OR NOT EXISTS (
             SELECT 1
               FROM pharmacy_goods_receipts receipt
              WHERE receipt.tenant_id=pharmacy_purchase_orders.tenant_id
                AND receipt.purchase_order_id=pharmacy_purchase_orders.id
           )
         )
         AND (
           (status='draft' AND $1 IN ('submitted', 'cancelled'))
           OR (status='submitted' AND $1 IN ('approved', 'cancelled'))
           OR (status='approved' AND $1='cancelled')
           OR (status='fully_received' AND $1='closed')
         )
       RETURNING ${PO_RETURNING}`,
      ...params,
    );
    if (!rows[0]) {
      throw AppError.conflict(
        'Purchase order transition is not permitted from its current state or while authority recovery is required',
        'PHARMACY_PURCHASE_ORDER_TRANSITION_INVALID',
      );
    }
    return rows[0];
  });
}

export async function addPurchaseOrderItem({
  tenantId = null, purchaseOrderId, inventoryItemId,
  orderedQuantity, unitPriceMinor = null, taxRatePct = null, notes = null,
  actorUid = null, actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const poId = normalizeId(purchaseOrderId, 'purchase_order_id');
  const itemId = normalizeId(inventoryItemId, 'inventory_item_id');
  const qty = normalizeQuantity(orderedQuantity, 'ordered_quantity', { min: 0.0001, required: true });
  let taxRate = null;
  if (taxRatePct !== null && taxRatePct !== undefined) {
    const v = Number(taxRatePct);
    if (!Number.isFinite(v) || v < 0 || v > 100) throw AppError.badRequest('tax_rate_pct must be 0..100');
    taxRate = v;
  }
  try {
    return await setTenantTx(tid, async (tx) => {
      const authority = await tx.$queryRawUnsafe(
        `SELECT po.id, po.facility_id
           FROM pharmacy_purchase_orders po
           JOIN pharmacy_inventory_items pii
             ON pii.tenant_id=po.tenant_id
            AND pii.id=$3::int
            AND pii.facility_id=po.facility_id
            AND pii.status='active'
           JOIN facilities f
             ON f.tenant_id=po.tenant_id
            AND f.id=po.facility_id
            AND f.status='active'
           JOIN pharmacy_catalog pc
             ON pc.tenant_id=pii.tenant_id
            AND pc.id=pii.catalog_id
            AND pc.is_active=TRUE
           JOIN pharmacy_suppliers supplier
             ON supplier.tenant_id=po.tenant_id
            AND supplier.id=po.supplier_id
            AND supplier.facility_id=po.facility_id
            AND supplier.status='active'
          WHERE po.tenant_id=$1::uuid
            AND po.id=$2::int
            AND po.status='draft'
            AND COALESCE(po.metadata->>'authority_recovery_required', 'false') <> 'true'
            AND NOT EXISTS (
              SELECT 1
                FROM pharmacy_inventory_authority_recovery_worklist recovery
               WHERE recovery.tenant_id=po.tenant_id AND recovery.status='OPEN'
                 AND (
                   (recovery.entity_type='purchase_order' AND recovery.entity_id=po.id)
                   OR (recovery.entity_type='purchase_order_item'
                     AND recovery.inventory_item_id=pii.id)
                 )
            )
          FOR UPDATE OF po, pii, f, pc, supplier`,
        tid,
        poId,
        itemId,
      );
      if (!authority[0]) {
        throw AppError.conflict(
          'PO lines require a draft order and an active item in the same facility',
          'PHARMACY_PURCHASE_ORDER_ITEM_AUTHORITY_INVALID',
        );
      }
      await assertSupplyFacilityGrantTx(tx, {
        tenantId: tid,
        facilityId: Number(authority[0].facility_id),
        actorUid,
        actorRole,
      });
      const rows = await tx.$queryRawUnsafe(
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
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('inventory_item already on this PO');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid purchase_order_id or inventory_item_id');
    throw err;
  }
}

export async function listPurchaseOrders({
  tenantId = null, facilityId = null, supplierId = null, status = null,
  limit = DEFAULT_LIST_LIMIT, actorUid = null, actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const exactFacilityId = normalizeId(facilityId, 'facility_id');
  const filters = ['tenant_id = $1::uuid', 'facility_id = $2::int'];
  const params = [tid, exactFacilityId];
  if (supplierId) {
    params.push(normalizeId(supplierId, 'supplier_id'));
    filters.push(`supplier_id = $${params.length}`);
  }
  if (status) {
    params.push(normalizeEnum(status, PO_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  const rows = await setTenantTx(tid, async (tx) => {
    await assertSupplyFacilityGrantTx(tx, {
      tenantId: tid,
      facilityId: exactFacilityId,
      actorUid,
      actorRole,
    });
    return tx.$queryRawUnsafe(
      `SELECT ${PO_RETURNING} FROM pharmacy_purchase_orders
       WHERE ${filters.join(' AND ')}
         AND EXISTS (
           SELECT 1
             FROM facilities facility
             JOIN pharmacy_suppliers supplier
               ON supplier.tenant_id=pharmacy_purchase_orders.tenant_id
              AND supplier.id=pharmacy_purchase_orders.supplier_id
              AND supplier.facility_id=pharmacy_purchase_orders.facility_id
              AND supplier.status='active'
            WHERE facility.tenant_id=pharmacy_purchase_orders.tenant_id
              AND facility.id=pharmacy_purchase_orders.facility_id
              AND facility.status='active'
         )
       ORDER BY ordered_at DESC NULLS LAST, created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
  });
  return { purchase_orders: rows, count: rows.length };
}

// ---------------------------------------------------------------------------
// Goods receipts (GRN)
// ---------------------------------------------------------------------------

export async function createGoodsReceipt({
  tenantId = null, facilityId = null,
  grnNumber, purchaseOrderId = null, supplierId = null,
  invoiceNumber = null, invoiceDate = null, totalAmountMinor = null,
  notes = null, receivedBy = null, metadata = null,
  actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const poId = normalizeId(purchaseOrderId, 'purchase_order_id');
  const requestedFacilityId = facilityId == null ? null : normalizeId(facilityId, 'facility_id');
  const requestedSupplierId = supplierId == null ? null : normalizeId(supplierId, 'supplier_id');
  const cleanNumber = safeText(grnNumber, 80);
  if (!cleanNumber) throw AppError.badRequest('grn_number is required');
  try {
    return await setTenantTx(tid, async (tx) => {
      const authority = await tx.$queryRawUnsafe(
        `SELECT po.id, po.facility_id, po.supplier_id
           FROM pharmacy_purchase_orders po
           JOIN facilities f
             ON f.tenant_id=po.tenant_id
            AND f.id=po.facility_id
            AND f.status='active'
           JOIN pharmacy_suppliers supplier
             ON supplier.tenant_id=po.tenant_id
            AND supplier.id=po.supplier_id
            AND supplier.facility_id=po.facility_id
            AND supplier.status='active'
          WHERE po.tenant_id=$1::uuid
            AND po.id=$2::int
            AND po.status IN ('approved', 'partially_received')
          FOR UPDATE OF po, f, supplier`,
        tid,
        poId,
      );
      if (!authority[0]
        || (requestedFacilityId != null
          && requestedFacilityId !== Number(authority[0].facility_id))
        || (requestedSupplierId != null
          && requestedSupplierId !== Number(authority[0].supplier_id))) {
        throw AppError.conflict(
          'The goods receipt must match an approved purchase order, active facility, and active supplier',
          'PHARMACY_GRN_AUTHORITY_INVALID',
        );
      }
      await assertSupplyFacilityGrantTx(tx, {
        tenantId: tid,
        facilityId: Number(authority[0].facility_id),
        actorUid: receivedBy,
        actorRole,
      });
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_goods_receipts
         (tenant_id, facility_id, grn_number, purchase_order_id, supplier_id,
          invoice_number, invoice_date, status, total_amount_minor, notes,
          received_by, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::date, 'received', $8, $9, $10::uuid, $11::jsonb)
       RETURNING id, tenant_id, facility_id, grn_number, purchase_order_id, supplier_id,
                 invoice_number, invoice_date, received_at, status, total_amount_minor,
                 notes, received_by, metadata, created_at, updated_at`,
      tid, Number(authority[0].facility_id),
      cleanNumber,
      poId,
      Number(authority[0].supplier_id),
      safeText(invoiceNumber, 120),
      normalizeDate(invoiceDate, 'invoice_date'),
      normalizeBigInt(totalAmountMinor, 'total_amount_minor', { min: 0, max: 1_000_000_000_000 }),
      safeText(notes),
      maybeUuid(receivedBy, 'received_by'),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      );
      return rows[0];
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('grn_number already exists');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid purchase_order_id or supplier_id');
    throw err;
  }
}

export async function listGoodsReceipts({
  tenantId = null, facilityId = null, status = null, supplierId = null,
  limit = DEFAULT_LIST_LIMIT, actorUid = null, actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const exactFacilityId = normalizeId(facilityId, 'facility_id');
  const filters = ['tenant_id = $1::uuid', 'facility_id = $2::int'];
  const params = [tid, exactFacilityId];
  if (status) {
    params.push(normalizeEnum(status, GRN_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (supplierId) {
    params.push(normalizeId(supplierId, 'supplier_id'));
    filters.push(`supplier_id = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  const rows = await setTenantTx(tid, async (tx) => {
    await assertSupplyFacilityGrantTx(tx, {
      tenantId: tid,
      facilityId: exactFacilityId,
      actorUid,
      actorRole,
    });
    return tx.$queryRawUnsafe(
      `SELECT id, tenant_id, facility_id, grn_number, purchase_order_id, supplier_id,
              invoice_number, invoice_date, received_at, status, total_amount_minor,
              notes, received_by, metadata, created_at, updated_at
       FROM pharmacy_goods_receipts
       WHERE ${filters.join(' AND ')}
         AND EXISTS (
           SELECT 1
             FROM pharmacy_purchase_orders po
             JOIN facilities facility
               ON facility.tenant_id=po.tenant_id
              AND facility.id=po.facility_id
              AND facility.status='active'
             JOIN pharmacy_suppliers supplier
               ON supplier.tenant_id=po.tenant_id
              AND supplier.id=po.supplier_id
              AND supplier.facility_id=po.facility_id
              AND supplier.status='active'
            WHERE po.tenant_id=pharmacy_goods_receipts.tenant_id
              AND po.id=pharmacy_goods_receipts.purchase_order_id
              AND po.facility_id=pharmacy_goods_receipts.facility_id
              AND po.supplier_id=pharmacy_goods_receipts.supplier_id
         )
       ORDER BY received_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
  });
  return { goods_receipts: rows, count: rows.length };
}

const GRN_QC_DECISIONS = ['passed', 'failed'];
const GRN_TRANSITION_ACTIONS = ['reject', 'finalize', 'close', 'archive'];

export async function recordGoodsReceiptItemQc({
  tenantId = null,
  goodsReceiptId,
  goodsReceiptItemId,
  qcStatus,
  qcNotes = null,
  performedBy = null,
  actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const grnId = normalizeId(goodsReceiptId, 'goods_receipt_id');
  const grnItemId = normalizeId(goodsReceiptItemId, 'goods_receipt_item_id');
  const decision = normalizeEnum(qcStatus, GRN_QC_DECISIONS, 'qc_status', { required: true });
  const performerUid = normalizeFacilityActor(performedBy, actorRole).actorUid;
  const cleanNotes = safeText(qcNotes);

  return setTenantTx(tid, async (tx) => {
    const authorityRows = await tx.$queryRawUnsafe(
      `SELECT grn.id AS goods_receipt_id, grn.facility_id,
              grn.status AS goods_receipt_status,
              line.id AS goods_receipt_item_id, line.inventory_item_id,
              line.inventory_batch_id, line.qc_status, line.qc_notes,
              batch.status AS batch_status, batch.expiry_date::text AS expiry_date
         FROM pharmacy_goods_receipts grn
         JOIN pharmacy_purchase_orders po
           ON po.tenant_id=grn.tenant_id
          AND po.id=grn.purchase_order_id
          AND po.facility_id=grn.facility_id
          AND po.supplier_id=grn.supplier_id
         JOIN facilities facility
           ON facility.tenant_id=grn.tenant_id
          AND facility.id=grn.facility_id
          AND facility.status='active'
         JOIN pharmacy_suppliers supplier
           ON supplier.tenant_id=grn.tenant_id
          AND supplier.id=grn.supplier_id
          AND supplier.facility_id=grn.facility_id
         JOIN pharmacy_goods_receipt_items line
           ON line.tenant_id=grn.tenant_id
          AND line.goods_receipt_id=grn.id
          AND line.id=$3::int
         JOIN pharmacy_inventory_items item
           ON item.tenant_id=line.tenant_id
          AND item.id=line.inventory_item_id
          AND item.facility_id=grn.facility_id
          AND item.status='active'
         JOIN pharmacy_catalog catalog
           ON catalog.tenant_id=item.tenant_id
          AND catalog.id=item.catalog_id
          AND catalog.is_active=TRUE
         JOIN pharmacy_inventory_batches batch
           ON batch.tenant_id=line.tenant_id
          AND batch.id=line.inventory_batch_id
          AND batch.inventory_item_id=line.inventory_item_id
          AND batch.facility_id=grn.facility_id
          AND batch.goods_receipt_id=grn.id
         JOIN facility_locations location
           ON location.tenant_id=batch.tenant_id
          AND location.facility_id=batch.facility_id
          AND location.id=batch.storage_location_id
          AND location.status='active'
        WHERE grn.tenant_id=$1::uuid AND grn.id=$2::int
          AND COALESCE(grn.metadata->>'authority_recovery_required', 'false') <> 'true'
        FOR UPDATE OF grn, po, facility, supplier, line, item, catalog, batch, location`,
      tid,
      grnId,
      grnItemId,
    );
    const authority = authorityRows[0];
    if (!authority) {
      throw AppError.conflict(
        'The goods receipt line must retain its exact supplier and one active item, batch, storage, and facility authority chain',
        'PHARMACY_GRN_QC_AUTHORITY_INVALID',
      );
    }
    await assertSupplyFacilityGrantTx(tx, {
      tenantId: tid,
      facilityId: Number(authority.facility_id),
      actorUid: performerUid,
      actorRole,
    });

    if (GRN_QC_DECISIONS.includes(authority.qc_status)) {
      if (authority.qc_status !== decision) {
        throw AppError.conflict(
          'A completed goods receipt line QC decision is immutable',
          'PHARMACY_GRN_QC_IMMUTABLE',
        );
      }
      return {
        goods_receipt_item: {
          id: Number(authority.goods_receipt_item_id),
          goods_receipt_id: Number(authority.goods_receipt_id),
          inventory_item_id: Number(authority.inventory_item_id),
          inventory_batch_id: Number(authority.inventory_batch_id),
          qc_status: authority.qc_status,
          qc_notes: authority.qc_notes,
        },
        batch: {
          id: Number(authority.inventory_batch_id),
          status: authority.batch_status,
          facility_id: Number(authority.facility_id),
        },
      };
    }
    if (authority.goods_receipt_status !== 'qc_pending') {
      throw AppError.conflict(
        'Only a QC-pending goods receipt can accept a line decision',
        'PHARMACY_GRN_TERMINAL',
      );
    }
    if (decision === 'passed') {
      const expiry = normalizeDate(authority.expiry_date, 'stored expiry_date', { required: true });
      const todayRows = await tx.$queryRawUnsafe(
        `SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS today`,
      );
      if (expiry < String(todayRows[0]?.today || '')) {
        throw AppError.conflict(
          'Expired stock cannot pass goods receipt quality control',
          'PHARMACY_GRN_QC_EXPIRED',
        );
      }
    }

    const lineRows = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_goods_receipt_items
          SET qc_status=$3, qc_notes=$4,
              metadata=COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object(
                  'qc_performed_by', $5::uuid,
                  'qc_decided_at', NOW()
                ),
              updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int
          AND goods_receipt_id=$6::int
          AND COALESCE(qc_status, 'pending')='pending'
        RETURNING id, tenant_id, goods_receipt_id, inventory_item_id,
                  inventory_batch_id, purchase_order_item_id,
                  received_quantity, unit_cost_minor, qc_status, qc_notes,
                  metadata, created_at, updated_at`,
      tid,
      grnItemId,
      decision,
      cleanNotes,
      performerUid,
      grnId,
    );
    if (!lineRows[0]) {
      throw AppError.conflict(
        'The goods receipt line QC decision changed concurrently',
        'PHARMACY_GRN_QC_IMMUTABLE',
      );
    }
    const batchRows = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_inventory_batches
          SET status=$3, updated_at=NOW(),
              metadata=COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object(
                  'grn_qc_status', $4::text,
                  'grn_qc_performed_by', $5::uuid,
                  'grn_qc_decided_at', NOW()
                )
        WHERE tenant_id=$1::uuid AND id=$2::int
          AND goods_receipt_id=$6::int
          AND status='quarantined'
        RETURNING ${BATCH_RETURNING}`,
      tid,
      Number(authority.inventory_batch_id),
      decision === 'passed' ? 'in_stock' : 'quarantined',
      decision,
      performerUid,
      grnId,
    );
    if (!batchRows[0]) {
      throw AppError.conflict(
        'The received batch is no longer in its governed quarantine state',
        'PHARMACY_GRN_QC_BATCH_STATE_INVALID',
      );
    }
    return { goods_receipt_item: lineRows[0], batch: batchRows[0] };
  });
}

export async function transitionGoodsReceipt({
  tenantId = null,
  id,
  action,
  performedBy = null,
  actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const grnId = normalizeId(id, 'goods_receipt_id');
  const cleanAction = normalizeEnum(action, GRN_TRANSITION_ACTIONS, 'action', { required: true });
  const performerUid = normalizeFacilityActor(performedBy, actorRole).actorUid;

  return setTenantTx(tid, async (tx) => {
    const receiptRows = await tx.$queryRawUnsafe(
      `SELECT grn.id, grn.tenant_id, grn.facility_id, grn.grn_number,
              grn.purchase_order_id, grn.supplier_id, grn.invoice_number,
              grn.invoice_date, grn.received_at, grn.status,
              grn.total_amount_minor, grn.notes, grn.received_by,
              grn.metadata, grn.created_at, grn.updated_at
         FROM pharmacy_goods_receipts grn
         JOIN pharmacy_purchase_orders po
           ON po.tenant_id=grn.tenant_id
          AND po.id=grn.purchase_order_id
          AND po.facility_id=grn.facility_id
          AND po.supplier_id=grn.supplier_id
         JOIN facilities facility
           ON facility.tenant_id=grn.tenant_id
          AND facility.id=grn.facility_id
          AND facility.status='active'
         JOIN pharmacy_suppliers supplier
           ON supplier.tenant_id=grn.tenant_id
          AND supplier.id=grn.supplier_id
          AND supplier.facility_id=grn.facility_id
        WHERE grn.tenant_id=$1::uuid AND grn.id=$2::int
          AND COALESCE(grn.metadata->>'authority_recovery_required', 'false') <> 'true'
        FOR UPDATE OF grn, po, facility, supplier`,
      tid,
      grnId,
    );
    const receipt = receiptRows[0];
    if (!receipt) {
      throw AppError.conflict(
        'The goods receipt must retain its exact purchase-order, facility, and supplier lineage',
        'PHARMACY_GRN_AUTHORITY_INVALID',
      );
    }
    await assertSupplyFacilityGrantTx(tx, {
      tenantId: tid,
      facilityId: Number(receipt.facility_id),
      actorUid: performerUid,
      actorRole,
    });

    const aggregateRows = await tx.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS total_count,
              COUNT(*) FILTER (WHERE COALESCE(qc_status, 'pending')='pending')::int AS pending_count,
              COUNT(*) FILTER (WHERE qc_status='passed')::int AS passed_count,
              COUNT(*) FILTER (WHERE qc_status='failed')::int AS failed_count
         FROM pharmacy_goods_receipt_items
        WHERE tenant_id=$1::uuid AND goods_receipt_id=$2::int`,
      tid,
      grnId,
    );
    const aggregate = aggregateRows[0] || {};
    const totalCount = Number(aggregate.total_count || 0);
    const pendingCount = Number(aggregate.pending_count || 0);
    const passedCount = Number(aggregate.passed_count || 0);
    const failedCount = Number(aggregate.failed_count || 0);
    let nextStatus;
    let allowedCurrent;

    if (cleanAction === 'reject') {
      if (receipt.status === 'rejected') return receipt;
      if (!['received', 'qc_pending'].includes(receipt.status) || totalCount !== 0) {
        throw AppError.conflict(
          'A goods receipt can only be rejected before any receipt lines are recorded',
          'PHARMACY_GRN_REJECT_NOT_ALLOWED',
        );
      }
      nextStatus = 'rejected';
      allowedCurrent = ['received', 'qc_pending'];
    } else if (cleanAction === 'finalize') {
      if (['qc_passed', 'qc_failed', 'partial'].includes(receipt.status)) return receipt;
      if (receipt.status !== 'qc_pending' || totalCount === 0 || pendingCount !== 0
        || passedCount + failedCount !== totalCount) {
        throw AppError.conflict(
          'A goods receipt can only be finalized after every recorded line has an immutable QC decision',
          'PHARMACY_GRN_FINALIZE_NOT_ALLOWED',
        );
      }
      nextStatus = passedCount === totalCount
        ? 'qc_passed'
        : (failedCount === totalCount ? 'qc_failed' : 'partial');
      allowedCurrent = ['qc_pending'];
    } else if (cleanAction === 'close') {
      if (receipt.status === 'closed') return receipt;
      if (!['qc_passed', 'partial'].includes(receipt.status)
        || pendingCount !== 0 || passedCount === 0) {
        throw AppError.conflict(
          'Only a finalized goods receipt with accepted stock can be closed',
          'PHARMACY_GRN_CLOSE_NOT_ALLOWED',
        );
      }
      nextStatus = 'closed';
      allowedCurrent = ['qc_passed', 'partial'];
    } else {
      if (receipt.status === 'archived') return receipt;
      if (!['closed', 'qc_failed'].includes(receipt.status)) {
        throw AppError.conflict(
          'Only a closed or wholly failed goods receipt can be archived',
          'PHARMACY_GRN_ARCHIVE_NOT_ALLOWED',
        );
      }
      nextStatus = 'archived';
      allowedCurrent = ['closed', 'qc_failed'];
    }

    const updatedRows = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_goods_receipts
          SET status=$3,
              metadata=COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object(
                  $4::text || '_by', $5::uuid,
                  $4::text || '_at', NOW()
                ),
              updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int
          AND status=ANY($6::text[])
        RETURNING id, tenant_id, facility_id, grn_number, purchase_order_id,
                  supplier_id, invoice_number, invoice_date, received_at,
                  status, total_amount_minor, notes, received_by, metadata,
                  created_at, updated_at`,
      tid,
      grnId,
      nextStatus,
      cleanAction,
      performerUid,
      allowedCurrent,
    );
    if (!updatedRows[0]) {
      throw AppError.conflict(
        'The goods receipt lifecycle state changed concurrently',
        'PHARMACY_GRN_TERMINAL',
      );
    }
    return updatedRows[0];
  });
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
  commandKey = null,
  requestFingerprint = null,
  actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const itemId = normalizeId(inventoryItemId, 'inventory_item_id');
  const cleanKind = normalizeEnum(movementKind, MOVEMENT_KINDS, 'movement_kind', { required: true });
  const delta = normalizeQuantity(quantityDelta, 'quantity_delta', {
    min: -1_000_000_000,
    max: 1_000_000_000,
    required: true,
  });
  if (delta === 0) {
    throw AppError.badRequest('quantity_delta must be a non-zero number');
  }
  if (SUPPLY_DECREASING_MOVEMENTS.has(cleanKind) && delta >= 0) {
    throw AppError.badRequest(
      `${cleanKind} requires a negative quantity_delta`,
      'PHARMACY_STOCK_MOVEMENT_DIRECTION_INVALID',
    );
  }
  if (SUPPLY_INCREASING_MOVEMENTS.has(cleanKind) && delta <= 0) {
    throw AppError.badRequest(
      `${cleanKind} requires a positive quantity_delta`,
      'PHARMACY_STOCK_MOVEMENT_DIRECTION_INVALID',
    );
  }
  if (cleanKind === 'recall') {
    throw AppError.conflict(
      'Batch recall is a status-only quarantine action; use the batch recall endpoint',
      'INVENTORY_RECALL_REQUIRES_BATCH_RECALL_PATH',
    );
  }
  if (SUPPLY_DECREASING_MOVEMENTS.has(cleanKind) || delta < 0) {
    throw AppError.conflict(
      'Inventory decrements must be composed by a typed authoritative custody workflow',
      'INVENTORY_DECREASE_REQUIRES_GOVERNED_WORKFLOW',
    );
  }
  const batchId = inventoryBatchId
    ? normalizeId(inventoryBatchId, 'inventory_batch_id')
    : null;
  if (!batchId) {
    throw AppError.badRequest(
      'inventory_batch_id is required so the stock ledger and batch balance stay atomic',
      'INVENTORY_BATCH_REQUIRED',
    );
  }
  const cleanCommandKey = String(commandKey || '').trim();
  const cleanRequestFingerprint = String(requestFingerprint || '').trim().toLowerCase();
  if (!IDEMPOTENCY_KEY_RE.test(cleanCommandKey)
    || !/^[0-9a-f]{64}$/.test(cleanRequestFingerprint)) {
    throw AppError.conflict(
      'Stock movement requires durable idempotency authority',
      'PHARMACY_STOCK_MOVEMENT_IDEMPOTENCY_REQUIRED',
    );
  }
  const durableCommand = {
    keySha256: createHash('sha256').update(cleanCommandKey).digest('hex'),
    requestSha256: cleanRequestFingerprint,
  };
  const cleanReferenceType = safeText(referenceType, 60);
  const cleanReferenceId = safeText(referenceId, 120);
  const cleanNotes = safeText(notes);
  const movementMetadata = normalizeJsonObject(metadata, 'metadata');

  try {
    return await setTenantTx(tid, async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))::text AS lock_acquired`,
        `pharmacy_supply_stock_movement_v1:${tid}:${durableCommand.keySha256}`,
      );
      const prior = await tx.$queryRawUnsafe(
          `SELECT ${selectAliasedFields('movement', 'movement', MOVEMENT_FIELDS)},
                  batch.id AS lineage_batch_id,
                  batch.inventory_item_id AS lineage_inventory_item_id,
                  batch.facility_id AS lineage_facility_id,
                  item.id AS lineage_item_id,
                  item.facility_id AS lineage_item_facility_id,
                  item.schedule_class AS lineage_item_schedule_class,
                  item.is_narcotic AS lineage_item_is_narcotic,
                  item.unit_label AS lineage_item_unit_label,
                  ${CONTROLLED_REGISTER_REPLAY_SELECT}
             FROM pharmacy_stock_movements movement
             LEFT JOIN pharmacy_inventory_batches batch
               ON batch.tenant_id=movement.tenant_id
               AND batch.id=movement.inventory_batch_id
               AND batch.inventory_item_id=movement.inventory_item_id
             LEFT JOIN pharmacy_inventory_items item
               ON item.tenant_id=movement.tenant_id
              AND item.id=movement.inventory_item_id
              AND item.facility_id=batch.facility_id
             ${CONTROLLED_REGISTER_REPLAY_JOIN}
            WHERE movement.tenant_id=$1::uuid
              AND movement.metadata->>'contract'='pharmacy_supply_stock_movement_v1'
              AND movement.metadata->>'command_key_sha256'=$2
            ORDER BY movement.id
            LIMIT 2`,
          tid,
          durableCommand.keySha256,
      );
      if (prior.length) {
        if (prior.length !== 1) {
          throw AppError.conflict(
            'Idempotency-Key was already used for a different stock movement',
            'INVENTORY_COMMAND_REPLAY_CONFLICT',
          );
        }
        const replayRow = prior[0];
        const incompleteMessage = 'The stock movement committed without complete immutable lineage and requires recovery';
        const { metadata: replayMetadata, intent, facilityId: replayFacilityId } = requireReplayMetadata(replayRow, {
          contract: 'pharmacy_supply_stock_movement_v1',
          commandKeySha256: durableCommand.keySha256,
          requestField: 'request_sha256',
          requestFingerprint: durableCommand.requestSha256,
          conflictMessage: 'Idempotency-Key was already used for a different stock movement',
          conflictCode: 'INVENTORY_COMMAND_REPLAY_CONFLICT',
          incompleteMessage,
          incompleteCode: 'INVENTORY_COMMAND_RECEIPT_INCOMPLETE',
        });
        const replayMovement = extractAliasedFields(replayRow, 'movement', MOVEMENT_FIELDS);
        const movementResponse = requireMovementResponse(
          replayMetadata,
          incompleteMessage,
          'INVENTORY_COMMAND_RECEIPT_INCOMPLETE',
        );
        const replayControlled = isControlledSupplyItem({
          schedule_class: replayRow.lineage_item_schedule_class,
          is_narcotic: replayRow.lineage_item_is_narcotic === true,
        });
        if (!replayMovement || !intentMatches(intent, {
          facility_id: replayFacilityId,
          inventory_item_id: Number(replayMovement.inventory_item_id),
          inventory_batch_id: Number(replayMovement.inventory_batch_id),
          movement_kind: String(replayMovement.movement_kind),
          quantity_delta: Number(replayMovement.quantity_delta),
          reference_type: replayMovement.reference_type ?? null,
          reference_id: replayMovement.reference_id ?? null,
          performed_by: replayMovement.performed_by ?? null,
          notes: replayMovement.notes ?? null,
          controlled: replayControlled,
        })
          || !intentMatches(movementResponse, {
            contract: 'pharmacy_supply_stock_movement_v1',
            facility_id: replayFacilityId,
            inventory_item_id: Number(replayMovement.inventory_item_id),
            inventory_batch_id: Number(replayMovement.inventory_batch_id),
            movement_kind: String(replayMovement.movement_kind),
            quantity_delta: Number(replayMovement.quantity_delta),
            reference_type: replayMovement.reference_type ?? null,
            reference_id: replayMovement.reference_id ?? null,
            performed_by: replayMovement.performed_by ?? null,
            notes: replayMovement.notes ?? null,
          })
          || Number(replayRow.lineage_batch_id) !== Number(replayMovement.inventory_batch_id)
          || Number(replayRow.lineage_inventory_item_id) !== Number(replayMovement.inventory_item_id)
          || Number(replayRow.lineage_facility_id) !== replayFacilityId) {
          throw AppError.conflict(
            incompleteMessage,
            'INVENTORY_COMMAND_RECEIPT_INCOMPLETE',
          );
        }
        requireControlledRegisterEvidence(
          replayRow,
          intent,
          {
            facilityId: replayFacilityId,
            inventoryItemId: Number(replayMovement.inventory_item_id),
            inventoryBatchId: Number(replayMovement.inventory_batch_id),
            movementKind: String(replayMovement.movement_kind),
            quantity: Number(replayMovement.quantity_delta),
            performedBy: replayMovement.performed_by,
          },
          incompleteMessage,
          'INVENTORY_COMMAND_RECEIPT_INCOMPLETE',
        );
        await assertSupplyFacilityGrantTx(tx, {
          tenantId: tid,
          facilityId: replayFacilityId,
          actorUid: performedBy,
          actorRole,
        });
        return {
          ...replayMovement,
          facility_id: replayFacilityId,
        };
      }
      const ledgerRows = await tx.$queryRawUnsafe(
        `SELECT item.id, item.facility_id, item.status, item.schedule_class,
                item.is_narcotic, item.unit_label, batch.status AS batch_status
           FROM pharmacy_inventory_items item
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
            AND batch.id=$3::int
            AND batch.inventory_item_id=item.id
            AND batch.facility_id=item.facility_id
            AND (
              batch.status='in_stock'
              OR ($4::text='return' AND batch.status='depleted')
            )
            AND batch.expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
            AND EXISTS (
              SELECT 1 FROM facility_locations location
               WHERE location.tenant_id=batch.tenant_id
                 AND location.facility_id=batch.facility_id
                 AND location.id=batch.storage_location_id
                 AND location.status='active'
            )
           JOIN pharmacy_suppliers supplier
             ON supplier.tenant_id=batch.tenant_id
            AND supplier.id=batch.supplier_id
            AND supplier.facility_id=batch.facility_id
            AND supplier.status='active'
          WHERE item.tenant_id=$1::uuid AND item.id=$2::int
            AND item.status='active'
          FOR UPDATE OF item, catalog, facility, batch, supplier`,
        tid,
        itemId,
        batchId,
        cleanKind,
      );
      const ledgerItem = ledgerRows[0];
      if (!ledgerItem) {
        throw AppError.conflict(
          'The item, batch, facility, catalog, and supplier must form one active stock authority chain',
          'PHARMACY_STOCK_MOVEMENT_AUTHORITY_INVALID',
        );
      }
      await assertSupplyFacilityGrantTx(tx, {
        tenantId: tid,
        facilityId: Number(ledgerItem.facility_id),
        actorUid: performedBy,
        actorRole,
      });
      const controlled = ledgerItem && isControlledSupplyItem(ledgerItem);
      const performerUid = controlled
        ? requireControlledPerformer(maybeUuid(performedBy, 'performed_by'))
        : maybeUuid(performedBy, 'performed_by');
      const registerEvidence = controlled
        ? await prepareControlledSupplyRegisterTx(tx, {
          tenantId: tid,
          item: ledgerItem,
          inventoryItemId: itemId,
          facilityId: Number(ledgerItem.facility_id),
          movementKind: cleanKind,
          quantityDelta: delta,
        })
        : null;
      const movementResponse = immutableResponseSnapshot({
        contract: 'pharmacy_supply_stock_movement_v1',
        facility_id: Number(ledgerItem.facility_id),
        inventory_item_id: itemId,
        inventory_batch_id: batchId,
        movement_kind: cleanKind,
        quantity_delta: delta,
        reference_type: cleanReferenceType,
        reference_id: cleanReferenceId,
        performed_by: performerUid,
        notes: cleanNotes,
      });
      const { movement } = await recordMovementTx(tx, {
        tenantId: tid,
        inventory_item_id: itemId,
        inventory_batch_id: batchId,
        movement_kind: cleanKind,
        quantity: Math.abs(delta),
        reference_type: cleanReferenceType,
        reference_id: cleanReferenceId,
        performed_by: performerUid,
        notes: cleanNotes,
        expected_facility_id: Number(ledgerItem.facility_id),
        metadata: {
          ...movementMetadata,
          contract: 'pharmacy_supply_stock_movement_v1',
          command_key_sha256: durableCommand.keySha256,
          request_sha256: durableCommand.requestSha256,
          facility_id: Number(ledgerItem.facility_id),
          intent: {
            facility_id: Number(ledgerItem.facility_id),
            inventory_item_id: itemId,
            inventory_batch_id: batchId,
            movement_kind: cleanKind,
            quantity_delta: delta,
            reference_type: cleanReferenceType,
            reference_id: cleanReferenceId,
            performed_by: performerUid,
            notes: cleanNotes,
            controlled,
            register_evidence: registerEvidence,
          },
          response: movementResponse,
        },
        require_usable_batch: ['issue', 'transfer_out', 'adjust_decrease'].includes(cleanKind),
      });
      if (controlled) {
        await appendControlledSupplyRegisterTx(tx, {
          tenantId: tid,
          item: ledgerItem,
          inventoryItemId: itemId,
          inventoryBatchId: batchId,
          movementKind: cleanKind,
          quantity: delta,
          performedBy: performerUid,
          referenceMovementId: movement?.id || null,
          notes: cleanNotes,
          registerEvidence,
        });
      }
      const response = {
        ...movement,
        facility_id: Number(ledgerItem.facility_id),
      };
      return response;
    });
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function listStockMovements({
  tenantId = null, inventoryItemId = null, inventoryBatchId = null,
  movementKind = null, facilityId = null, limit = DEFAULT_LIST_LIMIT,
  actorUid = null, actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const exactFacilityId = normalizeId(facilityId, 'facility_id');
  const filters = ['movement.tenant_id = $1::uuid', 'item.facility_id = $2::int'];
  const params = [tid, exactFacilityId];
  if (inventoryItemId) {
    params.push(normalizeId(inventoryItemId, 'inventory_item_id'));
    filters.push(`movement.inventory_item_id = $${params.length}`);
  }
  if (inventoryBatchId) {
    params.push(normalizeId(inventoryBatchId, 'inventory_batch_id'));
    filters.push(`movement.inventory_batch_id = $${params.length}`);
  }
  if (movementKind) {
    params.push(normalizeEnum(movementKind, MOVEMENT_KINDS, 'movement_kind'));
    filters.push(`movement.movement_kind = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  const rows = await setTenantTx(tid, async (tx) => {
    await assertSupplyFacilityGrantTx(tx, {
      tenantId: tid,
      facilityId: exactFacilityId,
      actorUid,
      actorRole,
    });
    return tx.$queryRawUnsafe(
      `SELECT movement.id, movement.tenant_id, movement.inventory_item_id,
              movement.inventory_batch_id, movement.movement_kind,
              movement.quantity_delta, movement.reference_type,
              movement.reference_id, movement.performed_by,
              movement.notes, movement.metadata, movement.created_at
         FROM pharmacy_stock_movements movement
         JOIN pharmacy_inventory_items item
           ON item.tenant_id=movement.tenant_id
          AND item.id=movement.inventory_item_id
          AND item.status='active'
         JOIN pharmacy_catalog catalog
           ON catalog.tenant_id=item.tenant_id
          AND catalog.id=item.catalog_id
          AND catalog.is_active=TRUE
         JOIN facilities facility
           ON facility.tenant_id=item.tenant_id
          AND facility.id=item.facility_id
          AND facility.status='active'
         JOIN pharmacy_inventory_batches batch
           ON batch.tenant_id=movement.tenant_id
          AND batch.id=movement.inventory_batch_id
          AND batch.inventory_item_id=item.id
          AND batch.facility_id=item.facility_id
         JOIN pharmacy_suppliers supplier
           ON supplier.tenant_id=batch.tenant_id
          AND supplier.id=batch.supplier_id
          AND supplier.facility_id=batch.facility_id
        WHERE ${filters.join(' AND ')}
          AND EXISTS (
            SELECT 1 FROM facility_locations location
             WHERE location.tenant_id=batch.tenant_id
               AND location.facility_id=batch.facility_id
               AND location.id=batch.storage_location_id
               AND location.status='active'
          )
        ORDER BY movement.created_at DESC
        LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
  });
  return { movements: rows, count: rows.length };
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
  tenantId = null, facilityId = null, lookaheadDays = 90,
  actorUid = null, actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const exactFacilityId = normalizeId(facilityId, 'facility_id');
  const days = normalizeInt(lookaheadDays, 'lookahead_days', { min: 1, max: 3650 });
  return setTenantTx(tid, async (tx) => {
    await assertSupplyFacilityGrantTx(tx, {
      tenantId: tid,
      facilityId: exactFacilityId,
      actorUid,
      actorRole,
    });
    const rows = await tx.$queryRawUnsafe(
      `SELECT batch.id, batch.inventory_item_id, batch.expiry_date,
              (batch.expiry_date - CURRENT_DATE)::int AS days_remaining
         FROM pharmacy_inventory_batches batch
         JOIN pharmacy_inventory_items item
           ON item.tenant_id=batch.tenant_id
          AND item.id=batch.inventory_item_id
          AND item.facility_id=batch.facility_id
          AND item.status='active'
         JOIN pharmacy_catalog catalog
           ON catalog.tenant_id=item.tenant_id
          AND catalog.id=item.catalog_id
          AND catalog.is_active=TRUE
         JOIN facilities facility
           ON facility.tenant_id=item.tenant_id
          AND facility.id=item.facility_id
          AND facility.status='active'
         JOIN pharmacy_suppliers supplier
           ON supplier.tenant_id=batch.tenant_id
          AND supplier.id=batch.supplier_id
          AND supplier.facility_id=batch.facility_id
        WHERE batch.tenant_id=$1::uuid AND batch.facility_id=$2::int
          AND batch.status IN ('in_stock', 'reserved')
          AND batch.expiry_date <= CURRENT_DATE + ($3::int * INTERVAL '1 day')
          AND EXISTS (
            SELECT 1 FROM facility_locations location
             WHERE location.tenant_id=batch.tenant_id
               AND location.facility_id=batch.facility_id
               AND location.id=batch.storage_location_id
               AND location.status='active'
          )
        FOR UPDATE OF batch, item, catalog, facility, supplier`,
      tid,
      exactFacilityId,
      days,
    );
    let created = 0;
    for (const row of rows) {
      const severity = severityForDaysRemaining(row.days_remaining);
      const existing = await tx.$queryRawUnsafe(
        `SELECT id FROM pharmacy_expiry_alerts
         WHERE tenant_id = $1::uuid AND inventory_batch_id = $2 AND status = 'open'
         LIMIT 1
         FOR UPDATE`,
        tid, row.id,
      );
      if (existing[0]) {
        await tx.$queryRawUnsafe(
          `UPDATE pharmacy_expiry_alerts
           SET days_remaining = $1, severity = $2, updated_at = NOW()
           WHERE id = $3 AND tenant_id = $4::uuid`,
          row.days_remaining, severity, existing[0].id, tid,
        );
      } else {
        await tx.$queryRawUnsafe(
          `INSERT INTO pharmacy_expiry_alerts
             (tenant_id, inventory_batch_id, inventory_item_id,
              expiry_date, days_remaining, severity, status)
           VALUES ($1::uuid, $2, $3, $4::date, $5, $6, 'open')`,
          tid, row.id, row.inventory_item_id, row.expiry_date,
          row.days_remaining, severity,
        );
        created += 1;
      }
    }
    return { scanned: rows.length, created, lookahead_days: days };
  });
}

export async function acknowledgeExpiryAlert({
  tenantId = null, id, acknowledgedBy, resolution = null, actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const alertId = normalizeId(id, 'expiry_alert id');
  const ackedBy = maybeUuid(acknowledgedBy, 'acknowledged_by');
  if (!ackedBy) throw AppError.badRequest('acknowledged_by is required');
  return setTenantTx(tid, async (tx) => {
    const authorityRows = await tx.$queryRawUnsafe(
      `SELECT batch.facility_id
         FROM pharmacy_expiry_alerts alert
         JOIN pharmacy_inventory_batches batch
           ON batch.tenant_id=alert.tenant_id
          AND batch.id=alert.inventory_batch_id
         JOIN pharmacy_inventory_items item
           ON item.tenant_id=batch.tenant_id
          AND item.id=batch.inventory_item_id
          AND item.facility_id=batch.facility_id
          AND item.status='active'
         JOIN pharmacy_catalog catalog
           ON catalog.tenant_id=item.tenant_id
          AND catalog.id=item.catalog_id
          AND catalog.is_active=TRUE
         JOIN facilities facility
           ON facility.tenant_id=item.tenant_id
          AND facility.id=item.facility_id
          AND facility.status='active'
         JOIN pharmacy_suppliers supplier
           ON supplier.tenant_id=batch.tenant_id
          AND supplier.id=batch.supplier_id
          AND supplier.facility_id=batch.facility_id
        WHERE alert.tenant_id=$1::uuid AND alert.id=$2::int
          AND alert.status='open'
          AND EXISTS (
            SELECT 1 FROM facility_locations location
             WHERE location.tenant_id=batch.tenant_id
               AND location.facility_id=batch.facility_id
               AND location.id=batch.storage_location_id
               AND location.status='active'
          )
        FOR UPDATE OF alert, batch, item, catalog, facility, supplier`,
      tid,
      alertId,
    );
    if (!authorityRows[0]) throw AppError.notFound('Expiry alert not found or not open');
    await assertSupplyFacilityGrantTx(tx, {
      tenantId: tid,
      facilityId: Number(authorityRows[0].facility_id),
      actorUid: ackedBy,
      actorRole,
    });
    const rows = await tx.$queryRawUnsafe(
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
  });
}

export async function listExpiryAlerts({
  tenantId = null, facilityId = null, status = null, severity = null,
  limit = DEFAULT_LIST_LIMIT, actorUid = null, actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const exactFacilityId = normalizeId(facilityId, 'facility_id');
  const filters = ['alert.tenant_id = $1::uuid', 'batch.facility_id = $2::int'];
  const params = [tid, exactFacilityId];
  if (status) {
    params.push(normalizeEnum(status, EXPIRY_STATUSES, 'status'));
    filters.push(`alert.status = $${params.length}`);
  }
  if (severity) {
    params.push(normalizeEnum(severity, EXPIRY_SEVERITIES, 'severity'));
    filters.push(`alert.severity = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  const rows = await setTenantTx(tid, async (tx) => {
    await assertSupplyFacilityGrantTx(tx, {
      tenantId: tid,
      facilityId: exactFacilityId,
      actorUid,
      actorRole,
    });
    return tx.$queryRawUnsafe(
      `SELECT alert.id, alert.tenant_id, alert.inventory_batch_id,
              alert.inventory_item_id, alert.expiry_date, alert.days_remaining,
              alert.severity, alert.status, alert.acknowledged_by,
              alert.acknowledged_at, alert.resolution, alert.resolved_at,
              alert.metadata, alert.created_at, alert.updated_at
         FROM pharmacy_expiry_alerts alert
         JOIN pharmacy_inventory_batches batch
           ON batch.tenant_id=alert.tenant_id
          AND batch.id=alert.inventory_batch_id
         JOIN pharmacy_inventory_items item
           ON item.tenant_id=batch.tenant_id
          AND item.id=batch.inventory_item_id
          AND item.facility_id=batch.facility_id
          AND item.status='active'
         JOIN pharmacy_catalog catalog
           ON catalog.tenant_id=item.tenant_id
          AND catalog.id=item.catalog_id
          AND catalog.is_active=TRUE
         JOIN facilities facility
           ON facility.tenant_id=item.tenant_id
          AND facility.id=item.facility_id
          AND facility.status='active'
         JOIN pharmacy_suppliers supplier
           ON supplier.tenant_id=batch.tenant_id
          AND supplier.id=batch.supplier_id
          AND supplier.facility_id=batch.facility_id
        WHERE ${filters.join(' AND ')}
          AND EXISTS (
            SELECT 1 FROM facility_locations location
             WHERE location.tenant_id=batch.tenant_id
               AND location.facility_id=batch.facility_id
               AND location.id=batch.storage_location_id
               AND location.status='active'
          )
        ORDER BY alert.expiry_date, alert.severity DESC
        LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
  });
  return { alerts: rows, count: rows.length };
}

// ---------------------------------------------------------------------------
// Substitutes
// ---------------------------------------------------------------------------

export async function addSubstitute({
  tenantId = null, primaryItemId, substituteItemId,
  substitutionKind = 'generic_equivalent', isBidirectional = true, notes = null,
  status = 'active', metadata = null, createdBy = null,
  actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const primaryId = normalizeId(primaryItemId, 'primary_item_id');
  const substituteId = normalizeId(substituteItemId, 'substitute_item_id');
  if (primaryId === substituteId) {
    throw AppError.badRequest('primary_item_id and substitute_item_id must differ');
  }
  const cleanKind = normalizeEnum(
    substitutionKind,
    SUBSTITUTE_KINDS,
    'substitution_kind',
  ) || 'generic_equivalent';
  const cleanStatus = normalizeEnum(status, ['active', 'paused', 'archived'], 'status') || 'active';
  const cleanMetadata = JSON.stringify(normalizeJsonObject(metadata, 'metadata'));
  try {
    return await setTenantTx(tid, async (tx) => {
      const authorityRows = await tx.$queryRawUnsafe(
        `SELECT primary_item.facility_id
           FROM pharmacy_inventory_items primary_item
           JOIN pharmacy_inventory_items substitute_item
             ON substitute_item.tenant_id=primary_item.tenant_id
            AND substitute_item.id=$3::int
            AND substitute_item.facility_id=primary_item.facility_id
            AND substitute_item.status='active'
           JOIN pharmacy_catalog primary_catalog
             ON primary_catalog.tenant_id=primary_item.tenant_id
            AND primary_catalog.id=primary_item.catalog_id
            AND primary_catalog.is_active=TRUE
           JOIN pharmacy_catalog substitute_catalog
             ON substitute_catalog.tenant_id=substitute_item.tenant_id
            AND substitute_catalog.id=substitute_item.catalog_id
            AND substitute_catalog.is_active=TRUE
           JOIN facilities facility
             ON facility.tenant_id=primary_item.tenant_id
            AND facility.id=primary_item.facility_id
            AND facility.status='active'
          WHERE primary_item.tenant_id=$1::uuid
            AND primary_item.id=$2::int
            AND primary_item.status='active'
          FOR UPDATE OF primary_item, substitute_item, primary_catalog,
                        substitute_catalog, facility`,
        tid,
        primaryId,
        substituteId,
      );
      if (!authorityRows[0]) {
        throw AppError.conflict(
          'Substitute items must be active catalog identities in the same active facility',
          'PHARMACY_SUBSTITUTE_AUTHORITY_INVALID',
        );
      }
      await assertSupplyFacilityGrantTx(tx, {
        tenantId: tid,
        facilityId: Number(authorityRows[0].facility_id),
        actorUid: createdBy,
        actorRole,
      });
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_substitutes
           (tenant_id, primary_item_id, substitute_item_id, substitution_kind,
            is_bidirectional, notes, status, metadata, created_by)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::uuid)
         RETURNING id, tenant_id, primary_item_id, substitute_item_id,
                   substitution_kind, is_bidirectional, notes, status,
                   metadata, created_by, created_at, updated_at`,
        tid, primaryId, substituteId,
        cleanKind,
        normalizeBoolean(isBidirectional, true),
        safeText(notes),
        cleanStatus,
        cleanMetadata,
        maybeUuid(createdBy, 'created_by'),
      );
      return rows[0];
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('Substitute pair already exists');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid item_id reference');
    throw err;
  }
}

export async function listSubstitutes({
  tenantId = null, facilityId = null, primaryItemId = null, status = null,
  actorUid = null, actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const exactFacilityId = normalizeId(facilityId, 'facility_id');
  const filters = ['substitution.tenant_id = $1::uuid', 'primary_item.facility_id = $2::int'];
  const params = [tid, exactFacilityId];
  if (primaryItemId) {
    params.push(normalizeId(primaryItemId, 'primary_item_id'));
    // Look up by either direction (primary or substitute) when bidirectional.
    filters.push(`(substitution.primary_item_id = $${params.length} OR (substitution.substitute_item_id = $${params.length} AND substitution.is_bidirectional = true))`);
  }
  if (status) {
    params.push(normalizeEnum(status, ['active', 'paused', 'archived'], 'status'));
    filters.push(`substitution.status = $${params.length}`);
  }
  const rows = await setTenantTx(tid, async (tx) => {
    await assertSupplyFacilityGrantTx(tx, {
      tenantId: tid,
      facilityId: exactFacilityId,
      actorUid,
      actorRole,
    });
    return tx.$queryRawUnsafe(
      `SELECT substitution.id, substitution.tenant_id,
              substitution.primary_item_id, substitution.substitute_item_id,
              substitution.substitution_kind, substitution.is_bidirectional,
              substitution.notes, substitution.status, substitution.metadata,
              substitution.created_by, substitution.created_at, substitution.updated_at
         FROM pharmacy_substitutes substitution
         JOIN pharmacy_inventory_items primary_item
           ON primary_item.tenant_id=substitution.tenant_id
          AND primary_item.id=substitution.primary_item_id
          AND primary_item.status='active'
         JOIN pharmacy_inventory_items substitute_item
           ON substitute_item.tenant_id=substitution.tenant_id
          AND substitute_item.id=substitution.substitute_item_id
          AND substitute_item.facility_id=primary_item.facility_id
          AND substitute_item.status='active'
         JOIN pharmacy_catalog primary_catalog
           ON primary_catalog.tenant_id=primary_item.tenant_id
          AND primary_catalog.id=primary_item.catalog_id
          AND primary_catalog.is_active=TRUE
         JOIN pharmacy_catalog substitute_catalog
           ON substitute_catalog.tenant_id=substitute_item.tenant_id
          AND substitute_catalog.id=substitute_item.catalog_id
          AND substitute_catalog.is_active=TRUE
         JOIN facilities facility
           ON facility.tenant_id=primary_item.tenant_id
          AND facility.id=primary_item.facility_id
          AND facility.status='active'
        WHERE ${filters.join(' AND ')}
        ORDER BY substitution.substitution_kind, substitution.primary_item_id`,
      ...params,
    );
  });
  return { substitutes: rows, count: rows.length };
}

// ---------------------------------------------------------------------------
// GRN line orchestration + forecast bridge (C4 follow-up)
// ---------------------------------------------------------------------------

/**
 * Atomic GRN-line orchestration. In one prisma.$transaction:
 *   1. INSERT pharmacy_inventory_batches (status='quarantined', remaining=0)
 *   2. UPDATE pharmacy_purchase_order_items.received_quantity by +received,
 *      conditional on (received + delta) <= ordered (refuses over-receive
 *      with 409; the chk_po_received_lte_ordered DB CHECK is the backstop)
 *   3. INSERT pharmacy_goods_receipt_items linking GRN + PO line + batch
 *   4. Recompute parent PO progress and transition status to
 *      'fully_received' (sum_received >= sum_ordered) or 'partially_received'.
 *   5. Persist that complete response projection in the initial append-only
 *      movement, which also updates the batch balance atomically.
 *
 * Any failure rolls the whole receipt back.
 */
export async function receivePurchaseOrderLine({
  tenantId = null,
  purchaseOrderId,
  purchaseOrderItemId,
  goodsReceiptId,
  batchNumber,
  expiryDate,
  receivedQuantity,
  lotNumber = null,
  manufactureDate = null,
  unitCostMinor = null,
  supplierId = null,
  storageLocationId = null,
  performedBy = null,
  commandKey = null,
  requestFingerprint = null,
  actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const poId = normalizeId(purchaseOrderId, 'purchase_order_id');
  const poiId = normalizeId(purchaseOrderItemId, 'purchase_order_item_id');
  const grnId = normalizeId(goodsReceiptId, 'goods_receipt_id');
  const cleanBatch = safeText(batchNumber, 120);
  if (!cleanBatch) throw AppError.badRequest('batch_number is required');
  const cleanExpiry = normalizeDate(expiryDate, 'expiry_date', { required: true });
  const cleanManufacture = normalizeDate(manufactureDate, 'manufacture_date');
  if (cleanManufacture && cleanManufacture > cleanExpiry) {
    throw AppError.badRequest(
      'manufacture_date cannot be after expiry_date',
      'PHARMACY_BATCH_DATE_RANGE_INVALID',
    );
  }
  const qty = normalizeQuantity(receivedQuantity, 'received_quantity', { min: 0.0001, required: true });
  const cost = normalizeBigInt(unitCostMinor, 'unit_cost_minor', { min: 0, max: 1_000_000_000_000 });
  const supId = supplierId ? normalizeId(supplierId, 'supplier_id') : null;
  const exactStorageLocationId = normalizeId(storageLocationId, 'storage_location_id');
  const cleanLot = safeText(lotNumber, 120);
  const performerUid = normalizeFacilityActor(performedBy, actorRole).actorUid;
  if (!IDEMPOTENCY_KEY_RE.test(String(commandKey || ''))
    || !/^[0-9a-f]{64}$/i.test(String(requestFingerprint || ''))) {
    throw AppError.conflict(
      'GRN line receipt requires durable idempotency authority',
      'PHARMACY_GRN_RECEIPT_IDEMPOTENCY_REQUIRED',
    );
  }
  const commandKeySha256 = createHash('sha256').update(String(commandKey)).digest('hex');

  return setTenantTx(requireTenantId(tid), async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))::text AS lock_acquired`,
      `pharmacy-grn-receive:${tid}:${commandKeySha256}`,
    );
    const replays = await tx.$queryRawUnsafe(
      `SELECT ${selectAliasedFields('movement', 'movement', MOVEMENT_FIELDS)},
              ${selectAliasedFields('batch', 'batch', BATCH_FIELDS)},
              ${selectAliasedFields('grn_line', 'grn_line', GRN_ITEM_RESPONSE_FIELDS)},
              ${selectAliasedFields('grn', 'grn', GRN_RESPONSE_FIELDS)},
              ${selectAliasedFields('po_line', 'po_line', PO_ITEM_RESPONSE_FIELDS)},
              ${selectAliasedFields('po', 'po', PO_FIELDS)},
              item.id AS lineage_item_id,
              item.facility_id AS lineage_item_facility_id,
              item.schedule_class AS lineage_item_schedule_class,
              item.is_narcotic AS lineage_item_is_narcotic,
              item.unit_label AS lineage_item_unit_label,
              ${CONTROLLED_REGISTER_REPLAY_SELECT}
         FROM pharmacy_stock_movements movement
         LEFT JOIN pharmacy_inventory_batches batch
           ON batch.tenant_id=movement.tenant_id
           AND batch.id=movement.inventory_batch_id
           AND batch.inventory_item_id=movement.inventory_item_id
         LEFT JOIN pharmacy_inventory_items item
           ON item.tenant_id=movement.tenant_id
          AND item.id=movement.inventory_item_id
          AND item.facility_id=batch.facility_id
         ${CONTROLLED_REGISTER_REPLAY_JOIN}
         LEFT JOIN pharmacy_goods_receipt_items grn_line
           ON grn_line.tenant_id=movement.tenant_id
          AND grn_line.id::text=movement.metadata#>>'{intent,goods_receipt_item_id}'
          AND grn_line.goods_receipt_id::text=movement.metadata#>>'{intent,goods_receipt_id}'
          AND grn_line.inventory_item_id=movement.inventory_item_id
          AND grn_line.inventory_batch_id=movement.inventory_batch_id
          AND grn_line.purchase_order_item_id::text=movement.metadata#>>'{intent,purchase_order_item_id}'
         LEFT JOIN pharmacy_goods_receipts grn
           ON grn.tenant_id=grn_line.tenant_id
          AND grn.id=grn_line.goods_receipt_id
          AND grn.id::text=movement.reference_id
         LEFT JOIN pharmacy_purchase_order_items po_line
           ON po_line.tenant_id=grn_line.tenant_id
          AND po_line.id=grn_line.purchase_order_item_id
          AND po_line.inventory_item_id=movement.inventory_item_id
         LEFT JOIN pharmacy_purchase_orders po
           ON po.tenant_id=po_line.tenant_id
          AND po.id=po_line.purchase_order_id
          AND po.id=grn.purchase_order_id
          AND po.facility_id=batch.facility_id
          AND po.supplier_id=batch.supplier_id
         WHERE movement.tenant_id=$1::uuid
          AND movement.metadata->>'contract'='pharmacy_grn_receive_line_v1'
          AND movement.metadata->>'command_key_sha256'=$2
        ORDER BY movement.id
        LIMIT 2`,
      tid,
      commandKeySha256,
    );
    if (replays.length) {
      if (replays.length !== 1) {
        throw AppError.conflict(
          'GRN receipt idempotency evidence conflicts with this request',
          'PHARMACY_GRN_RECEIPT_IDEMPOTENCY_CONFLICT',
        );
      }
      const replayRow = replays[0];
      const incompleteMessage = 'The GRN receipt committed without complete immutable lineage and requires recovery';
      const { metadata: replayMetadata, intent, facilityId: replayFacilityId } = requireReplayMetadata(replayRow, {
        contract: 'pharmacy_grn_receive_line_v1',
        commandKeySha256,
        requestField: 'request_fingerprint',
        requestFingerprint,
        conflictMessage: 'GRN receipt idempotency evidence conflicts with this request',
        conflictCode: 'PHARMACY_GRN_RECEIPT_IDEMPOTENCY_CONFLICT',
        incompleteMessage,
        incompleteCode: 'PHARMACY_GRN_RECEIPT_INCOMPLETE',
      });
      const replayMovement = extractAliasedFields(replayRow, 'movement', MOVEMENT_FIELDS);
      const replayBatch = extractAliasedFields(replayRow, 'batch', BATCH_FIELDS);
      const replayGrnLine = extractAliasedFields(
        replayRow,
        'grn_line',
        GRN_ITEM_RESPONSE_FIELDS,
      );
      const replayGrn = extractAliasedFields(replayRow, 'grn', GRN_RESPONSE_FIELDS);
      const replayPoLine = extractAliasedFields(replayRow, 'po_line', PO_ITEM_RESPONSE_FIELDS);
      const replayPo = extractAliasedFields(replayRow, 'po', PO_FIELDS);
      const responseSnapshot = requireResponsePayload(
        replayMetadata,
        incompleteMessage,
        'PHARMACY_GRN_RECEIPT_INCOMPLETE',
      );
      const snapshotBatch = responseSnapshot.batch;
      const snapshotGrnLine = responseSnapshot.goods_receipt_item;
      const snapshotGrn = responseSnapshot.goods_receipt;
      const snapshotPoLine = responseSnapshot.purchase_order_item;
      const snapshotPo = responseSnapshot.purchase_order;
      const movementQuantityScaled = numeric14_4ToScaled(replayMovement?.quantity_delta);
      const intentQuantityScaled = numeric14_4ToScaled(intent.quantity_delta);
      const intentReceivedQuantityScaled = numeric14_4ToScaled(intent.received_quantity);
      const batchReceivedQuantityScaled = numeric14_4ToScaled(replayBatch?.received_quantity);
      const grnLineReceivedQuantityScaled = numeric14_4ToScaled(replayGrnLine?.received_quantity);
      const snapshotBatchReceivedScaled = numeric14_4ToScaled(snapshotBatch?.received_quantity);
      const snapshotBatchRemainingScaled = numeric14_4ToScaled(snapshotBatch?.remaining_quantity);
      const snapshotGrnLineReceivedScaled = numeric14_4ToScaled(snapshotGrnLine?.received_quantity);
      const poLineReceivedBeforeScaled = numeric14_4ToScaled(intent.po_line_received_before);
      const totalReceivedBeforeScaled = numeric14_4ToScaled(intent.total_received_before);
      const commandTotalOrderedScaled = numeric14_4ToScaled(intent.total_ordered);
      const currentPoLineOrderedScaled = numeric14_4ToScaled(replayPoLine?.ordered_quantity);
      const currentPoLineReceivedScaled = numeric14_4ToScaled(replayPoLine?.received_quantity);
      const snapshotPoLineOrderedScaled = numeric14_4ToScaled(snapshotPoLine?.ordered_quantity);
      const snapshotPoLineReceivedScaled = numeric14_4ToScaled(snapshotPoLine?.received_quantity);
      const snapshotTotalOrderedScaled = numeric14_4ToScaled(responseSnapshot.total_ordered);
      const snapshotTotalReceivedScaled = numeric14_4ToScaled(responseSnapshot.total_received);
      const commandLineReceivedScaled = poLineReceivedBeforeScaled !== null
        && movementQuantityScaled !== null
        ? poLineReceivedBeforeScaled + movementQuantityScaled
        : null;
      const commandTotalReceivedScaled = totalReceivedBeforeScaled !== null
        && movementQuantityScaled !== null
        ? totalReceivedBeforeScaled + movementQuantityScaled
        : null;
      const commandParentStatus = commandTotalOrderedScaled !== null
        && commandTotalReceivedScaled !== null
        && commandTotalReceivedScaled >= commandTotalOrderedScaled
        ? 'fully_received'
        : 'partially_received';
      const replayControlled = isControlledSupplyItem({
        schedule_class: replayRow.lineage_item_schedule_class,
        is_narcotic: replayRow.lineage_item_is_narcotic === true,
      });
      if (!replayMovement || !replayBatch || !replayGrnLine || !replayGrn
        || !replayPoLine || !replayPo || !intentMatches(intent, {
          facility_id: replayFacilityId,
          inventory_item_id: Number(replayMovement.inventory_item_id),
          inventory_batch_id: Number(replayMovement.inventory_batch_id),
          movement_kind: String(replayMovement.movement_kind),
          reference_type: replayMovement.reference_type ?? null,
          reference_id: replayMovement.reference_id ?? null,
          performed_by: replayMovement.performed_by ?? null,
          purchase_order_id: Number(replayPo.id),
          purchase_order_item_id: Number(replayPoLine.id),
          goods_receipt_id: Number(replayGrn.id),
          goods_receipt_item_id: Number(replayGrnLine.id),
          supplier_id: Number(replayGrn.supplier_id),
          storage_location_id: Number(replayBatch.storage_location_id),
          batch_number: String(replayBatch.batch_number),
          lot_number: replayBatch.lot_number ?? null,
          manufacture_date: dateOnly(replayBatch.manufacture_date),
          expiry_date: dateOnly(replayBatch.expiry_date),
          unit_cost_minor: replayGrnLine.unit_cost_minor == null
            ? null
            : Number(replayGrnLine.unit_cost_minor),
          controlled: replayControlled,
        })
        || Number(replayBatch.facility_id) !== replayFacilityId
        || Number(replayBatch.id) !== Number(replayMovement.inventory_batch_id)
        || Number(replayBatch.inventory_item_id) !== Number(replayMovement.inventory_item_id)
        || Number(replayBatch.goods_receipt_id) !== Number(replayGrn.id)
        || (replayBatch.unit_cost_minor == null
          ? replayGrnLine.unit_cost_minor != null
          : Number(replayBatch.unit_cost_minor) !== Number(replayGrnLine.unit_cost_minor))
        || Number(replayGrn.facility_id) !== replayFacilityId
        || Number(replayGrn.purchase_order_id) !== Number(replayPo.id)
        || Number(replayGrn.supplier_id) !== Number(replayPo.supplier_id)
        || Number(replayGrnLine.goods_receipt_id) !== Number(replayGrn.id)
        || Number(replayGrnLine.inventory_item_id) !== Number(replayMovement.inventory_item_id)
        || Number(replayGrnLine.inventory_batch_id) !== Number(replayBatch.id)
        || Number(replayGrnLine.purchase_order_item_id) !== Number(replayPoLine.id)
        || Number(replayPoLine.purchase_order_id) !== Number(replayPo.id)
        || Number(replayPo.facility_id) !== replayFacilityId
        || String(replayMovement.movement_kind) !== 'receive'
        || String(replayMovement.reference_type) !== 'goods_receipt'
        || String(replayMovement.reference_id) !== String(replayGrn.id)
        || !snapshotBatch || typeof snapshotBatch !== 'object' || Array.isArray(snapshotBatch)
        || !snapshotGrnLine || typeof snapshotGrnLine !== 'object' || Array.isArray(snapshotGrnLine)
        || !snapshotGrn || typeof snapshotGrn !== 'object' || Array.isArray(snapshotGrn)
        || !snapshotPoLine || typeof snapshotPoLine !== 'object' || Array.isArray(snapshotPoLine)
        || !snapshotPo || typeof snapshotPo !== 'object' || Array.isArray(snapshotPo)
        || !intentMatches(snapshotBatch, {
          id: Number(replayBatch.id),
          tenant_id: String(replayBatch.tenant_id),
          inventory_item_id: Number(replayBatch.inventory_item_id),
          facility_id: replayFacilityId,
          batch_number: String(replayBatch.batch_number),
          lot_number: replayBatch.lot_number ?? null,
          unit_cost_minor: replayBatch.unit_cost_minor == null
            ? null
            : Number(replayBatch.unit_cost_minor),
          mrp_minor: null,
          supplier_id: Number(replayBatch.supplier_id),
          goods_receipt_id: Number(replayGrn.id),
          storage_location_id: Number(replayBatch.storage_location_id),
          status: 'quarantined',
        })
        || dateOnly(snapshotBatch.manufacture_date) !== dateOnly(replayBatch.manufacture_date)
        || dateOnly(snapshotBatch.expiry_date) !== dateOnly(replayBatch.expiry_date)
        || !intentMatches(snapshotGrnLine, {
          id: Number(replayGrnLine.id),
          tenant_id: String(replayGrnLine.tenant_id),
          goods_receipt_id: Number(replayGrn.id),
          inventory_item_id: Number(replayMovement.inventory_item_id),
          inventory_batch_id: Number(replayBatch.id),
          purchase_order_item_id: Number(replayPoLine.id),
          unit_cost_minor: replayGrnLine.unit_cost_minor == null
            ? null
            : Number(replayGrnLine.unit_cost_minor),
          qc_status: 'pending',
          qc_notes: null,
        })
        || !intentMatches(snapshotGrn, {
          id: Number(replayGrn.id),
          facility_id: replayFacilityId,
          supplier_id: Number(replayGrn.supplier_id),
          purchase_order_id: Number(replayPo.id),
          status: 'qc_pending',
        })
        || !intentMatches(snapshotPoLine, {
          id: Number(replayPoLine.id),
          purchase_order_id: Number(replayPo.id),
        })
        || !intentMatches(snapshotPo, {
          id: Number(replayPo.id),
          tenant_id: String(replayPo.tenant_id),
          facility_id: replayFacilityId,
          supplier_id: Number(replayPo.supplier_id),
          status: commandParentStatus,
        })
        || movementQuantityScaled === null || movementQuantityScaled <= 0n
        || intentQuantityScaled === null || intentQuantityScaled !== movementQuantityScaled
        || intentReceivedQuantityScaled === null
        || intentReceivedQuantityScaled !== movementQuantityScaled
        || batchReceivedQuantityScaled === null
        || batchReceivedQuantityScaled !== movementQuantityScaled
        || grnLineReceivedQuantityScaled === null
        || grnLineReceivedQuantityScaled !== movementQuantityScaled
        || snapshotBatchReceivedScaled === null
        || snapshotBatchReceivedScaled !== movementQuantityScaled
        || snapshotBatchRemainingScaled === null
        || snapshotBatchRemainingScaled !== movementQuantityScaled
        || snapshotGrnLineReceivedScaled === null
        || snapshotGrnLineReceivedScaled !== movementQuantityScaled
        || poLineReceivedBeforeScaled === null || poLineReceivedBeforeScaled < 0n
        || totalReceivedBeforeScaled === null || totalReceivedBeforeScaled < 0n
        || commandTotalOrderedScaled === null || commandTotalOrderedScaled <= 0n
        || currentPoLineOrderedScaled === null || currentPoLineOrderedScaled <= 0n
        || currentPoLineReceivedScaled === null || currentPoLineReceivedScaled < 0n
        || snapshotPoLineOrderedScaled === null
        || snapshotPoLineOrderedScaled !== currentPoLineOrderedScaled
        || snapshotPoLineReceivedScaled === null
        || snapshotPoLineReceivedScaled !== commandLineReceivedScaled
        || snapshotPoLineReceivedScaled > snapshotPoLineOrderedScaled
        || currentPoLineReceivedScaled < snapshotPoLineReceivedScaled
        || totalReceivedBeforeScaled < poLineReceivedBeforeScaled
        || snapshotTotalOrderedScaled === null
        || snapshotTotalOrderedScaled !== commandTotalOrderedScaled
        || snapshotTotalReceivedScaled === null
        || snapshotTotalReceivedScaled !== commandTotalReceivedScaled
        || snapshotTotalReceivedScaled <= 0n
        || snapshotTotalReceivedScaled > snapshotTotalOrderedScaled
        || snapshotTotalOrderedScaled < snapshotPoLineOrderedScaled
        || snapshotTotalReceivedScaled < snapshotPoLineReceivedScaled) {
        throw AppError.conflict(incompleteMessage, 'PHARMACY_GRN_RECEIPT_INCOMPLETE');
      }
      requireControlledRegisterEvidence(
        replayRow,
        intent,
        {
          facilityId: replayFacilityId,
          inventoryItemId: Number(replayMovement.inventory_item_id),
          inventoryBatchId: Number(replayMovement.inventory_batch_id),
          movementKind: String(replayMovement.movement_kind),
          quantity: replayMovement.quantity_delta,
          performedBy: replayMovement.performed_by,
        },
        incompleteMessage,
        'PHARMACY_GRN_RECEIPT_INCOMPLETE',
      );
      await assertSupplyFacilityGrantTx(tx, {
        tenantId: tid,
        facilityId: replayFacilityId,
        actorUid: performerUid,
        actorRole,
      });
      return responseSnapshot;
    }
    const lines = await tx.$queryRawUnsafe(
      `SELECT poi.id, poi.purchase_order_id, poi.inventory_item_id,
              poi.ordered_quantity, poi.received_quantity,
              po.facility_id, po.supplier_id, po.status AS purchase_order_status,
              grn.status AS goods_receipt_status
         FROM pharmacy_purchase_order_items poi
         JOIN pharmacy_purchase_orders po
           ON po.tenant_id=poi.tenant_id
          AND po.id=poi.purchase_order_id
         JOIN pharmacy_goods_receipts grn
           ON grn.tenant_id=po.tenant_id
          AND grn.id=$3::int
          AND grn.purchase_order_id=po.id
          AND grn.facility_id=po.facility_id
          AND grn.supplier_id=po.supplier_id
         JOIN pharmacy_inventory_items pii
           ON pii.tenant_id=poi.tenant_id
          AND pii.id=poi.inventory_item_id
          AND pii.facility_id=po.facility_id
          AND pii.status='active'
         JOIN facilities f
           ON f.tenant_id=po.tenant_id
          AND f.id=po.facility_id
          AND f.status='active'
         JOIN pharmacy_catalog pc
           ON pc.tenant_id=pii.tenant_id
          AND pc.id=pii.catalog_id
          AND pc.is_active=TRUE
         JOIN pharmacy_suppliers supplier
           ON supplier.tenant_id=po.tenant_id
          AND supplier.id=po.supplier_id
          AND supplier.facility_id=po.facility_id
          AND supplier.status='active'
        WHERE poi.id=$1::int
          AND poi.tenant_id=$2::uuid
          AND po.id=$4::int
          AND po.status IN ('approved', 'partially_received')
          AND grn.status IN ('received', 'qc_pending')
          AND $5::date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
          AND EXISTS (
            SELECT 1 FROM facility_locations location
             WHERE location.tenant_id=po.tenant_id
               AND location.facility_id=po.facility_id
               AND location.id=$6::int
               AND location.status='active'
          )
        FOR UPDATE OF poi, po, grn, pii, f, pc, supplier`,
      poiId, tid, grnId, poId, cleanExpiry, exactStorageLocationId,
    );
    if (!lines[0]) {
      throw AppError.conflict(
        'The GRN, purchase order line, item, facility, catalog, and supplier must form one active authority chain',
        'PHARMACY_GRN_AUTHORITY_INVALID',
      );
    }
    const itemId = Number(lines[0].inventory_item_id);
    const parentPoId = Number(lines[0].purchase_order_id);
    const facilityId = Number(lines[0].facility_id);
    const authoritativeSupplierId = Number(lines[0].supplier_id);
    if (supId != null && supId !== authoritativeSupplierId) {
      throw AppError.conflict(
        'supplier_id does not match the GRN and purchase order authority',
        'PHARMACY_GRN_SUPPLIER_MISMATCH',
      );
    }
    await assertSupplyFacilityGrantTx(tx, {
      tenantId: tid,
      facilityId,
      actorUid: performerUid,
      actorRole,
    });

    // Controlled stock: a GRN receipt is a statutory custody event — it needs
    // a named performer and a same-tx pharmacy_schedule_register row.
    const receivedItem = await loadSupplyMovementItem(tx, tid, itemId);
    const controlledReceipt = receivedItem && isControlledSupplyItem(receivedItem);
    if (controlledReceipt) requireControlledPerformer(performerUid);

    // 2. Insert the new batch.
    let batch;
    try {
      const inserted = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_inventory_batches
           (tenant_id, inventory_item_id, facility_id, batch_number, lot_number, manufacture_date,
            expiry_date, received_quantity, remaining_quantity, unit_cost_minor,
            supplier_id, goods_receipt_id, storage_location_id, status)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::date, $7::date, $8, 0, $9, $10, $11, $12, 'quarantined')
         RETURNING ${BATCH_RETURNING}`,
        tid, itemId, facilityId, cleanBatch, cleanLot, cleanManufacture, cleanExpiry,
        qty, cost, authoritativeSupplierId, grnId, exactStorageLocationId,
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
          purchase_order_item_id, received_quantity, unit_cost_minor, qc_status)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING id, tenant_id, goods_receipt_id, inventory_item_id, inventory_batch_id,
                 purchase_order_item_id, received_quantity, unit_cost_minor,
                 qc_status, qc_notes, metadata, created_at, updated_at`,
      tid, grnId, itemId, batch.id, poiId, qty, cost,
    );

    const receiptRows = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_goods_receipts
          SET status='qc_pending', updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int
          AND status IN ('received', 'qc_pending')
        RETURNING id, status, facility_id, supplier_id, purchase_order_id, updated_at`,
      tid,
      grnId,
    );
    if (!receiptRows[0]) {
      throw AppError.conflict(
        'The goods receipt is finalized or terminal and cannot accept more lines',
        'PHARMACY_GRN_TERMINAL',
      );
    }

    // 5. Recompute PO progress and auto-transition the parent header.
    const aggRows = await tx.$queryRawUnsafe(
       `SELECT
          COALESCE(SUM(ordered_quantity), 0)::numeric AS total_ordered,
          COALESCE(SUM(received_quantity), 0)::numeric AS total_received,
          (COALESCE(SUM(received_quantity), 0) - $3::numeric)::numeric AS total_received_before,
          COUNT(*) FILTER (WHERE received_quantity > 0)::int AS partial_count
        FROM pharmacy_purchase_order_items
        WHERE purchase_order_id = $1 AND tenant_id = $2::uuid`,
      parentPoId, tid, qty,
    );
    const quantityScaled = numeric14_4ToScaled(qty);
    const poLineReceivedBeforeScaled = numeric14_4ToScaled(lines[0].received_quantity);
    const poLineOrderedScaled = numeric14_4ToScaled(updated[0].ordered_quantity);
    const poLineReceivedScaled = numeric14_4ToScaled(updated[0].received_quantity);
    const totalOrderedScaled = numeric14_4ToScaled(aggRows[0]?.total_ordered);
    const totalReceivedScaled = numeric14_4ToScaled(aggRows[0]?.total_received);
    const totalReceivedBeforeScaled = numeric14_4ToScaled(aggRows[0]?.total_received_before);
    if (quantityScaled === null || quantityScaled <= 0n
      || poLineReceivedBeforeScaled === null || poLineReceivedBeforeScaled < 0n
      || poLineOrderedScaled === null || poLineOrderedScaled <= 0n
      || poLineReceivedScaled === null || poLineReceivedScaled < 0n
      || totalOrderedScaled === null || totalOrderedScaled <= 0n
      || totalReceivedScaled === null || totalReceivedScaled <= 0n
      || totalReceivedBeforeScaled === null || totalReceivedBeforeScaled < 0n
      || poLineReceivedScaled !== poLineReceivedBeforeScaled + quantityScaled
      || totalReceivedScaled !== totalReceivedBeforeScaled + quantityScaled
      || poLineReceivedScaled > poLineOrderedScaled
      || totalReceivedBeforeScaled < poLineReceivedBeforeScaled
      || totalReceivedScaled > totalOrderedScaled
      || totalOrderedScaled < poLineOrderedScaled
      || totalReceivedScaled < poLineReceivedScaled) {
      throw AppError.conflict(
        'The purchase order receipt arithmetic cannot be proven',
        'PHARMACY_GRN_RECEIPT_INCOMPLETE',
      );
    }
    const totalOrdered = Number(aggRows[0].total_ordered);
    const totalReceived = Number(aggRows[0].total_received);
    const partialCount = Number(aggRows[0]?.partial_count || 0);

    let parentStatus = null;
    if (totalReceivedScaled >= totalOrderedScaled) {
      parentStatus = 'fully_received';
    } else if (partialCount > 0) {
      parentStatus = 'partially_received';
    }

    if (!parentStatus) {
      throw AppError.conflict(
        'The purchase order receipt totals cannot produce a valid receipt state',
        'PHARMACY_GRN_RECEIPT_INCOMPLETE',
      );
    }
    const parentRows = await tx.$queryRawUnsafe(
      // $1 is both assigned to a varchar column and compared to an untyped
      // literal, which makes Postgres deduce `character varying` and `text`
      // for the same parameter (42P08). Pin it to text in both places; the
      // assignment to the varchar column still casts, and the length check
      // still applies.
      `UPDATE pharmacy_purchase_orders
       SET status = $1::text,
           received_at = CASE
             WHEN $1::text = 'fully_received' THEN NOW() ELSE received_at
           END,
           updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3::uuid
       RETURNING ${PO_RETURNING}`,
      parentStatus, parentPoId, tid,
    );
    const parent = parentRows[0];
    if (!parent) {
      throw AppError.conflict(
        'The purchase order header could not be projected for this receipt',
        'PHARMACY_GRN_RECEIPT_INCOMPLETE',
      );
    }

    const responseSnapshot = immutableResponseSnapshot({
      batch: {
        ...batch,
        remaining_quantity: batch.received_quantity,
      },
      goods_receipt_item: grnItemRows[0],
      goods_receipt: receiptRows[0],
      purchase_order_item: updated[0],
      purchase_order: parent,
      total_ordered: totalOrdered,
      total_received: totalReceived,
    });
    const quantityCanonical = scaledNumeric14_4ToCanonical(quantityScaled);
    const poLineReceivedBefore = scaledNumeric14_4ToCanonical(poLineReceivedBeforeScaled);
    const totalOrderedCanonical = scaledNumeric14_4ToCanonical(totalOrderedScaled);
    const totalReceivedBefore = scaledNumeric14_4ToCanonical(totalReceivedBeforeScaled);
    const registerEvidence = controlledReceipt
      ? await prepareControlledSupplyRegisterTx(tx, {
        tenantId: tid,
        item: receivedItem,
        inventoryItemId: itemId,
        facilityId,
        movementKind: 'receive',
        quantityDelta: qty,
      })
      : null;

    // 6. Append the receive ledger entry once, with its complete immutable
    // command response. The append-only movement is the durable replay receipt.
    const { movement: receiveMovement } = await recordMovementTx(tx, {
      tenantId: tid,
      inventory_item_id: itemId,
      inventory_batch_id: batch.id,
      movement_kind: 'receive',
      quantity: qty,
      reference_type: 'goods_receipt',
      reference_id: String(grnId),
      performed_by: performerUid,
      notes: `Received via GRN ${grnId}, batch ${cleanBatch}`,
      expected_facility_id: facilityId,
      metadata: {
        contract: 'pharmacy_grn_receive_line_v1',
        command_key_sha256: commandKeySha256,
        request_fingerprint: requestFingerprint,
        facility_id: facilityId,
        intent: {
          facility_id: facilityId,
          inventory_item_id: itemId,
          inventory_batch_id: Number(batch.id),
          movement_kind: 'receive',
          quantity_delta: quantityCanonical,
          reference_type: 'goods_receipt',
          reference_id: String(grnId),
          performed_by: performerUid,
          purchase_order_id: parentPoId,
          purchase_order_item_id: poiId,
          goods_receipt_id: grnId,
          goods_receipt_item_id: Number(grnItemRows[0].id),
          supplier_id: authoritativeSupplierId,
          storage_location_id: exactStorageLocationId,
          batch_number: cleanBatch,
          lot_number: cleanLot,
          manufacture_date: cleanManufacture,
          expiry_date: cleanExpiry,
          received_quantity: quantityCanonical,
          unit_cost_minor: cost,
          po_line_received_before: poLineReceivedBefore,
          total_ordered: totalOrderedCanonical,
          total_received_before: totalReceivedBefore,
          controlled: controlledReceipt,
          register_evidence: registerEvidence,
        },
        response_payload: responseSnapshot,
      },
    });
    const refreshedBatchRows = await tx.$queryRawUnsafe(
      `SELECT ${BATCH_RETURNING}
         FROM pharmacy_inventory_batches
        WHERE tenant_id=$1::uuid AND id=$2::int
          AND inventory_item_id=$3::int AND facility_id=$4::int
        FOR UPDATE`,
      tid,
      Number(batch.id),
      itemId,
      facilityId,
    );
    const refreshedBatch = refreshedBatchRows[0];
    if (!refreshedBatch
      || numeric14_4ToScaled(refreshedBatch.remaining_quantity) !== quantityScaled
      || String(refreshedBatch.status) !== String(responseSnapshot.batch.status)) {
      throw AppError.conflict(
        'GRN receipt batch balance does not match its immutable command response',
        'PHARMACY_GRN_RECEIPT_INCOMPLETE',
      );
    }

    // 6b. Controlled stock: same-tx statutory register receipt row.
    if (controlledReceipt) {
      await appendControlledSupplyRegisterTx(tx, {
        tenantId: tid,
        item: receivedItem,
        inventoryItemId: itemId,
        inventoryBatchId: batch.id,
        movementKind: 'receive',
        quantity: qty,
        performedBy: performerUid,
        referenceMovementId: receiveMovement?.id || null,
        notes: `Received via GRN ${grnId}, batch ${cleanBatch}`,
        registerEvidence,
      });
    }

    return responseSnapshot;
  });
}

/**
 * Bridge the existing clinical_ai_inventory_alerts forecast surface to the
 * new pharmacy_inventory_batches data: walks every active inventory_item
 * with reorder_level set, computes on-hand from in_stock+reserved batches,
 * computes consumption_per_day from 'issue' stock movements over the
 * lookback window, then forecasts days_to_reorder. Best-effort writes a
 * clinical_ai_inventory_alerts row when days_to_reorder < 14. The forecast
 * remains available when only the optional legacy alert projection is absent.
 */
export async function bridgeForecastToBatches({
  tenantId = null, facilityId = null, lookbackDays = 30,
  actorUid = null, actorRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const exactFacilityId = normalizeId(facilityId, 'facility_id');
  const requestedDays = normalizeInt(lookbackDays, 'lookback_days', { min: 1, max: 365 });
  const days = requestedDays || 30;
  return setTenantTx(tid, async (tx) => {
    await assertSupplyFacilityGrantTx(tx, {
      tenantId: tid,
      facilityId: exactFacilityId,
      actorUid,
      actorRole,
    });
    const items = await tx.$queryRawUnsafe(
      `SELECT item.id, item.sku_code, item.display_name, item.reorder_level
         FROM pharmacy_inventory_items item
         JOIN pharmacy_catalog catalog
           ON catalog.tenant_id=item.tenant_id
          AND catalog.id=item.catalog_id
          AND catalog.is_active=TRUE
         JOIN facilities facility
           ON facility.tenant_id=item.tenant_id
          AND facility.id=item.facility_id
          AND facility.status='active'
        WHERE item.tenant_id=$1::uuid AND item.facility_id=$2::int
          AND item.reorder_level IS NOT NULL AND item.status='active'`,
      tid,
      exactFacilityId,
    );
    const result = [];
    let alertProjectionAvailable = null;
    for (const item of items) {
      const stockRows = await tx.$queryRawUnsafe(
        `SELECT COALESCE(SUM(batch.remaining_quantity), 0)::numeric AS on_hand
           FROM pharmacy_inventory_batches batch
           JOIN pharmacy_suppliers supplier
             ON supplier.tenant_id=batch.tenant_id
            AND supplier.id=batch.supplier_id
            AND supplier.facility_id=batch.facility_id
            AND supplier.status='active'
          WHERE batch.tenant_id = $1::uuid AND batch.inventory_item_id = $2
            AND batch.facility_id=$3::int
            AND batch.status IN ('in_stock', 'reserved')
            AND batch.expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
            AND EXISTS (
              SELECT 1 FROM facility_locations location
               WHERE location.tenant_id=batch.tenant_id
                 AND location.facility_id=batch.facility_id
                 AND location.id=batch.storage_location_id
                 AND location.status='active'
            )`,
        tid, item.id, exactFacilityId,
      );
      const onHand = Number(stockRows[0]?.on_hand || 0);
      const issuedRows = await tx.$queryRawUnsafe(
        `SELECT COALESCE(SUM(-quantity_delta), 0)::numeric AS total_issued
           FROM pharmacy_stock_movements movement
           JOIN pharmacy_inventory_batches batch
             ON batch.tenant_id=movement.tenant_id
            AND batch.id=movement.inventory_batch_id
            AND batch.inventory_item_id=movement.inventory_item_id
            AND batch.facility_id=$4::int
           JOIN facility_locations location
             ON location.tenant_id=batch.tenant_id
            AND location.facility_id=batch.facility_id
            AND location.id=batch.storage_location_id
            AND location.status='active'
          WHERE movement.tenant_id = $1::uuid
            AND movement.inventory_item_id = $2
            AND movement.movement_kind = 'issue'
            AND movement.created_at >= NOW() - ($3::int * INTERVAL '1 day')`,
        tid, item.id, days,
        exactFacilityId,
      );
      const consumptionPerDay = Number(issuedRows[0]?.total_issued || 0) / days;
      const daysToReorder = consumptionPerDay > 0
        ? (onHand - Number(item.reorder_level)) / consumptionPerDay
        : null;
      let alertWritten = false;
      if (daysToReorder !== null && daysToReorder < 14) {
        const alertCategory = daysToReorder <= 0 ? 'stockout_risk' : 'reorder_point_breach';
        const severity = daysToReorder <= 0 ? 'critical' : (daysToReorder < 7 ? 'high' : 'moderate');
        if (alertProjectionAvailable === null) {
          const projectionRows = await tx.$queryRawUnsafe(
            `SELECT to_regclass('public.clinical_ai_inventory_alerts') IS NOT NULL AS available`,
          );
          alertProjectionAvailable = projectionRows[0]?.available === true;
        }
        if (alertProjectionAvailable) {
          await tx.$queryRawUnsafe(
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
              facility_id: exactFacilityId,
              days_to_reorder: daysToReorder,
              lookback_days: days,
            }]),
          );
          alertWritten = true;
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
  });
}

export const __testing__ = {
  severityForDaysRemaining,
  MOVEMENT_KINDS,
  BATCH_STATUSES,
  PO_STATUSES,
  EXPIRY_SEVERITIES,
  CONTROLLED_SCHEDULES,
  CONTROLLED_CUSTODY_BATCH_STATUSES,
  SUPPLY_DECREASING_MOVEMENTS,
  SUPPLY_REGISTER_KIND_BY_MOVEMENT,
  canonicalControlledScheduleClass,
  isControlledSupplyItem,
  normalizeBigInt,
  normalizeQuantity,
  numeric14_4ToScaled,
  canonicalNumeric14_4,
};

export default {
  upsertSupplier,
  listSuppliers,
  upsertInventoryItem,
  listInventoryItems,
  addInventoryBatch,
  listBatches,
  recallBatch,
  createPurchaseOrder,
  transitionPurchaseOrder,
  addPurchaseOrderItem,
  listPurchaseOrders,
  createGoodsReceipt,
  listGoodsReceipts,
  recordGoodsReceiptItemQc,
  transitionGoodsReceipt,
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
