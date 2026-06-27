// src/middleware/prometheusMiddleware.js
// Lightweight Prometheus metrics collection without external dependencies.
// Exposes histograms, counters, and gauges in Prometheus exposition format.

// The pg pool was retired in batch 28 and the db_pool_* gauges are zeroed
// out below — there's no DB client needed at this layer anymore.
import { isRedisConnected } from '../lib/redis.js';
import { Histogram, Counter, Gauge } from '../observability/metricPrimitives.js';

// ---------------------------------------------------------------------------
// Metric instances
// ---------------------------------------------------------------------------

const httpRequestDuration = new Histogram(
  'http_request_duration_seconds',
  'HTTP request duration in seconds',
  ['method', 'route', 'status_code'],
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
);

const httpRequestsTotal = new Counter(
  'http_requests_total',
  'Total number of HTTP requests',
  ['method', 'route', 'status_code'],
);

const dbPoolTotal = new Gauge('db_pool_connections_total', 'Total DB pool connections', []);
const dbPoolIdle = new Gauge('db_pool_connections_idle', 'Idle DB pool connections', []);
const dbPoolWaiting = new Gauge('db_pool_connections_waiting', 'Waiting DB pool requests', []);

const redisConnected = new Gauge('redis_connected', 'Whether Redis is connected (1=yes, 0=no)', []);

const nodeMemoryRss = new Gauge('node_memory_rss_bytes', 'Node.js RSS memory in bytes', []);
const nodeMemoryHeapTotal = new Gauge('node_memory_heap_total_bytes', 'Node.js heap total in bytes', []);
const nodeMemoryHeapUsed = new Gauge('node_memory_heap_used_bytes', 'Node.js heap used in bytes', []);

const nodeUptimeSeconds = new Gauge('node_uptime_seconds', 'Node.js process uptime in seconds', []);

// Postgres 42P01 (undefined_table) graceful-fallback counter (WS2 / REL-5).
// Incremented by src/lib/prisma.js whenever a 42P01 error is caught and the
// caller is expected to fall back gracefully (e.g. a missing-table read during
// a migration window or a downtime mirror serving static packs). A rising
// value is an early signal of schema drift / a partition the fallback path is
// papering over. No labels — a single named series is enough to alert on.
const dbUndefinedTableFallbackTotal = new Counter(
  'db_undefined_table_fallback_total',
  'Postgres 42P01 (undefined_table) errors that triggered a graceful fallback',
  [],
);

/**
 * Record a single Postgres 42P01 (undefined_table) graceful fallback.
 *
 * Exported as an incrementer (not the Counter instance) so consumers — chiefly
 * src/lib/prisma.js — depend only on this function. prometheusMiddleware.js
 * does NOT import prisma.js; keeping the surface a bare function avoids any
 * import cycle (prisma.js must never pull the Counter class or this module's
 * Redis import into its own load graph beyond this one symbol).
 */
export function recordUndefinedTableFallback() {
  dbUndefinedTableFallbackTotal.inc({});
}

// Clinical-AI deep/critical silent-template-fallback counter (deep-tier
// readiness gate). A module declared `model_tier:'deep'` — or any
// critical-risk / clinician-signoff module — that drops to the deterministic
// TEMPLATE draft (ai_metadata.used_ai=false) when the deep model isn't
// pulled/reachable is a SAFETY signal: clinicians receive template drafts
// believing they are AI-assisted. This degradation used to be silent (no
// startup assertion, no metric). Labelled by module + tier so ops can alert
// per-module (e.g. medication_reconciliation must never trend up once live).
const clinicalAiDeepTemplateFallbackTotal = new Counter(
  'clinical_ai_deep_template_fallback_total',
  'Deep-tier or critical/signoff clinical AI generations that silently fell back to a template draft',
  ['module', 'tier'],
);

/**
 * Record a single deep-tier / critical clinical-AI template fallback.
 *
 * Exported as a bare incrementer (not the Counter instance) for the exact
 * reason recordUndefinedTableFallback is: the caller (src/services/ai/
 * localLlmClient.js) must depend only on this function symbol, never on the
 * Counter class or this module's other imports — that keeps the AI client's
 * load graph free of any import cycle through the metrics layer.
 *
 * `module` / `tier` are bounded, low-cardinality labels (a fixed module
 * register + {quick,deep}); empty/unknown values collapse to '' which the
 * Counter renders harmlessly.
 */
export function recordDeepTemplateFallback({ module = '', tier = '' } = {}) {
  clinicalAiDeepTemplateFallbackTotal.inc({ module: String(module || ''), tier: String(tier || '') });
}

// ---------------------------------------------------------------------------
// Middleware — records request duration and count
// ---------------------------------------------------------------------------

