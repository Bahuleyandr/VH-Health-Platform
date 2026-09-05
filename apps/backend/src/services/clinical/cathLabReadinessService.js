// apps/backend/src/services/clinical/cathLabReadinessService.js
//
// Pre-procedure lab readiness for cath cases. Spec:
// docs/superpowers/specs/2026-09-04-cath-pre-procedure-lab-readiness-design.md
//
// Seven items under the existing `labs` readiness check, resolved from
// lab_results, open investigations/bookings and lab_specimens. Automation
// passes the check on availability and flips it back only if it set it; a
// critical value warns and never blocks (owner decision).
//
// Cycles. This module imports labResultsService (for recordExternalLabResultRow,
// the outside-lab entry point) and orderService (to place the missing orders).
// Only labResultsService reaches back to the readiness refresh, and it does so
// through a DYNAMIC import of refreshOpenCasesForPatient, never a static one;
// orderService does not reach back at all. cathLabService imports THIS module
// for getCase, so this module must not import cathLabService — which is why the
// readiness gate recompute is inlined below (recomputeCaseStatusTx) rather than
// borrowed from cathLabService.evaluateReadinessGate.

import { createHash } from 'node:crypto';

import { setTenant, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { epochMsOrNull } from '../../utils/dbInstant.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { createInvestigationOrder } from '../investigation/orderService.js';
import { recordExternalLabResultRow } from '../lab/labResultsService.js';
import {
  BLOODBORNE_MARKER_ITEM_CODES,
  LAB_ANALYTE_ITEMS,
  LAB_ANALYTE_ITEM_CODES,
  analyteItemForResult,
  orderCodesCovering,
} from '../lab/labAnalyteCodes.js';
import { recordMarkers } from './bloodborneMarkerService.js';
import { clinicalDate, normalizeSerologyValue } from './bloodborneMarkerRules.js';

export const ITEM_CODES = LAB_ANALYTE_ITEM_CODES;
export const ITEM_STATES = Object.freeze([
  'result_final', 'result_preliminary', 'external_recorded', 'sample_sent_awaiting_result',
  'ordered_awaiting_sample', 'not_ordered', 'stale', 'waived',
]);
// Migration 766's cath_case_lab_readiness_items_source_check vocabulary, in the
// order the constraint spells it. Pinned by cathLabReadinessMigration.test.js.
export const ITEM_SOURCES = Object.freeze(['lab_result', 'external', 'waiver']);
export const AVAILABLE_STATES = Object.freeze(['result_final', 'result_preliminary', 'waived']);
export const SETTINGS_DEFAULTS = Object.freeze({
  required_items: [...ITEM_CODES],
  lab_validity_days: 30,
  auto_pass: true,
  external_results_count: true,
});
export const DEFAULT_SEROLOGY_VALIDITY_DAYS = 90;

const SIGNED_STATUSES = new Set(['final', 'corrected', 'amended', 'verified']);
const OPEN_ORDER_STATUSES_EXCLUDED = new Set(['COMPLETED', 'CANCELLED']);
const SPECIMEN_SENT_STATES = new Set(['collected', 'in_transit', 'received', 'processing']);
const CRITICAL_FLAGS = new Set(['HH', 'LL', 'AA']);

export function isCriticalResult(row) {
  return Boolean(row?.is_critical) || CRITICAL_FLAGS.has(String(row?.abnormal_flag || '').toUpperCase());
}

const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Milliseconds since the epoch from anything a row can carry here: an epoch-ms
// twin (the driver hands `::bigint` back as a BigInt), a driver-materialised
// Date, an ISO string, or a plain number. NaN for everything else — every
// caller tests with Number.isFinite, never with truthiness, because 0 is a
// legitimate (if absurd) instant and `Number(null)` is also 0.
function toMs(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : NaN;
}

// The house rule for an instant that will be compared against the process
// clock: read the `<column>_epoch_ms` twin the query selects beside the column
// (src/utils/dbInstant.js, scripts/check-timestamptz-clock-comparisons.mjs),
// never the driver-materialised Date, which the pg driver shifts by the
// DATABASE SESSION timezone. The Date stays as the fallback so this pure
// resolver still works on the plain ISO rows the unit tests hand it, and on any
// caller that has not added the twin to its SELECT yet.
function instantMs(row, field) {
  const twin = epochMsOrNull(row?.[`${field}_epoch_ms`]);
  return twin == null ? toMs(row?.[field]) : twin;
}

// lab_results.external_reported_on is the day the OUTSIDE laboratory reported
// the value; performed_at on such a row is only when somebody keyed it in here,
// which can be months later. A DATE carries no time zone, so a string form is
// read as IST midnight — the ward's day, the convention clinicalDate() uses.
function externalReportedMs(value) {
  if (value === null || value === undefined) return NaN;
  if (value instanceof Date) return toMs(value);
  const text = String(value).trim();
  return ISO_DATE.test(text) ? toMs(`${text}T00:00:00+05:30`) : NaN;
}

// When the value became true of the patient, as an absolute instant.
function observedMs(row) {
  if (row?.result_origin === 'external_lab') {
    const reported = externalReportedMs(row.external_reported_on);
    if (Number.isFinite(reported)) return reported;
  }
  const performed = instantMs(row, 'performed_at');
  return Number.isFinite(performed) ? performed : instantMs(row, 'received_at');
}

// observed_at / ordered_at land in TIMESTAMPTZ columns, so they are written
// from the epoch value — a true instant — rather than from whatever shape
// (naive timestamp, DATE, driver Date) the source row happened to carry.
function msToIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Fresh means IN THE PAST and no older than the window. The lower bound is the
// point: a future-dated row is not evidence of anything, so it can never be
// fresh, and sortMs ranks it last so it never outranks a real value either. A
// lone future-dated result therefore resolves as `stale` — it is the latest but
// not fresh — which is the restrictive direction. Open orders inherit the same
// bound; a future-dated order is dropped and the item reads not_ordered rather
// than ordered_awaiting_sample, and the check counts both as missing.
function withinWindow(value, asOf, windowDays) {
  const ms = toMs(value);
  const age = toMs(asOf) - ms;
  return Number.isFinite(ms) && age >= 0 && age <= windowDays * MS_PER_DAY;
}

// Most-recent-first, ties broken on id descending. Ranks are COMPARED, never
// subtracted, because an unusable rank is -Infinity and `-Infinity - -Infinity`
// is NaN — a comparator that returns NaN silently leaves the array unsorted.
// The id tiebreak follows the same rule: a booking-derived open order carries
// no investigations row and therefore no `id`, and `Number(null) - Number(null)`
// would be NaN too.
function rankBy(msOf) {
  const idRank = (row) => {
    const n = Number(row?.id);
    return Number.isFinite(n) ? n : -Infinity;
  };
  return (a, b) => {
    const am = msOf(a);
    const bm = msOf(b);
    if (am !== bm) return bm - am;
    const ai = idRank(a);
    const bi = idRank(b);
    if (ai === bi) return 0;
    return ai < bi ? 1 : -1;
  };
}

// The evidence copied off a lab_results row onto the item.
function resultFields(row) {
  return {
    value_text: row.value_text ?? null,
    value_numeric: row.value_numeric == null ? null : Number(row.value_numeric),
    unit: row.unit ?? null,
    abnormal_flag: row.abnormal_flag ?? null,
    is_critical: isCriticalResult(row),
    observed_at: msToIso(observedMs(row)),
    source: row.result_origin === 'external_lab' ? 'external' : 'lab_result',
    lab_result_id: Number(row.id),
  };
}

function matchesItem(item, row) {
  return analyteItemForResult(row) === item;
}

function orderCoversItem(item, order) {
  const code = String(order.test_code || '').trim().toUpperCase();
  return LAB_ANALYTE_ITEMS[item].orderCodes.includes(code);
}

// One item's state from the patient's rows. Pure; the caller fetches rows.
export function resolveItemState({
  item,
  results = [],
  orders = [],
  specimens = [],
  waiver = null,
  windowDays,
  asOf = new Date(),
}) {
  const base = {
    item_code: item, state: 'not_ordered', value_text: null, value_numeric: null, unit: null,
    abnormal_flag: null, is_critical: false, observed_at: null, source: null, lab_result_id: null,
    investigation_id: null, specimen_id: null, ordered_at: null,
    // Present, and null, on EVERY item rather than only on waived ones: the
    // refresh builds its UPSERT straight from this object, so a lifted waiver
    // has to arrive as three explicit NULLs or the old waiver survives the
    // rewrite and the row still names a person who cleared nothing.
    waived_by: null, waived_at: null, waive_reason: null,
  };
  const asOfMs = toMs(asOf);
  // A row whose instant is unusable OR in the future ranks last, so it never
  // outranks a real value; ties then break on id descending.
  const rankResult = (row) => {
    const ms = observedMs(row);
    return Number.isFinite(ms) && ms <= asOfMs ? ms : -Infinity;
  };
  const rankOrder = (row) => {
    const ms = instantMs(row, 'requested_at');
    return Number.isFinite(ms) && ms <= asOfMs ? ms : -Infinity;
  };

  // The `cancelled` filter is defensive rather than observed: no writer produces
  // that status today — the HL7 ingest collapses OBX-11 X/W/D to 'preliminary'
  // upstream, so a retracted outside value arrives here as a preliminary one.
  // Follow-up: carry the retraction through the ingest, then this starts firing.
  const candidates = results
    .filter((row) => matchesItem(item, row) && String(row.status || '').toLowerCase() !== 'cancelled')
    .sort(rankBy(rankResult));
  const latest = candidates[0] || null;
  const latestFresh = latest && withinWindow(observedMs(latest), asOf, windowDays) ? latest : null;

  // Open orders are resolved BEFORE the result branch, not instead of it: a
  // repeat draw already in flight stays visible on the item even when a fresh
  // result has answered it, so nobody is told to order what is already ordered.
  // `booking_id` reaches here from the caller's LEFT JOIN with
  // investigation_bookings — the investigations table carries no such column.
  const openOrders = orders
    .filter((order) => orderCoversItem(item, order)
      && !OPEN_ORDER_STATUSES_EXCLUDED.has(String(order.status || '').toUpperCase())
      && withinWindow(instantMs(order, 'requested_at'), asOf, windowDays))
    .sort(rankBy(rankOrder));
  const openOrder = openOrders[0] || null;
  // Deterministic by id — the highest is the latest draw for that booking. The
  // caller's ORDER BY is not a contract this pure function may lean on.
  const specimen = openOrder && openOrder.booking_id != null
    ? specimens
      .filter((row) => Number(row.booking_id) === Number(openOrder.booking_id))
      .sort((a, b) => Number(b.id) - Number(a.id))[0] || null
    : null;
  const orderPointer = openOrder
    ? {
      // A booking with no investigations row IS an open order (spec §7 step 2)
      // but has no investigation to point at: null, never Number(null) === 0,
      // which would fail the item schema's `minimum: 1` and bind a 0 the FK
      // could never satisfy.
      investigation_id: openOrder.id == null ? null : Number(openOrder.id),
      specimen_id: specimen ? Number(specimen.id) : null,
      ordered_at: msToIso(instantMs(openOrder, 'requested_at')),
    }
    : {};

  let resolved;
  if (latestFresh) {
    const status = String(latestFresh.status || '').toLowerCase();
    const signed = SIGNED_STATUSES.has(status)
      && Number.isFinite(instantMs(latestFresh, 'signed_off_at'));
    // The result decides the state; the in-flight order only adds its pointers.
    resolved = {
      ...base,
      ...resultFields(latestFresh),
      state: latestFresh.result_origin === 'external_lab'
        ? 'external_recorded'
        : (signed ? 'result_final' : 'result_preliminary'),
      ...orderPointer,
    };
  } else if (openOrder) {
    const sent = specimen
      ? SPECIMEN_SENT_STATES.has(String(specimen.status || '').toLowerCase())
      : Number.isFinite(instantMs(openOrder, 'collected_at'));
    resolved = {
      ...base,
      state: sent ? 'sample_sent_awaiting_result' : 'ordered_awaiting_sample',
      ...orderPointer,
    };
  } else if (latest) {
    resolved = { ...base, ...resultFields(latest), state: 'stale' };
  } else {
    resolved = base;
  }

  if (!waiver) return resolved;
  // Migration 766's cath_case_lab_readiness_items_waiver_check requires all
  // three of who/when/why on any row in state 'waived'. Refusing here turns a
  // 23514 raised in the middle of a cath-case read into a 400 that names the
  // gap; waiveLabItem always supplies them, so this is the corrupt-row path.
  if (!waiver.waived_by || !waiver.waived_at || !waiver.waive_reason) {
    throw AppError.badRequest(
      'a waived lab item needs waived_by, waived_at and waive_reason',
      'CATH_LAB_READINESS_VALUE_INVALID',
    );
  }
  // A waiver decides the STATE, not the evidence: the value that prompted it
  // stays on the item, so a waived potassium of 6.9 still raises the critical
  // warning the operator standing at the table needs to see.
  return {
    ...resolved,
    state: 'waived',
    source: 'waiver',
    waived_by: waiver.waived_by,
    waived_at: waiver.waived_at,
    waive_reason: waiver.waive_reason,
  };
}

// The human-readable "why is this still pending" line. Derived from `missing`
// on EVERY pass, never carried forward: the reason is a statement about the
// items as they stand now, and a stored one goes stale the moment a sample is
// drawn (see the refresh, which recomputes it while the check stays
// auto-pending).
export function pendingReasonFor(missing = []) {
  if (!missing.length) return null;
  return missing.map((row) => `${row.item} ${String(row.state).replace(/_/g, ' ')}`).join('; ');
}

function isAvailable(item, settings) {
  if (AVAILABLE_STATES.includes(item.state)) return true;
  return item.state === 'external_recorded' && settings.external_results_count === true;
}

// What automation may do to the `labs` check row given the items.
// nextStatus: 'pass' | 'pending' | null (leave the row alone).
export function computeCheckDecision({ items, settings, check, caseRow }) {
  const required = items.filter((item) => item.required !== false);
  const missing = required.filter((item) => !isAvailable(item, settings)).map((item) => ({ item: item.item_code, state: item.state }));
  // Criticality is read across ALL items — required or not, waived or not.
  // `missing` is the gate and stays required-only; this is the WARNING, and a
  // potassium of 6.9 is a potassium of 6.9 whether the team waived the item or
  // never required it. resolveItemState leaves the value on a waived item for
  // exactly this reason.
  const criticalItems = items.filter((item) => isCriticalResult(item)).map((item) => item.item_code);
  const autoManaged = check?.metadata?.auto_managed === true;
  const status = String(check?.status || 'pending').toLowerCase();
  const started = Boolean(caseRow?.actual_start_at);
  let nextStatus = null;
  let autoPendingReason = null;
  // `!started` on BOTH branches: automation asserts readiness only while the
  // assertion can still change what happens. Opening an in_progress/completed
  // case would otherwise re-run this and flip a pending labs check to pass with
  // completed_at = NOW() — a readiness claim stamped after the procedure it was
  // supposed to gate, plus an auto_pass audit row to match. Once the case is on
  // the table the row is history: leave it exactly as the team left it.
  if (missing.length === 0 && !started) {
    if (settings.auto_pass === true && (status === 'pending' || (status === 'pass' && autoManaged))) {
      nextStatus = status === 'pass' ? null : 'pass';
    }
  } else if (status === 'pass' && autoManaged && !started) {
    // Deliberately not gated on settings.auto_pass: turning auto-pass off stops
    // automation making NEW assertions, but retracting one it already made is a
    // correction, and it moves the gate in the restrictive direction.
    nextStatus = 'pending';
    autoPendingReason = pendingReasonFor(missing);
  }
  return { nextStatus, criticalWarning: criticalItems.length > 0, criticalItems, missing, autoPendingReason };
}

// ---------------------------------------------------------------------------
// Shared validation and small helpers
//
// Every raw parameter below is bound and cast; nothing is interpolated into a
// statement. positiveInt is deliberately stricter than Number(): '12abc',
// ' 12 ' and '1e3' all become 12/1000 under Number and would then be bound to
// a ::bigint the caller never wrote.
// ---------------------------------------------------------------------------

const POSTGRES_INT4_MAX = 2_147_483_647;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const tenantOr = (value) => requireTenantId(value);

function requireUuid(value, label) {
  const text = String(value ?? '').trim();
  if (!UUID_PATTERN.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'CATH_LAB_BAD_UUID');
  }
  return text.toLowerCase();
}

