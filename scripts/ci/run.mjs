#!/usr/bin/env node
import process from 'node:process';
import { runAdminStage } from './admin.mjs';
import { runBackendStage } from './backend.mjs';
import { runContractsStage } from './contracts.mjs';
import { runFhirStage } from './fhir.mjs';
import { runFlutterStage } from './flutter.mjs';
import { runInfraStage } from './infra.mjs';
import { runSecurityStage } from './security.mjs';
import { runSmokeStage } from './smoke.mjs';
import {
  changedFilesForBranchPush,
  shouldSelectChangedStages,
  stagesForChangedFiles,
} from './stage-selection.mjs';

const stageOrder = ['security', 'contracts', 'backend', 'fhir', 'admin', 'flutter', 'infra'];
const optionalStages = ['smoke'];
const allStages = [...stageOrder, ...optionalStages];
const aliases = new Map([
  ['all', stageOrder],
  ['full', stageOrder],
  ['mobile', ['flutter']],
  ['k8s', ['infra']],
  ['kubernetes', ['infra']],
]);

function parseList(value) {
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .flatMap((entry) => aliases.get(entry) || [entry]);
}

function usage() {
  console.log(`Usage: node scripts/ci/run.mjs [--only=a,b] [--skip=a,b] [--install] [--include-smoke]

Stages: ${allStages.join(', ')}
Default stages: ${stageOrder.join(', ')}

Examples:
  node scripts/ci/run.mjs
  node scripts/ci/run.mjs --only=security,backend
  node scripts/ci/run.mjs --skip=flutter
  node scripts/ci/run.mjs --install --include-smoke
  node scripts/ci/run.mjs --install --changed-on-branch-push
`);
}

function parseArgs() {
  let selected = [...stageOrder];
  const skipped = new Set();
  let install = false;
  let changedOnBranchPush = false;
  let forceChanged = false;

  for (const arg of process.argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--install') {
      install = true;
      continue;
    }
    if (arg === '--changed') {
      forceChanged = true;
      continue;
    }
    if (arg === '--changed-on-branch-push') {
      changedOnBranchPush = true;
      continue;
    }
    if (arg === '--include-smoke') {
      selected.push('smoke');
      continue;
    }
    if (arg.startsWith('--only=')) {
      selected = parseList(arg.slice('--only='.length));
      continue;
    }
    if (arg.startsWith('--stage=')) {
      selected = parseList(arg.slice('--stage='.length));
      continue;
    }
    if (arg.startsWith('--skip=')) {
      for (const stage of parseList(arg.slice('--skip='.length))) skipped.add(stage);
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(2);
  }

  const unknown = [...new Set([...selected, ...skipped])].filter(
    (stage) => !allStages.includes(stage),
  );
  if (unknown.length > 0) {
    console.error(`Unknown local CI stage(s): ${unknown.join(', ')}`);
    usage();
    process.exit(2);
  }

  const changedMode = forceChanged || (changedOnBranchPush && shouldSelectChangedStages());
  if (changedMode) {
    const files = changedFilesForBranchPush();
    console.log(`Changed-file CI mode: ${files.length} changed file(s).`);
    if (files.length > 0) {
      for (const file of files.slice(0, 40)) console.log(` - ${file}`);
      if (files.length > 40) console.log(` - ... ${files.length - 40} more`);
    }
    selected = stagesForChangedFiles(files, stageOrder);
  }

  return {
    install,
    stages: allStages.filter((stage) => selected.includes(stage) && !skipped.has(stage)),
  };
}

const stageHandlers = {
  security: runSecurityStage,
  contracts: runContractsStage,
  backend: runBackendStage,
  fhir: runFhirStage,
  admin: runAdminStage,
  flutter: runFlutterStage,
  infra: runInfraStage,
  smoke: runSmokeStage,
};

const { install, stages } = parseArgs();

if (stages.length === 0) {
  console.error('No CI stages selected.');
  process.exit(2);
}

console.log(`VH Health CI: ${stages.join(', ')}${install ? ' (install enabled)' : ''}`);
const startedAt = Date.now();

for (const stage of stages) {
  console.log(`\n=== ${stage.toUpperCase()} ===`);
  await stageHandlers[stage]({ install });
}

const totalSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\nCI passed in ${totalSeconds}s.`);

