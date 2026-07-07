# BUILD: NL8-P3 — Porter & patient-transport tasks

**Spec:** `docs/superpowers/specs/2026-07-07-nl8-patient-flow-design.md` — read it fully (especially §3 porter workstream + §4 P3), plus `_worker-common.md` beside this file. ALL its rules apply: isolated worktree, scratch-DB schema-regen law, Decimal wire-shaping law, full local gates, build ledger, STOP after the PR (no post-PR pushes — the coordinator owns rebases/rolls/merges).

## Start gate
```
git fetch github
git grep -q "Porter &" github/main -- docs/superpowers/specs/2026-07-07-nl8-patient-flow-design.md || git ls-tree github/main -- docs/superpowers/specs/2026-07-07-nl8-patient-flow-design.md | grep -q .
```
Exit 0 → proceed. Otherwise STOP and report.

## Workspace
Worktree `VH-Health-Platform-nl8-p3`, branch `feat/nl8-p3-porter` (per `_worker-common.md` setup).

## Scope (this slice exactly — the spec section is authoritative; do not pull in later slices)
- Porter/transport task lifecycle mirroring the housekeeping request/log shape (own tables — the generic tasks table is NOT the substrate).
- Task sources per spec (discharge, transfer, sample, equipment moves); roster-based recipient resolution + escalation via existing engine.
- Role/zone/SLA parameters ship configurable per tenant with safe defaults (owner values = operator board).


## Migrations
Estimated **2-3**. Your actual numbers are coordinator-assigned at launch (playbook §5 registry) — use ONLY that block; never ls-and-take.

## Deliverable
Size M. PR titled `NL8-P3: Porter & patient-transport tasks` with a full build ledger (scope delivered, invariants held, migration numbers used, exact test commands + pass counts, deferrals). ALL checks green (re-query; `--watch` lies). STOP after the PR.

## Kickoff line (coordinator pastes into a fresh worker session)
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl8-p3-porter-transport.md` and `_worker-common.md` beside it; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: <ASSIGN>. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens. Report back with the PR number and your build ledger.
