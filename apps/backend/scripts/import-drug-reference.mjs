// Imports the aushadhi India drug reference artifact (dist/<date>/drugs.jsonl)
// into the composition layer:
//   --compositions <artifact-dir>              upsert unique compositions (source='imported')
//   --match-catalog <artifact-dir> --tenant X  exact-brand-match pharmacy_catalog rows
//   --stats [--tenant X]                       coverage report vs the acceptance gate
// All canonicalization goes through the platform's compositionParser — the
// artifact never carries VH Health keys (thin-builder/smart-importer contract).
import fs from 'node:fs';
import readline from 'node:readline';
import pg from 'pg';
import { compositionKey, parseStrength, parseForm } from '../src/services/pharmacy/compositionParser.js';

function connect() {
  const url = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL or TEST_DATABASE_URL required');
  return new pg.Client({ connectionString: url });
}

async function* readArtifactRows(artifactDir) {
  const file = `${artifactDir}/drugs.jsonl`;
  if (!fs.existsSync(file)) throw new Error(`artifact not found: ${file}`);
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip corrupt line */ }
  }
}

// Rebuild the parser's canonical inputs from artifact ingredients:
// generic_name = molecule names joined ' + '; a synthetic name string carries
// the strength tokens so parseStrength sees the same shapes catalog rows have.
export function referenceRowToParserInput(row) {
  const genericName = row.ingredients.map((i) => i.molecule).join(' + ');
  const strengthText = row.ingredients
    .map((i) => (i.strength_value !== null && i.strength_unit ? `${i.strength_value} ${i.strength_unit}` : ''))
    .filter(Boolean)
    .join(' + ');
  const name = `${row.brand_name ?? ''} ${strengthText}`.trim();
  return { genericName, name };
}

export async function importCompositions(artifactDir, { connectionString } = {}) {
  const client = connectionString ? new pg.Client({ connectionString }) : connect();
  await client.connect();
  const stats = { rows: 0, eligible: 0, upserted: 0, skippedCurated: 0, errors: 0 };
  const seenKeys = new Set();
  try {
    for await (const row of readArtifactRows(artifactDir)) {
      stats.rows += 1;
      if (row.type !== 'allopathy' || !row.ingredients?.length) continue;
      stats.eligible += 1;
      const { genericName } = referenceRowToParserInput(row);
      const comp = compositionKey(genericName);
      if (!comp.key || seenKeys.has(comp.key)) continue;
      seenKeys.add(comp.key);
      try {
        const res = await client.query(
          `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
           VALUES ($1,$2,$3,'imported')
           ON CONFLICT (composition_key) DO UPDATE
             SET display_label=EXCLUDED.display_label,
                 active_ingredients=EXCLUDED.active_ingredients,
                 source='imported', updated_at=NOW()
             WHERE drug_compositions.source <> 'curated'
           RETURNING id`,
          [comp.key, comp.displayLabel, comp.activeIngredients],
        );
        if (res.rows.length) stats.upserted += 1;
        else stats.skippedCurated += 1;
      } catch (e) {
        stats.errors += 1;
        console.error(`importCompositions: ${comp.key}: ${e.message}`);
      }
    }
    return stats;
  } finally {
    await client.end();
  }
}

