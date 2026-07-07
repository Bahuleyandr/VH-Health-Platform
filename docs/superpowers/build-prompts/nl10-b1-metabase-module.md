# BUILD: NL10-B1 — Metabase optional module + warehouse wiring (deploy HELD)

**Spec:** `docs/superpowers/specs/2026-07-07-nl10-embedded-bi-design.md` — read it fully (especially §4 tool matrix + §5 tenancy + staged posture), plus `_worker-common.md` beside this file. ALL its rules apply: isolated worktree, scratch-DB schema-regen law, Decimal wire-shaping law, full local gates, build ledger, STOP after the PR (no post-PR pushes — the coordinator owns rebases/rolls/merges).

## Start gate
```
git fetch github
git grep -q "Metabase optional" github/main -- docs/superpowers/specs/2026-07-07-nl10-embedded-bi-design.md || git ls-tree github/main -- docs/superpowers/specs/2026-07-07-nl10-embedded-bi-design.md | grep -q .
```
Exit 0 → proceed. Otherwise STOP and report.

## Workspace
Worktree `VH-Health-Platform-nl10-b1`, branch `feat/nl10-b1-metabase` (per `_worker-common.md` setup).

## Scope (this slice exactly — the spec section is authoritative; do not pull in later slices)
- Optional-module Kubernetes manifests for Metabase (unreferenced by root kustomization — HELD, telemedicine precedent), connected ONLY to the analytics warehouse as vh_metabase (no BYPASSRLS; marts-only grants — the existing dbt grant macros are the contract).
- BI NEVER reads OLTP (binding invariant); embed seam hardening on the existing metabaseService (signed URLs, tenant-scoped params).
- Phase-1 posture LOCKED: internal/single-tenant analytics; no native SQL for hospital admins.


## Migrations
Estimated **0-1**. Your actual numbers are coordinator-assigned at launch (playbook §5 registry) — use ONLY that block; never ls-and-take.

## Deliverable
Size M. PR titled `NL10-B1: Metabase optional module + warehouse wiring (deploy HELD)` with a full build ledger (scope delivered, invariants held, migration numbers used, exact test commands + pass counts, deferrals). ALL checks green (re-query; `--watch` lies). STOP after the PR.

## Kickoff line (coordinator pastes into a fresh worker session)
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl10-b1-metabase-module.md` and `_worker-common.md` beside it; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: <ASSIGN>. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens. Report back with the PR number and your build ledger.