function positiveInt(value, label, max = Number.MAX_SAFE_INTEGER) {
  const text = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(text)) {
    throw AppError.badRequest(`${label} must be a positive integer`, 'CATH_LAB_BAD_ID');
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n <= 0 || n > max) {
    throw AppError.badRequest(`${label} must be a positive integer`, 'CATH_LAB_BAD_ID');
  }
  return n;
}

// A lab_results / investigations / lab_specimens id copied onto a readiness
// item. These columns are int4 in both directions; a value that would not
// survive the ::int cast is dropped rather than bound, because the pointer is
// an optimisation (the refresh recomputes the item regardless) and a 22003 in
// the middle of a cath-case read is not.
function int4OrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0 || n > POSTGRES_INT4_MAX) return null;
  return n;
}

function cleanText(value, max = 2000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function num(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value?.toNumber === 'function') return value.toNumber();
  return value;
}

// A quantitative outside value, or null. Deliberately NOT Number(): `Number`
// turns null, '', [] and false into 0 and true into 1, so a request that named
// no value at all used to be stored as a creatinine of 0 — a value that reads
// as normal and passes the gate. Only an explicit finite number, or a plain
// decimal string, is a value here.
const DECIMAL_TEXT = /^\d+(\.\d+)?$/;
function numericValueOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && DECIMAL_TEXT.test(value.trim())) return Number(value.trim());
  return null;
}

