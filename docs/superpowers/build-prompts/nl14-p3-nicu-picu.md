# BUILD: NL-14 P3 — NICU/PICU feeds, fluids, neonatal scoring, pediatric references

You are implementing **NL-14 Phase 3 (NICU/PICU depth)** for the VH Health Platform. The approved design is on `github/main`: `docs/superpowers/specs/2026-07-08-nl14-critical-care-emergency-design.md` — read it in full; your scope is **§4.5 exactly**, bounded by **§3 (governance boundaries), §5 (slice order), and §7 (explicit boundaries)**. Also read `docs/CANONICAL_CLINICAL_TIMELINE.md`, `_worker-common.md` beside this file, and `apps/backend/CLAUDE.md`.

**Parallel-safety:** NOT parallel-safe with NL-14 P1. This slice EXTENDS the P1 ICU charting substrate with PICU/NICU views — it is not a separate silo and depends on P1's chart data model (spec §4.5, §5.5). **Sequence AFTER NL-14 P1 has landed on `github/main` and verified.** Independent of NL-14 P2; disjoint from the NL-13 slices once P1 is in.

**Critical constraints (hold these or the PR is rejected):**
- **Extend ICU charting, do not fork it.** PICU/NICU are additional views over the P1 ICU chart substrate, not a parallel silo (spec §4.5).
- **Neonatal/pediatric SCORE FORMULAS need owner approval before build** — do NOT hardcode formulas in UI or service. Ship scores as decision-support output rows with version/reference/reviewer slots that stay INERT until the owner approves (spec §3, §4.5, §6.5). Unsupplied/unapproved scores FAIL CLOSED ("score unavailable"), never fallback math.
- **Consume NL-5 pediatric content packs** — IAP growth + UIP/IAP immunization packs (already on main) are consumed once signed; keep any local fallbacks explicitly LABELLED as such (`docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md:28`, `:606`, `:636`).

