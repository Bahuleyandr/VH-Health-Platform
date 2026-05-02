// src/utils/migrations/runMigrations.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { splitStatements } from './splitStatements.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

/**
 * Apply pending `.sql` migrations from `src/migrations/` in filename order.
 *
 * Tracking lives in a `_migrations` table (autocreated). Each migration file
 * runs in two passes:
 *
 *   1. Split the file content into individual SQL statements (via
 *      `splitStatements`) so we don't hit Postgres error 42601 — `cannot
 *      insert multiple commands into a prepared statement` — that Prisma's
 *      `$executeRawUnsafe` raises when the input contains more than one
 *      command separated by `;`.
 *
 *   2. Execute each statement, then atomically record the file in
 *      `_migrations` so subsequent runs skip it. Failure inside any
 *      statement aborts the file (we do NOT record it as completed),
 *      and the runner re-throws so `bin/www.js` can exit with a clear
 *      error.
 *
 * Migration failure is FATAL by design: a half-applied schema leads to
 * silent runtime errors that are far harder to diagnose than a startup
 * crash. The previous behavior — catching errors and warning "non-fatal
 * — schema managed by Prisma" — masked real schema drift on dalekdefender
 * (verified 2026-05-01 — migrations 108-139 all silently failed and the
 * pod ran on a broken schema for an unknown number of restarts).
 */
export async function runMigrations({ migrationsDir = DEFAULT_MIGRATIONS_DIR } = {}) {
  // Create migrations tracking table. DDL → $executeRawUnsafe.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Get already-run migrations.
  const executed = await prisma.$queryRawUnsafe('SELECT name FROM _migrations ORDER BY name');
  const executedNames = new Set(
    (Array.isArray(executed) ? executed : executed?.rows ?? []).map((r) => r.name),
  );

  if (!fs.existsSync(migrationsDir)) {
    logger.info('No migrations directory found, skipping.');
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (executedNames.has(file)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const statements = splitStatements(sql);

    if (statements.length === 0) {
      logger.warn(`Migration ${file} contained no executable statements (comments-only file?). Recording as applied.`);
      await prisma.$executeRawUnsafe('INSERT INTO _migrations (name) VALUES ($1)', file);
      continue;
    }

    logger.info(`Running migration: ${file} (${statements.length} statement${statements.length === 1 ? '' : 's'})`);

    try {
      for (const stmt of statements) {
        await prisma.$executeRawUnsafe(stmt);
      }
      await prisma.$executeRawUnsafe('INSERT INTO _migrations (name) VALUES ($1)', file);
      ran += 1;
      logger.info(`✅ Migration completed: ${file}`);
    } catch (err) {
      logger.error(`❌ Migration ${file} failed`, {
        error: err?.message,
        code: err?.code,
        statements_attempted: statements.length,
      });
      // Re-throw so the caller can surface a fatal startup error.
      // Do NOT swallow — a half-applied schema is far worse than a crash.
      throw err;
    }
  }

  if (ran === 0) {
    logger.info('No pending migrations.');
  } else {
    logger.info(`✅ Ran ${ran} migration(s).`);
  }
}

export { DEFAULT_MIGRATIONS_DIR };
export default runMigrations;
