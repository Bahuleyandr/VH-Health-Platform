# BUILD: NL11-S3 — Entitlement Packaging P1 — catalog + enforcement contract

**Spec:** `docs/superpowers/specs/2026-07-07-nl11-productization-plan.md` — read it fully (especially §3 workstream + §5 slice row 3), plus `_worker-common.md` beside this file. ALL its rules apply: isolated worktree, scratch-DB schema-regen law, Decimal wire-shaping law, full local gates, build ledger, STOP after the PR (no post-PR pushes — the coordinator owns rebases/rolls/merges).

## Start gate
```
git fetch github
git grep -q "Entitlement Packaging" github/main -- docs/superpowers/specs/2026-07-07-nl11-productization-plan.md || git ls-tree github/main -- docs/superpowers/specs/2026-07-07-nl11-productization-plan.md | grep -q .
```
Exit 0 → proceed. Otherwise STOP and report.

## Workspace
Worktree `VH-Health-Platform-nl11-s3`, branch `feat/nl11-s03-entitlements-p1` (per `_worker-common.md` setup).

## Scope (this slice exactly — the spec section is authoritative; do not pull in later slices)
- SKU/package catalog, feature keys, tenant entitlements; route/nav/mobile capability checks + audit events + grace/expiry policy.
- LOCKED: hard-block commercial/admin/developer features; NEVER hard-block urgent clinical care (visible status + admin remediation instead). Emergency-care non-blocking assertions are mandatory tests.


## Migrations
Estimated **2**. Your actual numbers are coordinator-assigned at launch (playbook §5 registry) — use ONLY that block; never ls-and-take.

## Deliverable
Size M. PR titled `NL11-S3: Entitlement Packaging P1 — catalog + enforcement contract` with a full build ledger (scope delivered, invariants held, migration numbers used, exact test commands + pass counts, deferrals). ALL checks green (re-query; `--watch` lies). STOP after the PR.

## Kickoff line (coordinator pastes into a fresh worker session)
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl11-s03-entitlements-p1.md` and `_worker-common.md` beside it; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: <ASSIGN>. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens. Report back with the PR number and your build ledger.
