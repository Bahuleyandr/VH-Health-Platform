import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 20 },   // ramp up
    { duration: '1m', target: 50 },    // steady
    { duration: '30s', target: 100 },  // peak
    { duration: '30s', target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],  // 95th percentile < 500ms
    http_req_failed: ['rate<0.01'],     // <1% error rate
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5000';

export default function () {
  // Health check
  const healthRes = http.get(`${BASE_URL}/`);
  check(healthRes, { 'health check status 200': (r) => r.status === 200 });
  sleep(1);
}
