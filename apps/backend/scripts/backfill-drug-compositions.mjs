import pg from 'pg';
import { parseCatalogRow } from '../src/services/pharmacy/compositionParser.js';

async function upsertComposition(client, comp) {
  const rows = (await client.query(
    `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
     VALUES ($1,$2,$3,'parsed')
     ON CONFLICT (composition_key) DO UPDATE SET updated_at=NOW()
     RETURNING id`,
    [comp.key, comp.displayLabel, comp.activeIngredients],
  )).rows;
  return rows[0].id;
}

export async function backfillCompositions({ where = 'TRUE', connectionString } = {}) {
  const url = connectionString || process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const stats = { total: 0, resolved: 0, queued: 0 };
  try {
    const cat = (await client.query(
      `SELECT id, name, generic_name, tenant_id, composition_source
         FROM pharmacy_catalog WHERE is_active AND (${where})`,
    )).rows;
    for (const row of cat) {
      stats.total += 1;
      if (row.composition_source === 'curated' || row.composition_source === 'imported') continue; // precedence
      const p = parseCatalogRow(row);
      let compositionId = null;
      if (p.composition.key) compositionId = await upsertComposition(client, p.composition);
      await client.query(
        `UPDATE pharmacy_catalog SET
           composition_id=$2, strength=$3, strength_key=$4, strength_components=$5,
           form=$6, form_key=$7, release_key=$8, route=$9,
           composition_source='parsed', composition_confidence=$10, parsed_notes=$11, updated_at=NOW()
         WHERE id=$1`,
        [row.id, compositionId, p.strength.display, p.strength.key,
          p.strength.components ? JSON.stringify(p.strength.components) : null,
          p.form.form, p.form.formKey, p.form.releaseKey, p.form.route,
          p.confidence, p.composition.notes || null],
      );
      if (p.confidence === 'high') stats.resolved += 1;
      if (p.curationReason) {
        stats.queued += 1;
        await client.query(
          `INSERT INTO drug_composition_curation_queue (tenant_id, catalog_id, reason, status, parser_output)
           VALUES ($1::uuid,$2,$3,'open',$4)
           ON CONFLICT (tenant_id, catalog_id) DO UPDATE SET reason=EXCLUDED.reason, parser_output=EXCLUDED.parser_output, updated_at=NOW()`,
          [row.tenant_id, row.id, p.curationReason, JSON.stringify(p)],
        );
      }
    }
    return stats;
  } finally {
    await client.end();
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('backfill-drug-compositions.mjs');
if (invokedDirectly) {
  backfillCompositions().then((s) => {
    console.log(`backfill: ${s.total} rows, ${s.resolved} high-confidence, ${s.queued} queued for curation`);
    process.exit(0);
  }).catch((e) => { console.error('backfill failed:', e.message); process.exit(1); });
}
