import process from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function required(env, key) {
  const value = String(env[key] || '').trim();
  if (!value) throw new Error('Missing required manual smoke input: ' + key);
  return value;
}

function origin(env, key) {
  const value = required(env, key);
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(key + ' must be an explicit HTTPS origin without credentials, path, query or fragment');
  }
  return parsed.origin;
}

function flag(env, key) {
  const value = String(env[key] || 'false').toLowerCase();
  if (!['true', 'false'].includes(value)) throw new Error(key + ' must be true or false');
  return value === 'true';
}

export function validateManualSmokeConfig(mode, env = process.env) {
  if (!['post-deploy', 'trial-readiness'].includes(mode)) throw new Error('Unknown manual smoke mode');
  const authorizedBy = required(env, 'VH_SMOKE_AUTHORIZED_BY');
  const authorityRef = required(env, 'VH_SMOKE_AUTHORITY_REF');
  const expectedCommit = required(env, 'VH_SMOKE_EXPECTED_COMMIT');
  if (!/^[a-f0-9]{40}$/.test(expectedCommit)) {
    throw new Error('VH_SMOKE_EXPECTED_COMMIT must be the exact full deployed commit SHA');
  }
  const apiOrigin = origin(env, 'VH_TRIAL_API_ORIGIN');
  if (mode === 'trial-readiness') {
    required(env, 'VH_API_KEY');
    required(env, 'VH_STAFF_TEST_PASSWORD');
    const includeCreates = flag(env, 'VH_SMOKE_INCLUDE_CREATES');
    if (includeCreates) required(env, 'VH_SMOKE_WRITES_AUTHORITY_REF');
    return { mode, authorizedBy, authorityRef, expectedCommit, apiOrigin, includeCreates };
  }
  const adminOrigin = origin(env, 'VH_TRIAL_ADMIN_ORIGIN');
  required(env, 'VH_MONITORING_TOKEN');
  const includeSentry = flag(env, 'VH_SMOKE_INCLUDE_SENTRY');
  if (flag(env, 'SENTRY_SMOKE_REQUIRED') && !includeSentry) {
    throw new Error('Required Sentry smoke must be explicitly included');
  }
  if (includeSentry) {
    for (const key of ['SENTRY_DSN_BACKEND', 'SENTRY_DSN_ADMIN', 'SENTRY_DSN_STAFF']) {
      const dsn = new URL(required(env, key));
      if (dsn.protocol !== 'https:' || !dsn.username || !/\/[^/]+$/.test(dsn.pathname)) {
        throw new Error(key + ' is not a valid HTTPS Sentry DSN');
      }
    }
  }
  return { mode, authorizedBy, authorityRef, expectedCommit, apiOrigin, adminOrigin, includeSentry };
}

export function deployedCommit(body) {
  return String(body?.commit || body?.git_commit || body?.data?.git_commit || '');
}

export async function runManualSmokePreflight(mode, { env = process.env, fetchImpl = fetch } = {}) {
  const config = validateManualSmokeConfig(mode, env);
  const response = await fetchImpl(config.apiOrigin + '/health/version', {
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if (response.status !== 200 || deployedCommit(await response.json()) !== config.expectedCommit) {
    throw new Error('Smoke target does not report the exact approved deployed commit');
  }
  return config;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const modeIndex = process.argv.indexOf('--mode');
    const mode = modeIndex < 0 ? '' : process.argv[modeIndex + 1];
    await runManualSmokePreflight(mode);
    console.log('Manual smoke prerequisites verified (' + mode + ').');
  } catch (error) {
    console.error('Manual smoke held: ' + error.message);
    process.exitCode = 1;
  }
}
