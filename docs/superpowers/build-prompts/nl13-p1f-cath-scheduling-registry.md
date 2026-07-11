# BUILD: NL-13 P1f — Cath scheduling & registries: cath rooms on Scheduling 2.0, dose-audit rollups, complication registry → quality cockpit + BI

You are implementing **NL-13 P1f (Cath scheduling & registries)** for the VH Health Platform. Two reuse tracks: (a) cath rooms become bookable resources on the merged **Scheduling 2.0** rails (PR #528 — locate its migrations/service by grep and read them FIRST); (b) per-case radiation-dose/contrast and complication data roll up into the existing quality-cockpit indicator rails and BI catalog. Read `_worker-common.md`, `apps/backend/CLAUDE.md`, `apps/backend/src/services/clinical/cathLabService.js`, and the nuclear-medicine dose-register precedent (`feat/nl13-p4-nuclear-med` migs on main) for the dose-rollup shape.

**SEQUENCING: launch AFTER NL13-P1b (cath reporting) is MERGED to main** — shares cathLabService/staff workbench surface. May run in parallel with P1d/P1e (coordinator resolves workbench-file overlaps at roll).

## Start gate (run before anything)
```
git fetch github
git ls-tree --name-only github/main:apps/backend/src/migrations | grep -qE "^55[5-7]_"   # P1b MERGED
git ls-tree --name-only github/main:apps/backend/src/migrations | grep -qE "^48[2-8]_"   # cath P1 on main
git grep -l "scheduling" github/main -- "apps/backend/src/services" | head -1            # Scheduling 2.0 rails present
```
All exit 0 → proceed. Any exit 1 → STOP and report which precondition failed.

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl13-p1f"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl13-p1f-cath-scheduling-registry github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install && npm --prefix apps/admin install
dart pub get
```

## Environment & isolation (MANDATORY)
- Shared-checkout ban; scratch-DB schema-regen law; openapi generate/check/sync-core; staff strings all five locales; dart-format-check before push; phi/schema-drift checks.
- **Your reserved migration numbers: 569–571** (in order; leave unused untaken). Siblings: P1b 555–557, P1c 558–562, P1d 563–566, P1e 567–568.
- PHI tables get mig-356 RLS boilerplate + explicit tenant_id; pure config tables still tenant-scoped.
- Proxy-allowlist + routePolicy law for any new admin `api/v1/<family>`/segment (same commit).
- **Grep-verify every seam on YOUR worktree** (Scheduling 2.0 resource model, quality-cockpit indicator registration, BI catalog dataset registration, cath procedure-log dose/complication fields). A missing rail = STOP and report, not a rebuild.

## Scope (deliver all)
1. **Cath rooms as schedulable resources** (mig **569** only if a seed/mapping table is needed) — register cath lab rooms/tables as resources in the Scheduling 2.0 rails so elective cases can be booked into slots; link `cath_lab_cases` → booking (nullable FK or link table — do NOT modify P1 tables' existing columns). Emergency/STEMI cases bypass booking entirely (documented, tested); an emergency arriving mid-schedule flags the display (soft conflict indicator), never blocks or auto-cancels bookings. Room inventory is an **owner-decision inert slot** (owner creates rooms via existing scheduling admin; ship zero seeded rooms).
2. **Dose-audit rollups** (mig **570**) — grep the cath P1 procedure log for radiation-dose (fluoro time/DAP) and contrast-volume fields; if absent, ADD nullable columns in 570 (no backfill fabrication). Build per-month/per-operator rollup queries + an admin view; **owner-configured alert thresholds** (per-tenant settings, mig-351 pattern) with fail-closed `thresholds_pending` shape when unset — never encode dose limits from model memory.
3. **Complication registry** (mig **571**) — registry rows derived from procedure-log complications (grep the P1 complication capture; extend with a structured registry table: complication code/category owner-taxonomy slot, severity, outcome, review status). Feed the existing quality-cockpit indicator rails (register cath indicators: volumes, complication rate, dose outliers — computation from real rows only) and register the registry as a read-only BI catalog dataset (existing BI-catalog registration pattern).
4. **Surfaces** — staff cath workbench: schedule strip for booked cases (read from scheduling rails); admin: dose rollup + complication registry views under existing quality/scheduling segments where possible (new family ⇒ allowlist + routePolicy in same commit).
5. **Audit** — registry writes and review-status changes emit audit events; dose rollups are read-only derivations (no audit spam on reads beyond existing phiAccessLogger).

## Tests
- Unit: booking linkage; emergency-bypass + soft-conflict flag; thresholds_pending fail-closed; complication registry lifecycle; indicator computation from seeded rows.
- Deep (real DB): create room resource → book elective case → link asserted; emergency case bypasses; procedure log with dose fields → monthly rollup + threshold flag with owner setting; complication → registry row → cockpit indicator + BI dataset visible; RLS both directions.
- Staff/admin widget tests: schedule strip, rollup view, registry review flow.
- Regression: Scheduling 2.0, quality-cockpit, BI-catalog, cath P1/P1b suites all green and their tables unmodified (except documented FKs/columns above).

## Deliverable
Branch `feat/nl13-p1f-cath-scheduling-registry`, PR titled `NL-13 P1f: cath scheduling + dose/complication registries (cockpit + BI)`. Build ledger. ALL checks green. **STOP after the PR**; one scope = one PR; no force-push after open.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `docs/superpowers/build-prompts/nl13-p1f-cath-scheduling-registry.md` and `_worker-common.md` beside it; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: 569–571. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens, do not open a second PR for the same scope. Report back with the PR number and your build ledger.
