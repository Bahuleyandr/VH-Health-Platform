<p align="center">
  <img src="apps/patient/assets/images/logo.png" alt="Venkataeswara Hospitals logo" width="320" />
</p>

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
| `apps/admin` | Next.js 16, React 19, TypeScript | Admin and super-admin dashboard |
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

Forgejo Actions are the canonical hosted CI/CD surface. GitHub-hosted Actions
are kept as mirrors, and the same repo-owned checks can be run locally:

```bash
node scripts/local-ci.mjs
```

The gate runs secret scanning, backend lint/audit/swagger/DB/tests, admin
lint/type-check/test/build/bundle guard, Flutter format/analyze/test,
Kubernetes manifest validation, and the Forgejo specialty gates cover smoke
E2E, dependency-risk review, container supply chain, and warehouse/dbt drift. See
[`docs/RELEASE_READINESS.md`](docs/RELEASE_READINESS.md) for the release gate.

Forgejo also owns staging deploys, signed Android release assets, container
image releases, production digest pinning, and the Dalekdefender test-rig
deploy path. Required release configuration:

| Name | Type | Used by |
| --- | --- | --- |
| `VH_BASE_URL` | Forgejo variable / `--dart-define` | Patient and staff builds |
| `VH_API_KEY` | Forgejo secret / `--dart-define` | Patient and staff builds |
| Patient Android signing secrets | Forgejo secrets | Patient release workflow |
| Staff Android signing secrets | Forgejo secrets | Staff release workflow |
| `FIREBASE_APP_ID_PATIENT`, `FIREBASE_APP_ID_STAFF`, `FIREBASE_TOKEN` | Forgejo secrets | Staging Firebase App Distribution |
| `GHCR_USERNAME`/`GHCR_TOKEN` or `CONTAINER_REGISTRY_USERNAME`/`CONTAINER_REGISTRY_PASSWORD` | Forgejo secrets | Container release and Dalekdefender image pushes |
| `COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD`, `COSIGN_PUBLIC_KEY` | Forgejo secrets | Container signing and deploy verification |
| `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, `DALEKDEFENDER_SSH_KEY` | Forgejo secrets | Dalekdefender deploy |
| `VH_TRIAL_API_ORIGIN`, `VH_TRIAL_ADMIN_ORIGIN` | Forgejo secrets | Hosted post-deploy smoke |

Forgejo deploy/release prerequisites are enforced by:

```bash
node scripts/ci/forgejo-deploy-preflight.mjs --mode dalek-images
node scripts/ci/forgejo-deploy-preflight.mjs --mode dalek-deploy
node scripts/ci/forgejo-deploy-preflight.mjs --mode release-images
node scripts/ci/forgejo-deploy-preflight.mjs --mode post-deploy-smoke --allow-skip
```

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
- [`docs/PRODUCTION_DB_HARDENING.md`](docs/PRODUCTION_DB_HARDENING.md)
- [`apps/backend/docs/DB-MIGRATION-PLAN.md`](apps/backend/docs/DB-MIGRATION-PLAN.md)
- [`apps/backend/docs/RUNBOOKS/db-restore.md`](apps/backend/docs/RUNBOOKS/db-restore.md)
- [`docs/CANONICAL_CLINICAL_TIMELINE.md`](docs/CANONICAL_CLINICAL_TIMELINE.md)
- [`apps/backend/docs/DB-SCHEMA-REFERENCE.md`](apps/backend/docs/DB-SCHEMA-REFERENCE.md)

Super admins can inspect the database through the admin dashboard at
`/dashboard/database`. It is read-only and redacts sensitive-looking values.

## Production Data Hosting Status

Current local and Dalekdefender deployments are suitable for development,
staging, demos, and internal smoke testing with fake or de-identified data. Do
not store real patient PHI/PII in this platform until the production data
hosting checklist below is complete and reviewed.

For production patient data, prefer a managed PostgreSQL service in a private
network, such as AWS RDS/Aurora, GCP Cloud SQL, Azure Database for PostgreSQL,
or an equivalently operated private Postgres cluster. The database must not have
a public IP or direct internet exposure.

Minimum production controls:

- Private database networking only; allow traffic only from the backend,
  migration job, backup job, and explicitly approved read-only DB browser.
- Kubernetes `NetworkPolicy` or cloud firewall rules that deny namespace-wide
  lateral access by default.
- Encryption at rest backed by KMS or a managed cloud key service.
- TLS enforced for all database connections.
- Separate database users for app runtime, migrations, read-only reporting,
  backups, and emergency administration.
- Secrets stored in a managed secret store or encrypted Kubernetes secret
  backend, with documented rotation.
- Automated backups with point-in-time recovery and scheduled restore tests.
- Documented RPO/RTO targets and an operator runbook for restore, failover, and
  incident response.
- Audit logging for privileged access, schema changes, and sensitive data reads.
- A PHI/PII logging audit that prevents patient data from leaking into app,
  job, proxy, or database logs.
- DB browser access restricted to VPN/Tailscale or equivalent private access,
  MFA-protected accounts, read-only roles by default, and full access logging.
- Separate development, staging, and production databases. Real patient data
  must never be copied into dev or local environments without a formal
  de-identification process.

Regulatory review is still required before production use. At minimum, assess
the deployment against the HIPAA Security Rule if handling US ePHI, the India
Digital Personal Data Protection Act, 2023 for Indian patient data, and the
hospital's own retention, consent, access-control, and breach-response policies.

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
| Canonical clinical timeline | [`docs/CANONICAL_CLINICAL_TIMELINE.md`](docs/CANONICAL_CLINICAL_TIMELINE.md) |
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
