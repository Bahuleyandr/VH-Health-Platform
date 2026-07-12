#!/usr/bin/env node
import pg from 'pg';

const connectionString = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL or TEST_DATABASE_URL is required.');
  process.exit(1);
}

const client = new pg.Client({ connectionString });

try {
  await client.connect();

  const available = await client.query(
    "SELECT 1 FROM pg_available_extensions WHERE name = 'vector' LIMIT 1",
  );
  if (available.rowCount === 0) {
    throw new Error(
      'pgvector is not available in this Postgres instance. Use the pgvector/pgvector:pg18 image in CI or install the vector extension locally before running Prisma db push.',
    );
  }

  await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  // The previous version of this script pre-created
  //   _migrations_id_seq, housekeeping_log_number_seq,
  //   housekeeping_request_number_seq
  // so `prisma db push` could validate the @default(dbgenerated(nextval(…)))
  // expressions before the raw migrations that own those sequences ran.
  // With prisma db push removed from CI (raw migrations are now the
  // source of truth), 000_baseline.sql creates these sequences directly
  // and pre-creating them here only causes "relation already exists"
  // collisions against baseline.sql.
  console.log('pgvector extension is ready.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
