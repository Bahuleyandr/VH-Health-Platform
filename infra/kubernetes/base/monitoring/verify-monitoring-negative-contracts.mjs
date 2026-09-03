import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runnerPath = join(here, 'run-promtool-rule-tests.mjs');
const rulePath = join(here, 'backend-red-alerts.yaml');

const baseline = runRuleTests();
assert.equal(
  baseline.status,
  0,
  `baseline promtool rule tests failed:\n${resultOutput(baseline)}`,
);

const source = readFileSync(rulePath, 'utf8').replace(/\r\n/g, '\n');
const matcher = [
  '              kube_job_failed{',
  '                namespace="vhhealth",',
  '                job_name="vhhealth-backend-migrate",',
  '                condition="true"',
  '              }',
].join('\n');
const mutatedMatcher = [
  '              kube_job_failed{',
  '                namespace="vhhealth",',
  '                job_name="vhhealth-backend-migrate"',
  '              }',
].join('\n');
const matches = source.split(matcher).length - 1;
assert.equal(matches, 1, `condition="true" mutation anchor matched ${matches} times`);

const tempDir = mkdtempSync(join(tmpdir(), 'vhhealth-promtool-negative-'));
const mutatedPath = join(tempDir, 'backend-red-alerts.yaml');

try {
  writeFileSync(mutatedPath, source.replace(matcher, mutatedMatcher), 'utf8');
  const mutated = runRuleTests(mutatedPath);
  assert.notEqual(mutated.status, 0, 'missing condition="true" matcher reported green');
  assert.match(resultOutput(mutated), /BackendMigrationJobFailed/);
  console.log('✓ promtool rejects BackendMigrationJobFailed without condition="true"');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function runRuleTests(backendRuleFile) {
  // Build the child env explicitly and DELETE the override first. A plain
  // spread lets an ambient BACKEND_RED_ALERTS_FILE survive into the baseline
  // run, so the harness would assert "baseline green" against a file nobody
  // reviewed and then compare it to a mutation of the repo's file — a green
  // proof about two unrelated inputs.
  const env = { ...process.env };
  delete env.BACKEND_RED_ALERTS_FILE;
  if (backendRuleFile) env.BACKEND_RED_ALERTS_FILE = backendRuleFile;
  return spawnSync(process.execPath, [runnerPath], { encoding: 'utf8', env });
}

function resultOutput(result) {
  return `${result.stdout || ''}${result.stderr || ''}${result.error?.message || ''}`;
}
