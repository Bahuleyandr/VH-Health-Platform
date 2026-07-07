// Roadmap B2 — drug knowledge base deep round-trip.
//
// Exercises the starter dataset (migration 277) through the /api/v1/drug-kb
// surface and the full validatePrescriptionSafety integration: interactions,
// allergy cross-sensitivity, drug–disease against the B7 problem list, dose
// ceilings, and IV compatibility.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { __resetDrugKbCache, evaluateDrugKb } from '../services/clinical/drugKnowledgeBaseService.js';
import { validatePrescriptionSafety } from '../utils/clinical/prescriptionSafetyCheck.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '../..');
const SYNTHETIC_FIXTURE_DIR = path.join(__dirname, 'fixtures/drug-kb/synthetic-indigenous-v1');
const TEST_SOURCE_KEYS = [
  'b2_priority_low',
  'b2_priority_high',
  'b2_cutover_source',
  'vh_indigenous_fixture_v1',
];

const PHONE = `+9199906${String(Date.now() % 10000).padStart(5, '0')}`;
let patientId;
let patientUid;

async function deleteDrugKbSource(sourceKey) {
  for (const table of [
    'drug_kb_iv_compatibility',
    'drug_kb_dose_ranges',
    'drug_kb_condition_cautions',
    'drug_kb_allergy_cross_reactivity',
    'drug_kb_allergy_groups',
    'drug_kb_interactions',
    'drug_kb_monographs',
  ]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE source_key = $1`, sourceKey).catch(() => {});
  }
  await prisma.$executeRawUnsafe('DELETE FROM drug_kb_sources WHERE source_key = $1', sourceKey).catch(() => {});
}

async function cleanupTestKbSources() {
  for (const sourceKey of TEST_SOURCE_KEYS) {
    await deleteDrugKbSource(sourceKey);
  }
  await prisma.$executeRawUnsafe(
    `UPDATE drug_kb_sources
        SET is_active = TRUE,
            deactivated_at = NULL,
            updated_at = NOW()
      WHERE source_key = 'vh_starter_set'`,
  ).catch(() => {});
}

async function cleanup() {
  await cleanupTestKbSources();
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_problems WHERE patient_uid IN (SELECT uid FROM users WHERE name = 'B2TEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_allergies WHERE allergy_name = 'B2TEST-Penicillin'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = 'B2TEST Patient'`).catch(() => {});
}

