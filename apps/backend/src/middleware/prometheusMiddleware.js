// src/middleware/prometheusMiddleware.js
// Lightweight Prometheus metrics collection without external dependencies.
// Exposes histograms, counters, and gauges in Prometheus exposition format.

// The pg pool was retired in batch 28 and the db_pool_* gauges are zeroed
// out below — there's no DB client needed at this layer anymore.
import { isRedisConnected } from '../lib/redis.js';

// ---------------------------------------------------------------------------
// Histogram helper — fixed buckets, no external lib needed
// ---------------------------------------------------------------------------

class Histogram {
  constructor(name, help, labelNames, buckets) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.buckets = buckets;
    // key = sorted label string, value = { counts: [per-bucket], sum, count }
    this.data = new Map();
  }

  _key(labels) {
    return this.labelNames.map((n) => `${n}="${labels[n] || ''}"`).join(',');
  }

  _entry(labels) {
    const k = this._key(labels);
    if (!this.data.has(k)) {
      this.data.set(k, { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 });
    }
    return this.data.get(k);
  }

  observe(labels, value) {
    const entry = this._entry(labels);
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) entry.counts[i]++;
    }
    entry.sum += value;
    entry.count++;
  }

  serialize() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [, entry] of this.data) {
      const lblStr = this.labelNames.map((n) => `${n}="${entry.labels[n] || ''}"`).join(',');
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative += entry.counts[i];
        lines.push(`${this.name}_bucket{${lblStr},le="${this.buckets[i]}"} ${cumulative}`);
      }
      lines.push(`${this.name}_bucket{${lblStr},le="+Inf"} ${entry.count}`);
      lines.push(`${this.name}_sum{${lblStr}} ${entry.sum}`);
      lines.push(`${this.name}_count{${lblStr}} ${entry.count}`);
    }
    return lines.join('\n');
  }
}

class Counter {
  constructor(name, help, labelNames) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.data = new Map();
  }

  _key(labels) {
    return this.labelNames.map((n) => `${n}="${labels[n] || ''}"`).join(',');
  }

  inc(labels, val = 1) {
    const k = this._key(labels);
    this.data.set(k, { labels, value: (this.data.get(k)?.value || 0) + val });
  }

  serialize() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [, entry] of this.data) {
      const lblStr = this.labelNames.map((n) => `${n}="${entry.labels[n] || ''}"`).join(',');
      lines.push(`${this.name}{${lblStr}} ${entry.value}`);
    }
    return lines.join('\n');
  }
}

class Gauge {
  constructor(name, help, labelNames = []) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.data = new Map();
  }

  set(labels, value) {
    const k = this.labelNames.map((n) => `${n}="${labels[n] || ''}"`).join(',');
    this.data.set(k, { labels, value });
  }

  serialize() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [, entry] of this.data) {
      const lblStr = this.labelNames.length
        ? '{' + this.labelNames.map((n) => `${n}="${entry.labels[n] || ''}"`).join(',') + '}'
        : '';
      lines.push(`${this.name}${lblStr} ${entry.value}`);
    }
    return lines.join('\n');
  }
}

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

// ---------------------------------------------------------------------------
// Middleware — records request duration and count
// ---------------------------------------------------------------------------

function normalizeRoute(req) {
  // Use the matched Express route pattern when available to avoid high cardinality
  if (req.route && req.route.path) {
    return req.baseUrl + req.route.path;
  }
  // Fallback: collapse numeric path segments
  return req.path.replace(/\/\d+/g, '/:id');
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
  ];
  return sections.filter(Boolean).join('\n\n') + '\n';
}

export default prometheusMiddleware;
