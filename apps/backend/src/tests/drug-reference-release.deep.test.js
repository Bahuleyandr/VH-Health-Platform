/**
 * Deep test: aushadhi-data release consumption in scripts/import-drug-reference.mjs.
 * Covers: latest-release resolution, fail-closed manifest verification
 * (schema_version, release_date/dir match, compressed sha256/size, decompressed
 * sha256/size/record count), streaming zstd decompress to an artifact dir, and
 * an idempotent importCompositions run over the extracted artifact.
 *
 * Fixture releases are generated programmatically: a tiny drugs.jsonl is
 * zstd-compressed with Node's built-in zlib and the manifest carries the real
 * hashes, so the happy path exercises the same verification code as prod.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import pg from 'pg';
import {
  resolveRelease,
  verifyAndExtractRelease,
  importCompositions,
} from '../../scripts/import-drug-reference.mjs';

// CI provides DATABASE_URL (postgres service); local QA runs export TEST_DATABASE_URL.
// The bare-port fallback only serves ad-hoc local runs against the QA cluster.
const CONN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgresql://postgres:postgres@127.0.0.1:55432/vhhealth_test';
const MARK = 'drugrel-test';

const ROWS = [
  {
    brand_name: `Azithral 250 Tablet (${MARK})`, manufacturer: 'Alembic Pharmaceuticals Ltd',
    pack_label: 'strip of 5 tablets', form_raw: null, price_inr: 71, is_discontinued: false,
    ingredients: [{ molecule: 'relazithromycin', strength_value: 250, strength_unit: 'mg', strength_raw: '250mg' }],
    composition_raw: 'Relazithromycin (250mg)', composition_status: 'complete', substitutes_raw: [],
    type: 'allopathy', sources: [{ source: 'github-jr', source_id: '2', seen_at: '2026-07-07' }],
    first_seen: '2026-07-07', last_seen: '2026-07-07',
  },
  {
    brand_name: `Relmentin 625 Tablet (${MARK})`, manufacturer: 'GlaxoSmithKline',
    pack_label: 'strip of 10 tablets', form_raw: null, price_inr: 223, is_discontinued: false,
    ingredients: [
      { molecule: 'relamoxycillin', strength_value: 500, strength_unit: 'mg', strength_raw: '500mg' },
      { molecule: 'relclavulanic acid', strength_value: 125, strength_unit: 'mg', strength_raw: '125mg' }],
    composition_raw: 'Relamoxycillin (500mg) + Relclavulanic Acid (125mg)', composition_status: 'complete',
    substitutes_raw: [], type: 'allopathy', sources: [{ source: 'github-jr', source_id: '1', seen_at: '2026-07-07' }],
    first_seen: '2026-07-07', last_seen: '2026-07-07',
  },
  { // non-allopathy -> filtered by the existing import stage
    brand_name: `Herbal Tonic (${MARK})`, manufacturer: 'X', pack_label: 'bottle',
    form_raw: null, price_inr: 10, is_discontinued: false,
    ingredients: [{ molecule: 'relashwagandha', strength_value: null, strength_unit: null, strength_raw: null }],
    composition_raw: 'Relashwagandha', composition_status: 'complete', substitutes_raw: [],
    type: 'ayurvedic', sources: [{ source: 'github-jr', source_id: '3', seen_at: '2026-07-07' }],
    first_seen: '2026-07-07', last_seen: '2026-07-07',
  },
];
const JSONL = ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n';
const IMPORT_KEYS = ['relazithromycin', 'relamoxycillin+relclavulanic_acid'];

const LATEST = '2026-08-02';
const OLDER = '2026-07-26';

let repoDir;
let client;
const extractDirs = [];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Write releases/<date>/{drugs.jsonl.zst, manifest.json} with REAL hashes,
// then let the caller break one specific thing.
function writeRelease(root, date, { jsonl = JSONL, corruptArtifact = false, mutateManifest = null } = {}) {
  const dir = path.join(root, 'releases', date);
  fs.mkdirSync(dir, { recursive: true });
  const source = Buffer.from(jsonl);
  let artifact = zlib.zstdCompressSync(source);
  const manifest = {
    schema_version: 1,
    dataset: 'Aushadhi generated drug-product export',
    release_date: date,
    generated_at_utc: `${date}T03:00:00+00:00`,
    source: {
      host: 'test', path: `/var/lib/aushadhi/dist/${date}/drugs.jsonl`, format: 'jsonl',
      record_count: jsonl.split('\n').filter((l) => l.length).length,
      size_bytes: source.length,
      sha256: sha256(source),
    },
    artifact: {
      path: `releases/${date}/drugs.jsonl.zst`, format: 'zstd-compressed jsonl',
      size_bytes: artifact.length,
      sha256: sha256(artifact),
    },
  };
  if (corruptArtifact) {
    // flip a byte AFTER hashing so size matches but the sha256 does not
    artifact = Buffer.from(artifact);
    artifact[artifact.length - 1] ^= 0xff;
  }
  if (mutateManifest) mutateManifest(manifest);
  fs.writeFileSync(path.join(dir, 'drugs.jsonl.zst'), artifact);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drugrel-repo-'));
  extractDirs.push(dir);
  return dir;
}

function tmpOut() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drugrel-out-'));
  extractDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  client = new pg.Client({ connectionString: CONN });
  await client.connect();
  repoDir = tmpRepo();
  writeRelease(repoDir, OLDER);
  writeRelease(repoDir, LATEST);
});

afterAll(async () => {
  await client.query('DELETE FROM drug_compositions WHERE composition_key = ANY($1::text[])', [IMPORT_KEYS]);
  for (const dir of extractDirs) fs.rmSync(dir, { recursive: true, force: true });
  await client.end();
});

describe('resolveRelease', () => {
  test('latest = lexicographically greatest YYYY-MM-DD dir', () => {
    const r = resolveRelease(repoDir);
    expect(r.releaseDate).toBe(LATEST);
    expect(r.releaseDir).toBe(path.join(repoDir, 'releases', LATEST));
  });

  test('explicit date picks that release; unknown or malformed date throws', () => {
    const r = resolveRelease(repoDir, OLDER);
    expect(r.releaseDate).toBe(OLDER);
    expect(() => resolveRelease(repoDir, '2026-01-01')).toThrow(/not found/);
    expect(() => resolveRelease(repoDir, 'latest')).toThrow(/YYYY-MM-DD/);
    expect(() => resolveRelease(path.join(repoDir, 'nope'))).toThrow(/no releases/);
  });
});

describe('verifyAndExtractRelease', () => {
  test('happy path: verifies manifest + hashes and streams out an identical drugs.jsonl', async () => {
    const outDir = tmpOut();
    const rel = await verifyAndExtractRelease(repoDir, { outDir });
    expect(rel.releaseDate).toBe(LATEST);
    expect(rel.artifactDir).toBe(outDir);
    expect(rel.decompressed.records).toBe(3);
    expect(rel.decompressed.sha256).toBe(sha256(Buffer.from(JSONL)));
    expect(fs.readFileSync(path.join(outDir, 'drugs.jsonl'), 'utf8')).toBe(JSONL);
  });

  test('compressed sha256 mismatch aborts before decompression, nothing extracted', async () => {
    const repo = tmpRepo();
    writeRelease(repo, LATEST, { corruptArtifact: true });
    const outDir = tmpOut();
    await expect(verifyAndExtractRelease(repo, { outDir })).rejects.toThrow(/compressed sha256 mismatch/);
    expect(fs.existsSync(path.join(outDir, 'drugs.jsonl'))).toBe(false);
  });

  test('decompressed sha256 mismatch aborts and removes the extracted file', async () => {
    const repo = tmpRepo();
    writeRelease(repo, LATEST, { mutateManifest: (m) => { m.source.sha256 = '0'.repeat(64); } });
    const outDir = tmpOut();
    await expect(verifyAndExtractRelease(repo, { outDir })).rejects.toThrow(/decompressed sha256 mismatch/);
    expect(fs.existsSync(path.join(outDir, 'drugs.jsonl'))).toBe(false);
  });

  test('record count mismatch aborts and removes the extracted file', async () => {
    const repo = tmpRepo();
    writeRelease(repo, LATEST, { mutateManifest: (m) => { m.source.record_count += 1; } });
    const outDir = tmpOut();
    await expect(verifyAndExtractRelease(repo, { outDir })).rejects.toThrow(/record count mismatch/);
    expect(fs.existsSync(path.join(outDir, 'drugs.jsonl'))).toBe(false);
  });

  test('release_date not matching the directory name aborts', async () => {
    const repo = tmpRepo();
    writeRelease(repo, LATEST, { mutateManifest: (m) => { m.release_date = OLDER; } });
    await expect(verifyAndExtractRelease(repo, { outDir: tmpOut() })).rejects.toThrow(/release_date/);
  });

  test('unsupported schema_version aborts', async () => {
    const repo = tmpRepo();
    writeRelease(repo, LATEST, { mutateManifest: (m) => { m.schema_version = 2; } });
    await expect(verifyAndExtractRelease(repo, { outDir: tmpOut() })).rejects.toThrow(/schema_version/);
  });
});

describe('release -> import stage', () => {
  test('importCompositions over an extracted release is idempotent', async () => {
    const rel = await verifyAndExtractRelease(repoDir, { outDir: tmpOut() });

    const s1 = await importCompositions(rel.artifactDir, { connectionString: CONN });
    expect(s1.rows).toBe(3);
    expect(s1.eligible).toBe(2); // ayurvedic row filtered by the existing stage
    expect(s1.errors).toBe(0);

    const rows1 = (await client.query(
      'SELECT composition_key, source FROM drug_compositions WHERE composition_key = ANY($1::text[]) ORDER BY composition_key',
      [IMPORT_KEYS],
    )).rows;
    expect(rows1.map((r) => r.composition_key).sort()).toEqual([...IMPORT_KEYS].sort());
    expect(rows1.every((r) => r.source === 'imported')).toBe(true);

    // idempotent re-run: same stats shape, no duplicate rows
    const s2 = await importCompositions(rel.artifactDir, { connectionString: CONN });
    expect(s2.errors).toBe(0);
    const count = (await client.query(
      'SELECT COUNT(*)::int AS n FROM drug_compositions WHERE composition_key = ANY($1::text[])',
      [IMPORT_KEYS],
    )).rows[0];
    expect(count.n).toBe(IMPORT_KEYS.length);
  });
});
