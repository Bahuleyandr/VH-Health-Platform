# BUILD: NL-14 P2 — Code-blue and resuscitation documentation

You are implementing **NL-14 Phase 2 (code-blue / resuscitation documentation)** for the VH Health Platform. The approved design is on `github/main`: `docs/superpowers/specs/2026-07-08-nl14-critical-care-emergency-design.md` — read it in full; your scope is **§4.3 exactly**, bounded by **§3 (governance boundaries), §5 (slice order), and §7 (explicit boundaries)**. Also read `docs/CANONICAL_CLINICAL_TIMELINE.md`, `_worker-common.md` beside this file, and `apps/backend/CLAUDE.md`.

**Parallel-safety:** NOT parallel-safe with NL-14 P1. This slice EXTENDS the P1 ICU chart data model — its resus timeline reuses P1's medication/device/line links (spec §5.2). **Sequence AFTER NL-14 P1 has landed on `github/main` and verified**; do not start until P1's migrations and link schema exist. Disjoint from the NL-13 slices once P1 is in.

**Critical invariants (hold these or the PR is rejected):**
- **The durable resus event is the single source of truth.** The realtime `staff:code-blue` channel stays NOTIFICATION-ONLY and at-most-once; creating/updating the durable event MAY emit to `staff:code-blue`, but WS delivery NEVER becomes authoritative (spec §4.3).
- **Dashboard reconnect hydrates persisted events, not the live-only banner** — the current banner is live-only and loses ward/bed/reason context (`docs/superpowers/specs/2026-06-29-realtime-dashboards-clinical-alerts-design.md:25`, `:186`).
- **MAR-linked epinephrine/fluids must not double-administer** — resus medication rows REFERENCE MAR administrations, never a parallel med-admin lane (spec §3; duplicate-dose guard `apps/backend/src/migrations/327_mar_duplicate_administration_guard.sql:45`).

