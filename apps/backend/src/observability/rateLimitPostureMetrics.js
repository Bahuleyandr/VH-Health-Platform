// src/observability/rateLimitPostureMetrics.js
//
// Gap-audit 2026-08 (#873 follow-up): the rate-limit store posture
// (breaker state, degraded-since, probe counters) was reachable only through
// rateLimitStoreStatus() on the JSON GET /health/metrics — which nothing
// scrapes. Prometheus scrapes GET /metrics, whose serializer chain never
// included it, so a store-loss posture flip (fail-closed profiles answering
// 429, fail-open passing unmetered) was invisible to alerting.
//
// This module exports the posture as Prometheus families appended to the
// /metrics chain (metricsRoutes.js) and alerted on by
// infra/kubernetes/base/monitoring/backend-reliability-alerts.yaml
// (RateLimitStoreDegraded, WsFanoutSubscriberDown).
//
// Read-on-serialize: every gauge is refreshed inside serialize from the
// side-effect-free posture snapshots (rateLimitStoreStatus() uses
// peekStoreAccess(), which never consumes the breaker's half-open probe
// token — the 8745738eb invariant; isWsFanoutReady() is a plain flag read).
// Cheap, no collector loop needed.
//
// These are also the two signals behind the readiness probe's 873-F2/F10
// `degraded` block (uptimeRoutes.js /health/ready): the store posture and the
// cross-pod WS fan-out subscriber. Exporting them here gives the scraped
// plane the same honesty the readiness payload already has.
import { rateLimitStoreStatus } from '../middleware/rateLimitStoreHealth.js';
// lib/redis.js is imported as a namespace on purpose (same rationale as
// rateLimitStoreHealth.js): several suites mock that module with partial
// export sets, and a static named import of a newer export would break their
// module graphs at load.
import * as redisLib from '../lib/redis.js';
import { isWsFanoutReady } from '../utils/websocket/wsServer.js';
import { Gauge } from './metricPrimitives.js';

// All families are gauges on purpose. deniedWhileDown/passedUnmeteredWhileDown
// reset when the store recovers (rateLimitStoreHealth noteUp()), so they are
// NOT monotonic and must not be exposed with counter semantics; storeErrors
// and probes only reset on process restart, which gauge consumers handle the
// same way they would a counter reset.
const storeDegraded = new Gauge(
  'vh_rate_limit_store_degraded',
  'Redis rate-limit store posture: 1 while degraded (fail-closed profiles answer 429, fail-open pass unmetered), 0 when healthy or not configured',
);
const storeNotConfigured = new Gauge(
  'vh_rate_limit_store_not_configured',
  '1 when no Redis rate-limit store is configured (per-process MemoryStore; store loss not applicable) — distinguishes a healthy 0 from a not-applicable 0 on vh_rate_limit_store_degraded',
);
const storeDegradedSince = new Gauge(
  'vh_rate_limit_store_degraded_since_timestamp_seconds',
  'Unix timestamp since when the rate-limit store has been degraded; 0 when not degraded',
);
const storeErrors = new Gauge(
  'vh_rate_limit_store_errors',
  'Rate-limit store commands that failed since process start (resets on restart only)',
);
const storeProbes = new Gauge(
  'vh_rate_limit_store_probes',
  'Half-open breaker probes granted against the rate-limit store since process start (resets on restart only)',
);
const storeDeniedWhileDown = new Gauge(
  'vh_rate_limit_store_denied_while_down',
  'Requests answered 429 by fail-closed profiles during the CURRENT store outage (resets to 0 on recovery)',
);
const storePassedUnmeteredWhileDown = new Gauge(
  'vh_rate_limit_store_passed_unmetered_while_down',
  'Requests passed unmetered by fail-open profiles during the CURRENT store outage (resets to 0 on recovery)',
);
const wsFanoutReady = new Gauge(
  'vh_redis_ws_fanout_ready',
  'Cross-pod WebSocket fan-out subscriber state: 1 subscribed, 0 down (broadcasts single-process only). Emitted only when Redis is configured — the alert rule deliberately has no absent() arm',
);

function refresh() {
  const status = rateLimitStoreStatus();
  storeNotConfigured.set({}, status.state === 'not_configured' ? 1 : 0);
  storeDegraded.set({}, status.state === 'degraded' ? 1 : 0);
  const downSince = status.down_since ? Date.parse(status.down_since) : NaN;
  storeDegradedSince.set({}, Number.isFinite(downSince) ? Math.floor(downSince / 1000) : 0);
  const counters = status.counters || {};
  storeErrors.set({}, Number(counters.storeErrors ?? 0));
  storeProbes.set({}, Number(counters.probes ?? 0));
  storeDeniedWhileDown.set({}, Number(counters.deniedWhileDown ?? 0));
  storePassedUnmeteredWhileDown.set({}, Number(counters.passedUnmeteredWhileDown ?? 0));
  // Mirror the readiness probe's gate (873-F10): the fan-out signal is only
  // meaningful when Redis is configured at all; a Redis-less deployment must
  // not look "deaf" to the WsFanoutSubscriberDown rule.
  const required = redisLib.redisIsRequired ? redisLib.redisIsRequired() : false;
  const configured = redisLib.isRedisConfigured ? redisLib.isRedisConfigured() : false;
  if (required || configured) {
    wsFanoutReady.set({}, isWsFanoutReady() ? 1 : 0);
    return true;
  }
  return false;
}

export function serializeRateLimitPostureMetrics() {
  const emitWsFanout = refresh();
  const metrics = [
    storeDegraded,
    storeNotConfigured,
    storeDegradedSince,
    storeErrors,
    storeProbes,
    storeDeniedWhileDown,
    storePassedUnmeteredWhileDown,
  ];
  if (emitWsFanout) metrics.push(wsFanoutReady);
  return metrics.map((m) => m.serialize()).join('\n\n') + '\n';
}

export default { serializeRateLimitPostureMetrics };
