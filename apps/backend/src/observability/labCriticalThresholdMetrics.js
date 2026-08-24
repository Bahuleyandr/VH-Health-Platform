// src/observability/labCriticalThresholdMetrics.js
// Prometheus counter for critical-threshold lookups on the lab result-recording
// path.
//
// WHY THIS EXISTS. lab_critical_thresholds is seeded for the default tenant
// only (migrations 151/193) and has no INSERT path anywhere in non-test source,
// so a second tenant's table is empty — and evaluateCriticalThreshold answers a
// zero-row lookup with `matched:false`, the same answer it gives for an analyte
// that legitimately has no critical limit. A tenant that can never raise a
// critical lab alert was therefore indistinguishable from one whose results are
// all fine. The 2026-08-24 tenancy re-audit tried to close that by copying the
// default tenant's rows into every tenant; that was withdrawn twice (a copied
// row ties the reader's best match rank, and thresholds must agree with
// lab_reference_ranges or labPanelService rejects the result), so the remaining
// engineering fix is to make the absence VISIBLE. The gap itself is parked in
// docs/ROADMAP.md.
//
// `outcome` partitions every lookup that got as far as querying the table:
//
//   * matched   — at least one active threshold row matched the analyte. The
//     evaluation may still fail afterwards (unit mismatch, population scope,
//     ambiguity); this counter is about the LOOKUP.
//   * unmatched — no active threshold covered this analyte for this tenant.
//     Ordinary for most analytes; sustained across ALL analytes it means the
//     tenant cannot raise a critical lab alert at all. Distinguishing those
//     two needs a second query, which must not run here — see the note above
//     CRITICAL_THRESHOLD_LOOKUP_OUTCOMES. The canary check answers it instead.
//
// Label cardinality: tenant_id and analyte codes are deliberately NOT labels —
// both are unbounded in a multi-tenant deployment with an operator-authored
// test menu (the escalationMetrics precedent). They belong in the warning log,
// which carries the full per-event detail.

import { Counter } from './metricPrimitives.js';

const criticalThresholdLookups = new Counter(
  'vhhealth_lab_critical_threshold_lookups_total',
  'Critical-threshold lookups on the lab result-recording path by outcome '
    + '(unmatched = no active threshold covered this analyte for this tenant)',
  ['outcome'],
);

// Deliberately only what the lookup ALREADY knows. Splitting `unmatched` into
// analyte- vs tenant-unconfigured needed a second query, and every production
// caller passes its open transaction — a failed statement aborts it, and the
// swallowed rejection surfaced as 25P02 on the next write, so the lab result
// was not recorded. Observability on a clinical write path adds no statement.
// The tenant-wide question is answered by the canary check (utils/canaryHealthCheck.js),
// which runs on its own connection.
export const CRITICAL_THRESHOLD_LOOKUP_OUTCOMES = Object.freeze([
  'matched',
  'unmatched',
]);

const ALLOWED_OUTCOMES = new Set(CRITICAL_THRESHOLD_LOOKUP_OUTCOMES);

/**
 * Count one critical-threshold lookup.
 *
 * @param {'matched'|'unmatched'} outcome
 *   Anything else is recorded as `unmatched` rather than minting a label.
 */
export function recordCriticalThresholdLookup(outcome) {
  criticalThresholdLookups.inc({
    outcome: ALLOWED_OUTCOMES.has(outcome) ? outcome : 'unmatched',
  }, 1);
}

export function serializeLabCriticalThresholdMetrics() {
  return criticalThresholdLookups.serialize();
}

export default {
  CRITICAL_THRESHOLD_LOOKUP_OUTCOMES,
  recordCriticalThresholdLookup,
  serializeLabCriticalThresholdMetrics,
};
