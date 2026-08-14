#!/usr/bin/env node
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const selectableStages = ['backend', 'fhir', 'admin', 'flutter', 'contracts', 'gateway', 'infra'];

export function expectedCanonicalJobs({ tier, selected }) {
  const jobs = ['plan', 'security'];
  for (const stage of selectableStages) {
    if (tier === 'full' || selected[stage]) {
      jobs.push(
        tier === 'full' && stage === 'backend'
          ? 'lint-and-test'
          : tier === 'full' && stage === 'fhir'
            ? 'fhir-conformance'
            : `${tier}_${stage}`,
      );
    }
  }
  return jobs;
}

export function validateCanonicalResults({ tier, selected, results }) {
  const expected = expectedCanonicalJobs({ tier, selected });
  const failures = [];

  for (const job of expected) {
    const result = results[job]?.result;
    if (result !== 'success') failures.push(`${job}=${result || 'missing'}`);
  }

  return { expected, failures };
}

function parseSelected() {
  return Object.fromEntries(
    selectableStages.map((stage) => [stage, process.env[`SELECT_${stage.toUpperCase()}`] === 'true']),
  );
}

function main() {
  const tier = process.env.CANONICAL_TIER;
  const results = JSON.parse(process.env.CANONICAL_RESULTS || '{}');
  const { expected, failures } = validateCanonicalResults({
    tier,
    selected: parseSelected(),
    results,
  });

  console.log(`Canonical tier: ${tier}`);
  console.log(`Required jobs: ${expected.join(', ')}`);
  if (failures.length > 0) {
    console.error(`Canonical gate failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('Canonical gate passed.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
