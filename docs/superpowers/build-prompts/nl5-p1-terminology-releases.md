# BUILD: NL-5 P1 — Terminology release versioning, tenant settings, search posture
n> **STATUS: LAUNCHED 2026-07-07** (migration block assigned; see playbook §5). Kept for the record and for relaunch-on-failure.

You are implementing **NL-5 Phase 1** for the VH Health Platform. The approved design is on `github/main`: `docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md` — read it in full first; your scope is **§1 (Terminology Spine) + §Phased Plan P1** exactly. Backend CLAUDE.md at `apps/backend/CLAUDE.md` governs conventions.

## Start gate (run before anything)
```
git fetch github
git grep -q "NL-5 Terminology Spine + Content Studio Design" github/main -- docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md
```
Exit 0 → proceed. Exit 1 → STOP and report; do not improvise.

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl5-p1"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl5-p1-terminology-releases github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install
```
All work happens inside `$WT`. Push with `git push github feat/nl5-p1-terminology-releases`; open the PR against `main` on `Bahuleyandr/VH-Health-Platform` with `gh`. Backend tests need the dev Postgres on `:5433` — if it isn't running, start it per `apps/backend/CLAUDE.md` (`pg_ctl -D "D:/Dev/Tools/pgdata-vhhealth" -o "-p 5433" start`).

## Environment & isolation (MANDATORY)
- NEVER work in, commit in, or switch branches of `D:\Dev\Projects\VH Health\VH-Health-Platform` itself (shared checkout — contamination incident history). Your worktree is your world.
- Backend gate: `node apps/backend/scripts/run-ci-jest.mjs` (chunked, needs local Postgres). Route changes ⇒ `npm run openapi:generate && npm run openapi:check` in `apps/backend`, commit `src/docs/openapi.json`.
- Migrations: bare DDL in `apps/backend/src/migrations/NNN_*.sql`; after applying locally, `npx prisma db pull` and commit `schema.prisma` together with the `.sql`.
- **Your reserved migration numbers: 369 and 370** (coordinator-assigned). 368 belongs to the in-flight SAML build; 371–377 belong to parallel Wave B workers. Do NOT ls-and-take.

## Scope (deliver all)
1. **Importer upgrades** (`apps/backend/scripts/terminology-import.mjs`):
   - Write one `terminology_import_batches` row per run (table exists since mig 307; importer currently never writes it): status running→completed/failed/partial + row counts + release_label.
   - Release stamping: new column `terminology_concepts.last_seen_release VARCHAR(120)` (mig **369**), stamped from `--version` on every upsert.
   - `--full` retirement sweep: after a full-release import, concepts of that system with `last_seen_release <> current` flip `status='inactive'` — **never DELETE** (bindings + `clinical_code_bindings` reference codes historically). Partial imports never sweep.
   - `--rf2-map` (SNOMED ExtendedMap refset → SNOMED→ICD-10) + generic map CSV (`from_system,from_code,to_system,to_code,relationship`) landing in `terminology_concept_maps` via existing `upsertConceptMap`.
2. **`tenant_terminology_settings`** (mig **370**): tenant_id PK, `preferred_diagnosis_system` default `ICD11`, `enabled_systems TEXT[]` default all five, `snomed_pickers_enabled BOOLEAN default false`. Pattern-A RLS **exactly like migration 351**. New `terminologySettingsService` cloning `compositionFeatureService.js` (per-tenant-keyed 60s cache — never a global refresh; fail-closed to current defaults) + a settings endpoint on the existing terminology routes. Default row semantics must reproduce today's behavior exactly (inert).
3. **ICD-11 local-first flip**: `searchConcepts` goes local-first for ICD11 when `terminology_code_systems.concept_count` exceeds a threshold (real import happened); the 10-row starter set stays WHO-first. `getConcept` cache-miss behavior unchanged. Data-driven — no new flag.
4. **`coverageReport` extension**: add concept-map coverage per system pair (counts by relationship).
5. **Runbook** `apps/backend/docs/RUNBOOKS/terminology-releases.md`: NRCeS/LOINC/WHO-ICD/ATC acquisition steps (spec §1.1), import commands, rollback drill (re-import prior release with `--full`), binding-suggest operator step for the mig-102 investigation catalog.

## Invariants (verified at review — violations block merge)
- Terminology content tables stay **global: no tenant_id, no RLS** (mig 275/307 stance). Only `tenant_terminology_settings` is tenant-scoped.
- **No licensed content committed** — synthetic fixtures only (importer header rule).
- Everything inert by default; settings reads fail closed.
- Raw-SQL params: spread args, `::type` casts inside jsonb builders (`npm run lint:raw-params`).

## Tests (deep-test tier per spec P1)
Synthetic RF2/LOINC/CSV fixtures through the importer (dry-run + real against QA DB) asserting batch rows, version stamps, retirement flips; `validateCode` inactive-code degradation for a retired code referenced by an existing binding; **EXPLAIN-asserted trigram index plan** on a >100k-row synthetic corpus (regression tripwire); tenant-settings fail-closed + per-tenant cache isolation (composition-service test shape); ICD-11 ordering both sides of the threshold (extend `terminology.deep.test.js`).

## Deliverable
Branch `feat/nl5-p1-terminology-releases`, PR titled `NL-5 P1: terminology release versioning + tenant settings`. PR body = build ledger: scope delivered, invariants held, migrations used (369/370), exact test commands + pass counts, anything deferred. ALL checks green (`gh pr checks` exits 1 spuriously — re-query, don't trust `--watch`). **STOP after the PR** — the coordinator content-verifies and merges.
