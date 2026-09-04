// apps/backend/src/services/clinical/cathDeviceReuseService.js
//
// Cath-lab reprocessable device register, per-tenant reprocessing policy,
// post-use flow and CSSD device queue. Spec:
// docs/superpowers/specs/2026-09-04-cath-device-reuse-and-bloodborne-markers-design.md
//
// Boundaries: cathLabService.recordConsumableUsage calls captureReusedDeviceTx
// and markDeviceInCaseTx (added in a following commit); everything else about
// devices lives here. The register carries no patient identity — patient
// linkage is on usage rows — so the CSSD routes can read it without PHI logging.

import { CLINICAL_STAFF_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import { setTenant, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { logPhiAccess, logPhiAccessBatch } from '../../utils/hipaaAudit.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import { normalizeRole } from '../../utils/roles.js';
import { persistCdsAlert } from '../emr/cdsEngine.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  DEFAULT_VALIDITY_DAYS,
  MARKERS,
  registerExposureHandler,
  resolveReuseStatus,
} from './bloodborneMarkerService.js';
import { recordMedicationSafetyReviews } from './canonicalClinicalPlatformService.js';

export const DEVICE_STATUSES = Object.freeze([
  'awaiting_reprocessing', 'in_cssd', 'available', 'in_case', 'quarantined', 'discarded',
]);
export const CYCLE_TYPES = Object.freeze(['steam', 'eto', 'plasma', 'dry_heat', 'chemical', 'other']);
export const FUNCTION_CHECK_RESULTS = Object.freeze(['not_required', 'pass', 'fail']);
export const DISCARD_REASONS = Object.freeze([
  'max_cycles_reached', 'bloodborne_exposure', 'late_reactive_marker', 'function_check_failed',
  'sterilization_failed', 'damaged', 'wasted', 'policy_change', 'other',
]);
export const POST_USE_DISPOSITIONS = Object.freeze([
  'sent_for_reprocessing', 'discarded_bloodborne_exposure', 'discarded_max_cycles',
  'discarded_wasted', 'discarded_other', 'not_reprocessable',
]);
export const REACTIVE_PATIENT_RULES = Object.freeze(['discard', 'override_allowed']);
export const UNKNOWN_SEROLOGY_RULES = Object.freeze(['warn', 'block_return']);
export const CATH_CATEGORIES = Object.freeze([
  'stent', 'balloon', 'guidewire', 'catheter', 'sheath', 'closure_device', 'pacemaker', 'lead', 'other',
]);
export const IMPLANT_CATEGORIES = Object.freeze(['stent', 'pacemaker', 'lead', 'closure_device']);
// Absolute ceiling on the devices ONE post-use call may mint. units_max is
// derived from cath_case_consumable_usage.quantity, a NUMERIC the catalogue
// side does not bound: a fat-fingered quantity of 5000 would otherwise run
// 5000 INSERT + lock + audit round trips inside a single transaction and mint
// 5000 register rows nobody asked for. No real case opens more than a handful
// of reprocessable units, so 50 is far above practice and far below harm.
export const POST_USE_UNITS_CAP = 50;
// RP + at least 8 digits. cath_reprocessable_devices.device_tag is a stored
// generated column, `'RP' || lpad(id::text, GREATEST(8, length(id::text)), '0')`,
// so every tag minted today is exactly RP + 8 digits and ids past 10^8 keep
// every digit; the pattern stays open to 19 (bigint max) so this validator
// never becomes the thing that rejects a tag the DB itself produced.
export const DEVICE_TAG_PATTERN = /^RP[0-9]{8,19}$/;

export const DEVICE_ACTIONS = Object.freeze({
  receive: Object.freeze({ from: Object.freeze(['awaiting_reprocessing']), to: 'in_cssd' }),
  reprocessed: Object.freeze({ from: Object.freeze(['awaiting_reprocessing', 'in_cssd']), to: 'available' }),
  quarantine: Object.freeze({ from: Object.freeze(['awaiting_reprocessing', 'in_cssd', 'available']), to: 'quarantined' }),
  release: Object.freeze({ from: Object.freeze(['quarantined']), to: 'awaiting_reprocessing' }),
  discard: Object.freeze({ from: Object.freeze(['awaiting_reprocessing', 'in_cssd', 'available', 'in_case', 'quarantined']), to: 'discarded' }),
  capture: Object.freeze({ from: Object.freeze(['available']), to: 'in_case' }),
  return: Object.freeze({ from: Object.freeze(['in_case']), to: 'awaiting_reprocessing' }),
});

export function deviceTransition(status, action) {
  const rule = DEVICE_ACTIONS[action];
  if (!rule) return { ok: false, to: null, allowedFrom: [] };
  return { ok: rule.from.includes(status), to: rule.to, allowedFrom: rule.from };
}

export function normalizeDeviceTag(value) {
  const tag = String(value ?? '').trim().toUpperCase();
  if (!DEVICE_TAG_PATTERN.test(tag)) {
    throw AppError.badRequest('device tag must look like RP00000042', 'CATH_DEVICE_TAG_INVALID');
  }
  return tag;
}

export function computePostUseOptions({ usage, category, isImplant, policy, settings, restriction, device = null }) {
  const base = {
    dispositions: [],
    requires_acknowledgement: false,
    exposure: false,
    discard_reason: null,
    blocked_code: null,
    reason_codes: [],
    units_max: device ? 1 : Math.max(0, Math.floor(Number(usage?.quantity) || 0)),
  };
  if (usage?.wasted) return { ...base, reason_codes: ['wasted'] };
  if (usage?.post_use_disposition) return { ...base, reason_codes: ['already_recorded'] };
  if (isImplant || IMPLANT_CATEGORIES.includes(category) || !policy || policy.reprocessable !== true) {
    return { ...base, reason_codes: ['not_reprocessable'] };
  }
  if (device && Number(device.cycle_count) >= Number(device.max_cycles_snapshot)) {
    return { ...base, dispositions: ['discard'], discard_reason: 'max_cycles_reached', reason_codes: ['max_cycles_reached'] };
  }
  // The device's OWN exposure flag, which is a different fact from this
  // patient's restriction status below: the late-reactive sweep stamps the flag
  // from a PREVIOUS patient's reactive result, so a device can be flagged while
  // the current patient screens clear. Under the 'discard' rule that device
  // must not be offered for reprocessing on a clear patient's say-so.
  if (device?.exposure_flag === true && settings?.reactive_patient_rule === 'discard') {
    return { ...base, dispositions: ['discard'], discard_reason: 'bloodborne_exposure', reason_codes: ['device_exposure_flagged'] };
  }
  // Anything that is not an explicit 'clear' or 'restricted' is treated as unknown (fail restrictive).
  const status = restriction?.status === 'clear' || restriction?.status === 'restricted' ? restriction.status : 'unknown';
  if (status === 'restricted') {
    if (settings?.reactive_patient_rule === 'override_allowed') {
      return { ...base, dispositions: ['reprocess', 'discard'], requires_acknowledgement: true, exposure: true, reason_codes: ['bloodborne_restricted_override'] };
    }
    return { ...base, dispositions: ['discard'], discard_reason: 'bloodborne_exposure', reason_codes: ['bloodborne_restricted'] };
  }
  if (status === 'unknown') {
    if (settings?.unknown_serology_rule === 'block_return') {
      return { ...base, dispositions: ['discard'], blocked_code: 'CATH_REPROCESSING_SEROLOGY_REQUIRED', reason_codes: ['serology_required'] };
    }
    return { ...base, dispositions: ['reprocess', 'discard'], requires_acknowledgement: true, reason_codes: ['serology_unknown'] };
  }
  return { ...base, dispositions: ['reprocess', 'discard'] };
}

const tenantOr = (value) => requireTenantId(value);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanText(value, max = 2000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}
function requireUuid(value, label) {
  const text = String(value ?? '').trim();
  if (!UUID_PATTERN.test(text)) throw AppError.badRequest(`${label} must be a UUID`, 'CATH_LAB_BAD_UUID');
  return text.toLowerCase();
}
function positiveInt(value, label, { max = Number.MAX_SAFE_INTEGER } = {}) {
  // Decimal digits ONLY. `Number(value)` alone silently accepts '7e2' (700),
  // '0x10' (16) and '+7' — three spellings that mean a DIFFERENT number than
  // the one the caller typed, and every one of them reaches a bigint row id, a
  // facility filter or a bounded policy field. '7.0' is rejected too: an id
  // with a fractional part is a malformed request, not a rounding job.
  // Surrounding whitespace is a transport artefact rather than a different
  // value, so the text is trimmed before the shape check.
  const text = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(text)) throw AppError.badRequest(`${label} must be a positive integer`, 'CATH_LAB_BAD_ID');
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n <= 0 || n > max) throw AppError.badRequest(`${label} must be a positive integer`, 'CATH_LAB_BAD_ID');
  return n;
}
function oneOf(value, allowed, label, code = 'CATH_LAB_BAD_ENUM') {
  const text = String(value ?? '').trim().toLowerCase();
  if (!allowed.includes(text)) throw AppError.badRequest(`${label} must be one of ${allowed.join(', ')}`, code);
  return text;
}
function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
  if (value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false;
  throw AppError.badRequest('Boolean field is invalid', 'CATH_LAB_BAD_BOOLEAN');
}
function num(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value?.toNumber === 'function') return value.toNumber();
  return value;
}
function withTenant(tenantId, db, fn) { return db ? fn(db) : setTenant(tenantId, fn); }