// lab_results.value_numeric and the readiness item's copy of it are both
// NUMERIC(15, 4) -- eleven digits ahead of the point, so anything from 1e11 up
// does not fit the column. Postgres raises that as 22003 halfway through the
// insert, which reaches the ward as a 500 naming no field at all. The COLUMN's
// bound is therefore stated here, where the answer is a 400 that names it.
const VALUE_NUMERIC_EXCLUSIVE_MAX = 1e11;

// The quantitative value an outside entry is filing, or a 400. Exported so the
// rule can be pinned on its own: it is the difference between "no value was
// sent" and "a creatinine of 0 was sent", and the second reads as normal.
export function externalNumericValue(rawNumeric, rawText) {
  const value = numericValueOrNull(rawNumeric) ?? numericValueOrNull(rawText);
  if (
    value === null
    || !Number.isFinite(value)
    || value < 0
    || value >= VALUE_NUMERIC_EXCLUSIVE_MAX
  ) {
    throw AppError.badRequest(
      'value_numeric must be a non-negative number below 1e11 (NUMERIC(15, 4))',
      'CATH_LAB_READINESS_VALUE_INVALID',
    );
  }
  return value;
}

// A real calendar day, not merely ten characters shaped like one: the regex
// alone accepts 2026-13-45, which then raises 22008 on the ::date cast in the
// middle of the write and surfaces as a 500. Round-tripping through Date.UTC
// is what rejects an overflowed month or day here, as a 400.
function isCalendarDate(text) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!parts) return false;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  return roundTrip.getUTCFullYear() === year
    && roundTrip.getUTCMonth() === month - 1
    && roundTrip.getUTCDate() === day;
}

// Structural equality for the JSON the check row already carries. Key ORDER is
// not compared: `metadata` comes back out of jsonb, which does not preserve the
// order the object was written in, so JSON.stringify on both sides would report
// every read as a change and defeat the write-once rule below.
function deepEqual(left, right) {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((item, i) => deepEqual(item, right[i]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

function withTenant(tenantId, db, fn) {
  return db ? fn(db) : setTenant(tenantId, fn);
}

// audit_logs shape mirrors cssdService.js:208 — (tenant_id, uid, role, action,
// resource, resource_id, metadata, actor_uid, created_at). `role` is
// VARCHAR(50) and `action`/`resource`/`resource_id` are VARCHAR(100).
async function recordReadinessAudit(tx, {
  tenantId, action, resource, resourceId, context = {}, metadata = {},
}) {
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs
       (tenant_id, uid, role, action, resource, resource_id, metadata, actor_uid, created_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $2::uuid, NOW())`,
    tenantId,
    context.actorUid ? requireUuid(context.actorUid, 'actorUid') : null,
    cleanText(context.actorRole, 50),
    cleanText(action, 100),
    cleanText(resource, 100),
    cleanText(String(resourceId), 100),
    JSON.stringify(metadata ?? {}),
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SETTINGS_SELECT = 'tenant_id, required_items, lab_validity_days, auto_pass, '
  + 'external_results_count, updated_by, created_at, updated_at';

export async function getReadinessSettings({ tenantId, db = null } = {}) {
  const tid = tenantOr(tenantId);
  const rows = await withTenant(tid, db, (client) => client.$queryRawUnsafe(
    `SELECT ${SETTINGS_SELECT}
       FROM cath_lab_readiness_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    tid,
  ));
  const row = rows[0];
  if (!row) {
    return {
      tenant_id: tid,
      ...SETTINGS_DEFAULTS,
      required_items: [...SETTINGS_DEFAULTS.required_items],
      configured: false,
    };
  }
  return {
    ...row,
    lab_validity_days: Number(row.lab_validity_days),
    required_items: Array.isArray(row.required_items) ? row.required_items : [],
    configured: true,
  };
}

export async function upsertReadinessSettings(input = {}, context = {}) {
  const tid = tenantOr(input.tenantId);
  const supplied = Array.isArray(input.required_items)
    ? input.required_items.map((code) => String(code ?? '').trim().toLowerCase())
    : null;
  // An explicitly empty set is a 400, not a database error: migration 766's
  // cath_lab_readiness_settings_items_check requires at least one item, and a
  // 23514 surfacing as a 500 tells the tenant administrator nothing.
  if (supplied && supplied.length === 0) {
    throw AppError.badRequest(
      'required_items must name at least one item; mark the labs check not required on the case instead',
      'CATH_LAB_READINESS_ITEMS_EMPTY',
    );
  }
  const requiredItems = [...new Set(supplied ?? [...SETTINGS_DEFAULTS.required_items])];
  if (requiredItems.some((code) => !ITEM_CODES.includes(code))) {
    throw AppError.badRequest(
      `required_items must be within ${ITEM_CODES.join(', ')}`,
      'CATH_LAB_READINESS_ITEM_UNKNOWN',
    );
  }
  const validity = positiveInt(
    input.lab_validity_days ?? SETTINGS_DEFAULTS.lab_validity_days,
    'lab_validity_days',
    365,
  );
  const autoPass = input.auto_pass === undefined ? true : Boolean(input.auto_pass);
  const externalCount = input.external_results_count === undefined
    ? true
    : Boolean(input.external_results_count);
  const actor = requireUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_lab_readiness_settings
         (tenant_id, required_items, lab_validity_days, auto_pass, external_results_count, updated_by)
       VALUES ($1::uuid, $2::text[], $3::int, $4::boolean, $5::boolean, $6::uuid)
       ON CONFLICT (tenant_id) DO UPDATE SET
         required_items = EXCLUDED.required_items,
         lab_validity_days = EXCLUDED.lab_validity_days,
         auto_pass = EXCLUDED.auto_pass,
         external_results_count = EXCLUDED.external_results_count,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING ${SETTINGS_SELECT}`,
      tid, requiredItems, validity, autoPass, externalCount, actor,
    );
    await recordReadinessAudit(tx, {
      tenantId: tid,
      action: 'CATH_LAB_READINESS_SETTINGS_UPDATED',
      resource: 'cath_lab_readiness_settings',
      resourceId: tid,
      context,
      metadata: {
        required_items: requiredItems,
        lab_validity_days: validity,
        auto_pass: autoPass,
        external_results_count: externalCount,
      },
    });
    return {
      ...rows[0],
      lab_validity_days: Number(rows[0].lab_validity_days),
      configured: true,
    };
  });
}

// The serology window is the reuse programme's (migration 765), not a second
// number this feature invents: a tenant that shortened HIV/HBsAg/HCV validity
// for device reuse means the same thing here. A tenant that has never saved one
// falls back to the compiled-in default.
//
// No 42P01 guard: migration 765 creates cath_reprocessing_settings and ships in
// this same branch, so the table is always there — and a 42P01 raised inside the
// refresh transaction has already aborted it, so catching it here would only
// swap the honest error for a 25P02 on the next statement.
async function serologyValidityDays(tenantId, db) {
  const rows = await db.$queryRawUnsafe(
    `SELECT serology_validity_days
       FROM cath_reprocessing_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    tenantId,
  );
  return rows[0] ? Number(rows[0].serology_validity_days) : DEFAULT_SEROLOGY_VALIDITY_DAYS;
}

// ---------------------------------------------------------------------------
// Refresh: resolve the seven items, persist them, apply the check-level rule
// ---------------------------------------------------------------------------

// `lock`: false, 'update' or 'no key update'. Identifier-free — the clause is
// chosen from this closed map, never interpolated from an argument.
const CASE_LOCK_CLAUSES = Object.freeze({
  update: 'FOR UPDATE',
  // The refresh's lock. It still conflicts with the FOR UPDATE every other cath
  // writer takes on the case row, so two refreshes and a writer still serialise
  // — but it does NOT conflict with the FOR KEY SHARE that a child-row insert
  // (a readiness item, a consumable, a device link) takes on the parent, so a
  // read-driven refresh no longer parks writers behind it.
  'no key update': 'FOR NO KEY UPDATE',
});

