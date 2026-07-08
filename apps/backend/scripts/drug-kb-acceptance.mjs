#!/usr/bin/env node
// drug-kb-acceptance.mjs — NL-5 P2 drug-KB acceptance battery.
//
// Runs structural clinical-scenario probes through the existing evaluateDrugKb
// engine and emits a JSON snapshot. The default battery names production
// acceptance scenarios from the NL-5 design; the synthetic battery is for CI
// fixtures and deliberately uses fictional drug keys only.

import process from 'node:process';
import prisma from '../src/lib/prisma.js';
import {
  __resetDrugKbCache,
  drugKbStatus,
  evaluateDrugKb,
} from '../src/services/clinical/drugKnowledgeBaseService.js';

const SCENARIO_SETS = {
  default: [
    {
      id: 'contraindicated-pair',
      label: 'Known contraindicated pair',
      medications: [
        { name: 'Sildenafil 50mg', dose: '50mg', frequency: 'OD' },
        { name: 'Nitroglycerin spray', dose: '0.4mg', frequency: 'SOS' },
      ],
      expected: { check: 'interaction', severity: 'contraindicated' },
    },
    {
      id: 'pediatric-overdose',
      label: 'Pediatric overdose',
      medications: [{ name: 'Paracetamol', dose: '1000mg', frequency: 'QID' }],
      patient: { ageYears: 6, weightKg: 20 },
      expected: { check: 'dose_range', severity: 'major' },
    },
    {
      id: 'ckd-nsaid',
      label: 'CKD NSAID caution',
      medications: [{ name: 'Ibuprofen 400mg', dose: '400mg', frequency: 'TDS' }],
      problems: [{ icd10_code: 'N18.5', title: 'Chronic kidney disease' }],
      expected: { check: 'condition_caution', severity: 'contraindicated' },
    },
    {
      id: 'penicillin-cross-reactivity',
      label: 'Penicillin cross-reactivity',
      medications: [{ name: 'Ceftriaxone injection', route: 'IV' }],
      allergies: [{ allergen: 'penicillin' }],
      expected: { check: 'allergy_cross_sensitivity', severity: 'moderate' },
    },
    {
      id: 'iv-ceftriaxone-ringer-lactate',
      label: "IV ceftriaxone plus Ringer's lactate",
      medications: [
        { name: 'Ceftriaxone injection', route: 'IV' },
        { name: 'Ringer Lactate', route: 'IV' },
      ],
      expected: { check: 'iv_compatibility', severity: 'major' },
    },
  ],
  synthetic: [
    {
      id: 'synthetic-contraindicated-pair',
      label: 'Synthetic contraindicated pair',
      medications: [{ name: 'Fixture Alpha' }, { name: 'Fixture Beta' }],
      expected: { check: 'interaction', severity: 'contraindicated' },
    },
    {
      id: 'synthetic-pediatric-overdose',
      label: 'Synthetic pediatric dose ceiling',
      medications: [{ name: 'Fixture Child', dose: '250mg', frequency: 'QID' }],
      patient: { ageYears: 6, weightKg: 20 },
      expected: { check: 'dose_range', severity: 'major' },
    },
    {
      id: 'synthetic-condition-caution',
      label: 'Synthetic condition caution',
      medications: [{ name: 'Fixture Nsaid' }],
      problems: [{ icd10_code: 'X99.5', title: 'Synthetic condition' }],
      expected: { check: 'condition_caution', severity: 'contraindicated' },
    },
    {
      id: 'synthetic-cross-reactivity',
      label: 'Synthetic cross-reactivity',
      medications: [{ name: 'Fixture Ceph' }],
      allergies: [{ allergen: 'fixture penicillin' }],
      expected: { check: 'allergy_cross_sensitivity', severity: 'moderate' },
    },
    {
      id: 'synthetic-iv-incompatibility',
      label: 'Synthetic IV incompatibility',
      medications: [{ name: 'Fixture Calcium', route: 'IV' }, { name: 'Fixture Fluid', route: 'IV' }],
      expected: { check: 'iv_compatibility', severity: 'major' },
    },
  ],
};

function parseArgs(argv) {
  const args = { scenarioSet: 'default', requireSource: null, recordSource: null, pretty: true };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--scenario-set') args.scenarioSet = argv[++i];
    else if (arg === '--source') args.requireSource = argv[++i];
    else if (arg === '--record-source') args.recordSource = argv[++i];
    else if (arg === '--compact') args.pretty = false;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function findingMatches(finding, expected, sourceKey) {
  if (finding.check !== expected.check) return false;
  if (expected.severity && finding.severity !== expected.severity) return false;
  if (sourceKey && finding.source_key !== sourceKey) return false;
  return true;
}

function shapeFinding(finding) {
  return {
    check: finding.check,
    severity: finding.severity,
    drug_keys: finding.drug_keys || [],
    source_key: finding.source_key || null,
    medications: finding.medications || [],
  };
}

async function runScenario(scenario, requireSource) {
  const result = await evaluateDrugKb({
    medications: scenario.medications,
    allergies: scenario.allergies || [],
    problems: scenario.problems || [],
    patient: scenario.patient || {},
  });
  const matched = result.findings.find((finding) => (
    findingMatches(finding, scenario.expected, requireSource)
  ));
  return {
    id: scenario.id,
    label: scenario.label,
    status: matched ? 'passed' : 'failed',
    expected: scenario.expected,
    kb_available: result.kbAvailable,
    matched: matched ? shapeFinding(matched) : null,
    findings: result.findings.map(shapeFinding),
  };
}

async function recordSnapshot(sourceKey, snapshot) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE drug_kb_sources
        SET metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{acceptance_snapshot}',
              $1::jsonb,
              true
            ),
            edition_status = CASE
              WHEN edition_status = 'candidate' THEN 'accepted'
              ELSE edition_status
            END,
            accepted_at = COALESCE(accepted_at, NOW()),
            updated_at = NOW()
      WHERE source_key = $2
      RETURNING source_key`,
    JSON.stringify(snapshot),
    sourceKey,
  );
  if (rows.length !== 1) {
    throw new Error(`Cannot record acceptance snapshot; source '${sourceKey}' was not found`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const scenarios = SCENARIO_SETS[args.scenarioSet];
  if (!scenarios) {
    console.error(`--scenario-set must be one of: ${Object.keys(SCENARIO_SETS).join(', ')}`);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }

  __resetDrugKbCache();
  const beforeStatus = await drugKbStatus();
  const results = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, args.requireSource));
  }
  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.length - passed;
  const snapshot = {
    report: 'drug-kb-acceptance-v1',
    generated_at: new Date().toISOString(),
    scenario_set: args.scenarioSet,
    required_source_key: args.requireSource,
    status: failed === 0 ? 'passed' : 'failed',
    totals: { passed, failed, count: results.length },
    kb_status: beforeStatus,
    scenarios: results,
  };

  if (args.recordSource) {
    await recordSnapshot(args.recordSource, snapshot);
    snapshot.recorded_source_key = args.recordSource;
  }

  process.stdout.write(`${JSON.stringify(snapshot, null, args.pretty ? 2 : 0)}\n`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
