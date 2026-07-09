# BUILD: NL-13 P3 — Oncology completion: TNM/AJCC staging, CTCAE toxicity, tumor board

You are implementing **NL-13 Suite 4 (Oncology Completion)** for the VH Health Platform. The approved design survey is on `github/main`: `docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md` — read it in full; your scope is **`## Suite 4 - Oncology Completion`** exactly, plus the shared `## Non-Negotiable Boundaries`. Also read `_worker-common.md` beside this file, `docs/CANONICAL_CLINICAL_TIMELINE.md`, and `apps/backend/CLAUDE.md`. Do NOT re-design or add scope beyond the suite text.

**This is oncology COMPLETION, not first-dose chemo.** Chemo protocols/plans/cycles/administrations/cumulative-dose and infusion-chair booking already exist (`apps/backend/src/migrations/290_oncology_foundations.sql:20-184`, `apps/backend/src/services/oncology/chemoService.js:1-17`, `apps/backend/src/migrations/411_infusion_chairs.sql:8-60`, `apps/backend/src/migrations/412_chair_bookings.sql:12-83`) — do NOT rebuild them. The missing layer is TNM/AJCC staging, CTCAE toxicity, tumor board, registry, and terminology governance (spec Gaps). This slice **feeds from AP malignancy flags** (`apps/backend/src/services/pathology/pathologyService.js:128`, `apps/backend/src/services/pathology/pathologyService.js:668-742`).

**Parallel-safety:** backend tables/services/routes + staff/admin UI; sibling Wave E workers overlap only in `apps/backend/prisma/schema.prisma` and `apps/backend/src/docs/openapi.json` (regenerate, never hand-merge) = parallel-safe. No build-order dependency on P2. NOTE: P4 nuclear-med sequences AFTER this slice (its radiotherapy referrals reference the `oncology_diagnoses`/`oncology_staging_records` you create here).