async function recordDeviceAudit(tx, { tenantId, action, resource, resourceId, context = {}, metadata = {} }) {
  // Column list mirrors the CSSD sibling (src/services/cssd/cssdService.js:208)
  // exactly: audit_logs (plural) carries uid + actor_uid + role, and the
  // append-only trigger rejects any later edit, so write it once, correctly.
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs
       (tenant_id, uid, role, action, resource, resource_id, metadata, actor_uid, created_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $2::uuid, NOW())`,
    tenantId,
    context.actorUid ? requireUuid(context.actorUid, 'actorUid') : null,
    // audit_logs.role is VARCHAR(50); anything longer would raise 22001 and
    // take the whole transition down with it.
    cleanText(context.actorRole, 50),
    action, resource, String(resourceId), JSON.stringify(metadata),
  );
}

export const SETTINGS_DEFAULTS = Object.freeze({ reactive_patient_rule: 'discard', unknown_serology_rule: 'warn', serology_validity_days: DEFAULT_VALIDITY_DAYS });
const SETTINGS_SELECT = `tenant_id, reactive_patient_rule, unknown_serology_rule, serology_validity_days, reviewed_by, reviewed_at, updated_by, created_at, updated_at`;

export async function getReprocessingSettings({ tenantId, db = null } = {}) {
  const tid = tenantOr(tenantId);
  const rows = await withTenant(tid, db, (client) => client.$queryRawUnsafe(`SELECT ${SETTINGS_SELECT} FROM cath_reprocessing_settings WHERE tenant_id = $1::uuid LIMIT 1`, tid));
  const row = rows[0];
  // The unconfigured shape carries every column SETTINGS_SELECT returns, so a
  // caller reading settings never has to branch on `configured` for key access.
  if (!row) return { tenant_id: tid, ...SETTINGS_DEFAULTS, reviewed_by: null, reviewed_at: null, updated_by: null, created_at: null, updated_at: null, configured: false };
  return { ...row, serology_validity_days: Number(row.serology_validity_days), configured: true };
}

export async function upsertReprocessingSettings(input = {}, context = {}) {
  const tid = tenantOr(input.tenantId);
  const reactiveRule = oneOf(input.reactive_patient_rule ?? SETTINGS_DEFAULTS.reactive_patient_rule, REACTIVE_PATIENT_RULES, 'reactive_patient_rule');
  const unknownRule = oneOf(input.unknown_serology_rule ?? SETTINGS_DEFAULTS.unknown_serology_rule, UNKNOWN_SEROLOGY_RULES, 'unknown_serology_rule');
  const validity = positiveInt(input.serology_validity_days ?? SETTINGS_DEFAULTS.serology_validity_days, 'serology_validity_days', { max: 365 });
  const actor = requireUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_reprocessing_settings (tenant_id, reactive_patient_rule, unknown_serology_rule, serology_validity_days, reviewed_by, reviewed_at, updated_by)
       VALUES ($1::uuid, $2, $3, $4::int, $5::uuid, NOW(), $5::uuid)
       ON CONFLICT (tenant_id) DO UPDATE SET reactive_patient_rule = EXCLUDED.reactive_patient_rule, unknown_serology_rule = EXCLUDED.unknown_serology_rule,
         serology_validity_days = EXCLUDED.serology_validity_days, reviewed_by = EXCLUDED.reviewed_by, reviewed_at = NOW(), updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING ${SETTINGS_SELECT}`,
      tid, reactiveRule, unknownRule, validity, actor,
    );
    await recordDeviceAudit(tx, { tenantId: tid, action: 'CATH_REPROCESSING_SETTINGS_UPDATED', resource: 'cath_reprocessing_settings', resourceId: tid, context,
      metadata: { reactive_patient_rule: reactiveRule, unknown_serology_rule: unknownRule, serology_validity_days: validity } });
    return { ...rows[0], serology_validity_days: Number(rows[0].serology_validity_days), configured: true };
  });
}

const POLICY_SELECT = `tenant_id, category, reprocessable, max_cycles, allowed_cycle_types, function_check_required, updated_by, created_at, updated_at`;
function normalizePolicy(row) { return { ...row, max_cycles: row.max_cycles == null ? null : Number(row.max_cycles), allowed_cycle_types: Array.isArray(row.allowed_cycle_types) ? row.allowed_cycle_types : [] }; }
function defaultPolicy(tenantId, category) { return { tenant_id: tenantId, category, reprocessable: false, max_cycles: null, allowed_cycle_types: [], function_check_required: false, updated_by: null, created_at: null, updated_at: null }; }

