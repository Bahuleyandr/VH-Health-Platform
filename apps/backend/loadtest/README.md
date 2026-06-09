# Backend load testing (roadmap A5)

`hospital-day.js` models the three load shapes that hurt an HIS: the OPD
registration rush, ward-wide MAR pulls at med-pass hours, and constant admin
dashboard polling. SLOs are encoded as k6 thresholds — a breached SLO fails
the run, so this can gate releases.

## SLOs (v1 — revisit after first real-hardware baseline)

| Metric | Target |
|---|---|
| Chart/list read latency | p95 < 400 ms |
| Clinical write latency | p95 < 800 ms |
| Error rate (non-2xx/3xx, excl. 429) | < 1 % |

## Running

Install k6 (https://k6.io/docs/get-started/installation/ — single binary).

```bash
# 1. Mint tokens against the target environment (QA shown):
#    staff:  POST /api/v1/auth/staff/login  { employeeId: EMP-1004, password: test1234 }
#    admin:  POST /api/v1/auth/admin/login

# 2. Smoke profile (~2 min, low VUs — CI-friendly):
k6 run -e PROFILE=smoke \
  -e BASE_URL=http://127.0.0.1:5000 \
  -e API_KEY=$API_KEY -e STAFF_TOKEN=$STAFF -e ADMIN_TOKEN=$ADMIN \
  apps/backend/loadtest/hospital-day.js

# 3. Full profile (~20 min, 40/25/5 VUs) — run against a prod-shaped
#    environment (CNPG, real hardware), never against a laptop Postgres:
k6 run -e BASE_URL=... -e API_KEY=... -e STAFF_TOKEN=... -e ADMIN_TOKEN=... \
  apps/backend/loadtest/hospital-day.js
```

Optional: set `LOADTEST_PATIENT_UID` to a dedicated synthetic patient to
exercise the vitals write path. Never point it at a real patient.

## Interpreting

- Watch `vh_read_latency` p95 against Grafana's backend RED dashboard while
  the run executes — divergence between k6-observed and server-observed
  latency means network/ingress, not app.
- Re-baseline after every infra change (Postgres sizing, node changes,
  ingress) and before each pilot go-live. Keep results in
  `output/loadtest/<date>/` (gitignored) with a one-line summary in the
  PR that motivated the run.
