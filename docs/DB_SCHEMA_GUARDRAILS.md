# Database Schema Guardrails

This repo now has three layers that should catch schema drift before it breaks
the patient, staff, admin, or backend runtime paths.

## Local Checks

Run from `apps/backend`.

```powershell
# Reset/sync the disposable local test database.
$env:DATABASE_URL=''
$env:TEST_DATABASE_URL=''
npm run test:db:setup

# Verify critical route/table/column contracts.
$env:DATABASE_URL='postgresql://postgres@127.0.0.1:55432/vhhealth_test'
npm run db:contracts

# Seed full QA data and require every public app table to be non-empty.
npm run seed:test-data
npm run db:contracts:seeded

# Verify prisma/schema.prisma still matches the migrated database.
npm run check:schema-drift

# Or run the same contract/drift bundle used by smoke CI.
npm run ci:db-guardrails
```

If a developer has `apps/backend/.env` pointing to another database, keep the
first two variables blank for `test:db:setup`. The bootstrap intentionally uses
`127.0.0.1:55432/vhhealth_test` when those variables are absent.

The Prisma schema includes a pgvector-backed `Unsupported("vector")` column.
Local Postgres must provide the `vector` extension before `prisma db push` can
create that table. `npm run test:db:setup` checks this before resetting the
schema. If local Postgres does not have pgvector, use the Docker-backed
guardrail runner. It starts a disposable `pgvector/pgvector:pg16` container on a
free local port, applies Prisma + raw SQL migrations, seeds comprehensive QA
data, runs the contract checks, then removes the container:

```powershell
cd apps/backend
npm run ci:db-guardrails:docker
```

For manual inspection, you can keep the disposable database running:

```powershell
$env:VH_KEEP_DOCKER_TEST_DB='true'
npm run ci:db-guardrails:docker
```

The older fully manual equivalent is:

```powershell
docker run --rm -p 55433:5432 `
  -e POSTGRES_USER=postgres `
  -e POSTGRES_PASSWORD=postgres `
  -e POSTGRES_DB=vhhealth_test `
  pgvector/pgvector:pg16

$env:PGPASSWORD='postgres'
$env:DATABASE_URL="postgresql://postgres:$($env:PGPASSWORD)@127.0.0.1:55433/vhhealth_test"
$env:VH_ALLOW_NON_TEST_DATA_SEED='true'
cd apps/backend
npm run db:ensure-pgvector
npx prisma db push --skip-generate --accept-data-loss
node scripts/check-schema-drift.mjs
node scripts/ci-setup-db.mjs
npm run ci:db-guardrails
```

## CI Checks

The backend reusable workflow uses the `pgvector/pgvector:pg16` service image
and now runs:

- `npm run db:ensure-pgvector`
- Prisma `db push`
- `node scripts/check-schema-drift.mjs` before raw migrations add unmanaged tables
- raw SQL migrations
- `npm run db:contracts`
- `npm run seed:test-data`
- `npm run db:contracts:seeded`
- route-critical schema drift checks
- backend tests

`db:contracts` protects critical backend routes from missing tables/columns.
`db:contracts:seeded` catches seed gaps and fixture rot by requiring all public
application tables to have at least one row after the comprehensive seed.
The table drift check intentionally distinguishes route-critical missing tables
from additional managed tables created by raw migrations; additional tables are
not a failure because seeded-table coverage checks them separately.

The `Smoke E2E` workflow runs the same `npm run ci:db-guardrails` bundle before
starting backend/admin smoke tests. This catches table/column drift before the
UI route crawler and Flutter API smoke scripts start making requests.

For production hosting and restore-readiness checks, use
`docs/PRODUCTION_DB_HARDENING.md`. Schema correctness is necessary but not
enough; a production database also needs backup evidence, restore evidence,
role verification, network policy, and monitoring alerts.

## Admin Viewer

Super admins can inspect the database from:

```text
/dashboard/database
```

The page uses read-only backend routes under:

```text
/api/v1/admin/database
```

It shows table inventory, schema-contract status, column metadata, primary keys,
row counts, and a small row preview. Sensitive-looking values such as passwords,
tokens, secrets, API keys, encrypted fields, hashes, backup codes, and TOTP data
are redacted in previews. It is deliberately not a SQL console.
