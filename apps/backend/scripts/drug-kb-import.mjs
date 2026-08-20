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
//   catalog-links      drug_key + catalog_id OR catalog_code_or_name
//                      [,confidence,link_source] — TENANT-SCOPED (requires
//                      --tenant <uuid>): resolves each row against the
//                      tenant's pharmacy_catalog and upserts a live
//                      drug_kb_catalog_links row (migration 722). Default
//                      link_source is vendor_import; override per-row or via
//                      --link-source manual.
//
// Optional row-governance columns accepted on every dataset:
//   provenance,source_refs,license_status,review_status,author_user_id,
//   authored_at,clinical_reviewer_user_id,clinical_reviewed_at,
//   pharmacy_reviewer_user_id,pharmacy_reviewed_at,approved_by,approved_at
//
// Source license metadata (migration 722; surfaced by /drug-kb/status):
//   --license-holder "<name>" --license-expires 2027-03-31 --vendor-edition "2026 Q2"
//
// Source lifecycle (replaces the old raw-SQL note):
//   node scripts/drug-kb-import.mjs --activate-source cims_2026q2
//   node scripts/drug-kb-import.mjs --deactivate-source vh_starter_set
//
// Formulary coverage report (per resolution tier, read-only):
//   node scripts/drug-kb-import.mjs --report --tenant <tenant-uuid>
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

export function parseArgs(argv) {
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
    tenant: null,
    linkSource: 'vendor_import',
    licenseHolder: null,
    licenseExpires: null,
    vendorEdition: null,
    activateSource: null,
    deactivateSource: null,
    report: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--source') args.source = argv[++i];
    else if (a === '--vendor') args.vendor = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--dataset') args.dataset = argv[++i];
    else if (a === '--csv') args.csv = argv[++i];
    else if (a === '--tenant') args.tenant = argv[++i];
    else if (a === '--link-source') args.linkSource = argv[++i];
    else if (a === '--license-note') args.licenseNote = argv[++i];
    else if (a === '--license-holder') args.licenseHolder = argv[++i];
    else if (a === '--license-expires') args.licenseExpires = argv[++i];
    else if (a === '--vendor-edition') args.vendorEdition = argv[++i];
    else if (a === '--source-family') args.sourceFamily = argv[++i];
    else if (a === '--priority') args.priority = Number.parseInt(argv[++i], 10);
    else if (a === '--source-license-status') args.sourceLicenseStatus = argv[++i];
    else if (a === '--edition-status') args.editionStatus = argv[++i];
    else if (a === '--source-hash') args.sourceHash = argv[++i];
    else if (a === '--metadata-json') args.metadata = parseJsonOption(argv[++i], '--metadata-json', {});
    else if (a === '--metadata-file') args.metadata = parseJsonFile(argv[++i], '--metadata-file', {});
    else if (a === '--row-license-status') args.rowLicenseStatus = argv[++i];
    else if (a === '--row-review-status') args.rowReviewStatus = argv[++i];
    else if (a === '--activate-source') args.activateSource = argv[++i];
    else if (a === '--deactivate-source') args.deactivateSource = argv[++i];
    else if (a === '--report') args.report = true;
    else if (a === '--inactive') args.active = false;
    else if (a === '--dry-run') args.dryRun = true;
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return args;
}

const CATALOG_LINK_SOURCES = new Set(['manual', 'vendor_import', 'atc', 'composition']);
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalize one catalog-links CSV row. Pure — exported for unit tests.
 * Returns { catalogId, nameQuery, drugKey, confidence, linkSource } or throws
 * on an invalid row. Exactly one of catalogId / nameQuery is non-null.
 */
