# BUILD: NL11-S10 — Interface Engine mini-design gate (DESIGN-ONLY)

**Spec:** `docs/superpowers/specs/2026-07-07-nl11-productization-plan.md` — read it fully (especially §3 workstream + §5 slice row 10), plus `_worker-common.md` beside this file. ALL its rules apply: isolated worktree, scratch-DB schema-regen law, Decimal wire-shaping law, full local gates, build ledger, STOP after the PR (no post-PR pushes — the coordinator owns rebases/rolls/merges).

## Start gate
```
git fetch github
git grep -q "Interface Engine" github/main -- docs/superpowers/specs/2026-07-07-nl11-productization-plan.md || git ls-tree github/main -- docs/superpowers/specs/2026-07-07-nl11-productization-plan.md | grep -q .
```
Exit 0 → proceed. Otherwise STOP and report.

## Workspace
Worktree `VH-Health-Platform-nl11-s10`, branch `feat/nl11-s10-engine-mini-design` (per `_worker-common.md` setup).

## Scope (this slice exactly — the spec section is authoritative; do not pull in later slices)
- Docs-only mini-design: channel schema, connector worker, transform DSL/sandbox, message store, replay + deployment topology under the LOCKED peer-not-subsumed v1 posture.
- Design sign-off required before NL11-S11 — no implementation in this slice.


## Migrations
Estimated **0**. Your actual numbers are coordinator-assigned at launch (playbook §5 registry) — use ONLY that block; never ls-and-take.

## Deliverable
Size S. PR titled `NL11-S10: Interface Engine mini-design gate (DESIGN-ONLY)` with a full build ledger (scope delivered, invariants held, migration numbers used, exact test commands + pass counts, deferrals). ALL checks green (re-query; `--watch` lies). STOP after the PR.

## Kickoff line (coordinator pastes into a fresh worker session)
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl11-s10-engine-mini-design.md` and `_worker-common.md` beside it; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: <ASSIGN>. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens. Report back with the PR number and your build ledger.
