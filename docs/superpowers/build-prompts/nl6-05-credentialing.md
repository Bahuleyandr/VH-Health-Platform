# BUILD: N6-5 — Credentialing & privileging completion

**Plan:** `docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md` §4.4. Read fully, plus `_worker-common.md`. Foundation shipped in mig 287 (`staff_credentials` + `hasActivePrivilege` + one live consumer: chemo). This slice must land BEFORE any other slice adds a second privilege consumer (plan §5.4 — free-text privilege names would proliferate).

## Start gate
```
git fetch github
git grep -q "Credentialing & privileging" github/main -- docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md
```

## Workspace
Worktree `VH-Health-Platform-nl6-5`, branch `feat/nl6-5-credentialing`. Backend + admin.

## Scope (plan §4.4)
~3 migrations: `privilege_catalog` (name, description, required credential types, review cadence; FK from privilege-type `staff_credentials` rows; seed list per playbook adopted defaults: chemo_administration [exists], primary_surgeon, anesthesia_finalize, endoscopy, icu_attending, radiology_subspecialty_*) · grant workflow riding the EXISTING generic `approvals` table (request → department-head/leadership approve → active) · renewal fields + persistent `credential_expiry_alerts` (acknowledgeable — the pharmacy expiry-alert pattern) + per-staff notification · credential document upload copying the consent-signature validated R2 path (document_ref is a bare string today). **Enforcement wiring behind per-gate env flags** (the chemo `REQUIRE_ADMIN_PRIVILEGE()` pattern — ship inert): theatre booking/OT-ready surgeon check, anesthesia-record finalize (ANESTHETIST privilege), optional controlled-substance e-Rx check. Admin UI: staff-profile credentials tab + expiry board + privilege catalog editor. SCIM stays identity-only — credentials remain a local clinical-governance record.

Staff-subject data: no patient timeline events; audit via the existing audit-log pattern.

## Tests
Unit: catalog validation, expiry/renewal math, gate verdicts. Deep: grant → approve → enforce-at-theatre flow (flag on); revoke → gate blocks; **flag-off → zero behavior change (inertness proof)**; `chemo-loop.deep.test.js` keeps passing untouched.

## Deliverable
PR `N6-5: credentialing & privileging (catalog, approvals, enforcement seams)` + ledger. Stop after PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl6-05-credentialing.md` and `_worker-common.md`; execute EXACTLY. Your migration block: <ASSIGN>. STOP after the PR; report PR number + ledger.
