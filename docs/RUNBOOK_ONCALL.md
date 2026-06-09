# On-call Runbook — Backend Alerts (Roadmap A6)

Alert definitions: `infra/kubernetes/base/monitoring/backend-red-alerts.yaml`
(+ the platform alerts in `alert-rules.yaml`). Severities: `warning` →
Discord, `critical` → PagerDuty (when wired). Every alert annotation links
back to a section here.

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
