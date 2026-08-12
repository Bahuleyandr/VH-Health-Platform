#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  changedFilesForBranchPush,
  stagesForChangedFiles,
} from './stage-selection.mjs';

const selectableStages = ['security', 'contracts', 'backend', 'fhir', 'admin', 'flutter', 'infra'];
const outputStages = selectableStages.filter((stage) => stage !== 'security');

const fullSweepPatterns = [
  /^\.github\/workflows\/ci\.yml$/,
  /^\.github\/workflows\/_reusable-/,
  /^scripts\/ci\//,
];

function normalizeFiles(files) {
  return [...new Set(files.map((file) => file.trim().replace(/\\/g, '/')).filter(Boolean))].sort();
}

export function buildCanonicalPlan({
  eventName,
  files = [],
  requestedTier = 'full',
} = {}) {
  const normalizedFiles = normalizeFiles(files);
  const forceFull =
    eventName === 'merge_group' ||
    (eventName === 'workflow_dispatch' && requestedTier !== 'quick') ||
    normalizedFiles.length === 0 ||
    normalizedFiles.some((file) => fullSweepPatterns.some((pattern) => pattern.test(file)));

  const tier = forceFull ? 'full' : 'quick';
  const stages = forceFull
    ? [...selectableStages]
    : stagesForChangedFiles(normalizedFiles, selectableStages);

  return {
    tier,
    files: normalizedFiles,
    stages,
    selected: Object.fromEntries(outputStages.map((stage) => [stage, stages.includes(stage)])),
  };
}

function writeGitHubOutputs(plan) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;

  const entries = [
    ['tier', plan.tier],
    ['files_json', JSON.stringify(plan.files)],
    ...outputStages.map((stage) => [stage, String(plan.selected[stage])]),
  ];
  appendFileSync(outputPath, `${entries.map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
}

function main() {
  const eventName = process.env.GITHUB_EVENT_NAME || 'workflow_dispatch';
  const requestedTier = process.env.CANONICAL_TIER || 'full';
  const files = eventName === 'merge_group' ? [] : changedFilesForBranchPush();
  const plan = buildCanonicalPlan({ eventName, files, requestedTier });

  console.log(`Canonical CI tier: ${plan.tier}`);
  console.log(`Selected stages: ${plan.stages.join(', ')}`);
  console.log(`Changed files: ${plan.files.length}`);
  for (const file of plan.files.slice(0, 60)) console.log(` - ${file}`);
  if (plan.files.length > 60) console.log(` - ... ${plan.files.length - 60} more`);

  writeGitHubOutputs(plan);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
