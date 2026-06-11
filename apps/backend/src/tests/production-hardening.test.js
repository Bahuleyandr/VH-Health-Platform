import request from 'supertest';

const originalEnv = { ...process.env };

process.env.NODE_ENV = 'production';
process.env.ENABLE_DEV_AUTH = 'true';
process.env.ROUTE_HEALTH_MONITOR_ENABLED = 'false';
process.env.API_KEY = process.env.API_KEY || 'test-api-key';
process.env.MONITORING_TOKEN = 'prod-monitoring-token-for-tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-at-least-32-chars';
process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || 'test-field-encryption-key-32chars!!';
process.env.TOTP_ENCRYPTION_KEY = process.env.TOTP_ENCRYPTION_KEY || 'test-totp-encryption-key-32chars!!!!';
process.env.BACKUP_ENCRYPTION_KEY = process.env.BACKUP_ENCRYPTION_KEY || 'test-backup-encryption-key-32chars!!';
process.env.HL7_INBOUND_SHARED_SECRET = process.env.HL7_INBOUND_SHARED_SECRET || 'test-hl7-inbound-shared-secret-32chars';
process.env.PUBLIC_BASE_URL = 'https://api.vhhealth.app';

const { default: app } = await import(`../app.js?production-hardening=${Date.now()}`);

const API_KEY = process.env.API_KEY;

function get(path) {
  return request(app).get(path).set('x-forwarded-proto', 'https');
}

function post(path) {
  return request(app).post(path).set('x-forwarded-proto', 'https');
}

describe('production infrastructure hardening', () => {
  afterAll(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('keeps basic liveness public in production', async () => {
    const res = await get('/health/live');

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
  });

  it('rejects unauthenticated deep health and versioned comprehensive health in production', async () => {
    const deep = await get('/health/deep');
    const versioned = await get('/api/v1/health/health-check');

    expect(deep.statusCode).toBe(401);
    expect(deep.body.code).toBe('MONITORING_AUTH_REQUIRED');
    expect(versioned.statusCode).toBe(401);
    expect(versioned.body.code).toBe('MONITORING_AUTH_REQUIRED');
  });

  it('rejects public Prometheus metrics in production', async () => {
    const res = await get('/metrics');

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('MONITORING_AUTH_REQUIRED');
  });

  it('rejects API-key-only OpenAPI and API catalog access in production', async () => {
    const openApi = await get('/api/v1/api-docs/spec').set('x-api-key', API_KEY);
    const catalog = await get('/api/v1/version/api-catalog').set('x-api-key', API_KEY);

    expect(openApi.statusCode).toBe(401);
    expect(catalog.statusCode).toBe(401);
  });

  it('does not mount dev patient login in production even when ENABLE_DEV_AUTH is true', async () => {
    const res = await post('/api/v1/auth/dev/patient-login')
      .set('x-api-key', API_KEY)
      .send({ phone: '+919884112233', name: 'Production Dev Login Probe' });

    expect([401, 404]).toContain(res.statusCode);
    expect(res.body.data?.accessToken).toBeUndefined();
  });

  it('still redirects plain HTTP before infrastructure auth in production', async () => {
    const res = await request(app).get('/');

    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('https://api.vhhealth.app/');
  });

  it('does not reflect untrusted Host in production HTTPS redirects', async () => {
    const res = await request(app)
      .get('/api/v1/version?probe=1')
      .set('Host', 'attacker.example');

    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('https://api.vhhealth.app/api/v1/version?probe=1');
    expect(res.headers.location).not.toContain('attacker.example');
  });
});