export function normalizeCatalogLinkRow(row, { defaultLinkSource = 'vendor_import' } = {}) {
  const drugKey = String(row.drug_key || '').trim().toLowerCase();
  if (!drugKey) throw new Error('catalog-links row requires drug_key');
  const rawId = String(row.catalog_id || '').trim();
  const nameQuery = String(row.catalog_code_or_name || row.catalog_name || '').trim();
  let catalogId = null;
  if (rawId) {
    catalogId = Number.parseInt(rawId, 10);
    if (!Number.isInteger(catalogId) || catalogId <= 0) {
      throw new Error(`catalog-links row has invalid catalog_id '${rawId}'`);
    }
  } else if (!nameQuery) {
    throw new Error('catalog-links row requires catalog_id or catalog_code_or_name');
  }
  const linkSource = String(row.link_source || defaultLinkSource).trim().toLowerCase();
  if (!CATALOG_LINK_SOURCES.has(linkSource)) {
    throw new Error(`Unsupported link_source '${linkSource}' (allowed: ${[...CATALOG_LINK_SOURCES].join(', ')})`);
  }
  let confidence = null;
  if (row.confidence != null && String(row.confidence).trim() !== '') {
    confidence = Number.parseFloat(row.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`catalog-links row has invalid confidence '${row.confidence}' (0..1)`);
    }
  }
  return {
    catalogId, nameQuery: catalogId ? null : nameQuery, drugKey, confidence, linkSource,
  };
}

async function importCatalogLinks(client, args) {
  const rl = readline.createInterface({ input: fs.createReadStream(args.csv), crlfDelay: Infinity });
  let header = null;
  let parsed = 0;
  let written = 0;
  const skipped = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (!header) {
      header = cols.map((c) => c.trim().toLowerCase());
      if (!header.includes('drug_key')) throw new Error('CSV missing required column: drug_key');
      if (!header.includes('catalog_id') && !header.includes('catalog_code_or_name') && !header.includes('catalog_name')) {
        throw new Error('CSV missing required column: catalog_id or catalog_code_or_name');
      }
      continue;
    }
    const row = Object.fromEntries(header.map((h, i) => [h, (cols[i] ?? '').trim()]));
    let link;
    try {
      link = normalizeCatalogLinkRow(row, { defaultLinkSource: args.linkSource });
    } catch (err) {
      skipped.push(`row ${parsed + skipped.length + 1}: ${err.message}`);
      continue;
    }
    parsed += 1;

    // Resolve the tenant catalog row.
    let catalogId = link.catalogId;
    if (catalogId) {
      const found = await client.query(
        `SELECT id FROM pharmacy_catalog WHERE tenant_id = $1::uuid AND id = $2::int`,
        [args.tenant, catalogId],
      );
      if (found.rowCount === 0) {
        skipped.push(`catalog_id ${catalogId}: not found in tenant pharmacy_catalog`);
        continue;
      }
    } else {
      const found = await client.query(
        `SELECT id FROM pharmacy_catalog
          WHERE tenant_id = $1::uuid AND is_active
            AND (LOWER(name) = LOWER($2) OR LOWER(generic_name) = LOWER($2))
          ORDER BY id`,
        [args.tenant, link.nameQuery],
      );
      if (found.rowCount === 0) {
        skipped.push(`'${link.nameQuery}': no active tenant pharmacy_catalog match`);
        continue;
      }
      if (found.rowCount > 1) {
        skipped.push(`'${link.nameQuery}': ambiguous (${found.rowCount} catalog matches) — use catalog_id`);
        continue;
      }
      catalogId = Number(found.rows[0].id);
    }

    if (args.dryRun) { written += 0; continue; }

    // Upsert the LIVE link for this catalog item (partial unique index —
    // update-then-insert rather than ON CONFLICT against the (TRUE) idiom).
    const updated = await client.query(
      `UPDATE drug_kb_catalog_links
          SET drug_key = $3, link_source = $4, source_key = $5,
              confidence = $6, review_status = $7, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND pharmacy_catalog_id = $2::int AND is_active`,
      [args.tenant, catalogId, link.drugKey, link.linkSource, args.source || null,
        link.confidence, args.rowReviewStatus || 'legacy'],
    );
    if (updated.rowCount === 0) {
      await client.query(
        `INSERT INTO drug_kb_catalog_links
           (tenant_id, pharmacy_catalog_id, drug_key, link_source, source_key,
            confidence, review_status, is_active)
         VALUES ($1::uuid, $2::int, $3, $4, $5, $6, $7, true)`,
        [args.tenant, catalogId, link.drugKey, link.linkSource, args.source || null,
          link.confidence, args.rowReviewStatus || 'legacy'],
      );
    }
    written += 1;
  }
  return { parsed, written, skipped };
}

