// Imports the aushadhi India drug reference artifact (dist/<date>/drugs.jsonl)
// into the composition layer:
//   --compositions <artifact-dir>              upsert unique compositions (source='imported')
//   --match-catalog <artifact-dir> --tenant X  exact-brand-match pharmacy_catalog rows
//   --stats [--tenant X]                       coverage report vs the acceptance gate
//   --release <aushadhi-data-dir> [--date YYYY-MM-DD] [--compositions] [--match-catalog --tenant X]
//       resolve a release from an aushadhi-data checkout
//       (releases/<YYYY-MM-DD>/{drugs.jsonl.zst, manifest.json}; latest = max
//       date dir), verify it fail-closed against the manifest (compressed
//       sha256+size, then decompressed sha256+size+record count), stream-
//       decompress to a temp artifact dir, and feed the existing stages.
//       With no stage flag it verifies only and writes nothing to the DB.
// All canonicalization goes through the platform's compositionParser — the
// artifact never carries VH Health keys (thin-builder/smart-importer contract).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import pg from 'pg';
import { compositionKey, parseStrength, parseForm } from '../src/services/pharmacy/compositionParser.js';
import { strengthSignature, resolveImportStrength } from '../src/services/pharmacy/verifiedStrengthFill.js';

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

// ---------------------------------------------------------------------------
// aushadhi-data release consumption.
// A release is releases/<YYYY-MM-DD>/{drugs.jsonl.zst, manifest.json} inside a
// checkout of the private aushadhi-data repo (its git-based release channel —
// no tags, no GitHub Releases). Verification is fail-closed: any mismatch
// aborts before anything is handed to an import stage, so nothing reaches the
// DB from an unverified artifact. Decompression is streaming (the decompressed
// JSONL is ~533 MB — never buffered whole) via Node's built-in zlib zstd
// support (>=22.15 / >=23.8; the backend pins Node 26).
// ---------------------------------------------------------------------------

const RELEASE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Pick a release dir: explicit --date, or "latest" = lexicographically max
// YYYY-MM-DD directory under releases/ (the repo has no latest pointer).
export function resolveRelease(repoDir, date = null) {
  const releasesRoot = path.join(repoDir, 'releases');
  if (!fs.existsSync(releasesRoot)) throw new Error(`no releases/ directory under ${repoDir}`);
  if (date !== null) {
    if (!RELEASE_DATE_RE.test(date)) throw new Error(`release date must be YYYY-MM-DD, got: ${date}`);
    const releaseDir = path.join(releasesRoot, date);
    if (!fs.existsSync(releaseDir)) throw new Error(`release ${date} not found under ${releasesRoot}`);
    return { releaseDate: date, releaseDir };
  }
  const dates = fs.readdirSync(releasesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && RELEASE_DATE_RE.test(d.name))
    .map((d) => d.name)
    .sort();
  if (!dates.length) throw new Error(`no YYYY-MM-DD release directories under ${releasesRoot}`);
  const releaseDate = dates[dates.length - 1];
  return { releaseDate, releaseDir: path.join(releasesRoot, releaseDate) };
}

// Streaming SHA-256 + byte count of a file (never buffers the file whole).
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    fs.createReadStream(file)
      .on('data', (chunk) => { hash.update(chunk); bytes += chunk.length; })
      .on('error', reject)
      .on('end', () => resolve({ sha256: hash.digest('hex'), bytes }));
  });
}

// Streaming zstd decompress zstFile -> outFile while computing the decompressed
// SHA-256, byte count, and record count (JSONL lines; a trailing unterminated
// line still counts as a record).
export async function decompressZstd(zstFile, outFile) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let newlines = 0;
  let lastByte = null;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      let i = chunk.indexOf(0x0a);
      while (i !== -1) { newlines += 1; i = chunk.indexOf(0x0a, i + 1); }
      if (chunk.length) lastByte = chunk[chunk.length - 1];
      cb(null, chunk);
    },
  });
  await pipeline(
    fs.createReadStream(zstFile),
    zlib.createZstdDecompress(),
    counter,
    fs.createWriteStream(outFile),
  );
  const records = newlines + (bytes > 0 && lastByte !== 0x0a ? 1 : 0);
  return { sha256: hash.digest('hex'), bytes, records };
}

