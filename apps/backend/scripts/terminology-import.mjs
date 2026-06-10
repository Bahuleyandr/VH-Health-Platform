#!/usr/bin/env node
// terminology-import.mjs — roadmap B8 content importer.
//
// Loads standard code-system releases into terminology_concepts. The
// licenses are free but the content is NOT redistributable in this repo,
// so the owner downloads the release files and points this script at them:
//
//   SNOMED CT (NRC India RF2 snapshot — free national license):
//     node scripts/terminology-import.mjs --system SNOMED_CT --rf2 path/to/Snapshot/Terminology
//
//   LOINC (Regenstrief release):
//     node scripts/terminology-import.mjs --system LOINC --loinc path/to/Loinc.csv
//
//   Generic code,display[,category] CSV (ICD10 / ICD11 / ATC or curated subsets):
//     node scripts/terminology-import.mjs --system ICD11 --csv path/to/icd11.csv
//
// Options: --version <release-label>  stamp terminology_code_systems.version
//          --dry-run                  parse + count, no writes
//
// Connection: DATABASE_URL (same env the backend uses).

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const VALID_SYSTEMS = new Set(['ICD10', 'ICD11', 'SNOMED_CT', 'LOINC', 'ATC']);
const BATCH_SIZE = 500;
const SNOMED_FSN_TYPE = '900000000000003001';

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--system') args.system = argv[++i];
    else if (a === '--rf2') args.rf2 = argv[++i];
    else if (a === '--loinc') args.loinc = argv[++i];
    else if (a === '--csv') args.csv = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

// Minimal RFC-4180 CSV line parser (handles quoted fields + embedded commas).
export function parseCsvLine(line) {
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out;
}

// Strip the SNOMED FSN semantic tag: "Myocardial infarction (disorder)" →
// { display: "Myocardial infarction", tag: "disorder" }.
export function splitFsn(term) {
  const m = /^(.*)\s+\(([^()]+)\)\s*$/.exec(term || '');
  if (!m) return { display: (term || '').trim(), tag: null };
  return { display: m[1].trim(), tag: m[2].trim() };
}

async function flushBatch(client, systemKey, batch, stats, dryRun) {
  if (batch.length === 0) return;
  stats.parsed += batch.length;
  if (dryRun) { batch.length = 0; return; }
  const values = [];
  const params = [];
  let p = 1;
  for (const row of batch) {
    values.push(`($${p}, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, 'active')`);
    params.push(systemKey, row.code, row.display, row.category ?? null, row.semanticTag ?? null);
    p += 5;
  }
  const sql = `
    INSERT INTO terminology_concepts (system_key, code, display, category, semantic_tag, status)
    VALUES ${values.join(', ')}
    ON CONFLICT (system_key, code) DO UPDATE
      SET display = EXCLUDED.display,
          category = COALESCE(EXCLUDED.category, terminology_concepts.category),
          semantic_tag = COALESCE(EXCLUDED.semantic_tag, terminology_concepts.semantic_tag),
          status = 'active',
          updated_at = NOW()`;
  const res = await client.query(sql, params);
  stats.written += res.rowCount;
  batch.length = 0;
}

async function importGenericCsv(client, systemKey, filePath, stats, dryRun) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  const batch = [];
  let header = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (!header) {
      header = cols.map((c) => c.trim().toLowerCase());
      // Headerless code,display files are also accepted.
      if (header[0] !== 'code') {
        const code = cols[0]?.trim();
        const display = cols[1]?.trim();
        if (code && display) batch.push({ code, display, category: cols[2]?.trim() || null });
        header = ['code', 'display', 'category'];
      }
      continue;
    }
    const row = Object.fromEntries(header.map((h, i) => [h, cols[i]]));
    const code = row.code?.trim();
    const display = row.display?.trim();
    if (!code || !display) continue;
    batch.push({ code, display, category: row.category?.trim() || null });
    if (batch.length >= BATCH_SIZE) await flushBatch(client, systemKey, batch, stats, dryRun);
  }
  await flushBatch(client, systemKey, batch, stats, dryRun);
}