async function caseRowTx(client, tenantId, caseId, { lock = false } = {}) {
  const lockClause = lock ? (CASE_LOCK_CLAUSES[lock] ?? CASE_LOCK_CLAUSES.update) : '';
  const rows = await client.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, encounter_id, facility_id, status, urgency, actual_start_at
       FROM cath_lab_cases
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
      ${lockClause}
      LIMIT 1`,
    tenantOr(tenantId), positiveInt(caseId, 'case_id'),
  );
  const row = rows[0];
  if (!row) throw AppError.notFound('Cath-lab case not found', 'CATH_LAB_CASE_NOT_FOUND');
  return { ...row, id: num(row.id) };
}

// Exactly what the UPSERT below binds, in one object, so the STORED row can be
// compared against it column for column and an unchanged item skipped. The
// widths mirror the lab_results columns migration 766 copies from. Exported so
// the bound SHAPES can be pinned without a database: every column below is cast
// in SQL, and which JS type reaches that cast is the whole question.
export function itemWriteValues(item) {
  return {
    required: item.required !== false,
    state: item.state,
    // The copy targets mirror the lab_results widths (255 / 40 / 10); clamp
    // rather than let a widened source column raise 22001 inside a case read.
    value_text: cleanText(item.value_text, 255),
    value_numeric: item.value_numeric == null ? null : Number(item.value_numeric),
    unit: cleanText(item.unit, 40),
    abnormal_flag: cleanText(item.abnormal_flag, 10),
    is_critical: Boolean(item.is_critical),
    observed_at: item.observed_at ?? null,
    source: item.source ?? null,
    lab_result_id: int4OrNull(item.lab_result_id),
    investigation_id: int4OrNull(item.investigation_id),
    specimen_id: int4OrNull(item.specimen_id),
    ordered_at: item.ordered_at ?? null,
    waived_by: item.waived_by ? requireUuid(item.waived_by, 'waived_by') : null,
    // The one instant here that does not already arrive as an ISO string: a
    // waiver is read back off the STORED row, so the driver hands it over as a
    // Date. Binding that Date is the Prisma 7 session-timezone skew this module
    // writes instants as strings to avoid, so it is normalised to the shape
    // observed_at and ordered_at already carry (msToIso). storedItemMatches
    // compares both sides through toMs, so the round trip still reads equal and
    // a waived item is still not rewritten by a no-op refresh. A value that is
    // not an instant at all is passed through untouched: resolveItemState has
    // already refused a waived item without one, so this is the corrupt-row
    // path, and nulling it would trade migration 766's waiver CHECK for a
    // silent loss of who waived and when.
    waived_at: msToIso(toMs(item.waived_at)) ?? item.waived_at ?? null,
    waive_reason: item.waive_reason ?? null,
  };
}

const ITEM_TEXT_COLUMNS = Object.freeze([
  'state', 'value_text', 'unit', 'abnormal_flag', 'source', 'waive_reason',
]);
const ITEM_INT_COLUMNS = Object.freeze(['lab_result_id', 'investigation_id', 'specimen_id']);
const ITEM_INSTANT_COLUMNS = Object.freeze(['observed_at', 'ordered_at', 'waived_at']);

// Does the stored row already say exactly what the computed item says? Compared
// per column TYPE rather than with ===: the driver hands a NUMERIC back as a
// Decimal or a string and a TIMESTAMPTZ back as a Date, while the computed item
// carries a JS number and an ISO string. refreshed_at is deliberately excluded —
// it is the write's own timestamp, not evidence, and comparing it would make
// every row differ from itself.
function storedItemMatches(stored, values) {
  if (!stored) return false;
  if (Boolean(stored.required) !== values.required) return false;
  if (Boolean(stored.is_critical) !== values.is_critical) return false;
  for (const column of ITEM_TEXT_COLUMNS) {
    const left = stored[column] == null ? null : String(stored[column]);
    if (left !== values[column]) return false;
  }
  for (const column of ITEM_INT_COLUMNS) {
    const left = stored[column] == null ? null : Number(stored[column]);
    if (left !== values[column]) return false;
  }
  for (const column of ITEM_INSTANT_COLUMNS) {
    const left = stored[column] == null ? null : toMs(stored[column]);
    const right = values[column] == null ? null : toMs(values[column]);
    if (left !== right) return false;
  }
  const storedNumeric = stored.value_numeric == null ? null : Number(stored.value_numeric);
  if (storedNumeric !== values.value_numeric) return false;
  const storedWaivedBy = stored.waived_by == null ? null : String(stored.waived_by).toLowerCase();
  return storedWaivedBy === values.waived_by;
}

const STORED_ITEM_SELECT = 'item_code, required, state, value_text, value_numeric, unit, '
  + 'abnormal_flag, is_critical, observed_at, source, lab_result_id, investigation_id, '
  + 'specimen_id, ordered_at, waived_by, waived_at, waive_reason, refreshed_at';

async function upsertItemTx(tx, tenantId, caseId, itemCode, values) {
  await tx.$executeRawUnsafe(
    `INSERT INTO cath_case_lab_readiness_items
       (tenant_id, case_id, item_code, required, state, value_text, value_numeric, unit,
        abnormal_flag, is_critical, observed_at, source, lab_result_id, investigation_id,
        specimen_id, ordered_at, waived_by, waived_at, waive_reason, refreshed_at)
     VALUES ($1::uuid, $2::bigint, $3, $4::boolean, $5, $6, $7::numeric, $8,
             $9, $10::boolean, $11::timestamptz, $12, $13::int, $14::int,
             $15::int, $16::timestamptz, $17::uuid, $18::timestamptz, $19, NOW())
     ON CONFLICT (tenant_id, case_id, item_code) DO UPDATE SET
       required = EXCLUDED.required,
       state = EXCLUDED.state,
       value_text = EXCLUDED.value_text,
       value_numeric = EXCLUDED.value_numeric,
       unit = EXCLUDED.unit,
       abnormal_flag = EXCLUDED.abnormal_flag,
       is_critical = EXCLUDED.is_critical,
       observed_at = EXCLUDED.observed_at,
       source = EXCLUDED.source,
       lab_result_id = EXCLUDED.lab_result_id,
       investigation_id = EXCLUDED.investigation_id,
       specimen_id = EXCLUDED.specimen_id,
       ordered_at = EXCLUDED.ordered_at,
       waived_by = EXCLUDED.waived_by,
       waived_at = EXCLUDED.waived_at,
       waive_reason = EXCLUDED.waive_reason,
       refreshed_at = NOW()`,
    tenantId,
    caseId,
    itemCode,
    values.required,
    values.state,
    values.value_text,
    values.value_numeric,
    values.unit,
    values.abnormal_flag,
    values.is_critical,
    values.observed_at,
    values.source,
    values.lab_result_id,
    values.investigation_id,
    values.specimen_id,
    values.ordered_at,
    values.waived_by,
    values.waived_at,
    values.waive_reason,
  );
}

// The same gate as cathLabService.evaluateReadinessGate, inlined: cathLabService
// imports this module for getCase, so importing it back would be a static cycle.
const READINESS_CHECK_TYPES = Object.freeze([
  'consent', 'labs', 'allergy_renal_risk', 'anticoagulation',
  'blood_bank', 'equipment', 'implants_device_rep', 'timeout',
]);
const READINESS_CLEAR_STATES = new Set(['pass', 'waived', 'not_applicable']);

async function recomputeCaseStatusTx(tx, tenantId, caseId, actorUid) {
  const checks = await tx.$queryRawUnsafe(
    `SELECT check_type, status, required
       FROM cath_lab_readiness_checks
      WHERE tenant_id = $1::uuid
        AND case_id = $2::bigint`,
    tenantId, caseId,
  );
  const byType = new Map(checks.map((check) => [check.check_type, check]));
  const ready = READINESS_CHECK_TYPES.every((type) => {
    const check = byType.get(type);
    return Boolean(check) && (check.required === false || READINESS_CLEAR_STATES.has(check.status));
  });
  await tx.$executeRawUnsafe(
    `UPDATE cath_lab_cases
        SET status = CASE
              WHEN status IN ('scheduled', 'readiness_pending', 'ready') THEN $3
              ELSE status
            END,
            updated_by = COALESCE($4::uuid, updated_by),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint`,
    tenantId, caseId, ready ? 'ready' : 'readiness_pending', actorUid,
  );
  return ready;
}

// Booking statuses a draw can still happen under. Migration 098 puts no CHECK
// on investigation_bookings.status, so the vocabulary is the lifecycle its own
// header documents — BOOKED → CONFIRMED → DISPATCHED → COLLECTED → PROCESSING →
// RESULT_READY — plus CANCELLED and the NO_SHOW-shaped terminals a lab adds.
// This is the SAME resultable set labResultsService, labPanelService and
// labClosedLoopService already use, and it deliberately excludes every terminal
// one: CANCELLED / NO_SHOW (nothing will be drawn) and RESULT_READY (the value
// is in, so the lab_results row is the evidence from then on, not the booking).
const RESULTABLE_BOOKING_STATUSES = Object.freeze([
  'BOOKED', 'CONFIRMED', 'DISPATCHED', 'COLLECTED', 'PROCESSING',
]);

// How long the `labs` check row's live_evidence stamp may go unrefreshed before
// the refresh writes it again even though nothing about the evidence changed.
// A read-driven refresh runs on every GET of the case; without this the row
// would be rewritten (metadata included, ~3 KB of it) on every one of them.
const EVIDENCE_STAMP_MAX_AGE_MS = 60_000;

export async function refreshCaseLabReadiness({
  tenantId, caseId, db = null, context = {},
} = {}) {
  const tid = tenantOr(tenantId);
  const run = db ? (fn) => fn(db) : (fn) => setTenantTx(tid, fn);
  return run(async (tx) => {
    const cathCase = await caseRowTx(tx, tid, caseId, { lock: 'no key update' });
    const settings = await getReadinessSettings({ tenantId: tid, db: tx });
    const serologyDays = await serologyValidityDays(tid, tx);
    const asOf = new Date();
    // Serology carries the reuse programme's window; everything else the
    // tenant's lab validity. One function, so the item resolution, the
    // open-order set and the orderable set cannot drift apart.
    const windowDaysFor = (code) => (BLOODBORNE_MARKER_ITEM_CODES.includes(code)
      ? serologyDays
      : settings.lab_validity_days);
    // Wide enough that a value which has merely gone stale is still SEEN — the
    // resolver needs the row to answer 'stale' rather than 'not_ordered'.
    const lookbackDays = Math.max(settings.lab_validity_days, serologyDays) + 365;

    // lab_results.received_at is NOT NULL, so COALESCE(performed_at,
    // received_at) is always a real instant: nothing is silently dropped here.
    //
    // The three _epoch_ms twins are the house rule for an instant the resolver
    // compares against the process clock (src/utils/dbInstant.js): the pg driver
    // materialises a TIMESTAMPTZ in the DATABASE SESSION timezone, the twin is
    // the absolute instant in every session. external_reported_on is a DATE —
    // no zone to shift, and it is the day the outside laboratory reported the
    // value, which is what freshness must be measured from.
    const results = await tx.$queryRawUnsafe(
      `SELECT id, test_code, loinc_code, value_text, value_numeric, unit, abnormal_flag,
              is_critical, status, signed_off_at, performed_at, received_at, result_origin,
              external_reported_on,
              (EXTRACT(EPOCH FROM signed_off_at) * 1000)::bigint AS signed_off_at_epoch_ms,
              (EXTRACT(EPOCH FROM performed_at) * 1000)::bigint AS performed_at_epoch_ms,
              (EXTRACT(EPOCH FROM received_at) * 1000)::bigint AS received_at_epoch_ms
         FROM lab_results
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND COALESCE(performed_at, received_at) >= NOW() - ($3::int * INTERVAL '1 day')`,
      tid, cathCase.patient_uid, lookbackDays,
    );
    // investigations.status is the UPPER-case lifecycle from
    // config/investigationConfig.js (REQUESTED → SCHEDULED → COLLECTED →
    // IN_PROGRESS → COMPLETED, plus CANCELLED); the column carries no CHECK.
    //
    // requested_at is TIMESTAMP WITHOUT TIME ZONE (collected_at is TIMESTAMPTZ),
    // so its stored value only means something once you say which zone wrote it.
    // Every app writer goes through Prisma, whose sessions are pinned to UTC
    // (pinSessionTimeZoneToUrl in src/lib/prisma.js), so the naive value is a
    // UTC wall clock and `AT TIME ZONE 'UTC'` is what turns it back into the
    // instant. Spelled out rather than left to EXTRACT's implicit
    // treat-naive-as-UTC rule, so the assumption is visible where it is made.
    const investigationOrders = await tx.$queryRawUnsafe(
      `SELECT i.id, i.test_code, i.status, i.requested_at, i.collected_at, b.id AS booking_id,
              (EXTRACT(EPOCH FROM (i.requested_at AT TIME ZONE 'UTC')) * 1000)::bigint
                AS requested_at_epoch_ms,
              (EXTRACT(EPOCH FROM i.collected_at) * 1000)::bigint AS collected_at_epoch_ms
         FROM investigations i
         LEFT JOIN investigation_bookings b
           ON b.investigation_id = i.id
          AND b.tenant_id = i.tenant_id
        WHERE i.tenant_id = $1::uuid
          AND i.patient_uid = $2::uuid
          AND i.status NOT IN ('COMPLETED', 'CANCELLED')
          AND i.requested_at >= NOW() - ($3::int * INTERVAL '1 day')`,
      tid, cathCase.patient_uid, lookbackDays,
    );
    // Spec §7 step 2: a patient-app booking is an order too. Its tests are
    // catalogue IDS in investigation_bookings.selected_tests (migration 098),
    // and a booking that has not been turned into an investigations row yet —
    // investigation_id IS NULL — is exactly what the query above cannot see.
    // Without this the checklist tells the ward to order a draw that is
    // already booked, and order-missing places a duplicate.
    //
    // ordered_at is the booking's created_at: when the order was PLACED, which
    // is what investigations.requested_at means and what the freshness window
    // is measured from. scheduled_date is a DATE with no time and is often
    // null, so it cannot carry that meaning. created_at is TIMESTAMP WITHOUT
    // TIME ZONE and is read back as UTC for the same reason requested_at is.
    // investigation_bookings has no patient_uid, so the patient is resolved
    // through users.id the way every other booking reader does; the catalogue
    // is global (no tenant_id) and joins on its own code column.
    const resultableBookingStatuses = [...RESULTABLE_BOOKING_STATUSES];
    const bookingOrders = await tx.$queryRawUnsafe(
      `SELECT NULL::int AS id, UPPER(cat.code) AS test_code, b.status,
              b.created_at AS requested_at, b.collected_at, b.id AS booking_id,
              (EXTRACT(EPOCH FROM (b.created_at AT TIME ZONE 'UTC')) * 1000)::bigint
                AS requested_at_epoch_ms,
              (EXTRACT(EPOCH FROM b.collected_at) * 1000)::bigint AS collected_at_epoch_ms
         FROM investigation_bookings b
         JOIN users u
           ON u.id = b.patient_id
          AND u.tenant_id = b.tenant_id
         CROSS JOIN LATERAL unnest(b.selected_tests) AS selected(catalog_id)
         JOIN investigation_test_catalog cat
           ON cat.id = selected.catalog_id
        WHERE b.tenant_id = $1::uuid
          AND u.uid = $2::uuid
          AND b.investigation_id IS NULL
          AND UPPER(b.status) = ANY($4::text[])
          AND cat.code IS NOT NULL
          AND b.created_at >= NOW() - ($3::int * INTERVAL '1 day')`,
      tid, cathCase.patient_uid, lookbackDays, resultableBookingStatuses,
    );
    const orders = [...investigationOrders, ...bookingOrders];
    const bookingIds = [...new Set(
      orders.map((order) => int4OrNull(order.booking_id)).filter((id) => id != null),
    )];
    // lab_specimens.status is the LOWER-case vocabulary of
    // lab_specimens_status_check (ordered/collected/in_transit/received/
    // processing/rejected/disposed/cancelled).
    const specimens = bookingIds.length
      ? await tx.$queryRawUnsafe(
        `SELECT id, booking_id, status
           FROM lab_specimens
          WHERE tenant_id = $1::uuid
            AND booking_id = ANY($2::int[])
          ORDER BY id DESC`,
        tid, bookingIds,
      )
      : [];
    // The seven persisted rows, read ONCE. They are both the waiver source (a
    // waiver lives on the item row it waives) and the baseline the write-once
    // rule below compares against, so a second query for either would be a
    // second chance for the two reads to disagree.
    const storedRows = await tx.$queryRawUnsafe(
      `SELECT ${STORED_ITEM_SELECT}
         FROM cath_case_lab_readiness_items
        WHERE tenant_id = $1::uuid
          AND case_id = $2::bigint`,
      tid, cathCase.id,
    );
    const storedByCode = new Map(storedRows.map((row) => [row.item_code, row]));

    const items = ITEM_CODES.map((code) => {
      const stored = storedByCode.get(code) || null;
      const waiver = stored && stored.state === 'waived' ? stored : null;
      return {
        ...resolveItemState({
          item: code, results, orders, specimens, waiver, windowDays: windowDaysFor(code), asOf,
        }),
        required: settings.required_items.includes(code),
      };
    });
    // Write only what changed. A cath case is READ far more often than its labs
    // move, and every read used to rewrite all seven rows — churning
    // refreshed_at, the row versions and the WAL for nothing.
    for (const item of items) {
      const values = itemWriteValues(item);
      if (storedItemMatches(storedByCode.get(item.item_code), values)) continue;
      await upsertItemTx(tx, tid, cathCase.id, item.item_code, values);
    }

    const checkRows = await tx.$queryRawUnsafe(
      `SELECT id, status, completed_by, evidence_owner, source_name, attachment_ref, metadata
         FROM cath_lab_readiness_checks
        WHERE tenant_id = $1::uuid
          AND case_id = $2::bigint
          AND check_type = 'labs'
        FOR UPDATE`,
      tid, cathCase.id,
    );
    const check = checkRows[0] || null;
    const decision = computeCheckDecision({
      items,
      settings,
      check: check || { status: 'pending', metadata: {} },
      caseRow: cathCase,
    });
    let checkStatus = check ? check.status : 'pending';
    let autoManaged = check?.metadata?.auto_managed === true;
    if (check) {
      const priorMetadata = check.metadata && typeof check.metadata === 'object'
        ? check.metadata
        : {};
      // The reason is RECOMPUTED, not carried forward: while automation owns a
      // pending check the stored line goes stale the moment a sample is drawn,
      // and the ward would keep reading "hb not ordered" about an item that is
      // now awaiting a result.
      const autoPendingReason = decision.nextStatus === 'pending'
        ? decision.autoPendingReason
        : decision.nextStatus === 'pass'
          ? null
          : (autoManaged && String(check.status || '').toLowerCase() === 'pending'
            ? pendingReasonFor(decision.missing)
            : priorMetadata.auto_pending_reason ?? null);
      // evidence_owner / source_name / attachment_ref describe WHO cleared the
      // check. Automation may claim them on a row it is moving, or on one it
      // already owns — never on a human's pass, whose named owner and attached
      // report are the record of a clinical decision and used to be overwritten
      // by the next case read.
      const ownsEvidence = Boolean(decision.nextStatus) || autoManaged;
      const attachmentRef = `lab_readiness:${cathCase.id}`;
      // The stored copy came back out of jsonb, so compare against the same
      // round trip: a Date on this side and its ISO string on that one are the
      // same evidence, and key order out of jsonb is not the order it went in.
      const evidenceJson = JSON.parse(JSON.stringify(items));
      const stampMs = toMs(priorMetadata.live_evidence_refreshed_at);
      const stampIsStale = !Number.isFinite(stampMs)
        || asOf.getTime() - stampMs > EVIDENCE_STAMP_MAX_AGE_MS;
      const changed = Boolean(decision.nextStatus)
        || (priorMetadata.critical_warning ?? null) !== decision.criticalWarning
        || !deepEqual(priorMetadata.critical_items ?? null, decision.criticalItems)
        || !deepEqual(priorMetadata.live_evidence ?? null, evidenceJson)
        || (priorMetadata.auto_pending_reason ?? null) !== autoPendingReason
        || (ownsEvidence && (check.evidence_owner !== 'lab_readiness'
          || check.source_name !== 'lab_results'
          || check.attachment_ref !== attachmentRef));
      if (changed || stampIsStale) {
        const metadataPatch = {
          critical_warning: decision.criticalWarning,
          critical_items: decision.criticalItems,
          live_evidence: items,
          live_evidence_refreshed_at: asOf.toISOString(),
          auto_pending_reason: autoPendingReason,
          ...(decision.nextStatus
            ? {
              auto_managed: true,
              auto_passed_at: decision.nextStatus === 'pass' ? asOf.toISOString() : null,
            }
            : {}),
        };
        await tx.$executeRawUnsafe(
          `UPDATE cath_lab_readiness_checks
              SET status = COALESCE($4::text, status),
                  completed_at = CASE
                    WHEN $4::text = 'pass' THEN NOW()
                    WHEN $4::text = 'pending' THEN NULL
                    ELSE completed_at
                  END,
                  completed_by = CASE WHEN $4::text IS NOT NULL THEN NULL ELSE completed_by END,
                  evidence_owner = CASE WHEN $6::boolean THEN 'lab_readiness' ELSE evidence_owner END,
                  source_name = CASE WHEN $6::boolean THEN 'lab_results' ELSE source_name END,
                  attachment_ref = CASE WHEN $6::boolean THEN $5 ELSE attachment_ref END,
                  metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid
              AND id = $2::bigint`,
          tid,
          num(check.id),
          JSON.stringify(metadataPatch),
          decision.nextStatus,
          attachmentRef,
          ownsEvidence,
        );
      }
      if (decision.nextStatus) {
        checkStatus = decision.nextStatus;
        autoManaged = true;
        await recomputeCaseStatusTx(
          tx, tid, cathCase.id,
          context.actorUid ? requireUuid(context.actorUid, 'actorUid') : null,
        );
        // The actor on an automation flip is the system, not whoever happened
        // to open the case: attributing it to a person would put a decision in
        // their audit trail that they never made.
        await recordReadinessAudit(tx, {
          tenantId: tid,
          action: `cath_lab.readiness.labs.auto_${decision.nextStatus}`,
          resource: 'cath_lab_readiness_checks',
          resourceId: num(check.id),
          context: { actorUid: null, actorRole: 'SYSTEM' },
          metadata: {
            case_id: cathCase.id,
            missing: decision.missing,
            critical_items: decision.criticalItems,
            reason: decision.autoPendingReason,
          },
        });
      }
    }
    return {
      case_id: cathCase.id,
      check_status: checkStatus,
      auto_managed: autoManaged,
      critical_warning: decision.criticalWarning,
      critical_items: decision.criticalItems,
      items,
      missing: decision.missing,
      orderable_now: orderCodesCovering(
        items
          .filter((item) => item.required && ['not_ordered', 'stale'].includes(item.state))
          .map((item) => item.item_code),
      ),
      // Only the orders the RESOLVER would honour. An order older than the
      // item's window is not evidence there either, so counting it here would
      // both leave the item not_ordered and refuse to re-order it — a case the
      // checklist could never make ready.
      open_order_codes: [...new Set(
        orders
          .filter((order) => !OPEN_ORDER_STATUSES_EXCLUDED.has(String(order.status || '').toUpperCase())
            && ITEM_CODES.some((code) => orderCoversItem(code, order)
              && withinWindow(instantMs(order, 'requested_at'), asOf, windowDaysFor(code))))
          .map((order) => String(order.test_code || '').toUpperCase()),
      )],
      settings: {
        lab_validity_days: settings.lab_validity_days,
        serology_validity_days: serologyDays,
        auto_pass: settings.auto_pass,
        external_results_count: settings.external_results_count,
        required_items: settings.required_items,
      },
      case_started: Boolean(cathCase.actual_start_at),
    };
  });
}

// Best-effort, post-commit: refresh every open case of a patient after a lab
// event. Failures are logged and never propagate into the lab write — a
// readiness snapshot that is one event behind is repaired by the next refresh;
// a lab result that failed to commit is not.
export async function refreshOpenCasesForPatient({ tenantId, patientUid } = {}) {
  try {
    const tid = tenantOr(tenantId);
    const uid = requireUuid(patientUid, 'patientUid');
    const cases = await setTenant(tid, (client) => client.$queryRawUnsafe(
      `SELECT id
         FROM cath_lab_cases
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND status IN ('scheduled', 'readiness_pending', 'ready')
          AND actual_start_at IS NULL`,
      tid, uid,
    ));
    for (const row of cases) {
      try {
        await refreshCaseLabReadiness({ tenantId: tid, caseId: num(row.id) });
      } catch (err) {
        logger.warn(`Cath lab readiness refresh failed for case ${row.id}: ${err?.message}`);
      }
    }
    return cases.length;
  } catch (err) {
    logger.warn(`Cath lab readiness refresh lookup failed: ${err?.message}`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Actions: waive, un-waive, order the missing, record an outside result
// ---------------------------------------------------------------------------

function requireItem(value) {
  const item = String(value ?? '').trim().toLowerCase();
  if (!ITEM_CODES.includes(item)) {
    throw AppError.badRequest(
      `item must be one of ${ITEM_CODES.join(', ')}`,
      'CATH_LAB_READINESS_ITEM_UNKNOWN',
    );
  }
  return item;
}

// Once the patient is on the table the pre-procedure record is HISTORY: what
// the team knew before the case is not editable after it. The same rule the
// order and outside-result paths already state, and the same code
// (CATH_LAB_READINESS_CASE_STARTED) — spelled once so the two waiver paths
// cannot drift from it. The caller passes the row it has ALREADY LOCKED, so
// the decision is made against a case row no concurrent writer can start
// underneath it.
function requireCaseNotStarted(cathCase, message) {
  if (cathCase?.actual_start_at) {
    throw AppError.conflict(message, 'CATH_LAB_READINESS_CASE_STARTED');
  }
}

export async function waiveLabItem(caseId, itemCode, input = {}, context = {}) {
  const tid = tenantOr(input.tenantId);
  const item = requireItem(itemCode);
  const reason = cleanText(input.reason, 500);
  if (!reason) {
    throw AppError.badRequest(
      'reason is required to waive a lab item',
      'CATH_LAB_READINESS_VALUE_INVALID',
    );
  }
  const actor = requireUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => {
    const cathCase = await caseRowTx(tx, tid, caseId, { lock: true });
    requireCaseNotStarted(
      cathCase,
      'The procedure has started; the pre-procedure record is closed to new waivers',
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO cath_case_lab_readiness_items
         (tenant_id, case_id, item_code, required, state, source,
          waived_by, waived_at, waive_reason, refreshed_at)
       VALUES ($1::uuid, $2::bigint, $3, TRUE, 'waived', 'waiver', $4::uuid, NOW(), $5, NOW())
       ON CONFLICT (tenant_id, case_id, item_code) DO UPDATE SET
         state = 'waived',
         source = 'waiver',
         waived_by = EXCLUDED.waived_by,
         waived_at = NOW(),
         waive_reason = EXCLUDED.waive_reason,
         refreshed_at = NOW()`,
      tid, cathCase.id, item, actor, reason,
    );
    await recordReadinessAudit(tx, {
      tenantId: tid,
      action: 'cath_lab.readiness.labs.item_waived',
      resource: 'cath_case_lab_readiness_items',
      resourceId: `${cathCase.id}:${item}`,
      context,
      metadata: { case_id: cathCase.id, item, reason },
    });
    return refreshCaseLabReadiness({ tenantId: tid, caseId: cathCase.id, db: tx, context });
  });
}

