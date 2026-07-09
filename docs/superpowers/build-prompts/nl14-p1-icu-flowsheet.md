# BUILD: NL-14 P1 — ICU flowsheet depth: ventilation, sedation, device-presence source events

You are implementing **NL-14 Phase 1 (ICU flowsheet depth)** for the VH Health Platform. The approved design is on `github/main`: `docs/superpowers/specs/2026-07-08-nl14-critical-care-emergency-design.md` — read it in full; your scope is **§4.1 exactly**, bounded by **§2 (device-density/charting policy), §3 (governance boundaries), and §7 (explicit boundaries)**. Also read `docs/CANONICAL_CLINICAL_TIMELINE.md`, `_worker-common.md` beside this file, and `apps/backend/CLAUDE.md`.

**Parallel-safety:** safe to run concurrently with the NL-13 slices (disjoint surfaces — ICU charting touches none of their files). This slice is the ICU chart data-model foundation: **NL-14 P2 (resus) and P3 (NICU/PICU) both EXTEND it and are NOT parallel-safe with you — they sequence AFTER P1 lands and verifies** (spec §5.1, §5.2, §5.5).

**Critical boundaries (hold these or the PR is rejected):**
- **NL-7 owns device transport; NL-14 only CONSUMES device observations** (spec §7). Gateway/MLLP/HTTP framing, credentials, registry, association, downsampling, suppression, parking, device metrics stay in NL-7. Never bypass NL-7's governance-owned persistence pacing.
- **N6-6 owns HAI logic** (spec §7). The ICU adapter writes/closes N6-6 `device_presence_logs` for denominator devices ONLY (central line, urinary catheter, ventilator); N6-6 keeps rate math, attribution, snapshots, outbreak logic.
- **RASS/CAM-ICU/CPOT/SOFA/SBT are versioned DECISION-SUPPORT outputs**, not order-mutating — they carry references + reviewer signoff and never place orders, change ventilator settings, stop sedation, or auto-finalize documentation (spec §3, §4.1).

