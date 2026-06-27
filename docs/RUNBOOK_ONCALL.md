# VH Health On-Call Runbook

Sections are linked from PrometheusRule annotations in
`infra/kubernetes/base/monitoring/`. GitHub anchors are lowercase with
non-alphanumerics stripped to match the `runbook:` fragment.

---

## BackendHighErrorRate

**What fired:** HTTP 5xx rate exceeded 2% of all requests for 5 minutes.

Triage:
```bash
kubectl logs -n vhhealth deploy/vhhealth-backend --since=10m | grep '"statusCode":5'
kubectl top pods -n vhhealth -l app=vhhealth-backend
```

Check recent deployments: `kubectl rollout history deploy/vhhealth-backend -n vhhealth`.
If a bad deploy, roll back: `kubectl rollout undo deploy/vhhealth-backend -n vhhealth`.

---

## BackendReadLatencyP95Breach

**What fired:** GET p95 latency exceeded the 400 ms SLO for 10 minutes.

Triage:
```bash
kubectl logs -n vhhealth deploy/vhhealth-backend --since=15m | grep '"duration"' | sort -t: -k2 -n | tail -20
# Check slow queries:
kubectl exec -n vhhealth <cnpg-primary-pod> -- psql -U app -c \
  "SELECT query, mean_exec_time, calls FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;"
```

Common causes: missing index, lock contention, read-replica lag. Check CNPG replication alert too.

---

## BackendWriteLatencyP95Breach

**What fired:** POST/PUT/PATCH p95 latency exceeded the 800 ms SLO for 10 minutes.

Triage:
```bash
kubectl logs -n vhhealth deploy/vhhealth-backend --since=15m | grep '"method":"POST\|PUT\|PATCH"' | grep '"duration"'
kubectl exec -n vhhealth <cnpg-primary-pod> -- psql -U app -c \
  "SELECT pid, wait_event_type, wait_event, query FROM pg_stat_activity WHERE state='active';"
```

Common causes: table bloat, long-running transactions, migration running. Run `VACUUM ANALYZE` on hot tables if bloat is suspected.

---

## BackendClinicalRouteErrors

**What fired:** 5xx rate on EMR/MAR/prescriptions/clinical routes exceeded 0.05 req/s for 3 minutes. Patient-facing clinical impact.

Triage:
```bash
kubectl logs -n vhhealth deploy/vhhealth-backend --since=5m | grep -E '"/api/v1/(emr|clinical|pharmacy|prescriptions|downtime)' | grep '"statusCode":5'
```

Escalate immediately if errors touch `/emr` or `/clinical` — consider activating the downtime procedure (`docs/DOWNTIME_PROCEDURE.md`).

---

## CNPGReplicationLagHigh

**What fired:** CNPG read-replica replication lag exceeded 30 seconds for 5 minutes.

Triage:
```bash
kubectl exec -n vhhealth <cnpg-primary-pod> -- psql -U app -c \
  "SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
          (sent_lsn - replay_lsn) AS lag_bytes FROM pg_stat_replication;"
kubectl logs -n vhhealth <cnpg-replica-pod> --since=10m | grep -i "replication\|wal"
```

Remediation: if lag is growing, check replica pod CPU/IO (`kubectl top pod`). Under extreme lag, temporarily redirect read traffic to primary via connection string override.

---

## EventOutboxDrainStalled

**What fired:** The oldest pending row in `event_outbox` has been waiting more than 10 minutes (threshold: 600 s) — the drain cron appears stalled.

Triage:
```bash
kubectl logs -n vhhealth deploy/vhhealth-backend --since=20m | grep event-outbox-drain
kubectl exec -n vhhealth <cnpg-primary-pod> -- psql -U app -c \
  "SELECT count(*), min(available_at) FROM event_outbox WHERE status='pending';"
```

Remediation: check if the scheduler cron registered successfully at startup (look for `[scheduler] event-outbox-drain registered` in logs). If missing, restart the backend pod: `kubectl rollout restart deploy/vhhealth-backend -n vhhealth`.