// Lifting a waiver. The gate is not "undo": the waiver row and its audit trail
// stay in the log, and this writes a SECOND decision over them — the item goes
// back to being resolved from the patient's own lab evidence, which may leave
// it missing again and take the check off pass.
//
// The state is not GUESSED here. Clearing the three waiver columns and running
// the refresh on the SAME transaction is what re-resolves the item, so a
// lifted waiver reads exactly what it would have read had it never been
// waived — including the value that was already on the row, which
// resolveItemState keeps on a waived item. `state` and `source` are set to the
// no-evidence pair rather than left saying `waived`, because migration 766's
// cath_case_lab_readiness_items_waiver_check refuses a `waived` row without a
// who/when/why the statement has just nulled; the refresh below overwrites
// both from the evidence a statement later.
export async function unwaiveLabItem(caseId, itemCode, input = {}, context = {}) {
  const tid = tenantOr(input.tenantId);
  const item = requireItem(itemCode);
  // Optional: WHY the waiver is being lifted. A waiver needs a reason because
  // it clears a gate; lifting one restores the gate, so it is the restrictive
  // direction and is not held up for prose.
  const reason = cleanText(input.reason, 500);
  requireUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => {
    const cathCase = await caseRowTx(tx, tid, caseId, { lock: true });
    requireCaseNotStarted(
      cathCase,
      'The procedure has started; the pre-procedure record is closed to waiver changes',
    );
    const rows = await tx.$queryRawUnsafe(
      `SELECT state, waive_reason
         FROM cath_case_lab_readiness_items
        WHERE tenant_id = $1::uuid
          AND case_id = $2::bigint
          AND item_code = $3
        FOR UPDATE`,
      tid, cathCase.id, item,
    );
    const stored = rows[0] || null;
    // Read under the case lock and asserted from the STORED row, not from what
    // the caller believes: a second tap that arrives after the first has
    // already lifted the waiver is told so rather than writing a no-op audit
    // row saying a waiver was removed.
    if (!stored || String(stored.state) !== 'waived') {
      throw AppError.conflict(
        `The ${item} item is not waived`,
        'CATH_LAB_READINESS_NOT_WAIVED',
      );
    }
    const previousReason = stored.waive_reason ?? null;
    await tx.$executeRawUnsafe(
      `UPDATE cath_case_lab_readiness_items
          SET state = 'not_ordered',
              source = NULL,
              waived_by = NULL,
              waived_at = NULL,
              waive_reason = NULL,
              refreshed_at = NOW()
        WHERE tenant_id = $1::uuid
          AND case_id = $2::bigint
          AND item_code = $3`,
      tid, cathCase.id, item,
    );
    await recordReadinessAudit(tx, {
      tenantId: tid,
      action: 'cath_lab.readiness.labs.unwaived',
      resource: 'cath_case_lab_readiness_items',
      resourceId: `${cathCase.id}:${item}`,
      context,
      // The reason the waiver GAVE is the thing being withdrawn, so it is
      // carried onto the row that withdraws it: the log otherwise says an
      // override was lifted without saying which override.
      metadata: {
        case_id: cathCase.id, item, reason, previous_reason: previousReason,
      },
    });
    return refreshCaseLabReadiness({ tenantId: tid, caseId: cathCase.id, db: tx, context });
  });
}

