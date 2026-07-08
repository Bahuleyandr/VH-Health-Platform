# Backend load testing (roadmap A5)

`hospital-day.js` models the three load shapes that hurt an HIS: the OPD
registration rush, ward-wide MAR pulls at med-pass hours, and constant admin
dashboard polling. SLOs are encoded as k6 thresholds, so a breached SLO fails
the run and can gate releases.

`hospital-day-500bed.js` is the NL12-S3 capacity profile. It is not a laptop
gate and it is not just the baseline profile with higher VUs. It models a
500-bed synthetic census, shift-change pressure, ward med-pass concurrency,
bed-board reads, admin dashboard fan-out, and SLO probe traffic. Full runs
require owner approval, production-shaped infrastructure, and seeded synthetic
patients only.

## SLOs (v1 — revisit after first real-hardware baseline)

| Metric | Target |
|---|---|
| Chart/list read latency | p95 < 400 ms |
| Clinical write latency | p95 < 800 ms |
| Error rate (non-2xx/3xx, excl. 429) | < 1 % |
| Throttled rate during 500-bed run | < 5 % |

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

### NL12-S3 500-bed profile

Smoke mode keeps the guardrail low enough for syntax and endpoint wiring checks:

```bash
k6 run -e PROFILE=smoke \
  -e BASE_URL=http://127.0.0.1:5000 \
  -e API_KEY=$API_KEY -e STAFF_TOKEN=$STAFF -e ADMIN_TOKEN=$ADMIN \
  apps/backend/loadtest/hospital-day-500bed.js
```

Full mode is an operator ceremony. It refuses to run unless the caller confirms
approval, production-shaped infrastructure, and a synthetic patient pool:

```bash
mkdir -p output/loadtest/<date>/nl12-s3-500bed

LOADTEST_500BED_CONFIRM=I_HAVE_APPROVAL_AND_SYNTHETIC_DATA \
PRODUCTION_SHAPED_ENV=confirmed \
OWNER_APPROVED_BY=<owner-or-change-ticket> \
TARGET_ENVIRONMENT=<prod-shaped-env> \
SYNTHETIC_POOL_ID=<pool-id> \
SYNTHETIC_PATIENT_UIDS=<uuid1,uuid2,...> \
LOADTEST_WARD_IDS=<ward-id1,ward-id2,...> \
EVIDENCE_DIR=output/loadtest/<date>/nl12-s3-500bed \
k6 run -e BASE_URL=... -e API_KEY=... -e STAFF_TOKEN=... -e ADMIN_TOKEN=... \
  apps/backend/loadtest/hospital-day-500bed.js
```

The full profile peaks at about 425-440 active VUs by default across OPD rush,
ward rounds, MAR pulls, bed-board reads, admin dashboards, and SLO probes. Use
`LOAD_SCALE=0.5` or another owner-approved value to rehearse below the ceiling.
Those VUs are compressed operator actions, not a one-to-one mapping to beds.

After the run, assemble the evidence bundle:

```bash
LOADTEST_500BED_CONFIRM=I_HAVE_APPROVAL_AND_SYNTHETIC_DATA \
TARGET_ENVIRONMENT=<prod-shaped-env> \
OWNER_APPROVED_BY=<owner-or-change-ticket> \
SYNTHETIC_POOL_ID=<pool-id> \
LOADTEST_WINDOW_START=<iso-start> \
LOADTEST_WINDOW_END=<iso-end> \
K6_SUMMARY_JSON=output/loadtest/<date>/nl12-s3-500bed/k6-summary.json \
PROMETHEUS_URL=<prometheus-url> \
GRAFANA_URL=<grafana-url> \
OUTPUT_DIR=output/loadtest/<date>/nl12-s3-500bed \
npm --prefix apps/backend run load-test:500bed:evidence
```

Complete `500-bed-slo-rebaseline-template.md` beside the raw evidence before
changing any SLO target.

## Interpreting

- Watch `vh_read_latency` p95 against Grafana's backend RED dashboard while
  the run executes — divergence between k6-observed and server-observed
  latency means network/ingress, not app.
- For NL12-S3, compare `vh_500bed_read_latency`,
  `vh_500bed_write_latency`, `vh_500bed_error_rate`, and
  `vh_500bed_throttled_rate` with backend RED, backend reliability, CNPG, and
  SLO burn-rate snapshots.
- Re-baseline after every infra change (Postgres sizing, node changes,
  ingress) and before each pilot go-live. Keep results in
  `output/loadtest/<date>/` (gitignored) with a one-line summary in the
  PR that motivated the run.
