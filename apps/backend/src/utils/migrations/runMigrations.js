// src/utils/migrations/runMigrations.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

export async function runMigrations() {
  try {
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

    if (!fs.existsSync(MIGRATIONS_DIR)) {
      logger.info('No migrations directory found, skipping.');
      return;
    }

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (executedNames.has(file)) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      logger.info(`Running migration: ${file}`);

      try {
        // DDL statements (CREATE TABLE / ALTER / INDEX) don't return rowsets,
        // so $executeRawUnsafe is the right Prisma method. It also accepts
        // multi-statement SQL on Postgres.
        await prisma.$executeRawUnsafe(sql);
        await prisma.$executeRawUnsafe('INSERT INTO _migrations (name) VALUES ($1)', file);
        ran++;
        logger.info(`✅ Migration completed: ${file}`);
      } catch (err) {
        // Idempotent migrations (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT
        // EXISTS) can succeed at the SQL layer but Prisma still surfaces an
        // error if the file's last statement returns no rows under
        // $queryRawUnsafe semantics. Switching to $executeRawUnsafe above
        // resolves that, but we log the full error here in case anything
        // legitimately fails so a future-you can debug it.
        logger.error(`❌ Migration ${file} failed`, {
          error: err?.message,
          code: err?.code,
        });
        throw err;
      }
    }

    if (ran === 0) {
      logger.info('No pending migrations.');
    } else {
      logger.info(`✅ Ran ${ran} migration(s).`);
    }
  } catch (error) {
    logger.error('❌ Migration runner aborted', { error: error?.message, code: error?.code });
    throw error;
  }
}

export default runMigrations;