// Exact-after-normalization brand matching. Deliberately mirrors the artifact's
// normalization only as far as needed for equality (lowercase + collapse ws) —
// no fuzzy matching is ever auto-applied.
export function normBrand(s) {
  return (s ?? '').toString().toLowerCase().replace(/[‘’'"`]/g, '').replace(/\s+/g, ' ').trim();
}

export async function loadBrandIndex(artifactDir) {
  const index = new Map();
  for await (const row of readArtifactRows(artifactDir)) {
    if (row.type !== 'allopathy' || !row.ingredients?.length) continue;
    const k = normBrand(row.brand_name);
    if (!k) continue;
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(row);
  }
  return index;
}

export async function matchCatalog(artifactDir, { tenantId, connectionString } = {}) {
  if (!tenantId) throw new Error('matchCatalog requires tenantId (curation queue tenant_id has no default)');
  const client = connectionString ? new pg.Client({ connectionString }) : connect();
  await client.connect();
  const stats = { catalogRows: 0, matched: 0, ambiguous: 0, unmatched: 0, skippedProtected: 0 };
  try {
    const index = await loadBrandIndex(artifactDir);
    const cat = (await client.query(
      `SELECT id, name, generic_name, tenant_id, composition_source, composition_confidence
         FROM pharmacy_catalog
        WHERE is_active AND tenant_id=$1::uuid`,
      [tenantId],
    )).rows;
    for (const row of cat) {
      stats.catalogRows += 1;
      if (row.composition_source === 'curated'
        || (row.composition_source === 'imported' && row.composition_confidence === 'high')) {
        stats.skippedProtected += 1;
        continue;
      }
      const candidates = index.get(normBrand(row.name)) ?? [];
      // distinct compositions among candidates decide ambiguity
      const keys = new Set(candidates.map((c) => compositionKey(referenceRowToParserInput(c).genericName).key).filter(Boolean));
      if (keys.size === 1) {
        const ref = candidates[0];
        const { genericName } = referenceRowToParserInput(ref);
        const comp = compositionKey(genericName);
        const compId = (await client.query(
          `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
           VALUES ($1,$2,$3,'imported')
           ON CONFLICT (composition_key) DO UPDATE SET updated_at=NOW()
           RETURNING id`,
          [comp.key, comp.displayLabel, comp.activeIngredients],
        )).rows[0].id;
        // strength/form from the platform parser over the CATALOG row's own name
        // (never overwrite the pharmacist's text fields; only structured keys)
        const strength = parseStrength(row.name || '');
        const form = parseForm(row.name || '');
        await client.query(
          `UPDATE pharmacy_catalog SET
             composition_id=$2,
             strength=COALESCE(strength,$3), strength_key=COALESCE(strength_key,$4),
             strength_components=COALESCE(strength_components,$5),
             form=COALESCE(form,$6), form_key=COALESCE(form_key,$7),
             release_key=COALESCE(release_key,$8), route=COALESCE(route,$9),
             composition_source='imported', composition_confidence='high',
             parsed_notes=$10, updated_at=NOW()
           WHERE id=$1`,
          [row.id, compId, strength.display, strength.key,
            strength.components ? JSON.stringify(strength.components) : null,
            form.form, form.formKey, form.releaseKey, form.route,
            `drug-reference exact brand match (${candidates[0].sources?.map((s) => s.source).join(';') ?? 'artifact'})`],
        );
        stats.matched += 1;
      } else if (keys.size > 1) {
        stats.ambiguous += 1;
        await client.query(
          `INSERT INTO drug_composition_curation_queue (tenant_id, catalog_id, reason, status, parser_output)
           VALUES ($1::uuid,$2,'reference_ambiguous','open',$3)
           ON CONFLICT (tenant_id, catalog_id) DO UPDATE
             SET reason=EXCLUDED.reason, parser_output=EXCLUDED.parser_output, updated_at=NOW()`,
          [row.tenant_id, row.id, JSON.stringify({
            brand: row.name,
            candidates: candidates.slice(0, 8).map((c) => ({ brand: c.brand_name, manufacturer: c.manufacturer, composition: c.composition_raw })),
          })],
        );
      } else {
        stats.unmatched += 1;
      }
    }
    return stats;
  } finally {
    await client.end();
  }
}

export async function coverageStats({ tenantId, connectionString } = {}) {
  const client = connectionString ? new pg.Client({ connectionString }) : connect();
  await client.connect();
  try {
    const where = tenantId ? 'AND tenant_id=$1::uuid' : '';
    const params = tenantId ? [tenantId] : [];
    const r = (await client.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE composition_id IS NOT NULL)::int AS with_composition,
              COUNT(*) FILTER (WHERE composition_confidence='high')::int AS high_confidence
         FROM pharmacy_catalog WHERE is_active ${where}`,
      params,
    )).rows[0];
    const rowPct = r.total ? (100 * r.with_composition) / r.total : 0;
    return {
      ...r,
      row_coverage_pct: Number(rowPct.toFixed(1)),
      row_gate_90: rowPct >= 90,
      note: 'usage-weighted gate needs dispense volume — see acceptance snapshot tooling in spec 2026-06-30',
    };
  } finally {
    await client.end();
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('import-drug-reference.mjs');
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
  };
  const run = async () => {
    if (flag('compositions')) {
      const s = await importCompositions(flag('compositions'));
      console.log(`compositions: ${JSON.stringify(s)}`);
    } else if (flag('match-catalog')) {
      const s = await matchCatalog(flag('match-catalog'), { tenantId: flag('tenant') });
      console.log(`match-catalog: ${JSON.stringify(s)}`);
    } else if (flag('stats')) {
      const s = await coverageStats({ tenantId: typeof flag('tenant') === 'string' ? flag('tenant') : undefined });
      console.log(`coverage: ${JSON.stringify(s)}`);
    } else {
      console.log('usage: node scripts/import-drug-reference.mjs --compositions <dir> | --match-catalog <dir> --tenant <uuid> | --stats [--tenant <uuid>]');
    }
  };
  run().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
}
