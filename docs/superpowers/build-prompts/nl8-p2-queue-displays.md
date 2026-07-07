# BUILD: NL8-P2 — PHI-free queue displays

**Spec:** `docs/superpowers/specs/2026-07-07-nl8-patient-flow-design.md` — read it fully (especially §3 displays workstream + §4 P2), plus `_worker-common.md` beside this file. ALL its rules apply: isolated worktree, scratch-DB schema-regen law, Decimal wire-shaping law, full local gates, build ledger, STOP after the PR (no post-PR pushes — the coordinator owns rebases/rolls/merges).

## Start gate
```
git fetch github
git grep -q "PHI-free queue" github/main -- docs/superpowers/specs/2026-07-07-nl8-patient-flow-design.md || git ls-tree github/main -- docs/superpowers/specs/2026-07-07-nl8-patient-flow-design.md | grep -q .
```
Exit 0 → proceed. Otherwise STOP and report.

## Workspace
Worktree `VH-Health-Platform-nl8-p2`, branch `feat/nl8-p2-queue-displays` (per `_worker-common.md` setup).

## Scope (this slice exactly — the spec section is authoritative; do not pull in later slices)
- Queue TV/token boards: PHI-FREE payloads only (queue label, token/visit number, room/counter, status, timestamps) — LOCKED: token-only, no names/initials unless a later owner override.
- Realtime updates via the existing outbox→WS board recipe; display auth/hosting per spec (admin/staff-web display route behind existing LAN/HTTPS ingress; zero-inbound preserved).
- Per-department display config in tenant settings.


## Migrations
Estimated **1-2**. Your actual numbers are coordinator-assigned at launch (playbook §5 registry) — use ONLY that block; never ls-and-take.

## Deliverable
Size M. PR titled `NL8-P2: PHI-free queue displays` with a full build ledger (scope delivered, invariants held, migration numbers used, exact test commands + pass counts, deferrals). ALL checks green (re-query; `--watch` lies). STOP after the PR.

## Kickoff line (coordinator pastes into a fresh worker session)
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl8-p2-queue-displays.md` and `_worker-common.md` beside it; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: <ASSIGN>. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens. Report back with the PR number and your build ledger.
