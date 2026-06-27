# Observability Alert Tier — Design

**Date:** 2026-06-27
**Epic:** ROADMAP §0 Tier-2 #8 (Observability / SLOs)
**Status:** Approved design → ready for implementation plan

## Goal

Close the observability gap on the reliability machinery shipped in the recent
event-runtime gap/hardening work (event_outbox drain + dead-letter, cross-process
WS fan-out, webhook delivery bridge). That machinery currently emits **no
Prometheus metrics**, so it is unmonitored — nothing can alert when the outbox
backs up, dead-letters accumulate (lost events), or WS broadcasts drop under
Redis Sentinel failover. Instrument those signals as metrics, alert on them, add
formal SLO burn-rate alerting (99.95% availability), and ship the first VH Health
Grafana dashboards-as-code. The deliverable is alerting-as-code so the go-live
monitoring activation is a config exercise, not new authoring.

## Background — current state (what already exists)

Exploration (2026-06-27) found the observability stack is **far more mature than
the ROADMAP's "missing alert tier" framing implies**:

- **Metrics exposition** — `src/middleware/prometheusMiddleware.js` is a custom,
  dependency-free exporter (its own `Histogram`/`Counter`/`Gauge` classes). It
  exposes RED (`http_request_duration_seconds`, `http_requests_total` by
  method/route/status_code, with PHI-safe route-label normalization),
  `redis_connected`, node memory/uptime gauges, and two app safety counters:
  `db_undefined_table_fallback_total` and
  `clinical_ai_deep_template_fallback_total{module,tier}`. Served at `/metrics`,
  token-gated in prod by `requireProductionMonitoringAccess`.
- **Alerts** — two `PrometheusRule` CRs already exist:
  - `infra/kubernetes/base/monitoring/backend-red-alerts.yaml`: BackendHighErrorRate
    (5xx > 2%), Backend read/write p95 SLO breach (GET 400ms / write 800ms),
    BackendClinicalRouteErrors, BackendDown, WardDowntimePacksStale,
    OutageCriticalCronJobFailing, CNPGReplicationLagHigh, CNPGBackupNotRecent.
  - `infra/kubernetes/base/monitoring/alert-rules.yaml`: nodes (down/CPU/mem/PVC),
    workloads (crashloop/replica mismatch), postgres (replication/connections),
    certificates, cloudflared tunnel, harbor, and synthetic-check watchers
    (canary + cnpg-backup-verify stale/failing).
- **Routing** — `infra/kubernetes/base/monitoring/kube-prometheus-values.yaml`
  wires Alertmanager: `severity=warning`→Discord, `severity=critical`→PagerDuty,
  Watchdog→muted Discord. Operator supplies the secret URLs.
- **Grafana** — deployed (TLS, admin creds via `grafana-admin-credentials`) but
  with **zero VH Health dashboards committed**.
- **Rule selector** — the kube-prometheus-stack operator picks up PrometheusRule
  CRs by the `release: vhhealth-monitoring` label in namespace
  `vhhealth-monitoring`.

### The actual gap

1. **The reliability machinery emits no metrics.** Confirmed: a repo-wide grep
   for `event_outbox_*` / `dead_letter_*` / `*_outbox_depth` / `ws_broadcast_dropped`
   metrics finds nothing. `event_outbox` pending depth / oldest-pending age /
   dead-letter count, `notification_outbox` backlog, `webhook_deliveries`
   backlog/failures, and WS dropped-broadcast count are all invisible.
2. **Lost real-time broadcasts are invisible.** The cross-process WS fan-out is
   at-most-once (Redis pub/sub): a broadcast can be dropped under Redis Sentinel
   failover, a Redis-down fallback, or the 1MB bufferedAmount backpressure guard.
   For clinical real-time data (vitals, critical alerts) a silently dropped
   broadcast is a reliability incident — but nothing counts them today. A
   `ws_broadcast_dropped_total` counter + alert is justified **on its own** as a
   WS-reliability signal. (Side note: the same data would also be the measured
   evidence any *future* event-runtime/BEAM evaluation would need — but that
   evaluation is **undecided**, and this build neither assumes nor depends on it.
   No part of this slice ties to BEAM.)
