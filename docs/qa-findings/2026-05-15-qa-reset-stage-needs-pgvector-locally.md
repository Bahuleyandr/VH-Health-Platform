---
id: 2026-05-15-qa-reset-stage-needs-pgvector-locally
run_id: 2026-05-15-ed0c8afc
started_at: 2026-05-15T09:21:52.589Z
finished_at: 2026-05-15T09:21:53.911Z
git_sha: 467b207307d99d7cfd7f0f164191d262a366a6ef
seed_version: none
base_url: http://127.0.0.1:5206
tenant_id: 00000000-0000-4000-8000-000000000001
scenario: orchestrator's default reset stage cannot bootstrap a fresh QA DB on a host without the pgvector Postgres extension
command: node scripts/qa-orchestrator.mjs
exit_code: 1
severity: medium
area: infra
repro_steps:
  - "Start postgres: node apps/backend/scripts/qa-cluster-up.mjs (this works — applies all 236 raw migrations)"
  - "Run the orchestrator with all default stages: DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test VH_QA_RESET_CONFIRM=vhhealth_test NODE_ENV=test node scripts/qa-orchestrator.mjs"
  - "Inspect qa-runs/<run_id>/reset/stderr.txt — ensure-test-db.mjs aborts because prisma/schema.prisma uses Unsupported(\"vector\")"
expected: |
  reset stage bootstraps the schema and emits seed_version into qa_seed_meta, so downstream stages observe a known-good DB. Same behaviour the 2026-05-08 runs had.
actual: |
  reset stage exits 2 with `Local test DB setup requires pgvector because prisma/schema.prisma contains Unsupported("vector"). Install the vector extension for local Postgres, or run the Docker-backed guardrail: npm run ci:db-guardrails:docker`. Orchestrator aborts subsequent stages — even though the DB on 55432 already has all 236 raw migrations applied via qa-cluster-up.mjs and would work for every downstream smoke.
artifacts:
  - qa-runs/2026-05-15-ed0c8afc/reset/stderr.txt
  - qa-runs/2026-05-15-ed0c8afc/reset/stdout.txt
  - qa-runs/2026-05-15-ed0c8afc/summary.json
confidence: high
status: open
---

## Symptom

A fresh `node scripts/qa-orchestrator.mjs` run with the default stage
list (`reset, admin, patient, staff, clinical`) fails immediately at
the reset stage. Failure output:

```
NOTICE:  extension "pgcrypto" already exists, skipping
Local test DB setup requires pgvector because prisma/schema.prisma
contains Unsupported("vector"). Install the vector extension for local
Postgres, or run the Docker-backed guardrail:
  npm run ci:db-guardrails:docker
[qa-reset] FATAL: schema bootstrap (ensure-test-db) failed with exit code 1
```

Because the orchestrator treats `reset` as a hard prerequisite for
later stages (`scripts/qa-orchestrator.mjs:253-256`: `if (stage ===
'reset' && report.exit_code !== 0) { log('reset failed — aborting
subsequent stages'); break; }`), every downstream stage is also
skipped — the entire harness is gated on a Postgres extension that
the local install on Trenzalore doesn't have.

This is consistent with the [`project_vh_health_schema_drift_fix.md`
memory note](../../../.. /memory): the source of truth has been moved
to raw SQL migrations + `pgvector:pg16` Docker, but `qa-reset.mjs`
still runs against the host Postgres 17 cluster on 55432, which has
no vector extension.

## Reproduction

```bash
node apps/backend/scripts/qa-cluster-up.mjs   # idempotent; 236 migrations applied
DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test \
  VH_QA_RESET_CONFIRM=vhhealth_test NODE_ENV=test \
  node scripts/qa-orchestrator.mjs            # aborts at reset
```

The workaround for this report-only pass was to skip the reset stage:

```bash
node scripts/qa-orchestrator.mjs --stages admin,patient,staff,clinical
```

…which then runs against whatever the DB was last left in. That works,
but the absence of a seed step means `summary.json.seed_version` is
`null` and the smoke patient / staff / clinical stages run against
whatever shape the DB happens to be in. Acceptable for a focused
report-only pass, not acceptable for a clean baseline.

## Hypothesis

Two reasonable paths:

1. **Wire the orchestrator to detect the missing extension and fall
   through to the Docker bootstrap.** `ensure-test-db.mjs` already
   surfaces the error string. `qa-reset.mjs` could `spawn` the
   `ci:db-guardrails:docker` script instead of exiting 2 — gated on
   `process.env.VH_QA_BOOTSTRAP_BACKEND=docker` so it doesn't
   surprise people who deliberately want to run against a host
   Postgres without vector.
2. **Document the prerequisite in `docs/qa/README.md` and the
   `vh-health-qa` skill.** The skill currently tells the user how to
   start backend/admin but doesn't surface the pgvector requirement.
   This is the lowest-effort fix and arguably the right one for a dev
   workstation — the QA cluster on this rig has always had a
   no-pgvector caveat (see `project_vh_health_schema_drift_fix.md`).

## Notes

- The `--skip-reset` flag on `qa-orchestrator.mjs` doesn't currently
  exist; only `--stages a,b,c` is honoured. Adding `--skip-reset` as
  a one-liner alias would smooth the workaround above.
- This is **not** a regression introduced by the wave 1–4 changes —
  it's an environment / infra mismatch that has always been latent.
  Filing it as a finding because it cost ~10 min of triage time
  during this report-only pass.

## Artifacts

- [`qa-runs/2026-05-15-ed0c8afc/reset/stderr.txt`](../../qa-runs/2026-05-15-ed0c8afc/reset/stderr.txt)
- [`qa-runs/2026-05-15-ed0c8afc/summary.json`](../../qa-runs/2026-05-15-ed0c8afc/summary.json)
- `apps/backend/scripts/ensure-test-db.mjs` — the abort path
- `scripts/qa-reset.mjs` — caller that re-raises