export async function listCategoryPolicies({ tenantId, db = null } = {}) {
  const tid = tenantOr(tenantId);
  const rows = await withTenant(tid, db, (client) => client.$queryRawUnsafe(`SELECT ${POLICY_SELECT} FROM cath_reprocessing_category_policies WHERE tenant_id = $1::uuid`, tid));
  const byCategory = new Map(rows.map((row) => [row.category, normalizePolicy(row)]));
  return CATH_CATEGORIES.map((category) => byCategory.get(category) || defaultPolicy(tid, category));
}
export async function categoryPolicyTx(tx, tenantId, category) {
  const rows = await tx.$queryRawUnsafe(`SELECT ${POLICY_SELECT} FROM cath_reprocessing_category_policies WHERE tenant_id = $1::uuid AND category = $2 LIMIT 1`, tenantOr(tenantId), category);
  return rows[0] ? normalizePolicy(rows[0]) : null;
}
// Pure, and it mirrors four of the table's CHECK constraints (implant vs
// reprocessable, max_cycles range, allowed_cycle_types vocabulary, category
// vocabulary), so it is exported for tests rather than reached through a write.
export function validatePolicyInput(entry) {
  const category = oneOf(entry.category, CATH_CATEGORIES, 'category');
  const reprocessable = boolValue(entry.reprocessable, false);
  if (reprocessable && IMPLANT_CATEGORIES.includes(category)) throw AppError.badRequest(`${category} is an implant category and can never be reprocessable`, 'CATH_REPROCESSING_IMPLANT_FORBIDDEN');
  const maxCycles = entry.max_cycles == null || entry.max_cycles === '' ? null : positiveInt(entry.max_cycles, 'max_cycles', { max: 50 });
  const cycleTypes = Array.isArray(entry.allowed_cycle_types) ? entry.allowed_cycle_types.map((t) => oneOf(t, CYCLE_TYPES, 'allowed_cycle_types')) : [];
  const functionCheck = boolValue(entry.function_check_required, false);
  if (reprocessable && (maxCycles == null || cycleTypes.length === 0)) throw AppError.badRequest('A reprocessable category needs max_cycles and at least one allowed cycle type', 'CATH_REPROCESSING_POLICY_INCOMPLETE');
  return { category, reprocessable, maxCycles, cycleTypes: [...new Set(cycleTypes)], functionCheck };
}
export async function upsertCategoryPolicies({ tenantId, policies = [] } = {}, context = {}) {
  const tid = tenantOr(tenantId);
  if (!Array.isArray(policies) || policies.length === 0) throw AppError.badRequest('policies must be a non-empty array', 'CATH_REPROCESSING_POLICY_INCOMPLETE');
  // There are exactly CATH_CATEGORIES.length categories and the table is keyed
  // (tenant_id, category), so a longer array can only be duplicates — and a
  // duplicated category is a last-writer-wins race inside ONE request, where
  // the caller cannot tell which of its two entries survived. Bound the loop
  // and reject the ambiguity instead of upserting the same key twice.
  if (policies.length > CATH_CATEGORIES.length) {
    throw AppError.badRequest(`policies cannot exceed the ${CATH_CATEGORIES.length} consumable categories`, 'CATH_REPROCESSING_POLICY_DUPLICATE');
  }
  const actor = requireUuid(context.actorUid, 'actorUid');
  const validated = policies.map(validatePolicyInput);
  const seen = new Set();
  for (const policy of validated) {
    if (seen.has(policy.category)) {
      throw AppError.badRequest(`category ${policy.category} appears more than once`, 'CATH_REPROCESSING_POLICY_DUPLICATE');
    }
    seen.add(policy.category);
  }
  await setTenantTx(tid, async (tx) => {
    for (const policy of validated) {
      await tx.$executeRawUnsafe(
        `INSERT INTO cath_reprocessing_category_policies (tenant_id, category, reprocessable, max_cycles, allowed_cycle_types, function_check_required, updated_by)
         VALUES ($1::uuid, $2, $3, $4::int, $5::text[], $6, $7::uuid)
         ON CONFLICT (tenant_id, category) DO UPDATE SET reprocessable = EXCLUDED.reprocessable, max_cycles = EXCLUDED.max_cycles, allowed_cycle_types = EXCLUDED.allowed_cycle_types,
           function_check_required = EXCLUDED.function_check_required, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        tid, policy.category, policy.reprocessable, policy.maxCycles, policy.cycleTypes, policy.functionCheck, actor,
      );
    }
    await recordDeviceAudit(tx, { tenantId: tid, action: 'CATH_REPROCESSING_POLICY_UPDATED', resource: 'cath_reprocessing_category_policies', resourceId: tid, context,
      metadata: { categories: validated.map((p) => ({ category: p.category, reprocessable: p.reprocessable, max_cycles: p.maxCycles })) } });
  });
  return listCategoryPolicies({ tenantId: tid });
}

const DEVICE_SELECT = `d.id, d.tenant_id, d.facility_id, d.catalog_item_id, d.device_tag, d.origin_usage_id, d.origin_unit_index, d.cycle_count, d.max_cycles_snapshot, d.status, d.current_usage_id,
  d.exposure_flag, d.exposure_markers, d.last_reprocessed_at, d.last_reprocessed_by, d.last_cycle_type, d.last_function_check, d.quarantine_reason, d.quarantined_at,
  d.discard_reason, d.discard_note, d.discarded_at, d.discarded_by, d.created_by, d.created_at, d.updated_at, d.metadata, c.item_name, c.category, c.manufacturer, c.model`;
const DEVICE_FROM = `FROM cath_reprocessable_devices d JOIN cath_consumable_catalog c ON c.id = d.catalog_item_id AND c.tenant_id = d.tenant_id`;

export function normalizeDevice(row) {
  if (!row) return row;
  return { ...row, id: num(row.id), catalog_item_id: num(row.catalog_item_id), origin_usage_id: num(row.origin_usage_id),
    current_usage_id: row.current_usage_id == null ? null : num(row.current_usage_id), cycle_count: Number(row.cycle_count),
    max_cycles_snapshot: Number(row.max_cycles_snapshot), facility_id: Number(row.facility_id), exposure_markers: Array.isArray(row.exposure_markers) ? row.exposure_markers : [] };
}
export async function listDevices({ tenantId, status = null, facilityId = null, limit = 100, db = null } = {}) {
  const tid = tenantOr(tenantId);
  const params = [tid]; const clauses = ['d.tenant_id = $1::uuid'];
  if (status) { params.push(oneOf(status, DEVICE_STATUSES, 'status')); clauses.push(`d.status = $${params.length}`); }
  // Presence, not truthiness: facility_id is INTEGER, so a bad filter should be
  // a 400 rather than silently listing every facility. 0 is not a valid id and
  // positiveInt rejects it; only null/undefined/'' mean "no filter".
  if (facilityId !== null && facilityId !== undefined && facilityId !== '') {
    params.push(positiveInt(facilityId, 'facility_id', { max: 2_147_483_647 }));
    clauses.push(`d.facility_id = $${params.length}::int`);
  }
  params.push(Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500));
  const rows = await withTenant(tid, db, (client) => client.$queryRawUnsafe(
    `SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE ${clauses.join(' AND ')}
      ORDER BY CASE d.status WHEN 'awaiting_reprocessing' THEN 0 WHEN 'in_cssd' THEN 1 WHEN 'quarantined' THEN 2 WHEN 'available' THEN 3 WHEN 'in_case' THEN 4 ELSE 5 END, d.updated_at DESC, d.id DESC
      LIMIT $${params.length}::int`, ...params));
  return rows.map(normalizeDevice);
}
export async function deviceByTag({ tenantId, tag, db = null } = {}) {
  const tid = tenantOr(tenantId); const safeTag = normalizeDeviceTag(tag);
  const rows = await withTenant(tid, db, (client) => client.$queryRawUnsafe(`SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE d.tenant_id = $1::uuid AND d.device_tag = $2 LIMIT 1`, tid, safeTag));
  return rows[0] ? normalizeDevice(rows[0]) : null;
}
async function lockDeviceTx(tx, tenantId, deviceId) {
  const rows = await tx.$queryRawUnsafe(`SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE d.tenant_id = $1::uuid AND d.id = $2::bigint FOR UPDATE OF d`, tenantOr(tenantId), positiveInt(deviceId, 'device_id'));
  if (!rows[0]) throw AppError.notFound('Reprocessable device not found', 'CATH_DEVICE_NOT_FOUND');
  return normalizeDevice(rows[0]);
}
async function lockDeviceByTagTx(tx, tenantId, tag) {
  const rows = await tx.$queryRawUnsafe(`SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE d.tenant_id = $1::uuid AND d.device_tag = $2 FOR UPDATE OF d`, tenantOr(tenantId), normalizeDeviceTag(tag));
  if (!rows[0]) throw AppError.notFound('Reprocessable device not found', 'CATH_DEVICE_NOT_FOUND');
  return normalizeDevice(rows[0]);
}
function assertTransition(device, action) {
  const verdict = deviceTransition(device.status, action);
  if (!verdict.ok) throw AppError.conflict(`Device ${device.device_tag} is ${device.status}; ${action} is only allowed from ${verdict.allowedFrom.join(', ')}`, 'CATH_DEVICE_INVALID_TRANSITION', { status: device.status, action, allowed_from: verdict.allowedFrom });
  return verdict.to;
}
async function applyDeviceTransitionTx(tx, device, action, patch = {}, context = {}) {
  const to = assertTransition(device, action);
  // Shape guards for the columns the UPDATE below writes, checked here rather
  // than left to the table's CHECK constraints: a 23514 from Postgres is a 500
  // with no field name, these are 400s that say which field is wrong. Every
  // caller — including the ones Task 3 adds — goes through this function, so
  // this is the one place that has to be right.
  if (to === 'in_case' && patch.usageId == null) throw AppError.badRequest('usage_id is required to place a device in a case', 'CATH_DEVICE_USAGE_REQUIRED');
  if (to === 'discarded' && !patch.discardReason) throw AppError.badRequest('discard reason is required', 'CATH_DEVICE_REASON_REQUIRED');
  const discardReason = patch.discardReason == null ? null : oneOf(patch.discardReason, DISCARD_REASONS, 'discard_reason', 'CATH_DEVICE_DISCARD_REASON_INVALID');
  const cycleType = patch.cycleType == null ? null : oneOf(patch.cycleType, CYCLE_TYPES, 'cycle_type', 'CSSD_DEVICE_CYCLE_TYPE_INVALID');
  const functionCheck = patch.functionCheck == null ? null : oneOf(patch.functionCheck, FUNCTION_CHECK_RESULTS, 'function_check_result', 'CATH_DEVICE_FUNCTION_CHECK_INVALID');
  // Markers are a shared vocabulary with the patient marker record, and they
  // are appended to a TEXT[] with no CHECK on its element values — validate and
  // dedupe here so nothing can smuggle a free-text value into the array.
  const exposureMarkers = Array.isArray(patch.exposureMarkers) && patch.exposureMarkers.length
    ? [...new Set(patch.exposureMarkers.map((marker) => oneOf(marker, MARKERS, 'exposure_markers', 'CATH_DEVICE_EXPOSURE_MARKER_INVALID')))]
    : null;
  // The actor stays nullable HERE on purpose: the late-reactive-marker sweep
  // Task 3 adds is a system actor and calls in with `actorUid: null`. Every
  // human-facing entry point below requires it before opening its transaction.
  const actor = context.actorUid ? requireUuid(context.actorUid, 'actorUid') : null;
  // cath_reprocessable_devices_exposure_check: exposure_flag must be true
  // whenever exposure_markers is non-empty, so supplying markers implies the
  // flag — never let a caller set one without the other.
  const exposureFlag = Boolean(patch.exposureFlag) || exposureMarkers !== null;
  const rows = await tx.$queryRawUnsafe(
    // $3 MUST carry an explicit ::text cast at EVERY use. Prisma sends raw
    // params untyped, so Postgres deduces $3 as character varying from
    // `SET status = $3` and as text from `$3 = 'in_case'` and errors at PARSE
    // time with "inconsistent types deduced for parameter $3" — every
    // transition would 500. Verified against the live schema by PREPAREing this
    // statement with no parameter type list. Do not "simplify" the casts away.
    //
    // cath_reprocessable_devices_in_case_check is a biconditional:
    // current_usage_id IS NOT NULL exactly when status = 'in_case'. This UPDATE
    // sets it on 'in_case' and nulls it on 'awaiting_reprocessing'/'discarded';
    // 'available'/'quarantined'/'in_cssd' keep whatever is there, which is
    // always NULL — the only exits from 'in_case' are `return` and `discard`,
    // and both land on a status that nulls the column.
    `UPDATE cath_reprocessable_devices d
        SET status = $3::text,
            current_usage_id = CASE WHEN $3::text = 'in_case' THEN $4::bigint WHEN $3::text IN ('awaiting_reprocessing', 'discarded') THEN NULL ELSE current_usage_id END,
            cycle_count = CASE WHEN $3::text = 'available' THEN cycle_count + 1 ELSE cycle_count END,
            last_reprocessed_at = CASE WHEN $3::text = 'available' THEN NOW() ELSE last_reprocessed_at END,
            last_reprocessed_by = CASE WHEN $3::text = 'available' THEN $5::uuid ELSE last_reprocessed_by END,
            last_cycle_type = CASE WHEN $3::text = 'available' THEN $6 ELSE last_cycle_type END,
            -- A device discarded for 'function_check_failed' never reaches
            -- 'available', so without this second arm the failing check would
            -- exist only in the audit row and last_function_check would still
            -- read 'pass' from the previous cycle.
            last_function_check = CASE WHEN $3::text = 'available' OR $9 = 'function_check_failed' THEN $7 ELSE last_function_check END,
            -- 'awaiting_reprocessing' clears the quarantine fields: it is where
            -- the release action lands, and a released device must not keep
            -- showing the reason it was held for. The return action
            -- (in_case -> awaiting_reprocessing) hits the same arm, but a device
            -- in a case cannot be quarantined -- quarantine's from-list excludes
            -- 'in_case' -- so there it is a no-op.
            quarantine_reason = CASE WHEN $3::text = 'quarantined' THEN $8 WHEN $3::text = 'awaiting_reprocessing' THEN NULL ELSE quarantine_reason END,
            quarantined_at = CASE WHEN $3::text = 'quarantined' THEN NOW() WHEN $3::text = 'awaiting_reprocessing' THEN NULL ELSE quarantined_at END,
            discard_reason = CASE WHEN $3::text = 'discarded' THEN $9 ELSE discard_reason END,
            discard_note = CASE WHEN $3::text = 'discarded' THEN $10 ELSE discard_note END,
            discarded_at = CASE WHEN $3::text = 'discarded' THEN NOW() ELSE discarded_at END,
            discarded_by = CASE WHEN $3::text = 'discarded' THEN $5::uuid ELSE discarded_by END,
            exposure_flag = exposure_flag OR $11::boolean,
            -- DISTINCT without ORDER BY leaves the stored array in hash order,
            -- which makes the column's value depend on the plan; ORDER BY m
            -- makes the merge deterministic so equality assertions hold.
            exposure_markers = CASE WHEN $12::text[] IS NULL THEN exposure_markers ELSE ARRAY(SELECT DISTINCT m FROM unnest(exposure_markers || $12::text[]) AS m ORDER BY m) END,
            metadata = metadata || $13::jsonb,
            updated_at = NOW()
      WHERE d.tenant_id = $1::uuid AND d.id = $2::bigint
      RETURNING d.id`,
    device.tenant_id, device.id, to,
    patch.usageId == null ? null : positiveInt(patch.usageId, 'usage_id'),
    actor, cycleType, functionCheck, cleanText(patch.quarantineReason, 500),
    discardReason, cleanText(patch.discardNote, 2000), exposureFlag,
    exposureMarkers,
    JSON.stringify(patch.metadata || {}),
  );
  if (!rows[0]) throw AppError.internal('Device transition did not persist', 'CATH_DEVICE_TRANSITION_FAILED');
  await recordDeviceAudit(tx, { tenantId: device.tenant_id, action: `cath_device.${action}`, resource: 'cath_reprocessable_devices', resourceId: device.id, context,
    // The claimed idempotency key rides the audit row so a replayed CSSD
    // command can be told apart from a genuine second transition on the same
    // device. cssdRoutes builds deviceContext() with it for exactly this;
    // before this line the key was collected and then dropped on the floor.
    metadata: { device_tag: device.device_tag, from: device.status, to, cycle_count_before: device.cycle_count, discard_reason: discardReason, quarantine_reason: cleanText(patch.quarantineReason, 500), note: cleanText(patch.discardNote ?? patch.note, 500), idempotency_key: context.idempotencyKey ?? null } });
  return lockDeviceTx(tx, device.tenant_id, device.id);
}

// Every entry point below is operated by a person, so each validates
// context.actorUid BEFORE opening its transaction: a missing actor is a 400,
// not a row written with a NULL audit actor, and not a lock held while we
// discover the request was malformed.
export async function receiveDevice(deviceId, context = {}) {
  const tid = tenantOr(context.tenantId);
  requireUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => applyDeviceTransitionTx(tx, await lockDeviceTx(tx, tid, deviceId), 'receive', {}, context));
}
export async function markDeviceReprocessed(deviceId, input = {}, context = {}) {
  const tid = tenantOr(context.tenantId);
  // Shape (400) and policy (409) are different failures: an unknown cycle type
  // is a bad request, a known one the category does not allow is a conflict
  // that carries the allowed list.
  const cycleType = oneOf(input.cycle_type ?? input.cycleType, CYCLE_TYPES, 'cycle_type', 'CSSD_DEVICE_CYCLE_TYPE_INVALID');
  const functionCheck = input.function_check_result == null && input.functionCheckResult == null ? null : oneOf(input.function_check_result ?? input.functionCheckResult, FUNCTION_CHECK_RESULTS, 'function_check_result');
  requireUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => {
    const device = await lockDeviceTx(tx, tid, deviceId);
    // The from-state check for what this call IS — a reprocessing record —
    // runs before any branching. The fail path below transitions with
    // `discard`, whose from-list is wider, so without this an in_case,
    // available, quarantined or discarded device would be silently discarded
    // by a CSSD "reprocessed, check failed" submission instead of 409ing.
    assertTransition(device, 'reprocessed');
    const policy = await categoryPolicyTx(tx, tid, device.category);
    if (!policy || policy.reprocessable !== true) throw AppError.conflict(`${device.category} is not reprocessable under the current policy`, 'CATH_REPROCESSING_NOT_ALLOWED');
    if (!policy.allowed_cycle_types.includes(cycleType)) throw AppError.conflict(`${cycleType} is not an allowed cycle type for ${device.category}`, 'CSSD_DEVICE_CYCLE_TYPE_NOT_ALLOWED', { allowed: policy.allowed_cycle_types });
    if (policy.function_check_required && functionCheck !== 'pass' && functionCheck !== 'fail') throw AppError.badRequest('function_check_result (pass or fail) is required for this category', 'CATH_DEVICE_FUNCTION_CHECK_REQUIRED');
    if (functionCheck === 'fail') {
      return applyDeviceTransitionTx(tx, device, 'discard', { discardReason: 'function_check_failed', functionCheck: 'fail', discardNote: cleanText(input.note, 2000),
        metadata: { cycle_type: cycleType, function_check_result: 'fail' } }, context);
    }
    if (device.cycle_count >= device.max_cycles_snapshot) throw AppError.conflict(`Device ${device.device_tag} has reached ${device.max_cycles_snapshot} cycles; discard it`, 'CATH_DEVICE_MAX_CYCLES_REACHED');
    return applyDeviceTransitionTx(tx, device, 'reprocessed', { cycleType, functionCheck: functionCheck ?? 'not_required' }, context);
  });
}
export async function quarantineDevice(deviceId, input = {}, context = {}) {
  const tid = tenantOr(context.tenantId); const reason = cleanText(input.reason, 500);
  if (!reason) throw AppError.badRequest('reason is required to quarantine a device', 'CATH_DEVICE_REASON_REQUIRED');
  requireUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => applyDeviceTransitionTx(tx, await lockDeviceTx(tx, tid, deviceId), 'quarantine', { quarantineReason: reason }, context));
}
export async function releaseDevice(deviceId, input = {}, context = {}) {
  const tid = tenantOr(context.tenantId);
  requireUuid(context.actorUid, 'actorUid');
  // The release note survives the cleared quarantine_reason column: it is kept
  // in metadata and in the audit row this transition writes.
  return setTenantTx(tid, async (tx) => applyDeviceTransitionTx(tx, await lockDeviceTx(tx, tid, deviceId), 'release', { note: cleanText(input.note, 500), metadata: { release_note: cleanText(input.note, 500) } }, context));
}
export async function discardDevice(deviceId, input = {}, context = {}) {
  const tid = tenantOr(context.tenantId);
  // Missing and invalid are separate 400s: "you forgot the reason" and "that is
  // not a reason we recognise" are different things to show an operator.
  const rawReason = cleanText(input.reason, 100);
  if (!rawReason) throw AppError.badRequest('discard reason is required', 'CATH_DEVICE_REASON_REQUIRED');
  const reason = oneOf(rawReason, DISCARD_REASONS, 'reason', 'CATH_DEVICE_DISCARD_REASON_INVALID');
  requireUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => applyDeviceTransitionTx(tx, await lockDeviceTx(tx, tid, deviceId), 'discard', { discardReason: reason, discardNote: cleanText(input.note, 2000) }, context));
}

// The generic validators (cleanText, requireUuid, positiveInt, oneOf) stay
// module-private: Task 3 appends to this same file and uses them directly.
export { lockDeviceTx, lockDeviceByTagTx, applyDeviceTransitionTx, recordDeviceAudit, withTenant };

// positiveInt guards every bigint row id, the facility filter and the bounded
// policy fields on this surface, and how strict it is cannot be observed
// through a caller without a database. Exposed the same way cathLabService
// exposes its own internals — for tests, not for callers.
export const __testing__ = { positiveInt };

// ---------------------------------------------------------------------------
// Case-level reuse context and usage decoration
// ---------------------------------------------------------------------------

// `lock` is a boolean the callers below set literally; it never carries caller
// input, so the interpolation cannot become an injection point.
async function caseRowTx(client, tenantId, caseId, { lock = false } = {}) {
  const rows = await client.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, encounter_id, facility_id, status, actual_start_at
       FROM cath_lab_cases
      WHERE tenant_id = $1::uuid AND id = $2::bigint
      ${lock ? 'FOR UPDATE' : ''}
      LIMIT 1`,
    tenantOr(tenantId), positiveInt(caseId, 'case_id'),
  );
  const row = rows[0];
  if (!row) throw AppError.notFound('Cath-lab case not found', 'CATH_LAB_CASE_NOT_FOUND');
  return { ...row, id: num(row.id), facility_id: row.facility_id == null ? null : Number(row.facility_id) };
}

export async function caseReuseContext({ tenantId, caseId, db = null } = {}) {
  const tid = tenantOr(tenantId);
  return withTenant(tid, db, async (client) => {
    const cathCase = await caseRowTx(client, tid, caseId);
    const settings = await getReprocessingSettings({ tenantId: tid, db: client });
    const policies = await listCategoryPolicies({ tenantId: tid, db: client });
    const restriction = await resolveReuseStatus({
      tenantId: tid, patientUid: cathCase.patient_uid, validityDays: settings.serology_validity_days, db: client,
    });
    return {
      case: cathCase,
      settings,
      policies,
      restriction,
      reprocessable_categories: policies.filter((p) => p.reprocessable).map((p) => p.category),
    };
  });
}

// The serology detail audience. CLINICAL_STAFF_ROUTE_ROLES is the platform's
// existing answer to "who may read a patient's clinical narrative" — reuse it
// rather than mint a parallel list that drifts from it.
const SEROLOGY_DETAIL_ROLES = new Set(CLINICAL_STAFF_ROUTE_ROLES);

export function roleSeesSerologyDetail(role) {
  return SEROLOGY_DETAIL_ROLES.has(normalizeRole(role) || '');
}

// A reuse restriction carries two fields that are a patient's blood-borne
// serology in plain sight: `reasons` ("HBsAg reactive 2026-04-11") and
// `markers` (per-marker result and date). The capture sheet needs the DECISION
// — status, the window it was judged against, and when — but a receptionist or
// a stores clerk holding a cath-lab role has no business reading which marker
// came back reactive. Project by role rather than drop the keys: the published
// schema and the Staff app both parse a fixed shape, so `reasons`/`markers`
// come back EMPTY, never absent.
export function projectReuseRestrictionForRole(restriction, role) {
  if (!restriction || typeof restriction !== 'object') return restriction;
  if (roleSeesSerologyDetail(role)) return restriction;
  return {
    status: restriction.status,
    validity_days: restriction.validity_days,
    evaluated_at: restriction.evaluated_at,
    reasons: [],
    markers: [],
  };
}

// Adds device_tag / device status / allowed_post_use to the usage rows
// cathLabService.listCaseConsumableUsage produces.
export async function decorateConsumablesWithReuse(usageRows, { tenantId, caseId }) {
  const tid = tenantOr(tenantId);
  const rows = Array.isArray(usageRows) ? usageRows : [];
  const context = await caseReuseContext({ tenantId: tid, caseId });
  const deviceIds = rows.map((u) => u.device_id).filter((id) => id != null).map(Number);
  const devices = deviceIds.length
    ? await setTenant(tid, (tx) => tx.$queryRawUnsafe(
      `SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE d.tenant_id = $1::uuid AND d.id = ANY($2::bigint[])`,
      tid, deviceIds,
    ))
    : [];
  const byId = new Map(devices.map((d) => [num(d.id), normalizeDevice(d)]));
  const policyByCategory = new Map(context.policies.map((p) => [p.category, p]));
  const usage = rows.map((row) => {
    const device = row.device_id == null ? null : byId.get(Number(row.device_id)) || null;
    const options = computePostUseOptions({
      usage: row,
      category: row.category,
      isImplant: Boolean(row.is_implant),
      policy: policyByCategory.get(row.category) || null,
      settings: context.settings,
      restriction: context.restriction,
      device,
    });
    return {
      ...row,
      device_tag: device ? device.device_tag : null,
      device_status: device ? device.status : null,
      device_exposure_flag: device ? device.exposure_flag : false,
      allowed_post_use: options,
    };
  });
  return {
    usage,
    reuse_restriction: context.restriction,
    reprocessing: {
      settings: context.settings,
      reprocessable_categories: context.reprocessable_categories,
    },
  };
}

// ---------------------------------------------------------------------------
// Reused capture — called by cathLabService.recordConsumableUsage inside its tx
// ---------------------------------------------------------------------------

export async function captureReusedDeviceTx(tx, { tenantId, cathCase, catalog, deviceTag, acknowledgementReason = null }) {
  const tid = tenantOr(tenantId);
  const device = await lockDeviceByTagTx(tx, tid, deviceTag);
  if (device.catalog_item_id !== Number(catalog.id)) {
    throw AppError.conflict(`Device ${device.device_tag} is a ${device.item_name}, not the selected catalogue item`, 'CATH_DEVICE_CATALOG_MISMATCH');
  }
  if (device.facility_id !== Number(cathCase.facility_id)) {
    throw AppError.conflict(`Device ${device.device_tag} belongs to another facility`, 'CATH_DEVICE_FACILITY_MISMATCH');
  }
  const policy = await categoryPolicyTx(tx, tid, catalog.category);
  if (!policy || policy.reprocessable !== true) {
    throw AppError.conflict(`${catalog.category} is not reprocessable under the current policy`, 'CATH_REPROCESSING_NOT_ALLOWED');
  }
  if (device.status !== 'available') {
    throw AppError.conflict(`Device ${device.device_tag} is ${device.status}, not available`, 'CATH_DEVICE_NOT_AVAILABLE', { status: device.status });
  }
  const settings = await getReprocessingSettings({ tenantId: tid, db: tx });
  if (device.exposure_flag) {
    if (settings.reactive_patient_rule === 'discard') {
      throw AppError.conflict(`Device ${device.device_tag} carries a blood-borne exposure flag`, 'CATH_DEVICE_EXPOSURE_BLOCKED', { exposure_markers: device.exposure_markers });
    }
    if (!acknowledgementReason) {
      throw AppError.badRequest('exposure_acknowledgement.reason is required to reuse an exposure-flagged device', 'CATH_DEVICE_ACKNOWLEDGEMENT_REQUIRED', { exposure_markers: device.exposure_markers });
    }
  }
  const restriction = await resolveReuseStatus({
    tenantId: tid, patientUid: cathCase.patient_uid, validityDays: settings.serology_validity_days, db: tx,
  });
  return { device, policy, settings, restriction };
}

export async function markDeviceInCaseTx(tx, { device, usageId, acknowledgementReason = null, patientUid, encounterId = null, context = {} }) {
  const updated = await applyDeviceTransitionTx(tx, device, 'capture', {
    usageId,
    metadata: acknowledgementReason ? { last_exposure_acknowledgement: acknowledgementReason } : {},
  }, context);
  if (acknowledgementReason) {
    await recordReuseSafetyReview(tx, {
      tenantId: device.tenant_id, patientUid, encounterId,
      findingCode: 'EXPOSED_DEVICE_REUSED',
      message: `Exposure-flagged device ${device.device_tag} reused with acknowledgement`,
      reason: acknowledgementReason, actorUid: context.actorUid,
      payload: { device_id: device.id, device_tag: device.device_tag, usage_id: usageId, exposure_markers: device.exposure_markers },
    });
  }
  return updated;
}

// A reused device recorded as wasted is opened and destroyed in the case: it
// never becomes 'in_case', so it takes the discard tap instead of the capture
// tap. The acknowledgement obligation is identical either way — captureReusedDeviceTx
// demands exposure_acknowledgement.reason for an exposure-flagged device under
// `override_allowed` regardless of the wasted flag, so the override must land on
// the clinical record here too. Before this existed the wasted branch called
// applyDeviceTransitionTx directly and the review was silently dropped.
export async function markDeviceWastedTx(tx, { device, usageId, wasteReason, acknowledgementReason = null, patientUid, encounterId = null, context = {} }) {
  const updated = await applyDeviceTransitionTx(tx, device, 'discard', {
    discardReason: 'wasted',
    discardNote: wasteReason,
    metadata: {
      usage_id: usageId,
      ...(acknowledgementReason ? { last_exposure_acknowledgement: acknowledgementReason } : {}),
    },
  }, context);
  if (acknowledgementReason) {
    await recordReuseSafetyReview(tx, {
      tenantId: device.tenant_id, patientUid, encounterId,
      findingCode: 'EXPOSED_DEVICE_REUSED',
      message: `Exposure-flagged device ${device.device_tag} reused with acknowledgement and wasted`,
      reason: acknowledgementReason, actorUid: context.actorUid,
      payload: { device_id: device.id, device_tag: device.device_tag, usage_id: usageId, exposure_markers: device.exposure_markers, wasted: true },
    });
  }
  return updated;
}

// Overrides land on the clinical record through the platform safety-review
// vehicle (spec §7.5). `issue.type` becomes medication_safety_reviews.review_type
// and `issue.code` becomes finding_code — verified against
// canonicalClinicalPlatformService.recordMedicationSafetyReviews:1372.
async function recordReuseSafetyReview(tx, { tenantId, patientUid, encounterId, findingCode, message, reason, actorUid, payload }) {
  const rows = await recordMedicationSafetyReviews({
    tenantId,
    patientUid,
    encounterId,
    safety: {
      safe: false,
      blockers: [{ type: 'cath_device_reuse', code: findingCode, severity: 'high', message, ...payload }],
      warnings: [],
    },
    override: { reason, approvedBy: actorUid },
    actorUid,
  }, { db: tx });
  if (!rows.length) {
    throw AppError.internal('Cath device reuse safety review did not persist', 'CATH_DEVICE_SAFETY_REVIEW_FAILED');
  }
  return rows[0];
}

// ---------------------------------------------------------------------------
// Post-use: the return tap
// ---------------------------------------------------------------------------

async function lockUsageTx(tx, tenantId, caseId, usageId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT u.id, u.tenant_id, u.case_id, u.patient_uid, u.facility_id, u.catalog_item_id, u.quantity,
            u.wasted, u.device_id, u.reuse_cycle, u.post_use_disposition, u.metadata, u.used_at,
            c.category, c.is_implant, c.item_name
       FROM cath_case_consumable_usage u
       JOIN cath_consumable_catalog c ON c.id = u.catalog_item_id AND c.tenant_id = u.tenant_id
      WHERE u.tenant_id = $1::uuid AND u.case_id = $2::bigint AND u.id = $3::bigint
      FOR UPDATE OF u`,
    tenantOr(tenantId), positiveInt(caseId, 'case_id'), positiveInt(usageId, 'usage_id'),
  );
  const row = rows[0];
  if (!row) throw AppError.notFound('Cath consumable usage not found', 'CATH_CONSUMABLE_USAGE_NOT_FOUND');
  // quantity is NUMERIC — Prisma hands it back as a Decimal, and units_max is
  // computed from it, so normalise here rather than at every reader.
  return {
    ...row,
    id: num(row.id),
    case_id: num(row.case_id),
    catalog_item_id: num(row.catalog_item_id),
    quantity: num(row.quantity),
    device_id: row.device_id == null ? null : num(row.device_id),
  };
}

function dispositionCodeFor(disposition, discardReason) {
  if (disposition === 'reprocess') return 'sent_for_reprocessing';
  if (discardReason === 'bloodborne_exposure' || discardReason === 'late_reactive_marker') return 'discarded_bloodborne_exposure';
  if (discardReason === 'max_cycles_reached') return 'discarded_max_cycles';
  if (discardReason === 'wasted') return 'discarded_wasted';
  return 'discarded_other';
}

export async function recordPostUse(caseId, usageId, input = {}, context = {}) {
  const tid = tenantOr(input.tenantId ?? context.tenantId);
  const disposition = oneOf(input.disposition, ['reprocess', 'discard'], 'disposition', 'CATH_POST_USE_DISPOSITION_INVALID');
  const acknowledgement = cleanText(input.acknowledgement?.reason ?? input.acknowledgement_reason, 500);
  const requestedDiscardReason = input.discard_reason ? oneOf(input.discard_reason, DISCARD_REASONS, 'discard_reason', 'CATH_DEVICE_DISCARD_REASON_INVALID') : null;
  const discardNote = cleanText(input.discard_note, 2000);
  const idempotencyKey = cleanText(context.idempotencyKey, 200);
  const actor = requireUuid(context.actorUid, 'actorUid');

  return setTenantTx(tid, async (tx) => {
    const cathCase = await caseRowTx(tx, tid, caseId, { lock: true });
    const usage = await lockUsageTx(tx, tid, cathCase.id, usageId);

    // Replay of the same command returns the recorded result; a different
    // command on a dispositioned row is a conflict.
    if (usage.post_use_disposition) {
      const previous = usage.metadata?.post_use;
      if (previous && idempotencyKey && previous.idempotency_key === idempotencyKey) {
        return { ...previous.result, idempotent_replay: true };
      }
      throw AppError.conflict('Post-use disposition already recorded for this usage', 'CATH_POST_USE_ALREADY_RECORDED', { post_use_disposition: usage.post_use_disposition });
    }

    const settings = await getReprocessingSettings({ tenantId: tid, db: tx });
    const policy = await categoryPolicyTx(tx, tid, usage.category);
    const restriction = await resolveReuseStatus({ tenantId: tid, patientUid: cathCase.patient_uid, validityDays: settings.serology_validity_days, db: tx });
    const device = usage.device_id ? await lockDeviceTx(tx, tid, usage.device_id) : null;

    // CSSD can discard a device while it is still in the case: `discard`'s
    // from-list includes 'in_case', and the late-reactive sweep uses it. There
    // is then nothing left to transition — 'discarded' is terminal, so both
    // 'return' and 'discard' would 409 and the usage row would be stuck without
    // a disposition forever. Settle the row from the device's OWN discard
    // reason and return normally; the operator's requested disposition is moot
    // because the physical decision has already been taken.
    if (device && device.status === 'discarded') {
      const settledCode = device.discard_reason === 'bloodborne_exposure' || device.discard_reason === 'late_reactive_marker'
        ? 'discarded_bloodborne_exposure'
        : 'discarded_other';
      const settledResult = {
        usage_id: usage.id,
        case_id: cathCase.id,
        disposition: settledCode,
        units: null,
        devices: [normalizeDevice(device)],
        restriction_status: restriction.status,
        device_already_discarded: true,
      };
      await tx.$executeRawUnsafe(
        `UPDATE cath_case_consumable_usage
            SET post_use_disposition = $3,
                post_use_screen = $4::jsonb,
                metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::bigint`,
        tid, usage.id, settledCode, JSON.stringify(restriction),
        JSON.stringify({ post_use: { idempotency_key: idempotencyKey, acknowledgement: acknowledgement || null, actor_uid: actor, recorded_at: new Date().toISOString(), device_already_discarded: true, result: settledResult } }),
      );
      await recordDeviceAudit(tx, {
        tenantId: tid, action: 'cath_usage.post_use', resource: 'cath_case_consumable_usage', resourceId: usage.id,
        context, metadata: { disposition: settledCode, units: null, device_tags: [device.device_tag], restriction_status: restriction.status, device_already_discarded: true, device_discard_reason: device.discard_reason },
      });
      return settledResult;
    }

    const options = computePostUseOptions({ usage, category: usage.category, isImplant: Boolean(usage.is_implant), policy, settings, restriction, device });

    if (!options.dispositions.includes(disposition)) {
      if (options.blocked_code && disposition === 'reprocess') {
        throw AppError.conflict('Serology must be recorded before this device can be sent for reprocessing', options.blocked_code, { reasons: restriction.reasons });
      }
      if (options.reason_codes.includes('max_cycles_reached')) {
        throw AppError.conflict(`Device ${device.device_tag} has reached its maximum cycles; only discard is allowed`, 'CATH_DEVICE_MAX_CYCLES_REACHED');
      }
      if (options.reason_codes.includes('bloodborne_restricted')) {
        throw AppError.conflict('Patient is blood-borne restricted; only discard is allowed', 'CATH_DEVICE_EXPOSURE_BLOCKED', { reasons: restriction.reasons });
      }
      // Same block, different fact: the DEVICE carries the exposure flag (from
      // an earlier patient's late reactive result), so it must not be sent back
      // for reprocessing even when this patient screens clear.
      if (options.reason_codes.includes('device_exposure_flagged')) {
        throw AppError.conflict(`Device ${device.device_tag} carries a blood-borne exposure flag; only discard is allowed`, 'CATH_DEVICE_EXPOSURE_BLOCKED', { exposure_markers: device.exposure_markers, reasons: restriction.reasons });
      }
      throw AppError.conflict(`This usage cannot be ${disposition}ed`, 'CATH_REPROCESSING_NOT_ALLOWED', { reason_codes: options.reason_codes });
    }
    if (disposition === 'reprocess' && options.requires_acknowledgement && !acknowledgement) {
      throw AppError.badRequest('acknowledgement.reason is required for this post-use disposition', 'CATH_DEVICE_ACKNOWLEDGEMENT_REQUIRED', { reason_codes: options.reason_codes, reasons: restriction.reasons });
    }

    const exposureMarkers = options.exposure
      ? restriction.markers.filter((m) => m.result === 'reactive').map((m) => m.marker)
      : null;
    let devices = [];
    let discardReason = null;
    let units = null;

    if (disposition === 'reprocess') {
      if (device) {
        devices = [await applyDeviceTransitionTx(tx, device, 'return', {
          exposureFlag: options.exposure, exposureMarkers,
          metadata: acknowledgement ? { last_post_use_acknowledgement: acknowledgement } : {},
        }, context)];
      } else {
        units = input.units == null ? options.units_max : positiveInt(input.units, 'units');
        if (units > options.units_max) {
          throw AppError.badRequest(`units cannot exceed the recorded quantity (${options.units_max})`, 'CATH_DEVICE_UNITS_EXCEED_QUANTITY');
        }
        // Checked AFTER the quantity bound and against the resolved value, so
        // an omitted `units` that defaults to an absurd units_max is refused
        // too — the loop below is what the cap actually protects.
        if (units > POST_USE_UNITS_CAP) {
          throw AppError.badRequest(`units cannot exceed ${POST_USE_UNITS_CAP} in one post-use record`, 'CATH_DEVICE_UNITS_CAP', { cap: POST_USE_UNITS_CAP, units_max: options.units_max });
        }
        const seedMarkers = exposureMarkers || [];
        for (let index = 1; index <= units; index += 1) {
          const created = await tx.$queryRawUnsafe(
            `INSERT INTO cath_reprocessable_devices
               (tenant_id, facility_id, catalog_item_id, origin_usage_id, origin_unit_index,
                cycle_count, max_cycles_snapshot, status, exposure_flag, exposure_markers, created_by, metadata)
             VALUES ($1::uuid, $2::int, $3::bigint, $4::bigint, $5::smallint,
                     0, $6::int, 'awaiting_reprocessing', $7, $8::text[], $9::uuid, $10::jsonb)
             RETURNING id`,
            tid, Number(cathCase.facility_id), usage.catalog_item_id, usage.id, index,
            policy.max_cycles, Boolean(options.exposure), seedMarkers, actor,
            JSON.stringify({ created_from: 'post_use', acknowledgement: acknowledgement || null }),
          );
          const minted = await lockDeviceTx(tx, tid, created[0].id);
          await recordDeviceAudit(tx, {
            tenantId: tid, action: 'cath_device.created', resource: 'cath_reprocessable_devices', resourceId: minted.id,
            context, metadata: { device_tag: minted.device_tag, origin_usage_id: usage.id, unit_index: index, max_cycles: policy.max_cycles, exposure: Boolean(options.exposure) },
          });
          devices.push(minted);
        }
      }
    } else {
      discardReason = options.discard_reason || requestedDiscardReason || 'other';
      if (device) {
        devices = [await applyDeviceTransitionTx(tx, device, 'discard', { discardReason, discardNote }, context)];
      }
    }

    const dispositionCode = dispositionCodeFor(disposition, discardReason);
    const result = {
      usage_id: usage.id,
      case_id: cathCase.id,
      disposition: dispositionCode,
      units,
      devices: devices.map(normalizeDevice),
      restriction_status: restriction.status,
    };
    // Spec §6.3 step 3: a first-use row of quantity N reprocessed as only M
    // units leaves N - M units unaccounted for. Record the shortfall on the row
    // itself — the devices minted above are the only other trace, and counting
    // their absence is not something a reader can do.
    const unitsNotReprocessed = units == null ? 0 : Math.max(0, Number(options.units_max) - Number(units));
    await tx.$executeRawUnsafe(
      `UPDATE cath_case_consumable_usage
          SET post_use_disposition = $3,
              post_use_screen = $4::jsonb,
              metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      tid, usage.id, dispositionCode, JSON.stringify(restriction),
      JSON.stringify({
        post_use: { idempotency_key: idempotencyKey, acknowledgement: acknowledgement || null, actor_uid: actor, recorded_at: new Date().toISOString(), result },
        ...(unitsNotReprocessed > 0 ? { units_not_reprocessed: unitsNotReprocessed } : {}),
      }),
    );
    if (acknowledgement) {
      await recordReuseSafetyReview(tx, {
        tenantId: tid, patientUid: cathCase.patient_uid, encounterId: cathCase.encounter_id,
        findingCode: options.exposure ? 'BLOODBORNE_RESTRICTED_OVERRIDE' : 'SEROLOGY_UNKNOWN_ACKNOWLEDGED',
        message: options.exposure
          ? `Device from a blood-borne restricted patient sent for reprocessing (${restriction.reasons.join('; ')})`
          : `Device sent for reprocessing with serology unknown (${restriction.reasons.join('; ')})`,
        reason: acknowledgement, actorUid: actor,
        payload: { usage_id: usage.id, case_id: cathCase.id, device_ids: devices.map((d) => d.id) },
      });
    }
    await recordDeviceAudit(tx, {
      tenantId: tid, action: 'cath_usage.post_use', resource: 'cath_case_consumable_usage', resourceId: usage.id,
      context, metadata: { disposition: dispositionCode, units, device_tags: devices.map((d) => d.device_tag), restriction_status: restriction.status },
    });
    return result;
  });
}

