# BUILD: NL12-S4 — SLSA verify-before-pin + digest closure

**Spec:** `docs/superpowers/specs/2026-07-07-nl12-assurance-plan.md` — read it fully (especially §4 split + §5 slice row NL12-S4), plus `_worker-common.md` beside this file. ALL its rules apply: isolated worktree, scratch-DB schema-regen law, Decimal wire-shaping law, full local gates, build ledger, STOP after the PR (no post-PR pushes — the coordinator owns rebases/rolls/merges).

## Start gate
```
git fetch github
git grep -q "SLSA verify-before-pin" github/main -- docs/superpowers/specs/2026-07-07-nl12-assurance-plan.md || git ls-tree github/main -- docs/superpowers/specs/2026-07-07-nl12-assurance-plan.md | grep -q .
```
Exit 0 → proceed. Otherwise STOP and report.

## Workspace
Worktree `VH-Health-Platform-nl12-s4`, branch `feat/nl12-s4-slsa-verify-pin` (per `_worker-common.md` setup).

## Scope (this slice exactly — the spec section is authoritative; do not pull in later slices)
- Verified-then-pinned image evidence per release; make the signing path FAIL CLOSED when secrets are absent (the current skip is the known hole).


## Migrations
Estimated **0**. Your actual numbers are coordinator-assigned at launch (playbook §5 registry) — use ONLY that block; never ls-and-take.

## Deliverable
Size S-M. PR titled `NL12-S4: SLSA verify-before-pin + digest closure` with a full build ledger (scope delivered, invariants held, migration numbers used, exact test commands + pass counts, deferrals). ALL checks green (re-query; `--watch` lies). STOP after the PR.

## Kickoff line (coordinator pastes into a fresh worker session)
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl12-s4-slsa-verify-pin.md` and `_worker-common.md` beside it; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: <ASSIGN>. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens. Report back with the PR number and your build ledger.
