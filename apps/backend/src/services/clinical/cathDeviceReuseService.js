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

import { setTenant, setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { DEFAULT_VALIDITY_DAYS, MARKERS } from './bloodborneMarkerService.js';

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
  const n = Number(value);
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
  const actor = requireUuid(context.actorUid, 'actorUid');
  const validated = policies.map(validatePolicyInput);
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
    metadata: { device_tag: device.device_tag, from: device.status, to, cycle_count_before: device.cycle_count, discard_reason: discardReason, quarantine_reason: cleanText(patch.quarantineReason, 500), note: cleanText(patch.discardNote ?? patch.note, 500) } });
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
