# VH Health Platform — Session Handoff

_Last updated: 2026-05-02. Historical handoff snapshot. Verify current state
with `git status`, `git log -1`, and the root README before acting._

This doc is a single-page bootstrap for resuming work in another
session / environment. Read top-to-bottom, then jump to whichever
punch-list item you want to work on.

---

## Where we are

The platform is mid-rollout. The clinical surface is being driven
through real test deployments on the home tailnet (`dalekdefender`)
while the team irons out cross-role bugs, accessibility, and
internationalisation. **Hindi reached 100% structural coverage on
both Flutter apps in this run; Tamil/Telugu (and Malayalam on
patient) are queued for the dedicated translator pass.**

### Repo state on `main` (commit `24e3c974`)

| App | Stack | i18n | Notes |
|---|---|---|---|
| `apps/backend` | Node 22 + Express 5 + PG 17 + Prisma | English-only | Deployed live on dalekdefender k3s; admin portal at :8445 |
| `apps/admin` | Next.js 15 + React 19 | English-only | Untouched in this session |
| `apps/patient` | Flutter 3.41 + Firebase OTP | en/hi 100%, ta/te/ml 50.8% | ARB-based codegen, 5 locales supported |
| `apps/staff` | Flutter 3.41 + JWT + role config | en/hi 100%, ta/te 61% | Manual map (`lib/l10n/app_strings.dart`) |
| `packages/vhhealth_core` | Dart shared package | n/a | API client, theme tokens, crash-reporter abstraction |

### Live test deployment

- URL: `https://dalekdefender.hippocampus-monitor.ts.net:8444` (Tailnet only)
- Admin portal: `https://dalekdefender.hippocampus-monitor.ts.net:8445`
- API key: stored outside the repo in the local deployment secret file. Do not
  commit live keys to docs.
- Staff test users: `EMP-1001` through `EMP-1008`; password is stored outside
  the repo. Roles cover NURSING_STAFF, PHARMACY_STAFF, LAB_STAFF, DOCTOR,
  HR_STAFF, ADMIN, SUPER_ADMIN, GENERAL_STAFF.
- Admin login: seeded admin account; password is stored outside the repo.
- Redeploy recipe lives in `~/.claude/projects/.../memory/project_vh_health_dalekdefender.md`.

### Most recent staff `.exe`

`apps/staff/build/windows/x64/runner/Release/vhhealth_staff.exe` —
built 2026-05-02 at the end of this session with:

```
flutter build windows --release \
  --dart-define=VH_BASE_URL=https://dalekdefender.hippocampus-monitor.ts.net:8444/api/v1 \
  --dart-define=VH_API_KEY=<release-smoke-api-key>
```

Contains every change shipped in this session.

---

## What landed in this session

Long arc — 11 merged feature branches over the run, plus this
handoff doc. In priority order:

### 1. Cross-role backend bug sweep — 10 bugs surfaced by every staff role

Probe matrix of 8 roles × 28 endpoints surfaced:
- `/auth/staff/profile` 500 (controller called missing method)
- `/staff/hr/leave-balance/:id` UUID→NaN crash
- `/staff/hr/replacement/*` UUID-against-INT-FK crash + missing
  `replacement_requests` table (orphan schema, fixed in
  migration 142)
- `identityValidator` role-name drift (HR_STAFF / GENERAL_STAFF
  blocked from HR endpoints)
- `/appointments/list?date=today` 500 (Express 5 made `req.query`
  immutable, validator's customSanitizer couldn't write back; fixed
  at the service layer)
- `/staff/list` 500 (raw-Prisma param array passed as 1 arg)
- `/notifications/my` 400 (staff JWTs lack phone claim; added
  uid→phone fallback)
- SUPER_ADMIN profile lookup 404 (STAFF_ROLES enum missing)
- 2 Flutter path bugs (clinical-AI double-prefix, `/staff` →
  `/staff/list`)

### 2. UX upgrade run — 21 prioritised improvements

Logout button on every screen (29 screens swept), bed-sheet patient
quick-actions (Open EMR / Record Vitals / Add Note / Handover) with
context prefill on Vitals/Nursing Notes/Handover, search on
Appointments/Due Meds/Notifications/Leave, bed-board status filter
+ bed# search, long-press inline notes, persistent SuccessToast,
shared empty/error/loading state widgets, global patient picker
(Cmd+K), workload dashboard cards, realtime on Due Meds /
Appointments / Handover, skeleton loaders, bed admit/discharge/
transfer actions, recent-patients tile, two-pane desktop layouts,
voice-to-text on notes textareas, keyboard shortcut layer (Cmd+K /
Esc / Ctrl+/), first-run coach marks, print bed-board, telemetry
abstraction with 5 example sends, accessibility audit doc.

