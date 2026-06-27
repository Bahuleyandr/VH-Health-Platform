# On-call Runbook — Backend Alerts (Roadmap A6)

Alert definitions: `infra/kubernetes/base/monitoring/backend-red-alerts.yaml`,
`backend-reliability-alerts.yaml` (+ the platform alerts in `alert-rules.yaml`).
Severities: `warning` → Discord, `critical` → PagerDuty (when wired). Every alert
annotation links back to a section here.

First 2 minutes for ANY backend alert: `kubectl -n vhhealth get pods`,
`kubectl -n vhhealth logs deploy/vhhealth-backend --since=10m | tail -50`,
and check `/health/metrics` (circuit breaker state) + Sentry release health.

## BackendHighErrorRate

5xx > 2% for 5m.
1. Identify the route family: Grafana → backend RED → errors by route, or
   `kubectl logs ... | grep -E '"status":5'`.
2. Circuit breaker open? (`/health/metrics` → `circuit_breaker.open`) — if
   yes, treat as DB incident: check CNPG primary
   (`kubectl -n vhhealth get cluster vhhealth-pg`), connections, locks.
3. Recent deploy? `argocd app history vhhealth-backend` — rollback is one
   `argocd app rollback` away; do it on suspicion, investigate after.
4. If errors are confined to clinical routes → see
   BackendClinicalRouteErrors (treat as patient-impacting).

## BackendReadLatencyP95Breach / BackendWriteLatencyP95Breach

p95 above SLO (400ms reads / 800ms writes) for 10m.
1. Slow-query log: backend logs `Slow Prisma[primary] query` lines (>1s) —
   identify the offender; check for a missing index or a new N+1.
2. CNPG: CPU throttling / replication pressure (`kubectl top pods`,
   Grafana CNPG dashboard). auto_explain output is in the postgres logs
   for queries >2s.
3. Compare with the last k6 baseline (`apps/backend/loadtest/README.md`) —
   if load is simply higher than baselined capacity, scale before tuning.

## BackendClinicalRouteErrors

Any sustained 5xx on EMR/MAR/prescription/downtime routes — patient-facing.
1. Page the clinical-IT contact per the escalation sheet; wards may need
   the downtime procedure (`docs/DOWNTIME_PROCEDURE.md`) if writes are
   failing hospital-wide.
2. Triage the specific route in Sentry (clinical writes trace at 100% —
   the failing transaction will be there with full spans).
3. Do not silence the alert without a finding written to
   `docs/qa-findings/`.

## BackendDown

No scrape targets for 2m.
1. `kubectl -n vhhealth get pods -l app=vhhealth-backend` — CrashLoop?
   `kubectl describe pod` for OOM/eviction; check migration-failure exit
   (the app exits on failed migrations by design — see bin/www.js).
2. Ingress path: Cloudflare Tunnel + ingress-nginx pods healthy?
3. If recovery is not imminent (>10–15m), notify wards to begin the
   downtime procedure with their latest packs.

## WardDowntimePacksStale

Packs not regenerated in >1h.
1. Backend logs: `grep 'Ward downtime pack'` — per-ward failures are
   logged and skipped; a census-query failure aborts the sweep.
2. Verify the cron is alive: the `ward-downtime-packs` withJobLock job
   logs each run; a wedged lock clears on pod restart.
3. Regenerate manually: `POST /api/v1/downtime/generate` (admin JWT).

## CNPGReplicationLagHigh

1. `kubectl -n vhhealth get cluster vhhealth-pg -o wide` — replica states.
2. Sustained lag → check WAL volume I/O and network between nodes; consider
   pausing read-replica routing (`DATABASE_READ_URL` unset → reads fall
   back to primary) if stale reads are clinically risky.

## CNPGBackupNotRecent

No base backup in >30h (RPO at risk).
1. `kubectl -n vhhealth get scheduledbackup,backup` — last status + error.
2. Most common: R2 credentials (sealed secret) rotated/expired, or the
   `${CF_R2_ACCOUNT_ID}` substitution drifted. Test with a manual
   `kubectl cnpg backup vhhealth-pg`.
3. Until green again, treat the system as PITR-degraded: avoid risky DDL,
   and note the exposure window in the incident log. See
   `docs/DR_RESTORE_DRILL.md`.

<!-- ===== Reliability alerts (backend-reliability-alerts.yaml) ===== -->

## EventOutboxDrainStalled

Oldest pending `event_outbox` row is >10m old — the `event-outbox-drain` cron is
not draining (lock wedged, cron suspended, or a downstream bridge erroring).
1. Is the drain running? `kubectl -n vhhealth logs deploy/vhhealth-backend --since=15m | grep event-outbox-drain`.
2. Backlog shape: `SELECT count(*), min(available_at) FROM event_outbox WHERE status='pending';`.
3. A wedged `withJobLock` lock clears on pod restart; if a specific consumer is
   failing, rows back off and re-attempt — watch for them crossing to `failed`
   (see EventOutboxDeadLetters).

## EventOutboxBacklog

`event_outbox` pending backlog >500 for 10m — producers outrunning the drain.
1. Confirm the drain is healthy (see EventOutboxDrainStalled) before assuming a
   producer spike.
2. `SELECT event_type, count(*) FROM event_outbox WHERE status='pending' GROUP BY 1 ORDER BY 2 DESC;`
   to find the dominant producer.
3. Transient spikes self-drain; a sustained climb means the drain interval/batch
   can't keep up — scale or widen the drain batch.

## EventOutboxDeadLetters

