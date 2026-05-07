---
id: 2026-05-08-backend-circuit-breaker-trips-during-qa-reset-schema-drop
run_id: 2026-05-08-full-010
started_at: 2026-05-07T18:44:50Z
finished_at: 2026-05-07T18:45:34Z
git_sha: 93dd3e35455c3905af07e12958985d512fa653e9
seed_version: 14dfe387357e094e
base_url: http://127.0.0.1:5206
tenant_id: "00000000-0000-4000-8000-000000000001"
scenario: End-to-end orchestrator run with backend already running — reset stage's `DROP SCHEMA public CASCADE` window trips the backend's database circuit breaker, all four downstream smoke stages then fail with HTTP 500 "Database circuit breaker is open".
command: 'NODE_ENV=qa VH_QA_RESET_CONFIRM=vhhealth_test DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test PG_BIN="C:/Program Files/PostgreSQL/17/bin" node scripts/qa-orchestrator.mjs --run-id 2026-05-08-full-010'
exit_code: 1
severity: high
area: infra
repro_steps:
  - "Start the QA Postgres cluster on :55432 (per docs/qa-findings/_baseline.md)."
  - "Start the backend in another shell against vhhealth_test: `cd apps/backend && DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test npm run dev`."
  - "Wait for the backend to log `Server listening on :5206`."
  - "Run the orchestrator end-to-end without `--skip-reset`: `node scripts/qa-orchestrator.mjs`."
  - "Reset stage passes (32s). Admin/patient/staff/clinical stages all fail seconds later with 500 'Database circuit breaker is open'."
expected: "Reset stage drops + recreates the schema cleanly; downstream smoke stages then run against a backend that has either reconnected, or whose breaker has half-opened by the time smokes hit it. Either way, the orchestrator must be safe to run end-to-end against a running backend."
actual: |
  qa-runs/2026-05-08-full-010/summary.json:
    reset    passed=true
    admin    passed=false (HTTP 500 × multiple)
    patient  passed=false
    staff    passed=false
    clinical passed=false

  qa-runs/2026-05-08-full-010/admin/stdout.txt (excerpt):
    users_list               500 False Failed to retrieve users
    user_status_inactive     500 False Failed to change user status
    department_create        500 False Failed to create department
    doctors_manage           500 False Failed to retrieve doctor management data
    clinical_ai_status       500 False Database circuit breaker is open - service temporarily unavailable
    clinical_ai_reviews      500 False Database circuit breaker is open - service temporarily unavailable

  Reset stage finished at 2026-05-07T18:45:21.737Z; admin smoke started at
  2026-05-07T18:45:21.739Z (2ms gap). The backend's circuit breaker
  (5 consecutive failures → open for 30s, per
  apps/backend/CLAUDE.md "Database Resilience") had already tripped on
  queries that hit the schema mid-`DROP SCHEMA public CASCADE`.

  Re-running the smokes after a 30s+ pause via `--skip-reset` succeeds
  (qa-runs/2026-05-08-final-014/summary.json: all 4 stages passed,
  same backend process, same seeded data). Confirms the breaker, not
  the schema or seed, was the proximate cause.
artifacts:
  - "qa-runs/2026-05-08-full-010/summary.json"
  - "qa-runs/2026-05-08-full-010/admin/stdout.txt"
  - "qa-runs/2026-05-08-full-010/admin/stderr.txt"
  - "qa-runs/2026-05-08-final-013/summary.json (reset-only, passes when backend stopped)"
  - "qa-runs/2026-05-08-final-014/summary.json (skip-reset smokes, passes after breaker resets)"
  - "qa-runs/backend.log (concurrent backend log; schema-drop window leaks `relation \"...\" does not exist` errors into Prisma)"
confidence: high
status: open
first_seen_run: 2026-05-08-full-010
linked_issues: []
---

## Symptom

When the QA orchestrator is run end-to-end while a backend instance
is already serving against the same `vhhealth_test` database, the
**reset** stage succeeds, but every downstream smoke stage (admin,
patient, staff, clinical) fails with HTTP 500. Many of the failures
return the literal message `Database circuit breaker is open - service
temporarily unavailable`; others surface as `Failed to retrieve users`
/ `Failed to create department` / etc. but trace back to the same
breaker.

The orchestrator's reset stage performs:

