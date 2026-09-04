// src/services/clinical/bloodborneMarkerService.js
//
// Platform-level patient blood-borne marker record and its reuse resolver.
// Spec: docs/superpowers/specs/2026-09-04-cath-device-reuse-and-bloodborne-markers-design.md §5.1, §7.
//
// Consumers today: cath-lab device reuse (restriction strip, post-use rules,
// late-result quarantine). Named future consumers: OT sign-in, dialysis.
// Writers: the lab sign-off hook (recordMarkersFromSignedResults) and the cath
// readiness checklist's external-result / clinical-declaration paths, both of
// which call recordMarkers. There is deliberately no general create endpoint.

// eslint-disable-next-line no-unused-vars -- used by the persistence functions appended in Task 4
import prisma, { setTenant, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
// eslint-disable-next-line no-unused-vars -- used by the persistence functions appended in Task 4
import { requireTenantId } from '../tenant/tenantService.js';
import { markerForResult } from '../lab/labAnalyteCodes.js';

export const MARKERS = Object.freeze(['hiv', 'hbsag', 'hcv', 'cjd_suspected', 'other']);
export const CORE_MARKERS = Object.freeze(['hiv', 'hbsag', 'hcv']);
export const RESULTS = Object.freeze(['reactive', 'non_reactive', 'indeterminate', 'pending']);
export const SOURCES = Object.freeze(['lab_result', 'external_report', 'clinical_declaration']);
export const DEFAULT_VALIDITY_DAYS = 90;
export const STATUSES = Object.freeze(['restricted', 'unknown', 'clear']);

const MARKER_DISPLAY = Object.freeze({
  hiv: 'HIV',
  hbsag: 'HBsAg',
  hcv: 'HCV',
  cjd_suspected: 'CJD suspected',
});

// Order matters: negative tokens contain "reactive"/"detected", so they are
// tested before the positive tokens. Anything unrecognised is indeterminate,
// never silently non_reactive.
const PENDING_TOKENS = ['pending', 'awaited'];
const NEGATIVE_TOKENS = ['non-reactive', 'nonreactive', 'non reactive', 'non_reactive', 'negative', 'not detected'];
const INDETERMINATE_TOKENS = ['indeterminate', 'equivocal', 'borderline', 'grey zone', 'gray zone'];
const POSITIVE_TOKENS = ['weakly reactive', 'reactive', 'positive', 'detected'];

export function normalizeSerologyValue(valueText) {
  const text = String(valueText ?? '').trim().toLowerCase();
  if (!text) return 'pending';
  if (PENDING_TOKENS.includes(text)) return 'pending';
  if (NEGATIVE_TOKENS.some((token) => text.includes(token))) return 'non_reactive';
  if (INDETERMINATE_TOKENS.some((token) => text.includes(token))) return 'indeterminate';
  if (POSITIVE_TOKENS.some((token) => text.includes(token))) return 'reactive';
  return 'indeterminate';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value, label) {
  const text = String(value ?? '').trim();
  if (!UUID_PATTERN.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'BLOODBORNE_MARKER_INVALID');
  }
  return text.toLowerCase();
}

function isoDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value ?? '').trim();
  return text.length >= 10 ? text.slice(0, 10) : text;
}

// Calendar days between a DATE (YYYY-MM-DD or Date) and asOf, in UTC days.
function ageInDays(testedOn, asOf) {
  const tested = Date.UTC(
    Number(isoDate(testedOn).slice(0, 4)),
    Number(isoDate(testedOn).slice(5, 7)) - 1,
    Number(isoDate(testedOn).slice(8, 10)),
  );
  const now = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  return Math.floor((now - tested) / 86_400_000);
}

function markerLabel(row) {
  if (row.marker === 'other') return row.marker_label || 'Other marker';
  return MARKER_DISPLAY[row.marker] || row.marker;
}

function markerKey(row) {
  return row.marker === 'other' ? `other:${String(row.marker_label || '').toLowerCase()}` : row.marker;
}

// Latest non-voided row per marker (per label for 'other'), by tested_on then id.
function latestPerMarker(rows) {
  const sorted = [...rows]
    .filter((row) => !row.voided_at)
    .sort((a, b) => {
      const byDate = isoDate(b.tested_on).localeCompare(isoDate(a.tested_on));
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

export function computeReuseStatus(rows = [], {
  validityDays = DEFAULT_VALIDITY_DAYS,
  asOf = new Date(),
} = {}) {
  const latest = latestPerMarker(rows);
  const markers = [];
  const reasons = [];
  let restricted = false;

  for (const row of latest.values()) {
    const age = ageInDays(row.tested_on, asOf);
    markers.push({
      marker: row.marker,
      label: row.marker === 'other' ? (row.marker_label || null) : null,
      result: row.result,
      tested_on: isoDate(row.tested_on),
      source: row.source,
      age_days: age,
      within_window: age <= validityDays,
    });
    if (row.marker === 'cjd_suspected' && row.result === 'reactive') {
      restricted = true;
      reasons.push('CJD suspected');
    } else if (row.result === 'reactive') {
      // A reactive result never lapses: the window governs how long a
      // negative may be relied on, not how long a positive counts.
      restricted = true;
      reasons.push(`${markerLabel(row)} reactive ${isoDate(row.tested_on)}`);
    }
  }

  const base = {
    markers,
    validity_days: validityDays,
    evaluated_at: asOf.toISOString(),
  };
  if (restricted) return { status: 'restricted', reasons, ...base };

  const clear = CORE_MARKERS.every((marker) => {
    const row = latest.get(marker);
    return row && row.result === 'non_reactive' && ageInDays(row.tested_on, asOf) <= validityDays;
  });
  if (clear) {
    return { status: 'clear', reasons: ['HIV, HBsAg and HCV non-reactive within window'], ...base };
  }

  for (const marker of CORE_MARKERS) {
    const row = latest.get(marker);
    const label = MARKER_DISPLAY[marker];
    if (!row) reasons.push(`${label} not on record`);
    else if (row.result === 'pending') reasons.push(`${label} pending`);
    else if (row.result === 'indeterminate') reasons.push(`${label} indeterminate`);
    else if (ageInDays(row.tested_on, asOf) > validityDays) {
      reasons.push(`${label} result older than ${validityDays} days`);
    }
  }
  return { status: 'unknown', reasons, ...base };
}

// ---------------------------------------------------------------------------
// Exposure handlers — invoked post-commit whenever a reactive row is recorded.
// Consumers register at module load (cath device reuse quarantines devices).
// ---------------------------------------------------------------------------

const exposureHandlers = new Set();

export function registerExposureHandler(handler) {
  exposureHandlers.add(handler);
  return () => exposureHandlers.delete(handler);
}

export function __clearExposureHandlersForTests() {
  exposureHandlers.clear();
}

export async function notifyExposureHandlers(events = []) {
  for (const event of events) {
    for (const handler of exposureHandlers) {
      try {
        await handler(event);
      } catch (err) {
        logger.error(`Blood-borne exposure handler failed: ${err?.message}`, {
          marker: event?.marker,
          tenantId: event?.tenantId,
        });
      }
    }
  }
}

export { markerForResult, requireUuid as __requireUuidForTests, isoDate as __isoDateForTests };