function normalizeReportText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function runCoverageReport(client, tenant) {
  const catalog = (await client.query(
    `SELECT id, name, generic_name FROM pharmacy_catalog
      WHERE tenant_id = $1::uuid AND is_active ORDER BY id LIMIT 20000`,
    [tenant],
  )).rows;
  const total = catalog.length;
  const linked = new Set((await client.query(
    `SELECT DISTINCT pharmacy_catalog_id AS id FROM drug_kb_catalog_links
      WHERE tenant_id = $1::uuid AND is_active
        AND review_status NOT IN ('rejected', 'retired')`,
    [tenant],
  )).rows.map((r) => Number(r.id)));
  const atc = new Set((await client.query(
    `SELECT DISTINCT b.catalog_id AS id
       FROM terminology_catalog_bindings b
       JOIN drug_kb_monographs m
         ON m.atc_code IS NOT NULL AND UPPER(m.atc_code) = UPPER(b.code)
       JOIN drug_kb_sources s ON s.source_key = m.source_key AND s.is_active
      WHERE b.catalog_type = 'pharmacy_item' AND b.system_key = 'ATC'
        AND b.binding_status = 'confirmed'`,
  )).rows.map((r) => Number(r.id)));
  const monographs = (await client.query(
    `SELECT m.drug_key, m.aliases FROM drug_kb_monographs m
       JOIN drug_kb_sources s ON s.source_key = m.source_key AND s.is_active`,
  )).rows;
  const ingredientKeys = new Set();
  const aliasTokens = [];
  for (const mono of monographs) {
    const key = normalizeReportText(mono.drug_key);
    if (key) { ingredientKeys.add(key); aliasTokens.push(key); }
    for (const alias of mono.aliases || []) {
      const norm = normalizeReportText(alias);
      if (norm) { ingredientKeys.add(norm); aliasTokens.push(norm); }
    }
  }
  const composition = new Set();
  const compositionRows = (await client.query(
    `SELECT pc.id, dc.active_ingredients
       FROM pharmacy_catalog pc
       JOIN drug_compositions dc ON dc.id = pc.composition_id
      WHERE pc.tenant_id = $1::uuid AND pc.is_active`,
    [tenant],
  )).rows;
  for (const row of compositionRows) {
    for (const ingredient of row.active_ingredients || []) {
      if (ingredientKeys.has(normalizeReportText(ingredient))) {
        composition.add(Number(row.id));
        break;
      }
    }
  }

  let explicitCount = 0; let atcCount = 0; let compositionCount = 0; let textCount = 0; let unmatched = 0;
  for (const row of catalog) {
    const id = Number(row.id);
    if (linked.has(id)) { explicitCount += 1; continue; }
    if (atc.has(id)) { atcCount += 1; continue; }
    if (composition.has(id)) { compositionCount += 1; continue; }
    const text = normalizeReportText(`${row.name || ''} ${row.generic_name || ''}`);
    if (text && aliasTokens.some((token) => text.includes(token))) { textCount += 1; continue; }
    unmatched += 1;
  }
  const pct = (n) => (total ? ((n / total) * 100).toFixed(1) : '0.0');
  console.log(`Drug-KB formulary coverage for tenant ${tenant}`);
  console.log(`  active pharmacy_catalog items : ${total}`);
  console.log(`  tier 1 explicit link          : ${explicitCount} (${pct(explicitCount)}%)`);
  console.log(`  tier 2 ATC binding            : ${atcCount} (${pct(atcCount)}%)`);
  console.log(`  tier 3 composition            : ${compositionCount} (${pct(compositionCount)}%)`);
  console.log(`  tier 4 text fallback          : ${textCount} (${pct(textCount)}%)`);
  console.log(`  unmatched                     : ${unmatched} (${pct(unmatched)}%)`);
  const deterministic = explicitCount + atcCount + compositionCount;
  console.log(`  deterministic total           : ${deterministic} (${pct(deterministic)}%)`);
}