// Resolve + verify + decompress a release into an artifact dir the existing
// stages can consume. Verification order (all fail-closed):
//   1. manifest schema_version === 1
//   2. manifest release_date matches the release directory name
//   3. compressed drugs.jsonl.zst sha256 + size vs manifest.artifact.*
//   4. decompress (streaming)
//   5. decompressed sha256 + size + record count vs manifest.source.*
// On any mismatch the partial decompressed file is removed and the error is
// thrown before any import stage runs.
export async function verifyAndExtractRelease(repoDir, { date = null, outDir = null, log = () => {} } = {}) {
  const { releaseDate, releaseDir } = resolveRelease(repoDir, date);
  const manifestPath = path.join(releaseDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  log(`release ${releaseDate}: manifest ${manifestPath}`);

  if (manifest.schema_version !== 1) {
    throw new Error(`unsupported manifest schema_version ${JSON.stringify(manifest.schema_version)} (expected 1) in ${manifestPath}`);
  }
  if (manifest.release_date !== releaseDate) {
    throw new Error(`manifest release_date ${JSON.stringify(manifest.release_date)} does not match release directory ${releaseDate}`);
  }

  const zstFile = path.join(releaseDir, 'drugs.jsonl.zst');
  if (!fs.existsSync(zstFile)) throw new Error(`artifact not found: ${zstFile}`);
  const compressed = await sha256File(zstFile);
  if (compressed.sha256 !== manifest.artifact?.sha256) {
    throw new Error(`compressed sha256 mismatch for ${zstFile}: got ${compressed.sha256}, manifest artifact.sha256 ${manifest.artifact?.sha256}`);
  }
  if (compressed.bytes !== manifest.artifact?.size_bytes) {
    throw new Error(`compressed size mismatch for ${zstFile}: got ${compressed.bytes}, manifest artifact.size_bytes ${manifest.artifact?.size_bytes}`);
  }
  log(`release ${releaseDate}: compressed artifact verified (sha256 ${compressed.sha256.slice(0, 12)}…, ${compressed.bytes} bytes)`);

  const artifactDir = outDir ?? fs.mkdtempSync(path.join(os.tmpdir(), `aushadhi-release-${releaseDate}-`));
  fs.mkdirSync(artifactDir, { recursive: true });
  const outFile = path.join(artifactDir, 'drugs.jsonl');
  let decompressed;
  try {
    decompressed = await decompressZstd(zstFile, outFile);
    if (decompressed.sha256 !== manifest.source?.sha256) {
      throw new Error(`decompressed sha256 mismatch for ${outFile}: got ${decompressed.sha256}, manifest source.sha256 ${manifest.source?.sha256}`);
    }
    if (decompressed.bytes !== manifest.source?.size_bytes) {
      throw new Error(`decompressed size mismatch for ${outFile}: got ${decompressed.bytes}, manifest source.size_bytes ${manifest.source?.size_bytes}`);
    }
    if (decompressed.records !== manifest.source?.record_count) {
      throw new Error(`record count mismatch for ${outFile}: got ${decompressed.records}, manifest source.record_count ${manifest.source?.record_count}`);
    }
  } catch (e) {
    // Never leave an unverified artifact behind for a later stage to consume.
    fs.rmSync(outFile, { force: true });
    throw e;
  }
  log(`release ${releaseDate}: decompressed artifact verified (sha256 ${decompressed.sha256.slice(0, 12)}…, ${decompressed.bytes} bytes, ${decompressed.records} records) -> ${artifactDir}`);
  return { releaseDate, releaseDir, artifactDir, manifest, compressed, decompressed };
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

// Index normBrand(alias) -> { molecules, ambiguous } from the prescribable.jsonl VERIFIED
// layer. A brand mapping to more than one distinct verified strength (e.g. 250 and 500
// variants) is ambiguous → never filled. IO lives here; the pure fill/agree logic lives
// in verifiedStrengthFill.js so it is unit-testable without the `pg` driver.
export async function loadVerifiedStrengthIndex(artifactDir) {
  const file = `${artifactDir}/prescribable.jsonl`;
  const index = new Map();
  if (!fs.existsSync(file)) return index;
  const bySig = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (!rec.strength_verified || !Array.isArray(rec.molecules) || rec.molecules.length === 0) continue;
    if (!rec.molecules.every((m) => typeof m.strength_value === 'number' && Number.isFinite(m.strength_value))) continue;
    const sig = strengthSignature(rec.molecules);
    for (const alias of rec.brand_aliases ?? []) {
      const k = normBrand(alias);
      if (!k) continue;
      let sm = bySig.get(k); if (!sm) { sm = new Map(); bySig.set(k, sm); }
      if (!sm.has(sig)) sm.set(sig, rec.molecules);
    }
  }
  for (const [k, sm] of bySig) {
    index.set(k, sm.size === 1 ? { molecules: [...sm.values()][0], ambiguous: false } : { molecules: null, ambiguous: true });
  }
  return index;
}

export async function matchCatalog(artifactDir, { tenantId, connectionString } = {}) {
  if (!tenantId) throw new Error('matchCatalog requires tenantId (curation queue tenant_id has no default)');
  const client = connectionString ? new pg.Client({ connectionString }) : connect();
  await client.connect();
  const stats = { catalogRows: 0, matched: 0, ambiguous: 0, unmatched: 0, skippedProtected: 0, strengthFilled: 0, strengthMismatch: 0 };
  try {
    const index = await loadBrandIndex(artifactDir);
    const verifiedIndex = await loadVerifiedStrengthIndex(artifactDir);
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
        // Strength from the platform parser over the CATALOG row's own name; when the
        // name carries NO strength, FILL from Aushadhi's plausibility-verified strengths
        // (never a guess) so the alternatives endpoint can confirm substitutes. Form is
        // always from the catalog name. Structured keys only — never the pharmacist text.
        const { strength, provenance, mismatch, verifiedStrength } = resolveImportStrength(
          { catalogName: row.name, compKey: comp.key, verified: verifiedIndex.get(normBrand(row.name)) },
          { parseStrength, compositionKey },
        );
        if (provenance === 'aushadhi_verified') stats.strengthFilled += 1;
        if (mismatch) stats.strengthMismatch += 1;
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
            `drug-reference exact brand match (${candidates[0].sources?.map((s) => s.source).join(';') ?? 'artifact'}); strength=${provenance}${mismatch ? '; STRENGTH_MISMATCH_REVIEW' : ''}`],
        );
        // A catalog-name strength that disagrees with Aushadhi's verified value is KEPT
        // (never silently overwrite the pharmacist) but queued for human curation.
        if (mismatch) {
          await client.query(
            `INSERT INTO drug_composition_curation_queue (tenant_id, catalog_id, reason, status, parser_output)
             VALUES ($1::uuid,$2,'strength_mismatch','open',$3)
             ON CONFLICT (tenant_id, catalog_id) DO UPDATE
               SET reason=EXCLUDED.reason, parser_output=EXCLUDED.parser_output, updated_at=NOW()`,
            [row.tenant_id, row.id, JSON.stringify({
              brand: row.name,
              catalog_strength: strength.display ?? null,
              aushadhi_verified_strength: verifiedStrength?.display ?? null,
            })],
          );
        }
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
    if (typeof flag('release') === 'string') {
      // Release mode: resolve + verify + decompress an aushadhi-data checkout,
      // then feed the extracted artifact dir to whichever stages were asked
      // for. No stage flag = verify only (nothing written to the DB).
      const date = typeof flag('date') === 'string' ? flag('date') : null;
      const rel = await verifyAndExtractRelease(flag('release'), { date, log: console.log });
      try {
        let ranStage = false;
        if (flag('compositions')) {
          ranStage = true;
          const s = await importCompositions(rel.artifactDir);
          console.log(`compositions: ${JSON.stringify(s)}`);
        }
        if (flag('match-catalog')) {
          ranStage = true;
          const s = await matchCatalog(rel.artifactDir, { tenantId: flag('tenant') });
          console.log(`match-catalog: ${JSON.stringify(s)}`);
        }
        if (!ranStage) {
          console.log(`release ${rel.releaseDate}: verified only — add --compositions and/or --match-catalog --tenant <uuid> to import`);
        }
      } finally {
        fs.rmSync(rel.artifactDir, { recursive: true, force: true });
      }
    } else if (flag('compositions')) {
      const s = await importCompositions(flag('compositions'));
      console.log(`compositions: ${JSON.stringify(s)}`);
    } else if (flag('match-catalog')) {
      const s = await matchCatalog(flag('match-catalog'), { tenantId: flag('tenant') });
      console.log(`match-catalog: ${JSON.stringify(s)}`);
    } else if (flag('stats')) {
      const s = await coverageStats({ tenantId: typeof flag('tenant') === 'string' ? flag('tenant') : undefined });
      console.log(`coverage: ${JSON.stringify(s)}`);
    } else {
      console.log('usage: node scripts/import-drug-reference.mjs --compositions <dir> | --match-catalog <dir> --tenant <uuid> | --stats [--tenant <uuid>] | --release <aushadhi-data-dir> [--date YYYY-MM-DD] [--compositions] [--match-catalog --tenant <uuid>]');
    }
  };
  run().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
}
