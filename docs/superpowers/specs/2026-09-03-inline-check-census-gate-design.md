# Inline CHECK census gate (OPEN-23 detection gate)

**Date:** 2026-09-03
**Scope:** `scripts/ci/check-inline-check-census.mjs`, `scripts/ci/check-inline-check-census.test.mjs`,
`scripts/ci/inline-check-census.json`, one `run` line each in `scripts/ci/security.mjs` and the
backend lint-and-test workflow. No migration is added and no constraint is changed.
**Status:** implemented on `fix/inline-check-census-gate` (off main after #987).
**Origin:** audit row OPEN-23, detection half only; brief from the coordinating session.

## The defect being detected

Migrations apply sorted by name and `000_baseline.sql` runs first. A later migration that
re-declares a baseline-owned table with `CREATE TABLE IF NOT EXISTS` is a no-op for the table, so
every inline CHECK in that declaration is discarded silently. The baseline is a `pg_dump` of a
database bootstrapped by `prisma db push`, which cannot express CHECK constraints, so the tables
that were Prisma models were frozen without them and regenerating the baseline reproduces the loss.

Measured on main's corpus (736 migrations) against a base built the way CI does it (empty database,
extensions, `ci-setup-db.mjs`):

| | count |
|---|---|
| inline CHECK clauses in `CREATE TABLE` statements across all migrations | 2,194 |
| of which inside `IF NOT EXISTS` re-declarations of baseline-owned tables (the census) | 465, in 209 tables and 101 files |
| census clauses present in `pg_constraint` | 54 (27 tables fully present, 4 partial) |
| census clauses absent | 411, in 182 tables and 86 files |
| re-declarations of tables first created by a *migration* | 0 |

The ledger's figures (369 / 157 / 82) were produced differently; the census defines its own method
below and the ledger is reconciled to it by its owner. No census clause exists under a different
name (fingerprint search found none), so presence by name is a sound test.

## Design

### Two halves, because the two requirements pull apart

A gate that must not be skippable by tier routing has to live in the security stage, which has no
database. A gate that compares against `pg_constraint` needs a bootstrapped database, which only
the tier-routed backend job has. The census is derivable statically: an inline CHECK inside
`CREATE TABLE IF NOT EXISTS <t>` where `<t>` is created by `000_baseline.sql` is discarded by
construction unless the baseline's own declaration of `<t>` carried it. So:

1. **Static census and regression guard** (security stage, unconditional): rebuild the inventory
   from the migration files and compare it with the pinned manifest.
2. **Calibration** (backend job, after `ci-setup-db.mjs`, beside `check-schema-drift.mjs`): for
   every manifest entry, presence in `pg_constraint` must equal the manifest's `enforced` flag, in
   both directions, with zero discrepancies. A constraint the static pass calls absent but which
   exists is as much a classifier bug as the reverse.

### Inventory extraction

The scanner walks each migration skipping line and block comments, string literals and
dollar-quoted bodies, finds `CREATE [UNLOGGED|TEMP] TABLE [IF NOT EXISTS] [schema.]name (`,
captures the balanced body, splits it at top-level commas, and extracts every `CHECK (...)` with
its optional `CONSTRAINT name`, recording whether the item was a column definition or a table
constraint. Baseline-owned tables are the `CREATE TABLE public.<name> (` set in `000_baseline.sql`.

### The name Postgres would have given

Presence is tested by constraint name, so the gate reproduces Postgres's rule for unnamed CHECKs:
if the expression references exactly one column the name is `<table>_<column>_check`, otherwise
`<table>_check`, truncated by `makeObjectName` to 63 bytes, with `1`, `2`, … appended on collision
within the table. The referenced-column set comes from the OPEN-14 parser
(`apps/backend/scripts/lib/checkConstraintValues.mjs`: `parseCheckDefinition`,
`referencedColumns`), which already parses every CHECK definition on main. Calibrated on the 1,729
inline CHECKs of tables that migrations create: 98.3 % are found under the predicted name; the
remainder are tables or constraints a later migration dropped, listed by the calibration output.

### Census key

Entries are keyed by `(file, table, constraintName)` with a `clauseSha256` over the
whitespace-normalised clause, plus the clause text for the worklist. The alternative, a normalised
expression identity, was rejected: applied migrations are immutable (`check-migration-immutability`)
so reformatting is not a live risk; whitespace normalisation covers the residual; and the
constraint name is both stable and the key the calibration looks up. A clause edit changes the
sha and is reported as a change (and is an immutability violation anyway).

### Manifest

`scripts/ci/inline-check-census.json`, modelled on `dead-code-retirements.json`: `schemaVersion`,
`evidence` (baseline file, ledger path, generating head), `expectedAbsentCount`, and `entries`
each with `id`, `file`, `table`, `kind` (`column`|`table`), `column`, `constraintName`,
`clauseSha256`, `clause`, `enforced`.

### Rules the static gate enforces

- The set of entry ids rebuilt from the corpus equals the manifest's set. A new id fails with
  "new inline CHECK in a re-declaration of a baseline-owned table: it will never exist; add it with
  `ALTER TABLE … ADD CONSTRAINT` in a forward migration". A missing id fails with "declared
  constraint removed from an applied migration".
- Every entry's `clauseSha256` matches the corpus.
- The number of entries with `enforced: false` equals `expectedAbsentCount`. Growth fails.
- Shrinking is a manifest-only edit: when a forward migration adds the constraint (under the same
  name, or the entry's `constraintName` is updated to the new one), the author flips `enforced` to
  true and decrements the count; the calibration confirms presence. Nothing else changes, so
  remediation is rewarded, not blocked.

### Wiring, and why it cannot be skipped

`scripts/ci/security.mjs` runs the meta-test then the gate, next to the dead-code guard, because
`security` is the only stage every canonical plan selects. The meta-test asserts both `run` lines
exist in `security.mjs` and that the backend workflow carries the `--verify-db` step, so removing
the wiring fails CI. This is the OPEN-20 arrangement applied again.

### Reporting

The gate prints the per-table breakdown (absent, enforced, files) and, with `--report`, the full
worklist grouped by table, so the triage lane starts from the census rather than from the ledger's
sample. The two caller-controlled columns the ledger names (`maternity_pregnancies.edd_method`,
`booking_status`) appear in the `maternity_pregnancies` group.

## Tests (node --test, in the security stage)

- Synthetic fixture (a mini baseline with two tables, three migrations): the exact fixture passes.
- Removing a satisfied inline CHECK from a fixture migration fails (declared constraint removed).
- Decrementing `expectedAbsentCount` without a fix fails; deleting an absent entry fails.
- Adding a new inline CHECK to a re-declaration fails; adding one to a table the migration creates
  passes (not in the census).
- A genuinely fixed constraint: flip `enforced` and decrement, with a `pg_constraint` snapshot that
  contains it, passes both the static gate and the calibration; the same manifest against a
  snapshot without it fails the calibration; an entry marked absent whose constraint is present
  fails the calibration (the other direction).
- The real manifest matches the real corpus exactly (the equivalent of the dead-code guard's
  "exact current tree" test).
- Wiring: both `run` lines in `security.mjs`, the workflow step present.

## Verification

Static gate and meta-test green locally; calibration green against the schema-only base with zero
discrepancies in both directions; census totals reproduced; `npm run lint` in the backend
(untouched) and the security stage's own checks; canonical CI with `[full-ci]`.

## Out of scope, deliberately

Triage of the 411 (sole guard vs mirrored in code), data audit for violating rows, backfill, and the
forward migrations that add the constraints. Editing `155_maternity_workflow.sql` or the baseline.
