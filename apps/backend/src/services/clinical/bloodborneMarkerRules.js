// src/services/clinical/bloodborneMarkerRules.js
//
// Pure rules for the patient blood-borne marker record: the serology value
// normaliser, the reuse-status resolver and the exposure-handler registry.
// Kept free of prisma/logger-heavy imports so unit tests import them without
// a database (same split as icuComputations.js). bloodborneMarkerService.js
// re-exports everything here and adds the persistence functions.
//
// Spec: docs/superpowers/specs/2026-09-04-cath-device-reuse-and-bloodborne-markers-design.md §7.

import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

export const MARKERS = Object.freeze(['hiv', 'hbsag', 'hcv', 'cjd_suspected', 'other']);
export const CORE_MARKERS = Object.freeze(['hiv', 'hbsag', 'hcv']);
export const RESULTS = Object.freeze(['reactive', 'non_reactive', 'indeterminate', 'pending']);
export const SOURCES = Object.freeze(['lab_result', 'external_report', 'clinical_declaration']);
export const DEFAULT_VALIDITY_DAYS = 90;
export const STATUSES = Object.freeze(['restricted', 'unknown', 'clear']);
export const CLINICAL_TIME_ZONE = 'Asia/Kolkata';

const MARKER_DISPLAY = Object.freeze({
  hiv: 'HIV',
  hbsag: 'HBsAg',
  hcv: 'HCV',
  cjd_suspected: 'CJD suspected',
});

// Free-text serology to one of RESULTS. Precedence:
//   1. empty → pending
//   2. any indeterminate token → indeterminate (an equivocal note outranks
//      the surrounding words, whichever way they lean)
//   3. a negative token present: if a positive token survives once the
//      negative phrases are removed ("reactive — not detected on repeat",
//      a panel comment dumped into value_text) → indeterminate, never a
//      definite negative; else if a pending token is present → pending
//      ("not detected, repeat pending"); else → non_reactive
//   4. a positive token present → reactive, even with a pending token
//      ("reactive, confirmation pending" is a reactive screen)
//   5. a pending token present → pending
//   6. anything else → indeterminate
// A false non_reactive is the one input that manufactures an unearned
// "clear", so every mixed case resolves toward the restrictive side.
const PENDING_TOKENS = ['pending', 'awaited'];
const INDETERMINATE_TOKENS = ['indeterminate', 'equivocal', 'borderline', 'grey zone', 'gray zone'];
const NEGATIVE_TOKENS = ['non-reactive', 'nonreactive', 'non reactive', 'non_reactive', 'negative', 'not detected'];
const POSITIVE_TOKENS = ['weakly reactive', 'reactive', 'positive', 'detected'];

const hasAny = (text, tokens) => tokens.some((token) => text.includes(token));

export function normalizeSerologyValue(valueText) {
  const text = String(valueText ?? '').trim().toLowerCase();
  if (!text) return 'pending';
  if (hasAny(text, INDETERMINATE_TOKENS)) return 'indeterminate';
  const pending = hasAny(text, PENDING_TOKENS);
  const negatives = NEGATIVE_TOKENS.filter((token) => text.includes(token));
  if (negatives.length) {
    let rest = text;
    for (const token of negatives) rest = rest.split(token).join(' ');
    if (hasAny(rest, POSITIVE_TOKENS)) return 'indeterminate';
    return pending ? 'pending' : 'non_reactive';
  }
  if (hasAny(text, POSITIVE_TOKENS)) return 'reactive';
  if (pending) return 'pending';
  return 'indeterminate';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(value, label) {
  const text = String(value ?? '').trim();
  if (!UUID_PATTERN.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'BLOODBORNE_MARKER_INVALID');
  }
  return text.toLowerCase();
}

// YYYY-MM-DD for a DATE column value (string or the UTC-midnight Date Prisma returns).
export function isoDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  const text = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
}

// Calendar date of an instant in the clinical time zone, as YYYY-MM-DD.
export function clinicalDate(instant, timeZone = CLINICAL_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

function utcDayNumber(isoDay) {
  return Date.UTC(Number(isoDay.slice(0, 4)), Number(isoDay.slice(5, 7)) - 1, Number(isoDay.slice(8, 10))) / 86_400_000;
}

// Whole calendar days from tested_on to asOf, both read as clinical-zone
// dates. Negative when tested_on is after asOf (a future-dated result is
// unusable evidence and must not read as a same-day test); NaN when
// tested_on is not a date.
export function ageInDays(testedOn, asOf) {
  const tested = isoDate(testedOn);
  if (!tested) return NaN;
  return utcDayNumber(clinicalDate(asOf)) - utcDayNumber(tested);
}

function markerLabel(row) {
  if (row.marker === 'other') return String(row.marker_label || '').trim() || 'Other marker';
  return MARKER_DISPLAY[row.marker] || String(row.marker);
}

function markerKey(row) {
  return row.marker === 'other'
    ? `other:${String(row.marker_label || '').trim().toLowerCase()}`
    : row.marker;
}

function markerSortValue(row) {
  const rank = MARKERS.indexOf(row.marker);
  return `${rank < 0 ? 9 : rank}:${markerKey(row)}`;
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function liveRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => row && !row.voided_at);
}

