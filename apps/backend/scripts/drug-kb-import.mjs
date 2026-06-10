#!/usr/bin/env node
// drug-kb-import.mjs — roadmap B2 licensed-KB importer.
//
// Loads vendor drug-KB exports into the drug_kb_* tables (migration 277).
// Licensing Medi-Span / FDB / CIMS / CDSCO-derived data is an OWNER-SIDE
// procurement action; this script consumes a neutral CSV shape so any
// vendor export can be transformed once and imported repeatedly.
//
// Usage:
//   node scripts/drug-kb-import.mjs --source cims_2026q2 --vendor CIMS \
//        --version 2026.2 --dataset interactions --csv interactions.csv
//
// Datasets + required CSV columns (header row required):
//   monographs         drug_key,display_name[,atc_code,drug_class,aliases]
//                      (aliases pipe-separated: "brufen|combiflam")
//   interactions       drug_a_key,drug_b_key,severity[,mechanism,effect,management,evidence]
//   allergy-groups     group_key,member_key
//   cross-reactivity   group_key,reacts_with_group_key,risk[,note]
//   condition-cautions drug_key,icd10_prefix,condition_label,risk[,note]
//   dose-ranges        drug_key,population[,route,max_single_dose_mg,max_daily_dose_mg,
//                      max_daily_mg_per_kg,min_egfr,egfr_max_daily_mg,note]
//   iv-compatibility   drug_a_key,drug_b_key,compatibility[,diluent,note]
//
// After a licensed source is loaded and validated, deactivate the starter:
//   UPDATE drug_kb_sources SET is_active = false WHERE source_key = 'vh_starter_set';
//
// Connection: DATABASE_URL.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseCsvLine } from './terminology-import.mjs';

const DATASETS = {
  monographs: {
    required: ['drug_key', 'display_name'],
    insert: `INSERT INTO drug_kb_monographs (source_key, drug_key, display_name, atc_code, drug_class, aliases)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (source_key, drug_key) DO UPDATE SET
               display_name = EXCLUDED.display_name, atc_code = EXCLUDED.atc_code,
               drug_class = EXCLUDED.drug_class, aliases = EXCLUDED.aliases, updated_at = NOW()`,
    params: (r) => [
      r.drug_key.toLowerCase(), r.display_name, r.atc_code || null, r.drug_class || null,
      (r.aliases || '').split('|').map((a) => a.trim().toLowerCase()).filter(Boolean),
    ],
  },
  interactions: {
    required: ['drug_a_key', 'drug_b_key', 'severity'],
    insert: `INSERT INTO drug_kb_interactions (source_key, drug_a_key, drug_b_key, severity, mechanism, effect, management, evidence)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (source_key, drug_a_key, drug_b_key) DO UPDATE SET
               severity = EXCLUDED.severity, mechanism = EXCLUDED.mechanism,
               effect = EXCLUDED.effect, management = EXCLUDED.management, evidence = EXCLUDED.evidence`,
    params: (r) => {
      const a = r.drug_a_key.toLowerCase().trim();
      const b = r.drug_b_key.toLowerCase().trim();
      const [x, y] = a < b ? [a, b] : [b, a];
      return [x, y, r.severity.toLowerCase(), r.mechanism || null, r.effect || null, r.management || null, r.evidence || null];
    },
  },
  'allergy-groups': {
    required: ['group_key', 'member_key'],
    insert: `INSERT INTO drug_kb_allergy_groups (source_key, group_key, member_key)
             VALUES ($1, $2, $3)
             ON CONFLICT (source_key, group_key, member_key) DO NOTHING`,
    params: (r) => [r.group_key.toLowerCase(), r.member_key.toLowerCase()],
  },
  'cross-reactivity': {
    required: ['group_key', 'reacts_with_group_key', 'risk'],
    insert: `INSERT INTO drug_kb_allergy_cross_reactivity (source_key, group_key, reacts_with_group_key, risk, note)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (source_key, group_key, reacts_with_group_key) DO UPDATE SET
               risk = EXCLUDED.risk, note = EXCLUDED.note`,
    params: (r) => [r.group_key.toLowerCase(), r.reacts_with_group_key.toLowerCase(), r.risk.toLowerCase(), r.note || null],
  },
  'condition-cautions': {
    required: ['drug_key', 'icd10_prefix', 'condition_label', 'risk'],
    insert: `INSERT INTO drug_kb_condition_cautions (source_key, drug_key, icd10_prefix, condition_label, risk, note)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (source_key, drug_key, icd10_prefix) DO UPDATE SET
               condition_label = EXCLUDED.condition_label, risk = EXCLUDED.risk, note = EXCLUDED.note`,
    params: (r) => [r.drug_key.toLowerCase(), r.icd10_prefix.toUpperCase(), r.condition_label, r.risk.toLowerCase(), r.note || null],
  },
  'dose-ranges': {
    required: ['drug_key', 'population'],
    insert: `INSERT INTO drug_kb_dose_ranges (source_key, drug_key, route, population, max_single_dose_mg,
               max_daily_dose_mg, max_daily_mg_per_kg, min_egfr, egfr_max_daily_mg, note)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (source_key, drug_key, COALESCE(route, 'any'), population) DO UPDATE SET
               max_single_dose_mg = EXCLUDED.max_single_dose_mg,
               max_daily_dose_mg = EXCLUDED.max_daily_dose_mg,
               max_daily_mg_per_kg = EXCLUDED.max_daily_mg_per_kg,
               min_egfr = EXCLUDED.min_egfr,
               egfr_max_daily_mg = EXCLUDED.egfr_max_daily_mg,
               note = EXCLUDED.note`,
    params: (r) => [
      r.drug_key.toLowerCase(), r.route ? r.route.toLowerCase() : null, r.population.toLowerCase(),
      num(r.max_single_dose_mg), num(r.max_daily_dose_mg), num(r.max_daily_mg_per_kg),
      num(r.min_egfr), num(r.egfr_max_daily_mg), r.note || null,
    ],
  },
  'iv-compatibility': {
    required: ['drug_a_key', 'drug_b_key', 'compatibility'],
    insert: `INSERT INTO drug_kb_iv_compatibility (source_key, drug_a_key, drug_b_key, compatibility, diluent, note)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (source_key, drug_a_key, drug_b_key, COALESCE(diluent, 'any')) DO UPDATE SET
               compatibility = EXCLUDED.compatibility, note = EXCLUDED.note`,
    params: (r) => {
      const a = r.drug_a_key.toLowerCase().trim();
      const b = r.drug_b_key.toLowerCase().trim();
      const [x, y] = a < b ? [a, b] : [b, a];
      return [x, y, r.compatibility.toLowerCase(), r.diluent || null, r.note || null];
    },
  },
};