// ---------------------------------------------------------------------------
// Device history (PHI: lists the patients the device touched)
// ---------------------------------------------------------------------------

export async function deviceHistory({ tenantId, deviceId } = {}) {
  const tid = tenantOr(tenantId);
  const id = positiveInt(deviceId, 'device_id');
  return setTenant(tid, async (tx) => {
    const deviceRows = await tx.$queryRawUnsafe(`SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE d.tenant_id = $1::uuid AND d.id = $2::bigint LIMIT 1`, tid, id);
    if (!deviceRows[0]) throw AppError.notFound('Reprocessable device not found', 'CATH_DEVICE_NOT_FOUND');
    const uses = await tx.$queryRawUnsafe(
      `SELECT u.id AS usage_id, u.case_id, u.patient_uid, u.used_at, u.reuse_cycle, u.post_use_disposition,
              CASE WHEN u.id = $3::bigint THEN 'first_use' ELSE 'reuse' END AS kind
         FROM cath_case_consumable_usage u
        WHERE u.tenant_id = $1::uuid AND (u.device_id = $2::bigint OR u.id = $3::bigint)
        ORDER BY u.used_at ASC, u.id ASC`,
      tid, id, num(deviceRows[0].origin_usage_id),
    );
    const events = await tx.$queryRawUnsafe(
      // audit_logs.metadata is nullable and rows written by other writers can
      // leave it NULL; the published event schema declares metadata as a
      // required object, so coalesce here rather than emit a contract-invalid
      // null the generated clients reject.
      `SELECT action, actor_uid, COALESCE(metadata, '{}'::jsonb) AS metadata, created_at
         FROM audit_logs
        WHERE tenant_id = $1::uuid AND resource = 'cath_reprocessable_devices' AND resource_id = $2
        ORDER BY created_at ASC, id ASC`,
      tid, String(id),
    );
    return {
      device: normalizeDevice(deviceRows[0]),
      uses: uses.map((u) => ({ ...u, usage_id: num(u.usage_id), case_id: num(u.case_id) })),
      events,
    };
  });
}