### 3. Accessibility — 10 audit-doc gaps closed + screen-reader test plan

Bed-card semantic labels, AppBar tooltips on 15 icon-only buttons,
toast `liveRegion: true`, quick-action chip semantics with
`ExcludeSemantics`, 48dp hit-target on PatientContextChip close,
voice dictation `SemanticsService.announce` + haptic, 71 form
prefix-icons wrapped in `ExcludeSemantics`, skeletons honour
`MediaQuery.disableAnimations`, status pills inherit theme text
scale, recent-patients list semantics. Plus `apps/staff/docs/
SCREEN_READER_TEST_PLAN.md` with 12 NVDA / TalkBack scenarios.

### 4. Colour contrast audit — 13 issues triaged, 3 palette fixes

`warningAmber` darkened (#F57F17 → #E65100, was 2.65:1, now 5.83:1
both ways). `_lightHint` darkened (was 2.59:1, now 4.32:1). New
adaptive `successOnSurface` / `errorOnSurface` / `warningOnSurface`
getters with dark-mode-safe variants. Reproducible via
`apps/staff/docs/_contrast_calc.mjs`.

### 5. i18n — full migration + Hindi at 100% on both apps

Staff app:
- ~947 keys × 4 locales (manual map at `apps/staff/lib/l10n/app_strings.dart`)
- 1576 English keys, **Hindi 100%**, Tamil/Telugu 61.3%
- 216 `// REVIEW:` flags on clinical-action / security / financial
  strings for translator validation

Patient app:
- ARB-based with `flutter gen-l10n` (5 locales: en/hi/ta/te/ml)
- 528 English keys, **Hindi 100%**, Tamil/Telugu/Malayalam 50.8%
- 210 hardcoded English strings migrated → 6 remaining (all
  intentional brand strings: "VH Health", "Venkataeswara Hospitals")

Tooling:
- `apps/staff/scripts/i18n-verify.mjs` — manual-map verifier
- `apps/patient/scripts/i18n-verify.mjs` — ARB verifier
- `melos run i18n-health` — runs both
- `melos run i18n-health-staff` / `i18n-health-patient` — individually

Documentation:
- `apps/staff/docs/ACCESSIBILITY_AUDIT.md`
- `apps/staff/docs/SCREEN_READER_TEST_PLAN.md`
- `apps/staff/docs/COLOR_CONTRAST_AUDIT.md`
- `apps/staff/docs/LANGUAGE_HEALTH.md`

### 6. Bed-board feature — patient details + notes flow

Backend: `GET /api/v1/beds/ward/:id` augmented with patient/admission
JOINs (patient_full_name / age / gender / phone / chief_complaint /
admitting_diagnosis / attending_doctor_name etc.). New `PATCH
/api/v1/beds/:id/notes` endpoint that doesn't null patient_id when
only notes are sent. Flutter: bed cards tappable, modal bottom
sheet with quick-action chips, notes textarea with PATCH save.

---

## Punch list — what's still queued

In priority order. Each item links to where to start.

### High-value, well-scoped

1. **Tamil + Telugu translator pass** on both apps. ~610 keys staff
   each, ~260 keys patient each. Verifiers list every missing key
   by name. Drop output into Lokalise / Crowdin / Google Translation
   Toolkit. Resume command: `melos run i18n-health` from repo root.

2. **Patient Malayalam translator pass.** Same gap as Tamil/Telugu.
   Verifier output is the worklist.

3. **Pilot-clinician validation of the 216 staff Hindi REVIEW
   flags** + ~250 patient Hindi REVIEW items. Hindi works at 100%
   structurally, but the high-stakes clinical / security / financial
   wording needs human validation before production rollout.

4. **Backend notification template localisation.** SMS / email /
   push templates in `apps/backend/src/services/notifications/` are
   still English-only. When a Hindi nurse gets a leave-approval SMS
   in English, the language work feels half-done.

5. **Run the screen-reader test plan** (`apps/staff/docs/
   SCREEN_READER_TEST_PLAN.md`) — 12 NVDA / TalkBack scenarios,
   ~90 minutes. Tells us whether the a11y fixes work in practice.

6. **Cut a real release.** `staff-v1.2.0` and `patient-v1.2.0` tags.
   The signed-release workflows haven't been exercised against the
   real `VH_API_KEY` / signing secrets in months.

### Medium-value, defined scope

7. **Admin portal i18n.** Next.js — needs `next-intl` or similar.
   ~50 screens. Lower priority since most admin users are bilingual.
8. **Crash reporter wiring validation.** `FirebaseCrashReporter` is
   registered but Crashlytics events haven't been validated to
   actually arrive — controlled test crash + dashboard verification.
9. **Sentry on backend.** DSN env var exists but I haven't confirmed
   events flow.