function num(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--source') args.source = argv[++i];
    else if (a === '--vendor') args.vendor = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--dataset') args.dataset = argv[++i];
    else if (a === '--csv') args.csv = argv[++i];
    else if (a === '--license-note') args.licenseNote = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const dataset = DATASETS[args.dataset];
  if (!dataset) {
    console.error(`--dataset must be one of: ${Object.keys(DATASETS).join(', ')}`);
    process.exit(2);
  }
  if (!args.source || !/^[a-z0-9_]+$/.test(args.source)) {
    console.error('--source is required (lowercase key, e.g. cims_2026q2)');
    process.exit(2);
  }
  if (!args.csv || !fs.existsSync(args.csv)) {
    console.error('--csv <file> is required and must exist');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let parsed = 0;
  let written = 0;
  const startedAt = Date.now();
  try {
    if (!args.dryRun) {
      await client.query(
        `INSERT INTO drug_kb_sources (source_key, name, vendor, version, license_note, is_starter, imported_at)
         VALUES ($1, $2, $3, $4, $5, false, NOW())
         ON CONFLICT (source_key) DO UPDATE SET
           vendor = COALESCE(EXCLUDED.vendor, drug_kb_sources.vendor),
           version = COALESCE(EXCLUDED.version, drug_kb_sources.version),
           license_note = COALESCE(EXCLUDED.license_note, drug_kb_sources.license_note),
           imported_at = NOW(), updated_at = NOW()`,
        [args.source, `${args.vendor || args.source} drug KB`, args.vendor || null,
          args.version || null, args.licenseNote || null],
      );
    }

    const rl = readline.createInterface({ input: fs.createReadStream(args.csv), crlfDelay: Infinity });
    let header = null;
    for await (const line of rl) {
      if (!line.trim()) continue;
      const cols = parseCsvLine(line);
      if (!header) {
        header = cols.map((c) => c.trim().toLowerCase());
        const missing = dataset.required.filter((c) => !header.includes(c));
        if (missing.length) throw new Error(`CSV missing required columns: ${missing.join(', ')}`);
        continue;
      }
      const row = Object.fromEntries(header.map((h, i) => [h, (cols[i] ?? '').trim()]));
      if (dataset.required.some((c) => !row[c])) continue;
      parsed += 1;
      if (args.dryRun) continue;
      const res = await client.query(dataset.insert, [args.source, ...dataset.params(row)]);
      written += res.rowCount;
    }
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `${args.dryRun ? '[dry-run] ' : ''}${args.dataset} ← ${path.basename(args.csv)}: ` +
      `parsed ${parsed}${args.dryRun ? '' : `, upserted ${written}`} rows into source '${args.source}' in ${secs}s`,
    );
    if (!args.dryRun) {
      console.log("Reminder: once the licensed KB is validated, deactivate the starter set:\n" +
        "  UPDATE drug_kb_sources SET is_active = false WHERE source_key = 'vh_starter_set';");
    }
  } finally {
    await client.end();
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