// logPhiAccessBatch builds ONE jsonb_to_recordset INSERT and refuses more than
// 25 entries. A device late in its register life can have touched more than
// that; cap and warn rather than lose the whole batch to a TypeError.
export const DEVICE_HISTORY_PHI_BATCH_CAP = 25;

/**
 * One hipaa_access_log row per DISTINCT patient in a device history answer.
 *
 * Neither mount serving this read can produce that trail: the /api/v1/cath-lab
 * phiAccessLogger resolves a patient from the request and this request carries
 * none (so it writes patient_id = NULL), and the governance mount has no PHI
 * logger. Called by routes/clinical/cathDeviceHistoryHandler.js, which both
 * routers register — so the obligation exists once, here.
 */
export async function logDeviceHistoryAccess({ tenantId, deviceId, history, actor = {} } = {}) {
  const tid = tenantOr(tenantId);
  const uses = Array.isArray(history?.uses) ? history.uses : [];
  const patientUids = [...new Set(uses.map((use) => use?.patient_uid).filter(Boolean).map(String))];
  if (patientUids.length === 0) return { logged: 0, skipped: 0 };
  const capped = patientUids.slice(0, DEVICE_HISTORY_PHI_BATCH_CAP);
  const skipped = patientUids.length - capped.length;
  if (skipped > 0) {
    logger.warn(
      `Cath device history for device ${deviceId} spans ${patientUids.length} patients; only the first ${DEVICE_HISTORY_PHI_BATCH_CAP} were access-logged`,
      { tenantId: tid, deviceId, patientCount: patientUids.length, loggedCount: capped.length },
    );
  }
  // hipaa_access_log has no resource column, and request_id is its only free
  // text correlation field (varchar(80)) — so the device the read was ABOUT
  // rides there next to the request id. Without it the rows say only that
  // someone read CATH_LAB for N patients and lose what tied them together.
  const requestId = `${actor.requestId ? `${actor.requestId} ` : ''}cath_device:${deviceId}`.slice(0, 80);
  const entries = capped.map((patientUid) => ({
    userId: actor.actorUid || null,
    userRole: actor.actorRole || null,
    patientId: patientUid,
    recordType: 'CATH_LAB',
    action: 'VIEW',
    ip: actor.ipAddress || null,
    requestId,
    tenantId: tid,
  }));
  try {
    await setTenant(tid, (db) => logPhiAccessBatch(entries, { db }));
  } catch (err) {
    // The read itself succeeded and the caller is entitled to it; losing the
    // audit is the thing that must not happen. logPhiAccess is fire-and-forget
    // with its own durable file fallback.
    logger.error(`Cath device history PHI access batch failed: ${err?.message}`, { tenantId: tid, deviceId });
    for (const entry of entries) logPhiAccess(entry);
  }
  return { logged: entries.length, skipped };
}