async function importLoincCsv(client, filePath, stats, dryRun) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  const batch = [];
  let header = null;
  let idx = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (!header) {
      header = cols.map((c) => c.trim().replace(/^"|"$/g, '').toUpperCase());
      idx = {
        code: header.indexOf('LOINC_NUM'),
        longName: header.indexOf('LONG_COMMON_NAME'),
        component: header.indexOf('COMPONENT'),
        klass: header.indexOf('CLASS'),
        status: header.indexOf('STATUS'),
      };
      if (idx.code === -1 || idx.longName === -1) {
        throw new Error('Not a LOINC release CSV: LOINC_NUM / LONG_COMMON_NAME columns missing');
      }
      continue;
    }
    const status = idx.status >= 0 ? (cols[idx.status] || '').toUpperCase() : 'ACTIVE';
    if (status && status !== 'ACTIVE') continue;
    const code = cols[idx.code]?.trim();
    const display = cols[idx.longName]?.trim() || cols[idx.component]?.trim();
    if (!code || !display) continue;
    batch.push({ code, display, category: idx.klass >= 0 ? cols[idx.klass]?.trim() || null : null });
    if (batch.length >= BATCH_SIZE) await flushBatch(client, 'LOINC', batch, stats, dryRun);
  }
  await flushBatch(client, 'LOINC', batch, stats, dryRun);
}

async function importSnomedRf2(client, dir, stats, dryRun) {
  const files = fs.readdirSync(dir);
  const conceptFile = files.find((f) => /sct2_Concept_Snapshot/i.test(f));
  const descFile = files.find((f) => /sct2_Description_Snapshot/i.test(f));
  if (!conceptFile || !descFile) {
    throw new Error(`RF2 snapshot files not found in ${dir} (need sct2_Concept_Snapshot* and sct2_Description_Snapshot*)`);
  }

  // Pass 1 — active concept ids.
  const active = new Set();
  {
    const rl = readline.createInterface({
      input: fs.createReadStream(path.join(dir, conceptFile)),
      crlfDelay: Infinity,
    });
    let first = true;
    for await (const line of rl) {
      if (first) { first = false; continue; }
      const cols = line.split('\t');
      if (cols[2] === '1') active.add(cols[0]);
    }
  }
  console.log(`RF2: ${active.size} active concepts`);

  // Pass 2 — active FSNs for active concepts.
  const batch = [];
  const seen = new Set();
  {
    const rl = readline.createInterface({
      input: fs.createReadStream(path.join(dir, descFile)),
      crlfDelay: Infinity,
    });
    let first = true;
    for await (const line of rl) {
      if (first) { first = false; continue; }
      const cols = line.split('\t');
      // id effectiveTime active moduleId conceptId languageCode typeId term caseSignificanceId
      if (cols[2] !== '1' || cols[6] !== SNOMED_FSN_TYPE) continue;
      const conceptId = cols[4];
      if (!active.has(conceptId) || seen.has(conceptId)) continue;
      seen.add(conceptId);
      const { display, tag } = splitFsn(cols[7]);
      if (!display) continue;
      batch.push({ code: conceptId, display, category: tag, semanticTag: tag });
      if (batch.length >= BATCH_SIZE) await flushBatch(client, 'SNOMED_CT', batch, stats, dryRun);
    }
  }
  await flushBatch(client, 'SNOMED_CT', batch, stats, dryRun);
}

async function main() {
  const args = parseArgs(process.argv);
  const systemKey = (args.system || '').toUpperCase();
  if (!VALID_SYSTEMS.has(systemKey)) {
    console.error(`--system must be one of ${[...VALID_SYSTEMS].join(', ')}`);
    process.exit(2);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const stats = { parsed: 0, written: 0 };
  const startedAt = Date.now();
  try {
    if (systemKey === 'SNOMED_CT' && args.rf2) {
      await importSnomedRf2(client, args.rf2, stats, args.dryRun);
    } else if (systemKey === 'LOINC' && args.loinc) {
      await importLoincCsv(client, args.loinc, stats, args.dryRun);
    } else if (args.csv) {
      await importGenericCsv(client, systemKey, args.csv, stats, args.dryRun);
    } else {
      console.error('Provide an input: --rf2 <dir> (SNOMED_CT), --loinc <Loinc.csv>, or --csv <file>');
      process.exit(2);
    }

    if (!args.dryRun) {
      await client.query(
        `UPDATE terminology_code_systems
            SET concept_count = (SELECT COUNT(*) FROM terminology_concepts WHERE system_key = $1),
                version = COALESCE($2, version),
                imported_at = NOW(),
                updated_at = NOW()
          WHERE system_key = $1`,
        [systemKey, args.version || null],
      );
    }
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `${args.dryRun ? '[dry-run] ' : ''}${systemKey}: parsed ${stats.parsed} concepts` +
      `${args.dryRun ? '' : `, upserted ${stats.written}`} in ${secs}s`,
    );
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
