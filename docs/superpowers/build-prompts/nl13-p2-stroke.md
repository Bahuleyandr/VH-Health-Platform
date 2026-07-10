# BUILD: NL-13 P2 — Neuro & stroke pathway: activations, NIHSS, thrombolysis decisions, pathway events

You are implementing **NL-13 Suite 2 (Neuro And Stroke Pathway)** for the VH Health Platform. The approved design survey is on `github/main`: `docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md` — read it in full; your scope is **`## Suite 2 - Neuro And Stroke Pathway`** exactly, plus the shared `## Non-Negotiable Boundaries`. Also read `_worker-common.md` beside this file, `docs/CANONICAL_CLINICAL_TIMELINE.md`, and `apps/backend/CLAUDE.md`. Do NOT re-design or add scope beyond the suite text.

**Parallel-safety:** backend tables/services/routes + staff/admin UI; sibling Wave E workers overlap only in `apps/backend/prisma/schema.prisma` and `apps/backend/src/docs/openapi.json` (regenerate, never hand-merge) = parallel-safe. No build-order dependency on P3/P4.

## Start gate (run before anything)
```
git fetch github
git grep -q "NL-13 Quaternary Specialty Suites Design Survey" github/main -- docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md
```
Exit 0 → proceed. Exit 1 → STOP and report.

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl13-p2"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl13-p2-stroke github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install && npm --prefix apps/admin install
dart pub get   # Flutter workspace (staff-app stroke pathway surface)
```
All work happens inside `$WT`. Push with `git push github feat/nl13-p2-stroke`; open the PR against `main` on `Bahuleyandr/VH-Health-Platform` with `gh`. Backend tests need the dev Postgres on `:5433` — start it per `apps/backend/CLAUDE.md` if down.

## Environment & isolation (MANDATORY)
- NEVER work in, commit in, or switch branches of `D:\Dev\Projects\VH Health\VH-Health-Platform` itself (shared-checkout contamination history, PR #427). Your worktree is your world.
- Backend gate: `node apps/backend/scripts/run-ci-jest.mjs`. Route changes ⇒ `npm run openapi:generate && npm run openapi:check` in `apps/backend`, commit `src/docs/openapi.json`. Admin ⇒ `npm run lint && npm run type-check` inside `apps/admin` (NOT raw `npx tsc`). Flutter ⇒ `melos run analyze && melos run test`; EVERY user-facing string in ALL five `intl_*.arb` files (i18n guard fails CI otherwise).
- Migrations: bare DDL at `apps/backend/src/migrations/NNN_*.sql`. Regenerate `schema.prisma` ONLY from a disposable scratch DB built from YOUR OWN worktree's migrations (worker-common Schema-regeneration LAW — never the shared QA/dev DB). Commit `prisma/schema.prisma` WITH the `.sql`; then `node apps/backend/scripts/check-phi-tenant-id.mjs` and `node apps/backend/scripts/check-schema-drift.mjs`.
- **Your reserved migration numbers: 503–507** (use in order; leave unused ones untaken). Sibling Wave E blocks — P3 oncology 489–494, P4 nuclear-med 508–512, P6 transplant 546–554. Do NOT poach numbers outside 503–507.
- Deploy stays HELD: ship inert behind a per-tenant flag (mig-351 `composition_search_settings` + `compositionFeatureService` per-tenant-cache, fail-closed pattern); any k8s manifests land unreferenced by the root kustomization.

## Scope (deliver all — spec Suite 2 Scope Sketch)
All new tables are PHI: every one carries the **mig-356 RLS boilerplate** — `tenant_id UUID NOT NULL` with the GUC-aware default, `ENABLE` + `FORCE ROW LEVEL SECURITY`, the `tenant_isolation` policy, FK to `tenants`. Service writes go through `setTenant`/`setTenantTx` with an EXPLICIT `tenant_id` on every insert (the GUC default silently stamps the literal default tenant otherwise).

1. **`stroke_activations`** (mig **503**) — patient, encounter, activation source, last-known-well, arrival/door time, team, status, canonical timeline event reference. First-class code-stroke entity that today exists only as AI/radiology signals (spec Gaps; `apps/backend/src/services/ai/pathwayBundleComplianceService.js:55-69`, `apps/backend/src/tests/unit/radiologyWorklistPrioritizerService.test.js:38-117`).
2. **`stroke_nihss_assessments`** (mig **504**) — structured items, total score, assessor, **source/version owner field**, audit. NIHSS form/source/version is OWNER-SOURCED: ship `nihss_source` + `nihss_version` + attachment slots as evidence-owner metadata that stay **INERT until the operator supplies them**; never encode NIHSS item definitions/labels/scoring from model memory. The stored total is the pure ARITHMETIC sum of operator-supplied item scores only. Clinical sign-off **FAILS CLOSED** when source/version metadata is absent.
3. **`stroke_thrombolysis_decisions`** (mig **505**) — eligibility, contraindications/exclusions, dose/decision fields, **approver privilege gate**, patient/family documentation slot. The institutional thrombolysis protocol is OWNER-SOURCED: eligibility/contraindication checklists and dosing are operator-supplied metadata + attachment slots, INERT and FAIL CLOSED until supplied — do NOT encode inclusion/exclusion criteria or doses from model memory. Approver gate uses the N6-5 credentialing pattern (`hasActivePrivilege`/`enforcePrivilegeGate`, `apps/backend/src/services/staff/credentialingService.js:685-725`) keyed on an owner-confirmed privilege from mig 507.
4. **`stroke_pathway_events`** (mig **506**) — CT order, CT start/result, neurology review, decision, treatment start, transfer/disposition. Emit door-to-CT and door-to-needle **`workflow_sla_instances`** SLA evidence (`apps/backend/src/migrations/269_canonical_clinical_platform.sql:151-185`). Pathway-event query indexes land in this migration.
5. **Privilege/catalog seeds** (mig **507**) — stroke privilege key(s) seeded into the catalog (`apps/backend/src/migrations/380_privilege_catalog_seed_and_approval_indexes.sql:5-15`) ONLY if owner-confirmed; otherwise wire the gate but leave it unseeded (fails closed).
6. **Radiology reuse — NO new prioritization logic.** Reuse the existing `code_stroke` / `STROKE_PROTOCOL` context markers for the radiology handoff state (`apps/backend/src/services/ai/radiologyWorklistPrioritizerService.js:165-326`); do NOT duplicate or fork prioritization. Imaging viewers and device/vital streams stay integrate-only through PACS and NL-7 (`docs/RADIOLOGY_PACS.md:14-35`, `apps/backend/src/migrations/371_device_registry.sql:27-40`). NEWS2/code-blue substrates are reused, not rebuilt (`apps/backend/src/migrations/009_future_proof_clinical_ai.sql:192-229`, `apps/backend/src/utils/clinical/vitalSignMonitor.js:434-503`).
7. **Canonical timeline invariant.** Every patient-facing stroke write (activation, NIHSS, thrombolysis decision, pathway event) = detail row + `clinical_timeline_events` + `clinical_audit_events` in ONE transaction (`docs/CANONICAL_CLINICAL_TIMELINE.md:85-88`). Follow the theatre service pattern.
8. **Staff/admin UI.** Stroke pathway surface (activation → NIHSS entry → thrombolysis decision → pathway timers) with loading/empty/error states; admin Tier D emergency panel already advertises stroke-fast/thrombolysis-window support (`apps/admin/src/app/(with-auth)/dashboard/clinical-ai/components/coreModulePanels/TierDEmergencyPanel.tsx:85`). All strings through the 5-language i18n sweep.

## Tests (spec Suite 2 Test Strategy)
- Unit: NIHSS total = arithmetic sum of operator item scores; clock/timestamp validation; eligibility/contraindication capture; status transitions; privilege enforcement.
- Deep: activation → radiology prioritization → CT status → NIHSS → thrombolysis decision → timeline/audit/SLA evidence.
- Regression: existing code-stroke radiology prioritization **remains stat-tiered** (`apps/backend/src/tests/unit/radiologyWorklistPrioritizerService.test.js:94-117`).
- Emergency-panel tests where staff/admin UI renders `stroke_fast_check_assistant` (`apps/admin/src/app/(with-auth)/dashboard/clinical-ai/components/coreModulePanels/TierDEmergencyPanel.tsx:85`).
- Fail-closed assertion: sign-off is blocked when NIHSS or thrombolysis source/version metadata is absent.

## Deliverable
Branch `feat/nl13-p2-stroke`, PR titled `NL-13 P2: neuro & stroke pathway (activations, NIHSS, thrombolysis, pathway events)`. PR body = build ledger (scope delivered · invariants held · migration numbers used · exact test commands + pass counts · anything deferred and why). ALL checks green (re-query `gh pr checks`; `--watch` lies). **STOP after opening the PR** — the coordinator content-verifies and merges. One scope = one PR: do not merge, do not force-push after the PR opens, do not open a second PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `docs/superpowers/build-prompts/nl13-p2-stroke.md` and `_worker-common.md` beside it, plus the spec `docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md`; execute EXACTLY. Your migration block: 503–507. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens, do not open a second PR for the same scope. Report back with the PR number and your build ledger.