// Device state for the capture sheet. Case-pinned like the catalogue reads:
// a device from another facility is reported as not found, never described.
export async function deviceForCaseLookup({ tenantId, caseId, tag } = {}) {
  const tid = tenantOr(tenantId);
  return setTenant(tid, async (tx) => {
    const cathCase = await caseRowTx(tx, tid, caseId);
    const device = await deviceByTag({ tenantId: tid, tag, db: tx });
    if (!device || device.facility_id !== Number(cathCase.facility_id)) {
      throw AppError.notFound('Reprocessable device not found', 'CATH_DEVICE_NOT_FOUND');
    }
    const policy = await categoryPolicyTx(tx, tid, device.category);
    const settings = await getReprocessingSettings({ tenantId: tid, db: tx });
    return {
      device,
      reprocessable: Boolean(policy?.reprocessable),
      cycles_remaining: Math.max(0, device.max_cycles_snapshot - device.cycle_count),
      exposure_rule: settings.reactive_patient_rule,
      requires_acknowledgement: device.exposure_flag && settings.reactive_patient_rule === 'override_allowed',
      blocked: device.exposure_flag && settings.reactive_patient_rule === 'discard',
    };
  });
}

// ---------------------------------------------------------------------------
// Late reactive result: quarantine in-flight devices and alert infection control
// ---------------------------------------------------------------------------

