# Load Tests

Load testing infrastructure for VH Health Backend using [k6](https://k6.io/).

## Prerequisites

### Install k6

**macOS:**
```bash
brew install k6
```

**Linux (Debian/Ubuntu):**
```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D68
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

**Docker:**
```bash
docker pull grafana/k6
```

**Windows:**
```bash
choco install k6
# or
winget install k6 --source winget
```

## Test Scripts

| Script | Description | What it tests |
|--------|-------------|---------------|
| `k6/health.js` | Health check smoke test | `GET /` root endpoint (DB connectivity) |
| `k6/auth.js` | Authentication endpoints | OTP request, token refresh throughput |
| `k6/api.js` | Core API endpoints | Dashboard, appointments, pharmacy orders |

## Running Tests

### Quick start (local)

Make sure the backend is running on port 5000, then:

```bash
# Health check (simplest, no auth needed)
npm run load-test:health

# Auth endpoints
npm run load-test:auth

# API endpoints (requires valid JWT)
npm run load-test:api
```

### With environment variables

```bash
# Against a specific server
k6 run -e BASE_URL=https://api.vhhealth.app load-tests/k6/health.js

# Auth tests with API key
k6 run -e BASE_URL=http://localhost:5000 \
       -e API_KEY=your-api-key \
       load-tests/k6/auth.js

# API tests with full auth
k6 run -e BASE_URL=http://localhost:5000 \
       -e API_KEY=your-api-key \
       -e AUTH_TOKEN=$(npm run generate-admin-token --silent) \
       load-tests/k6/api.js
```

### With Docker

```bash
docker run --rm -i --network=host \
  -v $(pwd)/load-tests/k6:/scripts \
  grafana/k6 run /scripts/health.js
```

## Interpreting Results

After a run, k6 prints a summary like:

```
http_req_duration..........: avg=45ms  min=12ms  med=38ms  max=450ms  p(90)=89ms  p(95)=120ms
http_req_failed............: 0.12%   3 out of 2500
```

### Key metrics to watch

| Metric | What it means | Target |
|--------|---------------|--------|
| `http_req_duration p(95)` | 95th percentile response time | < 500ms |
| `http_req_failed rate` | Percentage of failed requests | < 1% |
| `http_reqs` | Total requests per second | Depends on infra |
| `vus` | Number of concurrent virtual users | As configured |
| `iteration_duration` | Time for one complete test iteration | Varies by script |

### Baseline Targets

| Threshold | Value | Rationale |
|-----------|-------|-----------|
| p(95) latency | < 500ms | Acceptable UX for mobile apps |
| Error rate | < 1% | Production reliability standard |
| p(99) latency | < 2000ms | Worst-case still usable |

### Common failure patterns

- **High p(95) with low avg**: A few slow queries or cold starts are dragging up the tail.
- **Error rate spike at peak**: Backend or DB cannot handle the concurrency -- check connection pool size.
- **Steady error rate**: Auth issues (expired JWT, wrong API key) or endpoint bugs -- check response bodies.
- **Timeouts**: Backend or reverse proxy timeout is too low for the load level.

## Adding New Tests

1. Create a new `.js` file in `load-tests/k6/`.
2. Follow the existing pattern: define `options` with stages and thresholds, use `check()` for assertions.
3. Add an npm script in `package.json`: `"load-test:name": "k6 run load-tests/k6/name.js"`
4. Document the new test in this README.

## Notes

- **Rate limiting**: Auth endpoints are rate-limited in production (OTP: 3/phone/10min). Use a test environment with relaxed limits for load testing.
- **Test data**: Use dedicated test phone numbers or user accounts that the backend recognizes as synthetic traffic.
- **Production**: Never run load tests against production without explicit approval. Use staging or a dedicated load-test environment.
