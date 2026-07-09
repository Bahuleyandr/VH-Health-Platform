# BUILD: NL-13 P6 — Transplant program management (candidates, waitlist, donor referrals, committee, NOTTO ledger)

> **✅ GATE CLEARED 2026-07-09 (owner decision recorded, playbook §7).** Organ scope = **Heart, Liver, Lung, Kidney, small bowel, multivisceral**; donor scope = **both living and deceased**. Migration block **546–554** assigned. The `transplant_programs.organ` enum carries exactly those six categories (multivisceral = combined-organ program; a candidate may list multiple required organs). NOTTO export format/API, committee quorum values, and allocation boundaries remain OPERATOR-supplied — build the substrate inert + fail-closed per the spec, never encode NOTTO allocation rules from model memory.

You are implementing **NL-13 Suite 3 (Transplant Program Management)** for the VH Health Platform. The approved design survey is on `github/main`: `docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md` — read it in full; your scope is **`## Suite 3 - Transplant Program Management`** exactly, plus the shared `## Non-Negotiable Boundaries`. Also read `_worker-common.md` beside this file, `docs/CANONICAL_CLINICAL_TIMELINE.md`, and `apps/backend/CLAUDE.md`. Do NOT re-design or add scope beyond the suite text. This prompt is fully authored so it can launch the moment the gate clears; until then it is inert.

**Parallel-safety:** backend tables/services/routes + staff/admin UI; sibling Wave E workers overlap only in `apps/backend/prisma/schema.prisma` and `apps/backend/src/docs/openapi.json` (regenerate, never hand-merge) = parallel-safe. No build-order dependency on P2/P3/P4 — but this suite does not start until the owner gate above clears and the coordinator assigns a migration block.

