# Runbook — Code Blue mis-fire investigation

> Executed via `kubectl` on the on-prem cluster. See
> [`../../../../docs/DEPLOYMENT_GUIDE.md`](../../../../docs/DEPLOYMENT_GUIDE.md)
> for kubeconfig setup.

**Severity:** P0 (patient safety)

Code Blue is the backend's cardiac-arrest / rapid-response alert
broadcast. When it fires, every on-duty nurse's phone goes into
full-screen-intent mode (`CodeBlueNotifier` on Android + Critical Alerts
on iOS where entitlement is granted). A mis-fire — the alert goes out
but the clinical reality was NOT a code — erodes trust in the channel
and next real Code Blue may be ignored.

## Symptoms

- `#vhhealth-ops` reports: "staff phones blew up for a patient who's
  fine"
- Audit log shows a `CODE_BLUE_BROADCAST` event
- No corresponding `clinical_alerts` row with `alert_type = 'code_blue'`
  marked `acknowledged_at` by the receiving floor staff

## Mental model — what can trigger a Code Blue

The backend only fires Code Blue from two paths:

1. `POST /clinical/code-blue` — explicit trigger by authorized staff
   (role `DOCTOR`, `NURSE`, or `ADMIN`). JWT is required; an audit
   entry with `user_id`, `patient_id`, `location`, `reason` is created.
2. `checkVitalAnomalies()` in `src/utils/clinical/vitalSignMonitor.js`
   detects a CRITICAL-severity vital combination (O2 <85%, HR >180,
   systolic BP <70, etc.) and auto-fires a Code Blue if the patient is
   flagged as "clinical-alerts-enabled".

Both paths go through `emitCodeBlue` in
`src/utils/websocket/realtimeEmitter.js` which:

1. Writes a `clinical_alerts` row.
2. Broadcasts on `staff:clinical-alerts` WS channel.
3. Sends a high-importance FCM data message to every staff device.

## Investigation steps

### 1. Capture the offending event from the audit trail

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "
    SELECT id, user_id, patient_id, action, resource, metadata, created_at
    FROM audit_logs
    WHERE action LIKE '%CODE_BLUE%'
    ORDER BY created_at DESC
    LIMIT 10;"
```

Grab the most recent row. Note `user_id`, `patient_id`, `created_at`,
and the `metadata` JSON.

### 2. Find the matching `clinical_alerts` row

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "
    SELECT id, patient_id, alert_type, severity, source, message,
           auto_generated, created_at, acknowledged_at, acknowledged_by
    FROM clinical_alerts
    WHERE alert_type = 'code_blue'
      AND created_at >= '<AUDIT_LOG_TIMESTAMP>'::timestamptz - interval '5 seconds'
      AND created_at <= '<AUDIT_LOG_TIMESTAMP>'::timestamptz + interval '5 seconds'
    ORDER BY created_at DESC;"
```

Look at the `source` field. If `source = 'manual'`, go to §3; if
`source = 'auto-vitals'`, go to §4.

### 3. Mis-fire from explicit trigger

User-initiated. Likely causes:

- **Accidental tap in the staff app's Rapid-Response screen**. The UI
  has a 2-second confirm hold — check if the hold threshold was
  satisfied (`metadata.confirm_held_ms`).
- **Training / drill that was NOT prefixed with the drill flag**
  (`metadata.drill = false` when it should be `true`).
- **Wrong patient selected** — MAR scanner picked up a neighbour's
  wristband.

Action:
1. Ask the staff member who triggered (their `user_id` is in the audit
   log — cross-ref via users table).
2. File a training note OR patch the UI confirm-hold duration.
3. Do NOT delete the alert — audit trail stays. Mark it
   `acknowledged_by_system_with_reason = 'misfire-investigation'` via:
   ```bash
   kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
     psql -U vhhealth -d vhhealth -c "
       UPDATE clinical_alerts
         SET acknowledged_at = now(),
             acknowledged_by = <oncall_user_id>,
             message = message || ' [POSTMORTEM: misfire, see incident #<N>]'
       WHERE id = <alert_id>;"
   ```

### 4. Mis-fire from auto-vitals

Automatic trigger by `checkVitalAnomalies`. Check the upstream vital:

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "
    SELECT id, patient_id, bp_systolic, bp_diastolic, pulse, spo2, temperature,
           respiratory_rate, gcs_total, recorded_at, recorded_by
    FROM vitals_chart
    WHERE patient_id = <PATIENT_ID>
    ORDER BY recorded_at DESC
    LIMIT 5;"
```

Three common auto-misfire causes:
1. **Garbage input from a device** — e.g., O2 sensor reading 0%
   because of a detached probe. Cross-check with the nurse on the
   floor whether the value was real.
2. **Unit mismatch** — e.g., temperature recorded in °C but parsed as
   °F (or vice versa) crossing into anomaly range.
3. **Stale reading** — old `recorded_at` being reprocessed by a retry
   job. Check if `recorded_at` is > 30 minutes before the audit log
   timestamp.

Action:
1. If input was garbage, correct the vital row (`clinical_alerts` links
   back via `trigger_vital_id`) OR delete it and re-submit.
2. If unit mismatch, fix the device integration (dedicated incident).
3. If stale-retry, check scheduler logs for the batch-replay pattern:
   ```bash
   kubectl -n vhhealth logs deployment/vhhealth-backend --tail=500 | grep -i "reminder\|batch-replay\|retry"
   ```
   There's a rare race where a stuck job reprocesses vitals from hours
   earlier.

### 5. Determine the downstream blast radius

How many devices actually received the push?

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "
    SELECT COUNT(*) AS devices_notified
    FROM notification_outbox
    WHERE type = 'code_blue'
      AND resource_id = <alert_id>
      AND status IN ('sent','delivered');"
```

If this number is large (≥ 10), consider a `#vhhealth-ops` announcement
to tell staff the alert was a drill / misfire so they don't silence the
channel for real future alerts.

### 6. Verify receive → ack loop is still healthy

```bash
STAFF_JWT=<test-staff-jwt>
kubectl -n vhhealth exec -it deployment/vhhealth-backend -- \
  curl -s -H "x-api-key: $API_KEY_STAFF" -H "Authorization: Bearer $STAFF_JWT" \
    http://localhost:5000/api/v1/realtime/health | jq
# Expected: { "ok": true, "connectedSockets": N, ... }
```

If the ack rate dropped after the misfire (staff disabling Code Blue
notifications in panic), raise a training ticket.

## Post-incident

- [ ] Add a row to `docs/incidents/code-blue-misfires-$(year).md`:
      UTC time, patient id (anonymized), trigger source, root cause,
      remediation, devices notified.
- [ ] If the cause was a UI bug, file a ticket with label `clinical-safety`.
- [ ] If the cause was a device-integration bug (unit mismatch, garbage
      input), escalate to biomed.
- [ ] If this is the 3rd misfire in 30 days, open a retrospective in
      `#vhhealth-clinical`.
- [ ] NEVER bulk-delete `clinical_alerts` misfire rows — auditors need
      the paper trail. Use the acknowledged-with-reason SQL in §3.
