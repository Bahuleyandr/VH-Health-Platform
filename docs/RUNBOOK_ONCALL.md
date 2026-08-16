# On-call Runbook — Backend Alerts (Roadmap A6)

Alert definitions: `infra/kubernetes/base/monitoring/backend-red-alerts.yaml`,
`backend-reliability-alerts.yaml` (+ the platform alerts in `alert-rules.yaml`).
The C1.1 alert rules land inert: all four top-level production ArgoCD
Applications are manual-sync. Child Applications may define their own policy,
but their creation or update first requires the manual platform sync.
Alertmanager receiver/delivery wiring remains C1.3. Severity labels express the
intended policy (`warning` to Discord, `critical` to PagerDuty), but do not
assume anyone is paged until C1.3 evidence proves the routes. Every alert
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
   (`kubectl -n vhhealth-platform get cluster vhhealth-pg`), connections,
   locks.
3. Recent deploy? Capture `vhhealth-apps` revision/history/diff, rendered image
   digests, pod events/logs, and the incident timestamp first. Roll back only
   with incident approval and evidence tying the regression to that revision.
4. If errors are confined to clinical routes → see
   BackendClinicalRouteErrors (treat as patient-impacting).

## BackendReadLatencyP95Breach / BackendWriteLatencyP95Breach

p95 above SLO (400ms reads / 800ms writes) for 10m.
1. Slow-query log: backend logs `Slow Prisma[primary] query` lines (>1s) —
   identify the offender; check for a missing index or a new N+1.
2. CNPG: CPU throttling / replication pressure (`kubectl top pods`,
   Grafana CNPG dashboard). auto_explain output is in the postgres logs
   for queries >2s.
3. Compare with the last k6 baseline (`apps/backend/loadtest/README.md`) and,
   for pilot-scale incidents, the latest completed
   `apps/backend/loadtest/500-bed-slo-rebaseline-template.md` evidence bundle.
   If load is simply higher than baselined capacity, scale before tuning.

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

1. `kubectl -n vhhealth-platform get cluster vhhealth-pg -o wide` — replica states.
2. Sustained lag → check WAL volume I/O and network between nodes; consider
   pausing read-replica routing (`DATABASE_READ_URL` unset → reads fall
   back to primary) if stale reads are clinically risky.

## CNPGBackupNotRecent

No base backup in >30h (RPO at risk).
This rule describes the qualified PG18 Barman-plugin target. Production remains
on PostgreSQL 17 until C1.2 and the qualification gates pass; do not activate or
interpret the plugin metric against the current PG17 runtime.

1. `kubectl -n vhhealth-platform get scheduledbackup,backup` — confirm the sole
   `vhhealth-pg-daily` schedule and inspect the latest plugin `Backup` status.
2. Check the Barman Cloud Plugin controller/sidecar and the
   `vhhealth-pg18-producer` `ObjectStore`. Confirm its endpoint is the committed
   production R2 value; native Kustomize replacement is used, not runtime
   account-ID substitution.
3. Separate the credential failure domains. Backup production may use only
   `cnpg-backup-producer-credentials` (bucket-scoped Object Read & Write);
   verification may use only `cnpg-dr-reader-credentials` (separate
   bucket-scoped Object Read-only). The configured prefix is workload routing,
   not token scope. Never copy the producer Secret into the verifier to make an
   alert green.
4. If an on-demand test is approved, create a one-off `Backup` using the same
   `method: plugin` and plugin name as `scheduled-backup.yaml`; do not invoke an
   implicit legacy backup method.
5. Until green again, treat the system as PITR-degraded: avoid risky DDL,
   and note the exposure window in the incident log. See
   `docs/DR_RESTORE_DRILL.md`.

## CnpgPluginBackupFailed

The Barman plugin reports a failed backup newer than its last available backup.
The PostgreSQL cluster may keep serving normally while WAL/base-backup and
restore work has stopped, so database health alone is not closure.

1. Preserve the latest `Backup` custom-resource status, producer
   `ObjectStore` status, plugin controller/sidecar logs, endpoint render, and
   archive-freshness timestamps.
