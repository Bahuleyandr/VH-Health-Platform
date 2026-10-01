import assert from 'node:assert/strict';
import test from 'node:test';
import { runManualSmokePreflight, validateManualSmokeConfig } from './manual-smoke-preflight.mjs';

const base = {
  VH_SMOKE_AUTHORIZED_BY: 'Test owner',
  VH_SMOKE_AUTHORITY_REF: 'test-approval',
  VH_SMOKE_EXPECTED_COMMIT: 'a'.repeat(40),
  VH_TRIAL_API_ORIGIN: 'https://api.example.invalid',
  VH_TRIAL_ADMIN_ORIGIN: 'https://admin.example.invalid',
  VH_MONITORING_TOKEN: 'test-monitor',
  VH_API_KEY: 'test-key',
  VH_STAFF_TEST_PASSWORD: 'test-password',
};

test('missing authority, target identity or required credentials fail before any network request', async () => {
  for (const key of ['VH_SMOKE_AUTHORIZED_BY', 'VH_SMOKE_AUTHORITY_REF', 'VH_SMOKE_EXPECTED_COMMIT',
    'VH_TRIAL_API_ORIGIN', 'VH_API_KEY', 'VH_STAFF_TEST_PASSWORD']) {
    let calls = 0;
    await assert.rejects(runManualSmokePreflight('trial-readiness', {
      env: { ...base, [key]: '' }, fetchImpl: () => { calls += 1; },
    }));
    assert.equal(calls, 0);
  }
  for (const key of ['VH_TRIAL_ADMIN_ORIGIN', 'VH_MONITORING_TOKEN']) {
    assert.throws(() => validateManualSmokeConfig('post-deploy', { ...base, [key]: '' }));
  }
});

test('origins cannot carry credentials, downgrade TLS or select a path', () => {
  for (const value of ['http://api.example.invalid', 'https://user:pass@api.example.invalid',
    'https://api.example.invalid/api/v1', 'https://api.example.invalid?target=x']) {
    assert.throws(() => validateManualSmokeConfig('post-deploy', { ...base, VH_TRIAL_API_ORIGIN: value }));
  }
});

test('write smoke requires its own authority and defaults off', () => {
  assert.equal(validateManualSmokeConfig('trial-readiness', base).includeCreates, false);
  assert.throws(() => validateManualSmokeConfig('trial-readiness',
    { ...base, VH_SMOKE_INCLUDE_CREATES: 'true' }), /VH_SMOKE_WRITES_AUTHORITY_REF/);
  assert.equal(validateManualSmokeConfig('trial-readiness',
    { ...base, VH_SMOKE_INCLUDE_CREATES: 'true', VH_SMOKE_WRITES_AUTHORITY_REF: 'write-approval' }).includeCreates, true);
});

test('selected Sentry checks require every DSN; unselected checks cannot become required', () => {
  assert.equal(validateManualSmokeConfig('post-deploy', base).includeSentry, false);
  assert.throws(() => validateManualSmokeConfig('post-deploy',
    { ...base, SENTRY_SMOKE_REQUIRED: 'true' }), /explicitly included/);
  assert.throws(() => validateManualSmokeConfig('post-deploy',
    { ...base, VH_SMOKE_INCLUDE_SENTRY: 'true' }), /SENTRY_DSN_BACKEND/);
  const configured = { ...base, VH_SMOKE_INCLUDE_SENTRY: 'true',
    SENTRY_DSN_BACKEND: 'https://public@sentry.example.invalid/1',
    SENTRY_DSN_ADMIN: 'https://public@sentry.example.invalid/2',
    SENTRY_DSN_STAFF: 'https://public@sentry.example.invalid/3' };
  assert.equal(validateManualSmokeConfig('post-deploy', configured).includeSentry, true);
  assert.throws(() => validateManualSmokeConfig('post-deploy',
    { ...configured, SENTRY_DSN_STAFF: '' }), /SENTRY_DSN_STAFF/);
});

test('trial login is gated by exact full deployed commit, not a shared prefix', async () => {
  for (const commit of ['a'.repeat(7), 'b'.repeat(40), 'unknown']) {
    await assert.rejects(runManualSmokePreflight('trial-readiness', {
      env: base, fetchImpl: async () => ({ status: 200, json: async () => ({ commit }) }),
    }), /exact approved/);
  }
  const config = await runManualSmokePreflight('trial-readiness', {
    env: base, fetchImpl: async (url) => {
      assert.equal(url, 'https://api.example.invalid/health/version');
      return { status: 200, json: async () => ({ git_commit: base.VH_SMOKE_EXPECTED_COMMIT }) };
    },
  });
  assert.equal(config.expectedCommit, base.VH_SMOKE_EXPECTED_COMMIT);
});

test('short expected SHAs and unsuccessful version responses fail closed', async () => {
  assert.throws(() => validateManualSmokeConfig('trial-readiness',
    { ...base, VH_SMOKE_EXPECTED_COMMIT: 'aaaaaaa' }), /full deployed/);
  await assert.rejects(runManualSmokePreflight('trial-readiness', {
    env: base, fetchImpl: async () => ({ status: 503 }),
  }), /exact approved/);
});

test('post-deploy probes require the same exact target identity as trial probes', async () => {
  for (const response of [
    { status: 200, json: async () => ({ commit: 'b'.repeat(40) }) },
    { status: 503, json: async () => ({ commit: base.VH_SMOKE_EXPECTED_COMMIT }) },
    { status: 200, json: async () => { throw new Error('Malformed version response'); } },
  ]) {
    let calls = 0;
    await assert.rejects(runManualSmokePreflight('post-deploy', {
      env: base, fetchImpl: async (url, options) => {
        calls += 1;
        assert.equal(url, base.VH_TRIAL_API_ORIGIN + '/health/version');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers, undefined);
        return response;
      },
    }));
    assert.equal(calls, 1);
  }
});