// Catalogue display names for the six orderable codes (migration 102). The
// codes themselves come from labAnalyteCodes.orderCodesCovering, which stays
// the single source of truth for WHICH orders cover which items.
const CATALOGUE_TEST_NAMES = Object.freeze({
  CBC: 'Complete Blood Count',
  PLT: 'Platelet Count',
  CREATININE: 'Serum Creatinine',
  KFT: 'Kidney Function Test',
  ELECTROLYTES: 'Serum Electrolytes',
  HIV: 'HIV 1 & 2 Antibody (ELISA)',
  HBSAG: 'Hepatitis B Surface Antigen',
  HCV: 'Hepatitis C Antibody',
});

// cath_lab_cases.urgency (elective | routine | urgent | emergency — the
// vocabulary cathLabService.createCase normalises to) mapped onto the priority
// vocabulary createInvestigationOrder accepts (PRIORITY_LEVELS in
// config/investigationConfig.js: STAT | URGENT | HIGH | NORMAL | LOW). A
// primary-PCI patient's pre-procedure bloods must not sit on the lab worklist
// behind an elective case's on a 24-hour turnaround clock: STAT is a 1-hour
// target, URGENT 4. Anything unrecognised falls back to NORMAL, which is the
// value this path used unconditionally before.
const CATH_URGENCY_ORDER_PRIORITY = Object.freeze({
  emergency: 'STAT',
  urgent: 'URGENT',
  routine: 'NORMAL',
  elective: 'NORMAL',
});

