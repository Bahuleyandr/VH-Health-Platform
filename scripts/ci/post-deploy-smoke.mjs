#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import process from 'node:process';
import { runManualSmokePreflight } from './manual-smoke-preflight.mjs';

const config = await runManualSmokePreflight('post-deploy');

const outputDir = resolve('output/post-deploy-smoke');
mkdirSync(outputDir, { recursive: true });

const apiOrigin = config.apiOrigin;
const healthOrigin = trimSlash(apiOrigin.replace(/\/api\/v\d+$/i, ''));
const adminOrigin = config.adminOrigin;
const expectedCommit = config.expectedCommit;
const requireVersionMatch = true;
const sentryRequired = config.includeSentry;
const versionMatchTimeoutMs = Number(process.env.VH_VERSION_MATCH_TIMEOUT_MS || 10 * 60 * 1000);
const versionMatchPollMs = Number(process.env.VH_VERSION_MATCH_POLL_MS || 15 * 1000);
const monitoringToken = firstNonEmpty(
  process.env.VH_MONITORING_TOKEN,
  process.env.MONITORING_TOKEN,
  process.env.METRICS_TOKEN,
  process.env.INTERNAL_MONITORING_TOKEN,
);

const results = [];

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function firstNonEmpty(...values) {
  return values.find((value) => String(value || '').trim())?.trim() || '';
}

function baseHeaders(extra = {}) {
  return {
    'User-Agent': 'vh-health-post-deploy-smoke/1.0',
    ...extra,
  };
}

function monitoringHeaders() {
  return monitoringToken
    ? baseHeaders({ 'x-monitoring-token': monitoringToken })
    : baseHeaders();
}

function appendResult(result) {
  results.push({
    checked_at: new Date().toISOString(),
    ...result,
  });
}

