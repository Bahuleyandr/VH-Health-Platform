# BUILD: NL-13 P1c — Code-STEMI pathway: activation, team fan-out, door-to-balloon SLA, primary-PCI evidence

You are implementing **NL-13 P1c (Code-STEMI pathway)** for the VH Health Platform. **Mirror the merged stroke pathway** (`feat/nl13-p2-stroke` → migs 503–507: `stroke_activations`, `stroke_pathway_events`, SLA wiring — read those migrations and `apps/backend/src/services/clinical/strokePathwayService.js` FIRST and copy their architecture) — this is the cardiac twin: STEMI activation instead of code-stroke, door-to-balloon instead of door-to-needle. Read `_worker-common.md`, `docs/CANONICAL_CLINICAL_TIMELINE.md`, `apps/backend/CLAUDE.md`.

**Parallel-safety:** new backend tables/service/routes + ED/staff surfaces; DISJOINT from NL13-P1b (cath reporting — different tables/files); overlaps siblings only in `schema.prisma`/`openapi.json` = parallel-safe with P1b. Reuses (read-only): ED visit/triage rails (migs 518–523), realtime code-blue channel pattern, `workflow_sla_instances`, cath_lab_cases (link, don't modify).

## Start gate (run before anything)
```
git fetch github
git ls-tree --name-only github/main:apps/backend/src/migrations | grep -qE "^50[3-7]_"   # stroke pathway on main
git ls-tree --name-only github/main:apps/backend/src/migrations | grep -qE "^48[2-8]_"   # cath P1 on main
```
Exit 0 → proceed. Exit 1 → STOP and report.

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl13-p1c"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl13-p1c-stemi-pathway github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install && npm --prefix apps/admin install
dart pub get
```

## Environment & isolation (MANDATORY)
- Shared-checkout ban; scratch-DB schema-regen law; openapi generate/check/sync-core on route changes; staff strings via `AppStrings`/`app_strings.dart` all five locales; `node scripts/dart-format-check.mjs` before push; `check-phi-tenant-id.mjs` + `check-schema-drift.mjs`.
- **Your reserved migration numbers: 558–562** (in order; leave unused untaken). Sibling blocks: P1b 555–557, P1d 563–566, P1e 567–568, P1f 569–571 — do NOT touch.
- All tables PHI: mig-356 RLS boilerplate; explicit tenant_id via `setTenantTx`.
- **New admin/staff API family**: if any admin page calls a new `api/v1/<family>` through the generic proxy, ADD the family to `ALLOWED_PATH_PREFIXES` in `apps/admin/src/app/api/proxy/[...path]/route.ts` AND the `/dashboard/<segment>` entry to `routePolicy.ts` in the SAME commit (five prior smoke 403s from this).

## Scope (deliver all — stroke-pathway architecture, cardiac semantics)
1. **`stemi_activations`** (mig **558**) — patient, encounter/ED-visit link, activation source (`ed_triage`/`ecg_auto_flag`/`clinician`/`prehospital_handover` — link ambulance handover where present), symptom-onset/last-known-well, first-medical-contact time, door time, ECG time, activation clock fields, team, status lifecycle (`activated → lab_notified → in_lab → device_deployed → completed/stood_down` CHECK), stand-down reason, canonical timeline event refs. **Owner-sourced clock/criteria fields stay INERT metadata slots** (activation criteria, target minutes) — never encode STEMI criteria or targets from model memory; per-tenant `stemi_pathway_settings` (mig-351 pattern) carries owner-supplied targets, FAIL-CLOSED (no targets → SLA instances created without breach thresholds, flagged `targets_pending`).
2. **`stemi_pathway_events`** (mig **559**) — append-only ordered events: ECG acquired/read, activation, lab-ready, patient-in-lab, access, wire-crossing, **device deployed (balloon/stent time)**, reperfusion assessment, transfer/disposition; each ties to `workflow_sla_instances` — **door-to-ECG, door-to-lab, door-to-balloon** SLA instances (the stroke door-to-CT/door-to-needle pattern verbatim).
3. **Team notification fan-out** (mig **560** if config table needed) — on activation, notify the on-call cath team via the existing realtime + notification rails (the code-blue `staff:code-blue` channel pattern: durable row first, realtime at-most-once, notification-only — NEVER source of truth). Ack tracking per team member.
4. **Cath-case linkage** — an activation can spawn/link a `cath_lab_cases` row (urgency `emergency`); primary-PCI evidence = the activation's SLA trail + the case's procedure log. Do NOT modify cath P1 tables; FK from activation → case.
5. **Service + routes + surfaces** — `stemiPathwayService.js` following strokePathwayService structure (canonical pair on every patient-facing write, in-tx). ED workbench gains a "Code STEMI" activation action (the trauma-activation pattern from #543); staff cath workbench shows incoming activations with clocks; admin clinical-alerts board lists active STEMI pathways (persisted-history hydration like code-blue — REMEMBER the proxy allowlist for any new family).
6. **Regression guards** — existing code-blue/stroke/ED flows untouched (no shared-table writes); reuse, don't fork, the SLA + realtime helpers.

## Tests
- Unit: activation lifecycle transitions; stand-down; clock-field validation; targets_pending fail-closed shape; team-ack tracking.
- Deep (real DB): ED triage → STEMI activation → team fan-out (durable row asserted) → cath case spawned → pathway events → door-to-ECG/lab/balloon SLA instances created + breach detection with owner targets → canonical timeline/audit rows in-tx → RLS both directions.
- Staff/ED widget tests: activation action, clock display, ack list.
- Regression: stroke pathway suite still green; code-blue channel behavior unchanged.

## Deliverable
Branch `feat/nl13-p1c-stemi-pathway`, PR titled `NL-13 P1c: code-STEMI pathway (activation, team fan-out, door-to-balloon SLA)`. Build ledger with scope · invariants · migs used · exact test commands + counts · deferrals. ALL checks green (re-query; `--watch` lies). **STOP after the PR** — one scope = one PR; no force-push after open; post-PR fixes go to the coordinator.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `docs/superpowers/build-prompts/nl13-p1c-stemi-pathway.md` and `_worker-common.md` beside it; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: 558–562. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens, do not open a second PR for the same scope. Report back with the PR number and your build ledger.