export function orderPriorityForUrgency(urgency) {
  return CATH_URGENCY_ORDER_PRIORITY[String(urgency ?? '').trim().toLowerCase()] || 'NORMAL';
}

export async function orderMissingLabs(caseId, input = {}, context = {}) {
  const tid = tenantOr(input.tenantId);
  const actor = requireUuid(context.actorUid, 'actorUid');
  const before = await refreshCaseLabReadiness({ tenantId: tid, caseId, context });
  if (before.case_started) {
    throw AppError.conflict(
      'The procedure has started; order labs from the case instead',
      'CATH_LAB_READINESS_CASE_STARTED',
    );
  }
  const codes = before.orderable_now.filter((code) => !before.open_order_codes.includes(code));
  const patientRows = await setTenant(tid, (client) => client.$queryRawUnsafe(
    `SELECT u.id, c.urgency
       FROM users u
       JOIN cath_lab_cases c
         ON c.patient_uid = u.uid
        AND c.tenant_id = u.tenant_id
      WHERE c.tenant_id = $1::uuid
        AND c.id = $2::bigint
      LIMIT 1`,
    tid, positiveInt(caseId, 'case_id'),
  ));
  if (!patientRows[0]) {
    throw AppError.notFound('Cath-lab case patient not found', 'CATH_LAB_CASE_NOT_FOUND');
  }
  const created = [];
  const skipped = before.orderable_now
    .filter((code) => before.open_order_codes.includes(code))
    .map((code) => ({ code, reason: 'already_ordered' }));
  const priority = orderPriorityForUrgency(patientRows[0].urgency);
  for (const code of codes) {
    try {
      // createInvestigationOrder returns { investigation, patient_name,
      // duplicate_warning } — the order row is one level in, not the return.
      const order = await createInvestigationOrder({
        patient_id: Number(patientRows[0].id),
        doctor_uid: actor,
        orderedBy: actor,
        test_name: CATALOGUE_TEST_NAMES[code] || code,
        test_code: code,
        type: 'LAB',
        priority,
        notes: `Pre-cath lab readiness (case ${before.case_id})`,
        tenantId: tid,
        actorRole: context.actorRole || null,
      });
      created.push({ code, investigation_id: Number(order.investigation.id) });
    } catch (err) {
      // AppError.internal takes (message, code) and NOTHING else — a third
      // argument is silently dropped, which is how this error used to reach the
      // ward as a bare INTERNAL_ERROR. Constructed directly so both the code and
      // the partial progress survive: some orders may already be on the lab's
      // worklist, and re-running order-missing must not double them.
      throw new AppError(
        `Could not place the ${code} order: ${err?.code || err?.message}`,
        500,
        'CATH_LAB_READINESS_ORDER_FAILED',
        { code, cause: err?.code || null, created: created.map((row) => row.code) },
      );
    }
  }
  await setTenantTx(tid, (tx) => recordReadinessAudit(tx, {
    tenantId: tid,
    action: 'cath_lab.readiness.labs.orders_placed',
    resource: 'cath_lab_cases',
    resourceId: before.case_id,
    context,
    metadata: { created, skipped },
  }));
  const after = await refreshCaseLabReadiness({ tenantId: tid, caseId, context });
  return { created, skipped, readiness: after };
}