## Start gate (run before anything)
```
git fetch github
git grep -q "NL-14 critical-care and emergency depth design" github/main -- docs/superpowers/specs/2026-07-08-nl14-critical-care-emergency-design.md
# PREREQUISITE gate — NL14-P1 ICU flowsheet (block 495–502) must be MERGED to main
# (resus timeline reuses its medication/device/line-link data model):
git ls-tree --name-only github/main:apps/backend/src/migrations | grep -qE "^(49[5-9]|50[0-2])_"
```
Exit 0 → proceed. Exit 1 → STOP and report.

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl14-p2-resus"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl14-p2-code-blue-resus github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install && npm --prefix apps/admin install
dart pub get   # Flutter workspace (staff-app resus documentation + dashboard hydration)
```
All work happens inside `$WT`. Branch off `github/main` only AFTER NL-14 P1 is merged there (this slice reuses P1's medication/device/line links). Push with `git push github feat/nl14-p2-code-blue-resus`; open the PR against `main` on `Bahuleyandr/VH-Health-Platform` with `gh`. Backend tests need the dev Postgres on `:5433` — start it per `apps/backend/CLAUDE.md` if down. Admin type-check is `npm run type-check` inside `apps/admin` (NOT raw `npx tsc`).

## Environment & isolation (MANDATORY)
- NEVER work in, commit in, or switch branches of `D:\Dev\Projects\VH Health\VH-Health-Platform` itself (shared-checkout contamination history — PR #427). Your worktree is your world.
- Backend gate: `node apps/backend/scripts/run-ci-jest.mjs`. Route changes ⇒ `npm run openapi:generate` + `npm run openapi:check` in `apps/backend`, commit `src/docs/openapi.json`. Staff-app changes ⇒ `melos run analyze && melos run test`; ALL user-facing strings through the five `intl_*.arb` files (i18n guard).
- Migrations: bare DDL at `apps/backend/src/migrations/NNN_*.sql`. Regenerate `schema.prisma` ONLY from a disposable scratch DB built from YOUR worktree's migrations (schema-regen LAW in `_worker-common.md`), commit `prisma/schema.prisma` with the `.sql`; then `node apps/backend/scripts/check-phi-tenant-id.mjs` and `node apps/backend/scripts/check-schema-drift.mjs`.
- **Your reserved migration numbers: 513–517** (use in order, leave unused ones untaken). Numbers only from playbook §5. Map (spec §4.3 estimate, 5 tables): `resuscitation_events` header, append-only `resuscitation_event_timeline`, team roles/signatures, medication/MAR/defib links, post-event QA/debrief.
- Deploy stays HELD: ship inert behind per-tenant flags (mig-351 `composition_search_settings` + `compositionFeatureService` fail-closed pattern); any new k8s/monitoring manifests land unreferenced by the root kustomization.

## Scope (deliver all — spec §4.3)
1. **`resuscitation_events` header** — code-blue / rapid-response events with patient, encounter/admission/ED-visit link, location snapshot (ward/bed/reason captured at event time, not a live pointer), trigger source, start/stop, outcome, team leader, recorder, and post-event note status. Trigger sources cover both explicit code-blue and critical-vital-derived fan-out (`apps/backend/src/utils/clinical/vitalSignMonitor.js:434`; channel emit `apps/backend/src/utils/websocket/realtimeEmitter.js:31`, `:42`, `apps/backend/src/utils/websocket/channelAuth.js:86`).
2. **Append-only `resuscitation_event_timeline`** — compressions, rhythm checks, shocks, airway, medication administrations linked to MAR where possible, defib energy, labs, fluids, blood products, procedures, ROSC, transfer, and death declaration. Rows are ordered and immutable (append-only; no in-place edit/delete of timeline entries).
3. **Realtime stays notification-only** — creating/updating the durable resus event MAY emit to `staff:code-blue`, but WS delivery remains at-most-once and NEVER the source of truth. The dashboard reconnect path hydrates persisted `resuscitation_events` rather than the live-only banner (`docs/superpowers/specs/2026-06-29-realtime-dashboards-clinical-alerts-design.md:25`, `:186`).
4. **Runbook note** — extend `apps/backend/docs/RUNBOOKS/code-blue-misfire.md` (`:26`, `:28`, `:33`) with durable-resus-event reconciliation for the future implementation PR.
5. **Staff-app resus documentation UI** — event header + live timeline entry, team-role/signature capture, dashboard code-blue history hydrated from persisted events. Multi-surface: every user-facing string through ALL five `intl_*.arb` files (i18n guard fails CI otherwise).

**Cross-cutting (every new table + every write):**
- **RLS boilerplate on every table:** mig-356 pattern exactly — `tenant_id UUID NOT NULL` with the GUC-aware default, `ENABLE` + `FORCE ROW LEVEL SECURITY`, `tenant_isolation` policy, FK to tenants. Service writes via `setTenantTx` with EXPLICIT `tenant_id` on inserts.
- **Canonical timeline:** resus events are patient-facing — every clinical write = detail row + `clinical_timeline_events` + `clinical_audit_events` in ONE transaction (`docs/CANONICAL_CLINICAL_TIMELINE.md`).
- **MAR safety:** epinephrine/fluid/blood-product administrations REFERENCE MAR (`apps/backend/src/services/clinical/marFiveRightsService.js:165`, `:234`; two-scan gate `apps/backend/src/migrations/309_bcma_scan_timestamps.sql:6`; duplicate-dose guard `apps/backend/src/migrations/327_mar_duplicate_administration_guard.sql:45`) and must not double-administer.
- **Owner-decision items fail closed:** resus QA/debrief templates, code-blue trigger/charting policy, and any protocol content are clinical-governance-owned (spec §6.5) — build as evidence-owner fields + version/source metadata + reviewer-signoff slots that stay INERT until the operator supplies approved content; unsupplied content FAILS CLOSED, never fallback math. Finalization requires a team leader and recorder; missing either blocks finalize.

## Tests (spec §4.3)
Explicit code-blue trigger creates a durable event AND a realtime notification; critical-vital-derived code-blue links to the alert/device evidence; timeline append is ordered and immutable; MAR-linked epinephrine/fluids do not double-administer; missing team leader/recorder blocks finalization; patient/tenant/PHI guard tests; reconnect dashboard hydrates persisted events instead of relying on the live-only banner. Run the backend gate `node apps/backend/scripts/run-ci-jest.mjs` and, for the Flutter surface, `melos run analyze && melos run test`.

## Deliverable
Branch `feat/nl14-p2-code-blue-resus`, PR titled `NL-14 P2: code-blue and resuscitation documentation`. PR body = build ledger (scope delivered, invariants held, migration numbers used, exact test commands + pass counts, deferred items). ALL checks green (re-query `gh pr checks`; `--watch` lies). **STOP after the PR** — coordinator content-verifies and merges.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `docs/superpowers/build-prompts/nl14-p2-code-blue-resus.md` and `_worker-common.md` beside it, plus the spec `docs/superpowers/specs/2026-07-08-nl14-critical-care-emergency-design.md`; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: 513–517. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens, do not open a second PR for the same scope. Report back with the PR number and your build ledger.
