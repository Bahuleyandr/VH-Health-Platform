// k6 load profile — "a hospital day in 20 minutes" (roadmap A5).
//
// Models the three load shapes that actually hurt an HIS:
//   1. opd_rush   — 08:00–11:00 registration/appointment listing burst
//   2. mar_storm  — med-pass hours: every ward nurse pulls due-lists at once
//   3. dashboards — admin polling (cheap but constant)
//
// Run (smoke, 2 min):
//   k6 run --env BASE_URL=http://localhost:5000 --env API_KEY=... \
//          --env STAFF_TOKEN=... --env ADMIN_TOKEN=... \
//          -e PROFILE=smoke apps/backend/loadtest/hospital-day.js
// Full profile: omit PROFILE (20 min). CI wiring: loadtest README.
//
// SLOs asserted as k6 thresholds (fail the run when breached):
//   * p95 read latency  < 400 ms   (chart/list reads)
//   * p95 write latency < 800 ms   (orders/vitals writes)
//   * error rate        < 1 %      (non-2xx/3xx, excluding 429)
//
// Tokens: forge via the staff/admin login endpoints beforehand, or use
// scripts in the README. The script never creates PHI — reads target the
// seeded QA dataset; the single write path posts vitals to a dedicated
// load-test patient (LOADTEST_PATIENT_UID) and is skipped when unset.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:5000';
const API_KEY = __ENV.API_KEY || '';
const STAFF_TOKEN = __ENV.STAFF_TOKEN || '';
const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || '';
const SMOKE = (__ENV.PROFILE || '') === 'smoke';

const readLatency = new Trend('vh_read_latency', true);
const writeLatency = new Trend('vh_write_latency', true);
const errorRate = new Rate('vh_error_rate');

const stagesFor = (peak) => (SMOKE
  ? [{ duration: '30s', target: Math.max(2, Math.ceil(peak / 10)) }, { duration: '60s', target: Math.max(2, Math.ceil(peak / 10)) }, { duration: '30s', target: 0 }]
  : [{ duration: '3m', target: peak }, { duration: '10m', target: peak }, { duration: '2m', target: 0 }]);

export const options = {
  scenarios: {
    opd_rush: {
      executor: 'ramping-vus',
      exec: 'opdRush',
      startVUs: 0,
      stages: stagesFor(40),
      tags: { shape: 'opd_rush' },
    },
    mar_storm: {
      executor: 'ramping-vus',
      exec: 'marStorm',
      startVUs: 0,
      stages: stagesFor(25),
      tags: { shape: 'mar_storm' },
    },
    dashboards: {
      executor: 'constant-vus',
      exec: 'dashboards',
      vus: SMOKE ? 1 : 5,
      duration: SMOKE ? '2m' : '15m',
      tags: { shape: 'dashboards' },
    },
  },
  thresholds: {
    vh_read_latency: ['p(95)<400'],
    vh_write_latency: ['p(95)<800'],
    vh_error_rate: ['rate<0.01'],
  },
};

function headers(token) {
  return {
    'X-API-Key': API_KEY,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function trackRead(res) {
  readLatency.add(res.timings.duration);
  errorRate.add(!(res.status >= 200 && res.status < 400) && res.status !== 429);
  check(res, { 'read ok': (r) => r.status === 200 });
}

export function opdRush() {
  trackRead(http.get(`${BASE}/api/v1/appointments/list?limit=20`, { headers: headers(STAFF_TOKEN), tags: { op: 'appt_list' } }));
  trackRead(http.get(`${BASE}/api/v1/appointments/today/list`, { headers: headers(STAFF_TOKEN), tags: { op: 'appt_today' } }));
  sleep(Math.random() * 2 + 0.5);
}

export function marStorm() {
  trackRead(http.get(`${BASE}/api/v1/downtime/wards`, { headers: headers(STAFF_TOKEN), tags: { op: 'ward_packs' } }));
  trackRead(http.get(`${BASE}/api/v1/appointments/list?limit=10&status=CONFIRMED`, { headers: headers(STAFF_TOKEN), tags: { op: 'confirmed_list' } }));
  const patientUid = __ENV.LOADTEST_PATIENT_UID;
  if (patientUid) {
    const res = http.post(`${BASE}/api/v1/emr/vitals`, JSON.stringify({
      patient_uid: patientUid,
      heart_rate: 70 + Math.floor(Math.random() * 20),
      respiratory_rate: 14 + Math.floor(Math.random() * 4),
      spo2: 96 + Math.floor(Math.random() * 3),
      systolic_bp: 110 + Math.floor(Math.random() * 20),
      diastolic_bp: 70 + Math.floor(Math.random() * 10),
      temperature: 36.5,
    }), { headers: headers(STAFF_TOKEN), tags: { op: 'vitals_write' } });
    writeLatency.add(res.timings.duration);
    errorRate.add(!(res.status >= 200 && res.status < 400) && res.status !== 429);
  }
  sleep(Math.random() * 3 + 1);
}

export function dashboards() {
  trackRead(http.get(`${BASE}/api/v1/dashboards/snapshot/daily-ops`, { headers: headers(ADMIN_TOKEN), tags: { op: 'daily_ops' } }));
  trackRead(http.get(`${BASE}/health/metrics`, { headers: { 'X-API-Key': API_KEY }, tags: { op: 'metrics' } }));
  sleep(5);
}
