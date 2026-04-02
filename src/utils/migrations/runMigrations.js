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
    // Create migrations tracking table
    await prisma.$queryRawUnsafe(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Get already-run migrations
    const { rows: executed } = await prisma.$queryRawUnsafe('SELECT name FROM _migrations ORDER BY name');
    const executedNames = new Set(executed.map(r => r.name));

    // Read migration files
    if (!fs.existsSync(MIGRATIONS_DIR)) {
      logger.info('No migrations directory found, skipping.');
      return;
    }

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (executedNames.has(file)) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      logger.info(`Running migration: ${file}`);

      await prisma.$queryRawUnsafe(sql);
      await prisma.$queryRawUnsafe('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      ran++;
      logger.info(`✅ Migration completed: ${file}`);
    }

    if (ran === 0) {
      logger.info('No pending migrations.');
    } else {
      logger.info(`✅ Ran ${ran} migration(s).`);
    }
  } catch (error) {
    logger.error('❌ Migration failed:', error.message);
    throw error;
  }
}

export default runMigrations;
