import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const preflight = path.join(repoRoot, 'scripts/ci/forgejo-deploy-preflight.mjs');

function missingDeployEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of [
    'CONTAINER_REGISTRY_USERNAME',
    'GHCR_USERNAME',
    'CONTAINER_REGISTRY_PASSWORD',
    'GHCR_TOKEN',
    'TS_OAUTH_CLIENT_ID',
    'TS_OAUTH_SECRET',
    'DALEKDEFENDER_SSH_KEY',
  ]) {
    delete env[name];
  }
  return env;
}

test('optional preflight emits a machine-readable not_deployed result', t => {
  const temp = mkdtempSync(path.join(tmpdir(), 'vhhealth-deploy-preflight-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const resultFile = path.join(temp, 'status.json');
  const outputFile = path.join(temp, 'github-output.txt');

  const result = spawnSync(process.execPath, [
    preflight,
    '--mode', 'dalek-deploy',
    '--allow-skip',
    '--result-file', resultFile,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: missingDeployEnvironment({ GITHUB_OUTPUT: outputFile }),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const receipt = JSON.parse(readFileSync(resultFile, 'utf8'));
  assert.equal(receipt.status, 'not_deployed');
  assert.equal(receipt.mode, 'dalek-deploy');
  assert.ok(receipt.missing_requirements.length > 0);
  const outputs = readFileSync(outputFile, 'utf8');
  assert.match(outputs, /^skip=true$/m);
  assert.match(outputs, /^status=not_deployed$/m);
});

test('required preflight fails closed and reports blocked', t => {
  const temp = mkdtempSync(path.join(tmpdir(), 'vhhealth-deploy-preflight-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const resultFile = path.join(temp, 'status.json');

  const result = spawnSync(process.execPath, [
    preflight,
    '--mode', 'dalek-deploy',
    '--result-file', resultFile,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: missingDeployEnvironment(),
  });

  assert.equal(result.status, 1);
  const receipt = JSON.parse(readFileSync(resultFile, 'utf8'));
  assert.equal(receipt.status, 'blocked');
});
