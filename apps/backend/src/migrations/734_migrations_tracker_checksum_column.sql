-- 734: add a content-integrity checksum column to the _migrations tracker.
--
-- The tracker was name-only, so an in-place edit of an already-applied migration
-- was undetectable by machinery — the migration-669 episode (PR #902) applied a
-- semantically-neutral SET CONSTRAINTS edit to some databases and not others with
-- zero signal. runMigrations.js now records a sha256 of each newly-applied file
-- and verifies already-applied ones on boot (fail-open by default; enforcement
-- behind MIGRATION_CHECKSUM_ENFORCE). This migration lands the column so the
-- CI-applied schema and prisma/schema.prisma agree; the runner also adds it
-- idempotently at boot for DBs that reach the reconcile step before this file.
--
-- Nullable: pre-existing rows are back-seeded from on-disk content on first run
-- (that seeding adopts current bytes, so it establishes the baseline for FUTURE
-- edits rather than retroactively flagging the historical 669 edit). No data
-- change beyond the column addition.

ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum TEXT;
