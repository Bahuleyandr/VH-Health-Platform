# Observability Alert Tier — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrument the unmonitored backend reliability machinery (event_outbox drain/dead-letter, webhook + notification backlog, WS broadcast drops, DB circuit breaker) as Prometheus metrics, then add reliability + 99.95% SLO burn-rate alerts and RED + reliability Grafana dashboards-as-code.

**Architecture:** A periodic in-process collector sets DB-derived gauges (cheap aggregate queries) and inline counters increment at event sites; the existing custom exporter serializes them. Alerts + SLO rules + dashboards are kube-prometheus-stack CRs/ConfigMaps picked up by the operator (label `release: vhhealth-monitoring`). Backend code (Units 1–2) is TDD'd + QA-cluster-verified; infra (Units 3–4) is promtool/JSON-lint-validated only — deploy is HELD, so alerts cannot be live-fired (stated honestly, not faked).

**Tech Stack:** Node 22 / Express 5, the custom dependency-free metrics exporter in `src/middleware/prometheusMiddleware.js`, Jest (ESM, `--experimental-vm-modules`) on the QA cluster (`postgresql://postgres@127.0.0.1:55432/vhhealth_test`), kube-prometheus-stack (Prometheus 2.55 / Alertmanager 0.27 / Grafana 11.3), Kustomize.

**Spec:** `docs/superpowers/specs/2026-06-27-observability-alert-tier-design.md`
**Branch:** `feat/observability-alert-tier` (already created; spec committed at `ead1fccf`/`4b8c26a3`).

---

## File Structure