async function probeJson(label, url, { required = true, expectStatus = 200, headers = null } = {}) {
  try {
    const startedAt = Date.now();
    const response = await fetch(url, {
      headers: headers || baseHeaders(),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const ok = response.status === expectStatus;
    appendResult({
      label,
      url,
      status: response.status,
      ok,
      required,
      duration_ms: Date.now() - startedAt,
      body: json ?? text.slice(0, 500),
    });
    return { ok, status: response.status, body: json, text };
  } catch (error) {
    appendResult({
      label,
      url,
      status: 'ERR',
      ok: false,
      required,
      error: error.message,
    });
    return { ok: false, status: 'ERR', body: null, error };
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function getDeployedCommit(versionBody) {
  return String(versionBody?.commit || versionBody?.git_commit || versionBody?.data?.git_commit || '');
}

function commitsMatch(deployed, expected) {
  if (!deployed || deployed === 'unknown' || !expected) return false;
  return deployed === expected;
}

async function sendSentrySmoke({ name, dsn }) {
  if (!dsn) {
    appendResult({
      label: `sentry:${name}`,
      ok: false,
      required: true,
      status: 'CONFIG_ERROR',
      message: 'Selected Sentry event smoke requires its DSN.',
    });
    return;
  }

  let endpoint;
  let eventId;
  try {
    const parsed = new URL(dsn);
    const projectId = parsed.pathname.split('/').filter(Boolean).pop();
    const publicKey = parsed.username;
    if (!projectId || !publicKey) throw new Error('DSN missing project id or public key');
    endpoint = `${parsed.protocol}//${parsed.host}/api/${projectId}/envelope/?sentry_key=${publicKey}`;
    eventId = randomBytes(16).toString('hex');
  } catch (error) {
    appendResult({
      label: `sentry:${name}`,
      ok: false,
      required: sentryRequired,
      status: 'CONFIG_ERROR',
      error: error.message,
    });
    return;
  }

  const now = new Date().toISOString();
  const envelope = [
    JSON.stringify({ dsn, sent_at: now }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify({
      event_id: eventId,
      timestamp: now,
      platform: 'javascript',
      level: 'info',
      message: `Post-deploy Sentry smoke: ${name}`,
      environment: process.env.SENTRY_SMOKE_ENVIRONMENT || 'post-deploy',
      release: expectedCommit || undefined,
      tags: {
        smoke: 'post_deploy',
        component: name,
        repository: process.env.GITHUB_REPOSITORY || 'unknown',
      },
      extra: {
        source: 'scripts/ci/post-deploy-smoke.mjs',
      },
    }),
    '',
  ].join('\n');

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'User-Agent': 'vh-health-post-deploy-smoke/1.0',
      },
      body: envelope,
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    appendResult({
      label: `sentry:${name}`,
      ok: response.status >= 200 && response.status < 300,
      required: sentryRequired,
      status: response.status,
      event_id: eventId,
    });
  } catch (error) {
    appendResult({
      label: `sentry:${name}`,
      ok: false,
      required: sentryRequired,
      status: 'ERR',
      event_id: eventId,
      error: error.message,
    });
  }
}

const live = await probeJson('backend:live', `${healthOrigin}/health/live`);
await probeJson('backend:ready', `${healthOrigin}/health/ready`, { headers: monitoringHeaders() });
let version = await probeJson('backend:version', `${healthOrigin}/health/version`);
await probeJson('backend:metrics', `${healthOrigin}/health/metrics`, { required: false, headers: monitoringHeaders() });
await probeJson('admin:login', `${adminOrigin}/login`);

if (version.ok && expectedCommit) {
  let deployed = getDeployedCommit(version.body);
  let match = commitsMatch(deployed, expectedCommit);
  if (!match && requireVersionMatch && versionMatchTimeoutMs > 0) {
    const deadline = Date.now() + versionMatchTimeoutMs;
    while (!match && Date.now() < deadline) {
      await sleep(versionMatchPollMs);
      version = await probeJson('backend:version-retry', `${healthOrigin}/health/version`);
      deployed = getDeployedCommit(version.body);
      match = commitsMatch(deployed, expectedCommit);
    }
  }
  appendResult({
    label: 'backend:version-match',
    ok: match,
    required: requireVersionMatch,
    status: match ? 'MATCH' : 'MISMATCH',
    expected_commit: expectedCommit,
    deployed_commit: deployed,
  });
}

if (!live.ok) {
  const legacyHealthUrl = /\/api\/v\d+$/i.test(apiOrigin)
    ? `${apiOrigin}/health`
    : `${apiOrigin}/api/v1/health`;
  await probeJson('backend:legacy-api-v1-health', legacyHealthUrl, { required: false });
}

if (config.includeSentry && results.some((result) => result.required && !result.ok)) {
  appendResult({ label: 'sentry', ok: false, required: true, status: 'HELD_TARGET_CHECK_FAILED' });
} else if (config.includeSentry) {
  await sendSentrySmoke({ name: 'backend', dsn: process.env.SENTRY_DSN_BACKEND });
  await sendSentrySmoke({ name: 'admin', dsn: process.env.SENTRY_DSN_ADMIN });
  await sendSentrySmoke({ name: 'staff', dsn: process.env.SENTRY_DSN_STAFF });
} else {
  appendResult({ label: 'sentry', ok: true, required: false, status: 'NOT_SELECTED' });
}

const report = {
  generated_at: new Date().toISOString(),
  api_origin: apiOrigin,
  health_origin: healthOrigin,
  admin_origin: adminOrigin,
  expected_commit: expectedCommit || null,
  require_version_match: requireVersionMatch,
  sentry_required: sentryRequired,
  authorized_by: config.authorizedBy,
  authority_ref: config.authorityRef,
  results,
};

writeFileSync(resolve(outputDir, 'post-deploy-smoke.json'), JSON.stringify(report, null, 2));

const failures = results.filter((result) => result.required && !result.ok);
if (failures.length > 0) {
  console.error(`Post-deploy smoke failed: ${failures.length} required check(s) failed.`);
  for (const failure of failures) {
    console.error(` - ${failure.label}: ${failure.status}${failure.error ? ` (${failure.error})` : ''}`);
  }
  process.exit(1);
}

console.log(`Post-deploy smoke passed with ${results.length} check(s).`);