2. If the controller or CRD is missing, reinstall the exact pinned plugin
   release outside ArgoCD and confirm `objectstores.barmancloud.cnpg.io` before
   touching the platform Application.
3. Keep `cnpg-backup-producer-credentials` only in production backup resources.
   Do not repair a verifier/restore failure by granting it writer access.
4. Prove a new plugin `Backup`, then run reader-only verification and the
   approved restore proof. Retain the failed and successful evidence.

## CnpgRestoreProofUnexpectedlyEnabled

`cnpg-scheduled-restore-proof` is an operator-gated CronJob and ships
`suspend: true`.

1. Confirm whether an approved synthetic restore window is active. If not,
   restore `suspend: true` through a reviewed manual sync and capture who/what
   changed it.
2. Preserve any running Job, Cluster, ObjectStore, events, and logs before
   cleanup. Delete only Cluster/ObjectStore resources labeled
   `vhhealth.app/disposable-restore-proof=true`.
3. Never delete the `vhhealth-restore-proof` namespace, its sealed reader
   Secret, R2 objects, Backup custom resources, or drill evidence.

## BackendUploadArchiveStale

The six-hour encrypted archive of the MinIO upload bucket has no successful
`vhhealth-backend-r2-sync` run in the expected window.

1. Inspect the CronJob and latest Job logs. Check the source-only
   `minio-backup-source-reader`, destination `offsite-backup-producer`,
   `backup-crypto`, exact R2 endpoint, disk space in `/work`, and network policy.
2. The producer intentionally performs no destination `HEAD`. Do not add
   reader authority or the broad backend Secret to make it self-verify.
3. After production succeeds, require the separate reader-owned verification
   Job to prove metadata, checksum, decryption, and archive contents.

## BackendUploadArchiveVerificationStale

The reader-owned `backup-verification` Job has not verified the latest
off-site archive inside the eight-hour bound.

1. Inspect its Job status/logs and confirm it uses only
   `offsite-backup-reader` plus `backup-crypto`.
2. Compare the object metadata, downloaded SHA-256/size, decryption result, tar
   integrity, source bucket metadata, and archive age.
3. A healthy producer is not proof of a restorable archive. Keep the incident
   open until reader-side verification passes; never substitute
   `offsite-backup-producer`.

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
2. Fix the downstream (schema/endpoint/credential), then use only the typed,
   reasoned ADMIN `POST /api/v1/admin/events/:id/redrive` operation. It accepts
   only `status='failed'`, requires a non-empty reason and writes the actor,
   request, prior state and result to the immutable audit log. Do not reset
   queue status with raw SQL.
3. Record the lost-event window in the incident log; some events (e.g. ABDM push,
   billing) may need manual replay.

## WebhookDeliveriesDead

`webhook_deliveries` rows in terminal `dead` status — outbound webhooks gave up.
1. `SELECT id, subscription_id, event_type, error_message FROM webhook_deliveries WHERE status='dead' ORDER BY id DESC LIMIT 50;`.
2. Usually a subscriber endpoint down/changed or auth rejected — confirm with the
   integration owner; fix the subscription target, then use the ADMIN delivery
   redrive action with a specific operator reason. Redrive accepts `dead` only,
   resets the current retry cycle and preserves the old cycle in immutable audit.
3. If a subscription is permanently gone, disable it to stop the dead pile-up.

## WebhookBacklog

`webhook_deliveries` pending >200 for 15m — the delivery bridge is behind.
1. Check the delivery worker logs for a slow/erroring subscriber dragging the batch.
2. `SELECT subscription_id, count(*) FROM webhook_deliveries WHERE status='pending' GROUP BY 1 ORDER BY 2 DESC;`.
3. A single bad subscriber backing up the queue → pause it; the rest drain.

## OutboxStaleLeases

One or more source `processing` or webhook `in_flight` leases have expired, or
the reapers are repeatedly recovering claims. A single recovery can follow a pod
restart; repeated recovery means worker crashes, database stalls or outbound
timeouts need investigation.

1. Check `event_outbox_stale_processing_rows`,
   `webhook_deliveries_stale_in_flight_rows`, and the two
   `*_stale_lease_reaped_total` counters in the Backend Reliability dashboard.
