// Utilities for producing labelled medication-adherence training rows.
// Runtime risk scoring stays in adherenceRiskService; these helpers are
// for offline data export and unit-testable feature engineering.

export const ADHERENCE_TRAINING_COLUMNS = [
  'missed_30',
  'overrides_30',
  'late_refills_90',
  'days_silent',
  'defaulted_within_30',
];

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(later, earlier) {
  return Math.floor((later.getTime() - earlier.getTime()) / 86400000);
}

function isWithin(date, startExclusive, endInclusive) {
  if (!date) return false;
  return date.getTime() > startExclusive.getTime() && date.getTime() <= endInclusive.getTime();
}

function shiftDays(date, days) {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

function clampNonNegativeInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function defaultAdherenceSnapshotDate(now = new Date()) {
  // Leave 30 days of future outcome window for labels.
  return shiftDays(asDate(now) || new Date(), -30).toISOString().slice(0, 10);
}

export function normalizeAdherenceTrainingRow(row = {}) {
  return {
    missed_30: clampNonNegativeInteger(row.missed_30),
    overrides_30: clampNonNegativeInteger(row.overrides_30),
    late_refills_90: clampNonNegativeInteger(row.late_refills_90),
    days_silent: Math.min(clampNonNegativeInteger(row.days_silent), 3650),
    defaulted_within_30: clampNonNegativeInteger(row.defaulted_within_30) > 0 ? 1 : 0,
  };
}

export function summarizeAdherenceTrainingWindow({
  marEvents = [],
  refillEvents = [],
  vitalEvents = [],
  snapshotDate,
  defaultThreshold = 2,
  silentCapDays = 60,
} = {}) {
  const snapshot = asDate(`${snapshotDate}T00:00:00Z`) || asDate(snapshotDate) || new Date();
  const past30 = shiftDays(snapshot, -30);
  const past90 = shiftDays(snapshot, -90);
  const future30 = shiftDays(snapshot, 30);

  const missed30 = marEvents.filter((event) => {
    const eventDate = asDate(event.administered_at || event.scheduled_time || event.date);
    return String(event.status || '').toLowerCase() === 'missed' && isWithin(eventDate, past30, snapshot);
  }).length;

  const overrides30 = marEvents.filter((event) => {
    const eventDate = asDate(event.administered_at || event.scheduled_time || event.date);
    return Boolean(event.override_reason) && isWithin(eventDate, past30, snapshot);
  }).length;

  const lateRefills90 = refillEvents.filter((event) => {
    const eventDate = asDate(event.refill_at || event.created_at || event.date);
    const late = event.late === true || Number(event.days_late || 0) > 7 || String(event.status || '').toLowerCase() === 'late';
    return late && isWithin(eventDate, past90, snapshot);
  }).length;

  const latestVital = vitalEvents
    .map((event) => asDate(event.recorded_at || event.date))
    .filter((date) => date && date.getTime() <= snapshot.getTime())
    .sort((a, b) => b.getTime() - a.getTime())[0] || null;
  const daysSilent = latestVital ? Math.min(daysBetween(snapshot, latestVital), silentCapDays) : silentCapDays;

  const futureMissed = marEvents.filter((event) => {
    const eventDate = asDate(event.administered_at || event.scheduled_time || event.date);
    return String(event.status || '').toLowerCase() === 'missed' && isWithin(eventDate, snapshot, future30);
  }).length;

  return normalizeAdherenceTrainingRow({
    missed_30: missed30,
    overrides_30: overrides30,
    late_refills_90: lateRefills90,
    days_silent: daysSilent,
    defaulted_within_30: futureMissed >= defaultThreshold ? 1 : 0,
  });
}

function csvValue(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function adherenceTrainingRowsToCsv(rows = []) {
  const header = ADHERENCE_TRAINING_COLUMNS.join(',');
  const lines = rows.map((row) => {
    const normalized = normalizeAdherenceTrainingRow(row);
    return ADHERENCE_TRAINING_COLUMNS.map((column) => csvValue(normalized[column])).join(',');
  });
  return `${[header, ...lines].join('\n')}\n`;
}

export default {
  ADHERENCE_TRAINING_COLUMNS,
  adherenceTrainingRowsToCsv,
  defaultAdherenceSnapshotDate,
  normalizeAdherenceTrainingRow,
  summarizeAdherenceTrainingWindow,
};
