---
id: 2026-05-07-prisma-db-push-column-ref-in-apgar-default
run_id: 2026-05-07-fix-housekeeping-001
started_at: 2026-05-07T18:05:00Z
finished_at: 2026-05-07T18:05:03Z
git_sha: 9e80e43f
seed_version: pre-bootstrap
base_url: http://127.0.0.1:55432
tenant_id: "00000000-0000-4000-8000-000000000001"
scenario: Schema bootstrap, second blocker — surfaced after the housekeeping_log_number_seq fix unblocked Prisma's earlier validation pass.
command: 'NODE_ENV=qa VH_QA_RESET_CONFIRM=vhhealth_test DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test PG_BIN="C:/Program Files/PostgreSQL/17/bin" node scripts/qa-orchestrator.mjs --stages reset'
exit_code: 1
severity: high
area: schema
repro_steps:
  - "Apply the housekeeping_log_number_seq fix from finding 2026-05-07-prisma-db-push-fails-on-housekeeping-sequence."
  - "Drop and recreate vhhealth_test (DROP DATABASE / CREATE DATABASE)."
  - "Run scripts/qa-orchestrator.mjs --stages reset (or apps/backend/scripts/ensure-test-db.mjs directly)."
  - "Bootstrap fails inside `prisma db push` with `cannot use column reference in DEFAULT expression`."
expected: "`prisma db push` populates the schema without error."
actual: |
  Postgres rejects the CREATE TABLE for `maternity_apgar_scores`:

      Error: ERROR: cannot use column reference in DEFAULT expression
         0: sql_schema_connector::apply_migration::migration_step
                 with step=CreateTable { table_id: TableId(360) }

  Root cause: `apps/backend/prisma/schema.prisma` line 9285 declares

      total_score Int? @default(dbgenerated("((((COALESCE(appearance, 0) + COALESCE(pulse, 0)) + COALESCE(grimace, 0)) + COALESCE(activity, 0)) + COALESCE(respiration, 0))"))

  But in `apps/backend/src/migrations/155_maternity_workflow.sql` the
  same column is defined as

      total_score INTEGER GENERATED ALWAYS AS (COALESCE(appearance,0)+COALESCE(pulse,0)+COALESCE(grimace,0)+COALESCE(activity,0)+COALESCE(respiration,0)) STORED

  Prisma's `db pull` represented the GENERATED column as `@default(dbgenerated(...))`,
  but Postgres only accepts column references inside `GENERATED ALWAYS AS`,
  not inside `DEFAULT`. So `db push` blows up on the column.
artifacts:
  - "qa-runs/2026-05-07-fix-housekeeping-001/reset/{stdout,stderr}.txt"
confidence: high
status: fixed
first_seen_run: 2026-05-07-fix-housekeeping-001
fixed_at: 2026-05-08T02:55:00Z
fixed_in_sha: 77fdc6b965fc42b5d8c08a5bf48b3d0c6d5d65a7
linked_issues:
  - "branch: qa-fix/2026-05-07-prisma-db-push-fails-on-housekeeping-sequence (merged, deleted)"
  - "PR: #65"
---

## Symptom

After unblocking the housekeeping_log_number_seq sequence (see the prior
finding), `prisma db push` proceeds further but now aborts with:

```
Error: ERROR: cannot use column reference in DEFAULT expression
   0: sql_schema_connector::apply_migration::migration_step
           with step=CreateTable { table_id: TableId(360) }
```

`maternity_apgar_scores.total_score` is the offender. Postgres reserves
column references for `GENERATED ALWAYS AS (...)` columns; they cannot
appear inside `DEFAULT`.

## Why this exists

`prisma db pull` (last run during batch-24 schema regen) introspected
the `total_score` column as a default expression rather than as a
GENERATED column, because the Prisma schema language has no
representation for stored-generated columns. The migration is correct;
the introspection is lossy.

## Plausible fixes

1. **Drop the `@default(dbgenerated(...))` from `schema.prisma` line 9285.**
   Smallest blast radius. The column type stays `Int?`, which is what
   the migration emits. `prisma db push` will create the column without
   a default; in production the migration's `GENERATED ALWAYS AS`
   provides the correct behavior.
2. **Stop introspecting this model** — flag it with a `/// @ignore`-style
   doc comment or remove from schema.prisma so `db pull` won't
   regenerate the broken default. The model already carries the
   "additional setup for migrations" warning; this would just be
   stronger.
3. **Have ensure-test-db.mjs drop the `maternity_apgar_scores` table
   after `db push`** so migration 155's `CREATE TABLE IF NOT EXISTS`
   creates it fresh with the GENERATED column. Restores test/prod
   parity for that single column. Worth doing alongside option 1 if any
   tests rely on GENERATED behavior; defer if none currently do.

## Impact on the harness

This is the second of (potentially) several bootstrap regressions on
the schema-bootstrap path. The QA orchestrator's `reset` stage cannot
go green until `db push` completes cleanly. This blocks every
downstream stage (admin / patient / staff / clinical) on a fresh DB.

## Fix attempt — `qa-fix/2026-05-07-prisma-db-push-fails-on-housekeeping-sequence`

Picked **option 1** from the plausible fixes above: drop the
`@default(dbgenerated(...))` from the `total_score` column. Migration
155's `GENERATED ALWAYS AS (...) STORED` clause already handles
test+prod for that column; Prisma's view of the column as a plain
`Int?` is the closest faithful representation Prisma's schema language
supports.

### Diff

`apps/backend/prisma/schema.prisma` (`model maternity_apgar_scores`):

```diff
   grimace            Int?
   activity           Int?
   respiration        Int?
-  total_score        Int?               @default(dbgenerated("((((COALESCE(appearance, 0) + COALESCE(pulse, 0)) + COALESCE(grimace, 0)) + COALESCE(activity, 0)) + COALESCE(respiration, 0))"))
+  total_score        Int?
   recorded_by        String?            @db.Uuid
```

No production migration is touched; the migration is the source of
truth for this column and is unchanged.

### Bundled with

This fix landed on the same `qa-fix/2026-05-07-prisma-db-push-fails-on-housekeeping-sequence`
branch as the housekeeping sequence fix and two downstream
seed/grant fixes. See that finding's "Fix attempt" section for the
full bundle rationale and validation runs.

### Validation

- `qa-runs/2026-05-08-final-013/summary.json` — reset stage,
  including `prisma db push` over the fixed schema, passes
  (32.0s, exit 0). The previous "cannot use column reference in
  DEFAULT expression" error no longer surfaces.
- `qa-runs/2026-05-08-final-014/summary.json` — downstream smokes
  pass (10.9s, all 4 stages exit 0), confirming the column behavior
  remains correct end-to-end after the GENERATED migration runs.