3. **Two exposed safety counters are unalerted.**
   `clinical_ai_deep_template_fallback_total` (a clinical-safety signal whose own
   code comment says "ops can alert per-module") and `db_undefined_table_fallback_total`
   (schema-drift early warning) have no alert rule.
4. **No application-level SLO burn-rate alerting** — the existing latency/error
   alerts are simple static thresholds, not error-budget burn-rate.
5. **No dashboards-as-code.**

## Scope

In scope: **Core + dashboards + SLO burn-rate** (the full slice).
Out of scope: changing the deployed Prometheus/Alertmanager/Grafana components
(they exist); operator secret provisioning (Discord/PagerDuty URLs — a go-live
step); live-firing alerts against the cluster (deploy is HELD).

## SLO targets

- **Availability: 99.95%** (≈21 min/month error budget). Strict, owner-chosen.
- **Latency objectives (reused from the existing alerts):** GET p95 ≤ 400ms,
  write (POST/PUT/PATCH) p95 ≤ 800ms.

**Topology caveat (must be in the runbook):** 99.95% on a single backend
`Deployment` with rolling restarts is aggressive — a rollout or pod eviction can
burn a meaningful slice of a 21-min budget. The multi-window/multi-burn-rate
design suppresses transient false pages (a fast burn must persist across both a
long and a short window), and `BackendDown` already covers hard outages. If
rollout noise still pages, the documented mitigations are: raise to 99.9%, or
add a second replica + maxUnavailable=0 surge for zero-downtime deploys. We do
NOT silently relax the target — the caveat is explicit.

## Architecture — four units

Each unit has one responsibility, a clear interface, and can be built + reviewed
independently. The chosen instrumentation approach is **periodic in-process
collector → cached gauges** (scrape stays constant-time; DB load is bounded and
decoupled from scrape cadence; the alternative scrape-time-query approach couples
DB load to scrape count and risks stalling scrapes as outbox tables grow).

### Unit 1 — Metric primitives (tiny refactor)

Extract the `Histogram` / `Counter` / `Gauge` classes (currently private inside
`prometheusMiddleware.js`) into `src/observability/metricPrimitives.js` and import
them back. They are now needed by two modules (the RED middleware and the new
reliability collector), so they become a shared primitive. **No behavior change**
to the RED metrics — a pure move + re-import, covered by re-running the existing
metrics tests.

Interface: `export class Histogram`, `export class Counter`, `export class Gauge`
(same constructor signatures + `.observe`/`.inc`/`.set`/`.serialize` as today).

### Unit 2 — Reliability metrics + collector (backend code)

New `src/observability/reliabilityMetrics.js`:

**Gauges (set by the collector each tick):**
| Metric | Source query (one batched read) |
|---|---|
| `event_outbox_pending_rows` | `COUNT(*) … WHERE status='pending'` |
| `event_outbox_oldest_pending_age_seconds` | `EXTRACT(EPOCH FROM now() - MIN(available_at)) … WHERE status='pending'` (0 when none) — the drain-stalled signal |
| `event_outbox_dead_letter_rows` | `COUNT(*) … WHERE status='failed'` — the terminal dead-letter state `markFailed` parks rows at once they reach `MAX_ATTEMPTS=7` (the enum is `pending`/`processing`/`delivered`/`failed`; a row only reaches `failed` at the attempt cap, below which it returns to `pending`) |
| `notification_outbox_pending_rows` | `COUNT(*) … WHERE status='pending'` |
| `webhook_deliveries_pending_rows` | `COUNT(*) … WHERE status IN ('pending','processing')` |
| `webhook_deliveries_failed_rows` | `COUNT(*) … WHERE status='failed'` |
| `db_circuit_breaker_open` | `circuitBreakerStatus().state === 'open' ? 1 : 0` (no query) |

