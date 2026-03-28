import http from 'k6/http';
import { check, sleep, group } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 15 },   // ramp up
    { duration: '1m', target: 40 },    // steady
    { duration: '30s', target: 80 },   // peak
    { duration: '30s', target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],   // 95th percentile < 500ms
    http_req_failed: ['rate<0.01'],      // <1% error rate
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5000';
const API_KEY = __ENV.API_KEY || 'test-api-key';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || 'test-jwt-token';

const headers = {
  'Content-Type': 'application/json',
  'x-api-key': API_KEY,
  'Authorization': `Bearer ${AUTH_TOKEN}`,
};

/**
 * Test core API endpoints under load.
 *
 * Prerequisites:
 *   - Set AUTH_TOKEN to a valid JWT (generate with: npm run generate-admin-token)
 *   - Set API_KEY to match the backend's API_KEY env var
 *   - Set BASE_URL if not running locally
 *
 * Example:
 *   k6 run -e BASE_URL=http://localhost:5000 \
 *          -e API_KEY=your-api-key \
 *          -e AUTH_TOKEN=your-jwt \
 *          load-tests/k6/api.js
 */
export default function () {
  // ── Dashboard endpoint ────────────────────────────────────────────────────
  group('Dashboard', () => {
    const dashRes = http.get(
      `${BASE_URL}/api/v1/dashboard?phone=+919900000001`,
      { headers, tags: { name: 'GET_dashboard' } },
    );
    check(dashRes, {
      'dashboard status 200': (r) => r.status === 200,
      'dashboard has data': (r) => {
        try { return JSON.parse(r.body).success === true; }
        catch { return false; }
      },
    });
  });

  sleep(Math.random() * 2 + 1); // 1-3 seconds (simulate user reading dashboard)

  // ── Appointments list ─────────────────────────────────────────────────────
  group('Appointments', () => {
    const apptRes = http.get(
      `${BASE_URL}/api/v1/appointments/list`,
      { headers, tags: { name: 'GET_appointments' } },
    );
    check(apptRes, {
      'appointments status 200': (r) => r.status === 200,
      'appointments returns array': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.success === true && Array.isArray(body.data);
        } catch { return false; }
      },
    });
  });

  sleep(Math.random() * 2 + 1); // 1-3 seconds

  // ── Pharmacy orders list ──────────────────────────────────────────────────
  group('Pharmacy Orders', () => {
    const pharmaRes = http.get(
      `${BASE_URL}/api/v1/pharmacy-orders/orders/my`,
      { headers, tags: { name: 'GET_pharmacy_orders' } },
    );
    check(pharmaRes, {
      'pharmacy orders status 200 or 401': (r) => r.status === 200 || r.status === 401,
    });
  });

  sleep(Math.random() * 2 + 1); // 1-3 seconds
}