// Patterns that collapse high-cardinality / PHI-bearing path segments to
// stable placeholders. Mirrors src/utils/sentryScrubber.js#normalizeSentryPath
// (kept inline rather than imported: this metrics module is intentionally
// dependency-light — it must not pull the Sentry scrubber's graph in just for
// one regex, and prisma.js imports a symbol from here so the load graph stays
// shallow). UUID first (would otherwise be partially eaten by the numeric
// rule), then VH-#### hospital ids, E.164 phones, bare 10-digit mobiles, and
// long numeric ids. Order matters.
const ROUTE_LABEL_PATTERNS = [
  [/\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi, '/:uuid'],
  [/\/VH-\d{4,}(?=\/|$)/gi, '/:hospitalId'],
  // Phone: a +-prefixed or separator-bearing number (a bare digit run is
  // treated as a numeric id by the next rule, not a phone — both are safe
  // placeholders, this just keeps the label intuitive).
  [/\/\+\d[\d\s-]{7,}\d(?=\/|$)/g, '/:phone'],
  [/\/\d[\d\s-]*[\s-][\d\s-]*\d(?=\/|$)/g, '/:phone'],
  [/\/\d+(?=\/|$)/g, '/:id'],
];

// Above this many path segments we assume the request never matched an Express
// route (matched routes use req.route.path and never reach this fallback) — a
// 404 / probe sweep otherwise mints a unique label per URL. Real deep API
// routes always match a pattern, so they never hit this cap.
const MAX_ROUTE_SEGMENTS = 6;

export function normalizeRoute(req) {
  // Use the matched Express route pattern when available to avoid high cardinality
  if (req.route && req.route.path) {
    return req.baseUrl + req.route.path;
  }
  // Fallback: collapse UUID / hospital-id / phone / numeric segments so an
  // unmatched path can neither carry PHI into a metric label nor explode
  // label cardinality. Strip any query string first (defensive — req.path
  // normally excludes it).
  let path = String(req.path || '').split('?')[0] || '/';
  for (const [pattern, replacement] of ROUTE_LABEL_PATTERNS) {
    path = path.replace(pattern, replacement);
  }
  // Catch-all: an over-deep path that still didn't match any route is a
  // never-seen surface — fold it into one bucket instead of a unique label.
  const segments = path.split('/').filter(Boolean);
  if (segments.length > MAX_ROUTE_SEGMENTS) {
    return '/__unmatched__';
  }
  return path;
}

export function prometheusMiddleware(req, res, next) {
  // Skip the metrics endpoint itself to avoid self-referential noise
  if (req.path === '/metrics') return next();

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;
    const route = normalizeRoute(req);
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    httpRequestDuration.observe(labels, durationSec);
    httpRequestsTotal.inc(labels);
  });
  next();
}

// ---------------------------------------------------------------------------
// Snapshot — refresh gauges just before scrape
// ---------------------------------------------------------------------------

function refreshGauges() {
  // Memory
  const mem = process.memoryUsage();
  nodeMemoryRss.set({}, mem.rss);
  nodeMemoryHeapTotal.set({}, mem.heapTotal);
  nodeMemoryHeapUsed.set({}, mem.heapUsed);

  // Uptime
  nodeUptimeSeconds.set({}, Math.floor(process.uptime()));

  // DB pool — the pg pool was retired in batch 28 (consolidated onto Prisma).
  // Prisma doesn't expose totalCount / idleCount / waitingCount directly, so
  // we zero these gauges. If pool-level metrics become load-bearing we can
  // wire `prisma.$metrics.json()` here, but for now the per-query slow-log
  // + circuit-breaker signals from src/lib/prisma.js are the primary ops
  // visibility.
  dbPoolTotal.set({}, 0);
  dbPoolIdle.set({}, 0);
  dbPoolWaiting.set({}, 0);

  // Redis — reflect actual client connection state
  try {
    redisConnected.set({}, isRedisConnected() ? 1 : 0);
  } catch {
    redisConnected.set({}, 0);
  }
}

// ---------------------------------------------------------------------------
// Serialize all metrics in Prometheus exposition format
// ---------------------------------------------------------------------------

export function serializeMetrics() {
  refreshGauges();
  const sections = [
    httpRequestDuration.serialize(),
    httpRequestsTotal.serialize(),
    dbPoolTotal.serialize(),
    dbPoolIdle.serialize(),
    dbPoolWaiting.serialize(),
    redisConnected.serialize(),
    nodeMemoryRss.serialize(),
    nodeMemoryHeapTotal.serialize(),
    nodeMemoryHeapUsed.serialize(),
    nodeUptimeSeconds.serialize(),
    dbUndefinedTableFallbackTotal.serialize(),
    clinicalAiDeepTemplateFallbackTotal.serialize(),
  ];
  return sections.filter(Boolean).join('\n\n') + '\n';
}

export default prometheusMiddleware;
