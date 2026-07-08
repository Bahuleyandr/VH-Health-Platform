# BUILD: NL9-P1 — Engagement foundation & consent-safe campaigns

**Spec:** `docs/superpowers/specs/2026-07-07-nl9-engagement-crm-design.md` — read it fully (especially §Workstreams + §Phased Plan P1), plus `_worker-common.md` beside this file. ALL its rules apply: isolated worktree, scratch-DB schema-regen law, Decimal wire-shaping law, full local gates, build ledger, STOP after the PR (no post-PR pushes — the coordinator owns rebases/rolls/merges).

## Start gate
```
git fetch github
git grep -q "Engagement foundation" github/main -- docs/superpowers/specs/2026-07-07-nl9-engagement-crm-design.md || git ls-tree github/main -- docs/superpowers/specs/2026-07-07-nl9-engagement-crm-design.md | grep -q .
```
Exit 0 → proceed. Otherwise STOP and report.

## Workspace
Worktree `VH-Health-Platform-nl9-p1`, branch `feat/nl9-p1-campaigns` (per `_worker-common.md` setup).

## Scope (this slice exactly — the spec section is authoritative; do not pull in later slices)
- Per-tenant engagement settings (mig-351 clone, acceptance snapshot, default OFF) + campaign/audience/recipient ledgers per spec.
- CONSENT GATES EVERY OUTBOUND TOUCH: recipients materialize only against current tenant-scoped patient_consents rows (fail-closed middleware pattern); narrow new consent types on patient_consents (LOCKED — no parallel consent store).
- Delivery rides notificationOutbox + existing WhatsApp/SMS/push rails (Twilio confirmed provider); quiet hours + per-patient cooldown + daily caps ship configurable with safe defaults.
- Approval workflow: admin/quality for broad campaigns, care-team approval for cohort campaigns (LOCKED).


## Migrations
Estimated **3-4**. Your actual numbers are coordinator-assigned at launch (playbook §5 registry) — use ONLY that block; never ls-and-take.

## Deliverable
Size L. PR titled `NL9-P1: Engagement foundation & consent-safe campaigns` with a full build ledger (scope delivered, invariants held, migration numbers used, exact test commands + pass counts, deferrals). ALL checks green (re-query; `--watch` lies). STOP after the PR.

## Kickoff line (coordinator pastes into a fresh worker session)
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl9-p1-campaigns.md` and `_worker-common.md` beside it; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: <ASSIGN>. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens. Report back with the PR number and your build ledger.
