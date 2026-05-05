# VH Health Platform

Standalone monorepo for the VH Health hospital platform: backend API, admin
dashboard, patient app, staff app, and shared Dart package.

The old component repositories are archived. This repository is the source of
truth for code, documentation, releases, migrations, and operational runbooks.
Do not add new work to the archived repos.

## Applications

| Path | Stack | Role |
| --- | --- | --- |
| `apps/backend` | Node 22, Express 5, PostgreSQL 17, Prisma plus SQL migrations | REST API, auth, database access, jobs, realtime, Clinical AI |
| `apps/admin` | Next.js 15, React 19, TypeScript | Admin and super-admin dashboard |
| `apps/patient` | Flutter 3.41, Firebase OTP | Patient mobile app |
| `apps/staff` | Flutter 3.41, staff JWT | Staff and clinical mobile/desktop app |
| `packages/vhhealth_core` | Dart package | Shared API config, HTTP client, auth helpers, models, theme, utilities |

## Quick Start

Install the per-stack dependencies from the repo root:

```bash
cd apps/backend && npm ci
cd ../admin && npm ci
cd ../..
dart pub get
dart run melos bootstrap
```

Run the main local checks:

```bash
node scripts/local-ci.mjs --only=security,infra
node scripts/local-ci.mjs --only=admin
node scripts/local-ci.mjs --only=flutter
```

The full backend CI stage uses a disposable Docker Postgres/pgvector database:

```bash
node scripts/local-ci.mjs --only=backend
```

If Docker Desktop is stopped, the backend stage will fail at the Docker
preflight. Start Docker before running the full gate.

## Daily Commands

Backend:

```bash
cd apps/backend
npm run dev
npm run lint
npm run swagger:validate
npm test
```

Admin:

```bash
cd apps/admin
npm run dev
npm run lint
npm run type-check
npm test
npm run build
npm run check:clinical-ai-bundle
```

Flutter workspace:

```bash
dart run melos run format
dart run melos run analyze
dart run melos run test
dart run melos run i18n-health
```

## Release And CI

GitHub-hosted Actions are useful mirrors, but the canonical pre-merge and
pre-tag gate is local:

```bash
node scripts/local-ci.mjs
```

The gate runs secret scanning, backend lint/audit/swagger/DB/tests, admin
lint/type-check/test/build/bundle guard, Flutter format/analyze/test, and
Kubernetes manifest validation. See
[`docs/RELEASE_READINESS.md`](docs/RELEASE_READINESS.md) for the release gate.

Required release configuration:

| Name | Type | Used by |
| --- | --- | --- |
| `VH_BASE_URL` | GitHub variable / `--dart-define` | Patient and staff builds |
| `VH_API_KEY` | GitHub secret / `--dart-define` | Patient and staff builds |
| Patient Android signing secrets | GitHub secrets | Patient release workflow |
| Staff Android signing secrets | GitHub secrets | Staff release workflow |

Never commit real API keys, passwords, tokens, keystores, DSNs, or live test
credentials. Store them in the deployment secret store or in local ignored env
files.

## Health Checks

Backend monitors should use:

- `GET /health/live` for liveness. No database dependency.
- `GET /health/ready` for readiness. Checks database connectivity and the
  migration-106 readiness table.
- `GET /health/ping` and `GET /health/deep` remain available for legacy callers.

## Database

Schema is managed by Prisma migrations plus raw SQL migrations under
`apps/backend/src/migrations`.

Important DB docs:

- [`docs/DB_SCHEMA_GUARDRAILS.md`](docs/DB_SCHEMA_GUARDRAILS.md)
- [`apps/backend/docs/DB-REBUILD-GUIDE.md`](apps/backend/docs/DB-REBUILD-GUIDE.md)
- [`apps/backend/docs/DB-MIGRATION-MANIFEST.md`](apps/backend/docs/DB-MIGRATION-MANIFEST.md)
- [`apps/backend/docs/DB-SCHEMA-REFERENCE.md`](apps/backend/docs/DB-SCHEMA-REFERENCE.md)

Super admins can inspect the database through the admin dashboard at
`/dashboard/database`. It is read-only and redacts sensitive-looking values.

## Smoke Tests

These scripts assume the local backend/admin/Postgres services are already
running with matching test secrets:

```powershell
.\scripts\smoke-patient-routing.ps1
.\scripts\smoke-staff-routing.ps1
.\scripts\smoke-admin-crud.ps1
```

Smoke journey coverage is documented in
[`docs/SMOKE_E2E_JOURNEYS.md`](docs/SMOKE_E2E_JOURNEYS.md).

## Current Documentation

| Topic | Document |
| --- | --- |
| Architecture | [`docs/SYSTEM-ARCHITECTURE.md`](docs/SYSTEM-ARCHITECTURE.md) |
| Deployment | [`docs/DEPLOYMENT_GUIDE.md`](docs/DEPLOYMENT_GUIDE.md) |
| Release gate | [`docs/RELEASE_READINESS.md`](docs/RELEASE_READINESS.md) |
| Remediation tracker | [`docs/PLATFORM_REMEDIATION_PLAN.md`](docs/PLATFORM_REMEDIATION_PLAN.md) |
| DB guardrails | [`docs/DB_SCHEMA_GUARDRAILS.md`](docs/DB_SCHEMA_GUARDRAILS.md) |
| Translation review | [`docs/TRANSLATION_REVIEW_TRACKER.md`](docs/TRANSLATION_REVIEW_TRACKER.md) |
| Staff language state | [`apps/staff/docs/LANGUAGE_HEALTH.md`](apps/staff/docs/LANGUAGE_HEALTH.md) |
| Patient language state | [`apps/patient/docs/LANGUAGE_HEALTH.md`](apps/patient/docs/LANGUAGE_HEALTH.md) |
| Backend docs index | [`apps/backend/docs/README.md`](apps/backend/docs/README.md) |
| Agent/bootstrap notes | [`CLAUDE.md`](CLAUDE.md) and [`SESSION_HANDOFF.md`](SESSION_HANDOFF.md) |

Historical per-app roadmaps and scratch refactor plans have been removed to
avoid sending future work toward obsolete paths. Current priorities belong in
the remediation tracker, release readiness doc, app-specific health docs, or a
fresh issue/branch plan.
