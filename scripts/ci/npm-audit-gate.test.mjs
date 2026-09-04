// Unit tests for the npm advisory gate's two discriminations.
//   node --test scripts/ci/npm-audit-gate.test.mjs
//
// The gate exists to tell "the advisory service did not answer" apart from
// "your dependencies have a known vulnerability". Both of those used to exit 1
// and read identically in CI. These tests pin the classifier against REAL
// output captured from the failures on 2026-09-04, and — more importantly —
// pin the direction it fails when it is unsure.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyAuditOutcome, manifestsUnchanged, resolveBaseRef } from './npm-audit-gate.mjs';

// Captured verbatim from run 33845185488, job 100935633334.
const REAL_503 = `npm warn config production Use \`--omit=dev\` instead.
npm warn audit 503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - Service Unavailable
{ error: 'Service Unavailable' }
npm error audit endpoint returned an error
npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-09-04T06_43_48_495Z-debug-0.log`;

// Captured verbatim from the re-run, job 100941323298.
const REAL_TIMEOUT = `npm warn audit network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk
npm error audit endpoint returned an error`;

// audit-ci's shape when the registry hands it something unparseable.
const REAL_AUDIT_CI = `npm warn exec The following package was not found and will be installed: audit-ci@7.1.0
code undefined:
Exiting...`;

// A genuine finding, in the shape npm actually prints it.
const REAL_FINDINGS = `# npm audit report

qs  2.2.5 - 6.15.3
Severity: high
qs: Denial of Service via Attacker Controlled isBuffer - https://github.com/advisories/GHSA-4mjr-xmp4-gh2g
fix available via \`npm audit fix\`
node_modules/qs

1 high severity vulnerability`;

describe('classifyAuditOutcome', () => {
  test('a 503 from the bulk advisory endpoint is a service failure, not a finding', () => {
    assert.equal(
      classifyAuditOutcome({ exitCode: 1, output: REAL_503 }),
      'service-unavailable',
    );
  });

  test('a network timeout to the registry is a service failure', () => {
    assert.equal(
      classifyAuditOutcome({ exitCode: 1, output: REAL_TIMEOUT }),
      'service-unavailable',
    );
  });

  test("audit-ci's empty error code is a service failure", () => {
    assert.equal(
      classifyAuditOutcome({ exitCode: 1, output: REAL_AUDIT_CI }),
      'service-unavailable',
    );
  });

  test('a real advisory is a finding', () => {
    assert.equal(
      classifyAuditOutcome({ exitCode: 1, output: REAL_FINDINGS }),
      'findings',
    );
  });

  test('a clean run is clean', () => {
    assert.equal(
      classifyAuditOutcome({ exitCode: 0, output: 'found 0 vulnerabilities' }),
      'clean',
    );
  });

  // The important one. If a future npm prints a transport warning AND a real
  // advisory in the same run, the advisory must win — otherwise a flaky network
  // becomes a way to launder a vulnerability past the gate.
  test('a transport warning alongside real findings is a FINDING', () => {
    const mixed = `npm warn audit 503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk
${REAL_FINDINGS}`;
    assert.equal(classifyAuditOutcome({ exitCode: 1, output: mixed }), 'findings');
  });

  // Unrecognised failure shapes must fail CLOSED. A new npm error string should
  // block the merge, not be waved through as infrastructure.
  test('an unrecognised non-zero exit is treated as a finding', () => {
    assert.equal(
      classifyAuditOutcome({ exitCode: 1, output: 'npm error something entirely new' }),
      'findings',
    );
  });

  test('empty output with a non-zero exit is treated as a finding', () => {
    assert.equal(classifyAuditOutcome({ exitCode: 1, output: '' }), 'findings');
    assert.equal(classifyAuditOutcome({ exitCode: 1, output: undefined }), 'findings');
  });
});

