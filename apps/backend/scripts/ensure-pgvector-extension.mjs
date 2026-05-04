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
      'pgvector is not available in this Postgres instance. Use the pgvector/pgvector:pg16 image in CI or install the vector extension locally before running Prisma db push.',
    );
  }

  await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  await client.query('CREATE SEQUENCE IF NOT EXISTS _migrations_id_seq');
  console.log('pgvector extension and Prisma bootstrap sequence are ready.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
