# BUILD: NL-13 P4 — Nuclear medicine & radiotherapy COORDINATION (integrate-only)

You are implementing **NL-13 Suite 6 (Nuclear Medicine And Radiotherapy Coordination)** for the VH Health Platform. The approved design survey is on `github/main`: `docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md` — read it in full; your scope is **`## Suite 6 - Nuclear Medicine And Radiotherapy Coordination`** exactly, plus the shared `## Non-Negotiable Boundaries`. Also read `_worker-common.md` beside this file, `docs/CANONICAL_CLINICAL_TIMELINE.md`, and `apps/backend/CLAUDE.md`. Do NOT re-design or add scope beyond the suite text.

**COORDINATION ONLY — integrate, never rebuild.** The roadmap narrows this to coordination seams; planning systems are integrated, not rebuilt (`docs/NEXT_LEVEL_ROADMAP.md:242-243`). Build coordination, orders, appointment/fraction status, documentation links, safety checklist/evidence slots, patient instructions, and canonical timeline outputs. **Integrate-only** for treatment planning systems, LINAC delivery, nuclear-medicine scanners, dose calculation, isotope inventory systems, and hardware control. Store EXTERNAL references only; NEVER calculate treatment plans or control delivery. Reuse the existing PACS/DICOM/OHIF/DICOMweb links (`docs/RADIOLOGY_PACS.md:14-35`, `docs/RADIOLOGY_PACS.md:225-263`) rather than inventing image/document plumbing.

**Parallel-safety:** backend tables/services/routes + staff/admin UI; sibling Wave E workers overlap only in `apps/backend/prisma/schema.prisma` and `apps/backend/src/docs/openapi.json` (regenerate, never hand-merge) = parallel-safe. **P4 sequences AFTER P3 oncology** — `radiation_oncology_referrals` reference P3's `oncology_diagnoses`/`oncology_staging_records` (diagnosis/staging link). Rebase on P3 once it merges; if P3 is not yet on `github/main`, coordinate the FK target with the coordinator before landing.

