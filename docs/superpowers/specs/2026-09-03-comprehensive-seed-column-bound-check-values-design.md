# Comprehensive seed: column-bound CHECK values (OPEN-14)

**Date:** 2026-09-03
**Scope:** `apps/backend/scripts/seed-comprehensive-test-data.mjs` (`checkedValue` and three entries
of `TABLE_COLUMN_SEED_OVERRIDES`), a new `apps/backend/scripts/lib/checkConstraintValues.mjs`, and
its unit test.
**Status:** implemented on `fix/seed-checked-value-column-bound` (branched from main `5b9b765b3`,
rebased onto `9e70d950d` after #982 landed; no file overlap).
**Origin:** audit row OPEN-14; brief from the coordinating session, 2026-09-03. Design decisions were
taken through the advocate / challenger / supervisor protocol against the measurements below.

## The defect

`checkedValue(checksByTable, table, column)` picks a seed value for a text column by scanning the
table's CHECK definitions for a quoted literal. Measured on main's schema (migration tip 762:
2,107 CHECK constraints, 5,654 text columns), it has three faults:

1. **Substring column gate.** `lowerDefinition.includes(lowerColumn)` lets `status` match a
   definition that mentions only `hbsag_status` or `order_status`. 65 columns take their value this
   way (`dialysis_patients.status = 'negative'` comes from the HBsAg check).
2. **Whole-definition harvest, first literal wins.** Literals are collected from the entire
   definition regardless of which conjunct constrains the requested column. 968 columns take a
   literal from a multi-column CHECK: `bulk_revision_jobs.hr_signature_sha256 = 'building'`,
   `diagnostic_result_generations.classification = 'object'` (from a `jsonb_typeof` check) and
   `clinical_ai_trial_sync_runs.source = 'clinicaltrials_gov_v2:legacy:%'` (a LIKE pattern) are
   representative.
3. **The answer depends on definition order.** With the same schema, 199 text columns return a
   different literal when the definitions are presented in reverse.

Only NOT NULL text columns reach the function on the generic path (nullable columns without an
override are left null), and 148 tables are seeded by hand and never consult it. Of the NOT NULL
columns, 1,483 currently get their value from `checkedValue`.

### Ordering is not a fix

The audit row and the three pin comments describe unordered catalog iteration. That was true when
the pins were written but is no longer so: commit `dce625f48` (2026-08-30) added
`ORDER BY conrelid::regclass::text, conname` to the constraint query. The ordering froze one
arbitrary answer per column rather than choosing a correct one. `facility_asset_events.event_type`
is the proof: under constraint-name order `chk_facility_asset_event_transition` sorts before
`chk_facility_asset_event_type`, so the function returns `'status_changed'`, the branch that requires
`to_status`, which the walker leaves null. The row fails deterministically, and the override pin for
that table exists precisely to cover the frozen wrong answer. `pharmacy_funding_decision_events`
resolves to `'FUNDING_RESOLVED'` the same way. Because the order is now stable, repeated
fresh-database seed runs cannot vary it and say nothing about order sensitivity; only a test that
presents both orders can.

## Design

### Where the logic lives

The parser and the value policy live in `apps/backend/scripts/lib/checkConstraintValues.mjs`, a
pure ESM module with no database or filesystem dependency, imported by the seeder and by the unit
test through the existing `scripts/lib` pattern (`abdmPreflight.mjs`, `migrationBatchGuard.mjs`).
The seeder's `checksByTable: Map<table, string[]>` and its constraint query are unchanged;
`checkedValue` keeps the text-type gate and delegates.

### Parsing depth: boolean skeleton with classified atoms

`pg_get_constraintdef` emits deparsed SQL. The module tokenizes it (string literals with `''`
escapes, quoted and bare identifiers, `::type` casts including multi-word types and array suffixes,
numbers, operators, punctuation) and parses only the boolean skeleton: parentheses, `AND`, `OR`,
`NOT`. Everything between boolean operators is an *atom*, kept as a token span. A parenthesised
span is a boolean group only when what follows it is a boolean operator, a closing paren or the
end; otherwise it belongs to an atom (`(col)::text = ...`). `CASE ... END` is consumed as one atom.
A trailing `NOT VALID` or `NO INHERIT` is stripped before parsing; 42 constraints on main carry it.

Atoms are classified by the shapes that bind a string literal to a column:

| atom shape | classification |
|---|---|
| `col [::cast] = 'lit'`, also `func(col) = 'lit'` | positive, literal bound to `col` |
| `col = ANY ((ARRAY['a', 'b', ...])[::cast])` | positive list, in list order |
| `col <> 'lit'`, `col <> ALL (ARRAY[...])` | negative |
| `col ~ / ~* / !~ / !~* / LIKE / ILIKE / SIMILAR TO 'pattern'` | format (contributes no literal) |
| `col IS [NOT] NULL` | null-ness |
| anything else | opaque; its identifiers still count as referenced columns |

Function names (an identifier followed by `(`) and type names after `::` are never columns. Column
matching is by identifier token, which is the word-boundary matching the brief asks for and the
discipline the old `formatConstrained` regex already applied.

Why this depth and not less: splitting conjuncts correctly requires tracking parenthesis depth,
which is the tokenizer's core primitive, and extracting literals correctly requires handling
escaped quotes and multi-word casts; a regex split reimplements both without structure or a place
to test them. Why not more: the corpus has no `CASE WHEN`, and only the shapes above bind literals.
The prototype parses all 2,107 definitions on main with zero failures.

### What "column-bound" means

For column `C` of a table, over the *set* of its CHECK definitions:

- Split every definition at its top-level `AND`s into conjuncts. A conjunct is **single-column**
  when `C` is the only column it references.
- **Allowed set**: literals from positive atoms bound to `C` in single-column conjuncts, in the
  order the constraint lists them (the authored order, which puts the initial state first far more
  often than not). If more than one single-column conjunct enumerates `C` (none does on main), the
  allowed set is their intersection.
- **Triggers**: every literal bound to `C` by a positive or negative atom inside a multi-column
  conjunct. Choosing a trigger engages a side condition on another column that the generic walker
  does not coordinate. `event_type <> 'release' OR release_method IS NOT NULL` makes `'release'` a
  trigger; `event_type <> ALL (ARRAY['status_changed', ...]) OR to_status IS NOT NULL` makes all
  five a trigger; the positive `event_type = ANY (ARRAY['FUNDING_RESOLVED', ...])` inside the
  pharmacy generation CHECK makes both a trigger.
- **Tier 1**: the first allowed value that is not a trigger.
- **Tier 2**: the first allowed value, when every allowed value is a trigger. The constraint itself
  forces a branch; the row's companion columns must then be pinned, exactly as today.
- Otherwise **null**, and `semanticValue` answers as it does today: hash columns get a valid
  64-hex digest, `status`-like names get `'active'`, identifiers get tagged strings.

A regex or LIKE atom on `C` contributes nothing; it describes format, not value. The old
"skip the whole definition" rule is unnecessary because literals from other atoms are never
attributed to `C`.

**No third tier.** The prototype also tried a tier that harvested positive literals bound to `C`
from inside multi-column conjuncts (branch selectors). Two measurements retired it. A fresh-database
seed with tiers 1 and 2 only and one with all three tiers were indistinguishable: 654 tables newly
seeded, zero rejected, zero unexpectedly empty, in both. And all six columns whose answer depended
on the tie-break rule were in that tier (`pharmacy_orders.status` as `'DISPATCHED'` or `'ON_HOLD'`,
for instance). A branch literal chosen for one column while the walker seeds its siblings
independently is the reported defect one level down; with no observed benefit it does not ship.
Reopen only if a fresh-database seed rejects a row that a branch literal would have passed.

### Order independence by construction

The policy is a function of the set of definitions. Single-column enumerations do not interact on
this schema, and where a tie-break is needed the module sorts definitions by their own text, never
by the caller's order and never by constraint name (renaming a constraint must not change a seed
value). Measured on main: zero columns change answer between forward and reversed input.

