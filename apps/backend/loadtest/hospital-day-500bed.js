// k6 load profile - NL12-S3 500-bed synthetic hospital day.
//
// This is intentionally separate from hospital-day.js. The baseline script is
// a smaller release gate; this profile is an operator-approved scale ceremony
// for production-shaped infrastructure with synthetic data only.
//
// Smoke:
//   k6 run -e PROFILE=smoke -e BASE_URL=http://127.0.0.1:5000 \
//     -e API_KEY=... -e STAFF_TOKEN=... -e ADMIN_TOKEN=... \
//     apps/backend/loadtest/hospital-day-500bed.js
//
// Full 500-bed profile requires explicit approval guards:
//   LOADTEST_500BED_CONFIRM=I_HAVE_APPROVAL_AND_SYNTHETIC_DATA
//   PRODUCTION_SHAPED_ENV=confirmed
//   OWNER_APPROVED_BY=<name/change-ticket>
//   SYNTHETIC_PATIENT_UIDS=<comma-separated synthetic patient UUIDs>
//   TARGET_ENVIRONMENT=<staging/prod-shaped environment name>

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:5000';
const API_KEY = __ENV.API_KEY || '';
const STAFF_TOKEN = __ENV.STAFF_TOKEN || '';
const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || '';
const PROFILE = __ENV.PROFILE || 'full';
const SMOKE = PROFILE === 'smoke';
const LOAD_SCALE = SMOKE ? 0.08 : positiveNumber(__ENV.LOAD_SCALE, 1);
const PATIENT_UIDS = splitEnv(__ENV.SYNTHETIC_PATIENT_UIDS || __ENV.LOADTEST_PATIENT_UIDS);
const WARD_IDS = splitEnv(__ENV.LOADTEST_WARD_IDS || '1,2,3,4,5,6,7,8,9,10,11,12');

const readLatency = new Trend('vh_500bed_read_latency', true);
const writeLatency = new Trend('vh_500bed_write_latency', true);
const errorRate = new Rate('vh_500bed_error_rate');
const throttledRate = new Rate('vh_500bed_throttled_rate');
const syntheticWritesSkipped = new Counter('vh_500bed_synthetic_writes_skipped');

guardFullRun();

export const options = {
  scenarios: {
    opd_arrival_rush: {
      executor: 'ramping-vus',
      exec: 'opdArrivalRush',
      startVUs: 0,
      stages: rampStages(120),
      tags: { shape: 'opd_arrival_rush', nl12_slice: 's3_500bed' },
    },
    ward_rounds: {
      executor: 'ramping-vus',
      exec: 'wardRounds',
      startVUs: 0,
      startTime: SMOKE ? '10s' : '3m',
      stages: rampStages(85),
      tags: { shape: 'ward_rounds', nl12_slice: 's3_500bed' },
    },
    med_pass: {
      executor: 'ramping-vus',
      exec: 'medPass',
      startVUs: 0,
      startTime: SMOKE ? '20s' : '5m',
      stages: rampStages(150),
      tags: { shape: 'med_pass', nl12_slice: 's3_500bed' },
    },
    bed_board: {
      executor: 'ramping-vus',
      exec: 'bedBoard',
      startVUs: 0,
      startTime: SMOKE ? '30s' : '8m',
      stages: rampStages(45),
      tags: { shape: 'bed_board', nl12_slice: 's3_500bed' },
    },
    admin_fanout: {
      executor: 'constant-vus',
      exec: 'adminFanout',
      vus: scaled(20),
      duration: SMOKE ? '3m' : '45m',
      tags: { shape: 'admin_fanout', nl12_slice: 's3_500bed' },
    },
    slo_probe: {
      executor: 'constant-vus',
      exec: 'sloProbe',
      vus: scaled(5),
      duration: SMOKE ? '3m' : '45m',
      tags: { shape: 'slo_probe', nl12_slice: 's3_500bed' },
    },
  },
  thresholds: {
    vh_500bed_read_latency: ['p(95)<400'],
    vh_500bed_write_latency: ['p(95)<800'],
    vh_500bed_error_rate: ['rate<0.01'],
    vh_500bed_throttled_rate: ['rate<0.05'],
    checks: ['rate>0.99'],
  },
};

const departmentMix = [
  'opd',
  'ipd-general',
  'icu',
  'emergency',
  'lab',
  'radiology',
  'pharmacy',
  'theatre',
];

export function opdArrivalRush() {
  const status = pick(['SCHEDULED', 'CONFIRMED']);
  trackRead(get(`/api/v1/appointments/list?limit=30&status=${status}`, STAFF_TOKEN, {
    op: 'appointment_list',
    department: 'opd',
  }));
  trackRead(get('/api/v1/appointments/today/list', STAFF_TOKEN, {
    op: 'appointment_today',
    department: 'opd',
  }));
  sleep(jitter(0.4, 2.0));
}

