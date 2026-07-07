# BUILD: NL8-P4 — Scheduling 2.0 (templates, overbook, resources)

**Spec:** `docs/superpowers/specs/2026-07-07-nl8-patient-flow-design.md` — read it fully (especially §3 scheduling workstream + §4 P4), plus `_worker-common.md` beside this file. ALL its rules apply: isolated worktree, scratch-DB schema-regen law, Decimal wire-shaping law, full local gates, build ledger, STOP after the PR (no post-PR pushes — the coordinator owns rebases/rolls/merges).

## Start gate
```
git fetch github
git grep -q "Scheduling 2.0" github/main -- docs/superpowers/specs/2026-07-07-nl8-patient-flow-design.md || git ls-tree github/main -- docs/superpowers/specs/2026-07-07-nl8-patient-flow-design.md | grep -q .
```
Exit 0 → proceed. Otherwise STOP and report.

## Workspace
Worktree `VH-Health-Platform-nl8-p4`, branch `feat/nl8-p4-scheduling2` (per `_worker-common.md` setup).

## Scope (this slice exactly — the spec section is authoritative; do not pull in later slices)
- Provider availability templates + slot generation per spec, layered over the existing appointment fabric (no parallel booking system).
- Overbook policy engine: caps + override authority + audit evidence, all tenant-configurable, ship inert/default-off.
- Resource booking (rooms/equipment) with conflict checks — reuse the N6-10 chair-booking EXCLUDE-constraint pattern for no-overlap.


## Migrations
Estimated **3-4**. Your actual numbers are coordinator-assigned at launch (playbook §5 registry) — use ONLY that block; never ls-and-take.

## Deliverable
Size L. PR titled `NL8-P4: Scheduling 2.0 (templates, overbook, resources)` with a full build ledger (scope delivered, invariants held, migration numbers used, exact test commands + pass counts, deferrals). ALL checks green (re-query; `--watch` lies). STOP after the PR.

## Kickoff line (coordinator pastes into a fresh worker session)
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl8-p4-scheduling2.md` and `_worker-common.md` beside it; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: <ASSIGN>. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens. Report back with the PR number and your build ledger.