// Latest non-voided row per marker (per label for 'other'), by tested_on then id.
function latestPerMarker(rows) {
  const sorted = [...liveRows(rows)].sort((a, b) => {
    const byDate = compareText(isoDate(b.tested_on), isoDate(a.tested_on));
    if (byDate !== 0) return byDate;
    return Number(b.id) - Number(a.id);
  });
  const latest = new Map();
  for (const row of sorted) {
    const key = markerKey(row);
    if (!latest.has(key)) latest.set(key, row);
  }
  return latest;
}

function coerceValidityDays(value) {
  const days = Number(value);
  return Number.isFinite(days) && days >= 1 && days <= 365 ? Math.floor(days) : DEFAULT_VALIDITY_DAYS;
}

// Reuse-restriction status for a patient from their marker rows.
//
// Rules (spec §7.3, with the 2026-09-04 review decision that a reactive row
// LATCHES): any non-voided reactive row for any marker, of any age, restricts —
// antibody markers do not revert, and for device reprocessing "ever reactive"
// is the safe reading of HBsAg too; only voiding (entered in error) clears it.
// Otherwise the latest non-voided row per core marker decides: all three
// non-reactive within the window → clear; anything else → unknown, with a
// reason per core marker. "Unknown" always carries at least one reason.
export function computeReuseStatus(rows = [], { validityDays, asOf = new Date() } = {}) {
  const window = coerceValidityDays(validityDays);
  const live = liveRows(rows);
  const latest = latestPerMarker(live);
  const reasons = [];

  const reactiveRows = live
    .filter((row) => row.result === 'reactive')
    .sort((a, b) => compareText(markerSortValue(a), markerSortValue(b)) || compareText(isoDate(b.tested_on), isoDate(a.tested_on)));
  const seenReactive = new Set();
  for (const row of reactiveRows) {
    const key = markerKey(row);
    if (seenReactive.has(key)) continue;
    seenReactive.add(key);
    reasons.push(row.marker === 'cjd_suspected'
      ? `CJD suspected ${isoDate(row.tested_on)}`.trim()
      : `${markerLabel(row)} reactive ${isoDate(row.tested_on)}`.trim());
  }

  const markers = [...latest.values()]
    .sort((a, b) => compareText(markerSortValue(a), markerSortValue(b)))
    .map((row) => {
      const age = ageInDays(row.tested_on, asOf);
      return {
        marker: row.marker,
        label: row.marker === 'other' ? (String(row.marker_label || '').trim() || null) : null,
        result: row.result,
        tested_on: isoDate(row.tested_on),
        source: row.source,
        age_days: Number.isNaN(age) ? null : age,
        within_window: Number.isNaN(age) ? false : (age >= 0 && age <= window),
      };
    });

  const base = { markers, validity_days: window, evaluated_at: asOf.toISOString() };
  if (reasons.length) return { status: 'restricted', reasons, ...base };

  const clear = CORE_MARKERS.every((marker) => {
    const row = latest.get(marker);
    if (!row || row.result !== 'non_reactive') return false;
    const age = ageInDays(row.tested_on, asOf);
    return !Number.isNaN(age) && age >= 0 && age <= window;
  });
  if (clear) {
    return { status: 'clear', reasons: ['HIV, HBsAg and HCV non-reactive within window'], ...base };
  }

  for (const marker of CORE_MARKERS) {
    const row = latest.get(marker);
    const label = MARKER_DISPLAY[marker];
    if (!row) { reasons.push(`${label} not on record`); continue; }
    const age = ageInDays(row.tested_on, asOf);
    if (row.result === 'pending') reasons.push(`${label} pending`);
    else if (row.result === 'indeterminate') reasons.push(`${label} indeterminate`);
    else if (row.result === 'non_reactive' && Number.isNaN(age)) reasons.push(`${label} result date cannot be read`);
    else if (row.result === 'non_reactive' && age < 0) reasons.push(`${label} result dated in the future (${isoDate(row.tested_on)})`);
    else if (row.result === 'non_reactive' && age > window) reasons.push(`${label} result older than ${window} days (${isoDate(row.tested_on)})`);
    else if (row.result !== 'non_reactive') reasons.push(`${label} result cannot be interpreted`);
  }
  if (reasons.length === 0) reasons.push('Serology status cannot be determined');
  return { status: 'unknown', reasons, ...base };
}

// ---------------------------------------------------------------------------
// Exposure handlers — invoked post-commit whenever a reactive row is recorded.
// Consumers register at module load (cath device reuse quarantines devices).
// ---------------------------------------------------------------------------

const exposureHandlers = new Set();

export function registerExposureHandler(handler) {
  if (typeof handler !== 'function') {
    throw new TypeError('registerExposureHandler expects a function');
  }
  exposureHandlers.add(handler);
  return () => exposureHandlers.delete(handler);
}

export function __clearExposureHandlersForTests() {
  exposureHandlers.clear();
}

export async function notifyExposureHandlers(events = []) {
  for (const event of Array.isArray(events) ? events : []) {
    for (const handler of exposureHandlers) {
      try {
        await handler(event);
      } catch (err) {
        logger.error(`Blood-borne exposure handler failed: ${err?.message}`, {
          marker: event?.marker,
          tenantId: event?.tenantId,
          patientUid: event?.patientUid,
          error: err?.message,
          code: err?.code || null,
          stack: err?.stack || null,
        });
      }
    }
  }
}
