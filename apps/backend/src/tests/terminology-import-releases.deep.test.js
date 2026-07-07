import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import prisma from '../lib/prisma.js';
import { validateCode } from '../services/terminology/terminologyService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const RELEASE_DRY = 'NL5P1_DRY';
const RELEASE_V1 = 'NL5P1_V1';
const RELEASE_V2 = 'NL5P1_V2';
const RELEASE_LOINC = 'NL5P1_LOINC';
const RELEASE_SNOMED = 'NL5P1_SNOMED';
const RELEASE_MAPS = 'NL5P1_MAPS';
const MARKER = 'NL5P1';

let tmpDir;
let preFullIcd10Rows = [];

function writeFixture(name, body) {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, body, 'utf8');
  return filePath;
}

function runImporter(args) {
  const result = spawnSync(process.execPath, ['scripts/terminology-import.mjs', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL || process.env.TEST_DATABASE_URL,
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`terminology-import failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result;
}

async function refreshCounts() {
  await prisma.$executeRawUnsafe(
    `UPDATE terminology_code_systems s
        SET concept_count = (
              SELECT COUNT(*) FROM terminology_concepts c WHERE c.system_key = s.system_key
            ),
            updated_at = NOW()
      WHERE s.system_key IN ('ICD10','ICD11','SNOMED_CT','LOINC')`,
  );
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_code_bindings WHERE resource_id LIKE $1`,
    `${MARKER}%`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM terminology_concept_maps
      WHERE source_code LIKE $1 OR target_code LIKE $1 OR source_code IN ('123456789','987654321')`,
    `${MARKER}%`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM terminology_concepts
      WHERE code LIKE $1 OR display LIKE $1 OR code IN ('123456789','987654321')`,
    `${MARKER}%`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM terminology_audit_events WHERE payload->>'release_label' LIKE $1`,
    `${MARKER}%`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM terminology_import_batches WHERE release_label LIKE $1`,
    `${MARKER}%`,
  ).catch(() => {});
  await refreshCounts().catch(() => {});
}

async function captureIcd10RowsBeforeFullSweep() {
  preFullIcd10Rows = await prisma.$queryRawUnsafe(
    `SELECT code, status, last_seen_release, last_import_batch_id::text AS last_import_batch_id
       FROM terminology_concepts
      WHERE system_key = 'ICD10'
        AND code NOT LIKE $1`,
    `${MARKER}%`,
  );
}

async function restoreIcd10RowsAfterFullSweep() {
  for (const row of preFullIcd10Rows) {
    await prisma.$executeRawUnsafe(
      `UPDATE terminology_concepts
          SET status = $2,
              last_seen_release = $3,
              last_import_batch_id = $4::bigint,
              updated_at = NOW()
        WHERE system_key = 'ICD10' AND code = $1`,
      row.code,
      row.status,
      row.last_seen_release,
      row.last_import_batch_id,
    );
  }
}

d('terminology-import release versioning and map ingestion (NL-5 P1)', () => {
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-nl5p1-'));
    await cleanup();
  });

  afterAll(async () => {
    await restoreIcd10RowsAfterFullSweep();
    await cleanup();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    await prisma.$disconnect().catch(() => {});
  });

  test('generic CSV dry-run writes provenance but no concepts', async () => {
    const csv = writeFixture('nl5p1-dry.csv', 'code,display,category\nNL5P1.DRY,NL5P1 Dry Concept,diagnosis\n');

    const result = runImporter(['--system', 'ICD10', '--csv', csv, '--version', RELEASE_DRY, '--full', '--dry-run']);
    expect(result.stdout).toContain('[dry-run] ICD10: parsed 1 concepts');

    const batches = await prisma.$queryRawUnsafe(
      `SELECT status, rows_processed, rows_inserted, metadata
         FROM terminology_import_batches
        WHERE release_label = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      RELEASE_DRY,
    );
    expect(batches[0]).toMatchObject({ status: 'completed', rows_processed: 1, rows_inserted: 0 });
    expect(batches[0].metadata.dry_run).toBe(true);

    const concepts = await prisma.$queryRawUnsafe(
      `SELECT code FROM terminology_concepts WHERE system_key = 'ICD10' AND code = 'NL5P1.DRY'`,
    );
    expect(concepts).toHaveLength(0);
  });

  test('full CSV import stamps release, links batch, and retires missing active concepts without deletion', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO terminology_concepts
         (system_key, code, display, category, status, last_seen_release)
       VALUES ('ICD10', 'NL5P1.OLD', 'NL5P1 Retired Diagnosis', 'diagnosis', 'active', 'NL5P1_OLD')
       ON CONFLICT (system_key, code) DO UPDATE SET
         display = EXCLUDED.display,
         status = 'active',
         last_seen_release = EXCLUDED.last_seen_release,
         updated_at = NOW()`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_code_bindings
         (resource_type, resource_id, system_key, code, display, coding_role, source)
       VALUES ('diagnosis', 'NL5P1-retired-binding', 'ICD10', 'NL5P1.OLD', 'NL5P1 Retired Diagnosis', 'diagnosis', 'manual')
       ON CONFLICT (resource_type, resource_id, system_key, code, coding_role) DO NOTHING`,
    );
    await captureIcd10RowsBeforeFullSweep();

    const csv = writeFixture('nl5p1-v1.csv', 'code,display,category\nNL5P1.A,NL5P1 Alpha Diagnosis,diagnosis\n');
    runImporter(['--system', 'ICD10', '--csv', csv, '--version', RELEASE_V1, '--full']);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT code, status, last_seen_release, last_import_batch_id::text AS last_import_batch_id
         FROM terminology_concepts
        WHERE system_key = 'ICD10' AND code IN ('NL5P1.A','NL5P1.OLD')
        ORDER BY code`,
    );
    const imported = rows.find((r) => r.code === 'NL5P1.A');
    const retired = rows.find((r) => r.code === 'NL5P1.OLD');
    expect(imported).toMatchObject({ status: 'active', last_seen_release: RELEASE_V1 });
    expect(imported.last_import_batch_id).toBeTruthy();
    expect(retired).toMatchObject({ status: 'inactive', last_seen_release: 'NL5P1_OLD' });

    const verdict = await validateCode('ICD10', 'NL5P1.OLD');
    expect(verdict).toMatchObject({ valid: false, mode: 'catalog', reason: 'concept_inactive' });
    const bindings = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM clinical_code_bindings
        WHERE resource_id = 'NL5P1-retired-binding' AND code = 'NL5P1.OLD'`,
    );
    expect(bindings[0].count).toBe(1);
  });

  test('partial CSV import never sweeps prior-release concepts', async () => {
    const csv = writeFixture('nl5p1-v2-partial.csv', 'code,display,category\nNL5P1.B,NL5P1 Beta Diagnosis,diagnosis\n');
    runImporter(['--system', 'ICD10', '--csv', csv, '--version', RELEASE_V2]);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT code, status, last_seen_release
         FROM terminology_concepts
        WHERE system_key = 'ICD10' AND code IN ('NL5P1.A','NL5P1.B')
        ORDER BY code`,
    );
    expect(rows.find((r) => r.code === 'NL5P1.A')).toMatchObject({ status: 'active', last_seen_release: RELEASE_V1 });
    expect(rows.find((r) => r.code === 'NL5P1.B')).toMatchObject({ status: 'active', last_seen_release: RELEASE_V2 });
  });

  test('LOINC and RF2 concept fixtures stamp releases through their native import paths', async () => {
    const loinc = writeFixture(
      'Loinc.csv',
      'LOINC_NUM,LONG_COMMON_NAME,COMPONENT,CLASS,STATUS\nNL5P1-1,NL5P1 LOINC One,One,CHEM,ACTIVE\nNL5P1-2,NL5P1 LOINC Two,Two,CHEM,DEPRECATED\n',
    );
    runImporter(['--system', 'LOINC', '--loinc', loinc, '--version', RELEASE_LOINC]);

    const rf2Dir = path.join(tmpDir, 'rf2');
    fs.mkdirSync(rf2Dir);
    writeFixture(
      path.join('rf2', 'sct2_Concept_Snapshot_INT_20260707.txt'),
      'id\teffectiveTime\tactive\tmoduleId\tdefinitionStatusId\n123456789\t20260707\t1\t900000000000207008\t900000000000074008\n987654321\t20260707\t1\t900000000000207008\t900000000000074008\n',
    );
    writeFixture(
      path.join('rf2', 'sct2_Description_Snapshot-en_INT_20260707.txt'),
      'id\teffectiveTime\tactive\tmoduleId\tconceptId\tlanguageCode\ttypeId\tterm\tcaseSignificanceId\n1\t20260707\t1\t900000000000207008\t123456789\ten\t900000000000003001\tNL5P1 SNOMED disorder (disorder)\t900000000000448009\n2\t20260707\t1\t900000000000207008\t987654321\ten\t900000000000003001\tNL5P1 SNOMED finding (finding)\t900000000000448009\n',
    );
    runImporter(['--system', 'SNOMED_CT', '--rf2', rf2Dir, '--version', RELEASE_SNOMED]);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT system_key, code, display, semantic_tag, last_seen_release
         FROM terminology_concepts
        WHERE code IN ('NL5P1-1','NL5P1-2','123456789')
        ORDER BY system_key, code`,
    );
    expect(rows.find((r) => r.code === 'NL5P1-1')).toMatchObject({
      system_key: 'LOINC',
      last_seen_release: RELEASE_LOINC,
    });
    expect(rows.some((r) => r.code === 'NL5P1-2')).toBe(false);
    expect(rows.find((r) => r.code === '123456789')).toMatchObject({
      system_key: 'SNOMED_CT',
      display: 'NL5P1 SNOMED disorder',
      semantic_tag: 'disorder',
      last_seen_release: RELEASE_SNOMED,
    });
  });

  test('RF2 ExtendedMap and generic map CSV land in terminology_concept_maps', async () => {
    const rf2Map = writeFixture(
      'der2_iisssccRefset_ExtendedMapSnapshot_INT_20260707.txt',
      'id\teffectiveTime\tactive\tmoduleId\trefsetId\treferencedComponentId\tmapGroup\tmapPriority\tmapRule\tmapAdvice\tmapTarget\tcorrelationId\tmapCategoryId\nmap-1\t20260707\t1\t900000000000207008\t447562003\t123456789\t1\t1\tTRUE\tALWAYS A00\tA00\t447561005\t447637006\n',
    );
    const mapCsv = writeFixture(
      'nl5p1-map.csv',
      'from_system,from_code,to_system,to_code,relationship\nICD10,NL5P1.A,ICD11,NL5P1.ICD11,equivalent\n',
    );

    runImporter(['--system', 'SNOMED_CT', '--rf2-map', rf2Map, '--map-csv', mapCsv, '--version', RELEASE_MAPS]);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT source_system, source_code, target_system, target_code, relationship, context
         FROM terminology_concept_maps
        WHERE (source_system = 'SNOMED_CT' AND source_code = '123456789')
           OR (source_system = 'ICD10' AND source_code = 'NL5P1.A')
        ORDER BY source_system, source_code`,
    );
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source_system: 'SNOMED_CT',
        source_code: '123456789',
        target_system: 'ICD10',
        target_code: 'A00',
        relationship: 'equivalent',
        context: 'rf2_extended_map',
      }),
      expect.objectContaining({
        source_system: 'ICD10',
        source_code: 'NL5P1.A',
        target_system: 'ICD11',
        target_code: 'NL5P1.ICD11',
        relationship: 'equivalent',
        context: 'generic_map_csv',
      }),
    ]));
  });
});