async function insertTestSource(sourceKey, { priority = 100, active = true, family = null } = {}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO drug_kb_sources
       (source_key, name, vendor, version, license_note, is_starter, is_active,
        imported_at, priority, source_family, edition_status, license_status, metadata)
     VALUES ($1, $2, 'VH Health test', 'fixture', 'synthetic fixture', FALSE, $3,
             NOW(), $4, $5, 'accepted', 'hospital_owned', $6::jsonb)
     ON CONFLICT (source_key) DO UPDATE SET
       is_active = EXCLUDED.is_active,
       priority = EXCLUDED.priority,
       source_family = EXCLUDED.source_family,
       edition_status = EXCLUDED.edition_status,
       license_status = EXCLUDED.license_status,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()`,
    sourceKey,
    `${sourceKey} test source`,
    active,
    priority,
    family || sourceKey,
    JSON.stringify({ acceptance_snapshot: { status: 'test-fixture' } }),
  );
}

async function seedPriorityConflictSources() {
  await insertTestSource('b2_priority_low', { priority: 100 });
  await insertTestSource('b2_priority_high', { priority: 500 });
  for (const sourceKey of ['b2_priority_low', 'b2_priority_high']) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO drug_kb_monographs (source_key, drug_key, display_name, aliases)
       VALUES
         ($1, 'priority_alpha', 'Priority Alpha', ARRAY['priority alpha']),
         ($1, 'priority_beta', 'Priority Beta', ARRAY['priority beta'])
       ON CONFLICT (source_key, drug_key) DO NOTHING`,
      sourceKey,
    );
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO drug_kb_interactions
       (source_key, drug_a_key, drug_b_key, severity, effect, management, evidence)
     VALUES
       ('b2_priority_low', 'priority_alpha', 'priority_beta', 'moderate', 'low priority effect', 'low priority management', 'synthetic'),
       ('b2_priority_high', 'priority_alpha', 'priority_beta', 'contraindicated', 'high priority effect', 'high priority management', 'synthetic')
     ON CONFLICT (source_key, drug_a_key, drug_b_key) DO UPDATE SET
       severity = EXCLUDED.severity,
       effect = EXCLUDED.effect,
       management = EXCLUDED.management`,
  );
}

async function importSyntheticFixture() {
  await deleteDrugKbSource('vh_indigenous_fixture_v1');
  const script = path.join(BACKEND_ROOT, 'scripts/drug-kb-import.mjs');
  const datasets = [
    'monographs',
    'interactions',
    'allergy-groups',
    'cross-reactivity',
    'condition-cautions',
    'dose-ranges',
    'iv-compatibility',
  ];
  for (const dataset of datasets) {
    await execFileAsync(process.execPath, [
      script,
      '--source', 'vh_indigenous_fixture_v1',
      '--source-family', 'vh_indigenous',
      '--version', 'fixture.v1',
      '--vendor', 'VH Health',
      '--license-note', 'internal provenance/citations',
      '--source-license-status', 'hospital_owned',
      '--edition-status', 'accepted',
      '--priority', '600',
      '--metadata-json', '{"acceptance_snapshot":{"status":"fixture-preaccepted"}}',
      '--dataset', dataset,
      '--csv', path.join(SYNTHETIC_FIXTURE_DIR, `${dataset}.csv`),
    ], { cwd: BACKEND_ROOT, env: process.env });
  }
}

async function createInactiveCutoverSource() {
  await deleteDrugKbSource('b2_cutover_source');
  await insertTestSource('b2_cutover_source', { priority: 700, active: false });
  await prisma.$executeRawUnsafe(
    `INSERT INTO drug_kb_monographs (source_key, drug_key, display_name, atc_code, drug_class, aliases, properties)
     SELECT 'b2_cutover_source', drug_key, display_name, atc_code, drug_class, aliases, properties
       FROM drug_kb_monographs
      WHERE source_key = 'vh_starter_set'
     ON CONFLICT (source_key, drug_key) DO NOTHING`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO drug_kb_interactions (source_key, drug_a_key, drug_b_key, severity, mechanism, effect, management, evidence)
     SELECT 'b2_cutover_source', drug_a_key, drug_b_key, severity, mechanism, effect, management, evidence
       FROM drug_kb_interactions
      WHERE source_key = 'vh_starter_set'
     ON CONFLICT (source_key, drug_a_key, drug_b_key) DO NOTHING`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO drug_kb_allergy_groups (source_key, group_key, member_key)
     SELECT 'b2_cutover_source', group_key, member_key
       FROM drug_kb_allergy_groups
      WHERE source_key = 'vh_starter_set'
     ON CONFLICT (source_key, group_key, member_key) DO NOTHING`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO drug_kb_allergy_cross_reactivity (source_key, group_key, reacts_with_group_key, risk, note)
     SELECT 'b2_cutover_source', group_key, reacts_with_group_key, risk, note
       FROM drug_kb_allergy_cross_reactivity
      WHERE source_key = 'vh_starter_set'
     ON CONFLICT (source_key, group_key, reacts_with_group_key) DO NOTHING`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO drug_kb_condition_cautions (source_key, drug_key, icd10_prefix, condition_label, risk, note)
     SELECT 'b2_cutover_source', drug_key, icd10_prefix, condition_label, risk, note
       FROM drug_kb_condition_cautions
      WHERE source_key = 'vh_starter_set'
     ON CONFLICT (source_key, drug_key, icd10_prefix) DO NOTHING`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO drug_kb_dose_ranges
       (source_key, drug_key, route, population, max_single_dose_mg, max_daily_dose_mg,
        max_daily_mg_per_kg, min_egfr, egfr_max_daily_mg, note)
     SELECT 'b2_cutover_source', drug_key, route, population, max_single_dose_mg, max_daily_dose_mg,
            max_daily_mg_per_kg, min_egfr, egfr_max_daily_mg, note
       FROM drug_kb_dose_ranges
      WHERE source_key = 'vh_starter_set'
     ON CONFLICT DO NOTHING`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO drug_kb_iv_compatibility (source_key, drug_a_key, drug_b_key, compatibility, diluent, note)
     SELECT 'b2_cutover_source', drug_a_key, drug_b_key, compatibility, diluent, note
       FROM drug_kb_iv_compatibility
      WHERE source_key = 'vh_starter_set'
     ON CONFLICT DO NOTHING`,
  );
}

function nonKbIssues(result) {
  const withoutKb = (issue) => !String(issue.type || '').endsWith('_KB')
    && issue.type !== 'DRUG_KB_CHECK_ERROR';
  return {
    blockers: result.blockers.filter(withoutKb),
    warnings: result.warnings.filter(withoutKb),
  };
}

d('Drug knowledge base — deep round-trip (roadmap B2)', () => {
  beforeAll(async () => {
    await cleanup();
    __resetDrugKbCache();
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, birthday, gender, updated_at)
       VALUES ($1, 'B2TEST Patient', 'PATIENT', true, '1980-03-03', 'male', NOW()) RETURNING id, uid`,
      PHONE,
    );
    patientId = Number(p[0].id);
    patientUid = p[0].uid;

    // Structured allergy (penicillin class) + active CKD problem (B7 feed).
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_allergies (patient_id, patient_uid, allergy_name, severity, is_active)
       VALUES ($1, $2::uuid, 'B2TEST-Penicillin', 'MILD', true)`,
      patientId, patientUid,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_problems (patient_uid, patient_id, title, icd10_code, status)
       VALUES ($1::uuid, $2, 'B2TEST Chronic kidney disease stage 5', 'N18.5', 'active')`,
      patientUid, patientId,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('status reports starter source and counts', async () => {
    const res = await authClient('DOCTOR').get('/api/v1/drug-kb/status');
    expect(res.status).toBe(200);
    expect(res.body.data.kb_available).toBe(true);
    expect(res.body.data.starter_only).toBe(true);
    const starter = res.body.data.sources.find((s) => s.source_key === 'vh_starter_set');
    expect(starter).toBeDefined();
    expect(starter.is_starter).toBe(true);
    expect(starter.priority).toBeGreaterThanOrEqual(100);
    expect(res.body.data.counts.interactions).toBeGreaterThanOrEqual(25);
    expect(res.body.data.counts.monographs).toBeGreaterThanOrEqual(60);
  });

  test('active source precedence keeps the highest-priority conflicting row', async () => {
    await seedPriorityConflictSources();
    __resetDrugKbCache();

    const result = await evaluateDrugKb({
      medications: [{ name: 'Priority Alpha' }, { name: 'Priority Beta' }],
    });

    const interaction = result.findings.find((finding) => finding.check === 'interaction');
    expect(interaction).toBeDefined();
    expect(interaction.severity).toBe('contraindicated');
    expect(interaction.source_key).toBe('b2_priority_high');

    await deleteDrugKbSource('b2_priority_low');
    await deleteDrugKbSource('b2_priority_high');
    __resetDrugKbCache();
  });

  test('synthetic indigenous-shaped fixture passes lint and acceptance battery', async () => {
    const lintScript = path.join(BACKEND_ROOT, 'scripts/drug-kb-lint.mjs');
    const lint = await execFileAsync(process.execPath, [
      lintScript,
      '--manifest',
      path.join(SYNTHETIC_FIXTURE_DIR, 'manifest.json'),
    ], { cwd: BACKEND_ROOT, env: process.env });
    expect(JSON.parse(lint.stdout).status).toBe('passed');

    await importSyntheticFixture();
    __resetDrugKbCache();

    const acceptanceScript = path.join(BACKEND_ROOT, 'scripts/drug-kb-acceptance.mjs');
    const acceptance = await execFileAsync(process.execPath, [
      acceptanceScript,
      '--scenario-set',
      'synthetic',
      '--source',
      'vh_indigenous_fixture_v1',
      '--record-source',
      'vh_indigenous_fixture_v1',
    ], { cwd: BACKEND_ROOT, env: process.env });
    const snapshot = JSON.parse(acceptance.stdout);
    expect(snapshot.status).toBe('passed');
    expect(snapshot.totals).toMatchObject({ passed: 5, failed: 0, count: 5 });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT metadata->'acceptance_snapshot' AS acceptance_snapshot
         FROM drug_kb_sources
        WHERE source_key = 'vh_indigenous_fixture_v1'`,
    );
    expect(rows[0]?.acceptance_snapshot?.status).toBe('passed');

    await deleteDrugKbSource('vh_indigenous_fixture_v1');
    __resetDrugKbCache();
  });

  test('check: contraindicated interaction (PDE5 + nitrate)', async () => {
    const res = await authClient('DOCTOR')
      .post('/api/v1/drug-kb/check')
      .send({
        medications: [
          { name: 'Tab Sildenafil 50mg', dose: '50mg', frequency: 'OD' },
          { name: 'GTN (nitroglycerin) spray', dose: '0.4mg', frequency: 'SOS' },
        ],
      });
    expect(res.status).toBe(200);
    const interaction = res.body.data.findings.find((f) => f.check === 'interaction');
    expect(interaction).toBeDefined();
    expect(interaction.severity).toBe('contraindicated');
    expect(interaction.drug_keys.sort()).toEqual(['nitroglycerin', 'sildenafil']);
  });

  test('check: allergy cross-sensitivity — same class blocks, cross-class warns', async () => {
    const res = await authClient('DOCTOR')
      .post('/api/v1/drug-kb/check')
      .send({
        medications: [
          { name: 'Cap Amoxicillin 500mg' },
          { name: 'Inj Ceftriaxone 1g' },
        ],
        allergies: [{ allergen: 'penicillin' }],
      });
    expect(res.status).toBe(200);
    const findings = res.body.data.findings.filter((f) => f.check === 'allergy_cross_sensitivity');
    const sameClass = findings.find((f) => f.medications[0].includes('Amoxicillin'));
    const crossClass = findings.find((f) => f.medications[0].includes('Ceftriaxone'));
    expect(sameClass).toBeDefined();
    expect(sameClass.severity).toBe('high');
    expect(crossClass).toBeDefined();
    expect(crossClass.severity).toBe('moderate');
  });

  test('check: drug–disease caution from problem list codes', async () => {
    const res = await authClient('DOCTOR')
      .post('/api/v1/drug-kb/check')
      .send({
        medications: [{ name: 'Tab Ibuprofen 400mg', dose: '400mg', frequency: 'TDS' }],
        problems: [{ icd10_code: 'N18.5', title: 'CKD stage 5' }],
      });
    expect(res.status).toBe(200);
    const disease = res.body.data.findings.find((f) => f.check === 'condition_caution');
    expect(disease).toBeDefined();
    expect(disease.severity).toBe('contraindicated');
    expect(disease.problem_code).toBe('N18.5');
  });

  test('check: adult dose ceiling and IV incompatibility', async () => {
    const res = await authClient('DOCTOR')
      .post('/api/v1/drug-kb/check')
      .send({
        medications: [
          { name: 'Tab Paracetamol', dose: '1500 mg', frequency: 'QID' },
          { name: 'Inj Ceftriaxone 1g', route: 'iv' },
          { name: 'Ringer Lactate 500ml', route: 'iv' },
        ],
        patient: { age_years: 40 },
      });
    expect(res.status).toBe(200);
    const dose = res.body.data.findings.filter((f) => f.check === 'dose_range');
    expect(dose.length).toBeGreaterThanOrEqual(1); // 1500mg single > 1000 and 6g/day > 4g
    const iv = res.body.data.findings.find((f) => f.check === 'iv_compatibility');
    expect(iv).toBeDefined();
    expect(iv.severity).toBe('major');
  });

  test('check rejects empty medication list', async () => {
    const res = await authClient('DOCTOR').post('/api/v1/drug-kb/check').send({ medications: [] });
    expect(res.status).toBe(400);
  });

  test('validatePrescriptionSafety integrates KB findings with correct blocker/warning split', async () => {
    __resetDrugKbCache();
    const result = await validatePrescriptionSafety(patientId, [
      { name: 'Inj Ceftriaxone 1g', dose: '1g', frequency: 'OD' },
      { name: 'Tab Ibuprofen 400mg', dose: '400mg', frequency: 'TDS' },
      { name: 'Tab Sildenafil 50mg', dose: '50mg', frequency: 'OD' },
      { name: 'Sorbitrate (isosorbide) 10mg', dose: '10mg', frequency: 'BD' },
    ]);

    expect(result.safe).toBe(false);

    // Contraindicated PDE5+nitrate interaction → blocker.
    const interactionBlocker = result.blockers.find((b) => b.type === 'DRUG_INTERACTION_KB');
    expect(interactionBlocker).toBeDefined();
    expect(interactionBlocker.severity).toBe('CONTRAINDICATED');

    // Ibuprofen × active CKD problem (N18.5) → blocker.
    const diseaseBlocker = result.blockers.find((b) => b.type === 'DRUG_DISEASE_KB');
    expect(diseaseBlocker).toBeDefined();
    expect(diseaseBlocker.message).toMatch(/N18\.5/);

    // Penicillin allergy ↔ cephalosporin cross-class (moderate) → warning.
    const xreact = result.warnings.find((w) => w.type === 'ALLERGY_CROSS_SENSITIVITY_KB');
    expect(xreact).toBeDefined();
    expect(xreact.medication).toMatch(/Ceftriaxone/);

    // Legacy floor checks still present (renal NSAID warning fires too).
    const legacyRenal = result.warnings.find((w) => w.type === 'RENAL_EVIDENCE_MISSING' || w.type === 'RENAL_MEDICATION_REVIEW');
    expect(legacyRenal).toBeDefined();
  });

  test('starter deactivation switches KB source while floor checks stay byte-identical', async () => {
    await createInactiveCutoverSource();
    __resetDrugKbCache();
    const medications = [
      { name: 'Inj Ceftriaxone 1g', dose: '1g', frequency: 'OD' },
      { name: 'Tab Ibuprofen 400mg', dose: '400mg', frequency: 'TDS' },
      { name: 'Tab Sildenafil 50mg', dose: '50mg', frequency: 'OD' },
      { name: 'Sorbitrate (isosorbide) 10mg', dose: '10mg', frequency: 'BD' },
    ];

    const before = await validatePrescriptionSafety(patientId, medications);
    const beforeKb = before.blockers.find((issue) => issue.type === 'DRUG_INTERACTION_KB');
    expect(beforeKb?.kb_source).toBe('vh_starter_set');

    try {
      await prisma.$executeRawUnsafe(
        `UPDATE drug_kb_sources
            SET is_active = CASE WHEN source_key = 'b2_cutover_source' THEN TRUE ELSE FALSE END,
                deactivated_at = CASE WHEN source_key = 'vh_starter_set' THEN NOW() ELSE deactivated_at END,
                activated_at = CASE WHEN source_key = 'b2_cutover_source' THEN NOW() ELSE activated_at END,
                updated_at = NOW()
          WHERE source_key IN ('vh_starter_set', 'b2_cutover_source')`,
      );
      __resetDrugKbCache();

      const after = await validatePrescriptionSafety(patientId, medications);
      const afterKb = after.blockers.find((issue) => issue.type === 'DRUG_INTERACTION_KB');
      expect(afterKb?.kb_source).toBe('b2_cutover_source');
      expect(nonKbIssues(after)).toEqual(nonKbIssues(before));
    } finally {
      await prisma.$executeRawUnsafe(
        `UPDATE drug_kb_sources
            SET is_active = TRUE,
                deactivated_at = NULL,
                updated_at = NOW()
          WHERE source_key = 'vh_starter_set'`,
      ).catch(() => {});
      await deleteDrugKbSource('b2_cutover_source');
      __resetDrugKbCache();
    }
  });

  test('patient role blocked at mount', async () => {
    const res = await authClient('PATIENT').get('/api/v1/drug-kb/status');
    expect(res.status).toBe(403);
  });
});