async function flagDeviceExposureTx(tx, device, event, context) {
  const markers = [event.marker];
  await tx.$executeRawUnsafe(
    `UPDATE cath_reprocessable_devices
        SET exposure_flag = TRUE,
            exposure_markers = ARRAY(SELECT DISTINCT m FROM unnest(exposure_markers || $3::text[]) AS m ORDER BY m),
            metadata = metadata || $4::jsonb,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::bigint`,
    device.tenant_id, device.id, markers, JSON.stringify({ late_reactive_marker_row_id: event.markerRowId }),
  );
  await recordDeviceAudit(tx, {
    tenantId: device.tenant_id, action: 'cath_device.exposure_flagged', resource: 'cath_reprocessable_devices', resourceId: device.id,
    context, metadata: { marker: event.marker, tested_on: event.testedOn, status: device.status },
  });
}

export async function quarantineDevicesExposedToPatient(event) {
  const tid = tenantOr(event.tenantId);
  const marker = oneOf(event.marker, MARKERS, 'marker', 'CATH_DEVICE_EXPOSURE_MARKER_INVALID');
  const settings = await getReprocessingSettings({ tenantId: tid });
  // CJD is not a serology window question: prion contamination has no decay, so
  // the sweep looks back over the whole register rather than the window.
  const lookbackDays = marker === 'cjd_suspected' ? 36500 : settings.serology_validity_days;
  // The system actor is the one caller allowed to hold a null actorUid — see
  // the note on applyDeviceTransitionTx.
  const context = { actorUid: null, actorRole: 'SYSTEM' };
  const patientUid = requireUuid(event.patientUid, 'patientUid');
  // Candidates are selected in their own read, then each device is handled in
  // its OWN transaction. One device that cannot be quarantined — a status race,
  // a lock timeout, a constraint — must not roll back the ones that already
  // succeeded: this sweep is the platform's response to a reactive result, and
  // losing nine quarantines because the tenth failed is the worst outcome
  // available. ORDER BY d.id makes the sweep deterministic, so a partial
  // failure is reproducible and the failed list is stable.
  const candidates = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT DISTINCT d.id
       FROM cath_reprocessable_devices d
       JOIN cath_case_consumable_usage u
         ON u.tenant_id = d.tenant_id AND (u.id = d.origin_usage_id OR u.device_id = d.id)
      WHERE d.tenant_id = $1::uuid
        AND u.patient_uid = $2::uuid
        AND d.status <> 'discarded'
        -- used_at is TIMESTAMPTZ and tested_on is a bare date. Subtracting the
        -- window from the date yields a plain timestamp with no zone, which
        -- Postgres would coerce using the SESSION TimeZone — UTC on the server,
        -- so the boundary would sit 5h30m off the clinical day. Pin it to
        -- Asia/Kolkata, the same zone every other cath date window uses.
        AND u.used_at >= (($3::date - ($4::int * INTERVAL '1 day'))::timestamp AT TIME ZONE 'Asia/Kolkata')
      ORDER BY d.id`,
    tid, patientUid, event.testedOn, lookbackDays,
  ));
  const affected = [];
  const failed = [];
  const markers = [marker];
  for (const { id } of candidates) {
    try {
      const settled = await setTenantTx(tid, async (tx) => {
        const device = await lockDeviceTx(tx, tid, id);
        // Re-checked under the lock, not only in the candidate SELECT: CSSD may
        // have discarded it between the read and this transaction, and
        // 'discarded' is terminal — quarantine would 409 and flagging a scrapped
        // device tells nobody anything.
        if (device.status === 'discarded') return null;
        // A device already in a case, or already held, cannot take the quarantine
        // transition — flag the exposure on it instead so the marker is never lost.
        if (device.status === 'in_case' || device.status === 'quarantined') {
          await flagDeviceExposureTx(tx, device, { ...event, marker }, context);
          return lockDeviceTx(tx, tid, id);
        }
        return applyDeviceTransitionTx(tx, device, 'quarantine', {
          exposureFlag: true, exposureMarkers: markers,
          quarantineReason: `Late reactive ${marker} result dated ${event.testedOn}`,
          metadata: { late_reactive_marker_row_id: event.markerRowId },
        }, context);
      });
      if (settled) affected.push(settled);
    } catch (err) {
      failed.push({ device_id: num(id), error: err?.message || String(err) });
      logger.error(
        `Late-reactive device sweep failed for device ${num(id)}: ${err?.message}`,
        { tenantId: tid, deviceId: num(id), marker, markerRowId: event.markerRowId },
      );
    }
  }
  // The alert and the outbox are still raised for the devices that DID settle:
  // a partial sweep that infection control never hears about is a silent one.
  if (affected.length === 0) return { affected: [], failed };

  const tags = affected.map((d) => d.device_tag).join(', ');
  try {
    await persistCdsAlert({
      patientUid: event.patientUid,
      encounterId: null,
      alertType: 'bloodborne_reuse_exposure',
      severity: 'high',
      title: 'Reprocessable devices exposed to a reactive blood-borne marker',
      description: `Devices ${tags} were used on this patient and are now quarantined or flagged after a reactive ${marker} result dated ${event.testedOn}.`,
      sourceData: { marker, tested_on: event.testedOn, device_ids: affected.map((d) => d.id), marker_row_id: event.markerRowId },
    });
  } catch (err) {
    logger.error(`CDS alert for blood-borne reuse exposure failed: ${err?.message}`, { tenantId: tid });
  }
  try {
    const officers = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
      `SELECT id, uid FROM users
        WHERE tenant_id = $1::uuid AND role = 'INFECTION_CONTROL_OFFICER'
          AND is_active = TRUE AND status = 'active' AND COALESCE(is_deleted, FALSE) = FALSE`,
      tid,
    ));
    for (const officer of officers) {
      await notificationOutbox.queue({
        tenantId: tid,
        type: 'bloodborne_reuse_exposure',
        channel: 'inapp',
        recipientId: officer.id,
        recipientPhone: null,
        title: 'Reprocessable devices quarantined after a reactive result',
        body: `Devices ${tags}: reactive ${marker} result dated ${event.testedOn}. Review the CSSD device queue.`,
        sourceEventKey: `bloodborne-reuse-exposure:${event.markerRowId}:${officer.uid}`,
        templateVersion: 'bloodborne-reuse-exposure.v1',
        data: { kind: 'bloodborne_reuse_exposure', marker, tested_on: event.testedOn, device_ids: affected.map((d) => d.id), deep_link: '/dashboard/cssd?tab=devices' },
      }, { strict: false });
    }
  } catch (err) {
    logger.error(`Infection-control notification for blood-borne reuse exposure failed: ${err?.message}`, { tenantId: tid });
  }
  return { affected: affected.map(normalizeDevice), failed };
}

// Registered at module load: bloodborneMarkerService.notifyExposureHandlers
// awaits every handler AFTER the marker transaction commits, so a reactive row
// recorded anywhere in the platform sweeps the device register here.
registerExposureHandler(quarantineDevicesExposedToPatient);
