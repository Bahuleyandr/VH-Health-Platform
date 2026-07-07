# BUILD: NL10-B3 — Exec mobile digest + benchmark pack

**Spec:** `docs/superpowers/specs/2026-07-07-nl10-embedded-bi-design.md` — read it fully (especially §3.5 + benchmark section), plus `_worker-common.md` beside this file. ALL its rules apply: isolated worktree, scratch-DB schema-regen law, Decimal wire-shaping law, full local gates, build ledger, STOP after the PR (no post-PR pushes — the coordinator owns rebases/rolls/merges).

## Start gate
```
git fetch github
git grep -q "Exec mobile" github/main -- docs/superpowers/specs/2026-07-07-nl10-embedded-bi-design.md || git ls-tree github/main -- docs/superpowers/specs/2026-07-07-nl10-embedded-bi-design.md | grep -q .
```
Exit 0 → proceed. Otherwise STOP and report.

## Workspace
Worktree `VH-Health-Platform-nl10-b3`, branch `feat/nl10-b3-digest` (per `_worker-common.md` setup).

## Scope (this slice exactly — the spec section is authoritative; do not pull in later slices)
- Exec digest via in-app/push (LOCKED default channel), composed from mart aggregates; email/WhatsApp routed through NL-9 consent/template rails only.
- Benchmark pack INTERNAL-ONLY with minimum-cell thresholds (locked) — no external sharing until owner revisits.


## Migrations
Estimated **1**. Your actual numbers are coordinator-assigned at launch (playbook §5 registry) — use ONLY that block; never ls-and-take.

## Deliverable
Size S-M. PR titled `NL10-B3: Exec mobile digest + benchmark pack` with a full build ledger (scope delivered, invariants held, migration numbers used, exact test commands + pass counts, deferrals). ALL checks green (re-query; `--watch` lies). STOP after the PR.

## Kickoff line (coordinator pastes into a fresh worker session)
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl10-b3-digest-benchmarks.md` and `_worker-common.md` beside it; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: <ASSIGN>. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens. Report back with the PR number and your build ledger.