## Start gate (run before anything)
```
git fetch github
git grep -q "NL-13 Quaternary Specialty Suites Design Survey" github/main -- docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md
```
Exit 0 → proceed **only if the owner gate above is cleared and a migration block is assigned**. Exit 1 → STOP and report.

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl13-p6"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl13-p6-transplant github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install && npm --prefix apps/admin install
dart pub get   # Flutter workspace (staff-app candidate / committee surfaces)
```
All work happens inside `$WT`. Push with `git push github feat/nl13-p6-transplant`; open the PR against `main` on `Bahuleyandr/VH-Health-Platform` with `gh`. Backend tests need the dev Postgres on `:5433` — start it per `apps/backend/CLAUDE.md` if down.

## Environment & isolation (MANDATORY)
- NEVER work in, commit in, or switch branches of `D:\Dev\Projects\VH Health\VH-Health-Platform` itself (shared-checkout contamination history, PR #427). Your worktree is your world.
- Backend gate: `node apps/backend/scripts/run-ci-jest.mjs`. Route changes ⇒ `npm run openapi:generate && npm run openapi:check` in `apps/backend`, commit `src/docs/openapi.json`. Admin ⇒ `npm run lint && npm run type-check` inside `apps/admin` (NOT raw `npx tsc`). Flutter ⇒ `melos run analyze && melos run test`; EVERY user-facing string in ALL five `intl_*.arb` files (i18n guard fails CI otherwise).
- Migrations: bare DDL at `apps/backend/src/migrations/NNN_*.sql`. Regenerate `schema.prisma` ONLY from a disposable scratch DB built from YOUR OWN worktree's migrations (worker-common Schema-regeneration LAW — never the shared QA/dev DB). Commit `prisma/schema.prisma` WITH the `.sql`; then `node apps/backend/scripts/check-phi-tenant-id.mjs` and `node apps/backend/scripts/check-schema-drift.mjs`.
- **Your reserved migration numbers: 546–554** (use in order, leave unused ones untaken; numbers only from playbook §5). Sibling Wave E blocks — P3 oncology 489–494, P2 stroke 503–507, P4 nuclear-med 508–512, P5 CTVS 542–545.
- Deploy stays HELD: ship inert behind a per-tenant flag (mig-351 `composition_search_settings` + `compositionFeatureService` per-tenant-cache, fail-closed pattern); any k8s manifests land unreferenced by the root kustomization.

## Scope (deliver all — spec Suite 3 Scope Sketch)
All new tables are PHI: every one carries the **mig-356 RLS boilerplate** — `tenant_id UUID NOT NULL` with the GUC-aware default, `ENABLE` + `FORCE ROW LEVEL SECURITY`, the `tenant_isolation` policy, FK to `tenants`. Service writes go through `setTenant`/`setTenantTx` with an EXPLICIT `tenant_id` on every insert. Assign migration numbers from your 546–554 block in order.

1. **`transplant_programs`** (mig **546**) — organ/service-line, site, program owner, status, **NOTTO evidence owner fields**.
2. **`transplant_candidates`** (mig **547**) — patient, diagnosis, listing evaluation status, committee status, contraindications summary, related care plan (`apps/backend/src/services/carePlan/carePlanService.js:28`).
3. **`transplant_waitlist_status_history`** (mig **548**) — listed/hold/inactive/removed/transplanted status, reason, committee/audit link.
4. **`transplant_donor_referrals`** (mig **549**) — deceased/live donor referral, source, relation category, screening summary, documents. **Non-patient subject** (donor) → register/audit trail, NOT a patient timeline event.
5. **`transplant_match_reviews`** (mig **550**) — candidate, donor/referral, compatibility summary, crossmatch documents (chain-of-custody), risk flags, decision.
6. **`transplant_committee_reviews`** (mig **551**) — attendees, **quorum policy reference**, decision, recommendations, deferral reason.
7. **`transplant_immunosuppression_plans`** (mig **552**) — regimen summary, monitoring plan, prescribing owner, downstream medication links.
8. **`transplant_notto_exports`** (mig **553**) — generated package metadata, owner-reviewed status, upload/reference ID, audit evidence. Integrate-only for external NOTTO registry/reporting surfaces until the owner supplies authoritative documents or API/export specs.
9. **Privilege/catalog seeds** (mig **554**) — transplant privilege keys via the N6-5 credentialing pattern (`apps/backend/src/services/staff/credentialingService.js:685-725`, seed into `apps/backend/src/migrations/380_privilege_catalog_seed_and_approval_indexes.sql:5-15`) — OWNER-CONFIRMED: seed transplant surgeon/physician/coordinator/committee-member privilege keys and enforce them on transplant clinical acts (transplant is a high-acuity privileged act, credentialing-gated like chemo). Wire `hasActivePrivilege`/`enforcePrivilegeGate` on procedure-level writes.
10. **NOTTO is OWNER-SOURCED and FAILS CLOSED.** Ship explicit evidence-owner fields, owner-reviewed export states, and document/reference slots as metadata + attachment slots that stay **INERT until the operator supplies them**; never encode NOTTO rules or organ-allocation/match policy from model memory. An export cannot reach a released state without owner-reviewed evidence present.
11. **Canonical timeline invariant.** Every patient-facing candidate write (evaluation, waitlist change, committee decision affecting the candidate, immunosuppression plan) = detail row + `clinical_timeline_events` + `clinical_audit_events` in ONE transaction (`docs/CANONICAL_CLINICAL_TIMELINE.md:85-88`). Donor referrals, committee meeting records, and NOTTO exports are non-patient subjects → register/audit trails, not patient timeline events.
12. **Blood-bank separation (HARD boundary).** The existing blood-bank donor/donation/TTI/component and transfusion crossmatch/bedside-verification rails (`apps/backend/src/services/bloodbank/donorIntakeService.js:259-345`, `apps/backend/src/services/bloodbank/donorProcessingService.js:236-400`, `apps/backend/src/services/bloodbank/transfusionSafetyService.js:164-224`, `apps/backend/src/services/bloodbank/transfusionSafetyService.js:339-351`) are NOT organ-transplant program management — build the organ-transplant donor/referral subjects as SEPARATE entities; do NOT reuse or entangle blood-bank donor rows.
13. **Staff/admin UI.** Candidate/waitlist/committee coordination surfaces with loading/empty/error states; all strings through the 5-language i18n sweep.

## Tests (spec Suite 3 Test Strategy)
- Unit: waitlist status transitions; committee decision state; transplant privilege gates; export-package state transitions.
- Deep: candidate evaluation → committee review → waitlist update → donor referral → match review → timeline/audit evidence.
- Security: tenant isolation, because donor/candidate data crosses patient subjects and must not leak across programs.
- Regression: blood-bank donor and transfusion flows remain SEPARATE from organ-transplant donor/referral subjects (`apps/backend/src/tests/transfusion-loop.deep.test.js:3-4`).

## Deliverable
Branch `feat/nl13-p6-transplant`, PR titled `NL-13 P6: transplant program management (candidates, waitlist, committee, NOTTO ledger)`. PR body = build ledger (scope delivered · invariants held · blood-bank separation held · migration numbers used · exact test commands + pass counts · anything deferred and why). ALL checks green (re-query `gh pr checks`; `--watch` lies). **STOP after opening the PR** — the coordinator content-verifies and merges. One scope = one PR: do not merge, do not force-push after the PR opens, do not open a second PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `docs/superpowers/build-prompts/nl13-p6-transplant.md` and `_worker-common.md` beside it, plus the spec `docs/superpowers/specs/2026-07-08-nl13-quaternary-suites-design.md`; execute EXACTLY. Your migration block: 546–554. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens, do not open a second PR for the same scope. Report back with the PR number and your build ledger.