| File | Responsibility | Unit |
|---|---|---|
| `apps/backend/src/observability/metricPrimitives.js` | **Create.** The `Histogram`/`Counter`/`Gauge` exposition-format classes, moved verbatim out of `prometheusMiddleware.js` so two modules can share them. | 1 |
| `apps/backend/src/middleware/prometheusMiddleware.js` | **Modify.** Import the 3 classes from `metricPrimitives.js` instead of defining them. No behavior change. | 1 |
| `apps/backend/src/observability/reliabilityMetrics.js` | **Create.** The reliability gauges + counters, the `collectReliabilityMetrics()` collector, `serializeReliabilityMetrics()`, and the inline recorders (`recordWsBroadcastDropped`, `recordEventDeadLettered`). | 2 |
| `apps/backend/src/utils/websocket/wsServer.js` | **Modify.** Call `recordWsBroadcastDropped(reason)` at the two observable drop sites (backpressure skip, fan-out local-fallback). | 2 |
| `apps/backend/src/utils/websocket/wsRedisAdapter.js` | **Modify.** Call `recordWsFanoutSubscriberError()` in the subscriber `error` handler (failover-window proxy). | 2 |
| `apps/backend/src/services/events/eventOutboxService.js` | **Modify.** Call `recordEventDeadLettered()` in the `markFailed` dead-letter branch. | 2 |
| `apps/backend/src/routes/metrics/metricsRoutes.js` | **Modify.** Append `serializeReliabilityMetrics()` to the `/metrics` body. | 2 |
| `apps/backend/src/bin/www.js` | **Modify.** Start the collector interval (unref'd) after `server.listen(PORT)`. | 2 |
| `apps/backend/src/tests/unit/metricPrimitives.test.js` | **Create.** Unit test the 3 primitives serialize correctly from the new path. | 1 |
| `apps/backend/src/tests/unit/reliabilityMetrics.test.js` | **Create.** Unit test the recorders/serializer + the collector's DB-error tolerance. | 2 |
| `apps/backend/src/tests/reliability-metrics.deep.test.js` | **Create.** QA-cluster integration: seed outbox/webhook/notification rows, run the collector, assert the exposition values. | 2 |
| `infra/kubernetes/base/monitoring/backend-reliability-alerts.yaml` | **Create.** PrometheusRule: reliability alerts + the 2 unalerted safety counters. | 3 |
| `infra/kubernetes/base/monitoring/backend-slo.yaml` | **Create.** PrometheusRule: 99.95% error-budget recording rules + multi-window multi-burn-rate alerts. | 4 |
| `infra/kubernetes/base/monitoring/dashboards/vhhealth-backend-red.json` | **Create.** RED Grafana dashboard. | 4 |
| `infra/kubernetes/base/monitoring/dashboards/vhhealth-backend-reliability.json` | **Create.** Reliability Grafana dashboard. | 4 |
| `infra/kubernetes/base/monitoring/dashboards-configmap.yaml` | **Create.** ConfigMaps wrapping the 2 dashboard JSONs, labelled `grafana_dashboard: "1"`. | 4 |
| `infra/kubernetes/base/monitoring/kustomization.yaml` | **Modify.** Add the 3 new resource files. | 3,4 |
| `infra/kubernetes/base/monitoring/validate-monitoring.mjs` | **Create.** Local/CI validator: `promtool check rules` over the PrometheusRule files + `JSON.parse` the dashboards. | 4 |
| `docs/RUNBOOK_ONCALL.md` | **Modify.** Add a runbook section per new alert. | 3,4 |

**Status name reference (confirmed by reading the services — do not re-guess):**
- `event_outbox.status`: `pending` / `processing` / `delivered` / `failed`. **`failed` IS the dead-letter** (`markFailed` parks rows there at `attempts >= MAX_ATTEMPTS (7)`; below the cap they return to `pending`).
- `webhook_deliveries.status`: `pending` / `failed` / `dead`. **`dead` is the terminal undelivered state.**
- `notification_outbox.status`: **UPPERCASE** `PENDING` / `SENT` / `FAILED`.
- `circuitBreakerStatus()` returns `{ open: <bool>, consecutiveFailures, openedAt, resetInMs, byTag }`.

---

## Unit 1 — Metric primitives (no behavior change)

### Task 1: Extract Histogram/Counter/Gauge to a shared module

**Files:**
- Create: `apps/backend/src/observability/metricPrimitives.js`
- Modify: `apps/backend/src/middleware/prometheusMiddleware.js` (lines 13–111 — the three class definitions)
- Test: `apps/backend/src/tests/unit/metricPrimitives.test.js`

- [ ] **Step 1: Create `metricPrimitives.js` with the three classes moved verbatim**

Move the existing `Histogram`, `Counter`, and `Gauge` classes out of `prometheusMiddleware.js` into the new file and `export` each. The bodies are copied unchanged from `prometheusMiddleware.js`:

```js
// src/observability/metricPrimitives.js
// Prometheus exposition-format metric primitives — no external dependency.
// Moved out of middleware/prometheusMiddleware.js (2026-06-27) so the RED
// middleware and the reliability collector can share one implementation.

export class Histogram {
  constructor(name, help, labelNames, buckets) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.buckets = buckets;
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

export class Counter {
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

export class Gauge {
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
```

- [ ] **Step 2: Replace the class definitions in `prometheusMiddleware.js` with an import**

Delete the three `class Histogram {…}` / `class Counter {…}` / `class Gauge {…}` blocks (lines ~13–111) and add this import near the top (after the existing `import { isRedisConnected }` line):

```js
import { Histogram, Counter, Gauge } from '../observability/metricPrimitives.js';
```

Everything else in `prometheusMiddleware.js` (the metric instances `httpRequestDuration`, `httpRequestsTotal`, the gauges, `recordUndefinedTableFallback`, `recordDeepTemplateFallback`, `normalizeRoute`, `prometheusMiddleware`, `refreshGauges`, `serializeMetrics`) is unchanged.

- [ ] **Step 3: Write the primitives unit test**

```js
// src/tests/unit/metricPrimitives.test.js
import { Histogram, Counter, Gauge } from '../../observability/metricPrimitives.js';

describe('metricPrimitives', () => {
  it('Counter serializes labelled increments', () => {
    const c = new Counter('demo_total', 'demo', ['reason']);
    c.inc({ reason: 'a' });
    c.inc({ reason: 'a' });
    c.inc({ reason: 'b' }, 3);
    const out = c.serialize();
    expect(out).toContain('# TYPE demo_total counter');
    expect(out).toContain('demo_total{reason="a"} 2');
    expect(out).toContain('demo_total{reason="b"} 3');
  });

  it('Gauge serializes a label-free series', () => {
    const g = new Gauge('demo_depth', 'demo');
    g.set({}, 42);
    expect(g.serialize()).toContain('demo_depth 42');
  });

  it('Histogram emits cumulative buckets + sum + count', () => {
    const h = new Histogram('demo_seconds', 'demo', ['route'], [0.1, 0.5, 1]);
    h.observe({ route: '/x' }, 0.2);
    h.observe({ route: '/x' }, 0.7);
    const out = h.serialize();
    expect(out).toContain('demo_seconds_bucket{route="/x",le="0.5"} 1');
    expect(out).toContain('demo_seconds_bucket{route="/x",le="+Inf"} 2');
    expect(out).toContain('demo_seconds_count{route="/x"} 2');
  });
});
```

- [ ] **Step 4: Run the new test + the existing exporter tests (prove no behavior change)**

Run (from `apps/backend`):
```
node --experimental-vm-modules --max-old-space-size=4096 node_modules/jest/bin/jest.js --runInBand metricPrimitives prometheusNormalizeRoute --forceExit
```
Expected: both suites PASS. Then lint:
```
npm run lint
```
Expected: exit 0.

- [ ] **Step 5: Commit**

```
git add apps/backend/src/observability/metricPrimitives.js apps/backend/src/middleware/prometheusMiddleware.js apps/backend/src/tests/unit/metricPrimitives.test.js
git commit -m "refactor(metrics): extract Histogram/Counter/Gauge to observability/metricPrimitives.js (no behavior change)"
```

---

## Unit 2 — Reliability metrics + collector

### Task 2: Reliability metric instances + recorders + serializer (no collector yet)

**Files:**
- Create: `apps/backend/src/observability/reliabilityMetrics.js`
- Test: `apps/backend/src/tests/unit/reliabilityMetrics.test.js`

- [ ] **Step 1: Write the failing serializer test**

```js
// src/tests/unit/reliabilityMetrics.test.js
import {
  recordWsBroadcastDropped,
  recordEventDeadLettered,
  recordWsFanoutSubscriberError,
  serializeReliabilityMetrics,
} from '../../observability/reliabilityMetrics.js';

describe('reliabilityMetrics serialization', () => {
  it('emits HELP/TYPE for every gauge + counter', () => {
    const out = serializeReliabilityMetrics();
    for (const name of [
      'event_outbox_pending_rows',
      'event_outbox_oldest_pending_age_seconds',
      'event_outbox_dead_letter_rows',
      'notification_outbox_pending_rows',
      'webhook_deliveries_pending_rows',
      'webhook_deliveries_failed_rows',
      'webhook_deliveries_dead_rows',
      'db_circuit_breaker_open',
      'ws_broadcast_dropped_total',
      'ws_fanout_subscriber_errors_total',
      'event_outbox_dead_lettered_total',
    ]) {
      expect(out).toContain(`# TYPE ${name}`);
    }
  });

  it('counters increment with bounded labels', () => {
    recordWsBroadcastDropped('backpressure');
    recordWsBroadcastDropped('backpressure');
    recordWsBroadcastDropped('fanout_local_fallback');
    recordWsFanoutSubscriberError();
    recordEventDeadLettered();
    const out = serializeReliabilityMetrics();
    expect(out).toContain('ws_broadcast_dropped_total{reason="backpressure"} 2');
    expect(out).toContain('ws_broadcast_dropped_total{reason="fanout_local_fallback"} 1');
    expect(out).toContain('ws_fanout_subscriber_errors_total 1');
    expect(out).toContain('event_outbox_dead_lettered_total 1');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand reliabilityMetrics --forceExit`
Expected: FAIL — `Cannot find module '../../observability/reliabilityMetrics.js'`.

- [ ] **Step 3: Implement `reliabilityMetrics.js` (instances + recorders + serializer; collector stub returns early)**

```js
// src/observability/reliabilityMetrics.js
// Reliability signal metrics for the event-outbox / webhook / WS-fan-out
// machinery. DB-derived gauges are refreshed by collectReliabilityMetrics()
// (a periodic in-process collector started in bin/www.js); counters increment
// inline at the event site. Appended to /metrics after the RED exporter.
//
// Status-name notes (do NOT re-guess):
//   event_outbox.status      pending|processing|delivered|failed  (failed = dead-letter @ MAX_ATTEMPTS=7)
//   webhook_deliveries.status pending|failed|dead                 (dead = terminal undelivered)
//   notification_outbox.status PENDING|SENT|FAILED                (UPPERCASE)
import prisma, { circuitBreakerStatus } from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { Gauge, Counter } from './metricPrimitives.js';

// ---- Gauges (set by the collector) ----------------------------------------
const eventOutboxPending = new Gauge('event_outbox_pending_rows', 'event_outbox rows in pending status');
const eventOutboxOldestAge = new Gauge('event_outbox_oldest_pending_age_seconds', 'Age of the oldest pending event_outbox row (seconds); 0 when none');
const eventOutboxDeadLetter = new Gauge('event_outbox_dead_letter_rows', 'event_outbox rows in the terminal failed (dead-letter) status');
const notificationOutboxPending = new Gauge('notification_outbox_pending_rows', 'notification_outbox rows in PENDING status');
const webhookPending = new Gauge('webhook_deliveries_pending_rows', 'webhook_deliveries rows in pending status');
const webhookFailed = new Gauge('webhook_deliveries_failed_rows', 'webhook_deliveries rows in failed status (retrying)');
const webhookDead = new Gauge('webhook_deliveries_dead_rows', 'webhook_deliveries rows in the terminal dead status (undelivered)');
const dbBreakerOpen = new Gauge('db_circuit_breaker_open', 'Whether any Prisma client circuit breaker is open (1=open, 0=closed)');

// ---- Counters (incremented inline at the event site) ----------------------
const wsBroadcastDropped = new Counter('ws_broadcast_dropped_total', 'Observable WS broadcast/sendToUser drops (per-socket backpressure or cross-process fan-out fallback). NOTE: the at-most-once Redis-failover drop is invisible to the app — see ws_fanout_subscriber_errors_total for the failover-window proxy.', ['reason']);
const wsFanoutSubscriberErrors = new Counter('ws_fanout_subscriber_errors_total', 'WS Redis fan-out subscriber error/reconnect events — the window during which a published broadcast can be silently dropped (at-most-once)', []);
const eventDeadLettered = new Counter('event_outbox_dead_lettered_total', 'event_outbox rows that crossed MAX_ATTEMPTS into the terminal failed (dead-letter) state', []);

// reason is a bounded, low-cardinality label. Anything unexpected collapses to 'other'.
const WS_DROP_REASONS = new Set(['backpressure', 'fanout_local_fallback', 'publish_error']);
export function recordWsBroadcastDropped(reason) {
  wsBroadcastDropped.inc({ reason: WS_DROP_REASONS.has(reason) ? reason : 'other' });
}
export function recordWsFanoutSubscriberError() {
  wsFanoutSubscriberErrors.inc({});
}
export function recordEventDeadLettered() {
  eventDeadLettered.inc({});
}

/**
 * Refresh the DB-derived gauges. ONE batched read per tick. Tolerant of a DB
 * error: logs + leaves the prior snapshot (a metrics collector must never throw
 * into the caller / crash the process).
 */
export async function collectReliabilityMetrics() {
  try {
    const [eo] = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')                                   AS pending,
        COUNT(*) FILTER (WHERE status = 'failed')                                    AS dead_letter,
        COALESCE(EXTRACT(EPOCH FROM (now() - MIN(available_at) FILTER (WHERE status = 'pending')))::bigint, 0) AS oldest_age
      FROM event_outbox
    `);
    eventOutboxPending.set({}, Number(eo?.pending ?? 0));
    eventOutboxDeadLetter.set({}, Number(eo?.dead_letter ?? 0));
    eventOutboxOldestAge.set({}, Number(eo?.oldest_age ?? 0));

    const [no] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FILTER (WHERE status = 'PENDING') AS pending FROM notification_outbox`,
    );
    notificationOutboxPending.set({}, Number(no?.pending ?? 0));

    const [wd] = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'failed')  AS failed,
        COUNT(*) FILTER (WHERE status = 'dead')    AS dead
      FROM webhook_deliveries
    `);
    webhookPending.set({}, Number(wd?.pending ?? 0));
    webhookFailed.set({}, Number(wd?.failed ?? 0));
    webhookDead.set({}, Number(wd?.dead ?? 0));

    dbBreakerOpen.set({}, circuitBreakerStatus().open ? 1 : 0);
  } catch (err) {
    logger.warn(`collectReliabilityMetrics: refresh skipped — ${err?.message || err}`);
  }
}

export function serializeReliabilityMetrics() {
  return [
    eventOutboxPending, eventOutboxOldestAge, eventOutboxDeadLetter,
    notificationOutboxPending,
    webhookPending, webhookFailed, webhookDead,
    dbBreakerOpen,
    wsBroadcastDropped, wsFanoutSubscriberErrors, eventDeadLettered,
  ].map((m) => m.serialize()).filter(Boolean).join('\n\n') + '\n';
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand reliabilityMetrics --forceExit`
Expected: PASS (both tests).

- [ ] **Step 5: Add the DB-error tolerance test**

Append to `reliabilityMetrics.test.js`:

```js
import { jest } from '@jest/globals';
// (place this block at top of the file with the other imports if your jest setup
//  requires mocks before import; here we test the swallow via a forced throw.)

describe('collectReliabilityMetrics tolerance', () => {
  it('does not throw when the DB query fails', async () => {
    const prismaMod = await import('../../lib/prisma.js');
    const spy = jest.spyOn(prismaMod.default, '$queryRawUnsafe').mockRejectedValue(new Error('db down'));
    const { collectReliabilityMetrics } = await import('../../observability/reliabilityMetrics.js');
    await expect(collectReliabilityMetrics()).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
```

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand reliabilityMetrics --forceExit`
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add apps/backend/src/observability/reliabilityMetrics.js apps/backend/src/tests/unit/reliabilityMetrics.test.js
git commit -m "feat(metrics): reliability gauges/counters + collector (event_outbox/webhook/notification/breaker/ws-drops)"
```

### Task 3: Wire the inline counters at their event sites

**Files:**
- Modify: `apps/backend/src/utils/websocket/wsServer.js` (drop sites ~310, ~327, ~376–380, ~397–399)
- Modify: `apps/backend/src/utils/websocket/wsRedisAdapter.js` (subscriber `error` handler, ~152)
- Modify: `apps/backend/src/services/events/eventOutboxService.js` (`markFailed` dead-letter branch, ~231)

- [ ] **Step 1: WS backpressure + fan-out-fallback drops in `wsServer.js`**

Add the import near the top:
```js
import { recordWsBroadcastDropped } from '../../observability/reliabilityMetrics.js';
```
In `deliverBroadcastLocal` and `deliverUserLocal`, at each `if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT) { … }` block, add the recorder before/with the existing `logger.warn`:
```js
    if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      recordWsBroadcastDropped('backpressure');
      logger.warn(`Skipping broadcast to slow WebSocket client (buffered: ${ws.bufferedAmount})`);
      continue; // (keep the existing control flow)
    }
```
At the two fan-out publish sites, count the cross-process fallback (remote pods miss the message). For broadcast (~376):
```js
  const published = fanout.publishBroadcast(channel, channel, data, tenantId);
  if (!published) {
    recordWsBroadcastDropped('fanout_local_fallback');
    deliverBroadcastLocal(channel, channel, data, tenantId);
  }
```
And the symmetric change at the `fanout.publishUser` site (~397). **Match the existing surrounding lines exactly** — only insert the `recordWsBroadcastDropped(...)` calls; do not change the delivery logic.

- [ ] **Step 2: Fan-out subscriber-error proxy in `wsRedisAdapter.js`**

Add the import near the top:
```js
import { recordWsFanoutSubscriberError } from '../../observability/reliabilityMetrics.js';
```
In `init()`, augment the subscriber error handler (currently `sub.on?.('error', (err) => logger.error(...))`):
```js
    sub.on?.('error', (err) => {
      recordWsFanoutSubscriberError();
      logger.error('WS fan-out subscriber error:', err?.message || err);
    });
```

- [ ] **Step 3: Dead-letter counter in `eventOutboxService.js`**

In `markFailed`, the branch is gated by `const deadLetter = nextAttempts >= MAX_ATTEMPTS;`. Add the import at the top:
```js
import { recordEventDeadLettered } from '../../observability/reliabilityMetrics.js';
```
Right where `deadLetter` is true and the row is written to `status = 'failed'`, record it once (place it after the successful UPDATE, before returning):
```js
    if (deadLetter) recordEventDeadLettered();
```
(Read the exact lines around the `status = 'failed'` UPDATE and insert the single call on the dead-letter path only — never on the back-to-pending path.)

- [ ] **Step 4: Verify the wiring compiles + lint**

Run (from `apps/backend`):
```
npm run lint
```
Expected: exit 0 (no unused-import / no-undef). A focused boot check:
```
node -e "import('./src/observability/reliabilityMetrics.js').then(()=>console.log('ok'))"
```
Expected: prints `ok`.

- [ ] **Step 5: Commit**

```
git add apps/backend/src/utils/websocket/wsServer.js apps/backend/src/utils/websocket/wsRedisAdapter.js apps/backend/src/services/events/eventOutboxService.js
git commit -m "feat(metrics): wire ws-drop / fanout-error / event-dead-letter counters at their event sites"
```

### Task 4: QA-cluster integration test for the collector

**Files:**
- Create: `apps/backend/src/tests/reliability-metrics.deep.test.js`

Pattern mirrors `discharge-save-outbox-atomicity.deep.test.js` (seed raw rows, run, assert). Requires the QA cluster up: `node apps/backend/scripts/qa-cluster-up.mjs`.

- [ ] **Step 1: Write the deep test**

```js
// src/tests/reliability-metrics.deep.test.js
// Proves collectReliabilityMetrics() reads the real reliability tables and that
// serializeReliabilityMetrics() reports the correct values. Seeds event_outbox
// (pending + failed/dead-letter), notification_outbox (PENDING), and
// webhook_deliveries (pending/failed/dead) under a unique marker, runs the
// collector, and asserts the gauge values reflect AT LEAST the seeded rows
// (other suites may add rows — assert >= seeded, and exact for the unique-age).
import { randomUUID } from 'crypto';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const prisma = (await import('../lib/prisma.js')).default;
const { collectReliabilityMetrics, serializeReliabilityMetrics } =
  await import('../observability/reliabilityMetrics.js');

const PATIENT_UID = randomUUID();
const MARK = `relmetrics-${PATIENT_UID.slice(0, 8)}`;

function gaugeValue(text, name) {
  // label-free gauge: a line `name <value>`
  const m = text.match(new RegExp(`^${name} (\\d+(?:\\.\\d+)?)$`, 'm'));
  return m ? Number(m[1]) : null;
}

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM event_outbox WHERE aggregate_type = $1`, MARK).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM webhook_deliveries WHERE event_type = $1`, MARK).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM notification_outbox WHERE channel = $1`, MARK).catch(() => {});
}

