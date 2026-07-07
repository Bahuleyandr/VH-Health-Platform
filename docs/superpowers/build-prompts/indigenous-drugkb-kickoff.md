# DESIGN: Indigenous drug-KB content program — kickoff (spec before ANY content authoring)

Docs-only design session. Deliverable: ONE grounded spec at
`docs/superpowers/specs/<today>-indigenous-drugkb-program-design.md` as a docs-only PR. NO code,
NO drug content. This spec is the mandatory gate before any interaction/dose/caution row is
authored (roadmap §7 owner override, 2026-07-07: indigenous evidence-gated program replaces
vendor licensing; the override paragraph in `docs/NEXT_LEVEL_ROADMAP.md` §7 is binding context).

## Method (Wave B discipline — survey first, cite path:line)
Ground before writing: the `drug_kb_*` schema (mig 277: monographs w/ Indian brand aliases,
interactions, allergy groups + cross-reactivity, condition cautions keyed icd10_prefix, dose
ranges incl. mg/kg + eGFR, IV compatibility) · `drugKnowledgeBaseService` engine (five check
families, severity taxonomy, is_active union, 5-min TTL) · `prescriptionSafetyCheck` check-8 +
the eight deterministic floor checks (fail-closed) · the ~90-row `vh_starter_set` and its
license_note · `drug-kb-import.mjs` neutral-CSV importer (seven datasets) · the acceptance
harness + `drug_kb_sources.priority` dedup (NL-5 P2, if merged) · the aushadhi
brand→composition dataset + its importer (PR #451) · the terminology spine's ATC axis ·
the content-studio lifecycle pattern (NL-5 P3) as the governance precedent.

## The spec must answer
1. **Content sourcing strategy per dataset**: which open/government sources feed each of the
   seven datasets (e.g., NFI, CDSCO alerts/schedules, WHO ATC/DDD, state formularies, published
   monographs) vs original clinical authoring — with licensing status verified per source
   (open ≠ redistributable; cite terms). NO model-knowledge drug facts — sources only.
2. **Editorial workflow**: author → clinical-pharmacology review → approve → versioned edition
   release; named reviewer roles (reuse ORDER_SET_APPROVER two-person pattern or define
   PHARMACOLOGY_REVIEWER); every row carries provenance (source citation) — schema seam for a
   `provenance` column/JSONB on each drug_kb_* table if absent.
3. **Edition/release model**: `drug_kb_sources` rows as versioned editions (source_key
   `vh_indigenous`, version labels, acceptance snapshot recorded before activation, starter-set
   deactivation criteria, rollback = prior edition re-activation).
4. **Coverage roadmap**: which drug families first (map to the hospital's actual formulary +
   aushadhi top-prescribed), coverage metrics (drugs covered / interactions per drug / dose
   ranges per population), and the go-live gate restated: current edition passes the acceptance
   battery + named-clinician sign-off + documented coverage ≥ target for the pilot formulary.
5. **Tooling gaps**: authoring surface (CSV-first vs a studio UI later), diff/review tooling for
   edition updates, CI protections (no content in repo? or reviewable in-repo since it is
   self-authored — DECIDE with licensing analysis; self-authored content CAN live in-repo,
   unlike vendor/terminology content).
6. **Owner Decisions section**: reviewer appointments, first-formulary scope, in-repo vs
   operator-supplied content storage, edition cadence.

## Isolation
Fresh worktree off `github/main` per `_worker-common.md`, branch
`docs/indigenous-drugkb-design`, single-file PR, STOP after the PR (coordinator verifies).

## Kickoff line
> You are a design worker for the VH Health Platform. Read
> `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\indigenous-drugkb-kickoff.md`
> and `_worker-common.md` beside it; produce the indigenous drug-KB program design spec exactly
> as instructed (survey-grounded, docs-only, single-file PR, no drug content, stop after PR).