2. Inventory without changing state:
   `SELECT tenant_id,id,attempts,lease_owner,lease_expires_at FROM event_outbox WHERE status='processing' ORDER BY lease_expires_at,id LIMIT 100;`
   and
   `SELECT tenant_id,id,subscription_id,attempt_number,lease_owner,lease_expires_at FROM webhook_deliveries WHERE status='in_flight' ORDER BY lease_expires_at,id LIMIT 100;`.
3. Confirm the distinct `event-outbox-stale-lease-reaper` and webhook stale
   reaper jobs are running under their advisory locks. Do not clear lease fields
   manually: the reapers fence by tenant, ID, owner and attempt epoch.
4. Correlate lease expiry with pod restarts, database latency and endpoint
   timeouts. A stale worker result must update zero rows and must not change a
   subscription success/failure counter.

## WebhookParkedWork

`webhook_deliveries_parked_rows` counts pending/retryable work that cannot be
claimed because its subscription is missing/inactive, its parent integration is
inactive, or its historical `event_filter` is unsupported.

1. Group parked work by gate using tenant-scoped database access; never include
   payloads in an incident channel. Inspect subscription/integration status and
   whether `event_filter = '{}'::jsonb`.
2. Missing subscriptions are automatically moved to `dead` without an outbound
   request. Intentionally paused subscription/integration work remains pending or
   retryable-failed and becomes eligible after explicit reactivation.
3. Do not invent filter evaluation during an incident. Clear or deactivate an
   unsupported filter through the reviewed integration configuration workflow.

## OutboxRecoveryCutover

Migration 588 is scheduler-quiesced and is not rolling-compatible with old
unfenced workers. Use this sequence only in a separately approved maintenance
window; merging the code is not approval to deploy it.

1. Inventory source states, duplicate non-null
   `(tenant_id,event_outbox_id,subscription_id)` tuples, active non-empty
   filters, processing/in-flight leases and parked work. Preserve counts and
   sample IDs in the change record.
2. Stop every event drain, webhook dispatcher and both stale reapers across the
   fleet. Verify no old pod can restart.
3. Snapshot the database, apply migration 588 once, deploy the matching build,
   and only then resume the fenced workers.
4. Verify lease constraints, the unique fan-out index, tenant-bound admin reads,
   all five lease/parked gauges, and a reaper dry-run before ending the window.
5. If preflight names duplicate tuples or active filters, abort without deleting
   evidence. Resolve each named identity under change control and start a fresh
   window. Rollback is scheduler/traffic hold plus forward fix or snapshot
   restoration; never restart the old worker against the hardened schema.

## NotificationBacklog

`notification_outbox` PENDING >500 for 15m — the notification sender is behind or
the provider (FCM/SMS) is failing.
1. Sender logs for provider errors; invalid FCM tokens are auto-deactivated, so a
   sustained climb is usually a provider outage or a credential problem.
2. `SELECT type, count(*) FROM notification_outbox WHERE status='PENDING' GROUP BY 1 ORDER BY 2 DESC;`.
3. Provider down → backlog drains on recovery (intent is persisted, never lost).

## NotificationOutboxDeadLetters

One or more notification intents exhausted their retry budget or entered an
operator-review state. Open **Admin → Notifications → Delivery Health**, select
the failed status, and inspect the bounded reason, provider attempt, latest
receipt outcome, provider code, and provider reference. Do not
copy recipient identifiers into an incident channel or change outbox state with
raw SQL. Repair the provider or configuration cause first, enter a specific
operator reason, and use **Replay** only for the named row. A replay of an
uncertain delivery creates a new intent and may duplicate a delivery; confirm
that risk before submitting it.

## NotificationOutboxReconciliationRequired

The backend cannot prove whether a provider accepted one or more notification
attempts. Treat the outcome as unknown, not failed. In **Admin → Notifications →
Delivery Health**, correlate the row with provider evidence without exposing the
message body or payload. If the provider or an independently retained delivery
record proves acceptance for the exact attempt, enter its **Provider reference**,
summarize the source in **Provider evidence**, enter an incident-specific
operator reason, and use **Record acceptance**. This appends an actor-attributed
acceptance receipt and advances only the cursor paused on that outbox row; the
row becomes sent only after every current channel attempt has acceptance
evidence. If acceptance cannot be proven, use the audited row replay only after
explicitly accepting duplicate-delivery risk. The original uncertain row is
never silently retried. Never use **Record acceptance** for a provider ticket
that merely reports receipt of a support request or for inferred delivery.

