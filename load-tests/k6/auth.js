import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 10 },   // ramp up
    { duration: '1m', target: 30 },    // steady
    { duration: '30s', target: 60 },   // peak
    { duration: '30s', target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],   // 95th percentile < 500ms
    http_req_failed: ['rate<0.01'],      // <1% error rate
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5000';
const API_KEY = __ENV.API_KEY || 'test-api-key';

const headers = {
  'Content-Type': 'application/json',
  'x-api-key': API_KEY,
};

/**
 * Test OTP request and token refresh endpoints under load.
 *
 * NOTE: These tests hit auth endpoints that are rate-limited in production
 * (OTP: 3 per phone per 10min). Use a test environment with relaxed limits,
 * or adjust the VU count accordingly.
 */
export default function () {
  // ── OTP request endpoint ──────────────────────────────────────────────────
  // Simulate requesting an OTP for a random test phone number.
  // In a real load test, use a pool of test numbers that the backend
  // recognises as load-test traffic (and does not actually send SMS).
  const vuPhone = `+9199000${String(__VU).padStart(5, '0')}`;

  const otpRes = http.post(
    `${BASE_URL}/api/v1/auth/firebase/request-otp`,
    JSON.stringify({ phone: vuPhone }),
    { headers, tags: { name: 'OTP_request' } },
  );
  check(otpRes, {
    'OTP request status 2xx or 429': (r) => (r.status >= 200 && r.status < 300) || r.status === 429,
  });

  // Realistic delay — user waits for SMS and types OTP
  sleep(Math.random() * 3 + 2); // 2-5 seconds

  // ── Token refresh endpoint ────────────────────────────────────────────────
  // Simulate refreshing an expired JWT. In a real test you would obtain a
  // valid refresh token during setup; here we verify the endpoint responds
  // correctly (401 for invalid token is acceptable — we're testing throughput).
  const refreshRes = http.post(
    `${BASE_URL}/api/v1/auth/staff/refresh-token`,
    JSON.stringify({ refreshToken: 'load-test-placeholder-token' }),
    { headers, tags: { name: 'token_refresh' } },
  );
  check(refreshRes, {
    'token refresh responds': (r) => r.status === 200 || r.status === 401 || r.status === 400,
  });

  // Realistic delay between auth operations
  sleep(Math.random() * 2 + 1); // 1-3 seconds
}
