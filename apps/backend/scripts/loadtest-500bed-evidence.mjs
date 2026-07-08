#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIRMATION = 'I_HAVE_APPROVAL_AND_SYNTHETIC_DATA';
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(backendRoot, '../..');
const queries = [
  {
    key: 'request_rate',
    title: 'Backend request rate',
    expr: 'sum(rate(http_requests_total[5m]))',
  },
  {
    key: 'error_ratio_5xx',
    title: 'Backend 5xx ratio',
    expr: 'sum(rate(http_requests_total{status_code=~"5.."}[5m])) / clamp_min(sum(rate(http_requests_total[5m])),1e-9)',
  },
  {
    key: ['p95', 'latency', 'seconds'].join('_'),
    title: 'Backend p95 latency',
    expr: 'histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))',
  },
  {
    key: 'slo_error_ratio_5m',
    title: 'SLO error ratio 5m',
    expr: 'job:slo_error:ratio_rate5m',
  },
  {
    key: 'slo_error_ratio_1h',
    title: 'SLO error ratio 1h',
    expr: 'job:slo_error:ratio_rate1h',
  },
  {
    key: 'db_circuit_breaker_open',
    title: 'DB circuit breaker open',
    expr: 'max(db_circuit_breaker_open)',
  },
  {
    key: 'db_read_replica_lag_seconds',
    title: 'DB read-replica lag seconds',
    expr: 'max(db_read_replica_lag_seconds)',
  },
];

const args = parseArgs(process.argv.slice(2));
const now = new Date();
const timestamp = now.toISOString().replace(/[:.]/g, '-');
const outputDir = resolveRepoPath(valueOf('OUTPUT_DIR', `output/loadtest/nl12-s3-500bed-${timestamp}`));
const confirmation = valueOf('LOADTEST_500BED_CONFIRM', '');

if (confirmation !== CONFIRMATION) {
  console.error(`Set LOADTEST_500BED_CONFIRM=${CONFIRMATION} before collecting 500-bed evidence.`);
  process.exit(2);
}

const runMeta = {
  generated_at: now.toISOString(),
  target_environment: valueOf('TARGET_ENVIRONMENT', ''),
  owner_approved_by: valueOf('OWNER_APPROVED_BY', ''),
  run_window_start: valueOf('LOADTEST_WINDOW_START', ''),
  run_window_end: valueOf('LOADTEST_WINDOW_END', ''),
  synthetic_pool_id: valueOf('SYNTHETIC_POOL_ID', ''),
  slo_decision: valueOf('SLO_DECISION', 'pending'),
  k6_summary_json: valueOf('K6_SUMMARY_JSON', ''),
  prometheus_url: valueOf('PROMETHEUS_URL', ''),
  grafana_url: valueOf('GRAFANA_URL', ''),
};

for (const required of ['target_environment', 'owner_approved_by', 'run_window_start', 'run_window_end', 'synthetic_pool_id']) {
  if (!runMeta[required]) {
    console.error(`Missing required evidence field: ${required}`);
    process.exit(2);
  }
}

mkdirSync(outputDir, { recursive: true });

const k6Summary = runMeta.k6_summary_json ? readK6Summary(runMeta.k6_summary_json) : null;
const prometheusSnapshots = await collectPrometheusSnapshots(runMeta);
const grafanaLinks = buildGrafanaLinks(runMeta);

const evidence = {
  ...runMeta,
  k6: k6Summary,
  prometheus: prometheusSnapshots,
  grafana: grafanaLinks,
};

writeJson(path.join(outputDir, 'evidence.json'), evidence);
writeJson(path.join(outputDir, 'prometheus-snapshots.json'), prometheusSnapshots);
writeJson(path.join(outputDir, 'grafana-links.json'), grafanaLinks);
writeFileSync(path.join(outputDir, 'evidence.md'), renderMarkdown(evidence), 'utf8');

console.log(`NL12-S3 evidence bundle written to ${outputDir}`);

if (prometheusSnapshots.status === 'failed') {
  process.exit(1);
}

function valueOf(name, fallback) {
  const argKey = name.toLowerCase().replaceAll('_', '-');
  return args[argKey] || process.env[name] || fallback;
}

function parseArgs(argv) {
  const parsed = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) {
      positionals.push(raw);
      continue;
    }
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = 'true';
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  if (!parsed['output-dir'] && positionals[0]) {
    parsed['output-dir'] = positionals[0];
  }
  return parsed;
}

function resolveRepoPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
}

function readK6Summary(filePath) {
  const absolute = resolveRepoPath(filePath);
  const raw = JSON.parse(readFileSync(absolute, 'utf8'));
  const metrics = raw.metrics || {};
  return {
    source: absolute,
    read_p95_ms: metricValue(metrics.vh_500bed_read_latency, 'p(95)'),
    write_p95_ms: metricValue(metrics.vh_500bed_write_latency, 'p(95)'),
    error_rate: metricValue(metrics.vh_500bed_error_rate, 'rate'),
    throttled_rate: metricValue(metrics.vh_500bed_throttled_rate, 'rate'),
    checks_rate: metricValue(metrics.checks, 'rate'),
    vus_max: metricValue(metrics.vus_max, 'value'),
    iterations: metricValue(metrics.iterations, 'count'),
  };
}

