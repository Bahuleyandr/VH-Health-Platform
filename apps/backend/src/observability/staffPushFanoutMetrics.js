// src/observability/staffPushFanoutMetrics.js
//
// Counters for the tenant-scoped staff push fan-out (staffPushRecipientService).
//
// Deliberately dependency-light: this module imports ONLY metricPrimitives so it
// can be recorded to from controllers and services without dragging prisma or
// pathway config into their import graph (the reason these counters do not live
// in reliabilityMetrics.js, which imports both).
//
// Reaching GET /metrics is NOT automatic — Counter has no global registry. A new
// serializer only gets scraped once it is imported + concatenated in
// src/routes/metrics/metricsRoutes.js. That wiring is done for this module.

import { Counter } from './metricPrimitives.js';

// Recipients that matched the tenant-scoped predicate but were evicted by the cap.
// Incremented by the exact number dropped (COUNT(*) OVER () - page size), so the
// counter reports true lost reach rather than "a trim happened".
const staffPushRecipientsTrimmed = new Counter(
  'vhhealth_staff_push_recipients_trimmed_total',
  'Staff push recipients dropped by the fan-out cap, by alert type',
  ['alert'],
);

// Fan-outs that resolved ZERO recipients. This is the tenant-scoping regression
// canary: because users.tenant_id carries a DEFAULT and several staff-onboarding
// paths omit it, staff can sit on the default tenant while bookings are created
// under another — in which case a correctly tenant-scoped query legitimately
// matches nobody and the alert silently never sends. Without this counter that
// failure is indistinguishable from "no staff on shift".
const staffPushZeroRecipients = new Counter(
  'vhhealth_staff_push_zero_recipients_total',
  'Staff push fan-outs that resolved zero eligible recipients, by alert type',
  ['alert'],
);

// Fan-outs that threw. The call sites are fire-and-forget inside a swallowing
// try/catch, so without this a delivery failure is one Winston line and no signal.
const staffPushFanoutFailures = new Counter(
  'vhhealth_staff_push_fanout_failures_total',
  'Staff push fan-outs that failed before delivery, by alert type',
  ['alert'],
);

export function recordStaffPushRecipientsTrimmed(alert, dropped) {
  if (dropped > 0) staffPushRecipientsTrimmed.inc({ alert }, dropped);
}

export function recordStaffPushZeroRecipients(alert) {
  staffPushZeroRecipients.inc({ alert });
}

export function recordStaffPushFanoutFailure(alert) {
  staffPushFanoutFailures.inc({ alert });
}

export function serializeStaffPushFanoutMetrics() {
  return [
    staffPushRecipientsTrimmed,
    staffPushZeroRecipients,
    staffPushFanoutFailures,
  ].map((metric) => metric.serialize()).filter(Boolean).join('\n\n') + '\n';
}

export default {
  recordStaffPushRecipientsTrimmed,
  recordStaffPushZeroRecipients,
  recordStaffPushFanoutFailure,
  serializeStaffPushFanoutMetrics,
};
