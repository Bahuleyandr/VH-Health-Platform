# BUILD: N6-14 — Linen / laundry (par stock + cycle counts) — LOWEST PRIORITY, DO LAST

**Plan:** `docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md` §4.9 (linen paragraph). Read fully, plus `_worker-common.md`. Launch only when every other NL-6 slice is done or a tenant asks. Nearest analogs: housekeeping request/log fabric (migs 052/249/250) and `ward_indents` `'linen'` type (supply requisition — that flow stays untouched).

## Start gate
```
git fetch github
git grep -q "Linen/laundry" github/main -- docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md
```

## Workspace
Worktree `VH-Health-Platform-nl6-14`, branch `feat/nl6-14-linen`. Backend + admin.

## Scope
~1–2 migrations, tenant RLS: per-ward linen par levels (item type, par qty) · soiled/clean cycle counts riding the housekeeping request pattern (collection run → laundry → return, quantities per item type, discrepancy flag) · simple par-vs-actual board on admin. No RFID/tag tracking (that would be NL-7 RTLS territory), no external-laundry billing.

## Tests
Deep: collection → laundry → return cycle with discrepancy flag; par-level math. Unit: count reconciliation.

## Deliverable
PR `N6-14: linen/laundry par stock + cycles` + ledger. Stop after PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl6-14-linen.md` and `_worker-common.md`; execute EXACTLY. Your migration block: <ASSIGN>. STOP after the PR; report PR number + ledger.
