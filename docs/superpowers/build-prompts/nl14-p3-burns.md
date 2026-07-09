# BUILD: NL-14 P3 — Burns charting, TBSA body-map, fluid-protocol content links

You are implementing **NL-14 Phase 3 (burns)** for the VH Health Platform. The approved design is on `github/main`: `docs/superpowers/specs/2026-07-08-nl14-critical-care-emergency-design.md` — read it in full; your scope is **§4.6 exactly**, bounded by governance boundaries §3, owner decisions §6, and explicit boundaries §7. Also read `docs/CANONICAL_CLINICAL_TIMELINE.md`, `_worker-common.md` (beside this file), and `apps/backend/CLAUDE.md`.

**Parallel-safety:** burns touches disjoint backend tables (burn chart header, wound/TBSA regions, reassessment/media metadata, fluid worksheet, protocol-content links) and its own staff-app surface — parallel-safe with the ED-trauma (`feat/nl14-p2-ed-trauma`) and ambulance (`feat/nl14-p2p3-ambulance`) slices and with the NL-13 slices; sibling overlap only in `schema.prisma`/`openapi.json`. **Depends on NL-5 content studio, which is already on main (mig 381/382)** — no live cross-worker dependency in this wave.

## Start gate (run before anything)
```
git fetch github
git grep -q "NL-14 critical-care and emergency depth design" github/main -- docs/superpowers/specs/2026-07-08-nl14-critical-care-emergency-design.md
```
Exit 0 → proceed. Exit 1 → STOP and report.

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl14-p3-burns"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl14-p3-burns github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install
dart pub get   # Flutter workspace (burn chart + TBSA body-map staff-app surface)
```
All work happens inside `$WT`. Push with `git push github feat/nl14-p3-burns`; open the PR against `main` on `Bahuleyandr/VH-Health-Platform` with `gh`. Backend tests need dev Postgres on `:5433` — start per `apps/backend/CLAUDE.md`.

## Environment & isolation (MANDATORY)
- NEVER work in, commit in, or switch branches of `D:\Dev\Projects\VH Health\VH-Health-Platform` itself (shared checkout — contamination history, PR #427). Your worktree is your world.
- Backend gate: `node apps/backend/scripts/run-ci-jest.mjs`. Route changes ⇒ `npm run openapi:generate && npm run openapi:check` in `apps/backend`, commit `src/docs/openapi.json`.
- Staff-app changes ⇒ `melos run analyze && melos run test`; every user-facing string through all 5 `intl_*.arb` files (i18n guard fails CI otherwise).
- Migrations: bare DDL at `apps/backend/src/migrations/NNN_*.sql`; regenerate `schema.prisma` ONLY from a disposable scratch DB built from YOUR OWN worktree's migrations (schema-regeneration LAW, PR #458), commit `.prisma` with the `.sql`; then `check-phi-tenant-id.mjs` + `check-schema-drift.mjs`.
- **Your reserved migration numbers: 536–541** (use in order, leave unused ones untaken). Numbers only from playbook §5. Sibling NL-14 blocks — do NOT touch: ED-trauma 518–523, ambulance 524–528.
- Deploy stays HELD: ship inert behind per-tenant flags (mig-351 `composition_search_settings` + `compositionFeatureService` fail-closed pattern); any k8s manifests land unreferenced by the root kustomization.

## Scope (deliver all — spec §4.6)
Every new PHI table carries the **mig-356 RLS boilerplate** (tenant_id UUID NOT NULL with GUC-aware default, ENABLE + FORCE ROW LEVEL SECURITY, `tenant_isolation` policy, FK to tenants); service writes go through `setTenantTx` with EXPLICIT tenant_id on inserts. Every patient-facing clinical write is one transaction: detail row + `clinical_timeline_events` + `clinical_audit_events` (canonical timeline invariant, `docs/CANONICAL_CLINICAL_TIMELINE.md`).

1. **Burn chart header** (mig **536**) per spec §4.6 bullet 1 (`...nl14-critical-care-emergency-design.md:136`): burn chart linked to ED visit/admission/MLC — mechanism, time of injury, first aid, inhalation risk, circumferential burns, comorbid risks, wound sites/depth, serial reassessment. **Links from the ED/MLC burn kind that ALREADY exists** (`apps/backend/src/migrations/126_ed_operational_entities.sql:190`, `apps/backend/src/services/ed/edOperationsService.js:58`). mig-356 RLS + canonical timeline invariant.
2. **Burn wound / TBSA regions** (mig **537**) per spec §4.6 bullet 2 (`...design.md:137`): **TBSA body-map as STRUCTURED REGIONS with age-template metadata + clinician override.** The output is DECISION SUPPORT carrying reference/version — **NOT a hidden formula.** mig-356 RLS + canonical timeline invariant.
3. **Burn reassessment / media metadata** (mig **538**) per spec §4.6 gap + estimate (`...design.md:132`, `:140`): serial wound/photograph reassessment trail (media metadata only; blobs via the existing media store). mig-356 RLS + media guard.
4. **Burn fluid worksheet outputs** (mig **539**) per spec §4.6 bullet 3 (`...design.md:138`): a fluid-resuscitation worksheet that RECORDS clinician decisions. **Parkland/local protocol templates come from the NL-5 content studio, already on main (`apps/backend/src/migrations/381_order_set_content_studio_governance.sql`, `apps/backend/src/migrations/382_content_studio_settings.sql`).** The UI renders and records; **it does NOT own Parkland or local protocol constants.** mig-356 RLS.
5. **Protocol-content links** (mig **540**) per spec §4.6 bullet 3 (`...design.md:138`): links to NL-5-approved fluid/analgesia/tetanus/wound-care/transfer/follow-up pathways. **Missing content FAILS CLOSED with "protocol unavailable" — NEVER fallback math** (spec test `...design.md:142`). NL-5 owns content (explicit boundary §7, `...design.md:166`). mig-356 RLS.
6. **Reserved spare** (mig **541**): the spec estimates 4–6 migrations (`...design.md:140`); 541 is held for an additional sub-table only if the model demands one. Leave untaken otherwise.

**Owner-decision handling (spec §6.5, `...design.md:159`):** burn TBSA/fluid references and clinical-governance owners build as **reference/policy tables + evidence-owner fields + version/source metadata + reviewer-signoff slots, INERT until the operator supplies them**; an unsupplied TBSA or fluid reference FAILS CLOSED ("protocol unavailable") — no fallback math, ever.

**Multi-surface:** this slice adds staff-app UI (burn chart + TBSA body-map entry/override). Route every user-facing string through ALL 5 `intl_*.arb` files (i18n guard); run `melos run analyze && melos run test`.

## Tests (spec §4.6 — `...design.md:142`)
MLC burn → burn chart link; TBSA region totals with versioned reference and override; fluid worksheet references approved content; missing content fails closed with "protocol unavailable" rather than fallback math; serial wound assessment timeline; tenant/PHI/media guard tests.

## Deliverable
Branch `feat/nl14-p3-burns`, PR titled `NL-14 P3: burns charting, TBSA body-map, fluid-protocol content links`. PR body = build ledger (scope delivered, invariants held, migration numbers used, exact test commands + pass counts, deferred items). ALL checks green (re-query `gh pr checks`; `--watch` lies). **STOP after the PR** — coordinator verifies and merges. One scope = one PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `docs/superpowers/build-prompts/nl14-p3-burns.md` and `_worker-common.md` beside it, plus the spec `docs/superpowers/specs/2026-07-08-nl14-critical-care-emergency-design.md`; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: 536–541. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens, do not open a second PR for the same scope. Report back with the PR number and your build ledger.
