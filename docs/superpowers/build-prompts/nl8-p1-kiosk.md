# BUILD: NL8-P1 — Kiosk self-check-in

**Spec:** `docs/superpowers/specs/2026-07-07-nl8-patient-flow-design.md` — read it fully (especially §3 kiosk workstream + §4 P1), plus `_worker-common.md` beside this file. ALL its rules apply: isolated worktree, scratch-DB schema-regen law, Decimal wire-shaping law, full local gates, build ledger, STOP after the PR (no post-PR pushes — the coordinator owns rebases/rolls/merges).

## Start gate
```
git fetch github
git grep -q "Kiosk self-check-in" github/main -- docs/superpowers/specs/2026-07-07-nl8-patient-flow-design.md || git ls-tree github/main -- docs/superpowers/specs/2026-07-07-nl8-patient-flow-design.md | grep -q .
```
Exit 0 → proceed. Otherwise STOP and report.

## Workspace
Worktree `VH-Health-Platform-nl8-p1`, branch `feat/nl8-p1-kiosk` (per `_worker-common.md` setup).

## Scope (this slice exactly — the spec section is authoritative; do not pull in later slices)
- Kiosk check-in flow per spec: locked decisions = QR + OTP primary self-service, per-department supervised staff-tablet mode toggle (tenant settings, mig-351 pattern).
- Appointment lookup/check-in + walk-in token issue riding the EXISTING appointment/token fabric; EMPI dedupe + front-desk guardrails reused, never bypassed.
- Profile edits limited to the spec-listed safe fields; everything else read-only or routed to front-desk approval.
- Kiosk device identity/session hardening exactly as the spec defines (no NL-7-style transport building).


## Migrations
Estimated **2-3**. Your actual numbers are coordinator-assigned at launch (playbook §5 registry) — use ONLY that block; never ls-and-take.

## Deliverable
Size M-L. PR titled `NL8-P1: Kiosk self-check-in` with a full build ledger (scope delivered, invariants held, migration numbers used, exact test commands + pass counts, deferrals). ALL checks green (re-query; `--watch` lies). STOP after the PR.

## Kickoff line (coordinator pastes into a fresh worker session)
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl8-p1-kiosk.md` and `_worker-common.md` beside it; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: <ASSIGN>. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens. Report back with the PR number and your build ledger.