const QUALITATIVE_TOKENS = Object.freeze([
  'reactive', 'non-reactive', 'nonreactive', 'non reactive',
  'positive', 'negative', 'indeterminate', 'not detected', 'detected',
]);

// The fingerprint the ingest-command rail requires. An outside entry has no
// HTTP body of its own when it arrives through a service call, so the
// fingerprint is taken over the fields that define the result: the same value
// twice replays, a corrected value is a new command.
function externalEntryFingerprint(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export async function recordExternalLabResult(caseId, itemCode, input = {}, context = {}) {
  const tid = tenantOr(input.tenantId);
  const item = requireItem(itemCode);
  const def = LAB_ANALYTE_ITEMS[item];
  const actor = requireUuid(context.actorUid, 'actorUid');
  const labName = cleanText(input.external_lab_name, 160);
  const reportRef = cleanText(input.external_report_ref, 120);
  const notes = cleanText(input.notes, 2000);
  const observedOn = String(input.observed_on ?? '').trim();
  if (!labName) {
    throw AppError.badRequest('external_lab_name is required', 'CATH_LAB_READINESS_VALUE_INVALID');
  }
  // "Today" is the ward's today (Asia/Kolkata), not UTC's: between 18:30 and
  // midnight IST a same-day report is tomorrow in UTC and would be refused.
  // isCalendarDate, not the bare shape regex: 2026-13-45 is ten characters in
  // the right pattern and raises 22008 on the ::date cast further down, which
  // reaches the ward as a 500 rather than as the 400 it is.
  if (!isCalendarDate(observedOn) || observedOn > clinicalDate(new Date())) {
    throw AppError.badRequest(
      'observed_on must be a past or present date (YYYY-MM-DD)',
      'CATH_LAB_READINESS_VALUE_INVALID',
    );
  }
  const valueText = cleanText(input.value_text, 255);
  let valueNumeric = null;
  let unit = cleanText(input.unit, 40) || def.unit;
  if (def.kind === 'qualitative') {
    const token = String(valueText || '').toLowerCase();
    if (!QUALITATIVE_TOKENS.some((allowed) => token === allowed)) {
      throw AppError.badRequest(
        `value_text must be one of ${QUALITATIVE_TOKENS.join(', ')}`,
        'CATH_LAB_READINESS_VALUE_INVALID',
      );
    }
    unit = null;
  } else {
    // NOT `Number(input.value_numeric ?? valueText)`: that turns null, '', []
    // and false into 0 and true into 1, so a request naming no value at all was
    // stored as a creatinine of 0 — a value that reads as normal, passes the
    // gate and clears the case. Only an explicit finite number, or a plain
    // decimal string in either field, is a value.
    valueNumeric = externalNumericValue(input.value_numeric, valueText);
    if (!unit) {
      throw AppError.badRequest(
        'unit is required for a quantitative result',
        'CATH_LAB_READINESS_VALUE_INVALID',
      );
    }
  }
  const cathCase = await setTenant(tid, (client) => caseRowTx(client, tid, caseId));
  if (cathCase.actual_start_at) {
    throw AppError.conflict(
      'The procedure has started; outside results are recorded on the case, not the checklist',
      'CATH_LAB_READINESS_CASE_STARTED',
    );
  }

  // abnormal_flag is NOT computed here, and that is spec §8.2 honoured rather
  // than skipped: an outside numeric value must carry the same flag an in-house
  // one would, and on this platform lab_results.abnormal_flag is owned by the
  // GOVERNED threshold policy, not by whoever writes the row.
  // labThresholdExceptionService rewrites reference_range, reference_range_low /
  // _high and abnormal_flag from the policy assessment immediately after the
  // insert (and nulls them when no policy matches the analyte, leaving
  // criticality_status 'threshold_unavailable'). The panel path says the same
  // thing by inserting abnormal_flag: null outright. Deriving a flag here from
  // lab_reference_ranges would either be overwritten a statement later or, worse
  // where no policy matches, give an OUTSIDE value a flag the in-house value for
  // the same analyte does not carry — the exact inconsistency §8.2 exists to
  // prevent. The readiness item copies whatever the governed rail decided.

  const storedValue = def.kind === 'qualitative' ? valueText : String(valueNumeric);
  const fingerprint = SHA256_HEX.test(String(context.requestFingerprint || ''))
    ? String(context.requestFingerprint)
    : externalEntryFingerprint({
      case_id: cathCase.id,
      item,
      value: storedValue,
      unit,
      observed_on: observedOn,
      external_lab_name: labName,
      external_report_ref: reportRef,
    });
  // One Idempotency-Key, one lab command PER ITEM. The header names the
  // caller's REQUEST; the lab rail keys its command table on
  // (tenant_id, actor_uid, command_scope, command_key), so handing it the bare
  // header would make the SECOND item of an hiv/hbsag/hcv trio sent under one
  // key collide with the first and fail LAB_RESULT_COMMAND_BODY_MISMATCH (422)
  // — then serve that 422 back from the HTTP claim for the rest of the key's
  // life. Suffixing the item code makes different items distinct commands while
  // a genuine retry of the SAME item still replays (same key, same
  // fingerprint). The suffix is budgeted inside the rail's 200-character
  // command_key limit, so a caller key at the cap cannot push the joined key
  // over it. With no header the content-derived fallback already carries the
  // item.
  const callerKey = cleanText(context.idempotencyKey, Math.max(1, 199 - item.length));
  const idempotencyKey = callerKey
    ? `${callerKey}:${item}`
    : `cath-readiness-ext:${cathCase.id}:${item}:${fingerprint.slice(0, 32)}`;

  // recordExternalLabResultRow, NOT recordResultManual with a flag: the escape
  // is a separate entry point no route can reach, and this module is the only
  // permitted caller (pinned by tests/unit/labExternalResultCallSites.test.js).
  const recorded = await recordExternalLabResultRow({
    tenantId: tid,
    performed_by: actor,
    performed_by_role: context.actorRole || null,
    qualitative: def.kind === 'qualitative',
    result: {
      patient_uid: cathCase.patient_uid,
      test_code: def.canonicalAnalyteCode,
      test_name: `${def.canonicalAnalyteCode} (external lab)`,
      value_text: storedValue,
      unit,
      comments: notes,
      result_origin: 'external_lab',
      external_lab_name: labName,
      external_report_ref: reportRef,
      external_reported_on: observedOn,
      performed_at: `${observedOn}T00:00:00+05:30`,
    },
  }, {
    idempotencyKey,
    requestBodySha256: fingerprint,
    httpIdempotencyClaimId: context.httpIdempotencyClaimId || null,
    requestId: context.requestId || null,
  });
  const labResult = recorded.result;

  // Serology also lands on the patient's blood-borne marker record (Plan 1's
  // rail), so the reuse resolver and the cath capture sheet see the outside
  // value too. `external_report` markers must carry the lab link.
  if (def.marker) {
    await recordMarkers({
      tenantId: tid,
      patientUid: cathCase.patient_uid,
      actorUid: actor,
      entries: [{
        marker: def.marker,
        result: normalizeSerologyValue(valueText),
        tested_on: observedOn,
        source: 'external_report',
        lab_result_id: Number(labResult.id),
        evidence: {
          external_lab_name: labName,
          external_report_ref: reportRef,
          raw_value: valueText,
        },
      }],
    });
  }
  await setTenantTx(tid, (tx) => recordReadinessAudit(tx, {
    tenantId: tid,
    action: 'CATH_LAB_EXTERNAL_RESULT_RECORDED',
    resource: 'lab_results',
    resourceId: Number(labResult.id),
    context,
    metadata: {
      case_id: cathCase.id,
      item,
      external_lab_name: labName,
      external_report_ref: reportRef,
      observed_on: observedOn,
    },
  }));
  const readiness = await refreshCaseLabReadiness({
    tenantId: tid, caseId: cathCase.id, context,
  });
  return { lab_result_id: Number(labResult.id), item, readiness };
}