### Retired and kept override pins

Retired, because their comments cite `checkedValue` and the function now derives the same value
from the definitions alone, in every order:

- `body_custody_events.event_type: 'receive'`
- `facility_asset_events.event_type: 'created'`
- `pharmacy_funding_decision_events.event_type: 'LINE_MATERIALIZED'`

Kept: `pharmacy_funding_decision_events.authority_generation: null` and
`supersedes_event_id: null` (the walker fills non-text columns; nothing to do with `checkedValue`),
`stemi_activations.activation_source`, and every other pin whose comment gives a different reason.
The kept pharmacy pins get a comment saying why they remain.

## Tests

`apps/backend/src/tests/unit/comprehensiveSeedCheckedValue.test.js` (ESM, runs under `npm test`,
imports the module directly):

- **Both orders, asserted directly.** Synthetic tables with an allowed-values CHECK plus one or
  more conditional CHECKs are evaluated in forward, reversed and several seeded-shuffle orders; the
  answer must be identical. The three real definition sets from main are included verbatim and
  must yield `'receive'`, `'created'` and `'LINE_MATERIALIZED'` in every order.
- **Column binding.** `kind IN ('a','b') AND status IN ('x','y')` asked for `status` gives `'x'`;
  a table whose only mention of `status` is inside `order_status` gives nothing for `status`.
