# CLAUDE.md — VH Health Platform (full-stack monorepo)

Single repo for every component of the VH Health healthcare platform:
Node/Express API, Next.js admin portal, two Flutter apps, and the
shared Dart package they all consume.

## Layout

| Path | Stack | Role |
|---|---|---|
| `apps/backend` | Node.js 22 + Express 5 + PostgreSQL 17 (Prisma, CNPG) | REST API consumed by every client |
| `apps/admin` | Next.js 16 + React 19 + TypeScript | Admin/super-admin web portal |
| `apps/patient` | Flutter 3.44.0 + Firebase OTP | Patient mobile app |
| `apps/staff` | Flutter 3.44.0 + staff JWT | Staff/clinical mobile app |
| `apps/device-gateway` | Node.js 26 + MLLP/HL7v2 | Held bedside-device ingress and durable recovery spool |
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

Historical source-repo names may still appear in merge-history notes. Current
work must use the monorepo paths above. Flutter packages resolve
`vhhealth_core` through the root Dart pub workspace; backend and admin call each
other over HTTP through the configured deployment URLs.

## Canonical clinical timeline invariant

VH Health now has a canonical clinical event layer. Future agents and humans
must not add new OP/IP clinical workflows that only write to their
feature-specific tables.

Read [`docs/CANONICAL_CLINICAL_TIMELINE.md`](docs/CANONICAL_CLINICAL_TIMELINE.md)
before changing OP Workspace, Patient Command Board, prescriptions,
investigations, referrals, vitals, I/O, MAR, discharge, bed/housekeeping, or
clinical audit flows.

Minimum rule: every successful patient-facing clinical write should persist the
detail row plus one `clinical_timeline_events` row and one
`clinical_audit_events` row in the same transaction. SLA-backed actions should
also create/update `workflow_sla_instances`; medication safety findings or
overrides should create `medication_safety_reviews`.

## Cross-stack workflows

### One-time per clone
```bash
# Global tooling (once per machine)
dart pub global activate melos 8.2.2
lefthook install                    # registers pre-commit/pre-push hooks

# Per-stack installs
cd apps/backend && npm install && cp .env.example .env     # fill secrets
cd ../admin    && npm install && cp .env.example .env.local
cd ../..
dart pub get                                               # Flutter workspace
melos bootstrap
```

After changing the pinned Flutter version, run `melos run clean` before the
next test run. Flutter otherwise can reuse `build/unit_test_assets` generated
by the previous SDK, including engine-versioned Material shaders.

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

`ci.yml` is the single protected, tiered gate. Feature-branch pushes run
security plus affected-stack checks and report `Merge Gate`. When the source
tree is final, create and push one no-source-change commit whose subject
contains `[full-ci]`; that push runs the full reusable matrix in parallel and
attaches both required contexts, `Merge Gate` and `Full Merge Gate`, to the
final pull-request head. Any later push invalidates both results and requires a
new `[full-ci]` commit. CI-plumbing changes also run the full matrix on push.
`all.yml` remains the scheduled/manual full sweep, and Smoke E2E runs nightly
rather than on every PR update.

GitHub merge queues are unavailable because this public repository is owned by
a personal account rather than an organization. The explicit final marker
commit is the fail-closed merge-boundary equivalent:

```bash
git commit --allow-empty -m "ci: run final canonical gate [full-ci]"
git push
```

The `workflow_dispatch` tiers remain diagnostic controls; a manual dispatch is
not the pull-request merge boundary.

Shared job definitions live under `.github/workflows/_reusable-*.yml` so
the path-filtered CI and the scheduled sweep stay in sync.

| Workflow | Fires when | What it runs |
|---|---|---|
| `all.yml` | `workflow_dispatch` + weekdays at 01:30 UTC | Flutter workspace + backend lint/swagger/prisma/tests + backend FHIR conformance + admin lint/type-check/jest/build |
| `ci.yml` | feature pushes + final `[full-ci]` marker push | affected checks on ordinary pushes; full backend shards, Flutter, Admin, FHIR, contracts, and infra in parallel once on the final marker commit; required aggregates `Merge Gate` + `Full Merge Gate` |
| `ci-flutter.yml` | manual diagnostic | `melos bootstrap → format → codegen → analyze → test`, plus a parallel `flutter build web` (dart2js) of staff |
| `ci-backend.yml` | backend CodeQL on PR/main; manual full diagnostic | CodeQL automatically; manual Semgrep, lint, Prisma/OpenAPI, DB, shards, and FHIR |
| `ci-admin.yml` | manual diagnostic | lint → type-check → jest → next build |
| `deploy-patient-staging.yml` | push to main touching patient | Firebase App Distribution |
| `deploy-staff-staging.yml` | push to main touching staff | Firebase App Distribution |
| `release-patient.yml` | tag `patient-v*` | signed APK + AAB → GitHub Release |
| `release-staff.yml` | tag `staff-v*` | signed APK + AAB → GitHub Release |

Backend + Admin run on a **3-node on-prem RKE2 Kubernetes cluster** inside the
hospital. Deploys are **GitOps via ArgoCD** — GitHub Actions builds, signs, and
pushes container images; ArgoCD watches this repo, but all four production
Applications require an explicit operator sync of the committed manifests, so
a merge remains inert. Postgres runs as a CloudNativePG-managed **PostgreSQL 17
cluster (3 replicas, HA)** in-cluster.
Ingress is **Cloudflare Tunnel → ingress-nginx → Service**, so the hospital
firewall has zero inbound ports open. See [`docs/DEPLOYMENT_GUIDE.md`](docs/DEPLOYMENT_GUIDE.md)
for the end-to-end runbook and [`docs/HARDWARE_REQUIREMENTS.md`](docs/HARDWARE_REQUIREMENTS.md)
for the procurement spec.

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
- `backend-v1.2.3` / `admin-v1.2.3` — semver-tagged container image releases
  (backend/admin image-build workflow pushes
  `ghcr.io/<owner>/vh-health-platform-backend:backend-v1.2.3` and
  `ghcr.io/<owner>/vh-health-platform-adminportal:admin-v1.2.3`, plus
  `latest-backend` / `latest-admin` stable tags). ArgoCD pins digests derived
  from these platform-owned packages in
  `infra/kubernetes/apps/kustomization.yaml` (written by
  `scripts/update-prod-digests.mjs`; the prod overlay deliberately excludes
  the app-tier Deployments).
- Manual `release-images.yml` dispatches can publish `main-<sha>` and
  `manual-<sha>` tags for staging-style verification. Plain pushes to `main`
  validate the workflow wiring but do not publish images.

## Deleted but worth knowing

- All per-app `.github/workflows/` files from the subtree sources are
  removed — GitHub Actions only reads from the root, they were inert.
- `apps/backend/node_modules/` was untracked 2026-04-18 (PR #45 in the
  old repo before the full-stack merge). Fresh clones must `npm install`.
- `melos.yaml` has been gone since the Melos 7 migration — scripts live
  under the `melos:` key in the root `pubspec.yaml`.
