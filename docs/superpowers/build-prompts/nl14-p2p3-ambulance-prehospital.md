# BUILD: NL-14 P2/P3 — Ambulance and pre-hospital handover seam (manual-first)

You are implementing **NL-14 P2/P3 (ambulance & pre-hospital seam)** for the VH Health Platform. The approved design is on `github/main`: `docs/superpowers/specs/2026-07-08-nl14-critical-care-emergency-design.md` — read it in full; your scope is **§4.4 exactly**, bounded by governance boundaries §3, owner decisions §6, and explicit boundaries §7. Also read `docs/CANONICAL_CLINICAL_TIMELINE.md`, `_worker-common.md` (beside this file), and `apps/backend/CLAUDE.md`.

**Parallel-safety:** ambulance touches disjoint backend tables (pre-hospital handover header/timeline, acceptance signatures, partner/fleet config, device links) and its own staff/admin surfaces — parallel-safe with the ED-trauma (`feat/nl14-p2-ed-trauma`) and burns (`feat/nl14-p3-burns`) slices and with the NL-13 slices; sibling overlap only in `schema.prisma`/`openapi.json`. **Ships manual-first, fully independent of any partner/device integration** (spec §5.4, `...nl14-critical-care-emergency-design.md:149`).

## Start gate (run before anything)
```
git fetch github
git grep -q "NL-14 critical-care and emergency depth design" github/main -- docs/superpowers/specs/2026-07-08-nl14-critical-care-emergency-design.md
```
Exit 0 → proceed. Exit 1 → STOP and report.

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl14-ambulance"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl14-p2p3-ambulance github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install && npm --prefix apps/admin install
dart pub get   # Flutter workspace (handover-acceptance staff-app surface)
```
All work happens inside `$WT`. Push with `git push github feat/nl14-p2p3-ambulance`; open the PR against `main` on `Bahuleyandr/VH-Health-Platform` with `gh`. Backend tests need dev Postgres on `:5433` — start per `apps/backend/CLAUDE.md`. Admin type-check is `npm run type-check` inside `apps/admin` (NOT raw `npx tsc`).

## Environment & isolation (MANDATORY)
- NEVER work in, commit in, or switch branches of `D:\Dev\Projects\VH Health\VH-Health-Platform` itself (shared checkout — contamination history, PR #427). Your worktree is your world.
- Backend gate: `node apps/backend/scripts/run-ci-jest.mjs`. Route changes ⇒ `npm run openapi:generate && npm run openapi:check` in `apps/backend`, commit `src/docs/openapi.json`.
- Staff-app changes ⇒ `melos run analyze && melos run test`; every user-facing string through all 5 `intl_*.arb` files (i18n guard fails CI otherwise). Admin ⇒ `npm run lint && npm run type-check` in `apps/admin`.
- Migrations: bare DDL at `apps/backend/src/migrations/NNN_*.sql`; regenerate `schema.prisma` ONLY from a disposable scratch DB built from YOUR OWN worktree's migrations (schema-regeneration LAW, PR #458), commit `.prisma` with the `.sql`; then `check-phi-tenant-id.mjs` + `check-schema-drift.mjs`.
- **Your reserved migration numbers: 524–528** (use in order, leave unused ones untaken). Numbers only from playbook §5. Sibling NL-14 blocks — do NOT touch: ED-trauma 518–523, burns 536–541.
- Deploy stays HELD: ship inert behind per-tenant flags (mig-351 `composition_search_settings` + `compositionFeatureService` fail-closed pattern); any k8s manifests land unreferenced by the root kustomization.

## Scope (deliver all — spec §4.4)
Every new PHI table carries the **mig-356 RLS boilerplate** (tenant_id UUID NOT NULL with GUC-aware default, ENABLE + FORCE ROW LEVEL SECURITY, `tenant_isolation` policy, FK to tenants); service writes go through `setTenantTx` with EXPLICIT tenant_id on inserts. Every patient-facing clinical write is one transaction: detail row + `clinical_timeline_events` + `clinical_audit_events` (canonical timeline invariant, `docs/CANONICAL_CLINICAL_TIMELINE.md`).

1. **Manual-only handover path FIRST** per spec §4.4 bullet 3 (`...design.md:106`) and slice order §5.4 (`...design.md:149`): ship the manual-only handover-acceptance workflow BEFORE any partner or device integration. **Partner fleets without integration use the SAME handover-acceptance workflow.** This is the primary deliverable; everything device/partner-shaped is inert scaffolding around it.
2. **Pre-hospital handover header** (mig **525**) per spec §4.4 bullet 1 (`...design.md:104`): ambulance encounter/handover records linked to `ambulance_requests` (`apps/backend/src/migrations/126_ed_operational_entities.sql:129`) and the ED visit — pickup context, scene observations, allergies/meds reported, ETA changes. mig-356 RLS + canonical timeline invariant.
3. **Pre-hospital observation/intervention timeline** (mig **526**) per spec §4.4 bullet 1 + estimate (`...design.md:104`, `:108`): append-only en-route observation/intervention timeline tied to the handover header. mig-356 RLS + canonical timeline invariant.
4. **Handover acceptance signatures** (mig **527**) per spec §4.4 bullet 1 (`...design.md:104`): receiving nurse/doctor acceptance + handover signed-at. **A partner-supplied payload CANNOT write the patient chart without an accepted handover / device association** (spec test `...design.md:110`). mig-356 RLS + audit.
5. **Ambulance partner/fleet config** (mig **524**, if needed) per spec §4.4 gap (`...design.md:100`) + estimate (`...design.md:108`): partner identity/consent boundary. Owner decision §6.3 (`...design.md:157`) — internal-fleet-only / named partner API-device / manual-first — build as a policy/config table INERT until the operator supplies scope; unsupplied → manual-first only, FAILS CLOSED against unaccepted partner writes. mig-356 RLS. Leave 524 untaken if not required.
6. **Optional device links** (mig **528**) per spec §4.4 bullet 2 (`...design.md:105`): **en-route device vitals are NL-7 transport, NOT NL-14-owned.** Ambulance monitor/device auth, local-push adapter, and store-and-forward all belong to NL-7 (explicit boundary §7, `...design.md:163`). NL-14 only CONSUMES verified/unverified observations once NL-7 delivers them; this table records the link only, never an ingest path. mig-356 RLS. Leave 528 untaken if not required.
7. **Tier-D SBAR handover draft** per spec §4.4 exists (`...design.md:98`): Tier-D drafts SBAR from an ambulance-request row (`apps/backend/src/services/ai/tierDEmergencyService.js:224`, `:241`). The **draft cites ONLY supplied rows** (spec test `...design.md:110`) — never fabricates observations and cannot finalize/accept the handover.

**Owner-decision handling (spec §6.3, `...design.md:157`):** ambulance-partner integration scope builds as a policy/config table + evidence-owner fields + version/source metadata + reviewer-signoff slots, **INERT until the operator supplies it**; unsupplied → manual-first, FAILS CLOSED against partner writes.

**Multi-surface:** this slice adds staff-app UI (handover-acceptance workflow for the receiving clinician) and optional admin UI (partner/fleet config). Route every user-facing string through ALL 5 `intl_*.arb` files (i18n guard); run the admin (`lint` + `type-check`) and Flutter (`analyze` + `test`) gates for the surfaces you touch.

## Tests (spec §4.4 — `...design.md:110`)
Manual handover lifecycle; ED visit creation from ambulance handover; ambulance status transitions remain valid; partner-supplied payload cannot write patient chart without accepted handover/device association; Tier-D handover draft cites only supplied rows; tenant and PHI guard tests.

## Deliverable
Branch `feat/nl14-p2p3-ambulance`, PR titled `NL-14 P2/P3: ambulance and pre-hospital handover seam (manual-first)`. PR body = build ledger (scope delivered, invariants held, migration numbers used, exact test commands + pass counts, deferred items). ALL checks green (re-query `gh pr checks`; `--watch` lies). **STOP after the PR** — coordinator verifies and merges. One scope = one PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `docs/superpowers/build-prompts/nl14-p2p3-ambulance-prehospital.md` and `_worker-common.md` beside it, plus the spec `docs/superpowers/specs/2026-07-08-nl14-critical-care-emergency-design.md`; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: 524–528. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens, do not open a second PR for the same scope. Report back with the PR number and your build ledger.
