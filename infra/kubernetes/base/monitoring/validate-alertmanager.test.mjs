import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertRouteCases } from './validate-alertmanager.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const validatorPath = join(here, 'validate-alertmanager.mjs');
const sourcePath = join(here, 'alertmanager.yaml.example');
const migrationCase = {
  labels: [
    'alertname=BackendMigrationJobFailed',
    'severity=critical',
    'team=backend',
    'namespace=vhhealth',
  ],
  receivers: ['ops-webhook', 'critical-pagerduty', 'team-backend'],
};

test('route validation rejects an empty label match', () => {
  assert.throws(
    () =>
      assertRouteCases([
        { labels: [], receivers: ['unmatched-alerts'] },
        migrationCase,
      ]),
    /empty label match/,
  );
});

test('migration failure route validation pins the backend receiver fan-out', () => {
  assert.throws(
    () =>
      assertRouteCases([
        {
          ...migrationCase,
          receivers: ['ops-webhook', 'critical-pagerduty'],
        },
      ]),
    /team-backend/,
  );
});

test('amtool validation fails on an empty or missing backend team route', { timeout: 30_000 }, () => {
  const baseline = runValidator();
  assert.equal(
    baseline.status,
    0,
    `baseline Alertmanager validation failed:\n${resultOutput(baseline)}`,
  );

  const source = readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
  const routeBlock = [
    '    - receiver: team-backend',
    '      matchers:',
    '        - team = "backend"',
    '',
  ].join('\n');
  const emptyMatcherBlock = [
    '    - receiver: team-backend',
    '      matchers: []',
    '',
  ].join('\n');
  const tempDir = mkdtempSync(join(tmpdir(), 'vhhealth-alertmanager-negative-'));
  const mutatedPath = join(tempDir, 'alertmanager.yaml');

  try {
    const emptyMatcher = replaceRequiredOnce(
      source,
      routeBlock,
      emptyMatcherBlock,
      'team-backend route',
    );
    writeFileSync(mutatedPath, emptyMatcher, 'utf8');
    const emptyResult = runValidator(mutatedPath);
    assert.notEqual(emptyResult.status, 0, 'empty team-backend match reported green');
    assert.match(resultOutput(emptyResult), /team-backend|receivers/i);

    const missingRoute = replaceRequiredOnce(
      source,
      routeBlock,
      '',
      'team-backend route',
    );
    writeFileSync(mutatedPath, missingRoute, 'utf8');
    const missingResult = runValidator(mutatedPath);
    assert.notEqual(missingResult.status, 0, 'missing team-backend route reported green');
    assert.match(resultOutput(missingResult), /team-backend|receivers/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function runValidator(configSource) {
  return spawnSync(process.execPath, [validatorPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(configSource ? { ALERTMANAGER_CONFIG_SOURCE: configSource } : {}),
    },
  });
}

function resultOutput(result) {
  return `${result.stdout || ''}${result.stderr || ''}${result.error?.message || ''}`;
}

function replaceRequiredOnce(source, anchor, replacement, description) {
  const matches = source.split(anchor).length - 1;
  assert.equal(matches, 1, `${description} mutation anchor matched ${matches} times`);
  return source.replace(anchor, replacement);
}