export function wardRounds() {
  const wardId = pick(WARD_IDS);
  trackRead(get('/api/v1/beds/summary', STAFF_TOKEN, {
    op: 'bed_summary',
    department: 'ipd-general',
  }));
  trackRead(get(`/api/v1/clinical/mar/due?ward_id=${wardId}&past_minutes=180&future_minutes=240`, STAFF_TOKEN, {
    op: 'mar_due',
    department: 'ipd-general',
    ward_id: wardId,
  }));
  trackRead(get('/api/v1/downtime/wards', STAFF_TOKEN, {
    op: 'downtime_ward_packs',
    department: 'ipd-general',
  }));
  sleep(jitter(1.0, 4.0));
}

export function medPass() {
  const wardId = pick(WARD_IDS);
  trackRead(get(`/api/v1/clinical/mar/overdue?ward_id=${wardId}`, STAFF_TOKEN, {
    op: 'mar_overdue',
    department: 'ipd-general',
    ward_id: wardId,
  }));
  trackRead(get(`/api/v1/clinical/mar/due?ward_id=${wardId}&past_minutes=120&future_minutes=120`, STAFF_TOKEN, {
    op: 'mar_due_med_pass',
    department: 'ipd-general',
    ward_id: wardId,
  }));

  const patientUid = pick(PATIENT_UIDS);
  if (patientUid) {
    trackWrite(post('/api/v1/emr/vitals', STAFF_TOKEN, vitalPayload(patientUid), {
      op: 'synthetic_vitals_write',
      department: 'ipd-general',
      ward_id: wardId,
    }));
  } else {
    syntheticWritesSkipped.add(1, { reason: 'missing_synthetic_patient_uid' });
  }
  sleep(jitter(0.8, 3.5));
}

export function bedBoard() {
  const wardId = pick(WARD_IDS);
  trackRead(get('/api/v1/beds?status=occupied', STAFF_TOKEN, {
    op: 'bed_list_occupied',
    department: 'ipd-general',
  }));
  trackRead(get(`/api/v1/beds/available?ward_id=${wardId}`, STAFF_TOKEN, {
    op: 'bed_available',
    department: 'ipd-general',
    ward_id: wardId,
  }));
  trackRead(get('/api/v1/beds/occupancy', STAFF_TOKEN, {
    op: 'bed_occupancy',
    department: 'ipd-general',
  }));
  sleep(jitter(1.5, 5.0));
}

export function adminFanout() {
  const department = pick(departmentMix);
  trackRead(get('/api/v1/dashboards/snapshot/daily-ops', ADMIN_TOKEN, {
    op: 'daily_ops',
    department,
  }));
  trackRead(get('/api/v1/dashboards/snapshot/ip-occupancy', ADMIN_TOKEN, {
    op: 'ip_occupancy',
    department: 'ipd-general',
  }));
  trackRead(get('/api/v1/dashboards/snapshot/lab-tat', ADMIN_TOKEN, {
    op: 'lab_tat',
    department: 'lab',
  }));
  if ((__ITER % 4) === 0) {
    trackRead(get('/api/v1/dashboards/snapshot/opd-daily', ADMIN_TOKEN, {
      op: 'opd_daily',
      department: 'opd',
    }));
  }
  sleep(jitter(4.0, 10.0));
}

export function sloProbe() {
  trackRead(http.get(`${BASE}/health/metrics`, {
    headers: { 'X-API-Key': API_KEY },
    tags: { op: 'health_metrics', department: 'platform' },
  }));
  sleep(jitter(5.0, 12.0));
}

export function handleSummary(data) {
  const summary = renderMarkdownSummary(data);
  const evidenceDir = __ENV.EVIDENCE_DIR || '';
  if (!evidenceDir) {
    return { stdout: summary };
  }

  return {
    stdout: summary,
    [`${evidenceDir}/k6-summary.json`]: JSON.stringify(data, null, 2),
    [`${evidenceDir}/k6-summary.md`]: summary,
  };
}

function get(path, token, tags) {
  return http.get(`${BASE}${path}`, { headers: headers(token), tags });
}

function post(path, token, body, tags) {
  return http.post(`${BASE}${path}`, JSON.stringify(body), { headers: headers(token), tags });
}

