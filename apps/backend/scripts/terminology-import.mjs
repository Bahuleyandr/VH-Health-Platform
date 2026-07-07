#!/usr/bin/env node
// terminology-import.mjs - roadmap B8 / NL-5 P1 content importer.
//
// Loads standard code-system releases into terminology_concepts. The
// licenses are free but the content is NOT redistributable in this repo,
// so the owner downloads the release files and points this script at them:
//
//   SNOMED CT (NRC India RF2 snapshot - free national license):
//     node scripts/terminology-import.mjs --system SNOMED_CT --rf2 path/to/Snapshot/Terminology --version <release>
//
//   LOINC (Regenstrief release):
//     node scripts/terminology-import.mjs --system LOINC --loinc path/to/Loinc.csv --version <release>
//
//   Generic code,display[,category] CSV (ICD10 / ICD11 / ATC or curated subsets):
//     node scripts/terminology-import.mjs --system ICD11 --csv path/to/icd11.csv --version <release>
//
//   SNOMED ExtendedMap RF2 refset (SNOMED -> ICD-10):
//     node scripts/terminology-import.mjs --system SNOMED_CT --rf2-map path/to/der2_iisssccRefset_ExtendedMapSnapshot.txt --version <release>
//
//   Generic map CSV:
//     node scripts/terminology-import.mjs --system ICD10 --map-csv path/to/maps.csv --version <release>
//
// Options: --version <release-label>  stamp terminology_code_systems.version and terminology_concepts.last_seen_release
//          --full                     after a concept import, mark missing concepts inactive for this system/release
//          --dry-run                  parse + provenance only, no concept/map/sweep writes
//
// Connection: DATABASE_URL (same env the backend uses).

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const VALID_SYSTEMS = new Set(['ICD10', 'ICD11', 'SNOMED_CT', 'LOINC', 'ATC']);
const VALID_RELATIONSHIPS = new Set(['equivalent', 'broader', 'narrower', 'related']);
const BATCH_SIZE = 500;
const SNOMED_FSN_TYPE = '900000000000003001';
const RF2_EXACT_MATCH_CORRELATION = '447561005';

const SYSTEM_ALIASES = Object.freeze({
  icd10: 'ICD10',
  'icd-10': 'ICD10',
  icd_10: 'ICD10',
  icd11: 'ICD11',
  'icd-11': 'ICD11',
  icd_11: 'ICD11',
  snomed: 'SNOMED_CT',
  snomedct: 'SNOMED_CT',
  'snomed-ct': 'SNOMED_CT',
  snomed_ct: 'SNOMED_CT',
  sct: 'SNOMED_CT',
  loinc: 'LOINC',
  atc: 'ATC',
});

