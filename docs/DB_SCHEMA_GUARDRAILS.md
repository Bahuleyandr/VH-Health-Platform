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
```

If a developer has `apps/backend/.env` pointing to another database, keep the
first two variables blank for `test:db:setup`. The bootstrap intentionally uses
`127.0.0.1:55432/vhhealth_test` when those variables are absent.

## CI Checks

The backend reusable workflow now runs:

- raw SQL migrations
- `npm run db:contracts`
- `npm run seed:test-data`
- `npm run db:contracts:seeded`
- schema drift checks
- backend tests

`db:contracts` protects critical backend routes from missing tables/columns.
`db:contracts:seeded` catches seed gaps and fixture rot by requiring all public
application tables to have at least one row after the comprehensive seed.

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
