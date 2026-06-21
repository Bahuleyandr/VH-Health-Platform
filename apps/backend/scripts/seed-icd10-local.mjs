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

// Keep the central terminology service (migration 275) in sync with the catalog
// we just seeded. Migration 275 federates icd10_codes -> terminology_concepts,
// but it runs DURING the migration chain — before this seed populates the
// catalog — so on a fresh DB terminology_concepts would otherwise hold zero
// ICD-10 concepts and codingValidationService would mark every real code
// validated:false (breaks clinicalCodingAssist + any terminology-validated path).
// Re-run the same federation now (idempotent). Best-effort: skip if the
// terminology tables aren't present on this schema.
let federated = 0;
try {
  const { rowCount: hasTbl } = await client.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'terminology_concepts'`,
  );
  if (hasTbl > 0) {
    const fed = await client.query(
      `INSERT INTO terminology_concepts (system_key, code, display, category, status)
       SELECT 'ICD10', c.code, c.description, c.category,
              CASE WHEN COALESCE(c.is_active, true) THEN 'active' ELSE 'inactive' END
         FROM icd10_codes c
        WHERE c.code IS NOT NULL AND c.description IS NOT NULL
       ON CONFLICT (system_key, code) DO UPDATE
         SET display  = EXCLUDED.display,
             category = COALESCE(EXCLUDED.category, terminology_concepts.category),
             status   = EXCLUDED.status,
             updated_at = NOW()`,
    );
    federated = fed.rowCount;
    await client.query(
      `UPDATE terminology_code_systems s
          SET concept_count = (SELECT COUNT(*) FROM terminology_concepts t WHERE t.system_key = s.system_key),
              imported_at   = NOW()
        WHERE s.system_key = 'ICD10'`,
    );
  }
} catch (e) {
  logger.error(`ICD-10 terminology federation skipped: ${e.message}`);
}

const { rows } = await client.query('SELECT count(*)::int AS n FROM icd10_codes');
logger.info(JSON.stringify({ inserted, skipped, failed, federated, total_in_table: rows[0].n, seed_size: ICD10_SEED_DATA.length }));
await client.end();