async function setSourceActive(client, sourceKey, active) {
  const res = await client.query(
    active
      ? `UPDATE drug_kb_sources
            SET is_active = true, activated_at = NOW(), deactivated_at = NULL, updated_at = NOW()
          WHERE source_key = $1
          RETURNING source_key, is_active, priority, is_starter`
      : `UPDATE drug_kb_sources
            SET is_active = false, deactivated_at = NOW(), updated_at = NOW()
          WHERE source_key = $1
          RETURNING source_key, is_active, priority, is_starter`,
    [sourceKey],
  );
  if (res.rowCount === 0) throw new Error(`Unknown drug-KB source '${sourceKey}'`);
  const row = res.rows[0];
  console.log(`Source '${row.source_key}' is now ${row.is_active ? 'ACTIVE' : 'INACTIVE'} (priority ${row.priority}${row.is_starter ? ', starter' : ''}).`);
}

async function main() {
  const args = parseArgs(process.argv);

  // Standalone subcommands (no dataset/CSV): source lifecycle + coverage report.
  if (args.activateSource || args.deactivateSource || args.report) {
    if (!process.env.DATABASE_URL) {
      console.error('DATABASE_URL is not set');
      process.exit(2);
    }
    if (args.report && (!args.tenant || !UUID_RX.test(args.tenant))) {
      console.error('--report requires --tenant <tenant-uuid>');
      process.exit(2);
    }
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      if (args.activateSource) await setSourceActive(client, args.activateSource, true);
      if (args.deactivateSource) await setSourceActive(client, args.deactivateSource, false);
      if (args.report) await runCoverageReport(client, args.tenant);
    } finally {
      await client.end();
    }
    return;
  }

  const isCatalogLinks = args.dataset === 'catalog-links';
  const dataset = DATASETS[args.dataset];
  if (!dataset && !isCatalogLinks) {
    console.error(`--dataset must be one of: ${[...Object.keys(DATASETS), 'catalog-links'].join(', ')}`);
    process.exit(2);
  }
  if (isCatalogLinks && (!args.tenant || !UUID_RX.test(args.tenant))) {
    console.error('--dataset catalog-links requires --tenant <tenant-uuid> (pharmacy_catalog is tenant-scoped)');
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
           metadata, source_hash, license_holder, license_expires_at, vendor_edition
         )
         VALUES ($1, $2, $3, $4, $5, false, $6, NOW(), $7, $8, $9, $10, $11::jsonb, $12,
                 $13, $14::timestamptz, $15)
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
           license_holder = COALESCE(EXCLUDED.license_holder, drug_kb_sources.license_holder),
           license_expires_at = COALESCE(EXCLUDED.license_expires_at, drug_kb_sources.license_expires_at),
           vendor_edition = COALESCE(EXCLUDED.vendor_edition, drug_kb_sources.vendor_edition),
           imported_at = NOW(), updated_at = NOW()`,
        [args.source, `${args.vendor || args.source} drug KB`, args.vendor || null,
          args.version || null, args.licenseNote || null, args.active, args.priority,
          args.sourceFamily || args.source, args.editionStatus, args.sourceLicenseStatus,
          JSON.stringify(args.metadata || {}), args.sourceHash || null,
          args.licenseHolder || null, args.licenseExpires || null, args.vendorEdition || null],
      );
    }

    if (isCatalogLinks) {
      const { parsed: linkParsed, written: linkWritten, skipped } = await importCatalogLinks(client, args);
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `${args.dryRun ? '[dry-run] ' : ''}catalog-links ← ${path.basename(args.csv)}: ` +
        `parsed ${linkParsed}${args.dryRun ? '' : `, upserted ${linkWritten}`} link rows for tenant ${args.tenant} in ${secs}s`,
      );
      if (skipped.length) {
        console.log(`Skipped ${skipped.length} row(s):`);
        for (const reason of skipped) console.log(`  - ${reason}`);
      }
      return;
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