## Start gate (run before anything)
```
git fetch github
git grep -q "NL-13 Quaternary Specialty Suites Design Survey" github/main -- docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md
```
Exit 0 → proceed. Exit 1 → STOP and report.

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl13-p4"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl13-p4-nuclear-med github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install && npm --prefix apps/admin install
dart pub get   # Flutter workspace (staff-app referral / fraction-status surfaces)
```
All work happens inside `$WT`. Push with `git push github feat/nl13-p4-nuclear-med`; open the PR against `main` on `Bahuleyandr/VH-Health-Platform` with `gh`. Backend tests need the dev Postgres on `:5433` — start it per `apps/backend/CLAUDE.md` if down.

## Environment & isolation (MANDATORY)
- NEVER work in, commit in, or switch branches of `D:\Dev\Projects\VH Health\VH-Health-Platform` itself (shared-checkout contamination history, PR #427). Your worktree is your world.
- Backend gate: `node apps/backend/scripts/run-ci-jest.mjs`. Route changes ⇒ `npm run openapi:generate && npm run openapi:check` in `apps/backend`, commit `src/docs/openapi.json`. Admin ⇒ `npm run lint && npm run type-check` inside `apps/admin` (NOT raw `npx tsc`). Flutter ⇒ `melos run analyze && melos run test`; EVERY user-facing string in ALL five `intl_*.arb` files (i18n guard fails CI otherwise).
- Migrations: bare DDL at `apps/backend/src/migrations/NNN_*.sql`. Regenerate `schema.prisma` ONLY from a disposable scratch DB built from YOUR OWN worktree's migrations (worker-common Schema-regeneration LAW — never the shared QA/dev DB). Commit `prisma/schema.prisma` WITH the `.sql`; then `node apps/backend/scripts/check-phi-tenant-id.mjs` and `node apps/backend/scripts/check-schema-drift.mjs`.
- **Your reserved migration numbers: 508–512** (use in order; leave unused ones untaken; group the six tables per the spec's "three to five migrations" estimate). Sibling Wave E blocks — P3 oncology 489–494 (you sequence AFTER P3), P2 stroke 503–507, P6 transplant `<gated>`. Do NOT poach numbers outside 508–512.
- Deploy stays HELD: ship inert behind a per-tenant flag (mig-351 `composition_search_settings` + `compositionFeatureService` per-tenant-cache, fail-closed pattern); any k8s manifests land unreferenced by the root kustomization.

## Scope (deliver all — spec Suite 6 Scope Sketch)
All new tables are PHI: every one carries the **mig-356 RLS boilerplate** — `tenant_id UUID NOT NULL` with the GUC-aware default, `ENABLE` + `FORCE ROW LEVEL SECURITY`, the `tenant_isolation` policy, FK to `tenants`. Service writes go through `setTenant`/`setTenantTx` with an EXPLICIT `tenant_id` on every insert.

1. **`radiation_oncology_referrals`** — patient, encounter, diagnosis/staging link (to P3 `oncology_diagnoses`/`oncology_staging_records`), intent, urgency, referring clinician, status.
2. **`radiotherapy_plan_refs`** — **external** planning-system reference, plan status, approving radiation oncologist, document link. Store the reference/ID + document link only; NEVER compute or store a calculated treatment plan.
3. **`radiotherapy_fraction_schedules`** — planned/actual fractions, status, hold/cancel reasons, external treatment reference. Track appointment/fraction STATUS; do not drive delivery.
4. **`nuclear_medicine_orders`** — study/therapy type, isotope/radiopharmaceutical reference, appointment, preparation instructions.
5. **`radioisotope_administration_records`** — administered activity summary, route, administrator, safety checklist, document links.
6. **`radiation_safety_evidence`** — AERB-adjacent owner-sourced evidence documents and QA references. **OWNER-SOURCED**: ship evidence-owner fields + source/version metadata slots + attachment slots that stay **INERT until the operator supplies them**; never encode AERB radiation-equipment licensing, QA, radiation-safety, radioisotope-handling, or delivery requirements from model memory. Equipment/QA evidence is a register/audit subject, NOT a patient timeline event.
7. **Privilege/catalog seeds** — radiation-oncology privilege key(s) via the N6-5 credentialing pattern (`apps/backend/src/services/staff/credentialingService.js:685-725`, seed into `apps/backend/src/migrations/380_privilege_catalog_seed_and_approval_indexes.sql:5-15`) ONLY if owner-confirmed; otherwise wire the gate but leave it unseeded (fails closed).
8. **Required external-reference metadata FAILS CLOSED**: a referral/plan/order that lacks its required external-reference metadata cannot advance state. This is the integration guardrail, not a warning.
9. **Canonical timeline invariant.** Every patient-facing coordination write (referral, order, administration record) = detail row + `clinical_timeline_events` + `clinical_audit_events` in ONE transaction (`docs/CANONICAL_CLINICAL_TIMELINE.md:85-88`). `radiation_safety_evidence` (equipment QA) uses register/audit trails, not patient timeline events.
10. **Staff/admin UI.** Referral + fraction-status + nuclear-medicine order coordination surfaces with loading/empty/error states, reusing PACS/DICOMweb document links (`docs/RADIOLOGY_PACS.md:225-227`); all strings through the 5-language i18n sweep.

## Tests (spec Suite 6 Test Strategy)
- Unit: referral/order/fraction state transitions; hold/cancel reasons; privilege gates; required external-reference metadata.
- Deep: oncology diagnosis/staging → radiotherapy referral → external plan reference → fraction schedule → timeline/audit evidence.
- Guardrail: prove the product STORES external references and does NOT calculate treatment plans or control delivery systems.
- PACS-link regression: image/document references still resolve against the existing OHIF/DICOMweb-oriented links (`docs/RADIOLOGY_PACS.md:14-35`, `docs/RADIOLOGY_PACS.md:225-227`).

## Deliverable
Branch `feat/nl13-p4-nuclear-med`, PR titled `NL-13 P4: nuclear medicine & radiotherapy coordination (integrate-only)`. PR body = build ledger (scope delivered · invariants held · integrate-only boundary held · migration numbers used · exact test commands + pass counts · anything deferred and why). ALL checks green (re-query `gh pr checks`; `--watch` lies). **STOP after opening the PR** — the coordinator content-verifies and merges. One scope = one PR: do not merge, do not force-push after the PR opens, do not open a second PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `docs/superpowers/build-prompts/nl13-p4-nuclear-med-radiotherapy.md` and `_worker-common.md` beside it, plus the spec `docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md`; execute EXACTLY. Your migration block: 508–512. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens, do not open a second PR for the same scope. Report back with the PR number and your build ledger.