Rows in terminal `status='failed'` (reached `MAX_ATTEMPTS=7`) — events
**permanently undelivered**; downstream consumers (webhook bridge, clinical/billing
projections) never saw them. `EventOutboxDeadLetterRateRising` is the leading edge.
1. `SELECT id, event_type, last_error, attempts FROM event_outbox WHERE status='failed' ORDER BY id DESC LIMIT 50;`
   — the `last_error` is the cause.
2. Fix the downstream (schema/endpoint/credential), then re-drive: reset the row
   to `pending` with `available_at=now()` once the consumer is healthy.
3. Record the lost-event window in the incident log; some events (e.g. ABDM push,
   billing) may need manual replay.

## WebhookDeliveriesDead

`webhook_deliveries` rows in terminal `dead` status — outbound webhooks gave up.
1. `SELECT id, subscription_id, event_type, last_error FROM webhook_deliveries WHERE status='dead' ORDER BY id DESC LIMIT 50;`.
2. Usually a subscriber endpoint down/changed or auth rejected — confirm with the
   integration owner; fix the subscription target, then re-enqueue.
3. If a subscription is permanently gone, disable it to stop the dead pile-up.

## WebhookBacklog

`webhook_deliveries` pending >200 for 15m — the delivery bridge is behind.
1. Check the delivery worker logs for a slow/erroring subscriber dragging the batch.
2. `SELECT subscription_id, count(*) FROM webhook_deliveries WHERE status='pending' GROUP BY 1 ORDER BY 2 DESC;`.
3. A single bad subscriber backing up the queue → pause it; the rest drain.

## NotificationBacklog

`notification_outbox` PENDING >500 for 15m — the notification sender is behind or
the provider (FCM/SMS) is failing.
1. Sender logs for provider errors; invalid FCM tokens are auto-deactivated, so a
   sustained climb is usually a provider outage or a credential problem.
2. `SELECT type, count(*) FROM notification_outbox WHERE status='PENDING' GROUP BY 1 ORDER BY 2 DESC;`.
3. Provider down → backlog drains on recovery (intent is persisted, never lost).

## WsBroadcastDrops

Real-time WS broadcasts dropping. `WsBroadcastDropsDetected` counts the OBSERVABLE
drops (`reason="backpressure"` = slow-consumer 1MB cap; `reason="fanout_local_fallback"`
= Redis down so cross-process pods missed it). `WsFanoutSubscriberErrorsHigh` is the
proxy for the INVISIBLE at-most-once Redis-failover drop (the bus swallows those).
1. By reason: Grafana → backend Reliability → WS drops. `backpressure` → a specific
   slow/stuck client socket; `fanout_local_fallback` → Redis/Sentinel health
   (`kubectl -n vhhealth get pods -l app=redis`).
2. Subscriber errors climbing → a Sentinel failover window; verify the fan-out
   re-subscribed (`grep 'WS Redis fan-out' backend logs after the spike').
3. Clinical realtime (vitals/code-blue) is at-most-once by design — if drops
   correlate with a clinical incident, write it to `docs/qa-findings/` (this is the
   measured signal for any future durable-realtime evaluation).

## DbCircuitBreakerOpen

The Prisma circuit breaker is OPEN (≥5 consecutive query failures) — queries are
being rejected fast for ~30s windows. Treat as a DB incident.
1. CNPG primary health: `kubectl -n vhhealth get cluster vhhealth-pg`, connections,
   locks; `/health/metrics` → `circuit_breaker` for which client (primary/readOnly).
2. Common causes: primary failover, connection exhaustion, a long lock. The breaker
   auto-resets (half-open) on recovery.
3. If it flaps, correlate with BackendHighErrorRate — the breaker open IS the cause
   of the 5xx.

## ClinicalAiTemplateFallback

A deep/critical clinical-AI module silently fell back to a deterministic TEMPLATE
draft (the deep model wasn't reachable) — clinicians may believe the output is
AI-assisted. Per-`module` label. **Clinical-safety signal.**
1. Which module: the `{{ $labels.module }}` label. Check the local LLM/GPU node
   health and that the module's deep model is pulled/reachable.
2. Until the model is back, the module is producing templates — notify clinical
   leads if it's a signoff-bearing module (e.g. medication_reconciliation).
3. Do not silence without a finding in `docs/qa-findings/`.

## DbUndefinedTableFallback

Postgres 42P01 (undefined_table) graceful fallbacks are firing — a read hit a
missing table/partition and the code papered over it. Usually schema drift or a
migration window.
1. Backend logs around the spike for the table name; cross-check against the latest
   migration (`_migrations` table) and the schema-drift check.
2. A migration mid-apply is transient; a sustained signal means a partition/table the
   fallback is masking should exist — investigate before it hides a real bug.

## BackendErrorBudgetBurn

Availability error budget for the **99.95% SLO** (~21 min/month) is burning fast
(`BackendErrorBudgetBurnFast`, 14.4×) or sustained (`BackendErrorBudgetBurnSlow`, 6×).
1. Which routes are 5xx-ing: Grafana → backend RED → errors by route, or
   `kubectl -n vhhealth logs deploy/vhhealth-backend --since=15m | grep -E '"status":5'`.
   Treat the burn like BackendHighErrorRate — the burn-rate just confirms it's eating budget.
2. Recent deploy? A rollout on the single backend Deployment briefly burns budget;
   `argocd app history vhhealth-backend` and roll back on suspicion.
3. **Topology caveat:** 99.95% on one Deployment with rolling restarts is aggressive
   — if this pages on routine deploys (not real incidents), the fix is to raise the
   target to 99.9% in `backend-slo.yaml` OR add a 2nd replica + `maxUnavailable=0`
   surge for zero-downtime deploys. Do NOT just silence it.
