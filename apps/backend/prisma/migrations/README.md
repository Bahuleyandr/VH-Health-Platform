# Prisma Migration Workflow

This directory contains Prisma database migrations for the VH Health backend.

## Overview

Prisma Migrate tracks changes to `prisma/schema.prisma` and generates SQL migration files that evolve the database schema over time. Each migration is stored as a timestamped directory containing a `migration.sql` file.

> **Note**: The current codebase uses raw `pg` queries for all database access. The Prisma schema serves as documentation and as the source of truth for migration generation.

## Commands

| Command | Description |
|---|---|
| `npm run db:migrate:dev` | Create and apply a new migration during development |
| `npm run db:migrate` | Apply pending migrations (production/CI) |
| `npm run db:migrate:status` | Check which migrations have been applied |
| `npm run db:migrate:reset` | Reset the database and re-apply all migrations (destructive) |
| `npm run db:generate` | Regenerate the Prisma Client after schema changes |
| `npm run db:studio` | Open Prisma Studio GUI to browse data |

## Development Workflow

1. **Edit the schema**: Make changes to `prisma/schema.prisma`.
2. **Create a migration**: Run `npm run db:migrate:dev` and provide a descriptive name (e.g., `add_appointment_notes_column`).
3. **Review the generated SQL**: Check the new migration file in `prisma/migrations/<timestamp>_<name>/migration.sql` to verify correctness.
4. **Commit**: Add both the schema changes and the migration directory to version control.

## Production Deployment

Run `npm run db:migrate` in your deployment pipeline. This applies any pending migrations that have not yet been run against the target database. It will never generate new migrations -- only apply existing ones.

## Important Notes

- **Never edit a migration that has already been applied** to any environment. Create a new migration instead.
- **Never delete migration directories** from version control. Prisma tracks applied migrations by their directory names.
- The `db:migrate:reset` command drops and recreates the database. Only use it in development.
- `DATABASE_URL` must be set in your environment for all migration commands.
