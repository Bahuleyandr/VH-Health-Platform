# BUILD: N6-1 — Radiology structured reporting + peer review + TAT (+ canonical-timeline fix)
n> **STATUS: LAUNCHED 2026-07-07** (migration block assigned; see playbook §5). Kept for the record and for relaunch-on-failure.

You are implementing **slice N6-1** of NL-6 for the VH Health Platform. The approved plan is on `github/main`: `docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md` — read **§3 (invariants), §4.3 (radiology), §5 (defects 1–2), §6 (N6-1 row)**. Also read `docs/CANONICAL_CLINICAL_TIMELINE.md` and `apps/backend/CLAUDE.md`.

## Start gate (run before anything)
```
git fetch github
git grep -q "NL-6 Departmental Completion" github/main -- docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md
```
Exit 0 → proceed. Exit 1 → STOP and report.

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl6-1"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl6-1-radiology-reporting github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install && npm --prefix apps/admin install
dart pub get   # Flutter workspace (Dart client regen via melos codegen)
```
All work happens inside `$WT`. Push with `git push github feat/nl6-1-radiology-reporting`; open the PR against `main` on `Bahuleyandr/VH-Health-Platform` with `gh`. Backend tests need the dev Postgres on `:5433` — start it per `apps/backend/CLAUDE.md` if down. Admin type-check is `npm run type-check` inside `apps/admin` (NOT raw `npx tsc`).

## Environment & isolation (MANDATORY)
- NEVER work in, commit in, or switch branches of `D:\Dev\Projects\VH Health\VH-Health-Platform` itself (shared checkout — contamination incident history). Your worktree is your world.
- Backend gate: `node apps/backend/scripts/run-ci-jest.mjs`. Route changes ⇒ `openapi:generate` + `openapi:check`, commit `openapi.json`; staff worklist consumes this API ⇒ `melos codegen` regenerates the Dart client — commit generated files; staff-app strings through all 5 `intl_*.arb`.
- Migrations: after applying, `npx prisma db pull`, commit `schema.prisma` with the `.sql`.
- **Your reserved migration numbers: 375–377** (use in order). 368 = SAML; 369–370 = NL-5 worker; 371–374 = NL-7 worker.
- New PHI tables: mig-356 RLS boilerplate; service writes via `setTenantTx` with explicit `tenant_id`.

## Scope (deliver all — plan §4.3)
1. **Report templates** (mig **375**): `radiology_report_templates` — per modality/body-part, ordered sections, optional coded fields as a JSONB schema. Template-driven submit populates a new `structured_report` JSONB on `radiology_orders` (mig **376**) **while still rendering the concatenated text into the existing `report` column** — every existing consumer (portal, PDFs, dashboards) stays byte-compatible. The current fold behavior lives at `radiologyService.js:400–406`; supersede it, don't patch it.
2. **Peer review** (same mig **376**): `radiology_peer_reviews` — report id, **reviewer ≠ author enforced server-side** (the transfusion different-human pattern, `transfusionSafetyService.js:238–368`), **generic 1–4 discrepancy scale** (owner default — RADPEER is ACR-licensed, do not reference it), comments, outcome → optional addendum; random-sampling picker over signed reports (**default 2%, per-tenant configurable**); read-only board tab. **Peer review must NOT weaken the signer gate**: reviews are post-sign-off artifacts; only addenda (already `RADIOLOGY_REPORT_SIGN_ROLES = [RADIOLOGIST]`-gated, no ADMIN override) mutate report content.
3. **TAT metrics** (mig **377**): computed view over the status timestamps (ordered→acquired→reported→signed) + threshold alerting via the existing alert fabric; surface on the existing radiology dashboard.
4. **★ Fix-in-slice (confirmed platform defect)**: radiology emits **zero** canonical timeline events today, violating `docs/CANONICAL_CLINICAL_TIMELINE.md`. Emit canonical events for order / acquire / report-submit / sign-off / addendum via `canonicalClinicalPlatformService` (copy the dental/ophtho service shapes; detail row + `clinical_timeline_events` + `clinical_audit_events` in the same transaction).
5. Dictation wiring is **optional stretch** — defer unless trivially cheap.

## Tests
Extend the existing radiology deep tests: template-driven submit renders an identical text blob (back-compat assertion); peer-review same-author rejection; sampling determinism (seeded); TAT computation unit tests; **canonical event emission assertions** for every lifecycle step (this is the defect regression); signer-gate regression (non-RADIOLOGIST still cannot sign/addend). tz-safe seeds (`hospitalToday` pattern).

## Deliverable
Branch `feat/nl6-1-radiology-reporting`, PR titled `N6-1: radiology structured reporting + peer review + TAT`. PR body = build ledger (scope, invariants held — especially back-compat + signer gate + canonical events, migs used 375–377, exact test commands + pass counts, deferred items). ALL checks green (re-query `gh pr checks`; `--watch` lies). **STOP after the PR** — coordinator verifies and merges.
