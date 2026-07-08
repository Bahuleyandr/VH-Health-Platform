# Runbook - Device Gateway Triage

> Device data is decision-support input. This runbook restores the feed, parks
> unsafe messages, and keeps wrong-patient charting impossible. Do not create
> patient associations from bed labels unless the clinical pilot has explicitly
> enabled that workflow.

**Severity:** P1 for spool backlog or silent devices; P0 if the outage hides
active ICU monitor data for a staffed unit.

## Spool-Drain Procedure

1. Confirm the gateway pod and current spool gauges.

```bash
kubectl -n vhhealth get pods -l app.kubernetes.io/name=device-gateway
kubectl -n vhhealth exec deployment/device-gateway -c device-gateway -- sh -lc 'ls -lah /var/spool/vhhealth-device-gateway && wc -l /var/spool/vhhealth-device-gateway/*.ndjson 2>/dev/null || true'
kubectl -n vhhealth port-forward svc/device-gateway 9108:9108
curl -fsS http://127.0.0.1:9108/metrics | grep -E 'gateway_spool_depth|gateway_spool_oldest_age_seconds|gateway_forward_failures_total|gateway_dead_letter_total'
```

2. Check whether the backend is refusing or unreachable.

```bash
kubectl -n vhhealth logs deployment/device-gateway -c device-gateway --since=15m
kubectl -n vhhealth exec deployment/device-gateway -c device-gateway -- sh -lc 'wget -qO- "$BACKEND_BASE_URL/api/v1/health" || true'
```

3. If the backend is healthy, restart the gateway once to force a clean drain
   from disk. The spool is a PVC; restart does not delete accepted frames.

```bash
kubectl -n vhhealth rollout restart deployment/device-gateway
kubectl -n vhhealth rollout status deployment/device-gateway
```

4. Watch the drain. Escalate if depth is not falling after 10 minutes.

```bash
kubectl -n vhhealth port-forward svc/device-gateway 9108:9108
watch -n 15 "curl -fsS http://127.0.0.1:9108/metrics | grep -E 'gateway_spool_depth|gateway_spool_oldest_age_seconds|gateway_forward_failures_total|gateway_dead_letter_total'"
```

5. If dead letters rise, preserve samples for backend review. Never paste raw
   HL7 into Slack or tickets.

```bash
kubectl -n vhhealth exec deployment/device-gateway -c device-gateway -- sh -lc 'ls -lah /var/spool/vhhealth-device-gateway/*.dead.ndjson 2>/dev/null || true'
```

## Silent-Device Response

1. Confirm the alert and identify the device code.

```bash
kubectl -n vhhealth exec statefulset/vhhealth-pg -c postgres -- psql -U vhhealth -d vhhealth -c "SELECT device_code, display_name, kind, allowed_source_ips, last_seen_at, expected_interval_seconds FROM device_registry WHERE status = 'active' AND (last_seen_at IS NULL OR last_seen_at < now() - (GREATEST(expected_interval_seconds, 60) * 3 * interval '1 second')) ORDER BY last_seen_at NULLS FIRST;"
```

2. Check gateway connection and message counters.

```bash
kubectl -n vhhealth port-forward svc/device-gateway 9108:9108
curl -fsS http://127.0.0.1:9108/metrics | grep -E 'mllp_connections_active|mllp_messages_received_total'
```

3. Ask biomed or unit nursing to confirm the physical monitor, central-station
   export, network cable, and VLAN firewall path. If the device was removed
   from service, pause or archive the registry row instead of leaving it active.

```bash
kubectl -n vhhealth exec statefulset/vhhealth-pg -c postgres -- psql -U vhhealth -d vhhealth -c "UPDATE device_registry SET status = 'paused', updated_at = now() WHERE device_code = '<DEVICE_CODE>' AND status = 'active';"
```

## Unassociated-Message Response

Unassociated ORU traffic means the platform refused to guess the patient. This
is safer than charting to the wrong person.

1. List recent parked messages.

```bash
kubectl -n vhhealth exec statefulset/vhhealth-pg -c postgres -- psql -U vhhealth -d vhhealth -c "SELECT id, analyzer_code, error, verdicts, created_at FROM lab_interface_messages WHERE message_type = 'ORU^VITALS' AND error = 'DEVICE_NOT_ASSOCIATED' ORDER BY created_at DESC LIMIT 20;"
```

2. Confirm the ward nurse scans or manually creates the association from the
   staff app. Do not use bed labels alone as proof.

```bash
kubectl -n vhhealth exec statefulset/vhhealth-pg -c postgres -- psql -U vhhealth -d vhhealth -c "SELECT a.id, d.device_code, a.channel, a.patient_uid, a.started_at FROM device_patient_associations a JOIN device_registry d ON d.id = a.device_registry_id WHERE a.ended_at IS NULL ORDER BY a.started_at DESC LIMIT 20;"
```

3. If association re-confirm TTL is enabled for the pilot, expired bindings
   close with `end_reason='ttl_expired'` and must be re-scanned. The default is
   off; enable only through device metadata after governance sign-off, for
   example `metadata.association_reconfirm_ttl_minutes = 1440`.

```bash
kubectl -n vhhealth exec statefulset/vhhealth-pg -c postgres -- psql -U vhhealth -d vhhealth -c "SELECT d.device_code, a.channel, a.patient_uid, a.started_at, a.ended_at, a.end_reason FROM device_patient_associations a JOIN device_registry d ON d.id = a.device_registry_id WHERE a.end_reason = 'ttl_expired' ORDER BY a.ended_at DESC LIMIT 20;"
```

## Pilot Soak Replay

Run this before opening a monitor feed or after changing gateway policy. It
uses committed synthetic fixtures, adds unique MSH-10 control IDs, injects
duplicates, drains the spool, and fails on any loss or duplicate ingest.

```bash
kubectl -n vhhealth exec deployment/device-gateway -c device-gateway -- node scripts/soak-replay.mjs --cycles=250 --duplicate-every=25
```

Expected output includes `"accepted": 1250`, `"ingested": 1250`,
`"rejected": 250`, and a non-zero `"duplicateAcks"` count when six fixtures are
present and only the malformed fixture rejects.
