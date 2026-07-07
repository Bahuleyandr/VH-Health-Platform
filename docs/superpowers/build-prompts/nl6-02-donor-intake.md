# BUILD: N6-2 — Blood bank donor cycle A: donors, screening, deferrals, collection

**Plan:** `docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md` §4.1 (BB-A) + §3 invariants. Read fully, plus `_worker-common.md`. Refine the mini-design from the plan's sketch before coding; keep it within this scope.
**★ OWNER GATE:** build ONLY if the playbook decision log resolves "blood CENTRE vs storage centre" to full blood centre. If storage-centre, this slice shrinks to a donor directory + camp coordination — re-scope with the coordinator first.

## Start gate
```
git fetch github
git grep -q "the missing donor cycle" github/main -- docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md
```

## Workspace
Worktree `VH-Health-Platform-nl6-2`, branch `feat/nl6-2-donor-intake`. Backend + admin.

## Scope (plan §4.1 BB-A)
~4 migrations (assigned block), all mig-356 RLS: `donors` (demographics + ABO/Rh + status lifecycle; EMPI-style dedupe at registration — the NL-4 front-desk pattern) · `donor_screenings` (questionnaire JSONB + verdict + auto-deferral rules) · `donor_deferrals` (reason codes, until-date, permanent flag, reactivation) · `donation_events` (camp/in-house, pre/post donor vitals, volume, adverse donor reactions) · donor consent via the mig-356 immutable-capture pattern (new `donor_consents` or a `subject_kind` generalization — mini-design call) · barcode on donation via the mig-354 scan pattern. Admin UI: donor registry + screening + deferral board.

**Invariant twist (plan §4.1):** donor events are donor-subject, NOT patient-subject — no `clinical_timeline_events`; use audit/register trails. Donors who are also patients stay separate subjects (adopted default, Decision 7). RBAC: `BLOOD_BANK_TECHNICIAN` + `canAccessBloodBank`; TTI approval roles come in N6-3.

## Tests
Unit: deferral rule engine. Deep: register donor → screen → auto-deferral path → reactivation; collection with adverse-reaction record; consent immutability; tenant isolation. Extend (don't fork) `transfusion-loop.deep.test.js` seed helpers where sharable.

## Deliverable
PR `N6-2: blood bank donor intake (donors, screening, deferrals, collection)` + ledger. Stop after PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl6-02-donor-intake.md` and `_worker-common.md`; execute EXACTLY (owner gate first). Your migration block: <ASSIGN>. STOP after the PR; report PR number + ledger.