d('reliability metrics collector (QA DB)', () => {
  beforeAll(async () => {
    await cleanup();
    // event_outbox: 2 pending (one 1h old → oldest-age), 1 failed (dead-letter)
    await prisma.$executeRawUnsafe(
      `INSERT INTO event_outbox (event_type, aggregate_type, payload, status, available_at, created_at)
       VALUES ('x', $1, '{}'::jsonb, 'pending', now() - interval '1 hour', now()),
              ('x', $1, '{}'::jsonb, 'pending', now(), now()),
              ('x', $1, '{}'::jsonb, 'failed',  now(), now())`,
      MARK,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO webhook_deliveries (event_type, status, created_at)
       VALUES ($1, 'pending', now()), ($1, 'failed', now()), ($1, 'dead', now())`,
      MARK,
    ).catch(() => {}); // tolerate extra NOT NULL cols — see Step 2 if this throws
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('reports event_outbox pending/dead-letter/oldest-age', async () => {
    await collectReliabilityMetrics();
    const out = serializeReliabilityMetrics();
    expect(gaugeValue(out, 'event_outbox_pending_rows')).toBeGreaterThanOrEqual(2);
    expect(gaugeValue(out, 'event_outbox_dead_letter_rows')).toBeGreaterThanOrEqual(1);
    // the 1h-old pending row makes oldest-age >= ~3600s
    expect(gaugeValue(out, 'event_outbox_oldest_pending_age_seconds')).toBeGreaterThanOrEqual(3000);
  }, 30_000);

  it('reports webhook + circuit-breaker gauges', async () => {
    await collectReliabilityMetrics();
    const out = serializeReliabilityMetrics();
    expect(gaugeValue(out, 'webhook_deliveries_dead_rows')).toBeGreaterThanOrEqual(1);
    // breaker closed in a healthy test run
    expect(gaugeValue(out, 'db_circuit_breaker_open')).toBe(0);
  }, 30_000);
});
```

- [ ] **Step 2: Run it; reconcile column reality**

Run: `node --experimental-vm-modules --max-old-space-size=4096 node_modules/jest/bin/jest.js --runInBand reliability-metrics --forceExit`
Expected: PASS. **If the `webhook_deliveries` or `notification_outbox` INSERT throws on a missing NOT-NULL column**, read the real columns (`\d webhook_deliveries` via `prisma.$queryRawUnsafe` or grep the migration) and add the required columns to the seed INSERT — the gauge query itself only reads `status`, so only the seed needs fixing. Do NOT relax the gauge assertions.

- [ ] **Step 3: Commit**

```
git add apps/backend/src/tests/reliability-metrics.deep.test.js
git commit -m "test(metrics): QA-cluster deep test for the reliability collector gauges"
```

### Task 5: Expose the reliability metrics + start the collector

**Files:**
- Modify: `apps/backend/src/routes/metrics/metricsRoutes.js`
- Modify: `apps/backend/src/bin/www.js` (after `server.listen(PORT)`, line ~255)

- [ ] **Step 1: Append reliability metrics to `/metrics`**

```js
// src/routes/metrics/metricsRoutes.js
import { Router } from 'express';
import { serializeMetrics } from '../../middleware/prometheusMiddleware.js';
import { serializeReliabilityMetrics } from '../../observability/reliabilityMetrics.js';

const router = Router();

router.get('/', (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(serializeMetrics() + '\n' + serializeReliabilityMetrics());
});

export default router;
```

- [ ] **Step 2: Start the collector in `bin/www.js`**

Add the import with the other imports near the top:
```js
import { collectReliabilityMetrics } from '../observability/reliabilityMetrics.js';
```
After `server.listen(PORT);` (line ~255), start a periodic, unref'd collector and stop it on shutdown:
```js
// Reliability metrics collector — refresh DB-derived gauges every 20s. unref()
// so it never holds the event loop open during graceful shutdown. Runs per-pod
// (each reports its own view of the global gauges; alerts collapse with max()).
const RELIABILITY_METRICS_INTERVAL_MS = 20_000;
collectReliabilityMetrics(); // prime immediately so the first scrape isn't empty
const reliabilityMetricsTimer = setInterval(collectReliabilityMetrics, RELIABILITY_METRICS_INTERVAL_MS);
reliabilityMetricsTimer.unref();
```
If `bin/www.js` has a shutdown/cleanup path (it imports `stopAllScheduledTasks`), add `clearInterval(reliabilityMetricsTimer);` alongside the other teardown calls. (Read the shutdown handler and place it with the existing `stopAllScheduledTasks()` call.)

- [ ] **Step 3: Verify the route composition**

Add a tiny route-composition test (no DB needed — the gauges are zero-valued before any collect):
```js
// add to src/tests/unit/reliabilityMetrics.test.js
import request from 'supertest';
describe('metrics route composition', () => {
  it('GET /metrics includes both RED and reliability sections', async () => {
    const app = (await import('../../app.js')).default;
    const res = await request(app).get('/metrics').set('x-api-key', process.env.API_KEY || 'test-api-key');
    // 200 in test (requireProductionMonitoringAccess is prod-gated); body has both
    expect(res.text).toContain('http_requests_total');
    expect(res.text).toContain('# TYPE event_outbox_pending_rows gauge');
    expect(res.text).toContain('# TYPE ws_broadcast_dropped_total counter');
  });
});
```
Run: `node --experimental-vm-modules --max-old-space-size=4096 node_modules/jest/bin/jest.js --runInBand reliabilityMetrics --forceExit`
Expected: PASS. (If `/metrics` requires auth even in test, set the documented test env or use the same header pattern as other route tests — confirm `requireProductionMonitoringAccess` is a no-op outside production.)

- [ ] **Step 4: Lint + commit**

```
npm run lint
git add apps/backend/src/routes/metrics/metricsRoutes.js apps/backend/src/bin/www.js apps/backend/src/tests/unit/reliabilityMetrics.test.js
git commit -m "feat(metrics): expose reliability metrics on /metrics + start the 20s collector in bin/www.js"
```

---

## Unit 3 — Reliability alerts

### Task 6: `backend-reliability-alerts.yaml` PrometheusRule

**Files:**
- Create: `infra/kubernetes/base/monitoring/backend-reliability-alerts.yaml`
- Modify: `infra/kubernetes/base/monitoring/kustomization.yaml`
- Modify: `docs/RUNBOOK_ONCALL.md`

- [ ] **Step 1: Write the PrometheusRule**

```yaml
# monitoring/backend-reliability-alerts.yaml — application reliability alerts.
# Metric names come from the backend exporter
# (src/observability/reliabilityMetrics.js). Gauges are reported per-pod, so
# every expr collapses the identical series with max().
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: vhhealth-backend-reliability-alerts
  namespace: vhhealth-monitoring
  labels:
    app.kubernetes.io/name: prometheus
    app.kubernetes.io/component: rules
    app.kubernetes.io/part-of: vhhealth
    app.kubernetes.io/managed-by: kustomize
    release: vhhealth-monitoring
spec:
  groups:
    - name: backend-reliability
      interval: 30s
      rules:
        - alert: EventOutboxDrainStalled
          expr: max(event_outbox_oldest_pending_age_seconds) > 600
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "Oldest pending event_outbox row is >10m old — the drain cron is stalled"
            runbook: "docs/RUNBOOK_ONCALL.md#eventoutboxdrainstalled"
        - alert: EventOutboxBacklogGrowing
          expr: max(event_outbox_pending_rows) > 500
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "event_outbox pending backlog >500 for 10m"
            runbook: "docs/RUNBOOK_ONCALL.md#eventoutboxbacklog"
        - alert: EventOutboxDeadLettersPresent
          expr: max(event_outbox_dead_letter_rows) > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "event_outbox dead-letter rows present — events permanently undelivered (clinical/billing consumers never saw them)"
            runbook: "docs/RUNBOOK_ONCALL.md#eventoutboxdeadletters"
        - alert: EventOutboxDeadLetterRateRising
          expr: increase(event_outbox_dead_lettered_total[15m]) > 0
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Events are crossing into dead-letter (rate>0 over 15m)"
            runbook: "docs/RUNBOOK_ONCALL.md#eventoutboxdeadletters"
        - alert: WebhookDeliveriesDead
          expr: max(webhook_deliveries_dead_rows) > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "webhook_deliveries in terminal dead status — outbound webhooks permanently undelivered"
            runbook: "docs/RUNBOOK_ONCALL.md#webhookdeliveriesdead"
        - alert: WebhookDeliveryBacklog
          expr: max(webhook_deliveries_pending_rows) > 200
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "webhook_deliveries pending backlog >200 for 15m"
            runbook: "docs/RUNBOOK_ONCALL.md#webhookbacklog"
        - alert: NotificationOutboxBacklog
          expr: max(notification_outbox_pending_rows) > 500
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "notification_outbox PENDING backlog >500 for 15m"
            runbook: "docs/RUNBOOK_ONCALL.md#notificationbacklog"
        - alert: WsBroadcastDropsDetected
          expr: sum(rate(ws_broadcast_dropped_total[5m])) > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Real-time WS broadcasts dropping (slow-consumer backpressure or cross-process fan-out fallback) — clinical realtime (vitals/alerts) may not reach all sessions"
            description: "By reason: {{ $labels.reason }}. The invisible Redis-failover drop is proxied by ws_fanout_subscriber_errors_total."
            runbook: "docs/RUNBOOK_ONCALL.md#wsbroadcastdrops"
        - alert: WsFanoutSubscriberErrorsHigh
          expr: sum(rate(ws_fanout_subscriber_errors_total[5m])) > 0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "WS Redis fan-out subscriber erroring/reconnecting — the window where broadcasts can be silently dropped (at-most-once)"
            runbook: "docs/RUNBOOK_ONCALL.md#wsbroadcastdrops"
        - alert: DbCircuitBreakerOpen
          expr: max(db_circuit_breaker_open) == 1
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Prisma DB circuit breaker is OPEN — queries are being rejected fast"
            runbook: "docs/RUNBOOK_ONCALL.md#dbcircuitbreakeropen"
    - name: backend-safety-signals
      interval: 30s
      rules:
        - alert: ClinicalAiDeepTemplateFallback
          expr: increase(clinical_ai_deep_template_fallback_total[15m]) > 0
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Deep/critical clinical-AI module {{ $labels.module }} silently fell back to a TEMPLATE draft — clinicians may believe it is AI-assisted"
            runbook: "docs/RUNBOOK_ONCALL.md#clinicalaitemplatefallback"
        - alert: DbUndefinedTableFallback
          expr: increase(db_undefined_table_fallback_total[15m]) > 0
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Postgres 42P01 undefined_table graceful fallbacks firing — likely schema drift or a missing partition"
            runbook: "docs/RUNBOOK_ONCALL.md#dbundefinedtablefallback"
```

- [ ] **Step 2: Register in kustomization**

In `infra/kubernetes/base/monitoring/kustomization.yaml`, add `backend-reliability-alerts.yaml` to the `resources:` list (next to `backend-red-alerts.yaml`). Read the file first to match its exact list style.

- [ ] **Step 3: Add runbook sections**

In `docs/RUNBOOK_ONCALL.md`, add one short `### <AlertName>` section per alert above with: what fired, the 2–3 `kubectl`/SQL triage commands, and the remediation. Keep each to ~5 lines. (Anchors must match the lowercase `runbook:` fragments, e.g. `#eventoutboxdrainstalled`.)

- [ ] **Step 4: Validate with promtool (see Task 9 for the validator)**

Run: `promtool check rules infra/kubernetes/base/monitoring/backend-reliability-alerts.yaml`
Expected: `SUCCESS: N rules found`. (If `promtool` is not installed locally, this runs in CI per Task 9 — note that in the commit message.)

- [ ] **Step 5: Commit**

```
git add infra/kubernetes/base/monitoring/backend-reliability-alerts.yaml infra/kubernetes/base/monitoring/kustomization.yaml docs/RUNBOOK_ONCALL.md
git commit -m "feat(monitoring): backend reliability alerts (outbox/webhook/ws-drops/breaker) + safety-counter alerts"
```

---

## Unit 4 — SLO burn-rate + dashboards

### Task 7: `backend-slo.yaml` — 99.95% error budget + multi-window burn-rate

**Files:**
- Create: `infra/kubernetes/base/monitoring/backend-slo.yaml`
- Modify: `infra/kubernetes/base/monitoring/kustomization.yaml`
- Modify: `docs/RUNBOOK_ONCALL.md`

Burn-rate math for SLO 99.95% (error budget = 0.0005): page when the short+long windows BOTH burn ≥14.4× budget; ticket at ≥6×. Error ratio = 5xx / total.

- [ ] **Step 1: Write the SLO PrometheusRule**

```yaml
# monitoring/backend-slo.yaml — availability SLO 99.95% (error budget 0.05%).
# Multi-window multi-burn-rate alerts (Google SRE workbook): a fast burn must
# persist across a long AND a short window before paging, which suppresses the
# transient false pages a single static threshold would cause — important on a
# single backend Deployment where a rollout briefly burns budget.
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: vhhealth-backend-slo
  namespace: vhhealth-monitoring
  labels:
    app.kubernetes.io/name: prometheus
    app.kubernetes.io/component: rules
    app.kubernetes.io/part-of: vhhealth
    app.kubernetes.io/managed-by: kustomize
    release: vhhealth-monitoring
spec:
  groups:
    - name: backend-slo-recording
      interval: 30s
      rules:
        - record: job:slo_error:ratio_rate5m
          expr: sum(rate(http_requests_total{status_code=~"5.."}[5m])) / clamp_min(sum(rate(http_requests_total[5m])), 1e-9)
        - record: job:slo_error:ratio_rate30m
          expr: sum(rate(http_requests_total{status_code=~"5.."}[30m])) / clamp_min(sum(rate(http_requests_total[30m])), 1e-9)
        - record: job:slo_error:ratio_rate1h
          expr: sum(rate(http_requests_total{status_code=~"5.."}[1h])) / clamp_min(sum(rate(http_requests_total[1h])), 1e-9)
        - record: job:slo_error:ratio_rate6h
          expr: sum(rate(http_requests_total{status_code=~"5.."}[6h])) / clamp_min(sum(rate(http_requests_total[6h])), 1e-9)
    - name: backend-slo-burn
      interval: 30s
      rules:
        - alert: BackendErrorBudgetBurnFast
          # 14.4x burn of a 0.0005 budget = 0.0072, over 1h AND 5m.
          expr: |
            job:slo_error:ratio_rate1h > (14.4 * 0.0005)
            and
            job:slo_error:ratio_rate5m > (14.4 * 0.0005)
          for: 2m
          labels:
            severity: critical
            slo: availability
          annotations:
            summary: "Backend availability error budget burning >14.4x (99.95% SLO) — fast burn"
            runbook: "docs/RUNBOOK_ONCALL.md#backenderrorbudgetburn"
        - alert: BackendErrorBudgetBurnSlow
          # 6x burn over 6h AND 30m.
          expr: |
            job:slo_error:ratio_rate6h > (6 * 0.0005)
            and
            job:slo_error:ratio_rate30m > (6 * 0.0005)
          for: 15m
          labels:
            severity: warning
            slo: availability
          annotations:
            summary: "Backend availability error budget burning >6x (99.95% SLO) — sustained slow burn"
            runbook: "docs/RUNBOOK_ONCALL.md#backenderrorbudgetburn"
```

- [ ] **Step 2: Register in kustomization + runbook section**

Add `backend-slo.yaml` to `kustomization.yaml` resources. Add a `### BackendErrorBudgetBurn` runbook section noting the 99.95% target, the **single-Deployment topology caveat** (a rollout can burn budget → if it pages on deploys, raise to 99.9% or add a 2nd replica + `maxUnavailable=0`), and the error-budget triage (which routes are 5xx-ing — link the RED dashboard).

- [ ] **Step 3: Validate + commit**

```
promtool check rules infra/kubernetes/base/monitoring/backend-slo.yaml
git add infra/kubernetes/base/monitoring/backend-slo.yaml infra/kubernetes/base/monitoring/kustomization.yaml docs/RUNBOOK_ONCALL.md
git commit -m "feat(monitoring): 99.95% availability SLO recording rules + multi-window burn-rate alerts"
```

### Task 8: Grafana dashboards-as-code

**Files:**
- Create: `infra/kubernetes/base/monitoring/dashboards/vhhealth-backend-red.json`
- Create: `infra/kubernetes/base/monitoring/dashboards/vhhealth-backend-reliability.json`
- Create: `infra/kubernetes/base/monitoring/dashboards-configmap.yaml`
- Modify: `infra/kubernetes/base/monitoring/kustomization.yaml`

- [ ] **Step 1: Author the RED dashboard JSON**

`vhhealth-backend-red.json` — a minimal valid Grafana dashboard (schemaVersion 39) with 4 timeseries panels using the existing RED metrics: request rate `sum by (route)(rate(http_requests_total[5m]))`; error ratio `sum(rate(http_requests_total{status_code=~"5.."}[5m]))/clamp_min(sum(rate(http_requests_total[5m])),1e-9)`; p95 latency `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))`; p99 latency (same with 0.99). Top-level shape:
```json
{
  "uid": "vhhealth-backend-red",
  "title": "VH Health — Backend RED",
  "schemaVersion": 39,
  "version": 1,
  "tags": ["vhhealth", "backend"],
  "time": { "from": "now-6h", "to": "now" },
  "templating": { "list": [] },
  "panels": [
    { "id": 1, "type": "timeseries", "title": "Request rate by route", "gridPos": {"h":8,"w":12,"x":0,"y":0},
      "targets": [{ "expr": "sum by (route)(rate(http_requests_total[5m]))", "legendFormat": "{{route}}" }] },
    { "id": 2, "type": "timeseries", "title": "5xx error ratio", "gridPos": {"h":8,"w":12,"x":12,"y":0},
      "targets": [{ "expr": "sum(rate(http_requests_total{status_code=~\"5..\"}[5m])) / clamp_min(sum(rate(http_requests_total[5m])),1e-9)" }] },
    { "id": 3, "type": "timeseries", "title": "p95 latency (s)", "gridPos": {"h":8,"w":12,"x":0,"y":8},
      "targets": [{ "expr": "histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))" }] },
    { "id": 4, "type": "timeseries", "title": "p99 latency (s)", "gridPos": {"h":8,"w":12,"x":12,"y":8},
      "targets": [{ "expr": "histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))" }] }
  ]
}
```

- [ ] **Step 2: Author the reliability dashboard JSON**

`vhhealth-backend-reliability.json` — same shape, `uid: vhhealth-backend-reliability`, title "VH Health — Backend Reliability", panels for: `max(event_outbox_pending_rows)`, `max(event_outbox_oldest_pending_age_seconds)`, `max(event_outbox_dead_letter_rows)`, `max(webhook_deliveries_dead_rows)`, `sum(rate(ws_broadcast_dropped_total[5m]))` (by reason), `max(db_circuit_breaker_open)`, `sum(rate(clinical_ai_deep_template_fallback_total[15m])) by (module)`.

- [ ] **Step 3: Wrap both in a ConfigMap manifest**

```yaml
# monitoring/dashboards-configmap.yaml — Grafana dashboards-as-code. The
# kube-prometheus-stack Grafana sidecar imports any ConfigMap labelled
# grafana_dashboard: "1" in the watched namespace.
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: vhhealth-backend-dashboards
  namespace: vhhealth-monitoring
  labels:
    grafana_dashboard: "1"
    app.kubernetes.io/part-of: vhhealth
    app.kubernetes.io/managed-by: kustomize
data:
  vhhealth-backend-red.json: |-
    <PASTE the exact contents of vhhealth-backend-red.json, indented under this key>
  vhhealth-backend-reliability.json: |-
    <PASTE the exact contents of vhhealth-backend-reliability.json>
```
(Alternatively, generate the ConfigMap via a kustomize `configMapGenerator` from the two `.json` files — preferred so the JSON stays lintable. If using `configMapGenerator`, add the `grafana_dashboard: "1"` label via the generator's `options.labels` and omit the hand-written manifest. Pick one; the generator route keeps the JSON as real files for Step 4's lint.)

- [ ] **Step 4: Register in kustomization (use configMapGenerator)**

In `kustomization.yaml` add:
```yaml
configMapGenerator:
  - name: vhhealth-backend-dashboards
    namespace: vhhealth-monitoring
    options:
      labels:
        grafana_dashboard: "1"
      disableNameSuffixHash: true
    files:
      - dashboards/vhhealth-backend-red.json
      - dashboards/vhhealth-backend-reliability.json
```
(If the file already has a `configMapGenerator`, append this entry. Match the existing indentation.)

- [ ] **Step 5: Commit**

```
git add infra/kubernetes/base/monitoring/dashboards/ infra/kubernetes/base/monitoring/kustomization.yaml
git commit -m "feat(monitoring): RED + reliability Grafana dashboards-as-code (sidecar-imported ConfigMap)"
```

### Task 9: Validation script + CI wiring

**Files:**
- Create: `infra/kubernetes/base/monitoring/validate-monitoring.mjs`
- Modify: CI (a GitHub Actions step) — `.github/workflows/` (the infra/monitoring path)

- [ ] **Step 1: Write the validator**

```js
// infra/kubernetes/base/monitoring/validate-monitoring.mjs
// Validates the monitoring assets WITHOUT a cluster: promtool check rules over
// every PrometheusRule, and JSON.parse over every dashboard. Deploy is HELD, so
// alerts cannot be live-fired — this is the honest CI gate (structure + PromQL
// parse-validity), NOT proof that an alert fires.
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ruleFiles = ['backend-reliability-alerts.yaml', 'backend-slo.yaml', 'backend-red-alerts.yaml', 'alert-rules.yaml'];

let failed = false;
for (const f of ruleFiles) {
  try {
    const out = execFileSync('promtool', ['check', 'rules', join(here, f)], { encoding: 'utf8' });
    console.log(`✓ ${f}\n${out.trim()}`);
  } catch (e) {
    failed = true;
    console.error(`✗ promtool check rules ${f}\n${e.stdout || ''}${e.stderr || e.message}`);
  }
}
const dashDir = join(here, 'dashboards');
for (const f of readdirSync(dashDir).filter((n) => n.endsWith('.json'))) {
  try {
    JSON.parse(readFileSync(join(dashDir, f), 'utf8'));
    console.log(`✓ dashboard JSON valid: ${f}`);
  } catch (e) {
    failed = true;
    console.error(`✗ invalid dashboard JSON ${f}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Add a CI step**

Add a job/step (in the workflow that runs on `infra/kubernetes/**` changes, or `all.yml`) that installs promtool and runs the validator:
```yaml
      - name: Validate monitoring rules + dashboards
        run: |
          PROM_VER=2.55.1
          curl -sSL "https://github.com/prometheus/prometheus/releases/download/v${PROM_VER}/prometheus-${PROM_VER}.linux-amd64.tar.gz" | tar xz
          sudo mv "prometheus-${PROM_VER}.linux-amd64/promtool" /usr/local/bin/
          node infra/kubernetes/base/monitoring/validate-monitoring.mjs
```
(Place it in the most appropriate existing workflow; read `.github/workflows/` to choose. If no infra-path workflow exists, add the step to `all.yml`.)

- [ ] **Step 3: Run the validator locally if promtool is available**

Run: `node infra/kubernetes/base/monitoring/validate-monitoring.mjs`
Expected: `✓` for every rule file + dashboard, exit 0. (If promtool isn't installed locally, the JSON checks still run; the promtool checks run in CI — state this honestly in the PR.)

- [ ] **Step 4: Commit**

```
git add infra/kubernetes/base/monitoring/validate-monitoring.mjs .github/workflows/
git commit -m "ci(monitoring): promtool + dashboard-JSON validation for the alert/SLO/dashboard assets"
```

---

## Closeout

After all tasks pass: use **superpowers:finishing-a-development-branch**. Run the full backend gate (`npm run lint`; the metrics jest suites; `npm test` subset if practical) + the monitoring validator, then merge `feat/observability-alert-tier` to `main` `--no-ff`, push BOTH remotes (`github` + `origin`), delete the branch, and tick `docs/ROADMAP.md` Epic #8 + the observability memory. **Deploy stays HELD** — the PR/commit must state that Units 3–4 are structurally validated (promtool/JSON) but not live-fired, and that operator activation (Alertmanager secret URLs, confirming Grafana sidecar import) is a go-live step.

---

## Self-Review

**Spec coverage:** Unit 1 (primitives) → Task 1. Unit 2 (metrics+collector) → Tasks 2–5 (instances/recorders, counter wiring, QA-cluster test, exposition+startup). Unit 3 (reliability alerts + 2 safety counters) → Task 6. Unit 4 (SLO burn-rate + dashboards) → Tasks 7–9. All spec metrics covered; the spec's "at-most-once loss as a counted drop" is refined honestly (observable drops counted; `ws_fanout_subscriber_errors_total` proxies the invisible failover window). The 99.95% topology caveat is carried into the SLO runbook step. The HELD/cannot-live-fire honesty is in Task 9 + Closeout.

**Placeholder scan:** The two `<PASTE …>` markers in Task 8 Step 3 are explicitly superseded by the preferred `configMapGenerator` route in Step 4 (which uses the real `.json` files) — no hand-paste needed. The `webhook_deliveries`/`notification_outbox` seed columns in Task 4 Step 2 have an explicit reconcile-against-reality instruction (the gauge queries read only `status`, which is confirmed). No TBD/TODO.

**Type/name consistency:** Metric names, recorder names (`recordWsBroadcastDropped`/`recordWsFanoutSubscriberError`/`recordEventDeadLettered`), `collectReliabilityMetrics`/`serializeReliabilityMetrics`, and the status strings (`failed`/`dead`/UPPERCASE `PENDING`) are identical across the module, the tests, the wiring tasks, and the alert exprs.
