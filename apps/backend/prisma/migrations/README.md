# Database migration workflow

This directory is historical residue. It is not the VH Health migration source
and must not receive new migrations.

The authoritative migration chain is the ordered raw SQL under
`apps/backend/src/migrations/`. Both the boot-time runner and the CI database
setup consult the `_migrations` tracker and apply each unrecorded SQL file once.
The checked-in `prisma/schema.prisma` is an introspected client model of that
database, not a DDL authoring source.

## Adding a schema change

1. Add the next reserved `NNN_description.sql` file under `src/migrations/`.
2. Apply the complete raw-SQL chain to a disposable QA database with
   `scripts/ci-setup-db.mjs`.
3. Run `prisma db pull --schema=prisma/schema.prisma` so the Prisma model matches
   the migrated database.
4. Run `npm run db:generate`, `npm run check:schema-drift`, the focused database
   contracts, and a fresh migration rehearsal.
5. Commit the raw SQL and regenerated Prisma schema together.

Never edit an applied raw migration. Add a later migration that converges every
supported lineage instead.

## Production ownership

Argo CD's backend migration Job is the sole production writer. It runs as an
Argo CD `PreSync` hook before backend workloads become ready. Application
workers keep migration execution disabled and verify the `_migrations` tip at
startup; they do not run `prisma migrate deploy`.

The `db:migrate*` package scripts remain compatibility utilities for the
historical Prisma directory only. They are not part of CI, startup, or the
production deployment path.
