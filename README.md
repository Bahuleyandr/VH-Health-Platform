# VH Health Platform

Full-stack monorepo for the VH Health hospital platform.

## Applications

| Path                     | Purpose                                                                        |
| ------------------------ | ------------------------------------------------------------------------------ |
| `apps/backend`           | Node/Express API, Prisma, migrations, health/readiness, admin and patient APIs |
| `apps/admin`             | Next.js admin portal, including Clinical AI operations and governance          |
| `apps/patient`           | Flutter patient mobile app                                                     |
| `apps/staff`             | Flutter staff/clinical mobile app                                              |
| `packages/vhhealth_core` | Shared Dart config, clients, models, and services                              |

This repo was migrated from separate upstream projects. Prefer monorepo paths under
`apps/` and `packages/` whenever older docs mention standalone repositories.

## Quick Start

```bash
dart pub global activate melos
dart pub get
dart run melos bootstrap
dart run melos run analyze
dart run melos run test
```

Backend:

```bash
cd apps/backend
npm ci
npm run lint
npm run swagger:validate
npm test
```

Admin:

```bash
cd apps/admin
npm ci
npm run lint
npm run type-check
npm test
npm run build
npm run check:clinical-ai-bundle
```

## Health And Release Trust

Backend monitors should use:

- `GET /health/live` for liveness, with no database dependency.
- `GET /health/ready` for readiness, including DB connectivity and migration `106` table presence.
- Legacy `GET /health/ping` and `GET /health/deep` remain available.

CI and local release checks are tracked in
[`docs/PLATFORM_REMEDIATION_PLAN.md`](docs/PLATFORM_REMEDIATION_PLAN.md).
When GitHub-hosted minutes are unavailable, use the repo-local gate:

```bash
node scripts/local-ci.mjs
```

Smoke journey coverage is documented in
[`docs/SMOKE_E2E_JOURNEYS.md`](docs/SMOKE_E2E_JOURNEYS.md).

## Release Configuration

GitHub Actions release builds expect:

- Repository variable `VH_BASE_URL`.
- Repository secret `VH_API_KEY`.
- Patient Android signing secrets.
- Staff Android signing secrets.

Kubernetes backend deployment should keep `CLUSTER_WORKERS=2` unless a capacity
review changes that number.

## Useful Smoke Commands

```powershell
.\scripts\smoke-patient-routing.ps1
.\scripts\smoke-staff-routing.ps1
.\scripts\smoke-admin-crud.ps1
```

These assume local backend/admin/Postgres services are already running with the
same test secrets used by the scripts.

## Key Docs

- [`docs/DEPLOYMENT_GUIDE.md`](docs/DEPLOYMENT_GUIDE.md)
- [`apps/backend/docs/RELEASE_NOTES_2026-04.md`](apps/backend/docs/RELEASE_NOTES_2026-04.md)
- [`docs/FLUTTER_PLUGIN_MAJOR_MIGRATIONS.md`](docs/FLUTTER_PLUGIN_MAJOR_MIGRATIONS.md)
- [`CLAUDE.md`](CLAUDE.md)
