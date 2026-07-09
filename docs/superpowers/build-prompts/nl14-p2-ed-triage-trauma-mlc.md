# BUILD: NL-14 P2 — ED triage scale, trauma activation, primary/secondary surveys, MLC completeness

You are implementing **NL-14 Phase 2 (ED triage / trauma / MLC)** for the VH Health Platform. The approved design is on `github/main`: `docs/superpowers/specs/2026-07-08-nl14-critical-care-emergency-design.md` — read it in full; your scope is **§4.2 exactly**, bounded by governance boundaries §3, owner decisions §6, and explicit boundaries §7. Also read `docs/CANONICAL_CLINICAL_TIMELINE.md`, `_worker-common.md` (beside this file), and `apps/backend/CLAUDE.md`.

**Parallel-safety:** ED-trauma touches disjoint backend tables (tenant ED policy, trauma activations, survey records, trauma timeline, MLC completeness) and its own admin/staff surfaces — parallel-safe with the ambulance (`feat/nl14-p2p3-ambulance`) and burns (`feat/nl14-p3-burns`) slices and with the NL-13 slices; sibling overlap only in `schema.prisma`/`openapi.json` (regenerate from your OWN worktree's migrations, never the shared DB).

## Start gate (run before anything)
```
git fetch github
git grep -q "NL-14 critical-care and emergency depth design" github/main -- docs/superpowers/specs/2026-07-08-nl14-critical-care-emergency-design.md
```
Exit 0 → proceed. Exit 1 → STOP and report.

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl14-p2-ed"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl14-p2-ed-trauma github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install && npm --prefix apps/admin install
dart pub get   # Flutter workspace (trauma activation / survey / MLC staff-app surfaces)
```
All work happens inside `$WT`. Push with `git push github feat/nl14-p2-ed-trauma`; open the PR against `main` on `Bahuleyandr/VH-Health-Platform` with `gh`. Backend tests need dev Postgres on `:5433` — start per `apps/backend/CLAUDE.md`. Admin type-check is `npm run type-check` inside `apps/admin` (NOT raw `npx tsc`).

## Environment & isolation (MANDATORY)
- NEVER work in, commit in, or switch branches of `D:\Dev\Projects\VH Health\VH-Health-Platform` itself (shared checkout — contamination history, PR #427). Your worktree is your world.
- Backend gate: `node apps/backend/scripts/run-ci-jest.mjs`. Route changes ⇒ `npm run openapi:generate && npm run openapi:check` in `apps/backend`, commit `src/docs/openapi.json`.
- Staff-app changes ⇒ `melos run analyze && melos run test`; every user-facing string through all 5 `intl_*.arb` files (i18n guard fails CI otherwise). Admin ⇒ `npm run lint && npm run type-check` in `apps/admin`.
- Migrations: bare DDL at `apps/backend/src/migrations/NNN_*.sql`; regenerate `schema.prisma` ONLY from a disposable scratch DB built from YOUR OWN worktree's migrations (schema-regeneration LAW, PR #458), commit `.prisma` with the `.sql`; then `check-phi-tenant-id.mjs` + `check-schema-drift.mjs`.
- **Your reserved migration numbers: 518–523** (use in order, leave unused ones untaken). Numbers only from playbook §5. Sibling NL-14 blocks — do NOT touch: ambulance 524–528, burns 536–541.
- Deploy stays HELD: ship inert behind per-tenant flags (mig-351 `composition_search_settings` + `compositionFeatureService` fail-closed pattern); any k8s manifests land unreferenced by the root kustomization.

## Scope (deliver all — spec §4.2)
Every new PHI table carries the **mig-356 RLS boilerplate** (tenant_id UUID NOT NULL with GUC-aware default, ENABLE + FORCE ROW LEVEL SECURITY, `tenant_isolation` policy, FK to tenants); service writes go through `setTenantTx` with EXPLICIT tenant_id on inserts. Every patient-facing clinical write is one transaction: detail row + `clinical_timeline_events` + `clinical_audit_events` (canonical timeline invariant, `docs/CANONICAL_CLINICAL_TIMELINE.md`).

1. **Tenant ED policy — canonical triage scale** (mig **518**) per spec §4.2 scope bullet 1 (`...nl14-critical-care-emergency-design.md:69`): a tenant ED policy table that SELECTS one canonical triage scale (ESI/ATS/CTAS/Manchester) and maps alternatives only for imported/legacy records. **Build so the OWNER picks the scale at activation — do NOT hardcode a scale** (owner decision §6.1, `...design.md:155`). The service already stores several scale strings (`apps/backend/src/services/ed/edOperationsService.js:33`, `:37`, `:370`); the policy constrains ACTIVE operations to the one selected. INERT until the operator supplies the choice; unsupplied → FAILS CLOSED (no active scale mixing). mig-356 RLS boilerplate.
2. **Trauma activations + team roles** (mig **519**) per spec §4.2 bullet 2 (`...design.md:70`): activation reason, activation level, team roles, arrival times, blood-bank/radiology/OT alerts, link to ED visit/admission (ED entities at `apps/backend/src/migrations/126_ed_operational_entities.sql:12`). mig-356 RLS + canonical timeline invariant.
3. **Primary/secondary survey records** (mig **520**) per spec §4.2 bullet 3 (`...design.md:71`): airway, breathing, circulation, disability, exposure, FAST/imaging, interventions, reassessment time, responsible clinician, source citations. Required-field validation gates completion. mig-356 RLS + canonical timeline invariant.
4. **Trauma timeline / interventions** (mig **521**) per spec §4.2 migration estimate (`...design.md:75`): append-only trauma timeline/intervention records tied to the activation. mig-356 RLS + canonical timeline invariant.
5. **MLC completeness / audit** (mig **522**) per spec §4.2 bullet 4 (`...design.md:72`): alleged history, injury diagram/description, police notification, certificate signer, chain-of-custody attachments, closure requirements. **The MLC draft assistant may PREFILL but CANNOT certify** — the MLC completeness gate BLOCKS certification on any missing required field. **Tier-D assistant outputs (`apps/backend/src/services/ai/tierDEmergencyService.js:396`) cannot bypass human signoff.** mig-356 RLS + audit trail.
6. **Optional injury-diagram attachments** (mig **523**) per spec §4.2 migration estimate (`...design.md:75`): injury-diagram/media attachment metadata for the MLC/survey record (blobs via existing media store; metadata only). mig-356 RLS + media guard. Use only if needed; leave 523 untaken otherwise.
7. **NL-7 device vitals as ED encounter evidence** per spec §4.2 bullet 5 (`...design.md:73`): integrate vital snapshots and device observations from NL-7 as encounter EVIDENCE linked to the ED visit — **NOT an ED-specific vitals transport.** NL-7 owns transport/registry/association/downsampling (explicit boundary §7, `...design.md:163`); consume verified/unverified observations, never re-ingest. ED board/queue stays NL-8 (`...design.md:164`) — emit clinical events/status hints only, do not own the queue engine.

**Owner-decision handling (spec §6, `...design.md:153`):** triage scale (§6.1), trauma-registry participation (§6.2), and clinical-governance owners (§6.5) all build as **policy tables + evidence-owner fields + version/source metadata + reviewer-signoff slots, INERT until the operator supplies them**; unsupplied content FAILS CLOSED (no scale mixing, no auto-certification, no unreviewed registry export).

**Multi-surface:** this slice adds admin UI (tenant triage-scale policy config) and staff-app UI (trauma activation, survey capture, MLC completeness). Route every user-facing string through ALL 5 `intl_*.arb` files (i18n guard); run the admin (`lint` + `type-check`) and Flutter (`analyze` + `test`) gates for the surfaces you touch.

## Tests (spec §4.2 — `...design.md:77`)
Triage scale policy validation; ED visit → triage → board order; trauma activation role/time invariants; survey record required-field validation; MLC incomplete cannot certify; assistant outputs cannot bypass human signoff; device vitals evidence linked to ED visit; tenant and PHI access tests.

## Deliverable
Branch `feat/nl14-p2-ed-trauma`, PR titled `NL-14 P2: ED triage, trauma activation, surveys, MLC completeness`. PR body = build ledger (scope delivered, invariants held, migration numbers used, exact test commands + pass counts, deferred items). ALL checks green (re-query `gh pr checks`; `--watch` lies). **STOP after the PR** — coordinator verifies and merges. One scope = one PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `docs/superpowers/build-prompts/nl14-p2-ed-triage-trauma-mlc.md` and `_worker-common.md` beside it, plus the spec `docs/superpowers/specs/2026-07-08-nl14-critical-care-emergency-design.md`; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: 518–523. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens, do not open a second PR for the same scope. Report back with the PR number and your build ledger.