- **Shapes.** `= ANY`, single equality, `<>`, `<> ALL`, a `NOT VALID` suffix, regex atoms giving
  nothing, function-wrapped columns, casts, an `OR` of equalities in a single-column conjunct, a
  multi-column-only column giving nothing (no third tier), and a trigger that heads the
  enumeration (added after the first mutation pass showed that in all three real sets the safe
  value happened to be listed first, so dropping the exclusion changed no value).
- **Mutation results** (each reverted afterwards, tree clean): treating every conjunct as
  single-column, which is the first-literal reversion, fails 5 of 21; dropping the trigger
  exclusion fails 2 of 21 including a value flip; using the caller's order instead of the
  definition text fails 1 of 21, the intersection case, which is the only place order can matter
  in tiers 1 and 2 by construction.
- `comprehensiveSeedCoreRefs.test.js` used to pin `facility_asset_events: { event_type: 'created' }`
  in the seeder source; it now asserts the replacement contract instead (delegation to the module,
  no `event_type` pin for the three tables).

## Verification (measured)

All seed runs used a fresh schema-only database built the way CI does it: empty database,
`CREATE EXTENSION vector` (CI's Postgres image pre-creates pgvector; `000_baseline.sql` needs it),
`ci-setup-db.mjs` through the full migration corpus, then its lookup seeds. The `vh_pr970`
scratch template already carries a full seed, so a seed run against it reports
`newlySeededTables: 0` and proves nothing.

| check | result |
|---|---|
| unmodified main on the fresh base | 654 tables newly seeded, 0 failed, 0 unexpectedly empty, 904/973 non-empty |
| this change with the pins retired | 654 / 0 / 0 / 904, rc 0 |
| every CHECK evaluated against the seeded rows (`WHERE (expr) IS FALSE`) | 2,107 evaluated, 0 errors, 0 violations, `NOT VALID` included |
| NOT NULL columns that fell through to `semanticValue` | 122 listed with the seeded value and each referencing CHECK: 0 violations; 70 have a row, 52 sit on tables with no row on this base |
| row-level snapshot delta, main → this change (first row of every table) | 37 (table, column) pairs: 13 real changes, 24 values that differ on every run by construction (bcrypt salts, random UUIDs, digests of random content, generated numbers) |
| whole-schema proof with the shipped module | 2,107 parsed, 0 order flips, 917 columns answered (tier 1: 827, tier 2: 90) |
| backend unit suites reading the seeder | 9 suites, 72 tests, CI mode |
| full backend `npm run lint` | rc 0 |

The 13 real changes are each either the column's own enumeration value (`blood_units.blood_group`
`A-` → `A+`, three `realm` columns `admin` → `staff`, `nhcx_messages.direction`,
`icu_line_tube_drain_events.presence_kind`, the two provider columns) or a `semanticValue` default
replacing a literal that belonged to a neighbouring column (`salary_revisions.reason` was
`'pending_hr'`, a status; `nhcx_messages.endpoint` was `'outbound'`, a direction;
`abdm_webhook_events.external_event_id` was `'live_authenticated_callback'`).

Why the scope shrank from the first measurement: 968 columns read a multi-column literal, but only
NOT NULL columns reach `checkedValue` on the generic path, and 148 tables are hand-seeded and never
consult it. Offline the NOT NULL delta was 170 changed plus 113 fallen through; at row level, on the
tables the generic walker actually seeds, it is the 13 above.

Canonical CI runs with `[full-ci]`. A test elsewhere that asserts on a value the seeder used to
produce is expected fallout of the function working and is reported, not accommodated by bending
the function.

## Revisit triggers

- A CHECK shape that binds a literal to a column in a way the classifier treats as opaque: extend
  the matcher, never the override table.
- A newly rejected row after this change is a seeding gap for that table: fix the seed, never the
  constraint, and never by widening the harvest.