## Start gate (run before anything)
```
git fetch github
git grep -q "NL-13 Quaternary Specialty Suites Design Survey" github/main -- docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md
```
Exit 0 → proceed. Exit 1 → STOP and report.

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl13-p3"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl13-p3-oncology-staging github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install && npm --prefix apps/admin install
dart pub get   # Flutter workspace (staff-app tumor-board / toxicity surfaces)
```
All work happens inside `$WT`. Push with `git push github feat/nl13-p3-oncology-staging`; open the PR against `main` on `Bahuleyandr/VH-Health-Platform` with `gh`. Backend tests need the dev Postgres on `:5433` — start it per `apps/backend/CLAUDE.md` if down.

## Environment & isolation (MANDATORY)
- NEVER work in, commit in, or switch branches of `D:\Dev\Projects\VH Health\VH-Health-Platform` itself (shared-checkout contamination history, PR #427). Your worktree is your world.
- Backend gate: `node apps/backend/scripts/run-ci-jest.mjs`. Route changes ⇒ `npm run openapi:generate && npm run openapi:check` in `apps/backend`, commit `src/docs/openapi.json`. Admin ⇒ `npm run lint && npm run type-check` inside `apps/admin` (NOT raw `npx tsc`). Flutter ⇒ `melos run analyze && melos run test`; EVERY user-facing string in ALL five `intl_*.arb` files (i18n guard fails CI otherwise).
- Migrations: bare DDL at `apps/backend/src/migrations/NNN_*.sql`. Regenerate `schema.prisma` ONLY from a disposable scratch DB built from YOUR OWN worktree's migrations (worker-common Schema-regeneration LAW — never the shared QA/dev DB). Commit `prisma/schema.prisma` WITH the `.sql`; then `node apps/backend/scripts/check-phi-tenant-id.mjs` and `node apps/backend/scripts/check-schema-drift.mjs`.
- **Your reserved migration numbers: 489–494** (use in order; leave unused ones untaken; group the seven tables per the spec's "four to six migrations" estimate). Sibling Wave E blocks — P2 stroke 503–507, P4 nuclear-med 508–512, P6 transplant `<gated>`. Do NOT poach numbers outside 489–494.
- Deploy stays HELD: ship inert behind a per-tenant flag (mig-351 `composition_search_settings` + `compositionFeatureService` per-tenant-cache, fail-closed pattern); any k8s manifests land unreferenced by the root kustomization.

## Scope (deliver all — spec Suite 4 Scope Sketch)
All new tables are PHI: every one carries the **mig-356 RLS boilerplate** — `tenant_id UUID NOT NULL` with the GUC-aware default, `ENABLE` + `FORCE ROW LEVEL SECURITY`, the `tenant_isolation` policy, FK to `tenants`. Service writes go through `setTenant`/`setTenantTx` with an EXPLICIT `tenant_id` on every insert.

1. **`oncology_diagnoses`** — patient, encounter, cancer site, pathology report link, diagnosis date, malignancy flag source. AP-to-oncology referral: feed from the pathology malignancy flags / synoptic fields (`apps/backend/src/services/pathology/pathologyService.js:128`, `apps/backend/src/services/pathology/pathologyService.js:668-742`).
2. **`oncology_staging_records`** — TNM fields, AJCC edition/source/version, clinical/pathologic stage, assessor, verification. **AJCC/TNM is OWNER-SOURCED**: ship `ajcc_edition`, `staging_source`, `staging_version` + attachment slots as evidence-owner metadata that stay **INERT until the operator supplies them**; never embed licensed AJCC/TNM staging tables or text from model memory. Field VALIDATION (well-formed T/N/M values) is allowed; the classification content is not.
3. **`oncology_toxicity_events`** — CTCAE source/version, grade, attribution, action taken, cycle/admin link (to the existing chemo cycle/administration rows). **CTCAE is OWNER-SOURCED**: `ctcae_source` + `ctcae_version` + attachment slots INERT until supplied; never embed CTCAE grading text from model memory.
4. **`tumor_board_meetings`** — service line, date, chair, attendees, **quorum reference**, status.
5. **`tumor_board_cases`** — diagnosis, staging, AP/radiology links, question, priority, discussion state.
6. **`tumor_board_recommendations`** — recommendation type, responsible owner, due date, acceptance/defer reason, timeline event.
7. **`oncology_registry_exports`** — owner-reviewed export snapshots and evidence references (register/evidence trail, NOT a patient timeline subject).
8. **Privilege/catalog seeds** — oncology privilege key(s) via the N6-5 credentialing pattern (`apps/backend/src/services/staff/credentialingService.js:685-725`, seed into `apps/backend/src/migrations/380_privilege_catalog_seed_and_approval_indexes.sql:5-15`) ONLY if owner-confirmed; otherwise wire the gate but leave it unseeded (fails closed). Reuse the existing optional chemo privilege enforcement pattern (`apps/backend/src/services/oncology/chemoService.js:945-948`).
9. **Owner-sourced governance FAILS CLOSED**: staging/toxicity clinical sign-off is BLOCKED until the required source/version metadata is present. This is the governance gate, not a warning.
10. **Canonical timeline invariant.** Every patient-facing oncology write (diagnosis, staging, toxicity, tumor-board case/recommendation) = detail row + `clinical_timeline_events` + `clinical_audit_events` in ONE transaction (`docs/CANONICAL_CLINICAL_TIMELINE.md:85-88`). `oncology_registry_exports` and the meeting record use audit/register trails, not patient timeline events.
11. **Chemo-plan linkage**: recommendations/toxicity link to the existing chemo plan/cycle rows without altering the chemo service's dosing/cumulative-limit logic (`apps/backend/src/services/oncology/chemoService.js:1-17`).
12. **Staff/admin UI.** Tumor-board queue + toxicity capture surfaces with loading/empty/error states; all strings through the 5-language i18n sweep.

## Tests (spec Suite 4 Test Strategy)
- Unit: TNM/stage field validation; CTCAE grade/source metadata; tumor-board state transitions; recommendation action due dates; chemo-cycle linkage.
- Deep: AP malignancy flag → oncology diagnosis → staging → tumor board → recommendation → chemo-plan link → canonical timeline/audit evidence.
- UI: tumor-board queue and toxicity capture.
- Content governance: staging/toxicity source/version metadata is REQUIRED before clinical sign-off (fail-closed assertion).

## Deliverable
Branch `feat/nl13-p3-oncology-staging`, PR titled `NL-13 P3: oncology completion (TNM/AJCC staging, CTCAE toxicity, tumor board)`. PR body = build ledger (scope delivered · invariants held · migration numbers used · exact test commands + pass counts · anything deferred and why). ALL checks green (re-query `gh pr checks`; `--watch` lies). **STOP after opening the PR** — the coordinator content-verifies and merges. One scope = one PR: do not merge, do not force-push after the PR opens, do not open a second PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `docs/superpowers/build-prompts/nl13-p3-oncology-staging.md` and `_worker-common.md` beside it, plus the spec `docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md`; execute EXACTLY. Your migration block: 489–494. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens, do not open a second PR for the same scope. Report back with the PR number and your build ledger.
