import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const script = new URL('./post-deploy-smoke.mjs', import.meta.url).href;
const base = {
  VH_SMOKE_AUTHORIZED_BY: 'Test owner', VH_SMOKE_AUTHORITY_REF: 'test-receipt',
  VH_SMOKE_EXPECTED_COMMIT: 'a'.repeat(40), VH_TRIAL_API_ORIGIN: 'https://api.example.invalid',
  VH_TRIAL_ADMIN_ORIGIN: 'https://admin.example.invalid', VH_MONITORING_TOKEN: 'test-monitor',
  VH_VERSION_MATCH_TIMEOUT_MS: '0',
};

function run(env = {}, commit = base.VH_SMOKE_EXPECTED_COMMIT, readinessStatus = 200) {
  const directory = mkdtempSync(join(tmpdir(), 'vh-post-smoke-'));
  const code = [
    'const requests = [];',
    'const versions = ' + JSON.stringify(Array.isArray(commit) ? commit : [commit]) + '; let versionRead = 0;',
    'process.exit = (status) => { process.exitCode = status; throw new Error("Smoke exited " + status); };',
    'globalThis.fetch = async (url, options = {}) => {',
    '  requests.push({ url, method: options.method || "GET" });',
    '  const body = url.endsWith("/health/version") ? { commit: versions[Math.min(versionRead++, versions.length - 1)] } : {};',
    '  return { status: url.endsWith("/health/ready") ? ' + readinessStatus + ' : 200, json: async () => body, text: async () => JSON.stringify(body) };',
    '};',
    'try { await import(' + JSON.stringify(script) + '); } finally { console.log(JSON.stringify({ requests })); }',
  ].join('\n');
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
      cwd: directory, env: { ...base, ...env }, encoding: 'utf8',
    });
    const reportPath = join(directory, 'output', 'post-deploy-smoke', 'post-deploy-smoke.json');
    const requests = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)).requests;
    return { ...result, requests, report: existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('post-deploy smoke refuses unapproved execution before any probe or output report', () => {
  const result = run({ VH_SMOKE_AUTHORITY_REF: '' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /"requests":\[\]/);
  assert.equal(result.report, null);
});

test('unselected Sentry smoke never submits even when DSNs exist', () => {
  const result = run({ SENTRY_DSN_BACKEND: 'https://public@sentry.example.invalid/1' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /"method":"POST"/);
  assert.equal(result.report.results.find((row) => row.label === 'sentry').status, 'NOT_SELECTED');
  assert.equal(result.report.require_version_match, true);
  assert.equal(result.report.authority_ref, base.VH_SMOKE_AUTHORITY_REF);
});

test('selected Sentry submissions are all required', () => {
  const result = run({
    VH_SMOKE_INCLUDE_SENTRY: 'true', SENTRY_SMOKE_REQUIRED: 'true',
    SENTRY_DSN_BACKEND: 'https://public@sentry.example.invalid/1',
    SENTRY_DSN_ADMIN: 'https://public@sentry.example.invalid/2',
    SENTRY_DSN_STAFF: 'https://public@sentry.example.invalid/3',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.results.filter((row) => row.label.startsWith('sentry:') && row.required).length, 3);
  assert.equal((result.stdout.match(/"method":"POST"/g) || []).length, 3);
});

test('a deployed SHA prefix is not accepted as exact-version evidence', () => {
  const result = run({}, 'a'.repeat(7));
  assert.equal(result.status, 1);
  assert.equal(result.report, null);
  assert.match(result.stderr, /exact approved/);
  assert.deepEqual(result.requests, [{ url: base.VH_TRIAL_API_ORIGIN + '/health/version', method: 'GET' }]);
});

test('wrong deployed identity cannot submit selected Sentry events', () => {
  const result = run({
    VH_SMOKE_INCLUDE_SENTRY: 'true',
    SENTRY_DSN_BACKEND: 'https://public@sentry.example.invalid/1',
    SENTRY_DSN_ADMIN: 'https://public@sentry.example.invalid/2',
    SENTRY_DSN_STAFF: 'https://public@sentry.example.invalid/3',
  }, 'b'.repeat(40));
  assert.equal(result.status, 1);
  assert.equal(result.report, null);
  assert.match(result.stderr, /exact approved/);
  assert.deepEqual(result.requests, [{ url: base.VH_TRIAL_API_ORIGIN + '/health/version', method: 'GET' }]);
});

test('a target changing after preflight still cannot submit selected Sentry events', () => {
  const result = run({
    VH_SMOKE_INCLUDE_SENTRY: 'true',
    SENTRY_DSN_BACKEND: 'https://public@sentry.example.invalid/1',
    SENTRY_DSN_ADMIN: 'https://public@sentry.example.invalid/2',
    SENTRY_DSN_STAFF: 'https://public@sentry.example.invalid/3',
  }, [base.VH_SMOKE_EXPECTED_COMMIT, 'b'.repeat(40)]);
  assert.equal(result.status, 1);
  assert.equal(result.requests.filter((request) => request.method === 'POST').length, 0);
  const version = result.report.results.find((row) => row.label === 'backend:version-match');
  assert.equal(version.ok, false);
  assert.equal(version.required, true);
  assert.equal(result.report.results.find((row) => row.label === 'sentry').status, 'HELD_TARGET_CHECK_FAILED');
});

test('selected Sentry events stay held when an approved target fails readiness', () => {
  const result = run({
    VH_SMOKE_INCLUDE_SENTRY: 'true',
    SENTRY_DSN_BACKEND: 'https://public@sentry.example.invalid/1',
    SENTRY_DSN_ADMIN: 'https://public@sentry.example.invalid/2',
    SENTRY_DSN_STAFF: 'https://public@sentry.example.invalid/3',
  }, base.VH_SMOKE_EXPECTED_COMMIT, 503);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /"method":"POST"/);
  const resultRow = result.report.results.find((row) => row.label === 'sentry');
  assert.equal(resultRow.status, 'HELD_TARGET_CHECK_FAILED');
  assert.equal(resultRow.required, true);
  assert.equal(resultRow.ok, false);
});