function headers(token) {
  return {
    'X-API-Key': API_KEY,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function trackRead(res) {
  readLatency.add(res.timings.duration, res.request?.tags || {});
  trackStatus(res, 'read accepted');
}

function trackWrite(res) {
  writeLatency.add(res.timings.duration, res.request?.tags || {});
  trackStatus(res, 'write accepted');
}

function trackStatus(res, label) {
  const accepted = (res.status >= 200 && res.status < 400) || res.status === 429;
  errorRate.add(!accepted, res.request?.tags || {});
  throttledRate.add(res.status === 429, res.request?.tags || {});
  check(res, { [label]: () => accepted });
}

function vitalPayload(patientUid) {
  return {
    patient_uid: patientUid,
    heart_rate: 68 + Math.floor(Math.random() * 26),
    respiratory_rate: 14 + Math.floor(Math.random() * 6),
    spo2: 95 + Math.floor(Math.random() * 4),
    systolic_bp: 108 + Math.floor(Math.random() * 28),
    diastolic_bp: 68 + Math.floor(Math.random() * 14),
    temperature: Number((36.4 + Math.random() * 0.8).toFixed(1)),
    source: 'nl12_s3_500bed_synthetic_load',
  };
}

function rampStages(peak) {
  const target = scaled(peak);
  if (SMOKE) {
    return [
      { duration: '30s', target },
      { duration: '2m', target },
      { duration: '30s', target: 0 },
    ];
  }

  return [
    { duration: '5m', target },
    { duration: '30m', target },
    { duration: '5m', target: 0 },
  ];
}

function scaled(peak) {
  return Math.max(SMOKE ? 1 : 3, Math.ceil(peak * LOAD_SCALE));
}

function splitEnv(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function pick(values) {
  if (!values || values.length === 0) {
    return null;
  }
  return values[Math.floor(Math.random() * values.length)];
}

function jitter(minSeconds, maxSeconds) {
  return minSeconds + (Math.random() * (maxSeconds - minSeconds));
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function guardFullRun() {
  const missing = [];
  if (!API_KEY) missing.push('API_KEY');
  if (!STAFF_TOKEN) missing.push('STAFF_TOKEN');
  if (!ADMIN_TOKEN) missing.push('ADMIN_TOKEN');

  if (!SMOKE) {
    if (__ENV.LOADTEST_500BED_CONFIRM !== 'I_HAVE_APPROVAL_AND_SYNTHETIC_DATA') {
      missing.push('LOADTEST_500BED_CONFIRM=I_HAVE_APPROVAL_AND_SYNTHETIC_DATA');
    }
    if (__ENV.PRODUCTION_SHAPED_ENV !== 'confirmed') {
      missing.push('PRODUCTION_SHAPED_ENV=confirmed');
    }
    if (!__ENV.OWNER_APPROVED_BY) {
      missing.push('OWNER_APPROVED_BY');
    }
    if (!__ENV.TARGET_ENVIRONMENT) {
      missing.push('TARGET_ENVIRONMENT');
    }
    if (!__ENV.SYNTHETIC_POOL_ID) {
      missing.push('SYNTHETIC_POOL_ID');
    }
    if (PATIENT_UIDS.length === 0) {
      missing.push('SYNTHETIC_PATIENT_UIDS');
    }
    if (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/i.test(BASE) && __ENV.ALLOW_LOCAL_500BED !== 'true') {
      missing.push('non-local BASE_URL or ALLOW_LOCAL_500BED=true');
    }
  }

  if (missing.length > 0) {
    throw new Error(`NL12-S3 500-bed profile missing guardrails: ${missing.join(', ')}`);
  }
}

function renderMarkdownSummary(data) {
  const metrics = data.metrics || {};
  const lines = [
    '# NL12-S3 500-Bed k6 Summary',
    '',
    `Generated at: ${new Date().toISOString()}`,
    `Profile: ${PROFILE}`,
    `Target environment: ${__ENV.TARGET_ENVIRONMENT || 'smoke/local'}`,
    '',
    '| Metric | Value | Threshold |',
    '| --- | ---: | --- |',
    metricRow(metrics.vh_500bed_read_latency, 'Read p95', 'p95 < 400 ms', 'p(95)', 'ms'),
    metricRow(metrics.vh_500bed_write_latency, 'Write p95', 'p95 < 800 ms', 'p(95)', 'ms'),
    metricRow(metrics.vh_500bed_error_rate, 'Error rate', '< 1%', 'rate', 'pct'),
    metricRow(metrics.vh_500bed_throttled_rate, 'Throttled rate', '< 5%', 'rate', 'pct'),
    '',
    'Attach this file with the Grafana RED, reliability, CNPG, and SLO burn-rate snapshots listed in `500-bed-slo-rebaseline-template.md`.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function metricRow(metric, label, threshold, key, unit) {
  const raw = metric?.values?.[key];
  const value = typeof raw === 'number'
    ? (unit === 'pct' ? `${(raw * 100).toFixed(2)}%` : raw.toFixed(1))
    : 'n/a';
  return `| ${label} | ${value} | ${threshold} |`;
}