## Start gate (run before anything)
```
git fetch github
git grep -q "NL-14 critical-care and emergency depth design" github/main -- docs/superpowers/specs/2026-07-08-nl14-critical-care-emergency-design.md
```
Exit 0 → proceed. Exit 1 → STOP and report.

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl14-p1"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl14-p1-icu-flowsheet github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install && npm --prefix apps/admin install
dart pub get   # Flutter workspace (staff-app ICU chart widgets)
```
All work happens inside `$WT`. Push with `git push github feat/nl14-p1-icu-flowsheet`; open the PR against `main` on `Bahuleyandr/VH-Health-Platform` with `gh`. Backend tests need the dev Postgres on `:5433` — start it per `apps/backend/CLAUDE.md` if down. Admin type-check is `npm run type-check` inside `apps/admin` (NOT raw `npx tsc`).

## Environment & isolation (MANDATORY)
- NEVER work in, commit in, or switch branches of `D:\Dev\Projects\VH Health\VH-Health-Platform` itself (shared-checkout contamination history — PR #427). Your worktree is your world.
- Backend gate: `node apps/backend/scripts/run-ci-jest.mjs`. Route changes ⇒ `npm run openapi:generate` + `npm run openapi:check` in `apps/backend`, commit `src/docs/openapi.json`. Staff-app changes ⇒ `melos run analyze && melos run test`; ALL user-facing strings through the five `intl_*.arb` files (i18n guard).
- Migrations: bare DDL at `apps/backend/src/migrations/NNN_*.sql`. Regenerate `schema.prisma` ONLY from a disposable scratch DB built from YOUR worktree's migrations (schema-regen LAW in `_worker-common.md`), commit `prisma/schema.prisma` with the `.sql`; then `node apps/backend/scripts/check-phi-tenant-id.mjs` and `node apps/backend/scripts/check-schema-drift.mjs`.
- **Your reserved migration numbers: 495–502** (use in order, leave unused ones untaken). Numbers only from playbook §5. Map (spec §4.1 estimate, 8 tables): ICU chart policy/versioning, ventilation episodes, weaning/SBT trials, line/tube/drain events, ICU-device observation links, ICU scoring outputs, ICU UI preference/audit, optional materialized daily summary.
- Deploy stays HELD: ship inert behind per-tenant flags (mig-351 `composition_search_settings` + `compositionFeatureService` fail-closed pattern); any new k8s/monitoring manifests land unreferenced by the root kustomization.

## Scope (deliver all — spec §4.1)
1. **ICU charting service** — hydrate a patient/day ICU view from manual flowsheet rows (`apps/backend/src/migrations/165_icu_flowsheet.sql:32`, `:107`, `:117`, `:133`, `:169`, `:219`), verified/unverified device vitals (`apps/backend/src/services/emr/deviceVitalsService.js:599`, `:628`), NEWS2, MAR, I/O, and current line/tube/drain presence. Consume NL-7's downsampled, governance-owned persistence (chart interval, critical/warning pass-through, NEWS2-delta, artifact/suppression) — never bypass it (`apps/backend/src/services/emr/deviceVitalsService.js:333`, `:473`, `:510`; NL-7 policy `apps/backend/src/migrations/373_device_ingest_policy.sql:3`; registry/association `apps/backend/src/migrations/371_device_registry.sql:3`, `apps/backend/src/migrations/372_device_patient_associations.sql:3`).
2. **Ventilation + weaning/SBT records** — explicit ventilation episodes and weaning/SBT trial records: mode, settings, oxygen device, start/stop, reason, responsible clinician, linked device-observation IDs where applicable. Durable episode/trial rows, NOT the current hourly manual cell.
3. **Line/tube/drain presence events** — start/stop lifecycle for central line, urinary catheter, ventilator/ETT/tracheostomy, arterial line, drains, feeding tubes, dialysis access, and oxygen device. Only central line, urinary catheter, and ventilator map into N6-6 HAI denominator device types; all others remain ICU chart facts. Do not infer line/device presence from a monitor alone (spec §2).
4. **N6-6 device-presence adapter** — write or close N6-6 `device_presence_logs` for denominator devices ONLY, preserving N6-6 ownership of HAI attribution, snapshots, outbreak logic, and rate computation (`apps/backend/src/migrations/398_hai_device_surveillance.sql:8`, `apps/backend/src/services/quality/infectionControlWorkbenchService.js:18`, `:176`, `:690`, `:880`, `apps/backend/src/services/quality/nabhIndicatorService.js:160`). NL-14 emits denominator source facts; it never computes rates (spec §7).
5. **ICU scoring outputs (decision-support only)** — surface RASS, CAM-ICU, CPOT, SOFA, and SBT-readiness as versioned output rows carrying input facts, output score, references, version, and reviewer identity. They must NOT place orders, change ventilator settings, stop sedation, or auto-finalize documentation — the existing ventilator/sedation module already states that rule (`apps/backend/src/migrations/049_icu_ventilator_sedation_bundle.sql:3`, `:54`, `apps/backend/src/services/ai/icuVentilatorBundleService.js:10`). Sedation/drip documentation REFERENCES MAR administrations (`apps/backend/src/services/clinical/marFiveRightsService.js:165`, `:234`; two-scan gate `apps/backend/src/migrations/309_bcma_scan_timestamps.sql:6`; duplicate-dose guard `apps/backend/src/migrations/327_mar_duplicate_administration_guard.sql:45`), never a parallel medication-administration lane (spec §3).
6. **Staff-app ICU chart UI** — dense flowsheet grid, unverified-device badges, line-presence lifecycle. Multi-surface: every user-facing string through ALL five `intl_*.arb` files (i18n guard fails CI otherwise); admin config surfaces likewise.

**Cross-cutting (every new table + every write):**
- **RLS boilerplate on every table:** mig-356 pattern exactly — `tenant_id UUID NOT NULL` with the GUC-aware default, `ENABLE` + `FORCE ROW LEVEL SECURITY`, `tenant_isolation` policy, FK to tenants. Service writes via `setTenantTx` with EXPLICIT `tenant_id` on inserts (the GUC default silently stamps the literal default tenant otherwise).
- **Canonical timeline:** ICU charting is patient-facing — every clinical write = detail row + `clinical_timeline_events` + `clinical_audit_events` in ONE transaction (`docs/CANONICAL_CLINICAL_TIMELINE.md`). Device rows still land `unverified` and stay unverified until clinician review (`apps/backend/src/services/emr/vitalsChartService.js:430`, `:591`, `:608`).
- **Owner-decision items fail closed:** alarm/charting policy, ICU scoring calculators, and sedation/weaning protocol content are clinical-governance-owned (spec §6.5). Build them as evidence-owner fields + version/source metadata + reviewer-signoff slots that stay INERT until the operator supplies approved content. Unsupplied content FAILS CLOSED ("protocol/score unavailable"), never fallback math. Protocol text, order sets, and weaning pathways consume NL-5 content studio, not hardcoded constants (spec §3).

## Tests (spec §4.1)
Backend deep test: ORU/device ingest → unverified vitals → ICU chart hydration; device association end on discharge/transfer; line/tube/drain start/stop → `device_presence_logs`; HAI denominator clipping (only the three denominator kinds reach N6-6); ventilation/weaning lifecycle; RASS/CAM/SOFA/CPOT/SBT calculator fixtures (version/reference/reviewer present, no order mutation); MAR-linked sedation/drip references (no double-administer); tenant isolation. Staff/admin widget tests: ICU chart density, unverified-device badges, line-presence lifecycle. Run the backend gate `node apps/backend/scripts/run-ci-jest.mjs` and, for the Flutter surface, `melos run analyze && melos run test`.

## Deliverable
Branch `feat/nl14-p1-icu-flowsheet`, PR titled `NL-14 P1: ICU flowsheet depth (ventilation, sedation, device-presence source events)`. PR body = build ledger (scope delivered, invariants held, migration numbers used, exact test commands + pass counts, deferred items). ALL checks green (re-query `gh pr checks`; `--watch` lies). **STOP after the PR** — coordinator content-verifies and merges.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `docs/superpowers/build-prompts/nl14-p1-icu-flowsheet.md` and `_worker-common.md` beside it, plus the spec `docs/superpowers/specs/2026-07-08-nl14-critical-care-emergency-design.md`; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: 495–502. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens, do not open a second PR for the same scope. Report back with the PR number and your build ledger.