## NotificationDeliveryCursorPaused

A channel is deliberately blocked behind a rejected or uncertain head row so
later messages cannot overtake it. Use the Delivery Health cursor view to find
the blocked row, then record acceptance evidence or replay that exact row. The reset action refuses
an unresolved head; it is only for clearing a stale pause after the ledger shows
a terminal rejection, acknowledged delivery, suppression, or audited superseding
replay. Enter an incident-specific reason and never clear the cursor with SQL.

## ReliabilityMetricsStale

The last complete reliability-metric collection is absent or older than five
minutes, so queue gauges must not be treated as current. Check backend logs for
`collectReliabilityMetrics: <family> skipped` and the named metric family, then verify
database connectivity and tenant-scoped reads. Healthy families continue to
refresh independently, but the global freshness timestamp advances only when
every configured family, including a configured read replica, succeeds. Restore
the failed collector path before closing queue alerts based on apparent zeros.

## CarePathwayReconciliationTechnicalError

The latest append-only receipt for at least one tenant/pathway contains a bounded
technical error. This is an evidence-collection failure, not permission to infer
that clinical state is healthy.

1. Use the ADMIN read-only reconciliation workbench to identify the pathway,
   receipt timestamp, registry checksum and stable error code. Do not request or
   paste patient/task/resource identifiers into the incident channel.
2. Confirm migration 587, the current registry version and the default-off
   scheduler configuration are coherent. Correlate the receipt time with backend
   logs; logs intentionally expose only tenant, pathway and stable error code.
3. Do not edit an evidence row, reset an SLA, reassign work or redrive a queue
   with SQL. Escalate the stable code to the owning domain or platform team; any
   mutation must use a separately reviewed typed, reasoned operation.

## CarePathwayActiveWithoutAuthority

A tenant setting says `active`, but this release deliberately has no production
activation capability. The executor remains fail-closed.

1. Treat this as configuration/governance drift. Confirm the affected fixed
   `pathway_key` metric and the latest read-only reconciliation receipt.
2. Do not attempt to mint activation authority or directly edit tenant settings
   in SQL. Escalate to the pathway owner and platform governance owner for an
   audited return to `off` or `shadow` through the approved settings process.
3. Confirm no pathway task, notification or patient projection was produced by
   reconciliation; the receipt should contain `ACTIVE_WITHOUT_ACTIVATION_AUTHORITY`.

## PathwayProjectorDebt

The current projector generation has terminal dead work, or a retired generation
still has pending work.

1. Inspect bounded projector metrics and the read-only reconciliation workbench.
   Preserve event and inbox rows as evidence; do not paste payloads into tickets.
2. Repair the producer/handler cause first. Use only the typed, audited projector
   recovery operation delivered by the queue-recovery slice; never change inbox
   status, lease or generation offsets with raw SQL.
3. Re-run reconciliation after typed recovery. A repaired sweep is non-clean; a
   later unchanged zero-drift sweep is required before evidence can count toward
   owner review.

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
1. CNPG primary health: `kubectl -n vhhealth-platform get cluster vhhealth-pg`, connections,
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

## RateLimitStoreDegraded

The Redis-backed rate-limit store is degraded (`vh_rate_limit_store_degraded` = 1
from `/metrics`, same signal as `rate_limit_store` on the JSON `/health/metrics`).
Per the store-loss decision table (`config/rateLimitStoreLossPolicy.js`),
fail-closed profiles (auth/otp/sos/dataExport/dashboard/smartFhirOAuth) are
answering honest 429s and fail-open profiles are passing unmetered. Pods stay
Ready on purpose — do not restart the fleet for this.
1. Which failure mode: `vh_rate_limit_store_errors` rising = command failures
   (breaker open, half-open probes via `vh_rate_limit_store_probes`);
   flat errors + degraded = connection-level loss (disconnected / never
   initialized). Check Redis/Sentinel health:
   `kubectl -n vhhealth get pods -l app=redis`.