---

## EventOutboxBacklog

**What fired:** `event_outbox` pending row count exceeded 500 for 10 minutes — drain is running but falling behind ingestion rate.

Triage:
```bash
kubectl exec -n vhhealth <cnpg-primary-pod> -- psql -U app -c \
  "SELECT event_type, count(*) FROM event_outbox WHERE status='pending' GROUP BY event_type ORDER BY 2 DESC;"
kubectl logs -n vhhealth deploy/vhhealth-backend --since=15m | grep 'event-outbox-drain\|claimed\|dispatched'
```

Remediation: if one event_type dominates, check the consumer for that type. Scale backend replicas if drain throughput is too low: `kubectl scale deploy/vhhealth-backend --replicas=3 -n vhhealth`.

---

## EventOutboxDeadLetters

**What fired:** Either dead-letter rows are present in `event_outbox` (events permanently failed after all retries) or the dead-letter rate counter is rising.

Triage:
```bash
kubectl exec -n vhhealth <cnpg-primary-pod> -- psql -U app -c \
  "SELECT id, event_type, error, created_at FROM event_outbox WHERE status='dead_letter' ORDER BY created_at DESC LIMIT 20;"
kubectl logs -n vhhealth deploy/vhhealth-backend --since=1h | grep 'dead.letter\|max.retries'
```

Remediation: inspect the `error` column to find the root consumer failure. Fix the downstream consumer, then manually replay dead-letter rows by resetting status to `pending` and `retry_count` to 0 after the fix is confirmed:
```sql
UPDATE event_outbox SET status='pending', retry_count=0, error=NULL
  WHERE status='dead_letter' AND event_type='<type>';
```
Clinical and billing consumers must confirm receipt before closing the incident.

---

## WebhookDeliveriesDead

**What fired:** Rows in `webhook_deliveries` have reached terminal `dead` status — outbound webhooks to tenant endpoints are permanently undelivered.

Triage:
```bash
kubectl exec -n vhhealth <cnpg-primary-pod> -- psql -U app -c \
  "SELECT id, tenant_id, endpoint_url, last_error, created_at FROM webhook_deliveries WHERE status='dead' ORDER BY created_at DESC LIMIT 20;"
kubectl logs -n vhhealth deploy/vhhealth-backend --since=1h | grep 'webhook.*dead\|webhook.*exhausted'
```

Remediation: check `last_error` for the tenant endpoint failure reason (DNS, TLS, 4xx/5xx). Contact the tenant if their endpoint is down. Replay after their fix:
```sql
UPDATE webhook_deliveries SET status='pending', attempts=0 WHERE status='dead' AND tenant_id='<id>';
```

---

## WebhookBacklog

**What fired:** `webhook_deliveries` pending count exceeded 200 for 15 minutes — delivery worker is falling behind.

Triage:
```bash
kubectl exec -n vhhealth <cnpg-primary-pod> -- psql -U app -c \
  "SELECT tenant_id, count(*) FROM webhook_deliveries WHERE status='pending' GROUP BY tenant_id ORDER BY 2 DESC;"
kubectl logs -n vhhealth deploy/vhhealth-backend --since=20m | grep 'webhook.*deliver\|webhook.*retry'
```

Remediation: if one tenant dominates (slow endpoint), consider temporarily pausing deliveries to that tenant. Otherwise scale backend replicas.

---

## NotificationBacklog

**What fired:** `notification_outbox` pending count exceeded 500 for 15 minutes — the notification sender is falling behind.

Triage:
```bash
kubectl exec -n vhhealth <cnpg-primary-pod> -- psql -U app -c \
  "SELECT channel, count(*) FROM notification_outbox WHERE status='pending' GROUP BY channel ORDER BY 2 DESC;"
kubectl logs -n vhhealth deploy/vhhealth-backend --since=20m | grep 'notification.outbox\|notification.*send'
```

Remediation: check if the FCM/SMS gateway is rate-limiting or down. Inspect per-channel counts — if SMS backlogged, confirm Twilio quota. If FCM, check Firebase console for delivery errors.

