# BUILD: NL9-P5 — Loyalty deepening & reward governance

**Spec:** `docs/superpowers/specs/2026-07-07-nl9-engagement-crm-design.md` — read it fully (especially §Phased Plan P5), plus `_worker-common.md` beside this file. ALL its rules apply: isolated worktree, scratch-DB schema-regen law, Decimal wire-shaping law, full local gates, build ledger, STOP after the PR (no post-PR pushes — the coordinator owns rebases/rolls/merges).

## Start gate
```
git fetch github
git grep -q "Loyalty deepening" github/main -- docs/superpowers/specs/2026-07-07-nl9-engagement-crm-design.md || git ls-tree github/main -- docs/superpowers/specs/2026-07-07-nl9-engagement-crm-design.md | grep -q .
```
Exit 0 → proceed. Otherwise STOP and report.

## Workspace
Worktree `VH-Health-Platform-nl9-p5`, branch `feat/nl9-p5-loyalty` (per `_worker-common.md` setup).

## Scope (this slice exactly — the spec section is authoritative; do not pull in later slices)
- Loyalty rule extensions on the existing health-points substrate; tenant-configurable within platform safety caps (LOCKED); redemption liability/expiry accounting per spec.
- Marketing sends consent-gated like every other outbound.


## Migrations
Estimated **1-2**. Your actual numbers are coordinator-assigned at launch (playbook §5 registry) — use ONLY that block; never ls-and-take.

## Deliverable
Size S-M. PR titled `NL9-P5: Loyalty deepening & reward governance` with a full build ledger (scope delivered, invariants held, migration numbers used, exact test commands + pass counts, deferrals). ALL checks green (re-query; `--watch` lies). STOP after the PR.

## Kickoff line (coordinator pastes into a fresh worker session)
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl9-p5-loyalty.md` and `_worker-common.md` beside it; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: <ASSIGN>. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens. Report back with the PR number and your build ledger.
