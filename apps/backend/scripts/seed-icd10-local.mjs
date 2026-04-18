import logger from '../src/logging/logger.js';
import pg from 'pg';
import { ICD10_SEED_DATA } from '../src/services/emr/icd10SeedData.js';

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
});

await client.connect();
let inserted = 0, skipped = 0, failed = 0;

for (const entry of ICD10_SEED_DATA) {
  try {
    const r = await client.query(
      `INSERT INTO icd10_codes (code, description, category)
       VALUES ($1, $2, $3)
       ON CONFLICT (code) DO NOTHING`,
      [entry.code, entry.description, entry.category]
    );
    if (r.rowCount === 1) inserted++; else skipped++;
  } catch (e) {
    failed++;
    logger.error(`FAIL ${entry.code}: ${e.message}`);
  }
}

const { rows } = await client.query('SELECT count(*)::int AS n FROM icd10_codes');
logger.info(JSON.stringify({ inserted, skipped, failed, total_in_table: rows[0].n, seed_size: ICD10_SEED_DATA.length }));
await client.end();