```sql
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
-- ... extensions, then prisma db push, then 168 raw migrations,
-- then comprehensive seed, then qa-tenant seed.
```

Anything the running backend touches against `vhhealth_test` during
that window — scheduled cron jobs (R2 cleanup, archive migration,
canary health check, FCM cleanup, audit log rotation), `/health/metrics`
probes, in-flight requests, etc. — will hit a partially-rebuilt schema
and surface `relation "..." does not exist` (Postgres code 42P01).

Five consecutive such failures opens the circuit breaker (per
`apps/backend/CLAUDE.md` → "Database Resilience"). The breaker stays
open for 30s. Reset takes ~30s and smokes start ~2ms after reset
finishes, so the breaker is still open during the smoke window.

## Why this is a real platform finding (not a harness bug)

In production, the same class of disruption can occur during:

- A planned schema migration that briefly takes a `DROP TABLE` or
  `ALTER TABLE ... RENAME` on a hot table.
- A failover where the primary replica is briefly unreachable.
- Any operator-driven `pg_terminate_backend` cleanup of a runaway
  query.

In all three, the breaker can latch open for 30s **after** the cause
is gone, and any client that retries within that window will see a
500 with a misleading "circuit breaker is open" message. The breaker
is intentional — it protects the pool — but the lack of half-open
fast-path means a single transient burst forces a fixed 30s outage.

## Workaround used to validate the housekeeping/APGAR fix

For the `qa-fix/2026-05-07-prisma-db-push-fails-on-housekeeping-sequence`
branch, validation ran in two phases:

1. **Reset phase (backend stopped).** Stop the backend, run
   `node scripts/qa-orchestrator.mjs --stages reset`. Reset passes
   cleanly because no client is touching the schema mid-drop.
   See `qa-runs/2026-05-08-final-013/summary.json` (reset only, 32s, passed).
2. **Smoke phase (backend running, `--skip-reset`).** Restart the
   backend so it sees the freshly-built schema, then
   `node scripts/qa-orchestrator.mjs --skip-reset`. All four smokes
   pass (`qa-runs/2026-05-08-final-014/summary.json`, 10.9s).

This is **not** an acceptable long-term mode of operation — the QA
harness's headline value is end-to-end pass-without-special-handling.
Filing this finding so the platform team can fix the breaker behavior
or the orchestrator can sequence around it.

## Plausible fixes

1. **Orchestrator-side: stop/start backend across reset.**
   Have `scripts/qa-orchestrator.mjs` SIGTERM the local backend before
   the `reset` stage and respawn it after, only for local-target runs.
   Keeps the "end-to-end orchestrator just works" property without
   touching backend code. Smallest blast radius. Doesn't help the
   production failover case.
2. **Backend-side: shorten breaker open window or add half-open
   probe.** `src/lib/prisma.js` currently keeps the breaker open
   for a fixed 30s after 5 consecutive failures. A 1–2s probe via
   `SELECT 1` after the first second of open state would let the
   breaker recover as soon as the schema is back. Would also
   improve the production failover case.
3. **Backend-side: distinguish schema-not-found from infra failure.**
   Postgres error 42P01 (relation does not exist) is not a real
   infrastructure failure — it's a known-bad query. Excluding 42P01
   from the breaker's failure counter would prevent a single
   bad migration window from latching the breaker open.
4. **Reset-side: `pg_terminate_backend` of competing sessions before
   `DROP SCHEMA`.** The reset script could explicitly terminate
   non-`qa_writer` sessions on `vhhealth_test` before the drop, and
   refuse to proceed if any survive. Doesn't fix the root cause but
   fails fast with a clear message instead of a misleading 500.

The QA harness is local-only and disposable, so option 1 is enough
to unblock the orchestrator's headline use case. Options 2 and 3 are
real platform improvements that should be considered separately.

## Why this matters

Until this is fixed, the QA orchestrator's report-mode pitch — "run
the harness end-to-end, get a clean pass or a focused finding" — is
gated on the operator manually stopping/starting the backend around
the reset stage. That is a documented but ugly carve-out, and any
new contributor will hit it. The "end-to-end orchestrator pass"
gate in `docs/qa/MODES.md` step 5 quietly relaxes to "two-phase
orchestrator pass" today, which is not what the doc says.