describe('manifestsUnchanged', () => {
  let repo;

  function run(args) {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  }

  function makeRepo() {
    repo = mkdtempSync(join(tmpdir(), 'audit-gate-'));
    run(['init', '-q', '-b', 'main']);
    run(['config', 'user.email', 'test@example.test']);
    run(['config', 'user.name', 'Audit Gate Test']);
    writeFileSync(join(repo, 'package.json'), '{"name":"x"}\n');
    writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
    run(['add', '-A']);
    run(['commit', '-qm', 'base']);
    run(['branch', 'base-branch']);
  }

  test('identical manifests compare as unchanged', (t) => {
    makeRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    writeFileSync(join(repo, 'src.js'), 'console.log(1);\n');
    run(['add', '-A']);
    run(['commit', '-qm', 'unrelated change']);

    assert.equal(
      manifestsUnchanged({
        repoRoot: repo,
        baseRef: 'base-branch',
        manifests: ['package.json', 'package-lock.json'],
      }),
      true,
    );
  });

  test('a changed lockfile compares as changed', (t) => {
    makeRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3,"bumped":true}\n');
    run(['add', '-A']);
    run(['commit', '-qm', 'bump a dependency']);

    assert.equal(
      manifestsUnchanged({
        repoRoot: repo,
        baseRef: 'base-branch',
        manifests: ['package.json', 'package-lock.json'],
      }),
      false,
    );
  });

  // The referent bug this function was rewritten to fix. The comparison must be
  // against the MERGE BASE, not the base branch's tip: when someone else lands
  // a dependency bump on main, a PR that has not touched a manifest must still
  // read as unchanged. Comparing against the tip reported every open PR as a
  // dependency change the moment main moved, which during an outage would fail
  // them all for something none of them did.
  test('a dependency bump landing on the BASE does not implicate this branch', (t) => {
    makeRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));

    // This branch: an unrelated change, manifests untouched.
    run(['checkout', '-qb', 'feature']);
    writeFileSync(join(repo, 'src.js'), 'console.log(1);\n');
    run(['add', '-A']);
    run(['commit', '-qm', 'unrelated work']);

    // Meanwhile main bumps a dependency.
    run(['checkout', '-q', 'main']);
    writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3,"bumped":"by someone else"}\n');
    run(['add', '-A']);
    run(['commit', '-qm', 'bump a dependency on main']);
    run(['checkout', '-q', 'feature']);

    assert.equal(
      manifestsUnchanged({
        repoRoot: repo,
        baseRef: 'main',
        manifests: ['package.json', 'package-lock.json'],
      }),
      true,
      'a bump on the base branch must not be attributed to this branch',
    );
  });

  // Undeterminable must be null, NOT true — the caller turns null into a
  // failure. Returning true here would let an unresolvable base silently skip
  // the gate, which is precisely the hole this whole change exists to avoid.
  test('an unresolvable base ref is undeterminable, not "unchanged"', (t) => {
    makeRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));

    assert.equal(
      manifestsUnchanged({
        repoRoot: repo,
        baseRef: 'refs/heads/does-not-exist',
        manifests: ['package.json'],
      }),
      null,
    );
    assert.equal(
      manifestsUnchanged({ repoRoot: repo, baseRef: null, manifests: ['package.json'] }),
      null,
    );
  });

  // This repo's canonical CI triggers on PUSH (ci.yml `branches: ['**','!main']`),
  // never on pull_request, so GITHUB_BASE_REF is always empty here. The gate's
  // first CI run failed on "the base branch could not be resolved" for exactly
  // that reason: a PR-only lookup can never resolve a base in this repo.
  describe('resolveBaseRef', () => {
    test('AUDIT_GATE_BASE_REF resolves when GITHUB_BASE_REF is empty (push builds)', (t) => {
      makeRepo();
      t.after(() => rmSync(repo, { recursive: true, force: true }));
      // Stand in for what actions/checkout leaves behind.
      run(['update-ref', 'refs/remotes/origin/main', 'HEAD']);

      t.after(() => { delete process.env.AUDIT_GATE_BASE_REF; });
      delete process.env.GITHUB_BASE_REF;
      process.env.AUDIT_GATE_BASE_REF = 'main';

      assert.equal(resolveBaseRef(repo), 'origin/main');
    });

    test('with neither variable set there is no base', (t) => {
      makeRepo();
      t.after(() => rmSync(repo, { recursive: true, force: true }));
      delete process.env.AUDIT_GATE_BASE_REF;
      delete process.env.GITHUB_BASE_REF;

      assert.equal(resolveBaseRef(repo), null);
    });

    // A local branch of the same name must NOT satisfy the lookup: on a
    // developer checkout it can be arbitrarily stale, and a stale base is how
    // "unchanged" quietly starts meaning something else.
    test('a local branch is not accepted in place of the remote-tracking ref', (t) => {
      makeRepo();
      t.after(() => rmSync(repo, { recursive: true, force: true }));
      t.after(() => { delete process.env.AUDIT_GATE_BASE_REF; });
      // `main` exists locally; refs/remotes/origin/main deliberately does not.
      process.env.AUDIT_GATE_BASE_REF = 'main';

      assert.equal(resolveBaseRef(repo), null);
    });
  });

  test('a manifest absent from both sides is not treated as a change', (t) => {
    makeRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));

    assert.equal(
      manifestsUnchanged({
        repoRoot: repo,
        baseRef: 'base-branch',
        manifests: ['package.json', 'npm-shrinkwrap.json'],
      }),
      true,
    );
  });
});
