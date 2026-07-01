import pg from 'pg';

export async function resolveCuration({ catalogId, compositionKey, displayLabel, activeIngredients,
  strengthComponents, confidence = 'high', reviewer, notes, connectionString } = {}) {
  const url = connectionString || process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    let compositionId = null;
    if (compositionKey) {
      const label = displayLabel || compositionKey.replace(/[_+]/g, (m) => (m === '+' ? ' + ' : ' '));
      const ai = activeIngredients || compositionKey.split('+');
      const cr = await client.query(
        `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
         VALUES ($1,$2,$3,'curated')
         ON CONFLICT (composition_key) DO UPDATE SET source='curated', updated_at=NOW() RETURNING id`,
        [compositionKey, label, ai]);
      compositionId = cr.rows[0].id;
    }
    await client.query(
      `UPDATE pharmacy_catalog SET composition_id=$2, strength_components=$3,
         composition_source='curated', composition_confidence=$4, updated_at=NOW() WHERE id=$1`,
      [catalogId, compositionId, strengthComponents ? JSON.stringify(strengthComponents) : null, confidence]);
    await client.query(
      `UPDATE drug_composition_curation_queue SET status='resolved', reviewer=$2, notes=$3, updated_at=NOW()
       WHERE catalog_id=$1`,
      [catalogId, reviewer || null, notes || null]);
  } finally {
    await client.end();
  }
}