function metricValue(metric, key) {
  const value = metric?.values?.[key];
  return typeof value === 'number' ? value : null;
}

async function collectPrometheusSnapshots(meta) {
  if (!meta.prometheus_url) {
    return {
      status: 'skipped',
      reason: 'PROMETHEUS_URL not supplied',
      queries,
    };
  }

  const start = seconds(meta.run_window_start);
  const end = seconds(meta.run_window_end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return {
      status: 'failed',
      reason: 'LOADTEST_WINDOW_START and LOADTEST_WINDOW_END must parse as date-times with end after start',
      queries,
    };
  }

  const results = [];
  let failed = false;
  for (const query of queries) {
    try {
      results.push({
        ...query,
        status: 'ok',
        result: await prometheusQueryRange(meta.prometheus_url, query.expr, start, end),
      });
    } catch (err) {
      failed = true;
      results.push({
        ...query,
        status: 'failed',
        error: err.message,
      });
    }
  }

  return {
    status: failed ? 'failed' : 'ok',
    start: meta.run_window_start,
    end: meta.run_window_end,
    results,
  };
}

async function prometheusQueryRange(baseUrl, query, start, end) {
  const url = new URL('api/v1/query_range', ensureTrailingSlash(baseUrl));
  url.searchParams.set('query', query);
  url.searchParams.set('start', String(start));
  url.searchParams.set('end', String(end));
  url.searchParams.set('step', valueOf('PROMETHEUS_STEP', '30s'));

  const headers = {};
  const bearer = process.env.PROMETHEUS_BEARER_TOKEN || '';
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Prometheus ${response.status} for ${query}`);
  }
  const body = await response.json();
  if (body.status !== 'success') {
    throw new Error(`Prometheus query failed: ${body.error || body.status}`);
  }
  return body.data?.result || [];
}

function buildGrafanaLinks(meta) {
  if (!meta.grafana_url) {
    return {
      status: 'skipped',
      reason: 'GRAFANA_URL not supplied',
      required_screenshots: requiredScreenshots(),
    };
  }

  const from = milliseconds(meta.run_window_start);
  const to = milliseconds(meta.run_window_end);
  const dashboards = [
    { key: 'backend_red', uid: 'vhhealth-backend-red', title: 'VH Health - Backend RED' },
    { key: 'backend_reliability', uid: 'vhhealth-backend-reliability', title: 'VH Health - Backend Reliability' },
  ];

  return {
    status: 'ok',
    required_screenshots: requiredScreenshots(),
    dashboards: dashboards.map((dashboard) => ({
      ...dashboard,
      url: grafanaDashboardUrl(meta.grafana_url, dashboard.uid, from, to),
    })),
  };
}

function grafanaDashboardUrl(baseUrl, uid, from, to) {
  const url = new URL(`d/${uid}`, ensureTrailingSlash(baseUrl));
  if (Number.isFinite(from) && Number.isFinite(to)) {
    url.searchParams.set('from', String(from));
    url.searchParams.set('to', String(to));
  }
  return url.toString();
}

function requiredScreenshots() {
  return [
    'grafana-backend-red.png',
    'grafana-backend-reliability.png',
    'grafana-cnpg-overview.png',
    'grafana-slo-burn-rate.png',
    'k6-terminal-summary.png',
  ];
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function renderMarkdown(evidence) {
  const k6 = evidence.k6 || {};
  const prometheusStatus = evidence.prometheus?.status || 'skipped';
  const grafanaStatus = evidence.grafana?.status || 'skipped';
  const lines = [
    '# NL12-S3 500-Bed Load Evidence',
    '',
    `Generated at: ${evidence.generated_at}`,
    `Target environment: ${evidence.target_environment}`,
    `Owner approval: ${evidence.owner_approved_by}`,
    `Run window: ${evidence.run_window_start} to ${evidence.run_window_end}`,
    `Synthetic pool: ${evidence.synthetic_pool_id}`,
    `SLO decision: ${evidence.slo_decision}`,
    '',
    '## k6 Summary',
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| Read p95 | ${formatMs(k6.read_p95_ms)} |`,
    `| Write p95 | ${formatMs(k6.write_p95_ms)} |`,
    `| Error rate | ${formatPercent(k6.error_rate)} |`,
    `| Throttled rate | ${formatPercent(k6.throttled_rate)} |`,
    `| Checks rate | ${formatPercent(k6.checks_rate)} |`,
    `| Max VUs | ${k6.vus_max ?? 'n/a'} |`,
    `| Iterations | ${k6.iterations ?? 'n/a'} |`,
    '',
    '## Snapshot Status',
    '',
    `Prometheus snapshots: ${prometheusStatus}`,
    `Grafana links: ${grafanaStatus}`,
    '',
    '## Required Attachments',
    '',
    ...requiredScreenshots().map((name) => `- ${name}`),
    '',
    '## Operator Decision',
    '',
    '- Keep current SLOs / lower targets / raise targets: pending',
    '- Capacity or topology action required before pilot: pending',
    '- Follow-up ticket: pending',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function seconds(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}

function milliseconds(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

function formatMs(value) {
  return typeof value === 'number' ? `${value.toFixed(1)} ms` : 'n/a';
}

function formatPercent(value) {
  return typeof value === 'number' ? `${(value * 100).toFixed(2)}%` : 'n/a';
}

function writeJson(filePath, data) {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