## Start gate (run before anything)
```
git fetch github
git grep -q "NL-14 critical-care and emergency depth design" github/main -- docs/superpowers/specs/2026-07-08-nl14-critical-care-emergency-design.md
# PREREQUISITE gate — NL14-P1 ICU flowsheet (block 495–502) must be MERGED to main
# (NICU/PICU views EXTEND its ICU chart substrate, not a separate silo):
git ls-tree --name-only github/main:apps/backend/src/migrations | grep -qE "^(49[5-9]|50[0-2])_"
```
Exit 0 → proceed. Exit 1 → STOP and report.

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl14-p3-nicu"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl14-p3-nicu-picu github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install && npm --prefix apps/admin install
dart pub get   # Flutter workspace (staff-app NICU/PICU chart widgets)
```
All work happens inside `$WT`. Branch off `github/main` only AFTER NL-14 P1 is merged there (this slice extends P1's ICU chart substrate). Push with `git push github feat/nl14-p3-nicu-picu`; open the PR against `main` on `Bahuleyandr/VH-Health-Platform` with `gh`. Backend tests need the dev Postgres on `:5433` — start it per `apps/backend/CLAUDE.md` if down. Admin type-check is `npm run type-check` inside `apps/admin` (NOT raw `npx tsc`).

## Environment & isolation (MANDATORY)
- NEVER work in, commit in, or switch branches of `D:\Dev\Projects\VH Health\VH-Health-Platform` itself (shared-checkout contamination history — PR #427). Your worktree is your world.
- Backend gate: `node apps/backend/scripts/run-ci-jest.mjs`. Route changes ⇒ `npm run openapi:generate` + `npm run openapi:check` in `apps/backend`, commit `src/docs/openapi.json`. Staff-app changes ⇒ `melos run analyze && melos run test`; ALL user-facing strings through the five `intl_*.arb` files (i18n guard).
- Migrations: bare DDL at `apps/backend/src/migrations/NNN_*.sql`. Regenerate `schema.prisma` ONLY from a disposable scratch DB built from YOUR worktree's migrations (schema-regen LAW in `_worker-common.md`), commit `prisma/schema.prisma` with the `.sql`; then `node apps/backend/scripts/check-phi-tenant-id.mjs` and `node apps/backend/scripts/check-schema-drift.mjs`.
- **Your reserved migration numbers: 529–535** (use in order, leave unused ones untaken). Numbers only from playbook §5. Map (spec §4.5 estimate, 7 tables): NICU/PICU feed-fluid chart, neonatal respiratory support, neonatal/pediatric score outputs, jaundice/phototherapy events, incubator/warmer observations, device links, specialty UI preferences.
- Deploy stays HELD: ship inert behind per-tenant flags (mig-351 `composition_search_settings` + `compositionFeatureService` fail-closed pattern); any new k8s/monitoring manifests land unreferenced by the root kustomization.

## Scope (deliver all — spec §4.5)
1. **PICU/NICU views over ICU charting** — extend the P1 ICU chart substrate (not a separate silo) with: weight-adjusted fluid balance, feeds (breast milk / formula / fortifier / TPN), urine/stool/emesis, glucose, bilirubin, phototherapy, oxygen/CPAP/ventilator mode, incubator/warmer temperature, and apnea/brady/desaturation events. ICU admissions already allow `PICU`/`NICU` unit codes (`apps/backend/src/migrations/165_icu_flowsheet.sql:32`).
2. **Neonatal + pediatric score outputs (decision-support only)** — add score output rows as decision support with references and human review. Candidate scores NEED owner approval before build; do NOT hardcode formulas in UI or service — rows carry version/reference/reviewer and stay INERT until approved (spec §3, §6.5).
3. **Maternity/newborn reuse** — link NICU admission to the existing newborn substrate: newborn record, resuscitation type, breastfeeding initiation, APGAR, newborn patient link, postnatal feeding/jaundice fields, newborn immunizations (`apps/backend/src/migrations/155_maternity_workflow.sql:240`, `:254`, `:261`, `:283`, `apps/backend/src/migrations/160_newborn_immunisations.sql:91`); patient immunizations cover walk-ins/transfers outside maternity (`apps/backend/src/migrations/179_paediatric_immunisations.sql:14`). Existing APGAR is birth-context only, not NICU acuity scoring — model NICU scores separately.
4. **NL-5 content-pack consumption** — consume NL-5 IAP growth and UIP/IAP immunization packs once signed; keep any local fallbacks LABELLED as such (`docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md:28`, `:606`, `:636`).
5. **Staff-app NICU/PICU chart UI** — dense neonatal rows, unverified-device badges, feed/fluid balance, score-output display with version/reference/reviewer. Multi-surface: every user-facing string through ALL five `intl_*.arb` files (i18n guard fails CI otherwise).

**Cross-cutting (every new table + every write):**
- **RLS boilerplate on every table:** mig-356 pattern exactly — `tenant_id UUID NOT NULL` with the GUC-aware default, `ENABLE` + `FORCE ROW LEVEL SECURITY`, `tenant_isolation` policy, FK to tenants. Service writes via `setTenantTx` with EXPLICIT `tenant_id` on inserts.
- **Canonical timeline:** NICU charting is patient-facing — every clinical write = detail row + `clinical_timeline_events` + `clinical_audit_events` in ONE transaction (`docs/CANONICAL_CLINICAL_TIMELINE.md`). Physiologic snapshots persist through NL-7; device rows land `unverified` until review.
- **Device consumption stays NL-7 / N6-6:** NICU device fleet (monitors, ventilators/CPAP, incubators/warmers, infusion/syringe pumps) is an owner decision (spec §6.4) and its transport/credentials are NL-7's; NL-14 only consumes observations. Any denominator device presence flows through the P1 N6-6 adapter, not a new HAI path.
- **Owner-decision items fail closed:** neonatal/pediatric score formulas and NICU device-fleet assumptions are clinical-governance-owned (spec §6.4, §6.5) — build as evidence-owner fields + version/source metadata + reviewer-signoff slots that stay INERT until the operator supplies approved content; unsupplied content FAILS CLOSED, never fallback math.

## Tests (spec §4.5)
Feed/fluid balance fixtures by weight; APGAR/newborn link to NICU admission; device vitals unverified badges in NICU; score outputs carry version/reference/reviewer; growth/immunization content-pack lookup; tenant isolation; staff widget tests for dense neonatal rows. Run the backend gate `node apps/backend/scripts/run-ci-jest.mjs` and, for the Flutter surface, `melos run analyze && melos run test`.

## Deliverable
Branch `feat/nl14-p3-nicu-picu`, PR titled `NL-14 P3: NICU/PICU feeds, fluids, neonatal scoring, pediatric references`. PR body = build ledger (scope delivered, invariants held, migration numbers used, exact test commands + pass counts, deferred items). ALL checks green (re-query `gh pr checks`; `--watch` lies). **STOP after the PR** — coordinator content-verifies and merges.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `docs/superpowers/build-prompts/nl14-p3-nicu-picu.md` and `_worker-common.md` beside it, plus the spec `docs/superpowers/specs/2026-07-08-nl14-critical-care-emergency-design.md`; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: 529–535. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens, do not open a second PR for the same scope. Report back with the PR number and your build ledger.
