# BUILD: N6-9 — Dialysis completion (reuse register, machine QA, billing hook)

**Plan:** `docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md` §4.6. Read fully, plus `_worker-common.md`. Dialysis is the platform's deepest module (migs 168+291); the device-ingest seam is DONE and its authentication upgrade belongs to NL-7 (device principal) — do NOT touch ingest auth here. Dialyzer-reuse register format: if not yet sourced (playbook Decision 3), ship flagged "format pending".

## Start gate
```
git fetch github
git grep -q "dialysis_depth" github/main -- apps/backend/src/migrations
```

## Workspace
Worktree `VH-Health-Platform-nl6-9`, branch `feat/nl6-9-dialysis-completion`. Backend + admin (+ staff bedside screen only if capacity allows — admin-only entry is acceptable).

## Scope (plan §4.6)
~2–3 migrations: `dialyzer_reuse_register` (dialyzer serial ↔ patient, cycle count vs the existing `reuse_count` column, integrity test, discard reason) · `dialysis_machine_qa_logs` (disinfection/turnaround per `machine_no`; non-clinical — no timeline events) · per-session charge hook into billing line items behind a tariff config — **money touches the ledger: shadow-first discipline, inert flag until finance review** (the money-ledger program rule) · optional PD dwell observations table.

## Tests
Deep: reuse-count vs register consistency; QA-log gating (warn-only); billing line emission on session complete (flag-gated, inertness proof both ways). Unit: reuse-cycle rules. Extend `dialysis-depth.deep.test.js`.

## Deliverable
PR `N6-9: dialysis completion (reuse register, machine QA, billing hook)` + ledger. Stop after PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl6-09-dialysis-completion.md` and `_worker-common.md`; execute EXACTLY. Your migration block: <ASSIGN>. STOP after the PR; report PR number + ledger.
