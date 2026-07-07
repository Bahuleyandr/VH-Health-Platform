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
// Optional row-governance columns accepted on every dataset:
//   provenance,source_refs,license_status,review_status,author_user_id,
//   authored_at,clinical_reviewer_user_id,clinical_reviewed_at,
//   pharmacy_reviewer_user_id,pharmacy_reviewed_at,approved_by,approved_at
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
    table: 'drug_kb_monographs',
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
    keyWhere: 'drug_key = $14',
    keyParams: (r) => [r.drug_key.toLowerCase()],
  },
  interactions: {
    table: 'drug_kb_interactions',
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
    keyWhere: 'drug_a_key = $14 AND drug_b_key = $15',
    keyParams: (r) => {
      const a = r.drug_a_key.toLowerCase().trim();
      const b = r.drug_b_key.toLowerCase().trim();
      return a < b ? [a, b] : [b, a];
    },
  },
  'allergy-groups': {
    table: 'drug_kb_allergy_groups',
    required: ['group_key', 'member_key'],
    insert: `INSERT INTO drug_kb_allergy_groups (source_key, group_key, member_key)
             VALUES ($1, $2, $3)
             ON CONFLICT (source_key, group_key, member_key) DO NOTHING`,
    params: (r) => [r.group_key.toLowerCase(), r.member_key.toLowerCase()],
    keyWhere: 'group_key = $14 AND member_key = $15',
    keyParams: (r) => [r.group_key.toLowerCase(), r.member_key.toLowerCase()],
  },
  'cross-reactivity': {
    table: 'drug_kb_allergy_cross_reactivity',
    required: ['group_key', 'reacts_with_group_key', 'risk'],
    insert: `INSERT INTO drug_kb_allergy_cross_reactivity (source_key, group_key, reacts_with_group_key, risk, note)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (source_key, group_key, reacts_with_group_key) DO UPDATE SET
               risk = EXCLUDED.risk, note = EXCLUDED.note`,
    params: (r) => [r.group_key.toLowerCase(), r.reacts_with_group_key.toLowerCase(), r.risk.toLowerCase(), r.note || null],
    keyWhere: 'group_key = $14 AND reacts_with_group_key = $15',
    keyParams: (r) => [r.group_key.toLowerCase(), r.reacts_with_group_key.toLowerCase()],
  },
  'condition-cautions': {
    table: 'drug_kb_condition_cautions',
    required: ['drug_key', 'icd10_prefix', 'condition_label', 'risk'],
    insert: `INSERT INTO drug_kb_condition_cautions (source_key, drug_key, icd10_prefix, condition_label, risk, note)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (source_key, drug_key, icd10_prefix) DO UPDATE SET
               condition_label = EXCLUDED.condition_label, risk = EXCLUDED.risk, note = EXCLUDED.note`,
    params: (r) => [r.drug_key.toLowerCase(), r.icd10_prefix.toUpperCase(), r.condition_label, r.risk.toLowerCase(), r.note || null],
    keyWhere: 'drug_key = $14 AND icd10_prefix = $15',
    keyParams: (r) => [r.drug_key.toLowerCase(), r.icd10_prefix.toUpperCase()],
  },
  'dose-ranges': {
    table: 'drug_kb_dose_ranges',
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
    keyWhere: "drug_key = $14 AND COALESCE(route, 'any') = $15 AND population = $16",
    keyParams: (r) => [
      r.drug_key.toLowerCase(),
      r.route ? r.route.toLowerCase() : 'any',
      r.population.toLowerCase(),
    ],
  },
  'iv-compatibility': {
    table: 'drug_kb_iv_compatibility',
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
    keyWhere: "drug_a_key = $14 AND drug_b_key = $15 AND COALESCE(diluent, 'any') = $16",
    keyParams: (r) => {
      const a = r.drug_a_key.toLowerCase().trim();
      const b = r.drug_b_key.toLowerCase().trim();
      const [x, y] = a < b ? [a, b] : [b, a];
      return [x, y, r.diluent || 'any'];
    },
  },
};

const LICENSE_STATUSES = new Set([
  'hospital_owned',
  'government_open_data_attribution',
  'permission_recorded',
  'permission_required',
  'operator_supplied_terms',
  'reference_only',
  'prohibited',
]);

const REVIEW_STATUSES = new Set(['legacy', 'draft', 'in_review', 'approved', 'rejected', 'retired']);
const EDITION_STATUSES = new Set(['candidate', 'accepted', 'rejected', 'retired', 'rolled_back']);

function num(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJsonOption(raw, label, fallback) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch (err) {
    throw new Error(`${label} must be valid JSON: ${err.message}`);
  }
}

function parseJsonFile(file, label, fallback) {
  if (!file) return fallback;
  return parseJsonOption(fs.readFileSync(file, 'utf8'), label, fallback);
}

function parseJsonRow(raw, label, fallback) {
  if (!raw) return fallback;
  return parseJsonOption(raw, label, fallback);
}

