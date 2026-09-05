// apps/backend/src/services/clinical/cathLabReadinessRules.js
//
// The PURE half of pre-procedure lab readiness: the vocabulary, the per-item
// resolution and the check-level decision. Spec:
// docs/superpowers/specs/2026-09-04-cath-pre-procedure-lab-readiness-design.md
//
// No I/O, no clock of its own (every function that needs one takes `asOf`), no
// tenant and no database. That is the point of the file: `resolveItemState` and
// `computeCheckDecision` are the two functions the whole feature's behaviour
// turns on, and they can be driven directly, exhaustively and without a stub
// client — which is how the boundary-date and check-decision tables in
// cathLabReadinessService.test.js are written.
//
// cathLabReadinessService.js re-exports every name here, so an importer that
// only knows the service keeps working; new code should prefer this module when
// it wants the rules without the persistence graph behind them.

import { AppError } from '../../utils/AppError.js';
import { epochMsOrNull } from '../../utils/dbInstant.js';
import {
  LAB_ANALYTE_ITEMS,
  LAB_ANALYTE_ITEM_CODES,
  analyteItemForResult,
} from '../lab/labAnalyteCodes.js';

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
export const OPEN_ORDER_STATUSES_EXCLUDED = new Set(['COMPLETED', 'CANCELLED']);
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
export function toMs(value) {
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
export function instantMs(row, field) {
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
export function msToIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Fresh means IN THE PAST and no older than the window. The lower bound is the
// point: a future-dated row is not evidence of anything, so it can never be
// fresh, and sortMs ranks it last so it never outranks a real value either. A
// lone future-dated result therefore resolves as `stale` — it is the latest but
// not fresh — which is the restrictive direction. Open orders inherit the same
// bound; a future-dated order is dropped and the item reads not_ordered rather
// than ordered_awaiting_sample, and the check counts both as missing.
export function withinWindow(value, asOf, windowDays) {
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

export function orderCoversItem(item, order) {
  const code = String(order.test_code || '').trim().toUpperCase();
  return LAB_ANALYTE_ITEMS[item].orderCodes.includes(code);
}

// Was this waiver written after the patient was already on the table?
//
// OWNER DECISION, 2026-09-06: the pre-cath checklist is not restrictive, so a
// waiver MAY be recorded once the procedure has started (see
// cathLabReadinessActions.isAfterCaseStart). What the record then owes its
// reader is the timing: "proceeding without HCV" decided in the anteroom and
// the same decision written down twenty minutes into a primary PCI are not the
// same document.
//
// DERIVED, never stored. Both instants are already columns —
// cath_case_lab_readiness_items.waived_at and cath_lab_cases.actual_start_at —
// so a third column would be a copy that can go stale against them, and no
// migration is needed for a value the read can compute.
//
// False when the case has not started, when the waiver predates the start, and
// when either instant is unusable: this key is an ASSERTION that a waiver was
// documented late, and an unknown is not one.
function waivedAfterStart(waivedAt, caseStartedAt) {
  if (!caseStartedAt) return false;
  const waivedMs = toMs(waivedAt);
  const startedMs = toMs(caseStartedAt);
  if (!Number.isFinite(waivedMs) || !Number.isFinite(startedMs)) return false;
  return waivedMs > startedMs;
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
  // The owning case's actual_start_at, for the waiver-lateness marker below.
  // Optional: every other branch reads it as "not started", which is also the
  // right answer for a case that has not.
  caseStartedAt = null,
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
    // Present, and false, on EVERY item for the same reason the three waiver
    // keys are present and null: CathLabReadinessItem is
    // additionalProperties:false with every key required, so the key set may
    // not vary by branch. Only a waived item can carry true.
    recorded_after_start: false,
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
    recorded_after_start: waivedAfterStart(waiver.waived_at, caseStartedAt),
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

// Does this item need nothing further from the team? Exported because the case
// LIST answers the same question over the stored rows without running a
// refresh, and a second copy of the external-results rule there would be a
// second thing to keep in step with the tenant setting.
export function isItemAvailable(item, settings) {
  if (AVAILABLE_STATES.includes(item.state)) return true;
  return item.state === 'external_recorded' && settings.external_results_count === true;
}

// What automation may do to the `labs` check row given the items.
// nextStatus: 'pass' | 'pending' | null (leave the row alone).
export function computeCheckDecision({ items, settings, check, caseRow }) {
  const required = items.filter((item) => item.required !== false);
  const missing = required.filter((item) => !isItemAvailable(item, settings)).map((item) => ({ item: item.item_code, state: item.state }));
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
export function isCalendarDate(text) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!parts) return false;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  return roundTrip.getUTCFullYear() === year
    && roundTrip.getUTCMonth() === month - 1
    && roundTrip.getUTCDate() === day;
}
