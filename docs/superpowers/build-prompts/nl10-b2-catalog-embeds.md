# BUILD: NL10-B2 — Governed dataset catalog + curated embedded dashboards

**Spec:** `docs/superpowers/specs/2026-07-07-nl10-embedded-bi-design.md` — read it fully (especially §3.3 + §5 staged posture), plus `_worker-common.md` beside this file. ALL its rules apply: isolated worktree, scratch-DB schema-regen law, Decimal wire-shaping law, full local gates, build ledger, STOP after the PR (no post-PR pushes — the coordinator owns rebases/rolls/merges).

## Start gate
```
git fetch github
git grep -q "Governed dataset" github/main -- docs/superpowers/specs/2026-07-07-nl10-embedded-bi-design.md || git ls-tree github/main -- docs/superpowers/specs/2026-07-07-nl10-embedded-bi-design.md | grep -q .
```
Exit 0 → proceed. Otherwise STOP and report.

## Workspace
Worktree `VH-Health-Platform-nl10-b2`, branch `feat/nl10-b2-catalog` (per `_worker-common.md` setup).

## Scope (this slice exactly — the spec section is authoritative; do not pull in later slices)
- Governed dataset catalog (which marts exist, owner, PHI class, refresh) surfaced in admin; patient_uid stays hidden from BI authors (locked default — backend-controlled drilldowns only).
- Curated embedded dashboards for the exec set per spec; per-dashboard access mapped to existing admin RBAC.


## Migrations
Estimated **1**. Your actual numbers are coordinator-assigned at launch (playbook §5 registry) — use ONLY that block; never ls-and-take.

## Deliverable
Size M. PR titled `NL10-B2: Governed dataset catalog + curated embedded dashboards` with a full build ledger (scope delivered, invariants held, migration numbers used, exact test commands + pass counts, deferrals). ALL checks green (re-query; `--watch` lies). STOP after the PR.

## Kickoff line (coordinator pastes into a fresh worker session)
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl10-b2-catalog-embeds.md` and `_worker-common.md` beside it; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: <ASSIGN>. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens. Report back with the PR number and your build ledger.
