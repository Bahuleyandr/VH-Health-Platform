# BUILD: N6-7 — Ophthalmology completion (linkage, biometry, cataract bundle, UI)

**Plan:** `docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md` §4.8. Read fully, plus `_worker-common.md`. Backend exams shipped (mig 293) + theatre eye-fields exist (site-mark laterality gate, eye-drops schedule, DAYCARE_OPHTHALMOLOGY_V1 template). Optical dispensing is OUT (adopted default). The mig-230 template's placeholder clinical text is an OWNER/clinician action — do not invent clinical content.

## Start gate
```
git fetch github
git grep -q "ophthalmology_exams" github/main -- apps/backend/src/migrations
```

## Workspace
Worktree `VH-Health-Platform-nl6-7`, branch `feat/nl6-7-ophthalmology`. Backend + staff app (`dart pub get`; i18n all 5 arb files).

## Scope (plan §4.8)
~2–3 migrations: link `ophthalmic_exams` to encounters/appointments (nullable FK, no backfill) · eye-test catalog seeds (biometry, keratometry, visual fields, OCT as orderable investigations) · `ophthalmic_biometry` (K-readings, axial length, IOL power/formula/selection — recorded-not-computed in v1) · cataract pre-op bundle as an order-set instance + theatre-booking readiness check (biometry present before OT-ready for cataract-coded procedures — **soft warn first**, never hard-gate in this slice) · ophthalmic imaging attachments via the validated R2 upload pattern keyed to exams · spectacles Rx print (pdfkit) from `final_glasses` rows · staff-app ophtho exam screen (per-eye entry) + patient history view.

IOP >21 mmHg alert already emits a distinct canonical subtype — new writes follow that precedent.

## Tests
Extend mig-293 exam deep tests: encounter linkage, IOP-alert regression, biometry record, cataract readiness warn (present vs absent). Widget tests for per-eye entry mapping. Journey candidate: cataract day-care variant asserting site-mark laterality + eye-drops schedule + discharge template — extend `surgical-day-care.journey.test.js` patterns (keep the journey set lean; only add if wall-clock stays acceptable).

## Deliverable
PR `N6-7: ophthalmology completion (linkage, biometry, cataract bundle, staff UI)` + ledger. Stop after PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl6-07-ophthalmology.md` and `_worker-common.md`; execute EXACTLY. Your migration block: <ASSIGN>. STOP after the PR; report PR number + ledger.