10. **Fill remaining a11y gaps** — high-contrast theme variant,
    legacy `primaryBlue`-on-darkCard sweep, focus-order audit on
    long forms.

### Smaller / housekeeping

11. **Prune the 135 unused getters** in staff `app_strings.dart`
    (~9% of declared accessors; speculatively-added during batch 4).

---

## How to resume in another session

### Cold-start commands

```bash
# Repo
git clone https://github.com/Bahuleyandr/VH-Health-Platform.git
cd VH-Health-Platform

# Tooling (per-machine, once)
dart pub global activate melos 7.5.1
lefthook install

# Per-stack installs
cd apps/backend && npm install && cp .env.example .env  # fill secrets
cd ../admin    && npm install && cp .env.local.example .env.local
cd ../..
dart pub get && melos bootstrap

# Verify i18n state
melos run i18n-health

# Lint
melos run analyze
```

### To continue any specific punch-list item

1. Read this doc + the relevant `apps/<app>/docs/` audit doc.
2. Run the verifier (`melos run i18n-health` / lint / test).
3. Pick a coherent batch (one screen / one feature / one locale).
4. Branch off `main`: `git checkout -b feat/<slug>`.
5. Ship + lint + commit + PR-merge into `main`.

### Where the live deployment is

- `dalekdefender.hippocampus-monitor.ts.net` (home tailnet, k3s).
- Backend on :8444, admin on :8445, Khata sibling on :8443.
- SSH access: `ssh dalekdefender` (Tailscale).
- Redeploy recipe in user-memory `project_vh_health_dalekdefender.md`.

### Key files for orientation

| Topic | Path |
|---|---|
| Cross-stack overview | `CLAUDE.md` (root) |
| Backend conventions | `apps/backend/CLAUDE.md` |
| Staff app structure | `apps/staff/CLAUDE.md` |
| Patient app structure | `apps/patient/CLAUDE.md` |
| i18n state | `apps/staff/docs/LANGUAGE_HEALTH.md` |
| A11y audit | `apps/staff/docs/ACCESSIBILITY_AUDIT.md` |
| SR test plan | `apps/staff/docs/SCREEN_READER_TEST_PLAN.md` |
| Contrast audit | `apps/staff/docs/COLOR_CONTRAST_AUDIT.md` |
| Test users + creds | `~/.claude/projects/.../memory/project_vh_health_dalekdefender.md` |

---

## Branch state (as of 2026-05-02)

- **Local: `main` only.**
- **Remote: `main` only.** All 14 historical branches were
  triaged and pruned in the closing minutes of this session:
    - 13 `feat/*` branches (b1–b4, c1, c3, c4, d1–d4, tier-b
      surgical schema/ai-modules) had been **fully merged into
      `main` already** (HEAD commits ancestor of `main` per
      `git merge-base --is-ancestor`). 0 commits ahead, 110–134
      behind. Safe to delete; no work lost.
    - 1 `chore/error-scan-2026-05-01` branch had **4 unique commits**
      but was 52 behind `main` — merging would have reverted this
      session's work. Solution: cherry-picked those 4 commits onto
      `main` (gitleaks TOTP allowlist, gitleaks kubeseal allowlist,
      sealed-secret placeholder standardisation, weekly scan
      `REPORT.md`), then deleted the branch.

## Recent commits on `main`

```
3efd9059 fix: allowlist RFC 4226/6238 TOTP test vector in gitleaks    ← cherry-pick
5ec6e046 fix: allowlist legacy REPLACE_WITH_KUBESEAL_OUTPUT placeholder ← cherry-pick
5b43c28b fix: standardise sealed-secret placeholder to allowlisted string ← cherry-pick
cc3c147c chore: weekly error scan — 5 patterns flagged                 ← cherry-pick
9c84045f Docs: refresh SESSION_HANDOFF.md with current main-branch state + punch list
24e3c974 Merge feat/hindi-100pct-patient-i18n: staff Hindi 100% + patient app i18n parity
a297ed37 Merge feat/i18n-health-verify: i18n verification script + report + final hardcoded sweep
223d2dc2 Merge feat/i18n-migration-finish: full staff-app i18n coverage
5b384f27 Merge feat/i18n-migration-contrast: contrast audit + Hindi review + 23-screen i18n migration
ef5d94e7 Merge feat/a11y-i18n-sr-plan: 10 a11y fixes + i18n expansion + SR test plan
6b22f8ae Merge feat/voice-print-i18n-telemetry: voice dictation + PDF print + telemetry + i18n + a11y audit
2aa291f4 Merge feat/role-sweep-2026-05-02: 10 cross-role bug fixes
022b7a85 Merge feat/logout-everywhere-bed-notes: universal logout button + bed-board patient details + notes flow
```

Pick any task, branch off `main`, and continue.
