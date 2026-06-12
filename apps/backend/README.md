# VH Health Backend

Node/Express API for the VH Health platform. It owns authentication, RBAC,
patient/staff/admin APIs, database migrations, background jobs, realtime events,
Clinical AI routes, and operational health endpoints.

## Runtime

| Area | Current choice |
| --- | --- |
| Runtime | Node 22 |
| HTTP | Express 5 |
| Database | PostgreSQL 17 in production, pgvector required for local full CI |
| ORM/querying | Prisma for modeled tables plus raw SQL for extended hospital tables |
| Auth | API key, JWT, Firebase OTP, staff credentials, admin cookie proxy |
| Docs | Swagger/OpenAPI under `src/docs/` |

## Local Setup

```bash
cd apps/backend
npm ci
cp .env.example .env
```

Fill `.env` with local-only values. Do not commit real secrets.

Useful commands:

```bash
npm run dev
npm run lint
npm run swagger:validate
npm test
```

The full backend gate is Docker-backed:

```bash
npm run ci
```

It runs linting, secret scanning, audits, Swagger validation, Spectral, schema
guardrails, seed checks, and Jest against a disposable pgvector database.

## Health Endpoints

Use these outside the `/api/v1` prefix:

| Endpoint | Purpose |
| --- | --- |
| `GET /health/live` | Liveness. No DB dependency. |
| `GET /health/ready` | Readiness. Checks DB connectivity and migration readiness. |
| `GET /health/ping` | Legacy lightweight ping. |
| `GET /health/deep` | Legacy deep check. |

## Database

The backend has two schema sources:

- Prisma migrations under `apps/backend/prisma/migrations`.
- Raw SQL migrations under `apps/backend/src/migrations`.

Recommended local DB validation:

```bash
npm run ci:db-guardrails:docker
```

See the current DB guardrail doc:
[`../../docs/DB_SCHEMA_GUARDRAILS.md`](../../docs/DB_SCHEMA_GUARDRAILS.md).

## Documentation

| Topic | Document |
| --- | --- |
| Backend conventions | [`CLAUDE.md`](CLAUDE.md) |
| Backend docs index | [`docs/README.md`](docs/README.md) |
| API reference | [`src/docs/swagger.yaml`](src/docs/swagger.yaml), validated by `npm run swagger:validate` |
| DB schema guardrails | [`../../docs/DB_SCHEMA_GUARDRAILS.md`](../../docs/DB_SCHEMA_GUARDRAILS.md) |
| DB cutover plan | [`docs/DB-MIGRATION-PLAN.md`](docs/DB-MIGRATION-PLAN.md) |
| Disaster recovery | [`docs/DISASTER-RECOVERY.md`](docs/DISASTER-RECOVERY.md) |
| Runbooks | [`docs/RUNBOOKS/README.md`](docs/RUNBOOKS/README.md) |
| Release gate | [`../../docs/RELEASE_READINESS.md`](../../docs/RELEASE_READINESS.md) |

Old standalone-repo roadmaps were removed. Current backend priorities should be
tracked in the root remediation/release docs or in a focused issue/branch plan.