function parseArgs(argv) {
  const args = { dryRun: false, full: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--system') args.system = argv[++i];
    else if (a === '--rf2') args.rf2 = argv[++i];
    else if (a === '--loinc') args.loinc = argv[++i];
    else if (a === '--csv') args.csv = argv[++i];
    else if (a === '--rf2-map') args.rf2Map = argv[++i];
    else if (a === '--map-csv') args.mapCsv = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--full') args.full = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function normalizeSystemKey(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (VALID_SYSTEMS.has(text)) return text;
  const lowered = text.toLowerCase();
  if (SYSTEM_ALIASES[lowered]) return SYSTEM_ALIASES[lowered];
  if (lowered.includes('snomed.info')) return 'SNOMED_CT';
  if (lowered.includes('loinc.org')) return 'LOINC';
  if (lowered.includes('icd-10')) return 'ICD10';
  if (lowered.includes('icd/release/11')) return 'ICD11';
  if (lowered.includes('whocc.no/atc')) return 'ATC';
  return null;
}

function normalizeRelationship(value) {
  const rel = String(value || 'equivalent').trim().toLowerCase();
  return VALID_RELATIONSHIPS.has(rel) ? rel : null;
}

function hasConceptInput(args) {
  return !!(args.rf2 || args.loinc || args.csv);
}

function hasMapInput(args) {
  return !!(args.rf2Map || args.mapCsv);
}

function sourceRefFor(args) {
  const refs = [];
  if (args.rf2) refs.push(`rf2:${args.rf2}`);
  if (args.loinc) refs.push(`loinc:${args.loinc}`);
  if (args.csv) refs.push(`csv:${args.csv}`);
  if (args.rf2Map) refs.push(`rf2-map:${args.rf2Map}`);
  if (args.mapCsv) refs.push(`map-csv:${args.mapCsv}`);
  return refs.join('; ');
}

function emptyStats() {
  return {
    conceptsParsed: 0,
    conceptsWritten: 0,
    mapsParsed: 0,
    mapsWritten: 0,
    skipped: 0,
    failed: 0,
    retired: 0,
  };
}

function totalProcessed(stats) {
  return stats.conceptsParsed + stats.mapsParsed;
}

function totalWritten(stats) {
  return stats.conceptsWritten + stats.mapsWritten;
}

async function createImportBatch(client, systemKey, args) {
  const metadata = {
    importer: 'terminology-import.mjs',
    dry_run: args.dryRun === true,
    full: args.full === true,
    inputs: {
      rf2: args.rf2 || null,
      loinc: args.loinc || null,
      csv: args.csv || null,
      rf2_map: args.rf2Map || null,
      map_csv: args.mapCsv || null,
    },
  };
  const rows = await client.query(
    `INSERT INTO terminology_import_batches
       (system_key, source_ref, release_label, status, started_at, metadata, updated_at)
     VALUES ($1, $2, $3, 'running', NOW(), $4::jsonb, NOW())
     RETURNING id`,
    [systemKey, sourceRefFor(args), args.version || null, JSON.stringify(metadata)],
  );
  return rows.rows[0].id;
}

async function finishImportBatch(client, batchId, status, stats, errorDetail = null) {
  await client.query(
    `UPDATE terminology_import_batches
        SET status = $2,
            rows_processed = $3,
            rows_inserted = $4,
            rows_skipped = $5,
            rows_failed = $6,
            error_detail = $7,
            finished_at = NOW(),
            updated_at = NOW(),
            metadata = metadata || $8::jsonb
      WHERE id = $1`,
    [
      batchId,
      status,
      totalProcessed(stats),
      totalWritten(stats),
      stats.skipped,
      stats.failed,
      errorDetail,
      JSON.stringify({
        concepts_written: stats.conceptsWritten,
        maps_written: stats.mapsWritten,
        retired: stats.retired,
      }),
    ],
  );
}

async function recordAuditEvent(client, { systemKey, action, summary, payload = {} }) {
  await client.query(
    `INSERT INTO terminology_audit_events (system_key, action, summary, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [systemKey, action, summary, JSON.stringify(payload)],
  );
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

// Strip the SNOMED FSN semantic tag: "Myocardial infarction (disorder)" ->
// { display: "Myocardial infarction", tag: "disorder" }.
export function splitFsn(term) {
  const m = /^(.*)\s+\(([^()]+)\)\s*$/.exec(term || '');
  if (!m) return { display: (term || '').trim(), tag: null };
  return { display: m[1].trim(), tag: m[2].trim() };
}

async function flushConceptBatch(client, systemKey, batch, stats, dryRun, { releaseLabel, batchId }) {
  if (batch.length === 0) return;
  stats.conceptsParsed += batch.length;
  if (dryRun) { batch.length = 0; return; }
  const values = [];
  const params = [];
  let p = 1;
  for (const row of batch) {
    values.push(`($${p}, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, 'active', $${p + 5}, $${p + 6})`);
    params.push(
      systemKey,
      row.code,
      row.display,
      row.category ?? null,
      row.semanticTag ?? null,
      releaseLabel || null,
      batchId,
    );
    p += 7;
  }
  const sql = `
    INSERT INTO terminology_concepts
      (system_key, code, display, category, semantic_tag, status, last_seen_release, last_import_batch_id)
    VALUES ${values.join(', ')}
    ON CONFLICT (system_key, code) DO UPDATE
      SET display = EXCLUDED.display,
          category = COALESCE(EXCLUDED.category, terminology_concepts.category),
          semantic_tag = COALESCE(EXCLUDED.semantic_tag, terminology_concepts.semantic_tag),
          status = 'active',
          last_seen_release = EXCLUDED.last_seen_release,
          last_import_batch_id = EXCLUDED.last_import_batch_id,
          updated_at = NOW()`;
  const res = await client.query(sql, params);
  stats.conceptsWritten += res.rowCount;
  batch.length = 0;
}

async function importGenericCsv(client, systemKey, filePath, stats, dryRun, batchContext) {
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
        else stats.skipped += 1;
        header = ['code', 'display', 'category'];
      }
      continue;
    }
    const row = Object.fromEntries(header.map((h, i) => [h, cols[i]]));
    const code = row.code?.trim();
    const display = row.display?.trim();
    if (!code || !display) {
      stats.skipped += 1;
      continue;
    }
    batch.push({ code, display, category: row.category?.trim() || null });
    if (batch.length >= BATCH_SIZE) {
      await flushConceptBatch(client, systemKey, batch, stats, dryRun, batchContext);
    }
  }
  await flushConceptBatch(client, systemKey, batch, stats, dryRun, batchContext);
}

async function importLoincCsv(client, filePath, stats, dryRun, batchContext) {
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
    if (status && status !== 'ACTIVE') {
      stats.skipped += 1;
      continue;
    }
    const code = cols[idx.code]?.trim();
    const display = cols[idx.longName]?.trim() || cols[idx.component]?.trim();
    if (!code || !display) {
      stats.skipped += 1;
      continue;
    }
    batch.push({ code, display, category: idx.klass >= 0 ? cols[idx.klass]?.trim() || null : null });
    if (batch.length >= BATCH_SIZE) {
      await flushConceptBatch(client, 'LOINC', batch, stats, dryRun, batchContext);
    }
  }
  await flushConceptBatch(client, 'LOINC', batch, stats, dryRun, batchContext);
}

async function importSnomedRf2(client, dir, stats, dryRun, batchContext) {
  const files = fs.readdirSync(dir);
  const conceptFile = files.find((f) => /sct2_Concept_Snapshot/i.test(f));
  const descFile = files.find((f) => /sct2_Description_Snapshot/i.test(f));
  if (!conceptFile || !descFile) {
    throw new Error(`RF2 snapshot files not found in ${dir} (need sct2_Concept_Snapshot* and sct2_Description_Snapshot*)`);
  }

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
      if (!display) {
        stats.skipped += 1;
        continue;
      }
      batch.push({ code: conceptId, display, category: tag, semanticTag: tag });
      if (batch.length >= BATCH_SIZE) {
        await flushConceptBatch(client, 'SNOMED_CT', batch, stats, dryRun, batchContext);
      }
    }
  }
  await flushConceptBatch(client, 'SNOMED_CT', batch, stats, dryRun, batchContext);
}

async function flushMapBatch(client, batch, stats, dryRun) {
  if (batch.length === 0) return;
  stats.mapsParsed += batch.length;
  if (dryRun) { batch.length = 0; return; }
  const values = [];
  const params = [];
  let p = 1;
  for (const row of batch) {
    values.push(`($${p}, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6}::jsonb)`);
    params.push(
      row.fromSystem,
      row.fromCode,
      row.toSystem,
      row.toCode,
      row.relationship,
      row.context,
      JSON.stringify(row.metadata || {}),
    );
    p += 7;
  }
  const sql = `
    INSERT INTO terminology_concept_maps
      (source_system, source_code, target_system, target_code, relationship, context, metadata)
    VALUES ${values.join(', ')}
    ON CONFLICT (source_system, source_code, target_system, target_code, relationship)
    DO UPDATE SET
      context = EXCLUDED.context,
      metadata = terminology_concept_maps.metadata || EXCLUDED.metadata`;
  const res = await client.query(sql, params);
  stats.mapsWritten += res.rowCount;
  batch.length = 0;
}

function mapRelationshipFromRf2(correlationId) {
  return correlationId === RF2_EXACT_MATCH_CORRELATION ? 'equivalent' : 'related';
}

function resolveRf2MapPath(inputPath) {
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) return inputPath;
  const files = fs.readdirSync(inputPath);
  const match = files.find((f) => /ExtendedMap.*Snapshot/i.test(f))
    || files.find((f) => /Map.*Snapshot/i.test(f));
  if (!match) {
    throw new Error(`RF2 map snapshot file not found in ${inputPath} (need *ExtendedMap*Snapshot* or *Map*Snapshot*)`);
  }
  return path.join(inputPath, match);
}

async function importRf2Map(client, filePathOrDir, stats, dryRun) {
  const filePath = resolveRf2MapPath(filePathOrDir);
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  const batch = [];
  let header = null;
  let idx = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (!header) {
      header = cols.map((c) => c.trim());
      idx = {
        id: header.indexOf('id'),
        effectiveTime: header.indexOf('effectiveTime'),
        active: header.indexOf('active'),
        refsetId: header.indexOf('refsetId'),
        referencedComponentId: header.indexOf('referencedComponentId'),
        mapGroup: header.indexOf('mapGroup'),
        mapPriority: header.indexOf('mapPriority'),
        mapRule: header.indexOf('mapRule'),
        mapAdvice: header.indexOf('mapAdvice'),
        mapTarget: header.indexOf('mapTarget'),
        correlationId: header.indexOf('correlationId'),
        mapCategoryId: header.indexOf('mapCategoryId'),
      };
      if (idx.referencedComponentId === -1 || idx.mapTarget === -1) {
        throw new Error('Not an RF2 ExtendedMap snapshot: referencedComponentId / mapTarget columns missing');
      }
      continue;
    }
    if (idx.active >= 0 && cols[idx.active] !== '1') {
      stats.skipped += 1;
      continue;
    }
    const fromCode = cols[idx.referencedComponentId]?.trim();
    const toCode = cols[idx.mapTarget]?.trim();
    if (!fromCode || !toCode) {
      stats.skipped += 1;
      continue;
    }
    const correlationId = idx.correlationId >= 0 ? cols[idx.correlationId]?.trim() : null;
    batch.push({
      fromSystem: 'SNOMED_CT',
      fromCode,
      toSystem: 'ICD10',
      toCode,
      relationship: mapRelationshipFromRf2(correlationId),
      context: 'rf2_extended_map',
      metadata: {
        source: 'rf2_extended_map',
        rf2_id: idx.id >= 0 ? cols[idx.id] || null : null,
        effective_time: idx.effectiveTime >= 0 ? cols[idx.effectiveTime] || null : null,
        refset_id: idx.refsetId >= 0 ? cols[idx.refsetId] || null : null,
        map_group: idx.mapGroup >= 0 ? cols[idx.mapGroup] || null : null,
        map_priority: idx.mapPriority >= 0 ? cols[idx.mapPriority] || null : null,
        map_rule: idx.mapRule >= 0 ? cols[idx.mapRule] || null : null,
        map_advice: idx.mapAdvice >= 0 ? cols[idx.mapAdvice] || null : null,
        correlation_id: correlationId,
        map_category_id: idx.mapCategoryId >= 0 ? cols[idx.mapCategoryId] || null : null,
      },
    });
    if (batch.length >= BATCH_SIZE) await flushMapBatch(client, batch, stats, dryRun);
  }
  await flushMapBatch(client, batch, stats, dryRun);
}

async function importGenericMapCsv(client, filePath, stats, dryRun) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  const batch = [];
  let header = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (!header) {
      header = cols.map((c) => c.trim().toLowerCase());
      for (const required of ['from_system', 'from_code', 'to_system', 'to_code']) {
        if (!header.includes(required)) {
          throw new Error(`Generic map CSV missing required column: ${required}`);
        }
      }
      continue;
    }
    const row = Object.fromEntries(header.map((h, i) => [h, cols[i]]));
    const fromSystem = normalizeSystemKey(row.from_system);
    const toSystem = normalizeSystemKey(row.to_system);
    const relationship = normalizeRelationship(row.relationship || 'equivalent');
    const fromCode = row.from_code?.trim();
    const toCode = row.to_code?.trim();
    if (!fromSystem || !toSystem || !relationship || !fromCode || !toCode) {
      stats.skipped += 1;
      continue;
    }
    batch.push({
      fromSystem,
      fromCode,
      toSystem,
      toCode,
      relationship,
      context: row.context?.trim() || 'generic_map_csv',
      metadata: { source: 'generic_map_csv' },
    });
    if (batch.length >= BATCH_SIZE) await flushMapBatch(client, batch, stats, dryRun);
  }
  await flushMapBatch(client, batch, stats, dryRun);
}

async function retireMissingConcepts(client, systemKey, releaseLabel, batchId, stats, dryRun) {
  if (!releaseLabel) {
    throw new Error('--full requires --version so the retirement sweep has a release boundary');
  }
  const count = await client.query(
    `SELECT COUNT(*)::int AS count
       FROM terminology_concepts
      WHERE system_key = $1
        AND status = 'active'
        AND last_seen_release IS DISTINCT FROM $2`,
    [systemKey, releaseLabel],
  );
  const retireCount = Number(count.rows[0]?.count) || 0;
  if (dryRun || retireCount === 0) {
    stats.retired += retireCount;
    return;
  }
  const res = await client.query(
    `UPDATE terminology_concepts
        SET status = 'inactive',
            last_import_batch_id = $3,
            updated_at = NOW()
      WHERE system_key = $1
        AND status = 'active'
        AND last_seen_release IS DISTINCT FROM $2`,
    [systemKey, releaseLabel, batchId],
  );
  stats.retired += res.rowCount;
}

async function refreshCodeSystem(client, systemKey, version) {
  await client.query(
    `UPDATE terminology_code_systems
        SET concept_count = (SELECT COUNT(*) FROM terminology_concepts WHERE system_key = $1),
            version = COALESCE($2, version),
            imported_at = NOW(),
            updated_at = NOW()
      WHERE system_key = $1`,
    [systemKey, version || null],
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const systemKey = normalizeSystemKey(args.system);
  if (!systemKey) {
    console.error(`--system must be one of ${[...VALID_SYSTEMS].join(', ')}`);
    process.exit(2);
  }
  if (!hasConceptInput(args) && !hasMapInput(args)) {
    console.error('Provide an input: --rf2 <dir>, --loinc <Loinc.csv>, --csv <file>, --rf2-map <file|dir>, or --map-csv <file>');
    process.exit(2);
  }
  if (args.rf2 && systemKey !== 'SNOMED_CT') {
    console.error('--rf2 concept imports require --system SNOMED_CT');
    process.exit(2);
  }
  if (args.loinc && systemKey !== 'LOINC') {
    console.error('--loinc imports require --system LOINC');
    process.exit(2);
  }
  if (args.full && !hasConceptInput(args)) {
    console.error('--full can only be used with a concept import input (--rf2, --loinc, or --csv)');
    process.exit(2);
  }
  if (args.full && !args.version) {
    console.error('--full requires --version <release-label>');
    process.exit(2);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const stats = emptyStats();
  const startedAt = Date.now();
  let batchId = null;
  try {
    batchId = await createImportBatch(client, systemKey, args);
    const batchContext = {
      releaseLabel: args.version || null,
      batchId,
    };

    if (systemKey === 'SNOMED_CT' && args.rf2) {
      await importSnomedRf2(client, args.rf2, stats, args.dryRun, batchContext);
    } else if (systemKey === 'LOINC' && args.loinc) {
      await importLoincCsv(client, args.loinc, stats, args.dryRun, batchContext);
    } else if (args.csv) {
      await importGenericCsv(client, systemKey, args.csv, stats, args.dryRun, batchContext);
    }

    if (args.rf2Map) {
      await importRf2Map(client, args.rf2Map, stats, args.dryRun);
    }
    if (args.mapCsv) {
      await importGenericMapCsv(client, args.mapCsv, stats, args.dryRun);
    }

    if (args.full) {
      await retireMissingConcepts(client, systemKey, args.version, batchId, stats, args.dryRun);
    }

    if (!args.dryRun && hasConceptInput(args)) {
      await refreshCodeSystem(client, systemKey, args.version || null);
    }

    const status = stats.failed > 0 ? 'partial' : 'completed';
    await finishImportBatch(client, batchId, status, stats);
    await recordAuditEvent(client, {
      systemKey,
      action: args.full ? 'TERMINOLOGY_FULL_IMPORT_COMPLETED' : 'TERMINOLOGY_IMPORT_COMPLETED',
      summary: `${systemKey} terminology import ${status}`,
      payload: {
        batch_id: String(batchId),
        release_label: args.version || null,
        dry_run: args.dryRun === true,
        full: args.full === true,
        concepts_written: stats.conceptsWritten,
        maps_written: stats.mapsWritten,
        retired: stats.retired,
      },
    });

    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `${args.dryRun ? '[dry-run] ' : ''}${systemKey}: parsed ${stats.conceptsParsed} concepts` +
      `${args.dryRun ? '' : `, upserted ${stats.conceptsWritten}`}` +
      `, parsed ${stats.mapsParsed} maps` +
      `${args.dryRun ? '' : `, upserted ${stats.mapsWritten} maps`}` +
      `${args.full ? `, retired ${stats.retired}` : ''}` +
      ` in ${secs}s (batch ${batchId})`,
    );
  } catch (err) {
    stats.failed += 1;
    if (batchId) {
      await finishImportBatch(client, batchId, 'failed', stats, err.message || String(err));
    }
    throw err;
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