**Counters (incremented inline at the event site):**
| Metric | Increment site |
|---|---|
| `ws_broadcast_dropped_total{reason}` | every drop path in `wsRedisAdapter`/`wsServer` (Redis-down fallback, 1MB bufferedAmount guard, at-most-once loss) — a standalone WS-reliability signal (lost real-time clinical broadcasts); `reason` is a bounded low-cardinality label |
| `event_outbox_dead_lettered_total` | `eventOutboxService.markFailed` when a row crosses MAX_ATTEMPTS into the terminal state (rate-of-loss signal; complements the gauge's current-count) |

**Collector:** `collectReliabilityMetrics()` runs the gauge queries in one batched
round-trip, tolerant of a DB error (logs + leaves the prior snapshot, never
throws — a metrics collector must not crash the process). Started from
`bin/www.js` on a ~20s interval (a bare `setInterval`, unref'd so it never holds
the event loop open at shutdown). It runs **per-pod and locally** — each pod
reports its own view of the global DB gauges; alerts/dashboards collapse the
N identical series with `max()`. Counters are naturally per-pod and summed by
Prometheus. (No `withJobLock`: a read-only snapshot per pod is correct, and
locking would leave non-holder pods reporting stale zeros.)

**Exposition:** `serializeReliabilityMetrics()` is appended to the `/metrics`
output in `src/routes/metrics/metricsRoutes.js`, after the existing
`serializeMetrics()`.

Cardinality discipline: all new gauges are label-free single series;
`ws_broadcast_dropped_total` carries only a bounded `reason`. No PHI, no tenant
or per-route explosion.

### Unit 3 — Reliability alerts

New `infra/kubernetes/base/monitoring/backend-reliability-alerts.yaml` — a
`PrometheusRule` (namespace `vhhealth-monitoring`, `release: vhhealth-monitoring`
label, same shape as the existing files). Alert group `backend-reliability`:

| Alert | Expr (sketch) | Severity |
|---|---|---|
| `EventOutboxBacklogGrowing` | `max(event_outbox_pending_rows) > 500 for 10m` | warning |
| `EventOutboxDrainStalled` | `max(event_outbox_oldest_pending_age_seconds) > 600 for 10m` | critical |
| `EventOutboxDeadLettersPresent` | `max(event_outbox_dead_letter_rows) > 0 for 5m` (lost events — clinical/billing consumers never saw them) | critical |
| `EventOutboxDeadLetterRateRising` | `increase(event_outbox_dead_lettered_total[15m]) > 0` | warning |
| `WebhookDeliveryBacklog` | `max(webhook_deliveries_pending_rows) > 200 for 15m` | warning |
| `WebhookDeliveryFailures` | `max(webhook_deliveries_failed_rows) > 0 for 10m` | warning |
| `NotificationOutboxBacklog` | `max(notification_outbox_pending_rows) > 500 for 15m` | warning |
| `WsBroadcastDropsDetected` | `sum(rate(ws_broadcast_dropped_total[5m])) > 0 for 5m` — real-time clinical broadcasts (vitals/alerts) dropped under Redis failover or backpressure | critical |
| `DbCircuitBreakerOpen` | `max(db_circuit_breaker_open) == 1 for 2m` | critical |
| `ClinicalAiDeepTemplateFallback` | `increase(clinical_ai_deep_template_fallback_total[15m]) > 0` — per-`module` (clinicians got a template believing it was AI-assisted) | warning |
| `DbUndefinedTableFallback` | `increase(db_undefined_table_fallback_total[15m]) > 0` (schema drift) | warning |

Thresholds above are starting points to be calibrated against real baseline data
once live; each alert carries a `runbook` annotation pointing at
`docs/RUNBOOK_ONCALL.md` (new sections added per alert).

### Unit 4 — SLO burn-rate + dashboards

**`infra/kubernetes/base/monitoring/backend-slo.yaml`** — a `PrometheusRule` with:
- **Recording rules** for the availability SLI (good = non-5xx) over the standard
  windows (5m, 30m, 1h, 2h, 6h, 1d, 3d), e.g.
  `job:slo_errors:ratio_rate1h = sum(rate(http_requests_total{status_code=~"5.."}[1h])) / sum(rate(http_requests_total[1h]))`.
- **Multi-window multi-burn-rate alerts** calibrated to 99.95% (error budget
  0.0005):
  - Fast/page: 14.4× burn over (1h AND 5m) → `severity=critical`.
  - Slow/ticket: 6× burn over (6h AND 30m) → `severity=warning`.
  (Plus the 3× and 1× tiers if low-noise; YAGNI-trim during implementation.)
- Latency SLO recording rules for GET p95 ≤ 400ms / write p95 ≤ 800ms (the
  existing static alerts can later be migrated to budget-burn, but stay as-is in
  this slice to avoid churn).

**Grafana dashboards-as-code** — two ConfigMaps in
`infra/kubernetes/base/monitoring/dashboards/` labelled `grafana_dashboard: "1"`
so the kube-prometheus-stack Grafana sidecar auto-imports them:
- `vhhealth-backend-red.json` — RED: request rate, error ratio, p50/p95/p99
  latency, broken out by route-family (`/api/v1/(emr|clinical|billing|appointments|…)`).
- `vhhealth-backend-reliability.json` — outbox pending/oldest-age/dead-letter,
  webhook + notification backlog, WS drop rate, circuit-breaker state,
  clinical-AI template-fallback rate.

Both registered in `infra/kubernetes/base/monitoring/kustomization.yaml`.

## Testing

- **Unit 1:** re-run existing metrics tests (no behavior change) + a smoke that
  the three primitive classes import + serialize from the new path.
- **Unit 2 (the load-bearing verification):** a QA-cluster integration test —
  seed `event_outbox` rows (pending + dead_letter) + `webhook_deliveries`, run
  `collectReliabilityMetrics()`, then assert `serializeReliabilityMetrics()`
  contains the exact metric lines with correct values; a unit test that the
  collector swallows a DB error and keeps the prior snapshot; and a test that
  `ws_broadcast_dropped_total` increments at a simulated drop. Run on the QA
  cluster (`postgres@127.0.0.1:55432/vhhealth_test`).
- **Units 3–4:** `promtool check rules` over the new PrometheusRule YAML, and a
  JSON-validity + `grafana_dashboard` label check on the dashboard ConfigMaps,
  wired into CI. These **cannot be live-fired** (deploy is HELD); the plan and
  PR say so explicitly — no silent claim of end-to-end alert verification.

## Risks & decisions

- **Scrape-time vs collector:** chose collector (bounded DB load). Decided.
- **Per-pod gauges → N identical series:** accepted; collapse with `max()` in
  alerts/dashboards. Standard for DB-global gauges scraped per replica.
- **99.95% on a single Deployment:** explicit caveat + documented mitigations
  (above). Not silently relaxed.
- **Threshold calibration:** initial thresholds are placeholders; the runbook
  notes they need a baseline-data pass once live. Logged, not hidden.
- **Terminal status name (resolved):** `eventOutboxService.markFailed` parks a row
  at `status='failed'` once `attempts >= MAX_ATTEMPTS (7)` — that IS the
  dead-letter state (below the cap the row returns to `'pending'`). The
  dead-letter gauge query and the `event_outbox_dead_lettered_total` increment
  site (the `deadLetter = nextAttempts >= MAX_ATTEMPTS` branch in `markFailed`)
  both key off this. Confirmed by reading `eventOutboxService.js`.

## Out of scope / follow-ups

- Migrating the existing static latency alerts to budget-burn (left as-is).
- Per-tenant SLO breakdown (cardinality; defer).
- Loki log-based alerting (separate concern; Loki retention already raised to
  180d in config).
- Operator secret provisioning + live alert firing (go-live steps).
