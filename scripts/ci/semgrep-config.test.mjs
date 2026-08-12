import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { requireSemgrepAvailability } from './security.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

test('blocking Semgrep runners fail on ERROR findings', () => {
  const securityRunner = readFileSync(
    path.join(repoRoot, 'scripts', 'ci', 'security.mjs'),
    'utf8',
  );
  const scheduledWorkflow = readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'all.yml'),
    'utf8',
  );
  const canonicalWorkflow = readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
    'utf8',
  );

  assert.match(securityRunner, /'--error'[\s\S]*'--severity', 'ERROR'/);
  assert.match(scheduledWorkflow, /--error\s+\\[\s\S]*--severity ERROR/);
  assert.match(
    canonicalWorkflow,
    /node --test scripts\/ci\/semgrep-config\.test\.mjs/,
  );
});

test('alternative Semgrep rules detect every tracked pattern family', (t) => {
  const semgrepBin = ['/tmp/vh-semgrep-venv/bin/semgrep', 'semgrep'].find((candidate) => {
    const version = spawnSync(candidate, ['--version'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    return version.status === 0;
  });
  if (!semgrepBin) {
    if (!requireSemgrepAvailability(false)) {
      t.skip('Semgrep is not installed locally');
      return;
    }
  }

  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'vh-semgrep-config-'));
  const sourceDir = path.join(fixtureRoot, 'apps', 'backend', 'src');
  const fixture = path.join(sourceDir, 'tracked-alternatives.js');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(fixture, `
const crypto = require('node:crypto');
const path = require('node:path');

crypto.createHash("md5");
crypto.createHash('sha1');
eval(source);
new Function(source);
path.join('/srv/uploads', req.params.name);
path.join('/srv/uploads', req.body.name);
path.join('/srv/uploads', req.query.name);
path.resolve('/srv/uploads', req.params.name);
path.resolve('/srv/uploads', req.body.name);
path.resolve('/srv/uploads', req.query.name);
res.redirect(req.query.next);
res.redirect(req.body.next);
res.redirect(req.params.next);
crypto.createHash('sha256');
JSON.parse(source);
path.join('/srv/uploads', 'known-file.json');
res.redirect('/dashboard');
`, 'utf8');

  try {
    const result = spawnSync(semgrepBin, [
      'scan',
      '--config', path.join(repoRoot, '.semgrep.yml'),
      '--json',
      '--quiet',
      fixtureRoot,
    ], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: { ...process.env, PYTHONUTF8: '1' },
    });

    assert.equal(
      result.status,
      0,
      `${result.error?.stack || ''}\n${result.stderr}\n${result.stdout}\nsignal=${result.signal}`,
    );
    const output = JSON.parse(result.stdout);
    const counts = output.results.reduce((byRule, finding) => {
      const ruleId = finding.check_id.split('.').at(-1);
      byRule[ruleId] = (byRule[ruleId] || 0) + 1;
      return byRule;
    }, {});

    const diagnostics = JSON.stringify(output, null, 2);
    assert.equal(counts['vh-weak-hash-md5-sha1'], 2, diagnostics);
    assert.equal(counts['vh-eval-dangerous'], 2, diagnostics);
    assert.equal(counts['vh-path-join-req-input'], 6, diagnostics);
    assert.equal(counts['vh-open-redirect'], 3, diagnostics);

    const blocking = spawnSync(semgrepBin, [
      'scan',
      '--config', path.join(repoRoot, '.semgrep.yml'),
      '--error',
      '--severity', 'ERROR',
      '--quiet',
      fixtureRoot,
    ], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    assert.equal(
      blocking.status,
      1,
      `blocking Semgrep invocation did not fail on findings:\n${blocking.stderr}\n${blocking.stdout}`,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
