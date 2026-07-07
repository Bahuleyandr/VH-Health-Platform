# BUILD: NL11-S1 — Migration Toolkit P1 — CSV rehearsal workspace

**Spec:** `docs/superpowers/specs/2026-07-07-nl11-productization-plan.md` — read it fully (especially §3 workstream + §5 slice row 1), plus `_worker-common.md` beside this file. ALL its rules apply: isolated worktree, scratch-DB schema-regen law, Decimal wire-shaping law, full local gates, build ledger, STOP after the PR (no post-PR pushes — the coordinator owns rebases/rolls/merges).

## Start gate
```
git fetch github
git grep -q "Migration Toolkit" github/main -- docs/superpowers/specs/2026-07-07-nl11-productization-plan.md || git ls-tree github/main -- docs/superpowers/specs/2026-07-07-nl11-productization-plan.md | grep -q .
```
Exit 0 → proceed. Otherwise STOP and report.

## Workspace
Worktree `VH-Health-Platform-nl11-s1`, branch `feat/nl11-s01-migration-toolkit-p1` (per `_worker-common.md` setup).

## Scope (this slice exactly — the spec section is authoritative; do not pull in later slices)
- Import jobs + source-file contract + CSV profiling + mapping + validation findings + rehearsal report; NO-WRITE preview for patient/encounter/opening-AR files.
- Dry-run-no-write proofs, CSV fixtures, tenant isolation, PHI-redacted reports, duplicate-detection smoke (the spec row's gate list is the test contract).


## Migrations
Estimated **2-3**. Your actual numbers are coordinator-assigned at launch (playbook §5 registry) — use ONLY that block; never ls-and-take.

## Deliverable
Size L. PR titled `NL11-S1: Migration Toolkit P1 — CSV rehearsal workspace` with a full build ledger (scope delivered, invariants held, migration numbers used, exact test commands + pass counts, deferrals). ALL checks green (re-query; `--watch` lies). STOP after the PR.

## Kickoff line (coordinator pastes into a fresh worker session)
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl11-s01-migration-toolkit-p1.md` and `_worker-common.md` beside it; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: <ASSIGN>. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens. Report back with the PR number and your build ledger.