2. Blast radius while down: `vh_rate_limit_store_denied_while_down` (auth-class
   requests refused) vs `vh_rate_limit_store_passed_unmetered_while_down`
   (unmetered traffic). Both reset to 0 on recovery.
3. Recovery is automatic (ioredis retry + breaker half-open probes). If the
   gauge stays 1 after Redis reports healthy, one successful limiter
   `increment` closes the breaker — sustained degradation with healthy Redis
   means the store credentials/ACL or the command timeout budget changed.

## WsFanoutSubscriberDown

At least one backend pod's cross-pod WebSocket fan-out subscriber is down
(`min(vh_redis_ws_fanout_ready) == 0`): sessions pinned to that pod miss
cross-pod realtime broadcasts (vitals, code-blue) while everything else keeps
serving. Distinct from `WsFanoutSubscriberErrorsHigh`, which is the
error/reconnect-rate proxy for the invisible at-most-once drop window.
1. Which pod: `/metrics` per-pod series, or `/health/ready`'s
   `redis_websocket_subscriber` block (873-F10) with its `degraded_since`.
2. Background reinit re-wires the subscriber when Redis returns
   (873-F2/F10). If Redis is healthy but a pod stays deaf, a rolling restart
   of THAT pod restores its subscription — not the fleet.
3. Correlate with `WsBroadcastDropsDetected` `reason="fanout_local_fallback"`
   to see whether broadcasts were actually lost during the window.

## BackendErrorBudgetBurn

Availability error budget for the **99.95% SLO** (~21 min/month) is burning fast
(`BackendErrorBudgetBurnFast`, 14.4×) or sustained (`BackendErrorBudgetBurnSlow`, 6×).
1. Which routes are 5xx-ing: Grafana → backend RED → errors by route, or
   `kubectl -n vhhealth logs deploy/vhhealth-backend --since=15m | grep -E '"status":5'`.
   Treat the burn like BackendHighErrorRate — the burn-rate just confirms it's eating budget.
2. Recent deploy? Capture `vhhealth-apps` revision/history/diff, image digests,
   pod events/logs, and the burn window. Roll back only after the evidence and
   incident owner identify the rollout as the likely cause.
3. **Topology caveat:** 99.95% on one Deployment with rolling restarts is aggressive
   — if this pages on routine deploys (not real incidents), the fix is to raise the
   target to 99.9% in `backend-slo.yaml` OR add a 2nd replica + `maxUnavailable=0`
   surge for zero-downtime deploys. Do NOT just silence it.

## Operator Script Index

For one-off tenant onboarding, RLS/runtime-role rehearsal, ledger cutover
evidence, clinical-AI readiness checks, PHI encryption jobs, QA cluster bring-up,
and seed scripts, use [`SCRIPTS_INDEX.md`](SCRIPTS_INDEX.md).

## Rollback

Use this section for staging/prod app image digest rollbacks. Digest-pin rollback
is the default when the bad rollout came from a Git pin commit; ArgoCD rollback
is the fallback when Git cannot be changed quickly enough or ArgoCD history is
the only known-good reference.

Before either mutation, capture the Application target/live revisions, history,
diff, rendered image digests, pod events/logs, relevant metrics, and—when the
incident touches data—the current `Backup`, `ObjectStore`, verifier/proof Job,
and archive status. Record incident approval and the exact known-good revision.

### Preferred: revert the digest-pin commit

1. Identify the pin commit that changed the app image digests:
   `git log --oneline -- infra/kubernetes/apps/kustomization.yaml infra/kubernetes/overlays/staging/apps/kustomization.yaml`.
2. Revert that commit on a new branch:
   `git switch -c revert/bad-image-pin && git revert <pin-commit-sha>`.
3. Validate the affected kustomize path before pushing:
   `kubectl kustomize infra/kubernetes/apps >/tmp/vhhealth-apps.yaml` for prod app pins, or
   `kubectl kustomize infra/kubernetes/overlays/staging/apps >/tmp/vhhealth-staging-apps.yaml` for staging app pins.
