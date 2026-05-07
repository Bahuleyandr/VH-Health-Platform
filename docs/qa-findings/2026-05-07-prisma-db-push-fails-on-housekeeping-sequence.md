---
id: 2026-05-07-prisma-db-push-fails-on-housekeeping-sequence
run_id: 2026-05-07-bootstrap-001
started_at: 2026-05-07T17:30:00Z
finished_at: 2026-05-07T17:32:00Z
git_sha: 56ae53fc6a95df26713ff4915740114263459991
seed_version: pre-bootstrap
base_url: http://127.0.0.1:55432
tenant_id: "00000000-0000-4000-8000-000000000001"
scenario: First QA harness run — schema bootstrap on a fresh vhhealth_test DB
command: 'NODE_ENV=qa VH_QA_RESET_CONFIRM=vhhealth_test DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test PG_BIN="C:/Program Files/PostgreSQL/17/bin" node scripts/qa-reset.mjs'
exit_code: 1
severity: high
area: schema
repro_steps:
  - "Drop the test DB and recreate empty: psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -c 'DROP DATABASE IF EXISTS vhhealth_test'"
  - "psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -c 'CREATE DATABASE vhhealth_test'"
  - "Run scripts/qa-reset.mjs with the env above (or apps/backend/scripts/ensure-test-db.mjs directly)."
  - "Bootstrap fails inside `prisma db push --skip-generate --accept-data-loss` with P1014."
expected: "`prisma db push` populates the schema cleanly so the hybrid SQL migrations (148–168) can apply on top."
actual: |
  Prisma errors out:

      Error: P1014
      The underlying table for model `housekeeping_log_number_seq` does not exist.

  Schema is left in a half-applied state after `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`. No tables exist when `db push` is invoked, so it cannot be a leftover-state issue.
artifacts:
  - "(orchestrator was running directly; raw output captured in this finding's body)"
confidence: high
status: open
first_seen_run: 2026-05-07-bootstrap-001
linked_issues: []
---

## Symptom

A clean QA reset on a freshly-recreated `vhhealth_test` database fails
during the Prisma `db push` step. Prisma reports model
`housekeeping_log_number_seq` has no underlying table.

This is the first stage of `scripts/qa-reset.mjs`, so the entire QA
harness is currently blocked on a green pass. The orchestrator never
gets to admin / patient / staff smokes.

## Reproduction

```bash
# 1. Start the local test Postgres cluster (if not already up)
"C:/Program Files/PostgreSQL/17/bin/pg_ctl.exe" \
  -D "D:/Dev/Tools/vhhealth-test-postgres-data" \
  -o "-p 55432" \
  -l "D:/Dev/Tools/vhhealth-test-postgres-data/postgres.log" start

# 2. Recreate the test DB cleanly
psql -h 127.0.0.1 -p 55432 -U postgres -d postgres \
  -c 'DROP DATABASE IF EXISTS vhhealth_test'
psql -h 127.0.0.1 -p 55432 -U postgres -d postgres \
  -c 'CREATE DATABASE vhhealth_test'

# 3. Trigger the failure (any of these reproduce it)
NODE_ENV=qa \
  VH_QA_RESET_CONFIRM=vhhealth_test \
  DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test \
  PG_BIN="C:/Program Files/PostgreSQL/17/bin" \
  node scripts/qa-reset.mjs

# Or, equivalently, just the upstream bootstrap script:
node apps/backend/scripts/ensure-test-db.mjs
```

Both paths surface the same error.

## Hypothesis (clearly marked, not yet verified)

`apps/backend/prisma/schema.prisma` line 8938 declares:

```prisma
log_number  String  @unique @default(dbgenerated(
  "((('HKL-'::text || to_char(now(), 'YYYYMMDD'::text))
    || '-'::text)
    || lpad((nextval('housekeeping_log_number_seq'::regclass))::text, 6, '0'::text))"
)) @db.VarChar(40)
```

The sequence `housekeeping_log_number_seq` is created in
`apps/backend/src/migrations/145_staff_operational_workflow_tables.sql`,
which only runs **after** `prisma db push` completes (via
`scripts/ci-setup-db.mjs`). On a fresh DB, the sequence does not yet
exist when Prisma tries to evaluate or validate the default
expression — so `db push` rejects the schema.

If the hypothesis holds, the fix has three plausible shapes:

1. **Pre-create the sequence in `ensure-test-db.mjs`** before the
   `db push` step — i.e. run `CREATE SEQUENCE IF NOT EXISTS
   housekeeping_log_number_seq` (and any other forward-referenced
   sequences) in the same `psql` call that creates `pgcrypto`,
   `pgvector`, etc. Cheapest, most local fix.
2. **Move the sequence into Prisma's view of the world** by adding a
   lightweight Prisma model or a migration ordered before the
   `dbgenerated` reference. Higher coupling but eliminates the chicken/egg
   altogether.
3. **Drop the `dbgenerated` default from `schema.prisma`** and rely
   solely on the application layer / migration 145 to populate the
   default. Reduces schema fidelity but unblocks bootstrap.

## Why this matters

- Anyone running the smoke suite locally on a fresh DB hits this.
- `apps/backend/scripts/ensure-test-db.mjs` is the canonical local
  bootstrap mentioned in `apps/backend/CLAUDE.md` — it should not be
  broken on `main`.
- CI's `smoke-e2e.yml` may be papering over this with a different
  bootstrap path; the locally-reproducible failure is real regardless.

## Artifacts

Live stderr captured during the bootstrap attempt:

```
Resetting local test database schema
NOTICE:  drop cascades to extension pgcrypto
DROP SCHEMA
CREATE SCHEMA
CREATE EXTENSION
CREATE SEQUENCE
DO
Syncing Prisma schema into local test database
Prisma schema loaded from prisma\schema.prisma
Datasource "db": PostgreSQL database "vhhealth_test", schema "public" at "127.0.0.1:55432"
Error: P1014

The underlying table for model `housekeeping_log_number_seq` does not exist.
```

## Re-observations

(none yet — first sighting on run `2026-05-07-bootstrap-001`)
