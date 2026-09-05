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
// This file currently holds only the pure resolution/decision rules (Task 2).
// Task 3 appends persistence, refresh, automation, order-missing, external
// result entry and waiver, and will add these imports at that point:
//   prisma, { setTenant, setTenantTx } from '../../lib/prisma.js'
//   logger from '../../logging/logger.js'
//   { AppError } from '../../utils/AppError.js'
//   { requireTenantId } from '../tenant/tenantService.js'
//   { BLOODBORNE_MARKER_ITEM_CODES, orderCodesCovering } from '../lab/labAnalyteCodes.js'
//   { recordMarkers, normalizeSerologyValue } from './bloodborneMarkerService.js'
//   { recordMedicationSafetyReviews } from './canonicalClinicalPlatformService.js'

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

function observedAt(row) {
  return row.performed_at || row.received_at || null;
}

function toMs(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : NaN;
}

function withinWindow(value, asOf, windowDays) {
  const ms = toMs(value);
  return Number.isFinite(ms) && (asOf.getTime() - ms) <= windowDays * 86_400_000;
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
  };
  if (waiver) {
    return { ...base, state: 'waived', source: 'waiver', waived_by: waiver.waived_by, waived_at: waiver.waived_at, waive_reason: waiver.waive_reason };
  }

  const candidates = results
    .filter((row) => matchesItem(item, row) && String(row.status || '').toLowerCase() !== 'cancelled')
    .sort((a, b) => (toMs(observedAt(b)) - toMs(observedAt(a))) || (Number(b.id) - Number(a.id)));
  const latest = candidates[0] || null;
  const latestFresh = latest && withinWindow(observedAt(latest), asOf, windowDays) ? latest : null;

  if (latestFresh) {
    const status = String(latestFresh.status || '').toLowerCase();
    const state = latestFresh.result_origin === 'external_lab'
      ? 'external_recorded'
      : (SIGNED_STATUSES.has(status) && latestFresh.signed_off_at ? 'result_final' : 'result_preliminary');
    return {
      ...base, state,
      value_text: latestFresh.value_text ?? null,
      value_numeric: latestFresh.value_numeric == null ? null : Number(latestFresh.value_numeric),
      unit: latestFresh.unit ?? null,
      abnormal_flag: latestFresh.abnormal_flag ?? null,
      is_critical: isCriticalResult(latestFresh),
      observed_at: observedAt(latestFresh),
      source: latestFresh.result_origin === 'external_lab' ? 'external' : 'lab_result',
      lab_result_id: Number(latestFresh.id),
    };
  }

  const openOrders = orders
    .filter((order) => orderCoversItem(item, order)
      && !OPEN_ORDER_STATUSES_EXCLUDED.has(String(order.status || '').toUpperCase())
      && withinWindow(order.requested_at, asOf, windowDays))
    .sort((a, b) => toMs(b.requested_at) - toMs(a.requested_at));
  const order = openOrders[0] || null;
  if (order) {
    const specimen = order.booking_id == null
      ? null
      : specimens.find((s) => Number(s.booking_id) === Number(order.booking_id)) || null;
    const sent = specimen
      ? SPECIMEN_SENT_STATES.has(String(specimen.status || '').toLowerCase())
      : Boolean(order.collected_at);
    return {
      ...base,
      state: sent ? 'sample_sent_awaiting_result' : 'ordered_awaiting_sample',
      investigation_id: Number(order.id),
      specimen_id: specimen ? Number(specimen.id) : null,
      ordered_at: order.requested_at,
    };
  }

  if (latest) {
    return {
      ...base, state: 'stale',
      value_text: latest.value_text ?? null,
      value_numeric: latest.value_numeric == null ? null : Number(latest.value_numeric),
      unit: latest.unit ?? null,
      abnormal_flag: latest.abnormal_flag ?? null,
      is_critical: isCriticalResult(latest),
      observed_at: observedAt(latest),
      source: latest.result_origin === 'external_lab' ? 'external' : 'lab_result',
      lab_result_id: Number(latest.id),
    };
  }
  return base;
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
  const criticalItems = required.filter((item) => item.state !== 'waived' && isCriticalResult(item)).map((item) => item.item_code);
  const autoManaged = check?.metadata?.auto_managed === true;
  const status = String(check?.status || 'pending').toLowerCase();
  const started = Boolean(caseRow?.actual_start_at);
  let nextStatus = null;
  let autoPendingReason = null;
  if (missing.length === 0) {
    if (settings.auto_pass === true && (status === 'pending' || (status === 'pass' && autoManaged))) {
      nextStatus = status === 'pass' ? null : 'pass';
    }
  } else if (status === 'pass' && autoManaged && !started) {
    nextStatus = 'pending';
    autoPendingReason = missing.map((m) => `${m.item} ${m.state.replace(/_/g, ' ')}`).join('; ');
  }
  return { nextStatus, criticalWarning: criticalItems.length > 0, criticalItems, missing, autoPendingReason };
}