4. Merge the revert and push `main`, then sync the relevant ArgoCD app:
   `argocd app sync vhhealth-apps --revision <revert-commit-sha>` or
   `argocd app sync vhhealth-apps-staging --revision <revert-commit-sha>`.
5. Verify rollout health:
   `argocd app wait <app-name> --health --sync --timeout 900`,
   `kubectl -n vhhealth rollout status deploy/vhhealth-backend deploy/vhhealth-admin`,
   and `curl -fsS https://api.vhhealth.app/api/v1/health` (or the staging host).

Use this path when the faulty state is isolated to one or more pinned image
digests, the previous Git commit is known-good, and there is time to preserve the
GitOps audit trail.

### Fallback: ArgoCD application rollback

1. Inspect application history:
   `argocd app history vhhealth-apps` or `argocd app history vhhealth-apps-staging`.
2. Roll back to the last known-good history ID:
   `argocd app rollback <app-name> <history-id>`.
3. Immediately open a Git revert branch for the bad digest-pin commit so the
   repository catches up with the live state; otherwise the next sync can reapply
   the bad digest.
4. Verify the same health signals as above plus the backend logs for migration or
   startup failures:
   `kubectl -n vhhealth logs deploy/vhhealth-backend --since=10m | tail -100`.

Use this path during an active outage when a known-good ArgoCD history entry is
available and waiting for a Git revert would extend patient- or operator-facing
impact. Follow with the Git revert as soon as the service is stable.

### CNPG upgrade, backup, and restore rollback boundaries

The app-image rollback above does not authorize a database image downgrade.

1. Before C1.1 activation, revert the Git change; the top-level manual sync
   keeps an un-synced merge inert.
2. During the sequential CNPG operator ladder, stop at the last passing rung.
   Preserve every failed-rung log and health result.
3. If the PostgreSQL 18 upgrade fails, restore the exact qualified PostgreSQL
   17 image and retain the source backup, upgrade logs, checksums, and failure
   evidence.
4. After successful conversion, never point the converted data directory back
   at a PostgreSQL 17 image. Restore the qualified PostgreSQL 17 backup into a
   new cluster or fix forward.
5. A broken verifier or restore-proof job may be suspended without stopping a
   healthy WAL/base-backup stream. Remove only labeled disposable restore
   resources.
6. Never delete R2 objects, `Backup` custom resources, checksums, drill
   evidence, or the only recoverable generation. Keep old and new credential
   generations until backup, reader-only verification, and synthetic restore
   evidence all pass.

## DbReadReplicaLagHigh

The backend exporter is reporting `db_read_replica_lag_seconds > 30` through
`prismaReadOnly`, which means read-only analytics/dashboard routes may serve
stale data.
1. Confirm the app metric and CNPG agree: Grafana backend Reliability →
   read-replica lag, then `kubectl -n vhhealth-platform get cluster vhhealth-pg -o wide`.
2. If lag is rising, inspect replica pod CPU/I/O, WAL replay, and network health.
   Do not route additional reads to the replica while the alert is firing.
3. If stale reads are clinically or operationally risky, unset/seal out
   `DATABASE_READ_URL` so `prismaReadOnly` falls back to primary, then restart
   backend pods and watch read latency.

## Read Replica Activation

Use this only after the CNPG read-only pooler is healthy and the go-live checklist
owner approves the read split. This is a DSN activation, not a clinical-mode flip.
1. Seal the read-only DSN that points at the CNPG RO pooler service, not a direct
   pod address and not the primary pooler.
2. Point backend `DATABASE_READ_URL` at that sealed CNPG RO pooler value and sync
   the backend secret through the normal GitOps path.
3. Restart or roll the backend Deployment so `prismaReadOnly` is created against
   the replica DSN.
4. Verify `db_read_replica_lag_seconds` appears in `/metrics`, Grafana backend
   Reliability shows the lag series, and `DbReadReplicaLagHigh` stays green.
5. Confirm analytics/dashboard reads are healthy, then record the activation time,
   DSN secret version, lag baseline, and rollback owner in the incident/change log.
