# Runbook - Cold-Chain Excursion Response

> Cold-chain alerts protect stock integrity. The system alerts and records
> evidence; it never auto-quarantines, discards, or releases stock.

**Severity:** P1 for blood-bank or vaccine units; P2 for ambient/lab units
unless a department policy says otherwise.

## 1. Confirm the Open Excursion

```bash
kubectl -n vhhealth exec statefulset/vhhealth-pg -c postgres -- psql -U vhhealth -d vhhealth -c "SELECT e.id, u.unit_code, u.display_name, u.department, e.opened_at, e.peak_temp_c, e.status, e.corrective_action FROM cold_chain_excursions e JOIN cold_chain_units u ON u.id = e.unit_id WHERE e.status IN ('open', 'acknowledged') ORDER BY e.opened_at DESC LIMIT 20;"
```

If the row is missing but staff report a temperature breach, check whether the
sensor is silent.

```bash
kubectl -n vhhealth exec statefulset/vhhealth-pg -c postgres -- psql -U vhhealth -d vhhealth -c "SELECT d.device_code, d.last_seen_at, d.expected_interval_seconds FROM device_registry d WHERE d.kind = 'fridge_sensor' AND d.status = 'active' ORDER BY d.last_seen_at NULLS FIRST LIMIT 20;"
```

## 2. Stabilize the Unit

Ask the department owner to move stock only under local SOP. Record what they
did in the excursion corrective action; do not edit readings.

```bash
kubectl -n vhhealth exec statefulset/vhhealth-pg -c postgres -- psql -U vhhealth -d vhhealth -c "SELECT unit_id, temp_c, humidity_pct, battery_pct, recorded_at FROM cold_chain_readings WHERE unit_id = <UNIT_ID> ORDER BY recorded_at DESC LIMIT 30;"
```

## 3. Verify Alert Delivery

```bash
kubectl -n vhhealth exec statefulset/vhhealth-pg -c postgres -- psql -U vhhealth -d vhhealth -c "SELECT id, type, status, retry_count, created_at, last_error FROM notification_outbox WHERE data::text LIKE '%cold_chain%' ORDER BY created_at DESC LIMIT 20;"
```

If notifications are stuck, drain the notification outbox per the backend
notification runbook before closing the excursion.

## 4. Close With Evidence

Close only after readings are back in range and the department has supplied a
corrective action plus stock disposition note.

```bash
kubectl -n vhhealth exec statefulset/vhhealth-pg -c postgres -- psql -U vhhealth -d vhhealth -c "SELECT e.id, e.status, e.corrective_action, e.disposition_note, e.closed_at FROM cold_chain_excursions e WHERE e.id = <EXCURSION_ID>;"
```

Post-incident:
- Attach the temperature-register export to the pharmacy or blood-bank incident record.
- If the cause was a dead sensor, open a biomed work order.
- If the cause was door-open behavior, assign a department training action.
- Never bulk-delete `cold_chain_readings` or `cold_chain_excursions`; they are the audit evidence.
