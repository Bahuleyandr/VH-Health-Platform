// src/observability/escalationMetrics.js
// Prometheus counters for the clinical escalation engine's fan-out honesty.
//
// runEscalationSweep pages humans about unacknowledged critical results, so any
// place it drops work or a recipient on the floor is clinical-safety-adjacent.
// The engine bounds two things, and each bound is counted here and paired with a
// Winston warning at the call site (services/workflow/escalationEngineService.js)
// so a trim is never a silent truncation:
//
//   * recipientsTrimmed — a notify tier resolved MORE active users in the role
//     (or its family fallback) than ESCALATION_RECIPIENT_FANOUT_CAP allows, so
//     the tail of that page was not notified.
//   * candidatePageFull  — a rule's candidate-task page came back exactly full,
//     so tasks past the page were not evaluated in that sweep.
//
// Label cardinality: role codes come from operator-authored
// escalation_rules.action_payload.notify_role, so they are shape-guarded to a
// bounded upper-snake token (the continuityMetrics REASON_PATTERN precedent) and
// anything else collapses to UNKNOWN. tenant_id is deliberately NOT a label —
// it is unbounded in a multi-tenant deployment and belongs in the warning log,
// which carries the full per-event detail.

import { Counter } from './metricPrimitives.js';

const recipientsTrimmed = new Counter(
  'vhhealth_escalation_recipients_trimmed_total',
  'Active users dropped from an escalation tier because the role fan-out exceeded its configured cap',
  ['role', 'arm'],
);

const candidatePageFull = new Counter(
  'vhhealth_escalation_candidate_page_full_total',
  'Escalation sweeps where a rule filled its entire candidate-task page, leaving later tasks unevaluated',
  ['trigger_condition'],
);

// Role labels are operator-authored; bound their shape so a typo cannot mint an
// unbounded label dimension.
const ROLE_LABEL_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;

function roleLabel(role) {
  const normalized = String(role ?? '').trim().toUpperCase();
  return ROLE_LABEL_PATTERN.test(normalized) ? normalized : 'UNKNOWN';
}

function positiveCount(value, label) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new TypeError(`${label} must be a finite positive number`);
  }
  return normalized;
}

/**
 * Record that `dropped` active users in `role` were cut from an escalation tier.
 *
 * @param {object} args
 * @param {string} args.role    Concrete role code the tier resolved to.
 * @param {'exact'|'family'} args.arm  Which resolution arm trimmed.
 * @param {number} args.dropped How many recipients were NOT notified (> 0).
 */
export function recordEscalationRecipientsTrimmed({ role, arm, dropped }) {
  recipientsTrimmed.inc(
    { role: roleLabel(role), arm: arm === 'family' ? 'family' : 'exact' },
    positiveCount(dropped, 'dropped'),
  );
}

/**
 * Record that a rule's candidate-task page came back full, so tasks beyond the
 * page were not evaluated in this sweep.
 *
 * @param {object} args
 * @param {string} args.triggerCondition The rule's trigger_condition.
 */
export function recordEscalationCandidatePageFull({ triggerCondition }) {
  const condition = String(triggerCondition ?? '').trim();
  candidatePageFull.inc({
    trigger_condition: /^[a-z][a-z0-9_]{0,39}$/.test(condition) ? condition : 'unknown',
  });
}

export function serializeEscalationMetrics() {
  return [recipientsTrimmed, candidatePageFull]
    .map((metric) => metric.serialize())
    .filter(Boolean)
    .join('\n\n') + '\n';
}

export default {
  recordEscalationCandidatePageFull,
  recordEscalationRecipientsTrimmed,
  serializeEscalationMetrics,
};