---

## WsBroadcastDrops

**What fired:** Either `ws_broadcast_dropped_total` rate is non-zero (broadcasts actively dropping due to slow-consumer backpressure or cross-process fan-out fallback) or the Redis fan-out subscriber is erroring/reconnecting (`WsFanoutSubscriberErrorsHigh`).

Drops are critical for clinical realtime (vitals monitors, alert panels).

Triage:
```bash
kubectl logs -n vhhealth deploy/vhhealth-backend --since=10m | grep -E 'ws.*drop|ws.*slow.consumer|ws.*fanout|redis.*subscriber'
# Check Redis health:
kubectl exec -n vhhealth <redis-pod> -- redis-cli ping
kubectl exec -n vhhealth <redis-pod> -- redis-cli info replication
```

Remediation:
- **slow-consumer drops**: the connected client is too slow. Check if a clinical monitor is stuck; reconnecting it usually resolves backpressure.
- **fanout subscriber errors**: Redis is reconnecting (Sentinel failover window). Drops are at-most-once during the reconnect gap — clinicians relying on realtime vitals should be notified to refresh. If Redis is consistently down, escalate to `docs/DISASTER-RECOVERY.md`.

---

## DbCircuitBreakerOpen

**What fired:** `db_circuit_breaker_open` gauge is 1 — the Prisma circuit breaker has tripped and is fast-failing all DB queries.

Triage:
```bash
kubectl logs -n vhhealth deploy/vhhealth-backend --since=5m | grep -E 'circuit.breaker|OPEN|prisma.*error'
kubectl exec -n vhhealth <cnpg-primary-pod> -- psql -U app -c "SELECT 1;" 2>&1
kubectl get pods -n vhhealth -l cnpg.io/cluster=vhhealth-db
```

Remediation: the breaker opens when consecutive DB errors exceed the threshold. Root-cause is almost always the DB being unavailable or the connection pool exhausted.
1. Confirm CNPG primary is up and accepting connections.
2. If yes, restart the backend pod to reset the breaker state: `kubectl rollout restart deploy/vhhealth-backend -n vhhealth`.
3. If CNPG is down, follow `docs/DISASTER-RECOVERY.md`.

---

## ClinicalAiTemplateFallback

**What fired:** A deep or critical clinical-AI module fell back to a static template draft instead of generating AI content. Clinicians may incorrectly believe the output is AI-assisted.

Triage:
```bash
kubectl logs -n vhhealth deploy/vhhealth-backend --since=30m | grep -E 'template.fallback|clinical.ai.*fallback|module.*tier'
```

Remediation:
1. Identify the module from `$labels.module` in the alert payload.
2. Check if the LLM gateway (local Ollama or external) is reachable from the backend pod.
3. If the module is tenant-gated, verify `clinical_ai_tenant_modules` is configured correctly.
4. Template fallbacks are silent to the clinician — notify clinical staff to review AI-generated content until the module is restored.

---

## DbUndefinedTableFallback

**What fired:** `db_undefined_table_fallback_total` counter incremented — a Postgres `42P01 undefined_table` error was caught by a graceful fallback handler. This indicates schema drift or a missing partition.

Triage:
```bash
kubectl logs -n vhhealth deploy/vhhealth-backend --since=30m | grep -E '42P01|undefined.table|fallback.*table'
kubectl exec -n vhhealth <cnpg-primary-pod> -- psql -U app -c \
  "SELECT * FROM _prisma_migrations WHERE rolled_back_at IS NULL ORDER BY started_at DESC LIMIT 5;"
```

Remediation:
1. Identify the missing table from logs (the fallback handler logs the table name).
2. If a migration is pending, apply it: `kubectl exec -n vhhealth deploy/vhhealth-backend -- npx prisma migrate deploy`.
3. If a partition is missing (e.g. `clinical_timeline_events_<month>`), run the partition maintenance script or apply the relevant migration.
4. This is non-fatal (the fallback returns empty results) but indicates a real schema gap — treat as a high-priority ops ticket.
