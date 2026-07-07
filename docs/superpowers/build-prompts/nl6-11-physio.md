# BUILD: N6-11 — Physiotherapy / rehab foundation (greenfield)

**Plan:** `docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md` §4.9 (physio paragraph). Read fully, plus `_worker-common.md`. Nothing exists (verified) — but the seams are ready: `PHYSIOTHERAPIST` role defined, "Physiotherapy & Rehabilitation" department seeded, discharge flow already opens physio consults, and `care_plans.plan_kind` already includes `'rehab'` in its CHECK (mig 122).

## Start gate
```
git fetch github
git grep -q "Physio/rehab" github/main -- docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md
```

## Workspace
Worktree `VH-Health-Platform-nl6-11`, branch `feat/nl6-11-physio`. Backend + admin + staff app (therapist worklist; i18n all 5 arb files).

## Scope
~2–3 migrations, tenant RLS: referral intake (from consult/discharge via `follow_up_plans.origin` — reuse, don't fork) · structured physio assessment record · therapy plan reusing `care_plans` with `plan_kind='rehab'` (no new plan table) · `physio_sessions` (session logs with structured measures — ROM/pain-score/exercise entries as typed JSONB) · simple outcome scores over time · staff-app therapist worklist + session-entry screen; admin view of plans/progress. Clinical writes are patient-facing → full canonical timeline events per the platform contract.

## Tests
Deep: referral → assessment → plan → sessions → discharge-summary linkage walk; outcome trend math; role gating (PHYSIOTHERAPIST). Unit: measure validation. Widget tests for the worklist mapping.

## Deliverable
PR `N6-11: physiotherapy/rehab foundation` + ledger. Stop after PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl6-11-physio.md` and `_worker-common.md`; execute EXACTLY. Your migration block: <ASSIGN>. STOP after the PR; report PR number + ledger.
