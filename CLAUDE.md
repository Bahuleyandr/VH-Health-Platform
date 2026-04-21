# CLAUDE.md — VH Health Platform (full-stack monorepo)

Single repo for every component of the VH Health healthcare platform:
Node/Express API, Next.js admin portal, two Flutter apps, and the
shared Dart package they all consume.

## Layout

| Path | Stack | Role |
|---|---|---|
| `apps/backend` | Node.js 22 + Express 5 + PostgreSQL 15 (raw `pg`) | REST API consumed by every client |
| `apps/admin` | Next.js 15 + React 19 + TypeScript | Admin/super-admin web portal |
| `apps/patient` | Flutter 3.41 + Firebase OTP | Patient mobile app |
| `apps/staff` | Flutter 3.41 + staff JWT | Staff/clinical mobile app |
| `packages/vhhealth_core` | Dart shared package | API client, shared types, codegen target |

## History

Created 2026-04-18 from four separate repos via `git subtree add`.
Full pre-monorepo history preserved — `git log apps/backend/` and
friends walk every commit from the original repos.

```bash
# First three were merged 2026-04-18 (old monorepo migration):
packages/vhhealth_core   ← Bahuleyandr/vhhealth-core
apps/patient             ← Bahuleyandr/VH-health
apps/staff               ← Bahuleyandr/VHhealth-staff

# Backend + admin merged later same day (this commit):
apps/backend             ← Bahuleyandr/VH-health-backend
apps/admin               ← Bahuleyandr/VH-Health-Adminportal
```

All five source repos are archived on GitHub. Don't push to them.

## Per-app documentation

Each app keeps its own `CLAUDE.md` next to its manifest:

- [`apps/backend/CLAUDE.md`](apps/backend/CLAUDE.md) — API structure, auth, security, DB patterns
- [`apps/admin/CLAUDE.md`](apps/admin/CLAUDE.md) — Next.js routing, auth flow, god-page refactor pattern
- [`apps/patient/CLAUDE.md`](apps/patient/CLAUDE.md) — routes, Firebase OTP flow, status enums
- [`apps/staff/CLAUDE.md`](apps/staff/CLAUDE.md) — staff auth, test philosophy, role config
- [`packages/vhhealth_core/CLAUDE.md`](packages/vhhealth_core/CLAUDE.md) — shared contracts

Per-app CLAUDE.md files still reference the old separate-repo paths
(e.g. `../vhhealth-core`, `../vhhealth-backend`). The actual wiring
is correct — Flutter packages resolve `vhhealth_core` via the Dart pub
workspace; backend and admin call each other over HTTP the same way
they always did. Paths in the docs are historical clutter.

## Cross-stack workflows

### One-time per clone
```bash
# Global tooling (once per machine)
dart pub global activate melos 7.5.1
lefthook install                    # registers pre-commit/pre-push hooks

# Per-stack installs
cd apps/backend && npm install && cp .env.example .env     # fill secrets
cd ../admin    && npm install && cp .env.local.example .env.local
cd ../..
dart pub get                                               # Flutter workspace
melos bootstrap
```

### Daily commands

**Flutter** (patient + staff + core — one workspace):
```bash
melos run analyze
melos run test
melos run format-fix
melos run codegen
```

**Backend**:
```bash
cd apps/backend
npm run dev              # nodemon on :5000
npm test                 # Jest; needs Postgres on :5433
npm run lint             # eslint + lint:raw-params
```

**Admin**:
```bash
cd apps/admin
npm run dev              # Next.js on :3001
npm test                 # Jest
npm run build            # prod build
```

## Pub workspace invariant

The Flutter side is a Dart pub workspace (Melos 7 + Dart 3.6+). All
three Flutter packages share one `pubspec.lock` at the repo root.

- Sub-packages depend on `vhhealth_core` by **name**, not path:
  `vhhealth_core: any` — the workspace resolver finds it.
- Every dep resolves to a single version across all workspace members.
  Version conflicts (e.g. `firebase_core ^4` vs `^3`) fail
  `dart pub get`.
- Melos scripts live under the `melos:` key in the root `pubspec.yaml`.

Backend and admin are independent npm packages — no npm workspace (yet).
Each has its own `package-lock.json`. If cross-package sharing ever
becomes useful, revisit.

## CI (root `.github/workflows/`)

Mostly path-filtered so unrelated changes don't fan out; `all.yml` is the
scheduled/manual sweep that runs the whole stack together:

Shared job definitions live under `.github/workflows/_reusable-*.yml` so
the path-filtered CI and the scheduled sweep stay in sync.

| Workflow | Fires when | What it runs |
|---|---|---|
| `all.yml` | `workflow_dispatch` + weekdays at 01:30 UTC | Flutter workspace + backend lint/swagger/prisma/tests + backend FHIR conformance + admin lint/type-check/jest/build |
| `ci-flutter.yml` | `apps/{patient,staff}/**`, `packages/vhhealth_core/**`, `pubspec.*` | `melos bootstrap → analyze → test → format` |
| `ci-backend.yml` | `apps/backend/**` | lint → swagger → prisma → tests (with Postgres 16 service) + CodeQL + FHIR conformance |
| `ci-admin.yml` | `apps/admin/**` | lint → type-check → jest → next build |
| `deploy-patient-staging.yml` | push to main touching patient | Firebase App Distribution |
| `deploy-staff-staging.yml` | push to main touching staff | Firebase App Distribution |
| `release-patient.yml` | tag `patient-v*` | signed APK + AAB → GitHub Release |
| `release-staff.yml` | tag `staff-v*` | signed APK + AAB → GitHub Release |

Backend deploys to a Raspberry Pi 5 via `systemd`, not via GitHub Actions.
Manual `deploy/deploy.sh` + systemctl restart on the host.

## Local CI (run workflows without pushing)

Docker-in-WSL + `act` lets you run any workflow locally. Windows wrapper at
`D:\Dev\Tools\act\act.cmd` delegates into the Ubuntu-24.04 WSL distro where
docker + act actually live.

```bash
act -l                     # list workflows + jobs
act push                   # simulate push (fires path-filtered workflows)
act workflow_dispatch -W .github/workflows/all.yml --dryrun
act -j lint-and-test       # specific job by name
act --dryrun push          # preview only
```

## Tag convention

- `patient-v1.2.3` — patient app release (fires `release-patient.yml`)
- `staff-v1.2.3` — staff app release (fires `release-staff.yml`)
- Backend + admin don't use tags — ship from main via systemd and web-host deploy

## Deleted but worth knowing

- All per-app `.github/workflows/` files from the subtree sources are
  removed — GitHub Actions only reads from the root, they were inert.
- `apps/backend/node_modules/` was untracked 2026-04-18 (PR #45 in the
  old repo before the full-stack merge). Fresh clones must `npm install`.
- `melos.yaml` has been gone since the Melos 7 migration — scripts live
  under the `melos:` key in the root `pubspec.yaml`.