function optionalUuid(value) {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function optionalTimestamp(value) {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function normalizeLicenseStatus(value, fallback) {
  const status = String(value || fallback || 'permission_required').trim();
  if (!LICENSE_STATUSES.has(status)) {
    throw new Error(`Unsupported license_status '${status}'`);
  }
  return status;
}

function normalizeReviewStatus(value, fallback = 'legacy') {
  const status = String(value || fallback).trim();
  if (!REVIEW_STATUSES.has(status)) {
    throw new Error(`Unsupported review_status '${status}'`);
  }
  return status;
}

function rowGovernanceParams(row, args) {
  const provenance = parseJsonRow(row.provenance, 'row provenance', {});
  const sourceRefs = parseJsonRow(row.source_refs, 'row source_refs', []);
  if (!Array.isArray(sourceRefs)) {
    throw new Error('row source_refs must be a JSON array');
  }
  return [
    JSON.stringify(provenance),
    JSON.stringify(sourceRefs),
    normalizeLicenseStatus(row.license_status, args.rowLicenseStatus || args.sourceLicenseStatus),
    normalizeReviewStatus(row.review_status, args.rowReviewStatus),
    optionalUuid(row.author_user_id || row.authored_by),
    optionalTimestamp(row.authored_at),
    optionalUuid(row.clinical_reviewer_user_id || row.clinical_reviewer_by),
    optionalTimestamp(row.clinical_reviewed_at),
    optionalUuid(row.pharmacy_reviewer_user_id || row.pharmacy_reviewer_by),
    optionalTimestamp(row.pharmacy_reviewed_at),
    optionalUuid(row.approved_by),
    optionalTimestamp(row.approved_at),
  ];
}

async function updateRowGovernance(client, dataset, source, row, args) {
  await client.query(
    `UPDATE ${dataset.table}
        SET provenance = $1::jsonb,
            source_refs = $2::jsonb,
            license_status = $3,
            review_status = $4,
            authored_by = $5::uuid,
            authored_at = $6::timestamptz,
            clinical_reviewer_by = $7::uuid,
            clinical_reviewed_at = $8::timestamptz,
            pharmacy_reviewer_by = $9::uuid,
            pharmacy_reviewed_at = $10::timestamptz,
            approved_by = $11::uuid,
            approved_at = $12::timestamptz
      WHERE source_key = $13 AND ${dataset.keyWhere}`,
    [...rowGovernanceParams(row, args), source, ...dataset.keyParams(row)],
  );
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    active: true,
    priority: 100,
    sourceFamily: null,
    sourceLicenseStatus: 'permission_required',
    editionStatus: 'accepted',
    rowLicenseStatus: null,
    rowReviewStatus: 'legacy',
    metadata: {},
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--source') args.source = argv[++i];
    else if (a === '--vendor') args.vendor = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--dataset') args.dataset = argv[++i];
    else if (a === '--csv') args.csv = argv[++i];
    else if (a === '--license-note') args.licenseNote = argv[++i];
    else if (a === '--source-family') args.sourceFamily = argv[++i];
    else if (a === '--priority') args.priority = Number.parseInt(argv[++i], 10);
    else if (a === '--source-license-status') args.sourceLicenseStatus = argv[++i];
    else if (a === '--edition-status') args.editionStatus = argv[++i];
    else if (a === '--source-hash') args.sourceHash = argv[++i];
    else if (a === '--metadata-json') args.metadata = parseJsonOption(argv[++i], '--metadata-json', {});
    else if (a === '--metadata-file') args.metadata = parseJsonFile(argv[++i], '--metadata-file', {});
    else if (a === '--row-license-status') args.rowLicenseStatus = argv[++i];
    else if (a === '--row-review-status') args.rowReviewStatus = argv[++i];
    else if (a === '--inactive') args.active = false;
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
  if (!Number.isInteger(args.priority) || args.priority < 0) {
    console.error('--priority must be a non-negative integer');
    process.exit(2);
  }
  if (!LICENSE_STATUSES.has(args.sourceLicenseStatus)) {
    console.error(`--source-license-status must be one of: ${[...LICENSE_STATUSES].join(', ')}`);
    process.exit(2);
  }
  if (!EDITION_STATUSES.has(args.editionStatus)) {
    console.error(`--edition-status must be one of: ${[...EDITION_STATUSES].join(', ')}`);
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
        `INSERT INTO drug_kb_sources (
           source_key, name, vendor, version, license_note, is_starter, is_active,
           imported_at, priority, source_family, edition_status, license_status,
           metadata, source_hash
         )
         VALUES ($1, $2, $3, $4, $5, false, $6, NOW(), $7, $8, $9, $10, $11::jsonb, $12)
         ON CONFLICT (source_key) DO UPDATE SET
           vendor = COALESCE(EXCLUDED.vendor, drug_kb_sources.vendor),
           version = COALESCE(EXCLUDED.version, drug_kb_sources.version),
           license_note = COALESCE(EXCLUDED.license_note, drug_kb_sources.license_note),
           is_active = EXCLUDED.is_active,
           priority = EXCLUDED.priority,
           source_family = EXCLUDED.source_family,
           edition_status = EXCLUDED.edition_status,
           license_status = EXCLUDED.license_status,
           metadata = COALESCE(drug_kb_sources.metadata, '{}'::jsonb) || EXCLUDED.metadata,
           source_hash = COALESCE(EXCLUDED.source_hash, drug_kb_sources.source_hash),
           imported_at = NOW(), updated_at = NOW()`,
        [args.source, `${args.vendor || args.source} drug KB`, args.vendor || null,
          args.version || null, args.licenseNote || null, args.active, args.priority,
          args.sourceFamily || args.source, args.editionStatus, args.sourceLicenseStatus,
          JSON.stringify(args.metadata || {}), args.sourceHash || null],
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
      await updateRowGovernance(client, dataset, args.source, row, args);
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
